import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { isPathInside } from './agent/capabilities/agentAttachmentMaterialization';
import type { TrustedLocalFileReference } from './localFileReferenceSecurity';
import type { OpenedLinkedFileReference } from './linkedFileGrantStore';

export interface PreviewLocalFileTokenEntry {
  constraint: { kind: 'root'; path: string } | { kind: 'exact'; path: string };
  mimeType: string;
  path: string;
  sizeBytes: number;
}

interface OpenPreviewLocalFile extends PreviewLocalFileTokenEntry {
  handle: FileHandle;
  closeAfterServe: boolean;
}

interface StoredPreviewLocalFile extends PreviewLocalFileTokenEntry {
  handle?: FileHandle;
  identity?: { dev: number | bigint; ino: number | bigint };
}

const PREVIEW_LOCAL_TOKEN_LIMIT = 512;
const SINGLE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/u;
const OPEN_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;

export class LocalFilePreviewStreamRegistry {
  private readonly entries = new Map<string, StoredPreviewLocalFile>();
  private readonly allowedRoots: () => readonly string[];

  constructor(allowedRoots: () => readonly string[]) {
    this.allowedRoots = allowedRoots;
  }

  async issue(file: TrustedLocalFileReference, mimeType: string): Promise<string | null> {
    if (file.entryKind !== 'file') return null;
    return this.issuePath(file.path, mimeType);
  }

  async issuePath(filePath: string, mimeType: string): Promise<string | null> {
    const resolvedPath = await realpath(filePath).catch(() => null);
    if (!resolvedPath) return null;
    const fileStats = await stat(resolvedPath).catch(() => null);
    if (!fileStats?.isFile() || fileStats.size <= 0) return null;
    const rootPath = await trustedRootForFile(resolvedPath, this.allowedRoots());
    if (!rootPath) return null;
    const token = randomUUID();
    this.setEntry(token, {
      constraint: { kind: 'root', path: rootPath },
      mimeType,
      path: resolvedPath,
      sizeBytes: fileStats.size,
    });
    return token;
  }

  async issueExactPath(filePath: string, mimeType: string): Promise<string | null> {
    const resolvedPath = await realpath(filePath).catch(() => null);
    if (!resolvedPath) return null;
    const handle = await open(resolvedPath, OPEN_NOFOLLOW).catch(() => null);
    if (!handle) return null;
    let transferred = false;
    try {
      const [fileStats, freshStats, freshPath] = await Promise.all([
        handle.stat(),
        stat(resolvedPath).catch(() => null),
        realpath(filePath).catch(() => null),
      ]);
      if (
        !fileStats.isFile()
        || fileStats.size <= 0
        || !freshStats?.isFile()
        || freshPath !== resolvedPath
        || !sameFileIdentity(fileStats, freshStats)
      ) return null;
      const token = await this.issueExactFile({
        entryKind: 'file',
        path: resolvedPath,
        stats: fileStats,
        handle,
      }, mimeType);
      transferred = token !== null;
      return token;
    } finally {
      if (!transferred) await handle.close().catch(() => undefined);
    }
  }

  async issueExactFile(file: OpenedLinkedFileReference, mimeType: string): Promise<string | null> {
    if (file.entryKind !== 'file' || file.stats.size <= 0) return null;
    const currentStats = await file.handle.stat().catch(() => null);
    if (
      !currentStats?.isFile()
      || currentStats.size <= 0
      || !sameFileIdentity(currentStats, file.stats)
    ) return null;
    const token = randomUUID();
    this.setEntry(token, {
      constraint: { kind: 'exact', path: file.path },
      handle: file.handle,
      identity: { dev: currentStats.dev, ino: currentStats.ino },
      mimeType,
      path: file.path,
      sizeBytes: currentStats.size,
    });
    return token;
  }

  async close(): Promise<void> {
    const handles = [...this.entries.values()].flatMap((entry) => entry.handle ? [entry.handle] : []);
    this.entries.clear();
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  }

  async serve(token: string, request: Pick<Request, 'headers'>): Promise<Response> {
    const entry = this.entries.get(token);
    if (!entry) return notFoundResponse();
    const current = await openCurrentSafeFile(entry);
    if (!current) {
      await this.deleteEntry(token);
      return notFoundResponse();
    }
    const range = parseRangeHeader(request.headers.get('range'), current.sizeBytes);
    if (range === 'invalid') {
      if (current.closeAfterServe) await current.handle.close().catch(() => undefined);
      return rangeNotSatisfiableResponse(current.sizeBytes);
    }

    const headers = new Headers({
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-type': current.mimeType,
    });
    const streamOptions = range
      ? { start: range.start, end: range.end, autoClose: current.closeAfterServe }
      : { start: 0, end: current.sizeBytes - 1, autoClose: current.closeAfterServe };
    const contentLength = range
      ? range.end - range.start + 1
      : current.sizeBytes;
    headers.set('content-length', String(contentLength));
    if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${current.sizeBytes}`);

    return new Response(Readable.toWeb(current.handle.createReadStream(streamOptions)) as ReadableStream, {
      status: range ? 206 : 200,
      headers,
    });
  }

  private setEntry(token: string, entry: StoredPreviewLocalFile): void {
    this.entries.set(token, entry);
    while (this.entries.size > PREVIEW_LOCAL_TOKEN_LIMIT) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      void this.deleteEntry(oldest.value);
    }
  }

  private async deleteEntry(token: string): Promise<void> {
    const entry = this.entries.get(token);
    this.entries.delete(token);
    await entry?.handle?.close().catch(() => undefined);
  }
}

export function parseRangeHeader(
  header: string | null,
  sizeBytes: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return 'invalid';
  const match = SINGLE_RANGE_PATTERN.exec(header.trim());
  if (!match) return 'invalid';

  const [, startText, endText] = match;
  if (!startText && !endText) return 'invalid';

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    const start = Math.max(sizeBytes - suffixLength, 0);
    return { start, end: sizeBytes - 1 };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= sizeBytes) return 'invalid';
  const requestedEnd = endText ? Number(endText) : sizeBytes - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return 'invalid';
  return { start, end: Math.min(requestedEnd, sizeBytes - 1) };
}

async function trustedRootForFile(filePath: string, allowedRoots: readonly string[]): Promise<string | null> {
  const fileRealPath = await realpath(filePath).catch(() => null);
  if (!fileRealPath) return null;
  for (const root of allowedRoots) {
    const rootRealPath = await safeTrustedRootRealPath(root);
    if (rootRealPath && isPathInside(rootRealPath, fileRealPath)) return rootRealPath;
  }
  return null;
}

async function openCurrentSafeFile(entry: StoredPreviewLocalFile): Promise<OpenPreviewLocalFile | null> {
  const fileRealPath = await realpath(entry.path).catch(() => null);
  if (!fileRealPath || !matchesConstraint(entry.constraint, fileRealPath)) return null;
  if (entry.handle && entry.identity) {
    const [fileStats, freshStats, freshRealPath] = await Promise.all([
      entry.handle.stat().catch(() => null),
      stat(entry.path).catch(() => null),
      realpath(entry.path).catch(() => null),
    ]);
    if (
      !fileStats?.isFile()
      || fileStats.size <= 0
      || !freshStats?.isFile()
      || freshRealPath !== entry.constraint.path
      || !sameFileIdentity(fileStats, freshStats)
      || !sameFileIdentity(fileStats, entry.identity)
    ) return null;
    return {
      ...entry,
      handle: entry.handle,
      closeAfterServe: false,
      path: fileRealPath,
      sizeBytes: fileStats.size,
    };
  }
  const handle = await open(fileRealPath, OPEN_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const [fileStats, freshStats, freshRealPath] = await Promise.all([
      handle.stat(),
      stat(fileRealPath).catch(() => null),
      realpath(entry.path).catch(() => null),
    ]);
    if (
      !fileStats.isFile()
      || fileStats.size <= 0
      || !freshStats?.isFile()
      || freshRealPath !== fileRealPath
      || fileStats.dev !== freshStats.dev
      || fileStats.ino !== freshStats.ino
    ) {
      await handle.close().catch(() => undefined);
      return null;
    }
    return {
      ...entry,
      handle,
      closeAfterServe: true,
      path: fileRealPath,
      sizeBytes: fileStats.size,
    };
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function matchesConstraint(
  constraint: PreviewLocalFileTokenEntry['constraint'],
  filePath: string,
): boolean {
  return constraint.kind === 'exact'
    ? filePath === constraint.path
    : isPathInside(constraint.path, filePath);
}

async function safeTrustedRootRealPath(root: string): Promise<string | null> {
  const rootRealPath = await realpath(root).catch(() => null);
  if (!rootRealPath) return null;
  return isFilesystemRoot(rootRealPath) ? null : rootRealPath;
}

function isFilesystemRoot(filePath: string): boolean {
  return /^\/?$/u.test(filePath) || /^[A-Za-z]:[\\/]?$/u.test(filePath);
}

function notFoundResponse(): Response {
  return new Response('Preview file not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function rangeNotSatisfiableResponse(sizeBytes: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes */${Math.max(sizeBytes, 0)}`,
    },
  });
}
