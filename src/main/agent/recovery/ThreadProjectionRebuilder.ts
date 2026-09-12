import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { RolloutStore } from '../persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../persistence/ThreadHistoryProjectionStore';
import { verifyRecoveryHistory } from './ThreadRecoveryHistory';
import { DataStoreRegistry } from '../../dataLifecycle/storeRegistry';
import { assertOwnedPath, type DataLifecycleCheckpoint } from '../../dataLifecycle/durableFiles';
import { verifyDatabase } from '../../dataLifecycle/sqlite';

/** Only complete, settled canonical logs authorize replacing the projection. */
export class ThreadProjectionRebuilder {
  constructor(private readonly userData: string, private readonly registry: DataStoreRegistry) {}

  async preview(): Promise<{ readonly threads: number; readonly sourceDigest: string }> {
    return this.readSources();
  }

  async rebuild(target: string, checkpoint?: DataLifecycleCheckpoint): Promise<{ threads: number; sourceDigest: string }> {
    const database = this.registry.openDatabase(target, false);
    const history = new ThreadHistoryProjectionStore(target, database);
    try {
      const source = await this.readSources(history, checkpoint);
      verifyDatabase(database, true);
      database.exec('PRAGMA user_version = 1; PRAGMA wal_checkpoint(TRUNCATE)');
      return source;
    } finally { history.close(); }
  }

  private async readSources(history?: ThreadHistoryProjectionStore, checkpoint?: DataLifecycleCheckpoint): Promise<{ threads: number; sourceDigest: string }> {
    const inspections = await this.registry.inspect(this.userData, true);
    const blocked = inspections.find((entry) => entry.store.id !== 'agent-history' && entry.issue);
    if (blocked) throw new Error(`Repair requires compatible ${blocked.store.id} data.`);
    const metadata = this.registry.openDatabase(await assertOwnedPath(this.userData, 'agent/state.sqlite'), true);
    let ids: string[];
    try { ids = (metadata.prepare('SELECT id FROM threads ORDER BY id').all() as { id: string }[]).map((row) => row.id); }
    finally { metadata.close(); }
    const original = this.registry.openDatabase(await assertOwnedPath(this.userData, 'agent/thread_history.sqlite'), true);
    let coverage: Map<string, { ordinal: number; byte_offset: number }>;
    try {
      const rows = original.prepare('SELECT thread_id, ordinal, byte_offset FROM rollout_watermarks').all() as { thread_id: string; ordinal: number; byte_offset: number }[];
      coverage = new Map(rows.map((row) => [row.thread_id, row]));
    } finally { original.close(); }
    const rollouts = new RolloutStore(join(this.userData, 'agent/rollouts'));
    const digest = createHash('sha256');
    for (const id of ids) {
      const entries = await rollouts.readForRecovery(id);
      const first = entries[0]?.event;
      if (!first || first.type !== 'thread/started' && first.type !== 'history/recovered') throw new Error('A conversation has no complete canonical event source. Its original projection must be retained.');
      const watermark = coverage.get(id);
      const boundary = watermark ? entries[watermark.ordinal] : undefined;
      if (!watermark || !boundary || boundary.byteOffset + boundary.byteLength !== watermark.byte_offset) {
        throw new Error('Canonical events do not prove the retained projection coverage. Use a verified backup or scoped conversation recovery.');
      }
      verifyRecoveryHistory(id, entries, this.registry.openDatabase(':memory:', false));
      digest.update(JSON.stringify({ id, entries }));
      history?.rebuildThread(id, entries);
      await checkpoint?.('history-source-verified');
    }
    return { threads: ids.length, sourceDigest: digest.digest('hex') };
  }
}
