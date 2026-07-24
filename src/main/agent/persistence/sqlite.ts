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
  return new nodeSqlite.DatabaseSync(path);
}
