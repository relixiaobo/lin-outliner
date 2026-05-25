import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetIngestInput, AssetMetadata } from '../core/types';

const META_SUFFIX = '.meta.json';
const NANOID_ALPHABET = 'useandom26T198340PXJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';

/**
 * Owns binary asset files under a single directory. The document references
 * assets purely by id; bytes and metadata live on disk so the CRDT stays small
 * and assets can later sync out-of-band. The renderer reads them through the
 * `lin-asset://` protocol handled by `serve`.
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
    const metadata: AssetMetadata = {
      id,
      mimeType,
      byteSize: bytes.byteLength,
      createdAt: Date.now(),
      ...(originalFilename ? { originalFilename } : {}),
      ...(dimensions ? { imageWidth: dimensions.width, imageHeight: dimensions.height } : {}),
    };
    await mkdir(this.root, { recursive: true });
    await this.atomicWrite(join(this.root, `${id}${ext}`), bytes);
    await this.atomicWrite(join(this.root, `${id}${META_SUFFIX}`), Buffer.from(JSON.stringify(metadata, null, 2)));
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
    const file = await this.findAssetFile(sanitizeId(id));
    return file ? join(this.root, file) : null;
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

  /** Serve an asset for the `lin-asset://<id>` protocol handler. */
  async serve(id: string): Promise<Response> {
    const safe = sanitizeId(id);
    const metadata = await this.lookup(safe);
    const file = await this.findAssetFile(safe);
    if (!file) {
      return new Response('Asset not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const bytes = await readFile(join(this.root, file));
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': metadata?.mimeType ?? 'application/octet-stream',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  }

  private async readInput(input: AssetIngestInput) {
    if (input.kind === 'path') {
      const bytes = await readFile(input.path);
      return { bytes, originalFilename: basename(input.path), hintedMime: undefined as string | undefined };
    }
    const bytes = Buffer.from(input.data);
    return { bytes, originalFilename: input.originalFilename, hintedMime: input.mimeType };
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

  private async atomicWrite(path: string, data: Buffer) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  }
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
};

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
  }
  if (bytes.length >= 5 && String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) === '%PDF-') return 'application/pdf';
  if (looksLikeSvg(bytes)) return 'image/svg+xml';
  return filename ? EXT_TO_MIME[extname(filename)] : undefined;
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
