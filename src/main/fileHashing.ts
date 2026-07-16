import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

const HASH_CHUNK_BYTES = 1024 * 1024;

/** Synchronous compatibility helper; use only when the caller enforces a size bound. */
export function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Hash in bounded turns so large in-memory inputs do not stall Electron main. */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const hash = createHash('sha256');
  for (let offset = 0; offset < bytes.byteLength; offset += HASH_CHUNK_BYTES) {
    const end = Math.min(offset + HASH_CHUNK_BYTES, bytes.byteLength);
    hash.update(bytes.subarray(offset, end));
    if (end < bytes.byteLength) await yieldToEventLoop();
  }
  return hash.digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  let bytesSinceYield = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytesSinceYield += chunk.byteLength;
    if (bytesSinceYield >= HASH_CHUNK_BYTES) {
      bytesSinceYield = 0;
      await yieldToEventLoop();
    }
  }
  return hash.digest('hex');
}
