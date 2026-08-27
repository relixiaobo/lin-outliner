import { createRequire } from 'node:module';

export interface ContentSqliteRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface ContentSqliteStatement {
  run(...values: readonly unknown[]): ContentSqliteRunResult;
  get<T extends object = Record<string, unknown>>(...values: readonly unknown[]): T | undefined;
  all<T extends object = Record<string, unknown>>(...values: readonly unknown[]): T[];
}

export interface ContentSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): ContentSqliteStatement;
  close(): void;
}

export const CONTENT_SQLITE_BUSY_RETRY_ATTEMPTS = 20;
export const CONTENT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

interface NodeSqliteModule {
  readonly DatabaseSync: new (path: string) => ContentSqliteDatabase;
}

interface BunSqliteModule {
  readonly Database: new (path: string, options?: { create?: boolean }) => ContentSqliteDatabase;
}

export async function openContentDatabase(path: string): Promise<ContentSqliteDatabase> {
  const load = createRequire(import.meta.url);
  let database: ContentSqliteDatabase;
  try {
    const nodeSqlite = load('node:sqlite') as NodeSqliteModule;
    database = new nodeSqlite.DatabaseSync(path);
  } catch (nodeError) {
    try {
      const bunSqlite = load('bun:sqlite') as BunSqliteModule;
      database = new bunSqlite.Database(path, { create: true });
    } catch {
      throw nodeError;
    }
  }
  try {
    // The timeout must be installed before journal_mode because two fresh
    // processes can race while WAL is first established.
    database.exec(`PRAGMA busy_timeout = ${CONTENT_SQLITE_BUSY_TIMEOUT_MS}`);
    await retryContentSqliteBusy(() => database.exec('PRAGMA journal_mode = WAL'));
    database.exec('PRAGMA synchronous = FULL');
    database.exec('PRAGMA foreign_keys = ON');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function retryContentSqliteBusy<T>(action: () => T): Promise<T> {
  for (let attempt = 0; attempt < CONTENT_SQLITE_BUSY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt === CONTENT_SQLITE_BUSY_RETRY_ATTEMPTS - 1) throw error;
      await delay(Math.min(100, 5 * (attempt + 1)));
    }
  }
  throw new Error('ContentStore SQLite busy retry limit was exhausted.');
}

export function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === 'SQLITE_BUSY'
    || value.code === 'SQLITE_LOCKED'
    || (typeof value.message === 'string' && /database is (?:busy|locked)/iu.test(value.message));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
