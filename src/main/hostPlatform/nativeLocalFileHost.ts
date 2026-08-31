import { app, clipboard, dialog, nativeImage, shell, type BrowserWindow } from 'electron';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mimeTypeForAssetFilename } from '../../core/assetMetadata';
import { officeOwnershipFileInfo } from '../../core/officeFiles';
import { rankTextSearchLabel } from '../../core/textSearchAnalyzer';
import { buildAgentLocalToolProcessEnv } from '../agent/capabilities/agentToolProcess';
import { resolveRipgrepCommand } from '../agent/capabilities/agentRipgrep';
import type { ResolvedThreadAttachmentFile } from '../agent/ThreadService';
import { decodeThreadResourceReference } from '../../core/agent/codec';
import type { ThreadResourceReference } from '../../core/agent/protocol';
import { setBoundedMapEntry } from '../boundedMap';
import {
  isSafeLocalFileOpenTarget,
  resolveTrustedLocalFileReference,
  type TrustedLocalFileReference,
} from '../localFileReferenceSecurity';
import { createLocalFileProcessTracker } from './localFileProcessTracker';

const DEFAULT_ATTACHMENT_PICKER_LIMIT = 6;
const DEFAULT_LOCAL_FILE_SEARCH_LIMIT = 8;
const DEFAULT_RECENT_LOCAL_FILE_LIMIT = 6;
const LOCAL_FILE_SEARCH_TIMEOUT_MS = 1200;
const LOCAL_FILE_ICON_TIMEOUT_MS = 250;
const LOCAL_FILE_ICON_SIZE: Electron.FileIconOptions['size'] = 'normal';
const LOCAL_FILE_PREVIEW_TIMEOUT_MS = 1600;
const LOCAL_FILE_THUMBNAIL_TIMEOUT_MS = 350;
const LOCAL_FILE_THUMBNAIL_SIZE = 512;
const RECENT_LOCAL_FILE_TIMEOUT_MS = 900;
const LOCAL_FILE_CACHE_LIMIT = 1000;

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.c', '.cpp', '.css', '.csv', '.env', '.go', '.h', '.hpp', '.html', '.java',
  '.js', '.jsx', '.kt', '.log', '.md', '.py', '.rs', '.sh', '.sql', '.swift',
  '.toml', '.ts', '.tsx', '.txt',
]);

export interface LocalFileOperationInput {
  readonly path?: unknown;
  readonly threadId?: unknown;
  readonly attachmentId?: unknown;
  readonly resourceRef?: unknown;
}

export interface NativeLocalFileHostOptions {
  readonly trustedRoots: () => readonly string[];
  readonly resolveAttachmentFile: (
    threadId: string,
    attachmentId: string,
  ) => Promise<ResolvedThreadAttachmentFile | null>;
  readonly resolveResourceFile: (
    threadId: string,
    ref: ThreadResourceReference,
    intent: 'delivered' | 'source',
  ) => Promise<TrustedLocalFileReference | null>;
}

export interface NativeLocalFileHost {
  pick(parent: BrowserWindow | null, rawOptions?: { maxFiles?: unknown }): Promise<unknown>;
  search(rawOptions?: { limit?: unknown; query?: unknown }): Promise<unknown>;
  recent(rawOptions?: { limit?: unknown }): Promise<unknown>;
  prepare(rawOptions?: { id?: unknown }): Promise<unknown>;
  preview(rawOptions?: { id?: unknown }): Promise<unknown>;
  metadata(file: TrustedLocalFileReference): Promise<LocalFilePreviewMetadata>;
  previewReference(rawOptions?: LocalFileOperationInput): Promise<unknown>;
  openReference(rawOptions?: LocalFileOperationInput): Promise<{ opened: boolean }>;
  revealReference(rawOptions?: LocalFileOperationInput): Promise<{ revealed: boolean }>;
  resolve(rawOptions?: LocalFileOperationInput, allowAttachmentPathHint?: boolean): Promise<TrustedLocalFileReference | null>;
  pickPaths(parent: BrowserWindow | null, options: Electron.OpenDialogOptions): Promise<string[]>;
  open(file: TrustedLocalFileReference): Promise<boolean>;
  reveal(path: string): void;
  copy(path: string): void;
  close(): Promise<void>;
}

type TrackedLocalFileSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess | null;

export function createNativeLocalFileHost(options: NativeLocalFileHostOptions): NativeLocalFileHost {
  const searchCache = new Map<string, string>();
  const iconCache = new Map<string, string | null>();
  const thumbnailCache = new Map<string, string | null>();
  const pendingIconLoads = new Map<string, Promise<string | null>>();
  const pendingThumbnailLoads = new Map<string, Promise<string | null>>();
  const processTracker = createLocalFileProcessTracker();
  let lastPickerDirectory: string | null = null;
  let closePromise: Promise<void> | null = null;

  const setCache = <V>(cache: Map<string, V>, key: string, value: V): void => {
    setBoundedMapEntry(cache, key, value, LOCAL_FILE_CACHE_LIMIT);
  };

  const iconDataUrl = async (filePath: string): Promise<string | null> => {
    const cached = iconCache.get(filePath);
    if (cached !== undefined) return cached;
    let pending = pendingIconLoads.get(filePath);
    if (!pending) {
      pending = app.getFileIcon(filePath, { size: LOCAL_FILE_ICON_SIZE })
        .then((image) => image.isEmpty() ? null : image.toDataURL())
        .catch(() => null)
        .then((value) => {
          setCache(iconCache, filePath, value);
          return value;
        })
        .finally(() => pendingIconLoads.delete(filePath));
      pendingIconLoads.set(filePath, pending);
    }
    return promiseWithTimeout(pending, LOCAL_FILE_ICON_TIMEOUT_MS, null);
  };

  const thumbnailDataUrl = async (filePath: string, timeoutMs: number): Promise<string | null> => {
    const cached = thumbnailCache.get(filePath);
    if (cached !== undefined) return cached;
    let pending = pendingThumbnailLoads.get(filePath);
    if (!pending) {
      pending = nativeImage.createThumbnailFromPath(filePath, {
        width: LOCAL_FILE_THUMBNAIL_SIZE,
        height: LOCAL_FILE_THUMBNAIL_SIZE,
      })
        .then((image) => image.isEmpty() ? null : image.toDataURL())
        .catch(() => null)
        .then((value) => {
          setCache(thumbnailCache, filePath, value);
          return value;
        })
        .finally(() => pendingThumbnailLoads.delete(filePath));
      pendingThumbnailLoads.set(filePath, pending);
    }
    return promiseWithTimeout(pending, timeoutMs, null);
  };

  const withIcons = <T extends {
    entryKind?: string;
    mimeType?: string;
    name?: string;
    path: string;
  }>(files: T[]): Promise<Array<T & { iconDataUrl?: string; thumbnailDataUrl?: string }>> => (
    Promise.all(files.map(async (file) => {
      const [icon, thumbnail] = await Promise.all([
        iconDataUrl(file.path),
        shouldLoadThumbnail(file)
          ? thumbnailDataUrl(file.path, LOCAL_FILE_THUMBNAIL_TIMEOUT_MS)
          : Promise.resolve(null),
      ]);
      return {
        ...file,
        ...(icon ? { iconDataUrl: icon } : {}),
        ...(thumbnail ? { thumbnailDataUrl: thumbnail } : {}),
      };
    }))
  );

  const pickedFile = async (filePath: string) => {
    try {
      const fileStat = await stat(filePath);
      const entryKind = fileStat.isDirectory() ? 'directory' : fileStat.isFile() ? 'file' : null;
      if (!entryKind) return null;
      const mimeType = entryKind === 'directory' ? 'inode/directory' : inferMimeType(filePath);
      const [visual] = await withIcons([{ entryKind, mimeType, name: basename(filePath), path: filePath }]);
      return {
        entryKind,
        path: filePath,
        name: basename(filePath),
        mimeType,
        sizeBytes: entryKind === 'directory' ? 0 : fileStat.size,
        lastModified: fileStat.mtimeMs,
        ...(visual?.iconDataUrl ? { iconDataUrl: visual.iconDataUrl } : {}),
        ...(visual?.thumbnailDataUrl ? { thumbnailDataUrl: visual.thumbnailDataUrl } : {}),
      };
    } catch {
      return null;
    }
  };

  const metadataResults = async (paths: string[], limit: number) => {
    const files = [];
    for (const filePath of paths) {
      if (files.length >= limit) break;
      if (officeOwnershipFileInfo(filePath)) continue;
      try {
        const fileStat = await stat(filePath);
        const entryKind = fileStat.isDirectory() ? 'directory' : fileStat.isFile() ? 'file' : null;
        if (!entryKind) continue;
        const id = createHash('sha256').update(filePath).digest('hex').slice(0, 24);
        setCache(searchCache, id, filePath);
        files.push({
          entryKind,
          id,
          path: filePath,
          name: basename(filePath),
          parentPath: dirname(filePath),
          mimeType: entryKind === 'directory' ? 'inode/directory' : inferMimeType(filePath),
          sizeBytes: entryKind === 'directory' ? 0 : fileStat.size,
          lastModified: fileStat.mtimeMs,
        });
      } catch {
        // Search indexes can return stale paths; ignore entries that no longer stat.
      }
    }
    return files;
  };

  const resolve = async (
    raw: LocalFileOperationInput | undefined,
    allowAttachmentPathHint = false,
    resourceIntent: 'delivered' | 'source' = 'delivered',
  ): Promise<TrustedLocalFileReference | null> => {
    const threadId = typeof raw?.threadId === 'string' && raw.threadId.trim() ? raw.threadId : null;
    const attachmentId = typeof raw?.attachmentId === 'string' && raw.attachmentId.trim()
      ? raw.attachmentId
      : null;
    let resourceRef: ThreadResourceReference | null = null;
    if (raw?.resourceRef !== undefined) {
      try {
        resourceRef = decodeThreadResourceReference(raw.resourceRef, 'localFile.resourceRef');
      } catch {
        return null;
      }
    }
    const scopedIdentityCount = Number(Boolean(attachmentId)) + Number(Boolean(resourceRef));
    if (threadId ? scopedIdentityCount !== 1 : scopedIdentityCount !== 0) return null;
    if (!threadId) {
      return resolveTrustedLocalFileReference(raw?.path, options.trustedRoots());
    }
    if (resourceRef) return options.resolveResourceFile(threadId, resourceRef, resourceIntent);
    const attachment = await options.resolveAttachmentFile(threadId, attachmentId!).catch(() => null);
    if (!attachment) return null;
    if (attachment.entryKind === 'directory') {
      return resolveTrustedLocalFileReference(raw?.path, [attachment.path]);
    }
    if (allowAttachmentPathHint) {
      const requestedPath = typeof raw?.path === 'string' ? raw.path : '';
      const acceptedHints = attachment.attachment.source.kind === 'localFile'
        ? [attachment.path, attachment.attachment.source.path]
        : [attachment.path, attachment.attachment.name, attachment.attachment.source.ref.fileName];
      return acceptedHints.includes(requestedPath) ? attachment : null;
    }
    if (typeof raw?.path !== 'string') return null;
    const requestedPath = await realpath(raw.path).catch(() => null);
    return requestedPath === attachment.path ? attachment : null;
  };

  const metadata = async (file: TrustedLocalFileReference): Promise<LocalFilePreviewMetadata> => {
    const mimeType = file.entryKind === 'directory' ? 'inode/directory' : inferMimeType(file.path);
    const [visual] = await withIcons([{
      entryKind: file.entryKind,
      mimeType,
      name: basename(file.path),
      path: file.path,
    }]);
    return {
      entryKind: file.entryKind,
      path: file.path,
      name: basename(file.path),
      parentPath: dirname(file.path),
      mimeType,
      sizeBytes: file.entryKind === 'directory' ? 0 : file.stats.size,
      lastModified: file.stats.mtimeMs,
      ...(visual?.iconDataUrl ? { iconDataUrl: visual.iconDataUrl } : {}),
      ...(visual?.thumbnailDataUrl ? { thumbnailDataUrl: visual.thumbnailDataUrl } : {}),
    };
  };

  const host: NativeLocalFileHost = {
    pick: async (parent, rawOptions) => {
      const maxFiles = clampLimit(rawOptions?.maxFiles, DEFAULT_ATTACHMENT_PICKER_LIMIT, 50);
      const defaultPath = attachmentPickerDefaultPath(lastPickerDirectory);
      const multiSelections = maxFiles > 1;
      const dialogOptions: Electron.OpenDialogOptions = {
        ...(defaultPath ? { defaultPath } : {}),
        properties: multiSelections
          ? ['openFile', 'openDirectory', 'multiSelections']
          : ['openFile', 'openDirectory'],
      };
      const result = parent
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) return { canceled: true, files: [] };
      lastPickerDirectory = dirname(result.filePaths[0]!);
      let skippedCount = 0;
      const files: NonNullable<Awaited<ReturnType<typeof pickedFile>>>[] = [];
      const rejectedFiles: Array<{
        name: string;
        reason: 'officeOwnershipFile';
        suggestedName?: string;
      }> = [];
      for (const filePath of result.filePaths) {
        const rejected = await rejectedOfficeOwnershipFile(filePath);
        if (rejected) {
          rejectedFiles.push(rejected);
          continue;
        }
        if (files.length >= maxFiles) {
          skippedCount += 1;
          continue;
        }
        const file = await pickedFile(filePath);
        if (file) files.push(file);
      }
      return {
        canceled: false,
        files,
        ...(rejectedFiles.length > 0 ? { rejectedFiles } : {}),
        ...(skippedCount > 0 ? { skippedCount } : {}),
      };
    },
    search: async (rawOptions) => {
      const query = normalizeQuery(rawOptions?.query);
      const limit = clampLimit(rawOptions?.limit, DEFAULT_LOCAL_FILE_SEARCH_LIMIT, 24);
      if (!query) return { files: [], query };
      const paths = await searchLocalFilePaths(query, limit * 6, processTracker.spawn);
      const rankedPaths = [...paths].sort((left, right) => localFilePathRank(left, query) - localFilePathRank(right, query));
      return { files: await withIcons(await metadataResults(rankedPaths, limit)), query };
    },
    recent: async (rawOptions) => {
      const limit = clampLimit(rawOptions?.limit, DEFAULT_RECENT_LOCAL_FILE_LIMIT, 18);
      const paths = await recentLocalFilePaths(limit * 12, processTracker.spawn);
      const files = await withIcons(
        (await metadataResults(paths, limit * 12))
          .sort((left, right) => right.lastModified - left.lastModified)
          .slice(0, limit),
      );
      return { files };
    },
    prepare: async (rawOptions) => {
      const id = typeof rawOptions?.id === 'string' ? rawOptions.id : '';
      const filePath = searchCache.get(id);
      return { file: filePath ? await pickedFile(filePath) : null };
    },
    preview: async (rawOptions) => {
      const id = typeof rawOptions?.id === 'string' ? rawOptions.id : '';
      const filePath = searchCache.get(id);
      if (!filePath) return { thumbnailDataUrl: null };
      try {
        const fileStat = await stat(filePath);
        const file = { entryKind: 'file', mimeType: inferMimeType(filePath), name: basename(filePath) };
        if (!fileStat.isFile() || !shouldLoadThumbnail(file)) return { thumbnailDataUrl: null };
        return { thumbnailDataUrl: await thumbnailDataUrl(filePath, LOCAL_FILE_PREVIEW_TIMEOUT_MS) };
      } catch {
        return { thumbnailDataUrl: null };
      }
    },
    metadata,
    previewReference: async (rawOptions) => {
      const file = await resolve(rawOptions, true, 'source');
      if (!file) return { file: null };
      return { file: await metadata(file) };
    },
    openReference: async (rawOptions) => {
      const file = await resolve(rawOptions, true);
      return { opened: file ? await host.open(file) : false };
    },
    revealReference: async (rawOptions) => {
      const file = await resolve(rawOptions, true);
      if (!file) return { revealed: false };
      host.reveal(file.path);
      return { revealed: true };
    },
    resolve,
    pickPaths: async (parent, dialogOptions) => {
      const result = parent
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? [] : result.filePaths;
    },
    open: async (file) => {
      if (!isSafeLocalFileOpenTarget(file)) return false;
      return (await shell.openPath(file.path)).length === 0;
    },
    reveal: (path) => shell.showItemInFolder(path),
    copy: copyFilePathToClipboard,
    close: () => {
      if (closePromise) return closePromise;
      searchCache.clear();
      iconCache.clear();
      thumbnailCache.clear();
      pendingIconLoads.clear();
      pendingThumbnailLoads.clear();
      lastPickerDirectory = null;
      closePromise = processTracker.close();
      return closePromise;
    },
  };
  return host;
}

interface LocalFilePreviewMetadata {
  readonly entryKind: 'file' | 'directory';
  readonly path: string;
  readonly name: string;
  readonly parentPath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly lastModified: number;
  readonly iconDataUrl?: string;
  readonly thumbnailDataUrl?: string;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(1, numeric));
}

function normalizeQuery(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
}

async function searchLocalFilePaths(
  query: string,
  limit: number,
  spawnProcess: TrackedLocalFileSpawn,
): Promise<string[]> {
  if (process.platform === 'darwin') {
    const spotlight = await collectNullDelimitedProcess(
      '/usr/bin/mdfind', ['-0', '-name', query], limit, LOCAL_FILE_SEARCH_TIMEOUT_MS, spawnProcess,
    );
    if (spotlight.length > 0) return spotlight;
  }
  return rgFileNameMatches(query, limit, spawnProcess);
}

async function recentLocalFilePaths(
  limit: number,
  spawnProcess: TrackedLocalFileSpawn,
): Promise<string[]> {
  if (process.platform === 'darwin') {
    const spotlight = await collectNullDelimitedProcess(
      '/usr/bin/mdfind',
      ['-0', 'kMDItemFSContentChangeDate >= $time.today(-30)'],
      limit,
      RECENT_LOCAL_FILE_TIMEOUT_MS,
      spawnProcess,
    );
    if (spotlight.length > 0) return spotlight;
  }
  const roots = ['desktop', 'documents', 'downloads']
    .map((name) => safeAppPath(name as Parameters<typeof app.getPath>[0]))
    .filter((path): path is string => Boolean(path));
  const paths: string[] = [];
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() && !entry.isDirectory()) continue;
        paths.push(join(root, entry.name));
        if (paths.length >= limit) return paths;
      }
    } catch {
      // Ignore folders unavailable to the current OS account.
    }
  }
  return paths;
}

async function rgFileNameMatches(
  query: string,
  limit: number,
  spawnProcess: TrackedLocalFileSpawn,
): Promise<string[]> {
  const home = safeAppPath('home');
  if (!home) return [];
  const ripgrep = await resolveRipgrepCommand(home).catch(() => null);
  if (!ripgrep) return [];
  const child = spawnProcess(ripgrep.command, [...ripgrep.argsPrefix,
    '--files', '--hidden', '--glob', '!**/.git/**', '--glob', '!**/node_modules/**',
    '--glob', '!**/Library/**', home,
  ], { env: buildAgentLocalToolProcessEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  const stdout = child?.stdout;
  if (!stdout) return [];
  return new Promise((resolve) => {
    const results: string[] = [];
    const seen = new Set<string>();
    const lowerQuery = query.toLowerCase();
    let buffer = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(results);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, LOCAL_FILE_SEARCH_TIMEOUT_MS);
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const filePath = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (basename(filePath).toLowerCase().includes(lowerQuery) && !seen.has(filePath)) {
          seen.add(filePath);
          results.push(filePath);
          if (results.length >= limit) {
            child.kill();
            finish();
            return;
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

function collectNullDelimitedProcess(
  command: string,
  args: readonly string[],
  limit: number,
  timeoutMs: number,
  spawnProcess: TrackedLocalFileSpawn,
): Promise<string[]> {
  const child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const stdout = child?.stdout;
  if (!stdout) return Promise.resolve([]);
  return new Promise((resolve) => {
    const results: string[] = [];
    const seen = new Set<string>();
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(results);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish();
    }, timeoutMs);
    stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let delimiter = buffer.indexOf(0);
      while (delimiter >= 0) {
        const filePath = buffer.subarray(0, delimiter).toString('utf8');
        buffer = buffer.subarray(delimiter + 1);
        if (filePath && !seen.has(filePath)) {
          seen.add(filePath);
          results.push(filePath);
          if (results.length >= limit) {
            child.kill();
            finish();
            return;
          }
        }
        delimiter = buffer.indexOf(0);
      }
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

async function rejectedOfficeOwnershipFile(filePath: string): Promise<{
  name: string;
  reason: 'officeOwnershipFile';
  suggestedName?: string;
} | null> {
  const ownershipFile = officeOwnershipFileInfo(filePath);
  if (!ownershipFile) return null;
  const suggestedPath = join(dirname(filePath), ownershipFile.suggestedName);
  const suggestedName = await stat(suggestedPath)
    .then((candidate) => candidate.isFile() ? ownershipFile.suggestedName : undefined)
    .catch(() => undefined);
  return {
    name: ownershipFile.name,
    reason: 'officeOwnershipFile',
    ...(suggestedName ? { suggestedName } : {}),
  };
}

function shouldLoadThumbnail(file: { entryKind?: string; mimeType?: string; name?: string }): boolean {
  if (file.entryKind === 'directory' || file.mimeType === 'inode/directory') return false;
  if ((file.mimeType ?? '').toLowerCase().startsWith('image/')) return true;
  return ['.avif', '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp']
    .includes(extname(file.name ?? '').toLowerCase());
}

function localFilePathRank(filePath: string, query: string): number {
  const match = rankTextSearchLabel(basename(filePath), query);
  return match ? match.rank + match.index / 1000 : 10;
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

function attachmentPickerDefaultPath(lastPickerDirectory: string | null): string | null {
  const mode = process.env.LIN_ATTACHMENT_PICKER_DEFAULT_PATH ?? 'last';
  if (mode === 'none' || mode === 'system') return null;
  if (mode === 'last') return lastPickerDirectory ?? safeAppPath('downloads');
  if (mode === 'downloads' || mode === 'documents' || mode === 'home') return safeAppPath(mode);
  return null;
}

function safeAppPath(name: Parameters<typeof app.getPath>[0]): string | null {
  try {
    return app.getPath(name);
  } catch {
    return null;
  }
}

function inferMimeType(filePath: string): string {
  const sharedMimeType = mimeTypeForAssetFilename(filePath);
  if (sharedMimeType) return sharedMimeType;
  const extension = extname(filePath).toLowerCase();
  if (extension === '.doc') return 'application/msword';
  if (extension === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === '.ppt') return 'application/vnd.ms-powerpoint';
  if (extension === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (extension === '.key' || extension === '.keynote') return 'application/vnd.apple.keynote';
  if (extension === '.pages') return 'application/vnd.apple.pages';
  if (extension === '.odp') return 'application/vnd.oasis.opendocument.presentation';
  if (extension === '.xls') return 'application/vnd.ms-excel';
  if (extension === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (extension === '.numbers') return 'application/vnd.apple.numbers';
  if (extension === '.xml') return 'application/xml';
  if (extension === '.yaml' || extension === '.yml') return 'application/yaml';
  if (TEXT_ATTACHMENT_EXTENSIONS.has(extension)) return 'text/plain';
  return 'application/octet-stream';
}

function copyFilePathToClipboard(path: string): void {
  clipboard.writeText(path);
  if (process.platform !== 'darwin') return;
  clipboard.writeBuffer('public.file-url', Buffer.from(pathToFileURL(path).toString(), 'utf8'));
  clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>`
    + `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`
    + `<plist version="1.0"><array><string>${escapeXml(path)}</string></array></plist>`,
    'utf8',
  ));
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
