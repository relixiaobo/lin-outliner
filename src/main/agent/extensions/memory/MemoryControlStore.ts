import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  MemoryAdmissionSnapshot,
  MemoryFeatureMode,
  MemoryStatus,
  ThreadMemoryMode,
} from '../../../../core/agent/memory';
import type { ThreadId, ThreadItemId, TurnId } from '../../../../core/agent/protocol';
import { redactSecretLikeContent } from '../../capabilities/agentSecretRedaction';
import { openSqlite, type SqliteDatabase, type SqliteValue } from '../../persistence/sqlite';

type MemoryControlStatus = Omit<MemoryStatus, 'strayTaggedNodeCount'>;

interface SettingRow { value: string }
interface ThreadModeRow { mode: string }
interface AdmissionRow {
  thread_id: string;
  turn_id: string;
  feature_mode: string;
  thread_mode: string;
  eligible: number;
  feature_generation: number;
  reset_epoch: number;
  visibility_generation: number;
  admitted_at: number;
}
interface SourceRow {
  thread_id: string;
  source_version: string;
  status: string;
  polluted: number;
  updated_at: number;
}
interface PublicationRow {
  id: string;
  kind: string;
  status: string;
  generation: number;
  feature_generation: number;
  reset_epoch: number;
  digest: string;
  payload_json: string;
  created_at: number;
}
interface RollbackRow {
  rollback_id: string;
  thread_id: string;
  status: string;
  omitted_turn_ids_json: string;
  before_version: number;
  after_version: number;
  suppressed_node_ids_json: string;
  suppress_all_generated: number;
  created_at: number;
}
interface GeneratedNodeRow {
  node_id: string;
  category: string;
  source_date: string;
  fingerprint: string;
  user_authoritative: number;
  generated_at: number;
}
interface JobRow { key: string; kind: string; payload_json: string; attempt: number; available_at: number }

export interface MemorySourceRecord {
  readonly threadId: ThreadId;
  readonly sourceVersion: string;
  readonly status: 'succeeded' | 'succeededNoOutput' | 'failed';
  readonly polluted: boolean;
  readonly updatedAt: number;
}

export interface MemoryPublicationRecord<T = unknown> {
  readonly id: string;
  readonly kind: 'stage1' | 'stage2' | 'reset';
  readonly status: 'prepared' | 'finalized';
  readonly generation: number;
  readonly featureGeneration: number;
  readonly resetEpoch: number;
  readonly digest: string;
  readonly payload: T;
  readonly createdAt: number;
}

export interface MemoryGeneratedNodeRecord {
  readonly nodeId: string;
  readonly category: string;
  readonly sourceDate: string;
  readonly fingerprint: string;
  readonly userAuthoritative: boolean;
  readonly generatedAt: number;
}

export interface MemoryLineageInput {
  readonly nodeId: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly originItemId: ThreadItemId;
}

export interface MemoryRollbackRecord {
  readonly rollbackId: string;
  readonly threadId: ThreadId;
  readonly status: 'prepared' | 'committed' | 'reconciled' | 'aborted';
  readonly omittedTurnIds: readonly TurnId[];
  readonly beforeVersion: number;
  readonly afterVersion: number;
  readonly suppressedNodeIds: readonly string[];
  readonly suppressAllGenerated: boolean;
  readonly createdAt: number;
}

export interface MemoryDirtyJob<T = unknown> {
  readonly key: string;
  readonly kind: string;
  readonly payload: T;
  readonly attempt: number;
}

export interface MemoryStage1Finalization {
  readonly publicationId: string;
  readonly threadId: ThreadId;
  readonly sourceVersion: string;
  readonly nodes: readonly MemoryGeneratedNodeRecord[];
  readonly lineage: readonly MemoryLineageInput[];
}

export interface MemoryStage2Finalization {
  readonly publicationId: string;
  readonly upsertedNodes: readonly MemoryGeneratedNodeRecord[];
  readonly lineage: readonly MemoryLineageInput[];
  readonly deletedNodeIds: readonly string[];
  readonly releasedNodeIds: readonly string[];
  readonly reconciledRollbackIds: readonly string[];
  readonly needsFollowUp: boolean;
}

export class MemoryControlStore {
  private generatedNodesCache: readonly MemoryGeneratedNodeRecord[] | null = null;
  private generatedNodeIdsCache: ReadonlySet<string> | null = null;
  private generatedNodesByIdCache: ReadonlyMap<string, MemoryGeneratedNodeRecord> | null = null;
  private readonly db: SqliteDatabase;

  constructor(path: string, database?: SqliteDatabase) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? openSqlite(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS thread_modes (
        thread_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('enabled', 'disabled')),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turn_admissions (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        feature_mode TEXT NOT NULL CHECK (feature_mode IN ('enabled', 'disabled')),
        thread_mode TEXT NOT NULL CHECK (thread_mode IN ('enabled', 'disabled')),
        eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
        feature_generation INTEGER NOT NULL,
        reset_epoch INTEGER NOT NULL,
        visibility_generation INTEGER NOT NULL,
        admitted_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_admissions_thread_idx ON turn_admissions(thread_id, admitted_at);
      CREATE TABLE IF NOT EXISTS turn_exclusions (
        turn_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('globalDisable', 'reset')),
        epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(turn_id, reason)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_records (
        thread_id TEXT PRIMARY KEY,
        source_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'succeededNoOutput', 'failed')),
        polluted INTEGER NOT NULL DEFAULT 0 CHECK (polluted IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS origin_claims (
        origin_item_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        source_date TEXT NOT NULL,
        content_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS generated_nodes (
        node_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        source_date TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        user_authoritative INTEGER NOT NULL DEFAULT 0 CHECK (user_authoritative IN (0, 1)),
        generated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS node_lineage (
        node_id TEXT NOT NULL REFERENCES generated_nodes(node_id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        origin_item_id TEXT NOT NULL,
        PRIMARY KEY(node_id, origin_item_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS citation_usage (
        citation_item_id TEXT NOT NULL,
        citation_turn_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        origin_item_id TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        PRIMARY KEY(citation_item_id, node_id, origin_item_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('stage1', 'stage2', 'reset')),
        status TEXT NOT NULL CHECK (status IN ('prepared', 'finalized')),
        generation INTEGER NOT NULL,
        feature_generation INTEGER NOT NULL,
        reset_epoch INTEGER NOT NULL,
        digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rollback_invalidations (
        rollback_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'reconciled', 'aborted')),
        omitted_turn_ids_json TEXT NOT NULL,
        before_version INTEGER NOT NULL,
        after_version INTEGER NOT NULL,
        suppressed_node_ids_json TEXT NOT NULL,
        suppress_all_generated INTEGER NOT NULL CHECK (suppress_all_generated IN (0, 1)),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS dirty_jobs (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    this.initializeSetting('featureMode', 'enabled');
    this.initializeSetting('featureModeGeneration', '0');
    this.initializeSetting('resetEpoch', '0');
    this.initializeSetting('memoryVisibilityGeneration', '0');
    this.initializeSetting('publicationGeneration', '0');
    this.initializeSetting('lastSuccessfulRunAt', '');
    this.initializeSetting('lastError', '');
  }

  close(): void {
    this.db.close();
  }

  status(): MemoryControlStatus {
    return {
      featureMode: this.featureMode(),
      featureModeGeneration: this.numberSetting('featureModeGeneration'),
      resetEpoch: this.numberSetting('resetEpoch'),
      memoryVisibilityGeneration: this.numberSetting('memoryVisibilityGeneration'),
      lastSuccessfulRunAt: nullableNumberSetting(this.setting('lastSuccessfulRunAt')),
      lastError: this.setting('lastError') || null,
      pendingJobs: Number((this.db.prepare('SELECT COUNT(*) AS count FROM dirty_jobs').get() as { count: number }).count),
    };
  }

  featureMode(): MemoryFeatureMode {
    const mode = this.setting('featureMode');
    if (mode !== 'enabled' && mode !== 'disabled') throw new Error(`Invalid persisted Memory feature mode: ${mode}`);
    return mode;
  }

  setFeatureMode(mode: MemoryFeatureMode, activeTurnIds: readonly TurnId[], now = Date.now()): MemoryControlStatus {
    this.transaction(() => {
      if (mode === 'disabled') {
        const nextGeneration = this.numberSetting('featureModeGeneration') + 1;
        for (const turnId of new Set(activeTurnIds)) {
          this.db.prepare(`
            INSERT OR IGNORE INTO turn_exclusions(turn_id, reason, epoch, created_at)
            VALUES (?, 'globalDisable', ?, ?)
          `).run(turnId, nextGeneration, now);
        }
      }
      if (this.featureMode() !== mode) {
        this.putSetting('featureMode', mode);
        this.incrementSetting('featureModeGeneration');
        this.incrementSetting('memoryVisibilityGeneration');
      }
    });
    return this.status();
  }

  threadMode(threadId: ThreadId): ThreadMemoryMode {
    const row = this.db.prepare('SELECT mode FROM thread_modes WHERE thread_id = ?').get(threadId) as ThreadModeRow | undefined;
    if (!row) return 'enabled';
    if (row.mode !== 'enabled' && row.mode !== 'disabled') throw new Error(`Invalid Thread Memory mode: ${row.mode}`);
    return row.mode;
  }

  setThreadMode(threadId: ThreadId, mode: ThreadMemoryMode, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO thread_modes(thread_id, mode, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
    `).run(threadId, mode, now);
  }

  writeAdmission(snapshot: MemoryAdmissionSnapshot): void {
    const existing = this.admission(snapshot.turnId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error('Memory admission snapshot is immutable');
      return;
    }
    this.db.prepare(`
      INSERT INTO turn_admissions(
        turn_id, thread_id, feature_mode, thread_mode, eligible, feature_generation,
        reset_epoch, visibility_generation, admitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.turnId,
      snapshot.threadId,
      snapshot.featureModeAtAdmission,
      snapshot.threadModeAtAdmission,
      snapshot.eligibleAtAdmission ? 1 : 0,
      snapshot.featureModeGeneration,
      snapshot.resetEpoch,
      snapshot.memoryVisibilityGeneration,
      snapshot.admittedAt,
    );
  }

  admission(turnId: TurnId): MemoryAdmissionSnapshot | null {
    const row = this.db.prepare('SELECT * FROM turn_admissions WHERE turn_id = ?').get(turnId) as AdmissionRow | undefined;
    return row ? admissionFromRow(row) : null;
  }

  deleteOrphanAdmissions(durableTurnIds: ReadonlySet<TurnId>): void {
    const rows = this.db.prepare('SELECT turn_id FROM turn_admissions').all() as Array<{ turn_id: string }>;
    this.transaction(() => {
      for (const row of rows) {
        if (!durableTurnIds.has(row.turn_id)) this.db.prepare('DELETE FROM turn_admissions WHERE turn_id = ?').run(row.turn_id);
      }
    });
  }

  isTurnExcluded(turnId: TurnId): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS present FROM turn_exclusions WHERE turn_id = ? LIMIT 1').get(turnId));
  }

  source(threadId: ThreadId): MemorySourceRecord | null {
    const row = this.db.prepare('SELECT * FROM source_records WHERE thread_id = ?').get(threadId) as SourceRow | undefined;
    return row ? {
      threadId: row.thread_id,
      sourceVersion: row.source_version,
      status: row.status as MemorySourceRecord['status'],
      polluted: row.polluted === 1,
      updatedAt: row.updated_at,
    } : null;
  }

  finalizeStage1NoOutput(threadId: ThreadId, sourceVersion: string, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM node_lineage WHERE thread_id = ?').run(threadId);
      this.db.prepare(`
        INSERT INTO source_records(thread_id, source_version, status, polluted, updated_at)
        VALUES (?, ?, 'succeededNoOutput', 0, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          source_version = excluded.source_version,
          status = excluded.status,
          polluted = 0,
          updated_at = excluded.updated_at
      `).run(threadId, sourceVersion, now);
      this.enqueueJob('phase2:global', 'phase2', { reason: 'stage1-no-output' }, now);
      this.recordSuccess(now);
    });
  }

  markThreadPolluted(threadId: ThreadId, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO source_records(thread_id, source_version, status, polluted, updated_at)
        VALUES (?, '', 'succeededNoOutput', 1, ?)
        ON CONFLICT(thread_id) DO UPDATE SET polluted = 1, updated_at = excluded.updated_at
      `).run(threadId, now);
      const origins = this.db.prepare(`
        SELECT origin_item_id FROM origin_claims WHERE thread_id = ?
      `).all(threadId) as Array<{ origin_item_id: string }>;
      for (const origin of origins) {
        this.db.prepare('DELETE FROM citation_usage WHERE origin_item_id = ?').run(origin.origin_item_id);
      }
      this.db.prepare('DELETE FROM origin_claims WHERE thread_id = ?').run(threadId);
      this.enqueueJob(`phase2:pollution:${threadId}`, 'phase2', { threadId }, now);
    });
  }

  claimOrigin(
    originItemId: ThreadItemId,
    threadId: ThreadId,
    turnId: TurnId,
    sourceDate: string,
    contentHash: string,
  ): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO origin_claims(origin_item_id, thread_id, turn_id, source_date, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(originItemId, threadId, turnId, sourceDate, contentHash);
    if (Number(result.changes) === 1) return true;
    const row = this.db.prepare('SELECT * FROM origin_claims WHERE origin_item_id = ?').get(originItemId) as {
      thread_id: string; turn_id: string; source_date: string; content_hash: string;
    };
    return row.thread_id === threadId && row.turn_id === turnId
      && row.source_date === sourceDate && row.content_hash === contentHash;
  }

  originSourceDate(originItemId: ThreadItemId): string | null {
    const row = this.db.prepare('SELECT source_date FROM origin_claims WHERE origin_item_id = ?').get(originItemId) as
      | { source_date: string }
      | undefined;
    return row?.source_date ?? null;
  }

  isOriginClaimed(originItemId: ThreadItemId): boolean {
    return Boolean(this.db.prepare('SELECT 1 AS present FROM origin_claims WHERE origin_item_id = ?').get(originItemId));
  }

  generatedNodeIdsWithoutCurrentSupport(): readonly string[] {
    return this.generatedNodes()
      .filter((node) => !node.userAuthoritative)
      .filter((node) => {
        const lineage = this.lineageForNode(node.nodeId);
        return lineage.length === 0 || lineage.every((edge) => !this.isOriginClaimed(edge.originItemId));
      })
      .map((node) => node.nodeId);
  }

  preparePublication<T>(record: MemoryPublicationRecord<T>): void {
    const existing = this.publication<T>(record.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error('Memory publication identity collision');
      return;
    }
    this.db.prepare(`
      INSERT INTO publications(
        id, kind, status, generation, feature_generation, reset_epoch, digest, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.kind,
      record.status,
      record.generation,
      record.featureGeneration,
      record.resetEpoch,
      record.digest,
      JSON.stringify(record.payload),
      record.createdAt,
    );
  }

  prepareReset<T extends { readonly epoch: number; readonly excludedTurnIds: readonly TurnId[] }>(
    record: MemoryPublicationRecord<T>,
    now = Date.now(),
  ): void {
    this.transaction(() => {
      this.preparePublication(record);
      for (const turnId of new Set(record.payload.excludedTurnIds)) {
        this.db.prepare(`
          INSERT OR IGNORE INTO turn_exclusions(turn_id, reason, epoch, created_at)
          VALUES (?, 'reset', ?, ?)
        `).run(turnId, record.payload.epoch, now);
      }
      this.enqueueJob(`reset:${record.id}`, 'reset', { publicationId: record.id }, now);
    });
  }

  publication<T = unknown>(id: string): MemoryPublicationRecord<T> | null {
    const row = this.db.prepare('SELECT * FROM publications WHERE id = ?').get(id) as PublicationRow | undefined;
    return row ? publicationFromRow<T>(row) : null;
  }

  preparedPublications(): readonly MemoryPublicationRecord[] {
    return (this.db.prepare(`SELECT * FROM publications WHERE status = 'prepared' ORDER BY created_at, id`).all() as PublicationRow[])
      .map((row) => publicationFromRow(row));
  }

  finalizePublication(id: string): void {
    this.transaction(() => this.finalizePublicationInsideTransaction(id));
  }

  allocatePublicationGeneration(): number {
    return this.transaction(() => this.incrementSetting('publicationGeneration'));
  }

  discardPreparedPublication(id: string): void {
    this.db.prepare(`DELETE FROM publications WHERE id = ? AND status = 'prepared'`).run(id);
  }

  finalizeStage1(input: MemoryStage1Finalization, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM node_lineage WHERE thread_id = ?').run(input.threadId);
      this.writeGeneratedNodesAndLineage(input.nodes, input.lineage);
      this.db.prepare(`
        INSERT INTO source_records(thread_id, source_version, status, polluted, updated_at)
        VALUES (?, ?, 'succeeded', 0, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          source_version = excluded.source_version,
          status = excluded.status,
          polluted = 0,
          updated_at = excluded.updated_at
      `).run(input.threadId, input.sourceVersion, now);
      this.finalizePublicationInsideTransaction(input.publicationId);
      this.enqueueJob('phase2:global', 'phase2', { reason: 'stage1' }, now);
      this.recordSuccess(now);
    });
  }

  finalizeStage2(input: MemoryStage2Finalization, now = Date.now()): void {
    this.transaction(() => {
      for (const nodeId of input.deletedNodeIds) {
        this.db.prepare('DELETE FROM generated_nodes WHERE node_id = ?').run(nodeId);
      }
      for (const nodeId of input.releasedNodeIds) {
        this.db.prepare(`UPDATE generated_nodes SET user_authoritative = 1 WHERE node_id = ?`).run(nodeId);
        this.db.prepare('DELETE FROM node_lineage WHERE node_id = ?').run(nodeId);
      }
      for (const node of input.upsertedNodes) {
        this.db.prepare('DELETE FROM node_lineage WHERE node_id = ?').run(node.nodeId);
      }
      this.writeGeneratedNodesAndLineage(input.upsertedNodes, input.lineage);
      this.finalizePublicationInsideTransaction(input.publicationId);
      for (const rollbackId of input.reconciledRollbackIds) {
        const rollback = this.rollback(rollbackId);
        if (!rollback || rollback.status !== 'committed') {
          throw new Error(`Memory rollback is not ready for reconciliation: ${rollbackId}`);
        }
        this.db.prepare(`UPDATE rollback_invalidations SET status = 'reconciled' WHERE rollback_id = ?`).run(rollbackId);
        this.db.prepare('DELETE FROM dirty_jobs WHERE key = ?').run(`rollback:${rollbackId}`);
      }
      if (input.needsFollowUp || this.activeRollbacks().some((rollback) => rollback.status === 'committed')) {
        this.enqueueJob(
          `phase2:rollback-continuation:${input.publicationId}`,
          'phase2',
          { reason: 'rollback-continuation' },
          now,
        );
      }
      this.incrementSetting('memoryVisibilityGeneration');
      this.recordSuccess(now);
    });
  }

  replaceGeneratedNodes(
    threadId: ThreadId,
    nodes: readonly MemoryGeneratedNodeRecord[],
    lineage: readonly MemoryLineageInput[],
  ): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM node_lineage WHERE thread_id = ?').run(threadId);
      this.writeGeneratedNodesAndLineage(nodes, lineage);
    });
  }

  generatedNodes(): readonly MemoryGeneratedNodeRecord[] {
    if (this.generatedNodesCache) return this.generatedNodesCache;
    this.generatedNodesCache = Object.freeze(
      (this.db.prepare('SELECT * FROM generated_nodes ORDER BY generated_at, node_id').all() as GeneratedNodeRow[])
        .map((row) => Object.freeze({
          nodeId: row.node_id,
          category: row.category,
          sourceDate: row.source_date,
          fingerprint: row.fingerprint,
          userAuthoritative: row.user_authoritative === 1,
          generatedAt: row.generated_at,
        })),
    );
    return this.generatedNodesCache;
  }

  generatedNodeIds(): ReadonlySet<string> {
    if (!this.generatedNodeIdsCache) {
      this.generatedNodeIdsCache = new Set(this.generatedNodesById().keys());
    }
    return this.generatedNodeIdsCache;
  }

  generatedNodesById(): ReadonlyMap<string, MemoryGeneratedNodeRecord> {
    if (!this.generatedNodesByIdCache) {
      this.generatedNodesByIdCache = new Map(this.generatedNodes().map((entry) => [entry.nodeId, entry]));
    }
    return this.generatedNodesByIdCache;
  }

  generatedNodesForThread(threadId: ThreadId): readonly MemoryGeneratedNodeRecord[] {
    return (this.db.prepare(`
      SELECT DISTINCT generated_nodes.*
      FROM generated_nodes
      JOIN node_lineage ON node_lineage.node_id = generated_nodes.node_id
      WHERE node_lineage.thread_id = ?
      ORDER BY generated_nodes.source_date, generated_nodes.category, generated_nodes.node_id
    `).all(threadId) as GeneratedNodeRow[]).map((row) => ({
      nodeId: row.node_id,
      category: row.category,
      sourceDate: row.source_date,
      fingerprint: row.fingerprint,
      userAuthoritative: row.user_authoritative === 1,
      generatedAt: row.generated_at,
    }));
  }

  markNodeUserAuthoritative(nodeId: string): void {
    this.db.prepare(`UPDATE generated_nodes SET user_authoritative = 1 WHERE node_id = ?`).run(nodeId);
    this.invalidateGeneratedNodesCache();
  }

  updateGeneratedNodeFingerprint(nodeId: string, fingerprint: string): void {
    this.db.prepare(`UPDATE generated_nodes SET fingerprint = ? WHERE node_id = ?`).run(fingerprint, nodeId);
    this.invalidateGeneratedNodesCache();
  }

  removeGeneratedNode(nodeId: string): void {
    this.db.prepare('DELETE FROM generated_nodes WHERE node_id = ?').run(nodeId);
    this.invalidateGeneratedNodesCache();
  }

  lineageForNode(nodeId: string): readonly MemoryLineageInput[] {
    return (this.db.prepare('SELECT * FROM node_lineage WHERE node_id = ? ORDER BY origin_item_id').all(nodeId) as Array<{
      node_id: string; thread_id: string; turn_id: string; origin_item_id: string;
    }>).map((row) => ({
      nodeId: row.node_id,
      threadId: row.thread_id,
      turnId: row.turn_id,
      originItemId: row.origin_item_id,
    }));
  }

  generatedNodeIdsSupportedOnlyByTurns(turnIds: readonly TurnId[]): {
    readonly nodeIds: readonly string[];
    readonly complete: boolean;
  } {
    const omitted = new Set(turnIds);
    const generated = this.generatedNodes().filter((node) => !node.userAuthoritative);
    const suppressed: string[] = [];
    let complete = true;
    for (const node of generated) {
      const lineage = this.lineageForNode(node.nodeId);
      if (lineage.length === 0) {
        complete = false;
        continue;
      }
      if (lineage.every((edge) => omitted.has(edge.turnId))) suppressed.push(node.nodeId);
    }
    return { nodeIds: Object.freeze(suppressed), complete };
  }

  prepareRollback(input: Omit<MemoryRollbackRecord, 'status' | 'createdAt'>, now = Date.now()): void {
    const existing = this.rollback(input.rollbackId);
    if (existing) {
      if (existing.status === 'aborted') throw new Error('Cannot prepare an aborted Memory rollback invalidation');
      return;
    }
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO rollback_invalidations(
          rollback_id, thread_id, status, omitted_turn_ids_json, before_version, after_version,
          suppressed_node_ids_json, suppress_all_generated, created_at
        ) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?, ?)
      `).run(
        input.rollbackId,
        input.threadId,
        JSON.stringify(input.omittedTurnIds),
        input.beforeVersion,
        input.afterVersion,
        JSON.stringify(input.suppressedNodeIds),
        input.suppressAllGenerated ? 1 : 0,
        now,
      );
      this.incrementSetting('memoryVisibilityGeneration');
    });
  }

  commitRollback(rollbackId: string, now = Date.now()): void {
    this.transaction(() => {
      const record = this.rollback(rollbackId);
      if (!record) throw new Error(`Memory rollback invalidation not found: ${rollbackId}`);
      if (record.status === 'aborted') throw new Error('Cannot commit an aborted Memory rollback invalidation');
      if (record.status === 'prepared') {
        this.db.prepare(`UPDATE rollback_invalidations SET status = 'committed' WHERE rollback_id = ?`).run(rollbackId);
      }
      const placeholders = record.omittedTurnIds.map(() => '?').join(',');
      if (placeholders) {
        this.db.prepare(`DELETE FROM citation_usage WHERE citation_turn_id IN (${placeholders})`)
          .run(...record.omittedTurnIds);
        const origins = this.db.prepare(`
          SELECT origin_item_id FROM origin_claims WHERE turn_id IN (${placeholders})
        `).all(...record.omittedTurnIds) as Array<{ origin_item_id: string }>;
        for (const origin of origins) {
          this.db.prepare('DELETE FROM citation_usage WHERE origin_item_id = ?').run(origin.origin_item_id);
        }
        this.db.prepare(`DELETE FROM origin_claims WHERE turn_id IN (${placeholders})`).run(...record.omittedTurnIds);
      }
      this.enqueueJob(`rollback:${rollbackId}`, 'rollback', { rollbackId }, now);
    });
  }

  abortRollback(rollbackId: string): void {
    const record = this.rollback(rollbackId);
    if (!record) return;
    if (record.status === 'committed' || record.status === 'reconciled') {
      throw new Error('Cannot abort a committed Memory rollback invalidation');
    }
    this.db.prepare(`UPDATE rollback_invalidations SET status = 'aborted' WHERE rollback_id = ?`).run(rollbackId);
    this.incrementSetting('memoryVisibilityGeneration');
  }

  reconcileRollback(rollbackId: string): void {
    const record = this.rollback(rollbackId);
    if (!record || record.status === 'reconciled') return;
    if (record.status !== 'committed') throw new Error('Only a committed Memory rollback can be reconciled');
    this.transaction(() => {
      this.db.prepare(`UPDATE rollback_invalidations SET status = 'reconciled' WHERE rollback_id = ?`).run(rollbackId);
      this.db.prepare('DELETE FROM dirty_jobs WHERE key = ?').run(`rollback:${rollbackId}`);
      this.incrementSetting('memoryVisibilityGeneration');
    });
  }

  rollback(rollbackId: string): MemoryRollbackRecord | null {
    const row = this.db.prepare('SELECT * FROM rollback_invalidations WHERE rollback_id = ?').get(rollbackId) as
      | RollbackRow
      | undefined;
    return row ? rollbackFromRow(row) : null;
  }

  activeRollbacks(): readonly MemoryRollbackRecord[] {
    return (this.db.prepare(`
      SELECT * FROM rollback_invalidations WHERE status IN ('prepared', 'committed') ORDER BY created_at, rollback_id
    `).all() as RollbackRow[]).map(rollbackFromRow);
  }

  enqueueJob(key: string, kind: string, payload: unknown, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO dirty_jobs(key, kind, payload_json, attempt, available_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        kind = excluded.kind,
        payload_json = excluded.payload_json,
        available_at = MIN(dirty_jobs.available_at, excluded.available_at),
        updated_at = excluded.updated_at
    `).run(key, kind, JSON.stringify(payload), now, now);
  }

  scheduleJob(key: string, kind: string, payload: unknown, availableAt: number, now = Date.now()): void {
    this.db.prepare(`
      INSERT INTO dirty_jobs(key, kind, payload_json, attempt, available_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        kind = excluded.kind,
        payload_json = excluded.payload_json,
        available_at = MAX(dirty_jobs.available_at, excluded.available_at),
        updated_at = excluded.updated_at
    `).run(key, kind, JSON.stringify(payload), availableAt, now);
  }

  nextJob(now = Date.now()): MemoryDirtyJob | null {
    const row = this.db.prepare(`
      SELECT key, kind, payload_json, attempt, available_at
      FROM dirty_jobs WHERE available_at <= ? ORDER BY available_at, updated_at, key LIMIT 1
    `).get(now) as JobRow | undefined;
    return row ? { key: row.key, kind: row.kind, payload: JSON.parse(row.payload_json), attempt: row.attempt } : null;
  }

  nextJobAvailableAt(): number | null {
    const row = this.db.prepare('SELECT MIN(available_at) AS available_at FROM dirty_jobs').get() as {
      available_at: number | null;
    };
    return row.available_at;
  }

  completeJob(key: string): void {
    this.db.prepare('DELETE FROM dirty_jobs WHERE key = ?').run(key);
  }

  failJob(key: string, error: string, now = Date.now()): void {
    const row = this.db.prepare('SELECT attempt FROM dirty_jobs WHERE key = ?').get(key) as { attempt: number } | undefined;
    const attempt = (row?.attempt ?? 0) + 1;
    const delay = Math.min(60_000, 250 * 2 ** Math.min(attempt, 8));
    this.db.prepare(`
      UPDATE dirty_jobs SET attempt = ?, available_at = ?, updated_at = ? WHERE key = ?
    `).run(attempt, now + delay, now, key);
    this.putSetting('lastError', redactSecretLikeContent(error).slice(0, 2_000));
  }

  recordSuccess(now = Date.now()): void {
    this.putSetting('lastSuccessfulRunAt', String(now));
    this.putSetting('lastError', '');
  }

  recordCitationUsage(
    input: {
      readonly citationItemId: ThreadItemId;
      readonly citationTurnId: TurnId;
      readonly nodeId: string;
      readonly originItemIds: readonly ThreadItemId[];
    },
    usedAt = Date.now(),
  ): void {
    this.transaction(() => {
      for (const originItemId of new Set(input.originItemIds)) {
        this.db.prepare(`
          INSERT OR IGNORE INTO citation_usage(
            citation_item_id, citation_turn_id, node_id, origin_item_id, used_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(input.citationItemId, input.citationTurnId, input.nodeId, originItemId, usedAt);
      }
    });
  }

  usageForNode(nodeId: string): { count: number; lastUsage: number | null } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(used_at) AS last_usage FROM citation_usage WHERE node_id = ?
    `).get(nodeId) as { count: number; last_usage: number | null };
    return { count: Number(row.count), lastUsage: row.last_usage };
  }

  finalizeReset(
    publicationId: string,
    epoch: number,
    excludedTurnIds: readonly TurnId[],
  ): void {
    this.transaction(() => {
      for (const turnId of new Set(excludedTurnIds)) {
        this.db.prepare(`
          INSERT OR IGNORE INTO turn_exclusions(turn_id, reason, epoch, created_at) VALUES (?, 'reset', ?, ?)
        `).run(turnId, epoch, Date.now());
      }
      this.putSetting('resetEpoch', String(epoch));
      this.incrementSetting('memoryVisibilityGeneration');
      for (const table of [
        'source_records',
        'origin_claims',
        'node_lineage',
        'generated_nodes',
        'citation_usage',
        'rollback_invalidations',
        'dirty_jobs',
      ]) this.db.exec(`DELETE FROM ${table}`);
      this.db.prepare(`DELETE FROM publications WHERE id != ?`).run(publicationId);
      const publication = this.publication(publicationId);
      if (!publication) throw new Error(`Memory publication not found: ${publicationId}`);
      this.db.prepare(`UPDATE publications SET status = 'finalized' WHERE id = ?`).run(publicationId);
      this.putSetting('publicationGeneration', String(Math.max(
        this.numberSetting('publicationGeneration'),
        publication.generation,
      )));
    });
    this.invalidateGeneratedNodesCache();
  }

  private initializeSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(key, value);
  }

  private setting(key: string): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as SettingRow | undefined;
    if (!row) throw new Error(`Memory setting not found: ${key}`);
    return row.value;
  }

  private numberSetting(key: string): number {
    const value = Number(this.setting(key));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Memory numeric setting: ${key}`);
    return value;
  }

  private putSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private incrementSetting(key: string): number {
    const value = this.numberSetting(key) + 1;
    this.putSetting(key, String(value));
    return value;
  }

  private writeGeneratedNodesAndLineage(
    nodes: readonly MemoryGeneratedNodeRecord[],
    lineage: readonly MemoryLineageInput[],
  ): void {
    for (const node of nodes) {
      this.db.prepare(`
        INSERT INTO generated_nodes(node_id, category, source_date, fingerprint, user_authoritative, generated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          category = excluded.category,
          source_date = excluded.source_date,
          fingerprint = excluded.fingerprint,
          user_authoritative = MAX(generated_nodes.user_authoritative, excluded.user_authoritative),
          generated_at = excluded.generated_at
      `).run(
        node.nodeId,
        node.category,
        node.sourceDate,
        node.fingerprint,
        node.userAuthoritative ? 1 : 0,
        node.generatedAt,
      );
    }
    for (const edge of lineage) {
      this.db.prepare(`
        INSERT OR IGNORE INTO node_lineage(node_id, thread_id, turn_id, origin_item_id)
        VALUES (?, ?, ?, ?)
      `).run(edge.nodeId, edge.threadId, edge.turnId, edge.originItemId);
    }
    this.invalidateGeneratedNodesCache();
  }

  private invalidateGeneratedNodesCache(): void {
    this.generatedNodesCache = null;
    this.generatedNodeIdsCache = null;
    this.generatedNodesByIdCache = null;
  }

  private finalizePublicationInsideTransaction(id: string): void {
    const publication = this.publication(id);
    if (!publication) throw new Error(`Memory publication not found: ${id}`);
    if (publication.status === 'prepared') {
      this.db.prepare(`UPDATE publications SET status = 'finalized' WHERE id = ?`).run(id);
    }
    this.putSetting('publicationGeneration', String(Math.max(
      this.numberSetting('publicationGeneration'),
      publication.generation,
    )));
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.invalidateGeneratedNodesCache();
      throw error;
    }
  }
}

function admissionFromRow(row: AdmissionRow): MemoryAdmissionSnapshot {
  return {
    threadId: row.thread_id,
    turnId: row.turn_id,
    featureModeAtAdmission: row.feature_mode as MemoryFeatureMode,
    threadModeAtAdmission: row.thread_mode as ThreadMemoryMode,
    eligibleAtAdmission: row.eligible === 1,
    featureModeGeneration: row.feature_generation,
    resetEpoch: row.reset_epoch,
    memoryVisibilityGeneration: row.visibility_generation,
    admittedAt: row.admitted_at,
  };
}

function publicationFromRow<T>(row: PublicationRow): MemoryPublicationRecord<T> {
  return {
    id: row.id,
    kind: row.kind as MemoryPublicationRecord['kind'],
    status: row.status as MemoryPublicationRecord['status'],
    generation: row.generation,
    featureGeneration: row.feature_generation,
    resetEpoch: row.reset_epoch,
    digest: row.digest,
    payload: JSON.parse(row.payload_json) as T,
    createdAt: row.created_at,
  };
}

function rollbackFromRow(row: RollbackRow): MemoryRollbackRecord {
  return {
    rollbackId: row.rollback_id,
    threadId: row.thread_id,
    status: row.status as MemoryRollbackRecord['status'],
    omittedTurnIds: JSON.parse(row.omitted_turn_ids_json) as TurnId[],
    beforeVersion: row.before_version,
    afterVersion: row.after_version,
    suppressedNodeIds: JSON.parse(row.suppressed_node_ids_json) as string[],
    suppressAllGenerated: row.suppress_all_generated === 1,
    createdAt: row.created_at,
  };
}

function nullableNumberSetting(value: string): number | null {
  if (!value) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

export type { SqliteValue };
