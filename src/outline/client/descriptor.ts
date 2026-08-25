import { lstat, readFile } from 'node:fs/promises';
import { RuntimeDescriptorSchema, type RuntimeDescriptor } from '../contract/schemas';
import { checkOutlineSchema } from '../contract/validation';
import { resolveOutlineRuntimePaths } from '../runtimePaths';

export async function readOutlineRuntimeDescriptor(root: string): Promise<RuntimeDescriptor | null> {
  const paths = resolveOutlineRuntimePaths(root);
  let descriptorStat: Awaited<ReturnType<typeof lstat>>;
  let raw: string;
  try {
    descriptorStat = await lstat(paths.descriptorPath);
    raw = await readFile(paths.descriptorPath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink()) {
    throw new Error(`Outline Runtime descriptor is not a regular file: ${paths.descriptorPath}`);
  }
  if (process.platform !== 'win32' && (descriptorStat.mode & 0o077) !== 0) {
    throw new Error(`Outline Runtime descriptor permissions are not private: ${paths.descriptorPath}`);
  }
  const value = JSON.parse(raw) as unknown;
  if (!checkOutlineSchema(RuntimeDescriptorSchema, value)) {
    throw new Error(`Outline Runtime descriptor is invalid: ${paths.descriptorPath}`);
  }
  if (value.socketPath !== paths.socketPath) {
    throw new Error('Outline Runtime descriptor socket does not belong to the requested Runtime root');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
