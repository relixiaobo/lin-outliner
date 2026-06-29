import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetIngestInput, AssetMetadata } from '../core/types';
import { isPathInside } from './agentAttachmentMaterialization';
import { atomicWriteFile, writeJsonFile } from './jsonFileStore';

const META_SUFFIX = '.meta.json';
// Lowercase + digits only: ids land in `asset://<id>` URLs whose hostname
// the URL parser lowercases, so a mixed-case id would never match its file.
const NANOID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Owns binary asset files under a single directory. The document references
 * assets purely by id; bytes and metadata live on disk so the CRDT stays small
 * and assets can later sync out-of-band. The renderer reads them through the
 * `asset://` protocol handled by `serve`.
 *
 * Layout:
 *   <root>/<id>.<ext>        raw bytes (extension is informational only)
 *   <root>/<id>.meta.json    metadata sidecar (authoritative)
 */
export class AssetService {
  private readonly resolveRoot: () => string;
  private readonly metaCache = new Map<string, AssetMetadata>();

  constructor(root: string | (() => string)) {
    this.resolveRoot = typeof root === 'string' ? () => root : root;
  }

  private get root() {
    return this.resolveRoot();
  }

  async ingest(input: AssetIngestInput): Promise<AssetMetadata> {
    const { bytes, originalFilename, hintedMime } = await this.readInput(input);
    const mimeType = sniffMimeType(bytes, originalFilename) ?? hintedMime ?? 'application/octet-stream';
    const id = nanoid();
    const ext = extensionForMime(mimeType, originalFilename);
    const dimensions = imageDimensions(bytes, mimeType);
    const durationMs = mediaDurationMs(bytes, mimeType);
    const metadata: AssetMetadata = {
      id,
      mimeType,
      byteSize: bytes.byteLength,
      createdAt: Date.now(),
      ...(originalFilename ? { originalFilename } : {}),
      ...(dimensions ? { imageWidth: dimensions.width, imageHeight: dimensions.height } : {}),
      ...(mimeType === 'application/pdf' ? pdfMetadata(bytes) : {}),
      ...(durationMs !== undefined && mimeType.startsWith('audio/') ? { audioDurationMs: durationMs } : {}),
      ...(durationMs !== undefined && mimeType.startsWith('video/') ? { videoDurationMs: durationMs } : {}),
    };
    await mkdir(this.root, { recursive: true });
    const assetPath = join(this.root, `${id}${ext}`);
    await atomicWriteFile(assetPath, bytes);
    const thumbnailAssetId = mimeType === 'application/pdf'
      ? await this.derivePdfThumbnail(assetPath, originalFilename)
      : undefined;
    if (thumbnailAssetId) metadata.thumbnailAssetId = thumbnailAssetId;
    await writeJsonFile(join(this.root, `${id}${META_SUFFIX}`), metadata, { trailingNewline: false });
    this.metaCache.set(id, metadata);
    return metadata;
  }

  async lookup(id: string): Promise<AssetMetadata | null> {
    const cached = this.metaCache.get(id);
    if (cached) return cached;
    try {
      const raw = await readFile(join(this.root, `${sanitizeId(id)}${META_SUFFIX}`), 'utf8');
      const metadata = JSON.parse(raw) as AssetMetadata;
      this.metaCache.set(id, metadata);
      return metadata;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Absolute path to the stored asset bytes, or null if missing. */
  async pathFor(id: string): Promise<string | null> {
    return this.safeAssetFilePath(sanitizeId(id));
  }

  async delete(id: string): Promise<void> {
    const safe = sanitizeId(id);
    this.metaCache.delete(id);
    const file = await this.findAssetFile(safe);
    await Promise.all([
      file ? unlink(join(this.root, file)).catch(ignoreNotFound) : Promise.resolve(),
      unlink(join(this.root, `${safe}${META_SUFFIX}`)).catch(ignoreNotFound),
    ]);
  }

  /** Serve an asset for the `asset://<id>` protocol handler. */
  async serve(id: string): Promise<Response> {
    let safe: string;
    try {
      safe = sanitizeId(id);
    } catch {
      // A malformed id is a miss, not a transport failure — answer 404 so the
      // renderer shows its placeholder instead of an ERR_FAILED.
      return notFoundResponse();
    }
    const metadata = await this.lookup(safe);
    const filePath = await this.safeAssetFilePath(safe);
    if (!filePath) return notFoundResponse();
    // Whole-file read is fine for images; large media (video/audio) will need a
    // streaming/range response — a follow-up when those types land.
    const bytes = await readFile(filePath);
    return new Response(bytes, {
      status: 200,
      headers: {
        // SVGs are served here only to be drawn in <img>, where scripts do not
        // execute. If an asset is ever rendered via <object>/<iframe> or direct
        // navigation, sanitize the SVG or add CSP/Content-Disposition first.
        'content-type': metadata?.mimeType ?? 'application/octet-stream',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  }

  private async readInput(input: AssetIngestInput) {
    if (input.kind === 'path') {
      const sourcePath = await realpath(input.path);
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) throw new Error('Only regular files can be ingested as assets.');
      const bytes = await readFile(sourcePath);
      return { bytes, originalFilename: basename(sourcePath), hintedMime: undefined as string | undefined };
    }
    const bytes = Buffer.from(input.data);
    return { bytes, originalFilename: input.originalFilename, hintedMime: input.mimeType };
  }

  private async safeAssetFilePath(safeId: string): Promise<string | null> {
    const file = await this.findAssetFile(safeId);
    if (!file) return null;
    try {
      const [rootRealPath, fileRealPath] = await Promise.all([
        realpath(this.root),
        realpath(join(this.root, file)),
      ]);
      if (!isPathInside(rootRealPath, fileRealPath)) return null;
      const fileStat = await stat(fileRealPath);
      return fileStat.isFile() ? fileRealPath : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async findAssetFile(safeId: string): Promise<string | null> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    return entries.find((name) => name === safeId || (name.startsWith(`${safeId}.`) && !name.endsWith(META_SUFFIX))) ?? null;
  }

  private async derivePdfThumbnail(pdfPath: string, originalFilename: string | undefined): Promise<string | undefined> {
    const tempDir = await mkdtemp(join(this.root, '.pdf-thumb-'));
    try {
      const prefix = join(tempDir, 'page');
      const result = await runProcess('pdftoppm', [
        '-f', '1',
        '-l', '1',
        '-singlefile',
        '-png',
        '-scale-to', '512',
        pdfPath,
        prefix,
      ], 5000);
      if (!result.ok) return undefined;
      const pngPath = `${prefix}.png`;
      const pngBytes = await readFile(pngPath).catch(() => null);
      if (!pngBytes || pngBytes.byteLength === 0) return undefined;
      const id = nanoid();
      const dimensions = imageDimensions(pngBytes, 'image/png');
      const metadata: AssetMetadata = {
        id,
        mimeType: 'image/png',
        byteSize: pngBytes.byteLength,
        createdAt: Date.now(),
        originalFilename: `${originalFilename ?? 'attachment.pdf'} thumbnail.png`,
        ...(dimensions ? { imageWidth: dimensions.width, imageHeight: dimensions.height } : {}),
      };
      await atomicWriteFile(join(this.root, `${id}.png`), pngBytes);
      await writeJsonFile(join(this.root, `${id}${META_SUFFIX}`), metadata, { trailingNewline: false });
      this.metaCache.set(id, metadata);
      return id;
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function notFoundResponse(): Response {
  return new Response('Asset not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function nanoid(size = 21): string {
  const bytes = randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i += 1) id += NANOID_ALPHABET[bytes[i] % NANOID_ALPHABET.length];
  return id;
}

/** Reject ids that could escape the asset directory. */
function sanitizeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid asset id: ${id}`);
  return id;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'application/epub+zip': '.epub',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/zip': '.zip',
};

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

export function mimeTypeForFilename(filename: string): string | undefined {
  return EXT_TO_MIME[extname(filename).toLowerCase()];
}

function extname(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function extensionForMime(mimeType: string, filename?: string): string {
  if (MIME_TO_EXT[mimeType]) return MIME_TO_EXT[mimeType];
  const fromName = filename ? extname(filename) : '';
  return fromName || '.bin';
}

/** Sniff a MIME type from magic bytes, falling back to the filename extension. */
export function sniffMimeType(bytes: Uint8Array, filename?: string): string | undefined {
  const filenameMimeType = filename ? mimeTypeForFilename(filename) : undefined;
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif') return 'image/avif';
    if (brand.startsWith('hei') || brand === 'mif1') return 'image/heic';
    if (['M4A ', 'M4B ', 'M4P ', 'M4V '].includes(brand)) return brand === 'M4V ' ? 'video/mp4' : 'audio/mp4';
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand)) return 'video/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
  }
  if (bytes.length >= 5 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return 'audio/wav';
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg';
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'audio/ogg';
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return filenameMimeType === 'application/epub+zip' ? filenameMimeType : 'application/zip';
  }
  if (looksLikeSvg(bytes)) return 'image/svg+xml';
  return filenameMimeType;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 256))).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<?xml') ? head.includes('<svg') : head.startsWith('<svg');
}

/** Decode intrinsic pixel dimensions from common raster headers. */
export function imageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mimeType === 'image/png' && bytes.length >= 24) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mimeType === 'image/gif' && bytes.length >= 10) {
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (mimeType === 'image/bmp' && bytes.length >= 26) {
      return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
    }
    if (mimeType === 'image/jpeg') return jpegDimensions(view, bytes.length);
    if (mimeType === 'image/webp') return webpDimensions(bytes, view);
  } catch {
    return undefined;
  }
  return undefined;
}

function jpegDimensions(view: DataView, length: number): { width: number; height: number } | undefined {
  let offset = 2; // skip SOI
  while (offset + 9 < length) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = view.getUint8(offset + 1);
    // SOF0..SOF15 carry frame dimensions (skip DHT/DAC/RSTn/SOS markers).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array, view: DataView): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  const format = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (format === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (format === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  return undefined;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT';
}

function ignoreNotFound(error: unknown): void {
  if (!isNotFound(error)) throw error;
}

function pdfMetadata(bytes: Uint8Array): Pick<AssetMetadata, 'pdfPageCount'> {
  const text = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 8 * 1024 * 1024))).toString('latin1');
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches && matches.length > 0 ? { pdfPageCount: matches.length } : {};
}

function mediaDurationMs(bytes: Uint8Array, mimeType: string): number | undefined {
  if (mimeType === 'audio/wav') return wavDurationMs(bytes);
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'audio/mp4') {
    return mp4DurationMs(bytes);
  }
  return undefined;
}

function wavDurationMs(bytes: Uint8Array): number | undefined {
  if (bytes.length < 44) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;
  while (offset + 8 <= bytes.length) {
    const chunk = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (chunk === 'fmt ' && dataOffset + 12 <= bytes.length) byteRate = view.getUint32(dataOffset + 8, true);
    if (chunk === 'data') dataSize = size;
    if (byteRate && dataSize !== undefined) break;
    offset = dataOffset + size + (size % 2);
  }
  if (!byteRate || dataSize === undefined) return undefined;
  return Math.round((dataSize / byteRate) * 1000);
}

function mp4DurationMs(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findMvhd = (start: number, end: number): { offset: number; size: number } | undefined => {
    let offset = start;
    while (offset + 8 <= end && offset + 8 <= bytes.length) {
      const size32 = view.getUint32(offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const headerSize = size32 === 1 ? 16 : 8;
      const size = size32 === 1 && offset + 16 <= bytes.length
        ? Number(view.getBigUint64(offset + 8))
        : size32;
      if (!Number.isSafeInteger(size) || size < headerSize) return undefined;
      const boxEnd = Math.min(offset + size, bytes.length);
      if (type === 'mvhd') return { offset: offset + headerSize, size: boxEnd - offset - headerSize };
      if (type === 'moov') {
        const nested = findMvhd(offset + headerSize, boxEnd);
        if (nested) return nested;
      }
      offset = boxEnd;
    }
    return undefined;
  };
  const mvhd = findMvhd(0, bytes.length);
  if (!mvhd || mvhd.size < 20) return undefined;
  const version = view.getUint8(mvhd.offset);
  if (version === 1) {
    if (mvhd.size < 32) return undefined;
    const timescale = view.getUint32(mvhd.offset + 20);
    const duration = view.getBigUint64(mvhd.offset + 24);
    return timescale > 0 ? Math.round(Number(duration) * 1000 / timescale) : undefined;
  }
  const timescale = view.getUint32(mvhd.offset + 12);
  const duration = view.getUint32(mvhd.offset + 16);
  return timescale > 0 ? Math.round(duration * 1000 / timescale) : undefined;
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}
