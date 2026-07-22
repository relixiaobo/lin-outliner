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

export class ToolPayloadStore {
  constructor(private readonly rootPath: string) {}

  async writeImage(
    threadId: ThreadId,
    itemId: string,
    index: number,
    dataBase64: string,
    mimeType: string,
  ): Promise<string> {
    const bytes = Buffer.from(dataBase64, 'base64');
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

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'EEXIST';
}
