import { chmodSync, closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOutlineStartupFailure } from '../contract/startupFailure';

/** Bun's extra stdio stream finalizer can close a reused descriptor after EOF. */
export function createStartupFileObservation(): { readonly path: string; read(): Error | null; close(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'tenon-runtime-observation-'));
  chmodSync(directory, 0o700);
  const path = join(directory, 'failure.json');
  let closed = false;
  return {
    path,
    read: () => {
      if (closed) return null;
      let descriptor: number;
      try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (isMissing(error)) return null; throw error; }
      try {
        const info = fstatSync(descriptor);
        if (!info.isFile() || info.size > 16_384) return new Error('Runtime startup observation exceeded its limit.');
        const buffer = Buffer.alloc(info.size);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(descriptor, buffer, length, buffer.length - length, length);
          if (!count) break;
          length += count;
        }
        try { return readOutlineStartupFailure(JSON.parse(buffer.subarray(0, length).toString('utf8'))); }
        catch { return null; }
      } finally { closeSync(descriptor); }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* Inspection cleanup cannot revoke a verified Runtime connection. */ }
    },
  };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
