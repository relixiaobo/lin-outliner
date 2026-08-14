import type { ThreadId, TurnId } from '../../../core/agent/protocol';
import type { SubagentToolPolicy } from '../capabilities/subagentToolPolicy';
import type {
  AgentWorktreeMetadata,
  AgentWorktreeRecoveryIntent,
} from '../worktree/AgentWorktree';
import type { SqliteDatabase } from './sqlite';
import type { AgentStartupContextSnapshot } from '../context/AgentStartupContext';

export type { AgentStartupContextSnapshot } from '../context/AgentStartupContext';

export type SubagentRunMode = 'foreground' | 'background';
export type SubagentStopProvenance = 'none' | 'model' | 'user' | 'budget' | 'hostRestart';
export type SubagentTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'killed';
export type SubagentNotificationState = 'pending' | 'delivering' | 'delivered';
export type SubagentInitialAdmissionState = 'pending' | 'committed';

export interface SubagentRecordedToolPolicy extends SubagentToolPolicy {
  readonly requestedTools: readonly string[] | null;
}

export interface SubagentExecutionRecord {
  readonly agentId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly description: string;
  readonly agentType: string;
  readonly runMode: SubagentRunMode;
  readonly generation: number;
  readonly currentTurnId: TurnId;
  readonly toolUseId: string;
  readonly stopProvenance: SubagentStopProvenance;
  readonly worktree: AgentWorktreeMetadata | null;
  /** Durable intent written immediately before a clean worktree is removed. */
  readonly worktreeCleanupStartedAt: number | null;
  readonly toolPolicy: SubagentRecordedToolPolicy;
  readonly startupContext: AgentStartupContextSnapshot | null;
  /**
   * `pending` is the cross-store prepare record for a fresh child. The first
   * durable `turn/started` commits it; startup rolls back anything earlier.
   */
  readonly initialAdmissionState: SubagentInitialAdmissionState;
  /** Complete recovery authority persisted before the first managed Git mutation. */
  readonly initialWorktreeIntent: AgentWorktreeRecoveryIntent | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SubagentGenerationSnapshot {
  readonly generation: number;
  readonly currentTurnId: TurnId;
  readonly toolUseId: string;
  readonly runMode: SubagentRunMode;
  readonly stopProvenance: SubagentStopProvenance;
  readonly worktree: AgentWorktreeMetadata | null;
  readonly worktreeCleanupStartedAt: number | null;
  readonly updatedAt: number;
}

export interface SubagentPendingNotification {
  readonly agentId: ThreadId;
  readonly generation: number;
  readonly parentThreadId: ThreadId;
  readonly turnId: TurnId;
  readonly toolUseId: string;
  readonly status: SubagentTerminalStatus;
  readonly state: SubagentNotificationState;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

export interface SubagentParentMessage {
  readonly id: string;
  readonly senderAgentId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly generation: number;
  readonly content: string;
  readonly deliveryMode: SubagentRunMode;
  readonly state: SubagentNotificationState;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

interface ExecutionRow {
  agent_id: string;
  parent_thread_id: string;
  description: string;
  agent_type: string;
  run_mode: string;
  generation: number;
  current_turn_id: string;
  tool_use_id: string;
  stop_provenance: string;
  worktree_json: string | null;
  worktree_cleanup_started_at: number | null;
  tool_policy_json: string;
  startup_context_json: string | null;
  admission_previous_json: string | null;
  initial_admission_state: string;
  initial_worktree_intent_json: string | null;
  created_at: number;
  updated_at: number;
}

interface NotificationRow {
  agent_id: string;
  generation: number;
  parent_thread_id: string;
  turn_id: string;
  tool_use_id: string;
  status: string;
  state: string;
  created_at: number;
  delivered_at: number | null;
}

interface ParentMessageRow {
  id: string;
  sender_agent_id: string;
  parent_thread_id: string;
  generation: number;
  content: string;
  delivery_mode: string;
  state: string;
  created_at: number;
  delivered_at: number | null;
}

/** Announces that one Agent's execution state was written. */
export type SubagentExecutionChangeObserver = (agentId: ThreadId) => void;

/**
 * Persistent execution state that is not already represented by Thread/Turn.
 * Agent identity is the child Thread id; model, cwd, Role, and transcript stay
 * in their existing authorities and are deliberately not duplicated here.
 */
export class SubagentExecutionLedger {
  private readonly deletedAgentIds = new Set<ThreadId>();

  private onExecutionChanged: SubagentExecutionChangeObserver = () => undefined;

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(`
      -- Pre-release clean cut: the admission columns change the persistence
      -- contract, so use fresh table names instead of shape-sniffing old rows.
      DROP TABLE IF EXISTS subagent_executions;
      DROP TABLE IF EXISTS subagent_notifications;
      DROP TABLE IF EXISTS subagent_parent_messages;
      DROP TABLE IF EXISTS subagent_spawn_counts;
      CREATE TABLE IF NOT EXISTS subagent_execution_records (
        agent_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        description TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        run_mode TEXT NOT NULL CHECK (run_mode IN ('foreground', 'background')),
        generation INTEGER NOT NULL CHECK (generation > 0),
        current_turn_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        stop_provenance TEXT NOT NULL CHECK (
          stop_provenance IN ('none', 'model', 'user', 'budget', 'hostRestart')
        ),
        worktree_json TEXT,
        worktree_cleanup_started_at INTEGER,
        tool_policy_json TEXT NOT NULL,
        startup_context_json TEXT,
        admission_previous_json TEXT,
        initial_admission_state TEXT NOT NULL CHECK (
          initial_admission_state IN ('pending', 'committed')
        ),
        initial_worktree_intent_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_execution_records_parent_idx
        ON subagent_execution_records(parent_thread_id, created_at, agent_id);
      CREATE TABLE IF NOT EXISTS subagent_execution_notifications (
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        parent_thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'interrupted', 'killed')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered')),
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        PRIMARY KEY(agent_id, generation)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_execution_notifications_pending_idx
        ON subagent_execution_notifications(parent_thread_id, state, created_at, agent_id, generation);
      CREATE TABLE IF NOT EXISTS subagent_execution_parent_messages (
        id TEXT PRIMARY KEY,
        sender_agent_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        content TEXT NOT NULL,
        delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('foreground', 'background')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered')),
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_execution_parent_messages_pending_idx
        ON subagent_execution_parent_messages(parent_thread_id, state, delivery_mode, sender_agent_id, generation, created_at, id);
    `);
    // A process may die after claiming but before admitting the parent Turn.
    // Client-input idempotency makes replay safe, so claims are recoverable.
    this.db.prepare("UPDATE subagent_execution_notifications SET state = 'pending' WHERE state = 'delivering'").run();
    this.db.prepare("UPDATE subagent_execution_parent_messages SET state = 'pending' WHERE state = 'delivering'").run();
  }

  create(input: Omit<
    SubagentExecutionRecord,
    | 'generation'
    | 'stopProvenance'
    | 'worktreeCleanupStartedAt'
    | 'initialAdmissionState'
    | 'initialWorktreeIntent'
  >): SubagentExecutionRecord {
    return this.insertExecution(input, 'committed', null);
  }

  beginInitialAdmission(input: Omit<
    SubagentExecutionRecord,
    | 'generation'
    | 'stopProvenance'
    | 'worktreeCleanupStartedAt'
    | 'initialAdmissionState'
    | 'initialWorktreeIntent'
  > & {
    readonly initialWorktreeIntent: AgentWorktreeRecoveryIntent | null;
  }): SubagentExecutionRecord {
    return this.insertExecution(input, 'pending', input.initialWorktreeIntent);
  }

  private insertExecution(
    input: Omit<
      SubagentExecutionRecord,
      | 'generation'
      | 'stopProvenance'
      | 'worktreeCleanupStartedAt'
      | 'initialAdmissionState'
      | 'initialWorktreeIntent'
    >,
    initialAdmissionState: SubagentInitialAdmissionState,
    initialWorktreeIntent: AgentWorktreeRecoveryIntent | null,
  ): SubagentExecutionRecord {
    this.db.prepare(`
      INSERT INTO subagent_execution_records(
        agent_id, parent_thread_id, description, agent_type, run_mode, generation,
        current_turn_id, tool_use_id, stop_provenance, worktree_json,
        worktree_cleanup_started_at, tool_policy_json,
        startup_context_json, admission_previous_json, initial_admission_state,
        initial_worktree_intent_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'none', ?, NULL, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      input.agentId,
      input.parentThreadId,
      input.description,
      input.agentType,
      input.runMode,
      input.currentTurnId,
      input.toolUseId,
      encodeWorktree(input.worktree),
      JSON.stringify(input.toolPolicy),
      input.startupContext === null ? null : JSON.stringify(input.startupContext),
      initialAdmissionState,
      initialWorktreeIntent === null ? null : JSON.stringify(initialWorktreeIntent),
      input.createdAt,
      input.updatedAt,
    );
    return this.touched(input.agentId);
  }

  pendingInitialAdmissions(): readonly SubagentExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_execution_records
      WHERE initial_admission_state = 'pending' ORDER BY created_at, agent_id
    `).all() as unknown as ExecutionRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(executionFromRow);
  }

  recordInitialWorktreeIfPending(input: {
    readonly agentId: ThreadId;
    readonly turnId: TurnId;
    readonly worktree: AgentWorktreeMetadata;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET worktree_json = ?, updated_at = ?
      WHERE agent_id = ? AND current_turn_id = ?
        AND initial_admission_state = 'pending' AND worktree_json IS NULL
    `).run(
      encodeWorktree(input.worktree),
      input.updatedAt,
      input.agentId,
      input.turnId,
    );
    if (Number(result.changes) !== 1) return null;
    return this.touched(input.agentId);
  }

  clearInitialWorktreeIntentIfPending(input: {
    readonly agentId: ThreadId;
    readonly turnId: TurnId;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET initial_worktree_intent_json = NULL, updated_at = ?
      WHERE agent_id = ? AND current_turn_id = ?
        AND initial_admission_state = 'pending'
    `).run(input.updatedAt, input.agentId, input.turnId);
    if (Number(result.changes) !== 1) return null;
    return this.touched(input.agentId);
  }

  completeInitialAdmissionIfCurrent(
    agentId: ThreadId,
    turnId: TurnId,
    updatedAt: number,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET initial_admission_state = 'committed', initial_worktree_intent_json = NULL,
          updated_at = ?
      WHERE agent_id = ? AND current_turn_id = ? AND initial_admission_state = 'pending'
    `).run(updatedAt, agentId, turnId);
    if (Number(result.changes) !== 1) return false;
    // The commit boundary the renderer is waiting for: only a committed
    // admission is projected, so this is where a child first becomes visible.
    this.announce(agentId);
    return true;
  }

  /**
   * The post-state of a write, announced as it is read back.
   *
   * Every mutating method funnels through here or through `announce`, so a
   * surface that watches execution state cannot go stale because one call site
   * forgot to say it had written. Observers are contained: a presentation
   * listener must never be able to fail a durable write.
   */
  private touched(agentId: ThreadId): SubagentExecutionRecord {
    const record = this.require(agentId);
    this.announce(agentId);
    return record;
  }

  /**
   * The store outlives any one owner and is built before the service that
   * projects it, so the watcher is attached rather than injected.
   */
  observeChanges(observer: SubagentExecutionChangeObserver): void {
    this.onExecutionChanged = observer;
  }

  private announce(agentId: ThreadId): void {
    try {
      this.onExecutionChanged(agentId);
    } catch (error) {
      console.error('[agent] Subagent execution observer failed', error);
    }
  }

  read(agentId: ThreadId): SubagentExecutionRecord | null {
    if (this.deletedAgentIds.has(agentId)) return null;
    const row = this.db.prepare('SELECT * FROM subagent_execution_records WHERE agent_id = ?')
      .get(agentId) as ExecutionRow | undefined;
    return row ? executionFromRow(row) : null;
  }

  startupContextForTurn(agentId: ThreadId, turnId: TurnId): AgentStartupContextSnapshot | null {
    const record = this.read(agentId);
    if (!record || record.currentTurnId !== turnId) return null;
    return record.startupContext;
  }

  require(agentId: ThreadId): SubagentExecutionRecord {
    const record = this.read(agentId);
    if (!record) throw new Error(`Subagent execution not found: ${agentId}`);
    return record;
  }

  listByParent(parentThreadId: ThreadId): readonly SubagentExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_execution_records
      WHERE parent_thread_id = ? ORDER BY created_at, agent_id
    `).all(parentThreadId) as unknown as ExecutionRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(executionFromRow);
  }

  all(): readonly SubagentExecutionRecord[] {
    const rows = this.db.prepare('SELECT * FROM subagent_execution_records ORDER BY created_at, agent_id')
      .all() as unknown as ExecutionRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(executionFromRow);
  }

  /**
   * Advances a generation only when the caller still owns the observed turn.
   * This is the admission-side half of terminal settlement's generation guard.
   */
  beginNextGenerationIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly expectedGeneration: number;
    readonly expectedTurnId: TurnId;
    readonly turnId: TurnId;
    readonly toolUseId: string;
    readonly runMode: SubagentRunMode;
    readonly previous: SubagentGenerationSnapshot;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    if (
      input.previous.generation !== input.expectedGeneration
      || input.previous.currentTurnId !== input.expectedTurnId
    ) throw new Error('Subagent generation admission snapshot does not match its expected owner');
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET generation = generation + 1, current_turn_id = ?, tool_use_id = ?,
          run_mode = ?, stop_provenance = 'none',
          worktree_cleanup_started_at = NULL, admission_previous_json = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND stop_provenance <> 'user' AND worktree_cleanup_started_at IS NULL
    `).run(
      input.turnId,
      input.toolUseId,
      input.runMode,
      JSON.stringify(input.previous),
      input.updatedAt,
      input.agentId,
      input.expectedGeneration,
      input.expectedTurnId,
    );
    return Number(result.changes) === 1 ? this.touched(input.agentId) : null;
  }

  /**
   * User-authored input is the sole authority that may clear a user stop while
   * advancing the stable Agent identity to a new generation.
   */
  beginUserGenerationIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly expectedGeneration: number;
    readonly expectedTurnId: TurnId;
    readonly turnId: TurnId;
    readonly previous: SubagentGenerationSnapshot;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    if (
      input.previous.generation !== input.expectedGeneration
      || input.previous.currentTurnId !== input.expectedTurnId
    ) throw new Error('Subagent generation admission snapshot does not match its expected owner');
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET generation = generation + 1, current_turn_id = ?, stop_provenance = 'none',
          worktree_cleanup_started_at = NULL, admission_previous_json = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND worktree_cleanup_started_at IS NULL
    `).run(
      input.turnId,
      JSON.stringify(input.previous),
      input.updatedAt,
      input.agentId,
      input.expectedGeneration,
      input.expectedTurnId,
    );
    return Number(result.changes) === 1 ? this.touched(input.agentId) : null;
  }

  generationSnapshot(agentId: ThreadId): SubagentGenerationSnapshot {
    const record = this.require(agentId);
    return {
      generation: record.generation,
      currentTurnId: record.currentTurnId,
      toolUseId: record.toolUseId,
      runMode: record.runMode,
      stopProvenance: record.stopProvenance,
      worktree: record.worktree,
      worktreeCleanupStartedAt: record.worktreeCleanupStartedAt,
      updatedAt: record.updatedAt,
    };
  }

  rollbackGeneration(
    agentId: ThreadId,
    expectedGeneration: number,
    expectedTurnId: TurnId,
  ): boolean {
    const snapshot = this.pendingGenerationSnapshot(agentId, expectedGeneration, expectedTurnId);
    if (!snapshot) return false;
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET generation = ?, current_turn_id = ?, tool_use_id = ?, run_mode = ?,
          stop_provenance = ?, worktree_cleanup_started_at = ?,
          admission_previous_json = NULL, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND admission_previous_json IS NOT NULL
    `).run(
      snapshot.generation,
      snapshot.currentTurnId,
      snapshot.toolUseId,
      snapshot.runMode,
      snapshot.stopProvenance,
      snapshot.worktreeCleanupStartedAt,
      snapshot.updatedAt,
      agentId,
      expectedGeneration,
      expectedTurnId,
    );
    if (Number(result.changes) !== 1) return false;
    this.announce(agentId);
    return true;
  }

  pendingGenerationAdmissions(): readonly {
    readonly execution: SubagentExecutionRecord;
    readonly previous: SubagentGenerationSnapshot;
  }[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_execution_records
      WHERE admission_previous_json IS NOT NULL ORDER BY created_at, agent_id
    `).all() as unknown as ExecutionRow[];
    return rows.map((row) => ({
      execution: executionFromRow(row),
      previous: decodeGenerationSnapshot(row.admission_previous_json!),
    }));
  }

  completeGenerationAdmissionIfCurrent(
    agentId: ThreadId,
    generation: number,
    turnId: TurnId,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records SET admission_previous_json = NULL
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND admission_previous_json IS NOT NULL
    `).run(agentId, generation, turnId);
    return Number(result.changes) === 1;
  }

  private pendingGenerationSnapshot(
    agentId: ThreadId,
    generation: number,
    turnId: TurnId,
  ): SubagentGenerationSnapshot | null {
    const row = this.db.prepare(`
      SELECT admission_previous_json FROM subagent_execution_records
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
    `).get(agentId, generation, turnId) as Pick<ExecutionRow, 'admission_previous_json'> | undefined;
    return row?.admission_previous_json ? decodeGenerationSnapshot(row.admission_previous_json) : null;
  }

  continueGeneration(input: {
    readonly agentId: ThreadId;
    readonly expectedGeneration: number;
    readonly expectedTurnId: TurnId;
    readonly turnId: TurnId;
    readonly updatedAt: number;
  }): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records SET current_turn_id = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
    `).run(
      input.turnId,
      input.updatedAt,
      input.agentId,
      input.expectedGeneration,
      input.expectedTurnId,
    );
    if (Number(result.changes) !== 1) return false;
    this.announce(input.agentId);
    return true;
  }

  rollbackContinuation(input: {
    readonly agentId: ThreadId;
    readonly expectedGeneration: number;
    readonly expectedTurnId: TurnId;
    readonly snapshot: SubagentGenerationSnapshot;
  }): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records SET current_turn_id = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
    `).run(
      input.snapshot.currentTurnId,
      input.snapshot.updatedAt,
      input.agentId,
      input.expectedGeneration,
      input.expectedTurnId,
    );
    if (Number(result.changes) !== 1) return false;
    this.announce(input.agentId);
    return true;
  }

  recordStop(
    agentId: ThreadId,
    provenance: Exclude<SubagentStopProvenance, 'none'>,
    updatedAt: number,
  ): SubagentExecutionRecord {
    const existing = this.require(agentId);
    const next = higherPriorityStop(existing.stopProvenance, provenance);
    this.db.prepare(`
      UPDATE subagent_execution_records SET stop_provenance = ?, updated_at = ? WHERE agent_id = ?
    `).run(next, updatedAt, agentId);
    return this.touched(agentId);
  }

  /**
   * Applies stop provenance only while the generation that observed the stop
   * is still current. Terminal accounting can outlive a Turn, so an unguarded
   * write here could stamp an older error onto a resumed generation.
   */
  recordStopIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly turnId: TurnId;
    readonly provenance: Exclude<SubagentStopProvenance, 'none'>;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const existing = this.read(input.agentId);
    if (
      !existing
      || existing.generation !== input.generation
      || existing.currentTurnId !== input.turnId
    ) return null;
    const next = higherPriorityStop(existing.stopProvenance, input.provenance);
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET stop_provenance = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
    `).run(
      next,
      input.updatedAt,
      input.agentId,
      input.generation,
      input.turnId,
    );
    if (Number(result.changes) !== 1) return null;
    return this.touched(input.agentId);
  }

  clearUserStop(agentId: ThreadId, updatedAt: number): SubagentExecutionRecord {
    this.db.prepare(`
      UPDATE subagent_execution_records SET stop_provenance = 'none', updated_at = ?
      WHERE agent_id = ? AND stop_provenance = 'user'
    `).run(updatedAt, agentId);
    return this.touched(agentId);
  }

  /** Updates worktree metadata only for the generation that owns the worktree. */
  setWorktreeIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly turnId: TurnId;
    readonly worktree: AgentWorktreeMetadata | null;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records SET worktree_json = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND worktree_cleanup_started_at IS NULL
    `).run(
      encodeWorktree(input.worktree),
      input.updatedAt,
      input.agentId,
      input.generation,
      input.turnId,
    );
    if (Number(result.changes) !== 1) return null;
    return this.touched(input.agentId);
  }

  beginWorktreeCleanupIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly turnId: TurnId;
    readonly worktree: AgentWorktreeMetadata;
    readonly startedAt: number;
  }): SubagentExecutionRecord | null {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET worktree_cleanup_started_at = COALESCE(worktree_cleanup_started_at, ?),
          updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND worktree_json = ? AND worktree_cleanup_started_at IS NULL
    `).run(
      input.startedAt,
      input.startedAt,
      input.agentId,
      input.generation,
      input.turnId,
      encodeWorktree(input.worktree),
    );
    if (Number(result.changes) !== 1) return null;
    return this.touched(input.agentId);
  }

  completeWorktreeCleanupIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly turnId: TurnId;
    readonly expectedWorktree: AgentWorktreeMetadata;
    readonly worktree: AgentWorktreeMetadata;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET worktree_json = ?, worktree_cleanup_started_at = NULL, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND worktree_json = ? AND worktree_cleanup_started_at IS NOT NULL
    `).run(
      encodeWorktree(input.worktree),
      input.updatedAt,
      input.agentId,
      input.generation,
      input.turnId,
      encodeWorktree(input.expectedWorktree),
    );
    if (Number(result.changes) !== 1) return null;
    return this.touched(input.agentId);
  }

  cancelWorktreeCleanupIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly turnId: TurnId;
    readonly worktree: AgentWorktreeMetadata;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const result = this.db.prepare(`
      UPDATE subagent_execution_records
      SET worktree_cleanup_started_at = NULL, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND worktree_json = ? AND worktree_cleanup_started_at IS NOT NULL
    `).run(
      input.updatedAt,
      input.agentId,
      input.generation,
      input.turnId,
      encodeWorktree(input.worktree),
    );
    if (Number(result.changes) !== 1) return null;
    return this.touched(input.agentId);
  }

  recordTerminal(input: Omit<SubagentPendingNotification, 'state' | 'deliveredAt'>): boolean {
    if (this.deletedAgentIds.has(input.agentId)) return false;
    const run = this.require(input.agentId);
    if (run.generation !== input.generation || run.currentTurnId !== input.turnId) return false;
    this.db.prepare(`
      INSERT INTO subagent_execution_notifications(
        agent_id, generation, parent_thread_id, turn_id, tool_use_id,
        status, state, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(agent_id, generation) DO NOTHING
    `).run(
      input.agentId,
      input.generation,
      input.parentThreadId,
      input.turnId,
      input.toolUseId,
      input.status,
      input.createdAt,
    );
    this.announce(input.agentId);
    return true;
  }

  pendingForParent(parentThreadId: ThreadId): readonly SubagentPendingNotification[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_execution_notifications
      WHERE parent_thread_id = ? AND state = 'pending'
      ORDER BY created_at, agent_id, generation
    `).all(parentThreadId) as unknown as NotificationRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(notificationFromRow);
  }

  hasUndeliveredForParent(parentThreadId: ThreadId): boolean {
    const rows = this.db.prepare(`
      SELECT agent_id FROM subagent_execution_notifications
      WHERE parent_thread_id = ? AND state <> 'delivered'
    `).all(parentThreadId) as unknown as Array<{ agent_id: ThreadId }>;
    return rows.some((row) => !this.deletedAgentIds.has(row.agent_id));
  }

  hasUndeliveredWork(threadId: ThreadId): boolean {
    if (this.deletedAgentIds.has(threadId)) return false;
    const rows = this.db.prepare(`
      SELECT agent_id AS owner_agent_id FROM subagent_execution_notifications
      WHERE (agent_id = ? OR parent_thread_id = ?) AND state <> 'delivered'
      UNION ALL
      SELECT sender_agent_id AS owner_agent_id FROM subagent_execution_parent_messages
      WHERE (sender_agent_id = ? OR parent_thread_id = ?) AND state <> 'delivered'
    `).all(threadId, threadId, threadId, threadId) as unknown as Array<{ owner_agent_id: ThreadId }>;
    return rows.some((row) => !this.deletedAgentIds.has(row.owner_agent_id));
  }

  notificationState(
    agentId: ThreadId,
    generation: number,
  ): SubagentNotificationState | null {
    return this.terminalNotification(agentId, generation)?.state ?? null;
  }

  /**
   * How one generation ended, and where its result stands with the parent.
   *
   * Recorded for background generations only — a foreground result travels
   * back through the `agent` call itself and never becomes a queued envelope.
   */
  terminalNotification(agentId: ThreadId, generation: number): {
    readonly status: SubagentTerminalStatus;
    readonly state: SubagentNotificationState;
  } | null {
    if (this.deletedAgentIds.has(agentId)) return null;
    const row = this.db.prepare(`
      SELECT status, state FROM subagent_execution_notifications
      WHERE agent_id = ? AND generation = ?
    `).get(agentId, generation) as { status: string; state: string } | undefined;
    return row
      ? { status: row.status as SubagentTerminalStatus, state: row.state as SubagentNotificationState }
      : null;
  }

  parentsWithPending(): readonly ThreadId[] {
    const rows = this.db.prepare(`
      SELECT parent_thread_id, agent_id FROM subagent_execution_notifications
      WHERE state = 'pending' ORDER BY parent_thread_id
    `).all() as unknown as Array<{ parent_thread_id: ThreadId; agent_id: ThreadId }>;
    return [...new Set(rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map((row) => row.parent_thread_id))];
  }

  claim(agentId: ThreadId, generation: number): boolean {
    if (this.deletedAgentIds.has(agentId)) return false;
    const result = this.db.prepare(`
      UPDATE subagent_execution_notifications SET state = 'delivering'
      WHERE agent_id = ? AND generation = ? AND state = 'pending'
    `).run(agentId, generation);
    if (Number(result.changes) !== 1) return false;
    this.announce(agentId);
    return true;
  }

  release(agentId: ThreadId, generation: number): void {
    this.db.prepare(`
      UPDATE subagent_execution_notifications SET state = 'pending'
      WHERE agent_id = ? AND generation = ? AND state = 'delivering'
    `).run(agentId, generation);
    this.announce(agentId);
  }

  markDelivered(agentId: ThreadId, generation: number, deliveredAt: number): void {
    this.db.prepare(`
      UPDATE subagent_execution_notifications SET state = 'delivered', delivered_at = ?
      WHERE agent_id = ? AND generation = ? AND state = 'delivering'
    `).run(deliveredAt, agentId, generation);
    this.announce(agentId);
  }

  enqueueParentMessage(input: Omit<SubagentParentMessage, 'state' | 'deliveredAt'>): void {
    if (this.deletedAgentIds.has(input.senderAgentId)) return;
    this.db.prepare(`
      INSERT INTO subagent_execution_parent_messages(
        id, sender_agent_id, parent_thread_id, generation, content, delivery_mode, state, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(id) DO NOTHING
    `).run(
      input.id,
      input.senderAgentId,
      input.parentThreadId,
      input.generation,
      input.content,
      input.deliveryMode,
      input.createdAt,
    );
  }

  pendingParentMessages(parentThreadId: ThreadId): readonly SubagentParentMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_execution_parent_messages
      WHERE parent_thread_id = ? AND state = 'pending' ORDER BY created_at, id
    `).all(parentThreadId) as unknown as ParentMessageRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.sender_agent_id))
      .map(parentMessageFromRow);
  }

  pendingForegroundParentMessages(
    parentThreadId: ThreadId,
    senderAgentId: ThreadId,
    generation: number,
  ): readonly SubagentParentMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_execution_parent_messages
      WHERE parent_thread_id = ? AND state = 'pending' AND delivery_mode = 'foreground'
        AND sender_agent_id = ? AND generation = ?
      ORDER BY created_at, id
    `).all(parentThreadId, senderAgentId, generation) as unknown as ParentMessageRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.sender_agent_id))
      .map(parentMessageFromRow);
  }

  parentsWithPendingMessages(): readonly ThreadId[] {
    const rows = this.db.prepare(`
      SELECT parent_thread_id, sender_agent_id FROM subagent_execution_parent_messages
      WHERE state = 'pending' ORDER BY parent_thread_id
    `).all() as unknown as Array<{ parent_thread_id: ThreadId; sender_agent_id: ThreadId }>;
    return [...new Set(rows
      .filter((row) => !this.deletedAgentIds.has(row.sender_agent_id))
      .map((row) => row.parent_thread_id))];
  }

  claimParentMessage(id: string): boolean {
    const owner = this.db.prepare(`
      SELECT sender_agent_id FROM subagent_execution_parent_messages WHERE id = ?
    `).get(id) as { sender_agent_id: ThreadId } | undefined;
    if (!owner || this.deletedAgentIds.has(owner.sender_agent_id)) return false;
    const result = this.db.prepare(`
      UPDATE subagent_execution_parent_messages SET state = 'delivering'
      WHERE id = ? AND state = 'pending'
    `).run(id);
    return Number(result.changes) === 1;
  }

  releaseParentMessage(id: string): void {
    this.db.prepare(`
      UPDATE subagent_execution_parent_messages SET state = 'pending'
      WHERE id = ? AND state = 'delivering'
    `).run(id);
  }

  /**
   * Permanently drops a foreground envelope whose invoking parent Turn no
   * longer exists. Such input is bound to that Turn and must not be replayed
   * into a later root admission.
   */
  discardParentMessage(id: string): void {
    this.db.prepare(`
      DELETE FROM subagent_execution_parent_messages
      WHERE id = ? AND state = 'delivering'
    `).run(id);
  }

  markParentMessageDelivered(id: string, deliveredAt: number): void {
    this.db.prepare(`
      UPDATE subagent_execution_parent_messages SET state = 'delivered', delivered_at = ?
      WHERE id = ? AND state = 'delivering'
    `).run(deliveredAt, id);
  }

  deleteAgent(agentId: ThreadId): void {
    this.deleteAgents([agentId]);
  }

  /** Removes one orphan identity without cascading into independently recoverable children. */
  deleteAgentOnly(agentId: ThreadId): void {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        DELETE FROM subagent_execution_notifications
        WHERE agent_id = ? OR parent_thread_id = ?
      `).run(agentId, agentId);
      this.db.prepare(`
        DELETE FROM subagent_execution_parent_messages
        WHERE sender_agent_id = ? OR parent_thread_id = ?
      `).run(agentId, agentId);
      this.db.prepare('DELETE FROM subagent_execution_records WHERE agent_id = ?').run(agentId);
      this.db.exec('COMMIT;');
      this.deletedAgentIds.add(agentId);
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  /** Retires identities after the Thread catalog has committed their deletion. */
  retireAgents(agentIds: readonly ThreadId[]): void {
    const ids = [...new Set(agentIds)];
    for (const agentId of ids) this.deletedAgentIds.add(agentId);
    this.deleteAgents(ids);
  }

  deleteAgents(agentIds: readonly ThreadId[]): void {
    const ids = [...new Set(agentIds)];
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        DELETE FROM subagent_execution_notifications
        WHERE agent_id IN (${placeholders}) OR parent_thread_id IN (${placeholders})
      `).run(...ids, ...ids);
      this.db.prepare(`
        DELETE FROM subagent_execution_parent_messages
        WHERE sender_agent_id IN (${placeholders}) OR parent_thread_id IN (${placeholders})
      `).run(...ids, ...ids);
      this.db.prepare(`
        DELETE FROM subagent_execution_records
        WHERE agent_id IN (${placeholders})
      `).run(...ids);
      this.db.exec('COMMIT;');
      for (const agentId of ids) this.deletedAgentIds.add(agentId);
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  orphanExecutions(knownThreadIds: ReadonlySet<ThreadId>): readonly SubagentExecutionRecord[] {
    const executions = this.db.prepare(`
      SELECT * FROM subagent_execution_records ORDER BY created_at, agent_id
    `).all() as unknown as ExecutionRow[];
    return executions
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .filter((row) => !knownThreadIds.has(row.agent_id) || !knownThreadIds.has(row.parent_thread_id))
      .map(executionFromRow);
  }

  /** Removes envelopes whose execution or Thread endpoint no longer exists. */
  sweepOrphanEnvelopes(knownThreadIds: ReadonlySet<ThreadId>): number {
    const executions = this.db.prepare(`
      SELECT agent_id FROM subagent_execution_records
    `).all() as unknown as Array<{ agent_id: ThreadId }>;
    const executionAgentIds = new Set(executions.map((row) => row.agent_id));
    const notifications = this.db.prepare(`
      SELECT agent_id, generation, parent_thread_id FROM subagent_execution_notifications
    `).all() as unknown as Array<{
      agent_id: ThreadId;
      generation: number;
      parent_thread_id: ThreadId;
    }>;
    const orphanNotifications = notifications.filter((row) => (
        !executionAgentIds.has(row.agent_id)
        || !knownThreadIds.has(row.agent_id)
        || !knownThreadIds.has(row.parent_thread_id)
    ));
    const messages = this.db.prepare(`
      SELECT id, sender_agent_id, parent_thread_id FROM subagent_execution_parent_messages
    `).all() as unknown as Array<{
      id: string;
      sender_agent_id: ThreadId;
      parent_thread_id: ThreadId;
    }>;
    const orphanMessages = messages.filter((row) => (
        !executionAgentIds.has(row.sender_agent_id)
        || !knownThreadIds.has(row.sender_agent_id)
        || !knownThreadIds.has(row.parent_thread_id)
    ));
    if (orphanNotifications.length === 0 && orphanMessages.length === 0) return 0;
    const deleteNotification = this.db.prepare(`
      DELETE FROM subagent_execution_notifications WHERE agent_id = ? AND generation = ?
    `);
    const deleteMessage = this.db.prepare(`
      DELETE FROM subagent_execution_parent_messages WHERE id = ?
    `);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of orphanNotifications) deleteNotification.run(row.agent_id, row.generation);
      for (const row of orphanMessages) deleteMessage.run(row.id);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return orphanNotifications.length + orphanMessages.length;
  }
}

function executionFromRow(row: ExecutionRow): SubagentExecutionRecord {
  if (row.initial_admission_state !== 'pending' && row.initial_admission_state !== 'committed') {
    throw new Error('Invalid persisted Subagent initial admission state');
  }
  return {
    agentId: row.agent_id,
    parentThreadId: row.parent_thread_id,
    description: row.description,
    agentType: row.agent_type,
    runMode: row.run_mode as SubagentRunMode,
    generation: row.generation,
    currentTurnId: row.current_turn_id,
    toolUseId: row.tool_use_id,
    stopProvenance: row.stop_provenance as SubagentStopProvenance,
    worktree: row.worktree_json === null
      ? null
      : decodeWorktree(JSON.parse(row.worktree_json)),
    worktreeCleanupStartedAt: row.worktree_cleanup_started_at,
    toolPolicy: decodeToolPolicy(JSON.parse(row.tool_policy_json)),
    startupContext: row.startup_context_json === null
      ? null
      : decodeStartupContext(JSON.parse(row.startup_context_json)),
    initialAdmissionState: row.initial_admission_state,
    initialWorktreeIntent: row.initial_worktree_intent_json === null
      ? null
      : decodeWorktreeRecoveryIntent(JSON.parse(row.initial_worktree_intent_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeWorktree(value: unknown): AgentWorktreeMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted Subagent worktree metadata');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sourceCwd !== 'string'
    || typeof record.path !== 'string'
    || typeof record.baseCommit !== 'string'
    || typeof record.branch !== 'string'
    || typeof record.gitCommonDir !== 'string'
    || typeof record.gitWorktreeDir !== 'string'
    || record.managed !== true
    || (record.removedAt !== null && typeof record.removedAt !== 'number')
    || Object.keys(record).some((key) => ![
      'sourceCwd', 'path', 'baseCommit', 'branch', 'gitCommonDir',
      'gitWorktreeDir', 'managed', 'removedAt',
    ].includes(key))
  ) {
    throw new Error('Invalid persisted Subagent worktree metadata');
  }
  return {
    sourceCwd: record.sourceCwd,
    path: record.path,
    baseCommit: record.baseCommit,
    branch: record.branch,
    gitCommonDir: record.gitCommonDir,
    gitWorktreeDir: record.gitWorktreeDir,
    managed: true,
    removedAt: record.removedAt as number | null,
  };
}

function decodeWorktreeRecoveryIntent(value: unknown): AgentWorktreeRecoveryIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted Subagent initial worktree intent');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.sourceCwd !== 'string'
    || typeof record.path !== 'string'
    || typeof record.branch !== 'string'
    || typeof record.baseCommit !== 'string'
    || typeof record.gitCommonDir !== 'string'
    || Object.keys(record).some((key) => ![
      'sourceCwd', 'path', 'branch', 'baseCommit', 'gitCommonDir',
    ].includes(key))
  ) throw new Error('Invalid persisted Subagent initial worktree intent');
  return Object.freeze({
    sourceCwd: record.sourceCwd,
    path: record.path,
    branch: record.branch,
    baseCommit: record.baseCommit,
    gitCommonDir: record.gitCommonDir,
  });
}

function decodeGenerationSnapshot(value: string): SubagentGenerationSnapshot {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid persisted Subagent generation admission snapshot');
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.generation !== 'number'
    || !Number.isInteger(record.generation)
    || record.generation < 1
    || typeof record.currentTurnId !== 'string'
    || typeof record.toolUseId !== 'string'
    || !['foreground', 'background'].includes(String(record.runMode))
    || !['none', 'model', 'user', 'budget', 'hostRestart'].includes(String(record.stopProvenance))
    || (record.worktree !== null && typeof record.worktree !== 'object')
    || (record.worktreeCleanupStartedAt !== null && typeof record.worktreeCleanupStartedAt !== 'number')
    || typeof record.updatedAt !== 'number'
  ) throw new Error('Invalid persisted Subagent generation admission snapshot');
  return {
    generation: record.generation,
    currentTurnId: record.currentTurnId,
    toolUseId: record.toolUseId,
    runMode: record.runMode as SubagentRunMode,
    stopProvenance: record.stopProvenance as SubagentStopProvenance,
    worktree: record.worktree === null ? null : decodeWorktree(record.worktree),
    worktreeCleanupStartedAt: record.worktreeCleanupStartedAt as number | null,
    updatedAt: record.updatedAt,
  };
}

function encodeWorktree(worktree: AgentWorktreeMetadata | null): string | null {
  if (worktree === null) return null;
  return JSON.stringify({
    sourceCwd: worktree.sourceCwd,
    path: worktree.path,
    baseCommit: worktree.baseCommit,
    branch: worktree.branch,
    gitCommonDir: worktree.gitCommonDir,
    gitWorktreeDir: worktree.gitWorktreeDir,
    managed: worktree.managed,
    removedAt: worktree.removedAt,
  });
}

function notificationFromRow(row: NotificationRow): SubagentPendingNotification {
  return {
    agentId: row.agent_id,
    generation: row.generation,
    parentThreadId: row.parent_thread_id,
    turnId: row.turn_id,
    toolUseId: row.tool_use_id,
    status: row.status as SubagentTerminalStatus,
    state: row.state as SubagentNotificationState,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

function parentMessageFromRow(row: ParentMessageRow): SubagentParentMessage {
  return {
    id: row.id,
    senderAgentId: row.sender_agent_id,
    parentThreadId: row.parent_thread_id,
    generation: row.generation,
    content: row.content,
    deliveryMode: row.delivery_mode as SubagentRunMode,
    state: row.state as SubagentNotificationState,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

function decodeToolPolicy(value: unknown): SubagentRecordedToolPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted Subagent tool policy');
  }
  const record = value as Record<string, unknown>;
  const requestedTools = record.requestedTools;
  if (
    !['general-purpose', 'explore', 'plan', 'role'].includes(String(record.kind))
    || typeof record.runInBackground !== 'boolean'
    || typeof record.worktree !== 'boolean'
    || typeof record.allowNesting !== 'boolean'
    || (requestedTools !== null && (
      !Array.isArray(requestedTools) || requestedTools.some((entry) => typeof entry !== 'string')
    ))
  ) throw new Error('Invalid persisted Subagent tool policy');
  return {
    kind: record.kind as SubagentToolPolicy['kind'],
    runInBackground: record.runInBackground,
    worktree: record.worktree,
    allowNesting: record.allowNesting,
    requestedTools: requestedTools === null ? null : Object.freeze([...requestedTools]),
  };
}

function decodeStartupContext(value: unknown): AgentStartupContextSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted Agent startup context');
  }
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.repositoryInstructions)
    || record.repositoryInstructions.some((entry) => typeof entry !== 'string')
    || (record.gitStatus !== null && typeof record.gitStatus !== 'string')
  ) throw new Error('Invalid persisted Agent startup context');
  return {
    repositoryInstructions: Object.freeze([...record.repositoryInstructions]),
    gitStatus: record.gitStatus as string | null,
  };
}

function higherPriorityStop(
  current: SubagentStopProvenance,
  candidate: Exclude<SubagentStopProvenance, 'none'>,
): SubagentStopProvenance {
  const priority: Record<SubagentStopProvenance, number> = {
    none: 0,
    hostRestart: 1,
    budget: 2,
    model: 3,
    user: 4,
  };
  return priority[candidate] > priority[current] ? candidate : current;
}
