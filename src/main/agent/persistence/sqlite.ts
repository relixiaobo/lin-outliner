import { createRequire } from 'node:module';

export type SqliteValue = string | number | bigint | Uint8Array | null;

export interface SqliteRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: readonly SqliteValue[]): SqliteRunResult;
  get(...params: readonly SqliteValue[]): unknown;
  all(...params: readonly SqliteValue[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  readonly DatabaseSync: new (path: string) => SqliteDatabase;
}

export function openSqlite(path: string): SqliteDatabase {
  const nodeSqlite = createRequire(import.meta.url)('node:sqlite') as NodeSqliteModule;
  const database = new nodeSqlite.DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  } catch (error) {
    closeSqliteAfterFailure(database, error);
  }
  return database;
}

/** Preserve the opening failure while recording any failure to release its handle. */
export function closeSqliteAfterFailure(database: SqliteDatabase, failure: unknown): never {
  try {
    database.close();
  } catch (cleanupError) {
    throw new AggregateError([failure, cleanupError], 'Database initialization and cleanup failed.', { cause: failure });
  }
  throw failure;
}
