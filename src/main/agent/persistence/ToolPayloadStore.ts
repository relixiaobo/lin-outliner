import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadId } from '../../../core/agent/protocol';

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export const MAX_TOOL_PAYLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS = Math.ceil(MAX_TOOL_PAYLOAD_IMAGE_BYTES / 3) * 4;

export type ToolPayloadImageMeasurement =
  | { readonly ok: true; readonly byteLength: number }
  | { readonly ok: false; readonly reason: 'invalidBase64' | 'imageByteLimit' };

export class ToolPayloadStore {
  constructor(private readonly rootPath: string) {}

  async writeImage(
    threadId: ThreadId,
    itemId: string,
    index: number,
    dataBase64: string,
    mimeType: string,
  ): Promise<string> {
    const measurement = measureToolPayloadImage(dataBase64);
    if (!measurement.ok) throw new Error(`Tool image payload rejected: ${measurement.reason}`);
    const bytes = Buffer.from(dataBase64, 'base64');
    if (bytes.length !== measurement.byteLength) throw new Error('Tool image payload decoded to an unexpected size');
    const digest = createHash('sha256')
      .update(itemId)
      .update('\0')
      .update(String(index))
      .update('\0')
      .update(bytes)
      .digest('hex');
    const directory = join(this.rootPath, threadId);
    const path = join(directory, `${digest}${MIME_EXTENSIONS[mimeType.toLowerCase()] ?? '.bin'}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' }).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
    return path;
  }

  async deleteThread(threadId: ThreadId): Promise<void> {
    await rm(join(this.rootPath, threadId), { recursive: true, force: true });
  }
}

export function measureToolPayloadImage(dataBase64: string): ToolPayloadImageMeasurement {
  if (dataBase64.length === 0) return { ok: false, reason: 'invalidBase64' };
  if (dataBase64.length > MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS) {
    return { ok: false, reason: 'imageByteLimit' };
  }
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0;
  if (padding > 0 && dataBase64.length % 4 !== 0) return { ok: false, reason: 'invalidBase64' };
  const bodyLength = dataBase64.length - padding;
  if (bodyLength % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    return { ok: false, reason: 'invalidBase64' };
  }
  const byteLength = Math.floor(bodyLength * 3 / 4);
  return byteLength <= MAX_TOOL_PAYLOAD_IMAGE_BYTES
    ? { ok: true, byteLength }
    : { ok: false, reason: 'imageByteLimit' };
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST';
}
