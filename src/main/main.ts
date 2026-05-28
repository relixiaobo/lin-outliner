import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentService } from './documentService';
import { AssetService } from './assetService';
import { AgentRuntime } from './agentRuntime';
import { MAC_TRAFFIC_LIGHT_POSITION } from '../core/chromeGeometry';
import { windowMaterialKind } from '../core/windowMaterial';
import { ASSET_URL_SCHEME } from '../core/assets';
import { LIN_DOCUMENT_EVENT_CHANNEL, type AssetIngestInput } from '../core/types';
import {
  deleteProviderApiKey,
  deleteProviderConfig,
  getProviderSecretStatus,
  getProviderSettings,
  setActiveProvider,
  setProviderApiKey,
  updateAgentRuntimeSettings,
  upsertProviderConfig,
  testProviderConnection,
} from './agentSettings';
import { isAgentCommand, isAssetCommand, isDocumentCommand, type AgentCommand, type AssetCommand } from '../core/commands';
import type { AgentProviderConfigInput, AgentRuntimeSettingsInput } from '../core/types';
import { loadWindowState, trackWindowState } from './windowState';

if (process.env.ELECTRON_USER_DATA_DIR) {
  app.setPath('userData', process.env.ELECTRON_USER_DATA_DIR);
} else if (!app.isPackaged) {
  // Running from source (electron-vite dev) with no explicit override. Never
  // share the installed prod app's default userData, so a bare `bun run dev`
  // can't read or clobber daily-use documents, agent sessions, or assets. The
  // clone-specific dev scripts still set ELECTRON_USER_DATA_DIR for per-clone
  // isolation; this is the catch-all for runs that forget to.
  app.setPath('userData', join(app.getPath('home'), '.lin-outliner-dev'));
}

// Must run before the app `ready` event so the renderer can load assets with
// regular <img>/<video> tags via `asset://<id>`.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_URL_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

const IMAGE_FILE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'] },
];

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const documentService = new DocumentService();
const assetService = new AssetService(() => join(app.getPath('userData'), 'assets'));
let mainWindow: BrowserWindow | null = null;
let quitAfterFlush = false;
let lastAttachmentPickerDirectory: string | null = null;
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
const localFileSearchCache = new Map<string, string>();
const localFileIconCache = new Map<string, string | null>();
const localFileThumbnailCache = new Map<string, string | null>();
const pendingLocalFileIconLoads = new Map<string, Promise<string | null>>();
const pendingLocalFileThumbnailLoads = new Map<string, Promise<string | null>>();
const agentRuntime = new AgentRuntime(() => mainWindow, documentService, {
  localFileRoot: process.env.LIN_AGENT_LOCAL_ROOT ?? process.cwd(),
});

documentService.onProjectionChanged((event) => {
  mainWindow?.webContents.send(LIN_DOCUMENT_EVENT_CHANNEL, event);
});

// ─── Security shell (the native host owns navigation + capabilities) ───

const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL ?? process.env.VITE_DEV_SERVER_URL;
const RENDERER_DEV_ORIGIN = RENDERER_DEV_URL ? safeOrigin(RENDERER_DEV_URL) : null;

// navigator.clipboard.writeText is the only renderer capability we rely on; deny
// everything else (geolocation, media, notifications, …) by default.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

// The packaged renderer (loaded from file://) is locked to its own resources.
// 'unsafe-inline' styles cover Shiki's inline color spans + React style props;
// remote http(s) is allowed only as <img>/<video> sources. The renderer makes
// no direct network calls (everything else goes through IPC) and runs no
// WebAssembly (loro-crdt lives in the main process), so script-src and
// connect-src stay tight.
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: http: ${ASSET_URL_SCHEME}:`,
  `media-src 'self' data: blob: https: http: ${ASSET_URL_SCHEME}:`,
  "font-src 'self' data:",
  `connect-src 'self' ${ASSET_URL_SCHEME}:`,
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Only http(s) may reach the OS browser — never file:// or a custom scheme.
function openExternalUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  void shell.openExternal(url).catch(() => {});
  return true;
}

function isAppDocumentUrl(url: string): boolean {
  if (url.startsWith('file:')) return true; // packaged renderer
  return RENDERER_DEV_ORIGIN != null && safeOrigin(url) === RENDERER_DEV_ORIGIN; // vite dev
}

// The renderer is a fixed local surface. Block any attempt to navigate it away
// (clicked links, injected redirects) or to spawn child windows; real http(s)
// links open in the OS browser instead.
function hardenWebContents(contents: Electron.WebContents) {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (isAppDocumentUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
}

function configureSessionSecurity() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Enforce CSP on the packaged renderer's own document (loaded from file://).
  // Dev loads from the Vite origin, which needs a relaxed policy for HMR, so it
  // falls through here untouched; the agent's remote web-fetch windows load
  // http(s) and are excluded too.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !details.url.startsWith('file:')) {
      callback({});
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [RENDERER_CSP],
      },
    });
  });
}

function createWindow() {
  const windowState = loadWindowState();
  const material = windowMaterialKind(process.platform);
  mainWindow = new BrowserWindow({
    title: 'Lin Outliner',
    width: windowState.bounds?.width ?? 1120,
    height: windowState.bounds?.height ?? 820,
    ...(windowState.bounds ? { x: windowState.bounds.x, y: windowState.bounds.y } : {}),
    minWidth: 760,
    minHeight: 560,
    // Create hidden and reveal on first paint so launch never flashes an empty
    // white frame; the platform animates the show.
    show: false,
    // With a window material the background must be transparent so the OS
    // material (vibrancy / mica) shows through; otherwise keep the opaque deck
    // colour as the pre-paint frame.
    backgroundColor: material ? '#00000000' : '#f7f6f1',
    ...(material === 'vibrancy' ? { vibrancy: 'under-window' as const } : {}),
    ...(material === 'mica' ? { backgroundMaterial: 'mica' as const } : {}),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (windowState.maximized) mainWindow.maximize();
  hardenWebContents(mainWindow.webContents);
  trackWindowState(mainWindow);

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (RENDERER_DEV_URL) {
    void mainWindow.loadURL(RENDERER_DEV_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.once('did-finish-load', () => agentRuntime.ready());
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function registerIpc() {
  ipcMain.handle('lin:invoke', async (_event, command: string, args?: Record<string, unknown>) => {
    if (isAgentCommand(command)) return handleAgentCommand(command, args ?? {});
    if (isAssetCommand(command)) return handleAssetCommand(command, args ?? {});
    if (isDocumentCommand(command)) return documentService.handle(command, args);
    throw new Error(`Unknown command: ${command}`);
  });

  ipcMain.handle('lin:window', (_event, command: string) => {
    const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!window) return;
    if (command === 'minimize') window.minimize();
    if (command === 'toggle_maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    if (command === 'close') window.close();
  });

  ipcMain.handle('lin:pick-local-files', async (event, rawOptions?: {
    maxFiles?: unknown;
  }) => {
    const maxFiles = clampPickerLimit(rawOptions?.maxFiles);
    const window = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? mainWindow;
    const defaultPath = attachmentPickerDefaultPath();
    const multiSelections = maxFiles > 1;
    const options: Electron.OpenDialogOptions = {
      ...(defaultPath.path ? { defaultPath: defaultPath.path } : {}),
      properties: multiSelections ? ['openFile', 'multiSelections'] : ['openFile'],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return {
        canceled: true,
        files: [],
      };
    }
    lastAttachmentPickerDirectory = dirname(result.filePaths[0]!);
    const selectedPaths = result.filePaths.slice(0, maxFiles);
    const skippedCount = Math.max(0, result.filePaths.length - selectedPaths.length);
    const files = (await Promise.all(selectedPaths.map(localPickedFile))).filter(
      (file): file is NonNullable<Awaited<ReturnType<typeof localPickedFile>>> => Boolean(file),
    );
    return {
      canceled: false,
      files,
      ...(skippedCount > 0 ? { skippedCount } : {}),
    };
  });

  ipcMain.handle('lin:search-local-files', async (_event, rawOptions?: {
    limit?: unknown;
    query?: unknown;
  }) => {
    const query = normalizeLocalFileQuery(rawOptions?.query);
    const limit = clampLocalFileSearchLimit(rawOptions?.limit);
    if (!query) return { files: [], query };
    const paths = await searchLocalFilePaths(query, limit * 6);
    const files = await localFileSearchResults(paths, query, limit);
    return { files, query };
  });

  ipcMain.handle('lin:recent-local-files', async (_event, rawOptions?: { limit?: unknown }) => {
    const limit = clampRecentLocalFileLimit(rawOptions?.limit);
    const paths = await recentLocalFilePaths(limit * 12);
    const files = await withLocalFileIcons((await localFileMetadataResults(paths, limit * 12))
      .sort((left, right) => right.lastModified - left.lastModified)
      .slice(0, limit));
    return { files };
  });

  ipcMain.handle('lin:prepare-local-file', async (_event, rawOptions?: { id?: unknown }) => {
    const id = typeof rawOptions?.id === 'string' ? rawOptions.id : '';
    const filePath = localFileSearchCache.get(id);
    if (!filePath) return { file: null };
    return { file: await localPickedFile(filePath) };
  });

  ipcMain.handle('lin:preview-local-file', async (_event, rawOptions?: { id?: unknown }) => {
    const id = typeof rawOptions?.id === 'string' ? rawOptions.id : '';
    const filePath = localFileSearchCache.get(id);
    if (!filePath) return { thumbnailDataUrl: null };
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return { thumbnailDataUrl: null };
      const file = {
        entryKind: 'file',
        mimeType: inferMimeType(filePath),
        name: basename(filePath),
      };
      if (!shouldLoadLocalFileThumbnail(file)) return { thumbnailDataUrl: null };
      return {
        thumbnailDataUrl: await localFileThumbnailDataUrl(filePath, LOCAL_FILE_PREVIEW_TIMEOUT_MS),
      };
    } catch {
      return { thumbnailDataUrl: null };
    }
  });
}

async function handleAssetCommand(command: AssetCommand, args: Record<string, unknown>) {
  switch (command) {
    case 'ingest_asset': {
      // Only the buffer path is exposed to the renderer. Path ingest is an
      // arbitrary-local-file read primitive, so it stays main-process-only
      // (used internally by pick_image_files); the renderer can never name a
      // path to read back through asset://.
      if ((args as { kind?: unknown }).kind !== 'buffer') {
        throw new Error('ingest_asset accepts only kind:"buffer" over IPC');
      }
      return assetService.ingest(args as unknown as AssetIngestInput);
    }
    case 'lookup_asset':
      return assetService.lookup(String(args.id));
    case 'delete_asset':
      return assetService.delete(String(args.id));
    case 'pick_image_files': {
      const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
      const options = {
        title: 'Insert image',
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: IMAGE_FILE_FILTERS,
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      return Promise.all(result.filePaths.map((path) => assetService.ingest({ kind: 'path', path })));
    }
    case 'open_asset': {
      const path = await assetService.pathFor(String(args.id));
      if (path) await shell.openPath(path);
      return { opened: Boolean(path) };
    }
    case 'reveal_asset': {
      const path = await assetService.pathFor(String(args.id));
      if (path) shell.showItemInFolder(path);
      return { revealed: Boolean(path) };
    }
    case 'open_external_url': {
      // Opens a remote media node's source in the OS default browser. Only
      // http(s) is allowed so a node can never smuggle a file:// or other
      // scheme into shell.openExternal.
      return { opened: openExternalUrl(String(args.url)) };
    }
    default:
      throw new Error(`Unknown asset command: ${command}`);
  }
}

function attachmentPickerDefaultPath(): { path?: string; source: string } {
  const mode = process.env.LIN_ATTACHMENT_PICKER_DEFAULT_PATH ?? 'last';
  if (mode === 'none' || mode === 'system') return { source: 'system' };
  if (mode === 'last') {
    if (lastAttachmentPickerDirectory) return { path: lastAttachmentPickerDirectory, source: 'last' };
    const downloads = safeAppPath('downloads');
    if (downloads) return { path: downloads, source: 'downloads-fallback' };
    return { source: 'system' };
  }
  if (mode === 'downloads') {
    const downloads = safeAppPath('downloads');
    return downloads ? { path: downloads, source: 'downloads' } : { source: 'system' };
  }
  if (mode === 'documents') {
    const documents = safeAppPath('documents');
    return documents ? { path: documents, source: 'documents' } : { source: 'system' };
  }
  if (mode === 'home') {
    const home = safeAppPath('home');
    return home ? { path: home, source: 'home' } : { source: 'system' };
  }
  return { source: 'system' };
}

function clampPickerLimit(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_ATTACHMENT_PICKER_LIMIT;
  return Math.min(50, Math.max(1, numeric));
}

function clampLocalFileSearchLimit(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_LOCAL_FILE_SEARCH_LIMIT;
  return Math.min(24, Math.max(1, numeric));
}

function clampRecentLocalFileLimit(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : DEFAULT_RECENT_LOCAL_FILE_LIMIT;
  return Math.min(18, Math.max(1, numeric));
}

function normalizeLocalFileQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function searchLocalFilePaths(query: string, limit: number): Promise<string[]> {
  if (process.platform === 'darwin') {
    const spotlight = await mdfindFileNameMatches(query, limit);
    if (spotlight.length > 0) return spotlight;
  }
  return rgFileNameMatches(query, limit);
}

function mdfindFileNameMatches(query: string, limit: number): Promise<string[]> {
  return collectNullDelimitedProcess('/usr/bin/mdfind', ['-0', '-name', query], limit, LOCAL_FILE_SEARCH_TIMEOUT_MS);
}

async function recentLocalFilePaths(limit: number): Promise<string[]> {
  if (process.platform === 'darwin') {
    const spotlight = await collectNullDelimitedProcess(
      '/usr/bin/mdfind',
      ['-0', 'kMDItemFSContentChangeDate >= $time.today(-30)'],
      limit,
      RECENT_LOCAL_FILE_TIMEOUT_MS,
    );
    if (spotlight.length > 0) return spotlight;
  }
  return commonDirectoryRecentFilePaths(limit);
}

async function commonDirectoryRecentFilePaths(limit: number): Promise<string[]> {
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
      // Ignore folders the user has not granted or that do not exist.
    }
  }
  return paths;
}

function rgFileNameMatches(query: string, limit: number): Promise<string[]> {
  const home = safeAppPath('home');
  if (!home) return Promise.resolve([]);
  return new Promise((resolve) => {
    const results: string[] = [];
    const seen = new Set<string>();
    const lowerQuery = query.toLowerCase();
    const child = spawn('rg', [
      '--files',
      '--hidden',
      '--glob', '!**/.git/**',
      '--glob', '!**/node_modules/**',
      '--glob', '!**/Library/**',
      home,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
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
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
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
  args: string[],
  limit: number,
  timeoutMs: number,
): Promise<string[]> {
  return new Promise((resolve) => {
    const results: string[] = [];
    const seen = new Set<string>();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
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
    child.stdout.on('data', (chunk: Buffer) => {
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

async function localFileSearchResults(paths: string[], query: string, limit: number) {
  const rankedPaths = [...paths].sort((left, right) =>
    localFilePathRank(left, query) - localFilePathRank(right, query));
  return withLocalFileIcons(await localFileMetadataResults(rankedPaths, limit));
}

async function localFileMetadataResults(paths: string[], limit: number) {
  const files = [];
  for (const filePath of paths) {
    if (files.length >= limit) break;
    try {
      const fileStat = await stat(filePath);
      const entryKind = fileStat.isDirectory() ? 'directory' : fileStat.isFile() ? 'file' : null;
      if (!entryKind) continue;
      files.push({
        entryKind,
        id: cacheLocalFileSearchPath(filePath),
        path: filePath,
        name: basename(filePath),
        parentPath: dirname(filePath),
        mimeType: entryKind === 'directory' ? 'inode/directory' : inferMimeType(filePath),
        sizeBytes: entryKind === 'directory' ? 0 : fileStat.size,
        lastModified: fileStat.mtimeMs,
      });
    } catch {
      // Spotlight can return stale paths; ignore entries that no longer stat.
    }
  }
  return files;
}

function withLocalFileIcons<T extends {
  entryKind?: string;
  mimeType?: string;
  name?: string;
  path: string;
}>(files: T[]): Promise<Array<T & { iconDataUrl?: string; thumbnailDataUrl?: string }>> {
  return Promise.all(files.map(async (file) => {
    const [iconDataUrl, thumbnailDataUrl] = await Promise.all([
      localFileIconDataUrl(file.path),
      shouldLoadLocalFileThumbnail(file) ? localFileThumbnailDataUrl(file.path, LOCAL_FILE_THUMBNAIL_TIMEOUT_MS) : Promise.resolve(null),
    ]);
    return {
      ...file,
      ...(iconDataUrl ? { iconDataUrl } : {}),
      ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
    };
  }));
}

function shouldLoadLocalFileThumbnail(file: { entryKind?: string; mimeType?: string; name?: string }): boolean {
  if (file.entryKind === 'directory' || file.mimeType === 'inode/directory') return false;
  const mimeType = (file.mimeType ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) return true;
  const extension = extname(file.name ?? '').toLowerCase();
  return [
    '.avif',
    '.bmp',
    '.gif',
    '.heic',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.tif',
    '.tiff',
    '.webp',
  ].includes(extension);
}

function localFilePathRank(filePath: string, query: string): number {
  const name = basename(filePath).toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (name === lowerQuery) return 0;
  if (name.startsWith(lowerQuery)) return 1;
  const wordIndex = name.search(new RegExp(`(^|[\\s._-])${escapeRegExp(lowerQuery)}`, 'u'));
  if (wordIndex >= 0) return 2 + wordIndex / 1000;
  const containsIndex = name.indexOf(lowerQuery);
  if (containsIndex >= 0) return 4 + containsIndex / 1000;
  return 10;
}

// Bounded LRU-ish insert: re-touch the key so it stays fresh and evict the
// oldest entries when over the cap, instead of clearing the whole map. Wholesale
// clearing would drop ids that prepare/preview still need for the visible
// results, leaving recently surfaced files unselectable mid-session.
function setBoundedLocalFileCache<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > LOCAL_FILE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cacheLocalFileSearchPath(filePath: string): string {
  const id = createHash('sha256').update(filePath).digest('hex').slice(0, 24);
  setBoundedLocalFileCache(localFileSearchCache, id, filePath);
  return id;
}

async function localFileIconDataUrl(filePath: string): Promise<string | null> {
  const cached = localFileIconCache.get(filePath);
  if (cached !== undefined) return cached;
  let pending = pendingLocalFileIconLoads.get(filePath);
  if (!pending) {
    pending = loadLocalFileIconDataUrl(filePath)
      .finally(() => pendingLocalFileIconLoads.delete(filePath));
    pendingLocalFileIconLoads.set(filePath, pending);
  }
  return promiseWithTimeout(pending, LOCAL_FILE_ICON_TIMEOUT_MS, null);
}

async function loadLocalFileIconDataUrl(filePath: string): Promise<string | null> {
  try {
    const image = await app.getFileIcon(filePath, { size: LOCAL_FILE_ICON_SIZE });
    const iconDataUrl = image.isEmpty() ? null : image.toDataURL();
    setBoundedLocalFileCache(localFileIconCache, filePath, iconDataUrl);
    return iconDataUrl;
  } catch {
    setBoundedLocalFileCache(localFileIconCache, filePath, null);
    return null;
  }
}

async function localFileThumbnailDataUrl(filePath: string, timeoutMs: number): Promise<string | null> {
  const cached = localFileThumbnailCache.get(filePath);
  if (cached !== undefined) return cached;
  let pending = pendingLocalFileThumbnailLoads.get(filePath);
  if (!pending) {
    pending = loadLocalFileThumbnailDataUrl(filePath)
      .finally(() => pendingLocalFileThumbnailLoads.delete(filePath));
    pendingLocalFileThumbnailLoads.set(filePath, pending);
  }
  return promiseWithTimeout(pending, timeoutMs, null);
}

async function loadLocalFileThumbnailDataUrl(filePath: string): Promise<string | null> {
  try {
    const image = await nativeImage.createThumbnailFromPath(filePath, {
      width: LOCAL_FILE_THUMBNAIL_SIZE,
      height: LOCAL_FILE_THUMBNAIL_SIZE,
    });
    const thumbnailDataUrl = image.isEmpty() ? null : image.toDataURL();
    setBoundedLocalFileCache(localFileThumbnailCache, filePath, thumbnailDataUrl);
    return thumbnailDataUrl;
  } catch {
    setBoundedLocalFileCache(localFileThumbnailCache, filePath, null);
    return null;
  }
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function localPickedFile(filePath: string) {
  try {
    const fileStat = await stat(filePath);
    const entryKind = fileStat.isDirectory() ? 'directory' : fileStat.isFile() ? 'file' : null;
    if (!entryKind) return null;
    if (entryKind === 'file' && fileStat.size <= 0) return null;
    const mimeType = entryKind === 'directory' ? 'inode/directory' : inferMimeType(filePath);
    const imageDataBase64 = entryKind === 'file' && isInlineImageMimeType(mimeType) && fileStat.size <= 10 * 1024 * 1024
      ? (await readFile(filePath)).toString('base64')
      : undefined;
    const [visual] = await withLocalFileIcons([{
      entryKind,
      mimeType,
      name: basename(filePath),
      path: filePath,
    }]);
    return {
      entryKind,
      path: filePath,
      name: basename(filePath),
      mimeType,
      sizeBytes: entryKind === 'directory' ? 0 : fileStat.size,
      lastModified: fileStat.mtimeMs,
      ...(visual?.iconDataUrl ? { iconDataUrl: visual.iconDataUrl } : {}),
      ...(visual?.thumbnailDataUrl ? { thumbnailDataUrl: visual.thumbnailDataUrl } : {}),
      ...(imageDataBase64 ? { imageDataBase64 } : {}),
    };
  } catch {
    return null;
  }
}

function safeAppPath(name: Parameters<typeof app.getPath>[0]): string | null {
  try {
    return app.getPath(name);
  } catch {
    return null;
  }
}

function inferMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.avif') return 'image/avif';
  if (extension === '.bmp') return 'image/bmp';
  if (extension === '.heic') return 'image/heic';
  if (extension === '.tif' || extension === '.tiff') return 'image/tiff';
  if (extension === '.pdf') return 'application/pdf';
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
  if (extension === '.json') return 'application/json';
  if (extension === '.xml') return 'application/xml';
  if (extension === '.yaml' || extension === '.yml') return 'application/yaml';
  if (TEXT_ATTACHMENT_EXTENSIONS.has(extension)) return 'text/plain';
  return 'application/octet-stream';
}

function isInlineImageMimeType(mimeType: string): boolean {
  return mimeType === 'image/jpeg'
    || mimeType === 'image/png'
    || mimeType === 'image/gif'
    || mimeType === 'image/webp';
}

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.c',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.log',
  '.md',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
]);

async function handleAgentCommand(command: AgentCommand, args: Record<string, unknown>) {
  switch (command) {
    case 'agent_restore_latest_session':
      return agentRuntime.restoreLatestSession();
    case 'agent_restore_session':
      return agentRuntime.restoreSession(String(args.sessionId));
    case 'agent_create_session':
      return agentRuntime.createSession();
    case 'agent_list_sessions':
      return agentRuntime.listSessions();
    case 'agent_rename_session':
      return agentRuntime.renameSession(String(args.sessionId), String(args.title ?? ''));
    case 'agent_delete_session':
      return agentRuntime.deleteSession(String(args.sessionId));
    case 'agent_debug_snapshot':
      return agentRuntime.debugSnapshot(String(args.sessionId));
    case 'agent_debug_history':
      return agentRuntime.debugHistory(String(args.sessionId));
    case 'agent_debug_totals':
      return agentRuntime.debugTotals(String(args.sessionId));
    case 'agent_debug_payload':
      return agentRuntime.debugPayload(String(args.sessionId), String(args.payloadId));
    case 'agent_payload_text':
      return agentRuntime.payloadText(String(args.sessionId), String(args.payloadId));
    case 'agent_subagent_status':
      return agentRuntime.subagentStatus(String(args.sessionId), String(args.agentId), {
        wait: args.wait === true,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      });
    case 'agent_subagent_send':
      return agentRuntime.subagentSend(String(args.sessionId), String(args.agentId), String(args.message ?? ''));
    case 'agent_subagent_stop':
      return agentRuntime.subagentStop(String(args.sessionId), String(args.agentId));
    case 'agent_send_message':
      return agentRuntime.sendMessage(
        String(args.sessionId),
        String(args.message ?? ''),
        args.attachments,
        args.userViewContext,
      );
    case 'agent_edit_message':
      return agentRuntime.editMessage(
        String(args.sessionId),
        String(args.nodeId),
        String(args.message ?? ''),
      );
    case 'agent_regenerate_message':
      return agentRuntime.regenerateMessage(String(args.sessionId), String(args.nodeId));
    case 'agent_retry_message':
      return agentRuntime.retryMessage(String(args.sessionId), String(args.nodeId));
    case 'agent_switch_branch':
      return agentRuntime.switchBranch(String(args.sessionId), String(args.nodeId));
    case 'agent_queue_follow_up':
      return agentRuntime.queueFollowUp(
        String(args.sessionId),
        String(args.message ?? ''),
        args.userViewContext,
      );
    case 'agent_clear_follow_up':
      return agentRuntime.clearFollowUp(String(args.sessionId));
    case 'agent_steer_session':
      return agentRuntime.steerSession(
        String(args.sessionId),
        String(args.message ?? ''),
      );
    case 'agent_clear_steer':
      return agentRuntime.clearSteer(String(args.sessionId));
    case 'agent_stop_session':
      return agentRuntime.stopSession(String(args.sessionId));
    case 'agent_reset_session':
      return agentRuntime.resetSession(String(args.sessionId));
    case 'agent_close_session':
      return agentRuntime.closeSession(String(args.sessionId));
    case 'agent_list_slash_commands':
      return agentRuntime.listSlashCommands(String(args.sessionId));
    case 'agent_get_provider_settings':
      return getProviderSettings();
    case 'agent_update_runtime_settings':
      return updateAgentRuntimeSettings(args.settings as AgentRuntimeSettingsInput);
    case 'agent_upsert_provider_config':
      return upsertProviderConfig(args.provider as AgentProviderConfigInput);
    case 'agent_delete_provider_config':
      return deleteProviderConfig(String(args.providerId));
    case 'agent_set_active_provider':
      return setActiveProvider(String(args.providerId));
    case 'agent_set_provider_api_key':
      return setProviderApiKey(String(args.providerId), String(args.apiKey ?? ''));
    case 'agent_delete_provider_api_key':
      return deleteProviderApiKey(String(args.providerId));
    case 'agent_get_provider_secret_status':
      return getProviderSecretStatus(String(args.providerId));
    case 'agent_list_all_definitions':
      return agentRuntime.listAllAgentDefinitions(String(args.sessionId));
    case 'agent_test_provider_connection':
      return testProviderConnection({
        providerId: String(args.providerId),
        modelId: String(args.modelId),
        baseUrl: args.baseUrl ? String(args.baseUrl) : undefined,
        apiKey: args.apiKey ? String(args.apiKey) : undefined,
      });
    case 'agent_list_all_skills':
      return agentRuntime.listAllSkills(String(args.sessionId));
    default:
      throw new Error(`Unknown agent command: ${command}`);
  }
}

// Single-instance: a second launch focuses the running window instead of
// spawning a duplicate process (macOS enforces this for packaged apps, Windows
// does not). If we don't hold the lock, another instance owns the session — let
// it surface its window and exit immediately.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focusMainWindow);

  app.whenReady().then(() => {
    protocol.handle(ASSET_URL_SCHEME, (request) => {
      const id = new URL(request.url).hostname;
      return assetService.serve(id);
    });
    configureSessionSecurity();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitAfterFlush) return;
    event.preventDefault();
    quitAfterFlush = true;
    void documentService.flushPendingChanges()
      .catch((error) => console.error(error))
      .finally(() => app.quit());
  });
}
