import { nativeImage, type NativeImage } from 'electron';
import { open } from 'node:fs/promises';
import { MAX_IMAGE_ATTACHMENT_SOURCE_BYTES, MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGE_DIMENSION } from '../../core/agentAttachmentLimits';
import { ImageObservationNormalizationError } from './imageArtifacts';
import { Mutex } from './Mutex';

export interface PreparedBoundedAgentImage {
  readonly bytes: Buffer;
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly fileName: string;
  readonly sourceDimensions: { readonly width: number; readonly height: number };
  readonly dimensions: { readonly width: number; readonly height: number };
}

// All model-image producers share the decode/encode lane. File access and
// resource authorization remain with their callers; filenames never select pixels.
const observationMutex = new Mutex();

export async function prepareBoundedAgentImage(
  sourcePath: string,
  displayName: string,
  signal?: AbortSignal,
): Promise<PreparedBoundedAgentImage> {
  return observationMutex.run(async () => {
    signal?.throwIfAborted();
    const handle = await open(sourcePath, 'r');
    try {
      const sourceStat = await handle.stat();
      if (!sourceStat.isFile()) {
        throw new ImageObservationNormalizationError(`Image is not a readable regular file: ${displayName}`);
      }
      validateSourceSize(sourceStat.size, displayName);
      // Bound the read as well as the decode, even if a local file grows after stat.
      const bytes = Buffer.alloc(sourceStat.size + 1);
      let length = 0;
      while (length < bytes.byteLength) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, length, bytes.byteLength - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== sourceStat.size) {
        throw new ImageObservationNormalizationError(`Image changed while being read: ${displayName}`);
      }
      return normalizePixels(bytes.subarray(0, length), displayName, signal);
    } finally {
      await handle.close();
    }
  });
}

export async function prepareBoundedAgentImageBytes(
  sourceBytes: Buffer,
  displayName: string,
  signal?: AbortSignal,
): Promise<PreparedBoundedAgentImage> {
  return observationMutex.run(async () => normalizePixels(sourceBytes, displayName, signal));
}

function validateSourceSize(size: number, displayName: string): void {
  if (size === 0) throw new ImageObservationNormalizationError(`Image is empty: ${displayName}`);
  if (size > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES) {
    throw new ImageObservationNormalizationError(
      `Image exceeds the ${formatFileSize(MAX_IMAGE_ATTACHMENT_SOURCE_BYTES)} image decode budget: ${displayName}`,
    );
  }
}

function normalizePixels(sourceBytes: Buffer, displayName: string, signal?: AbortSignal): PreparedBoundedAgentImage {
  signal?.throwIfAborted();
  validateSourceSize(sourceBytes.byteLength, displayName);
  let image = nativeImage.createFromBuffer(sourceBytes);
  if (image.isEmpty()) {
    throw new ImageObservationNormalizationError(`Image could not be decoded: ${displayName}`);
  }
  const decodedDimensions = image.getSize();
  const orientation = jpegOrientation(sourceBytes);
  const sourceDimensions = orientation >= 5
    ? { width: decodedDimensions.height, height: decodedDimensions.width } : decodedDimensions;
  const scale = Math.min(1, MAX_PROMPT_IMAGE_DIMENSION / decodedDimensions.width,
    MAX_PROMPT_IMAGE_DIMENSION / decodedDimensions.height);
  if (scale < 1) {
    image = image.resize({ width: Math.max(1, Math.floor(decodedDimensions.width * scale)),
      height: Math.max(1, Math.floor(decodedDimensions.height * scale)), quality: 'best' });
  }
  signal?.throwIfAborted();
  // Canonical encoding makes pixels and geometry agree even for oriented JPEGs.
  // Never use an OS thumbnail or pass through bytes under an unverified MIME label.
  return encodeBoundedAgentImage(orientPixels(image, orientation), sourceDimensions, displayName);
}

function encodeBoundedAgentImage(
  initialImage: NativeImage,
  sourceDimensions: { readonly width: number; readonly height: number },
  displayName: string,
): PreparedBoundedAgentImage {
  let image = initialImage;
  const png = image.toPNG();
  if (png.byteLength <= MAX_PROMPT_IMAGE_BYTES) {
    return {
      bytes: png,
      mimeType: 'image/png',
      fileName: 'prompt.png',
      sourceDimensions,
      dimensions: image.getSize(),
    };
  }

  for (;;) {
    for (const quality of [80, 70, 55, 40]) {
      const jpeg = image.toJPEG(quality);
      if (jpeg.byteLength <= MAX_PROMPT_IMAGE_BYTES) {
        return {
          bytes: jpeg,
          mimeType: 'image/jpeg',
          fileName: 'prompt.jpg',
          sourceDimensions,
          dimensions: image.getSize(),
        };
      }
    }
    const size = image.getSize();
    const width = Math.max(1, Math.floor(size.width * 0.75));
    const height = Math.max(1, Math.floor(size.height * 0.75));
    if (width === size.width && height === size.height) break;
    image = image.resize({ width, height, quality: 'best' });
  }
  throw new ImageObservationNormalizationError(
    `Image could not fit the model-input image budget: ${displayName}`,
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}


// Electron's bitmap decoder ignores JPEG EXIF orientation. Read only IFD0's
// bounded SHORT tag, then orient the already resized pixels (at most 2,000 px).
// Unusable optional metadata does not make otherwise decodable pixels unavailable.
function jpegOrientation(bytes: Buffer): number {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xff) { offset++; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    const payload = bytes.subarray(offset + 4, offset + 2 + length);
    if (marker === 0xe1 && payload.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) {
      const tiff = payload.subarray(6);
      if (tiff.length < 8) return 1;
      const little = tiff.toString('ascii', 0, 2) === 'II';
      if (!little && tiff.toString('ascii', 0, 2) !== 'MM') return 1;
      const u16 = (at: number) => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
      const u32 = (at: number) => little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
      if (u16(2) !== 42) return 1;
      const ifd = u32(4);
      if (ifd < 8 || ifd + 2 > tiff.length) return 1;
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const at = ifd + 2 + i * 12;
        if (at + 12 > tiff.length) return 1;
        if (u16(at) !== 0x112) continue;
        if (u16(at + 2) !== 3 || u32(at + 4) !== 1) return 1;
        const orientation = u16(at + 8);
        return orientation >= 1 && orientation <= 8 ? orientation : 1;
      }
    }
    offset += length + 2;
  }
  return 1;
}

function orientPixels(image: NativeImage, orientation: number): NativeImage {
  if (orientation === 1) return image;
  const { width, height } = image.getSize();
  const outputWidth = orientation >= 5 ? height : width;
  const outputHeight = orientation >= 5 ? width : height;
  const source = image.toBitmap();
  const output = Buffer.alloc(source.byteLength);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let dx = x, dy = y;
    switch (orientation) {
      case 2: dx = width - 1 - x; break;
      case 3: dx = width - 1 - x; dy = height - 1 - y; break;
      case 4: dy = height - 1 - y; break;
      case 5: dx = y; dy = x; break;
      case 6: dx = height - 1 - y; dy = x; break;
      case 7: dx = height - 1 - y; dy = width - 1 - x; break;
      case 8: dx = y; dy = width - 1 - x; break;
    }
    const target = (dy * outputWidth + dx) * 4;
    source.copy(output, target, (y * width + x) * 4, (y * width + x + 1) * 4);
  }
  return nativeImage.createFromBitmap(output, { width: outputWidth, height: outputHeight });
}
