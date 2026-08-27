const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  mka: 'audio/x-matroska',
  wma: 'audio/x-ms-wma',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
});

export function mimeTypeForAssetFilename(filename: string): string | undefined {
  const normalized = filename.replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = basename.lastIndexOf('.');
  return dot >= 0 ? MIME_BY_EXTENSION[basename.slice(dot + 1).toLowerCase()] : undefined;
}

export function sniffAssetMimeType(bytes: Uint8Array, filename?: string): string | undefined {
  const filenameMimeType = filename ? mimeTypeForAssetFilename(filename) : undefined;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46])) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (brand === 'avif') return 'image/avif';
    if (brand.startsWith('hei') || brand === 'mif1') return 'image/heic';
    if (['M4A ', 'M4B ', 'M4P '].includes(brand)) return 'audio/mp4';
    if (brand === 'M4V ' || ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand)) return 'video/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'AVI ') return 'video/x-msvideo';
  if (ascii(bytes, 0, 3) === 'ID3') return 'audio/mpeg';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'audio/flac';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(bytes, 0, 4) === 'OggS') {
    return filenameMimeType === 'video/ogg' || filenameMimeType === 'audio/opus'
      ? filenameMimeType
      : 'audio/ogg';
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return filenameMimeType === 'application/epub+zip' ? filenameMimeType : 'application/zip';
  }
  if (looksLikeSvg(bytes)) return 'image/svg+xml';
  return filenameMimeType;
}

export function assetImageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): { width: number; height: number } | undefined {
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

export function assetPdfPageCount(bytes: Uint8Array): number | undefined {
  const text = Buffer.from(bytes).toString('latin1');
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches && matches.length > 0 ? matches.length : undefined;
}

export function assetMediaDurationMs(bytes: Uint8Array, mimeType: string): number | undefined {
  if (mimeType === 'audio/wav') return wavDurationMs(bytes);
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime' || mimeType === 'audio/mp4') {
    return mp4DurationMs(bytes);
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 256))).toString('utf8').trimStart().toLowerCase();
  return head.startsWith('<?xml') ? head.includes('<svg') : head.startsWith('<svg');
}

function jpegDimensions(view: DataView, length: number): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < length) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = view.getUint8(offset + 1);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + view.getUint16(offset + 2);
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array, view: DataView): { width: number; height: number } | undefined {
  if (bytes.length < 30) return undefined;
  const format = ascii(bytes, 12, 4);
  if (format === 'VP8 ') {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (format === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === 'VP8X') {
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    };
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
    const chunk = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    if (chunk === 'fmt ' && dataOffset + 12 <= bytes.length) byteRate = view.getUint32(dataOffset + 8, true);
    if (chunk === 'data') dataSize = size;
    if (byteRate && dataSize !== undefined) break;
    offset = dataOffset + size + (size % 2);
  }
  return byteRate && dataSize !== undefined ? Math.round((dataSize / byteRate) * 1_000) : undefined;
}

function mp4DurationMs(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findMvhd = (start: number, end: number): { offset: number; size: number } | undefined => {
    let offset = start;
    while (offset + 8 <= end && offset + 8 <= bytes.length) {
      const size32 = view.getUint32(offset);
      const type = ascii(bytes, offset + 4, 4);
      const headerSize = size32 === 1 ? 16 : 8;
      const size = size32 === 1 && offset + 16 <= bytes.length ? Number(view.getBigUint64(offset + 8)) : size32;
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
    return timescale > 0 ? Math.round(Number(duration) * 1_000 / timescale) : undefined;
  }
  const timescale = view.getUint32(mvhd.offset + 12);
  const duration = view.getUint32(mvhd.offset + 16);
  return timescale > 0 ? Math.round(duration * 1_000 / timescale) : undefined;
}
