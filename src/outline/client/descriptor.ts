import { lstat, readFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
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

export async function descriptorHasMatchingRuntimeOwner(
  root: string,
  descriptor: RuntimeDescriptor,
): Promise<boolean> {
  const paths = resolveOutlineRuntimePaths(root);
  const ownerPath = path.join(paths.lockPath, 'owner.json');
  try {
    const [rootStat, lockStat, ownerStat, raw] = await Promise.all([
      lstat(paths.root),
      lstat(paths.lockPath),
      lstat(ownerPath),
      readFile(ownerPath, 'utf8'),
    ]);
    if (!privateOwnedDirectory(rootStat)
      || !privateOwnedDirectory(lockStat)
      || !privateOwnedFile(ownerStat)) return false;
    const owner = JSON.parse(raw) as unknown;
    return isRecord(owner)
      && owner.pid === descriptor.pid
      && owner.instanceId === descriptor.instanceId
      && owner.createdAt === descriptor.createdAt;
  } catch {
    return false;
  }
}

function privateOwnedDirectory(value: Stats): boolean {
  return value.isDirectory() && !value.isSymbolicLink() && privateOwnedPath(value);
}

function privateOwnedFile(value: Stats): boolean {
  return value.isFile() && !value.isSymbolicLink() && privateOwnedPath(value);
}

function privateOwnedPath(value: Stats): boolean {
  if (process.platform === 'win32') return true;
  if ((value.mode & 0o077) !== 0) return false;
  return typeof process.getuid !== 'function' || value.uid === process.getuid();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
