import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface AtomicWriteFileOptions {
  mode?: number;
  directoryMode?: number;
}

export interface JsonFileStoreOptions {
  mode?: number;
  directoryMode?: number;
  pretty?: boolean;
  trailingNewline?: boolean;
}

type JsonParse<T> = (value: unknown) => T;

export const PRIVATE_JSON_FILE_OPTIONS: JsonFileStoreOptions =
  process.platform === 'win32' ? {} : { mode: 0o600, directoryMode: 0o700 };

const fileWriteChains = new Map<string, Promise<unknown>>();
const activeFileWriteLocks = new AsyncLocalStorage<Set<string>>();

export function getJsonFileWriteLockCountForTests(): number {
  return fileWriteChains.size;
}

export function withFileWriteLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  if (activeFileWriteLocks.getStore()?.has(key)) {
    throw new Error(`Nested JSON file write lock for ${key}`);
  }
  const prior = fileWriteChains.get(key) ?? Promise.resolve();
  const run = prior.then(
    () => runWithFileWriteLock(key, task),
    () => runWithFileWriteLock(key, task),
  );
  const tail = run.then(() => undefined, () => undefined);
  fileWriteChains.set(key, tail);
  void tail.then(() => {
    if (fileWriteChains.get(key) === tail) fileWriteChains.delete(key);
  });
  return run;
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer | Uint8Array,
  options: AtomicWriteFileOptions = {},
): Promise<void> {
  return withFileWriteLock(filePath, () => atomicWriteFileUnlocked(filePath, data, options));
}

async function atomicWriteFileUnlocked(
  filePath: string,
  data: string | Buffer | Uint8Array,
  options: AtomicWriteFileOptions,
): Promise<void> {
  await prepareParentDirectory(filePath, options);
  const tmpPath = temporaryFilePath(filePath);
  try {
    await writeFile(tmpPath, data, options.mode === undefined ? undefined : { mode: options.mode });
    await rename(tmpPath, filePath);
    if (options.mode !== undefined && process.platform !== 'win32') {
      await chmod(filePath, options.mode);
    }
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function atomicWriteFileSync(
  filePath: string,
  data: string | Buffer | Uint8Array,
  options: AtomicWriteFileOptions = {},
): void {
  prepareParentDirectorySync(filePath, options);
  const tmpPath = temporaryFilePath(filePath);
  try {
    writeFileSync(tmpPath, data, options.mode === undefined ? undefined : { mode: options.mode });
    renameSync(tmpPath, filePath);
    if (options.mode !== undefined && process.platform !== 'win32') {
      chmodSync(filePath, options.mode);
    }
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

export async function readJsonOrDefault<T>(
  filePath: string,
  fallback: T,
  parse: JsonParse<T> = (value) => value as T,
): Promise<T> {
  try {
    return parse(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if (isNotFoundError(error)) return parse(fallback);
    throw error;
  }
}

function serializeJsonWithOptions(value: unknown, options: JsonFileStoreOptions): string {
  const json = options.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  return options.trailingNewline === false ? json : `${json}\n`;
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
  options: JsonFileStoreOptions = {},
): Promise<void> {
  return atomicWriteFile(filePath, serializeJsonWithOptions(value, options), options);
}

export function writeJsonFileSync(
  filePath: string,
  value: unknown,
  options: JsonFileStoreOptions = {},
): void {
  atomicWriteFileSync(filePath, serializeJsonWithOptions(value, options), options);
}

export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  parse: JsonParse<T>,
  mutator: (value: T) => T | void | Promise<T | void>,
  options: JsonFileStoreOptions = {},
): Promise<T> {
  return withFileWriteLock(filePath, async () => {
    const current = await readJsonOrDefault(filePath, fallback, parse);
    // The mutator runs while this file's write lock is held; it must not call
    // a jsonFileStore write helper for the same file path.
    const next = (await mutator(current)) ?? current;
    await atomicWriteFileUnlocked(filePath, serializeJsonWithOptions(next, options), options);
    return next;
  });
}

function runWithFileWriteLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const parentLocks = activeFileWriteLocks.getStore();
  const locks = new Set(parentLocks);
  locks.add(key);
  return activeFileWriteLocks.run(locks, task);
}

async function prepareParentDirectory(filePath: string, options: AtomicWriteFileOptions): Promise<void> {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true });
  if (options.directoryMode !== undefined && process.platform !== 'win32') {
    await chmod(parent, options.directoryMode);
  }
}

function prepareParentDirectorySync(filePath: string, options: AtomicWriteFileOptions): void {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  if (options.directoryMode !== undefined && process.platform !== 'win32') {
    chmodSync(parent, options.directoryMode);
  }
}

function temporaryFilePath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
