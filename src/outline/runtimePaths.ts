import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface OutlineRuntimePaths {
  readonly root: string;
  readonly descriptorPath: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly retirementPath: string;
  readonly workspacePath: string;
}

export function resolveOutlineRuntimePaths(root: string): OutlineRuntimePaths {
  const resolved = path.resolve(root);
  const directSocketPath = path.join(resolved, 'runtime.sock');
  const runtimeTempRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const socketPath = Buffer.byteLength(directSocketPath) <= 90
    ? directSocketPath
    : path.join(
        runtimeTempRoot,
        `tenon-outline-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`,
        `${createHash('sha256').update(resolved).digest('hex').slice(0, 32)}.sock`,
      );
  return {
    root: resolved,
    descriptorPath: path.join(resolved, 'runtime.json'),
    socketPath,
    lockPath: path.join(resolved, 'writer.lock'),
    retirementPath: path.join(resolved, 'retirement.lock'),
    workspacePath: path.join(resolved, 'workspace'),
  };
}
