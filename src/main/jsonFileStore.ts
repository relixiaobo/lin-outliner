import { randomUUID } from 'node:crypto';
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

const fileWriteChains = new Map<string, Promise<unknown>>();

export function withFileWriteLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const prior = fileWriteChains.get(key) ?? Promise.resolve();
  const run = prior.then(task, task);
  fileWriteChains.set(key, run.then(() => undefined, () => undefined));
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
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true });
  if (options.directoryMode !== undefined && process.platform !== 'win32') {
    await chmod(parent, options.directoryMode);
  }
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
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

export async function updateJsonFile<T>(
  filePath: string,
  fallback: T,
  parse: JsonParse<T>,
  mutator: (value: T) => T | void | Promise<T | void>,
  options: JsonFileStoreOptions = {},
): Promise<T> {
  return withFileWriteLock(filePath, async () => {
    const current = await readJsonOrDefault(filePath, fallback, parse);
    const next = (await mutator(current)) ?? current;
    await atomicWriteFileUnlocked(filePath, serializeJsonWithOptions(next, options), options);
    return next;
  });
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
