import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { isPathInside } from './agentAttachmentMaterialization';
import { setBoundedMapEntry } from './boundedMap';
import type { TrustedLocalFileReference } from './localFileReferenceSecurity';

export interface PreviewLocalFileTokenEntry {
  mimeType: string;
  path: string;
  rootPath: string;
  sizeBytes: number;
}

interface OpenPreviewLocalFile extends PreviewLocalFileTokenEntry {
  handle: FileHandle;
}

const PREVIEW_LOCAL_TOKEN_LIMIT = 512;
const SINGLE_RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/u;
const OPEN_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;

export class LocalFilePreviewStreamRegistry {
  private readonly entries = new Map<string, PreviewLocalFileTokenEntry>();
  private readonly allowedRoots: () => readonly string[];

  constructor(allowedRoots: () => readonly string[]) {
    this.allowedRoots = allowedRoots;
  }

  async issue(file: TrustedLocalFileReference, mimeType: string): Promise<string | null> {
    if (file.entryKind !== 'file') return null;
    const rootPath = await trustedRootForFile(file.path, this.allowedRoots());
    if (!rootPath) return null;
    const token = randomUUID();
    setBoundedMapEntry(this.entries, token, {
      mimeType,
      path: file.path,
      rootPath,
      sizeBytes: file.stats.size,
    }, PREVIEW_LOCAL_TOKEN_LIMIT);
    return token;
  }

  async serve(token: string, request: Pick<Request, 'headers'>): Promise<Response> {
    const entry = this.entries.get(token);
    if (!entry) return notFoundResponse();
    const current = await openCurrentSafeFile(entry);
    if (!current) {
      this.entries.delete(token);
      return notFoundResponse();
    }
    const range = parseRangeHeader(request.headers.get('range'), current.sizeBytes);
    if (range === 'invalid') {
      await current.handle.close().catch(() => undefined);
      return rangeNotSatisfiableResponse(current.sizeBytes);
    }

    const headers = new Headers({
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-type': current.mimeType,
    });
    const streamOptions = range
      ? { start: range.start, end: range.end }
      : undefined;
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

async function openCurrentSafeFile(entry: PreviewLocalFileTokenEntry): Promise<OpenPreviewLocalFile | null> {
  const fileRealPath = await realpath(entry.path).catch(() => null);
  if (!fileRealPath || !isPathInside(entry.rootPath, fileRealPath)) return null;
  const handle = await open(fileRealPath, OPEN_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile() || fileStats.size <= 0) {
      await handle.close().catch(() => undefined);
      return null;
    }
    return {
      ...entry,
      handle,
      path: fileRealPath,
      sizeBytes: fileStats.size,
    };
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
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
