import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DataLifecycleDomain, DataLifecycleIssue } from '../../core/dataLifecycle';
import { contentStoreSchema } from '../../content/ContentStore.schema';
import { automationStoreSchema } from '../agent/automations/AutomationStore.schema';
import { delegationSessionStoreSchema } from '../agent/delegation/DelegationSessionStore.schema';
import { goalStoreSchema } from '../agent/extensions/goal/GoalStore.schema';
import { memoryControlStoreSchema } from '../agent/extensions/memory/MemoryControlStore.schema';
import { agentResourceStoreSchema } from '../agent/persistence/AgentResourceStore.schema';
import { projectCatalogStoreSchema } from '../agent/persistence/ProjectCatalogStore.schema';
import { threadHistoryProjectionStoreSchema } from '../agent/persistence/ThreadHistoryProjectionStore.schema';
import { threadMetadataStoreSchema } from '../agent/persistence/ThreadMetadataStore.schema';
import { profileFileStoreSchema } from '../agent/profile/ProfileFileStore.schema';
import { toolTaskStoreSchema } from '../agent/tasks/ToolTaskStore.schema';
import { assertOwnedPath, missing, ownedPath, type DataLifecycleCheckpoint } from './durableFiles';
import { databaseVersion, migrateDatabase, openLifecycleDatabase, tableDefinitions, verifyDatabase, type LifecycleDatabaseFactory } from './sqlite';

export interface PhysicalSqliteStore {
  readonly id: string;
  readonly path: string;
  readonly domain: DataLifecycleDomain;
  readonly version: number;
  readonly schema: string;
  readonly seed?: string;
}

/** One entry per physical database, even when several domain classes share it. */
export const PHYSICAL_SQLITE_STORES: readonly PhysicalSqliteStore[] = [
  { id: 'content', path: 'content/state.sqlite', domain: 'outline', version: 2, schema: contentStoreSchema,
    seed: "INSERT OR IGNORE INTO content_meta(key, value) VALUES ('schema_version', '2')" },
  { id: 'agent-state', path: 'agent/state.sqlite', domain: 'agent', version: 1,
    schema: threadMetadataStoreSchema + projectCatalogStoreSchema },
  { id: 'agent-history', path: 'agent/thread_history.sqlite', domain: 'agent', version: 1, schema: threadHistoryProjectionStoreSchema },
  { id: 'agent-goals', path: 'agent/goals.sqlite', domain: 'agent', version: 1, schema: goalStoreSchema + toolTaskStoreSchema },
  { id: 'agent-memory', path: 'agent/memories.sqlite', domain: 'agent', version: 1, schema: memoryControlStoreSchema },
  { id: 'agent-profile', path: 'agent/profile-control.sqlite', domain: 'agent', version: 1, schema: profileFileStoreSchema },
  { id: 'agent-delegation', path: 'agent/delegation.sqlite', domain: 'agent', version: 1, schema: delegationSessionStoreSchema },
  { id: 'agent-schedules', path: 'agent/scheduled-tasks.sqlite', domain: 'agent', version: 1, schema: automationStoreSchema },
  { id: 'agent-resources', path: 'agent/resource_references.sqlite', domain: 'agent', version: 1, schema: agentResourceStoreSchema },
];

export interface StoreInspection {
  readonly store: PhysicalSqliteStore;
  readonly exists: boolean;
  readonly observedVersion: number;
  readonly issue: DataLifecycleIssue | null;
}

export class DataStoreRegistry {
  private readonly expected = new Map<string, ReadonlyMap<string, string>>();
  constructor(
    readonly stores: readonly PhysicalSqliteStore[] = PHYSICAL_SQLITE_STORES,
    readonly openDatabase: LifecycleDatabaseFactory = openLifecycleDatabase,
  ) {
    if (new Set(stores.map((store) => store.path)).size !== stores.length
      || new Set(stores.map((store) => store.id)).size !== stores.length) throw new Error('Duplicate physical Store registration');
  }

  async inspect(root: string, full = false): Promise<readonly StoreInspection[]> {
    const result: StoreInspection[] = [];
    for (const store of this.stores) {
      let exists = false;
      let observedVersion = 0;
      try {
        const path = await assertOwnedPath(root, store.path);
        const info = await lstat(path).catch((error: unknown) => { if (missing(error)) return null; throw error; });
        if (!info) { result.push({ store, exists, observedVersion, issue: null }); continue; }
        exists = true;
        if (!info.isFile()) throw new Error('Database path is not a regular file');
        const database = this.openDatabase(path, true);
        try {
          observedVersion = databaseVersion(database);
          if (observedVersion > store.version) {
            result.push({ store, exists, observedVersion, issue: { storeId: store.id, domain: store.domain,
              reason: 'future-version', message: 'This data requires a newer application version.',
              foundVersion: observedVersion, expectedVersion: store.version } });
            continue;
          }
          if (observedVersion !== 0 && observedVersion !== store.version) throw new Error('No supported migration exists for this database version');
          this.validateSchema(store, database);
          verifyDatabase(database, full);
        } finally { database.close(); }
        result.push({ store, exists, observedVersion, issue: null });
      } catch (error) {
        result.push({ store, exists, observedVersion, issue: { storeId: store.id, domain: store.domain,
          reason: 'invalid-data', message: error instanceof Error ? error.message : 'Storage inspection failed' } });
      }
    }
    return result;
  }

  validateSchema(store: PhysicalSqliteStore, database: ReturnType<LifecycleDatabaseFactory>): void {
    let expected = this.expected.get(store.id);
    if (!expected) {
      const empty = this.openDatabase(':memory:', false);
      try { empty.exec(store.schema); expected = tableDefinitions(empty); }
      finally { empty.close(); }
      this.expected.set(store.id, expected);
    }
    const actual = tableDefinitions(database);
    if (actual.size !== expected.size || [...expected].some(([name, sql]) => actual.get(name) !== sql)) {
      throw new Error('Database schema does not match a registered baseline');
    }
    if (store.id === 'content') {
      const marker = database.prepare("SELECT value FROM content_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (marker?.value !== '2') throw new Error('Unsupported ContentStore schema version');
    }
  }

  /** The coordinator calls this only after inspection and retained-original verification. */
  async establishVersions(root: string, inspections: readonly StoreInspection[], checkpoint?: DataLifecycleCheckpoint): Promise<void> {
    for (const inspection of inspections) {
      if (inspection.issue) continue;
      const { store } = inspection;
      const path = await assertOwnedPath(root, store.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const database = this.openDatabase(path, false);
      try {
        await migrateDatabase(database, { from: 0, to: store.version,
          apply: (db) => { if (!inspection.exists) { db.exec(store.schema); if (store.seed) db.exec(store.seed); } },
          validate: (db) => this.validateSchema(store, db),
        }, checkpoint);
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally { database.close(); }
    }
  }

  forPath(path: string): PhysicalSqliteStore | undefined { return this.stores.find((store) => store.path === path); }
}
