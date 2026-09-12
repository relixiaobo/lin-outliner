import { createRequire } from 'node:module';
import type { SqliteDatabase } from '../agent/persistence/sqlite';
import type { DataLifecycleCheckpoint } from './durableFiles';

export type LifecycleDatabaseFactory = (path: string, readOnly: boolean) => SqliteDatabase;

/** Inspection never changes journal mode, checkpoints, or creates a missing database. */
export const openLifecycleDatabase: LifecycleDatabaseFactory = (path, readOnly) => {
  const require = createRequire(import.meta.url);
  let database: SqliteDatabase;
  if (process.versions.bun) {
    const { Database } = require('bun:sqlite') as {
      Database: new (path: string, options: { readonly: boolean; create: boolean }) => SqliteDatabase;
    };
    database = new Database(path, { readonly: readOnly, create: !readOnly });
  } else {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
    };
    database = new DatabaseSync(path, { readOnly });
  }
  try {
    database.exec('PRAGMA busy_timeout = 1000');
    if (readOnly) database.exec('PRAGMA query_only = ON');
    else database.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL');
    return database;
  } catch (error) { database.close(); throw error; }
};

export function databaseVersion(database: SqliteDatabase): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number };
  if (!Number.isSafeInteger(row.user_version) || row.user_version < 0) throw new Error('Invalid database version');
  return row.user_version;
}

export function verifyDatabase(database: SqliteDatabase, full = false): void {
  const pragma = full ? 'integrity_check' : 'quick_check';
  const rows = database.prepare(`PRAGMA ${pragma}`).all() as Record<string, string>[];
  if (rows.length !== 1 || rows[0]?.[pragma] !== 'ok') throw new Error('Database integrity verification failed');
  if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database has invalid foreign-key relationships');
}

export interface DatabaseMigration {
  readonly from: number;
  readonly to: number;
  readonly apply: (database: SqliteDatabase) => void;
  readonly validate: (database: SqliteDatabase) => void;
}

/** All application changes and the version advance share this physical transaction. */
export async function migrateDatabase(
  database: SqliteDatabase, migration: DatabaseMigration, checkpoint?: DataLifecycleCheckpoint,
): Promise<void> {
  const current = databaseVersion(database);
  if (current === migration.to) { migration.validate(database); return; }
  if (current !== migration.from || !Number.isSafeInteger(migration.to) || migration.to <= migration.from) {
    throw new Error('Unsupported database migration source');
  }
  await checkpoint?.('before-database-transaction');
  database.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    migration.apply(database);
    migration.validate(database);
    database.exec(`PRAGMA user_version = ${migration.to}`);
    await checkpoint?.('before-database-commit');
    database.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) database.exec('ROLLBACK');
  }
  await checkpoint?.('database-committed');
}

export function tableDefinitions(database: SqliteDatabase): ReadonlyMap<string, string> {
  const rows = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];
  return new Map(rows.map((row) => [row.name, row.sql.replace(/\bIF\s+NOT\s+EXISTS\s+/gi, '').replace(/\s+/g, ' ').trim()]));
}
