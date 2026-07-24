import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  ThreadId,
  ThreadItemOutputReference,
} from '../../../core/agent/protocol';

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const TEXT_MIME_EXTENSIONS = {
  'text/plain': '.txt',
  'application/json': '.json',
} as const satisfies Readonly<Record<ThreadItemOutputReference['mimeType'], string>>;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_PAYLOAD_FILENAME_PATTERN = /^[a-f0-9]{64}\.(?:gif|jpg|png|webp|bin)$/;

export const MAX_TOOL_PAYLOAD_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOOL_PAYLOAD_IMAGE_BASE64_CHARS = Math.ceil(MAX_TOOL_PAYLOAD_IMAGE_BYTES / 3) * 4;

export type ToolPayloadImageMeasurement =
  | { readonly ok: true; readonly byteLength: number }
  | { readonly ok: false; readonly reason: 'invalidBase64' | 'imageByteLimit' };

export class ToolPayloadStore {
  constructor(private readonly rootPath: string) {}

  async writeText(
    threadId: ThreadId,
    _itemId: string,
    text: string,
    mimeType: ThreadItemOutputReference['mimeType'],
    summary: string,
  ): Promise<ThreadItemOutputReference> {
    const bytes = Buffer.from(text, 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const directory = join(this.rootPath, threadId);
    const path = join(directory, `${digest}${TEXT_MIME_EXTENSIONS[mimeType]}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' }).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
    return {
      id: digest,
      mimeType,
      byteLength: bytes.byteLength,
      summary,
    };
  }

  async readText(threadId: ThreadId, outputId: string): Promise<string | null> {
    if (!SHA_256_PATTERN.test(outputId)) throw new Error('Invalid tool output digest');
    for (const extension of Object.values(TEXT_MIME_EXTENSIONS)) {
      const path = join(this.rootPath, threadId, `${outputId}${extension}`);
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    return null;
  }

  async copyTextToThread(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    outputId: string,
  ): Promise<boolean> {
    if (!SHA_256_PATTERN.test(outputId)) throw new Error('Invalid tool output digest');
    const targetDirectory = join(this.rootPath, targetThreadId);
    await mkdir(targetDirectory, { recursive: true });
    for (const extension of Object.values(TEXT_MIME_EXTENSIONS)) {
      const filename = `${outputId}${extension}`;
      try {
        await copyFile(
          join(this.rootPath, sourceThreadId, filename),
          join(targetDirectory, filename),
          constants.COPYFILE_EXCL,
        );
        return true;
      } catch (error) {
        if (isAlreadyExists(error)) return true;
        if (!isNotFound(error)) throw error;
      }
    }
    return false;
  }

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

  async copyImageToThread(
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    imageRef: string,
  ): Promise<string> {
    const sourceDirectory = resolve(this.rootPath, sourceThreadId);
    const sourcePath = resolve(imageRef);
    if (dirname(sourcePath) !== sourceDirectory) return imageRef;
    const filename = basename(sourcePath);
    if (!IMAGE_PAYLOAD_FILENAME_PATTERN.test(filename)) {
      throw new Error('Invalid tool image payload reference');
    }
    const targetDirectory = resolve(this.rootPath, targetThreadId);
    const targetPath = join(targetDirectory, filename);
    await mkdir(targetDirectory, { recursive: true });
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL).catch((error: unknown) => {
      if (!isAlreadyExists(error)) throw error;
    });
    return targetPath;
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

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
