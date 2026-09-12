import { createHash, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OUTLINE_STORAGE_VERSION } from './contract/version';
import { CONTENT_SCHEMA_VERSION } from '../content/ContentStore.schema';

/** Standalone Runtime must honor pending maintenance even after the desktop dies. */
export async function inspectRuntimeDataAdmission(runtimeRoot: string, token?: string): Promise<'normal' | 'initialize'> {
  const userData = dirname(runtimeRoot);
  const manifest = await readControl(join(userData, 'data-manifest.json'));
  if (manifest !== null && (!record(manifest) || manifest.manifestVersion !== 1)) {
    throw blocked('This data lifecycle format requires a compatible application.');
  }
  if (record(manifest)) {
    if (!record(manifest.storeVersions)) throw blocked('Invalid stored data compatibility versions.');
    const versions = manifest.storeVersions;
    if (typeof versions['outline-workspace'] === 'number' && versions['outline-workspace'] > OUTLINE_STORAGE_VERSION
      || typeof versions.content === 'number' && versions.content > CONTENT_SCHEMA_VERSION) throw blocked('This workspace requires a newer compatible Runtime.');
  }
  const journal = await readControl(join(userData, 'data-lifecycle/operation.json'));
  if (journal === null) return 'normal';
  if (!record(journal) || !record(journal.operation) || journal.operation.version !== 1
    || journal.digest !== createHash('sha256').update(JSON.stringify(journal.operation)).digest('hex')) {
    throw blocked('The data recovery journal must be inspected before starting the Runtime.');
  }
  const operation = journal.operation;
  if (operation.phase === 'complete') return 'normal';
  const initialization = operation.kind === 'initialize' && operation.phase === 'verifying'
    || operation.kind === 'restore' && operation.phase === 'reconciling';
  if (initialization && token) {
    const permit = await readControl(join(userData, 'data-lifecycle/runtime-permit.json'));
    if (record(permit) && permit.version === 1 && permit.operationId === operation.id
      && typeof permit.token === 'string' && permit.token.length === token.length
      && timingSafeEqual(Buffer.from(permit.token), Buffer.from(token))
      && typeof permit.pid === 'number' && processExists(permit.pid)) return 'initialize';
  }
  throw blocked('Data maintenance is pending. Open Tenon to complete or recover the operation.');
}

async function readControl(path: string): Promise<unknown | null> {
  // The immediate control directory must not redirect a lifecycle lookup.
  const parent = await lstat(dirname(path)).catch((error: unknown) => { if (missing(error)) return null; throw error; });
  if (parent?.isSymbolicLink()) throw blocked('The data lifecycle directory is not owned storage.');
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw blocked('Invalid data lifecycle control record.');
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw blocked('Data lifecycle control changed during inspection.');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally { await file.close(); }
}

function blocked(message: string): Error { return Object.assign(new Error(message), { code: 'STARTUP_RECOVERY_REQUIRED' }); }
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function missing(error: unknown): boolean { return record(error) && error.code === 'ENOENT'; }
function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return record(error) && error.code === 'EPERM'; }
}
