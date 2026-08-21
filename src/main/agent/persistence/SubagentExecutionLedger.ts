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
export type SubagentTerminalStatus = 'finished' | 'failed' | 'interrupted' | 'killed';
export type SubagentNotificationState = 'pending' | 'delivering' | 'delivered';
export type SubagentInitialAdmissionState = 'pending' | 'committed';
export type SubagentExecutionMode = 'ordinary' | 'exhaustedSettlement';
export type SubagentTerminalOrigin =
  | 'ordinary'
  | 'budgetInterrupted'
  | 'normalOvershoot'
  | 'providerFailure'
  | 'contextFailure'
  | 'hostFailure'
  | 'rendererStop'
  | 'taskStop'
  | 'hostRestart';
export type SubagentTerminalRouting = 'ordinary' | 'exhaustedSettlement' | 'closeWithoutProvider';
export type SubagentNotificationCutoff = 'open' | 'closing' | 'closed';
export type SubagentDeliveryClass = 'ordinary' | 'carryForward';
export type SubagentCoverageDisposition = 'full' | 'excerpted' | 'omitted';
export type SubagentDeliveryBatchKind = 'exhaustedSettlement' | 'explicitAdmission';
export type SubagentDeliveryBatchState =
  | 'prepared'
  | 'linked'
  | 'detachedForOverflow'
  | 'admissionFailed'
  | 'settled';

export interface SubagentSettlementCoverage {
  readonly origin: 'budgetInterrupted' | 'normalOvershoot' | 'explicitAdmission';
  readonly full: number;
  readonly excerpted: number;
  readonly omitted: number;
  readonly providerAttempted: boolean;
}

export interface SubagentTerminalError {
  readonly code: string;
  readonly messagePreview: string;
  readonly omittedBytes: number;
}

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
  /** Frozen once for this execution generation. */
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly budgetWarningIssued: boolean;
  readonly terminalOrigin: SubagentTerminalOrigin | null;
  readonly terminalRouting: SubagentTerminalRouting | null;
  readonly notificationCutoff: SubagentNotificationCutoff;
  /** Whether this generation may use its parent's ordinary idle continuation. */
  readonly notificationDeliveryClass: SubagentDeliveryClass;
  readonly executionMode: SubagentExecutionMode;
  readonly activeBatchId: string | null;
  readonly settlementCoverage: SubagentSettlementCoverage | null;
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
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly budgetWarningIssued: boolean;
  readonly terminalOrigin: SubagentTerminalOrigin | null;
  readonly terminalRouting: SubagentTerminalRouting | null;
  readonly notificationCutoff: SubagentNotificationCutoff;
  readonly notificationDeliveryClass: SubagentDeliveryClass;
  readonly executionMode: SubagentExecutionMode;
  readonly activeBatchId: string | null;
  readonly settlementCoverage: SubagentSettlementCoverage | null;
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
  readonly stopProvenance: SubagentStopProvenance;
  readonly error: SubagentTerminalError | null;
  /** Usage frozen from this generation, never read back from a later resume. */
  readonly tokensUsed: number;
  readonly settlementCoverage: SubagentSettlementCoverage | null;
  readonly state: SubagentNotificationState;
  /** Immutable first delivery Turn; projection resolves Retry aliases. */
  readonly deliveryTurnId: TurnId | null;
  readonly deliveryClass: SubagentDeliveryClass;
  readonly eligibleAfterGeneration: number | null;
  readonly batchId: string | null;
  readonly coverageDisposition: SubagentCoverageDisposition | null;
  readonly omittedBytes: number;
  readonly omittedTokens: number;
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

export interface SubagentDeliveryBatchMember {
  readonly ordinal: number;
  /** Whether this generation is linked to and consumed by the admitted Turn. */
  readonly claimed: boolean;
  readonly agentId: ThreadId;
  readonly generation: number;
  readonly turnId: TurnId;
  readonly status: SubagentTerminalStatus;
  readonly stopProvenance: SubagentStopProvenance;
  readonly tokensUsed: number;
  readonly errorCode: string | null;
  readonly sourceBytes: number;
  readonly sourceTokens: number;
  readonly disposition: SubagentCoverageDisposition;
  readonly omittedBytes: number;
  readonly omittedTokens: number;
  readonly nestedFull: number;
  readonly nestedExcerpted: number;
  readonly nestedOmitted: number;
}

export interface SubagentDeliveryBatch {
  readonly batchId: string;
  readonly parentAgentId: ThreadId;
  readonly parentGeneration: number;
  readonly kind: SubagentDeliveryBatchKind;
  readonly origin: SubagentSettlementCoverage['origin'];
  readonly state: SubagentDeliveryBatchState;
  readonly reservedTurnId: TurnId;
  /** Canonical host-authored user Item carrying an explicit-generation sidecar. */
  readonly sidecarItemId: string | null;
  readonly envelopeDigest: string;
  readonly providerAttempted: boolean;
  readonly members: readonly SubagentDeliveryBatchMember[];
  readonly createdAt: number;
  readonly updatedAt: number;
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
  token_budget: number | null;
  tokens_used: number;
  budget_warning_issued: number;
  terminal_origin: string | null;
  terminal_routing: string | null;
  notification_cutoff: string;
  notification_delivery_class: string;
  execution_mode: string;
  active_batch_id: string | null;
  settlement_coverage_json: string | null;
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
  stop_provenance: string;
  error_code: string | null;
  error_message_preview: string | null;
  error_omitted_bytes: number;
  tokens_used: number;
  settlement_coverage_json: string | null;
  state: string;
  delivery_turn_id: string | null;
  delivery_class: string;
  eligible_after_generation: number | null;
  batch_id: string | null;
  coverage_disposition: string | null;
  omitted_bytes: number;
  omitted_tokens: number;
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

interface DeliveryBatchRow {
  batch_id: string;
  parent_agent_id: string;
  parent_generation: number;
  kind: string;
  origin: string;
  state: string;
  reserved_turn_id: string;
  sidecar_item_id: string | null;
  envelope_digest: string;
  previous_turn_id: string;
  previous_cutoff: string;
  provider_attempted: number;
  created_at: number;
  updated_at: number;
}

interface DeliveryBatchMemberRow {
  batch_id: string;
  ordinal: number;
  claimed: number;
  agent_id: string;
  generation: number;
  turn_id: string;
  status: string;
  stop_provenance: string;
  tokens_used: number;
  error_code: string | null;
  source_bytes: number;
  source_tokens: number;
  disposition: string;
  omitted_bytes: number;
  omitted_tokens: number;
  nested_full: number;
  nested_excerpted: number;
  nested_omitted: number;
  previous_state: string;
  previous_delivery_class: string;
  previous_eligible_after_generation: number | null;
  previous_batch_id: string | null;
  previous_coverage_disposition: string | null;
  previous_omitted_bytes: number;
  previous_omitted_tokens: number;
}

type SubagentExecutionCreateInput = Omit<
  SubagentExecutionRecord,
  | 'generation'
  | 'stopProvenance'
  | 'tokensUsed'
  | 'budgetWarningIssued'
  | 'terminalOrigin'
  | 'terminalRouting'
  | 'notificationCutoff'
  | 'notificationDeliveryClass'
  | 'executionMode'
  | 'activeBatchId'
  | 'settlementCoverage'
  | 'worktreeCleanupStartedAt'
  | 'initialAdmissionState'
  | 'initialWorktreeIntent'
>;

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
      DROP TABLE IF EXISTS subagent_execution_records;
      DROP TABLE IF EXISTS subagent_execution_notifications;
      DROP TABLE IF EXISTS subagent_execution_parent_messages;
      CREATE TABLE IF NOT EXISTS subagent_execution_state (
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
        token_budget INTEGER CHECK (token_budget IS NULL OR token_budget > 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
        budget_warning_issued INTEGER NOT NULL DEFAULT 0 CHECK (budget_warning_issued IN (0, 1)),
        terminal_origin TEXT CHECK (terminal_origin IS NULL OR terminal_origin IN (
          'ordinary', 'budgetInterrupted', 'normalOvershoot', 'providerFailure',
          'contextFailure', 'hostFailure', 'rendererStop', 'taskStop', 'hostRestart'
        )),
        terminal_routing TEXT CHECK (terminal_routing IS NULL OR terminal_routing IN (
          'ordinary', 'exhaustedSettlement', 'closeWithoutProvider'
        )),
        notification_cutoff TEXT NOT NULL DEFAULT 'open' CHECK (
          notification_cutoff IN ('open', 'closing', 'closed')
        ),
        notification_delivery_class TEXT NOT NULL DEFAULT 'ordinary' CHECK (
          notification_delivery_class IN ('ordinary', 'carryForward')
        ),
        execution_mode TEXT NOT NULL DEFAULT 'ordinary' CHECK (
          execution_mode IN ('ordinary', 'exhaustedSettlement')
        ),
        active_batch_id TEXT,
        settlement_coverage_json TEXT,
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
      CREATE INDEX IF NOT EXISTS subagent_execution_state_parent_idx
        ON subagent_execution_state(parent_thread_id, created_at, agent_id);
      CREATE TABLE IF NOT EXISTS subagent_generation_notifications (
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        parent_thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('finished', 'failed', 'interrupted', 'killed')),
        stop_provenance TEXT NOT NULL CHECK (
          stop_provenance IN ('none', 'model', 'user', 'budget', 'hostRestart')
        ),
        error_code TEXT,
        error_message_preview TEXT,
        error_omitted_bytes INTEGER NOT NULL DEFAULT 0 CHECK (error_omitted_bytes >= 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
        settlement_coverage_json TEXT,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered')),
        delivery_turn_id TEXT,
        delivery_class TEXT NOT NULL DEFAULT 'ordinary' CHECK (
          delivery_class IN ('ordinary', 'carryForward')
        ),
        eligible_after_generation INTEGER CHECK (
          eligible_after_generation IS NULL OR eligible_after_generation > 0
        ),
        batch_id TEXT,
        coverage_disposition TEXT CHECK (
          coverage_disposition IS NULL OR coverage_disposition IN ('full', 'excerpted', 'omitted')
        ),
        omitted_bytes INTEGER NOT NULL DEFAULT 0 CHECK (omitted_bytes >= 0),
        omitted_tokens INTEGER NOT NULL DEFAULT 0 CHECK (omitted_tokens >= 0),
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        PRIMARY KEY(agent_id, generation)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_generation_notifications_pending_idx
        ON subagent_generation_notifications(parent_thread_id, state, created_at, agent_id, generation);
      CREATE TABLE IF NOT EXISTS subagent_parent_message_queue (
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
      CREATE INDEX IF NOT EXISTS subagent_parent_message_queue_pending_idx
        ON subagent_parent_message_queue(parent_thread_id, state, delivery_mode, sender_agent_id, generation, created_at, id);
      CREATE TABLE IF NOT EXISTS subagent_delivery_batches (
        batch_id TEXT PRIMARY KEY,
        parent_agent_id TEXT NOT NULL,
        parent_generation INTEGER NOT NULL CHECK (parent_generation > 0),
        kind TEXT NOT NULL CHECK (kind IN ('exhaustedSettlement', 'explicitAdmission')),
        origin TEXT NOT NULL CHECK (origin IN ('budgetInterrupted', 'normalOvershoot', 'explicitAdmission')),
        state TEXT NOT NULL CHECK (state IN (
          'prepared', 'linked', 'detachedForOverflow', 'admissionFailed', 'settled'
        )),
        reserved_turn_id TEXT NOT NULL,
        sidecar_item_id TEXT,
        envelope_digest TEXT NOT NULL,
        previous_turn_id TEXT NOT NULL,
        previous_cutoff TEXT NOT NULL CHECK (previous_cutoff IN ('open', 'closing', 'closed')),
        provider_attempted INTEGER NOT NULL DEFAULT 0 CHECK (provider_attempted IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS subagent_delivery_batches_turn_idx
        ON subagent_delivery_batches(parent_agent_id, reserved_turn_id);
      CREATE INDEX IF NOT EXISTS subagent_delivery_batches_recovery_idx
        ON subagent_delivery_batches(state, created_at, batch_id);
      CREATE TABLE IF NOT EXISTS subagent_delivery_batch_members (
        batch_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        claimed INTEGER NOT NULL CHECK (claimed IN (0, 1)),
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        turn_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('finished', 'failed', 'interrupted', 'killed')),
        stop_provenance TEXT NOT NULL CHECK (
          stop_provenance IN ('none', 'model', 'user', 'budget', 'hostRestart')
        ),
        tokens_used INTEGER NOT NULL CHECK (tokens_used >= 0),
        error_code TEXT,
        source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
        source_tokens INTEGER NOT NULL CHECK (source_tokens >= 0),
        disposition TEXT NOT NULL CHECK (disposition IN ('full', 'excerpted', 'omitted')),
        omitted_bytes INTEGER NOT NULL CHECK (omitted_bytes >= 0),
        omitted_tokens INTEGER NOT NULL CHECK (omitted_tokens >= 0),
        nested_full INTEGER NOT NULL CHECK (nested_full >= 0),
        nested_excerpted INTEGER NOT NULL CHECK (nested_excerpted >= 0),
        nested_omitted INTEGER NOT NULL CHECK (nested_omitted >= 0),
        previous_state TEXT NOT NULL CHECK (previous_state IN ('pending', 'delivering', 'delivered')),
        previous_delivery_class TEXT NOT NULL CHECK (previous_delivery_class IN ('ordinary', 'carryForward')),
        previous_eligible_after_generation INTEGER CHECK (
          previous_eligible_after_generation IS NULL OR previous_eligible_after_generation > 0
        ),
        previous_batch_id TEXT,
        previous_coverage_disposition TEXT CHECK (
          previous_coverage_disposition IS NULL
          OR previous_coverage_disposition IN ('full', 'excerpted', 'omitted')
        ),
        previous_omitted_bytes INTEGER NOT NULL CHECK (previous_omitted_bytes >= 0),
        previous_omitted_tokens INTEGER NOT NULL CHECK (previous_omitted_tokens >= 0),
        PRIMARY KEY(batch_id, ordinal),
        UNIQUE(batch_id, agent_id, generation)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_delivery_batch_members_identity_idx
        ON subagent_delivery_batch_members(agent_id, generation);
    `);
    // A process may die after claiming but before admitting the parent Turn.
    // Client-input idempotency makes replay safe, so claims are recoverable.
    this.db.prepare(`
      UPDATE subagent_generation_notifications
      SET state = 'pending'
      WHERE state = 'delivering' AND batch_id IS NULL
    `).run();
    this.db.prepare("UPDATE subagent_parent_message_queue SET state = 'pending' WHERE state = 'delivering'").run();
  }

  create(input: SubagentExecutionCreateInput): SubagentExecutionRecord {
    return this.insertExecution(input, 'committed', null);
  }

  beginInitialAdmission(input: SubagentExecutionCreateInput & {
    readonly initialWorktreeIntent: AgentWorktreeRecoveryIntent | null;
  }): SubagentExecutionRecord {
    return this.insertExecution(input, 'pending', input.initialWorktreeIntent);
  }

  private insertExecution(
    input: SubagentExecutionCreateInput,
    initialAdmissionState: SubagentInitialAdmissionState,
    initialWorktreeIntent: AgentWorktreeRecoveryIntent | null,
  ): SubagentExecutionRecord {
    nullablePositiveSafeInteger(input.tokenBudget, 'Subagent generation token budget');
    this.db.prepare(`
      INSERT INTO subagent_execution_state(
        agent_id, parent_thread_id, description, agent_type, run_mode, generation,
        current_turn_id, tool_use_id, stop_provenance, token_budget, tokens_used,
        budget_warning_issued, terminal_origin, terminal_routing,
        notification_cutoff, notification_delivery_class, execution_mode,
        active_batch_id, settlement_coverage_json, worktree_json,
        worktree_cleanup_started_at, tool_policy_json,
        startup_context_json, admission_previous_json, initial_admission_state,
        initial_worktree_intent_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, 1, ?, ?, 'none', ?, 0, 0, NULL, NULL,
        'open', 'ordinary', 'ordinary', NULL, NULL, ?, NULL, ?, ?, NULL, ?, ?, ?, ?
      )
    `).run(
      input.agentId,
      input.parentThreadId,
      input.description,
      input.agentType,
      input.runMode,
      input.currentTurnId,
      input.toolUseId,
      input.tokenBudget,
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
      SELECT * FROM subagent_execution_state
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
      UPDATE subagent_execution_state
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
      UPDATE subagent_execution_state
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
      UPDATE subagent_execution_state
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
    const row = this.db.prepare('SELECT * FROM subagent_execution_state WHERE agent_id = ?')
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
      SELECT * FROM subagent_execution_state
      WHERE parent_thread_id = ? ORDER BY created_at, agent_id
    `).all(parentThreadId) as unknown as ExecutionRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(executionFromRow);
  }

  all(): readonly SubagentExecutionRecord[] {
    const rows = this.db.prepare('SELECT * FROM subagent_execution_state ORDER BY created_at, agent_id')
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
    readonly tokenBudget: number | null;
    readonly notificationDeliveryClass?: SubagentDeliveryClass;
    readonly previous: SubagentGenerationSnapshot;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    if (
      input.previous.generation !== input.expectedGeneration
      || input.previous.currentTurnId !== input.expectedTurnId
    ) throw new Error('Subagent generation admission snapshot does not match its expected owner');
    nullablePositiveSafeInteger(input.tokenBudget, 'Subagent generation token budget');
    const result = this.db.prepare(`
      UPDATE subagent_execution_state
      SET generation = generation + 1, current_turn_id = ?, tool_use_id = ?,
          run_mode = ?, stop_provenance = 'none', token_budget = ?, tokens_used = 0,
          budget_warning_issued = 0, terminal_origin = NULL, terminal_routing = NULL,
          notification_cutoff = 'open', notification_delivery_class = ?, execution_mode = 'ordinary',
          active_batch_id = NULL, settlement_coverage_json = NULL,
          worktree_cleanup_started_at = NULL, admission_previous_json = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND stop_provenance <> 'user' AND worktree_cleanup_started_at IS NULL
    `).run(
      input.turnId,
      input.toolUseId,
      input.runMode,
      input.tokenBudget,
      input.notificationDeliveryClass ?? 'ordinary',
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
    readonly tokenBudget: number | null;
    readonly notificationDeliveryClass?: SubagentDeliveryClass;
    readonly previous: SubagentGenerationSnapshot;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    if (
      input.previous.generation !== input.expectedGeneration
      || input.previous.currentTurnId !== input.expectedTurnId
    ) throw new Error('Subagent generation admission snapshot does not match its expected owner');
    nullablePositiveSafeInteger(input.tokenBudget, 'Subagent generation token budget');
    const result = this.db.prepare(`
      UPDATE subagent_execution_state
      SET generation = generation + 1, current_turn_id = ?, stop_provenance = 'none',
          token_budget = ?, tokens_used = 0, budget_warning_issued = 0,
          terminal_origin = NULL, terminal_routing = NULL,
          notification_cutoff = 'open', notification_delivery_class = ?, execution_mode = 'ordinary',
          active_batch_id = NULL, settlement_coverage_json = NULL,
          worktree_cleanup_started_at = NULL, admission_previous_json = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND worktree_cleanup_started_at IS NULL
    `).run(
      input.turnId,
      input.tokenBudget,
      input.notificationDeliveryClass ?? 'ordinary',
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
      tokenBudget: record.tokenBudget,
      tokensUsed: record.tokensUsed,
      budgetWarningIssued: record.budgetWarningIssued,
      terminalOrigin: record.terminalOrigin,
      terminalRouting: record.terminalRouting,
      notificationCutoff: record.notificationCutoff,
      notificationDeliveryClass: record.notificationDeliveryClass,
      executionMode: record.executionMode,
      activeBatchId: record.activeBatchId,
      settlementCoverage: record.settlementCoverage,
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
      UPDATE subagent_execution_state
      SET generation = ?, current_turn_id = ?, tool_use_id = ?, run_mode = ?,
          stop_provenance = ?, token_budget = ?, tokens_used = ?,
          budget_warning_issued = ?, terminal_origin = ?, terminal_routing = ?,
          notification_cutoff = ?, notification_delivery_class = ?, execution_mode = ?,
          settlement_coverage_json = ?,
          active_batch_id = ?,
          worktree_cleanup_started_at = ?,
          admission_previous_json = NULL, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND admission_previous_json IS NOT NULL
    `).run(
      snapshot.generation,
      snapshot.currentTurnId,
      snapshot.toolUseId,
      snapshot.runMode,
      snapshot.stopProvenance,
      snapshot.tokenBudget,
      snapshot.tokensUsed,
      snapshot.budgetWarningIssued ? 1 : 0,
      snapshot.terminalOrigin,
      snapshot.terminalRouting,
      snapshot.notificationCutoff,
      snapshot.notificationDeliveryClass,
      snapshot.executionMode,
      encodeSettlementCoverage(snapshot.settlementCoverage),
      snapshot.activeBatchId,
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
      SELECT * FROM subagent_execution_state
      WHERE admission_previous_json IS NOT NULL ORDER BY created_at, agent_id
    `).all() as unknown as ExecutionRow[];
    return rows.map((row) => ({
      execution: executionFromRow(row),
      previous: decodeGenerationSnapshot(row.admission_previous_json!),
    }));
  }

  hasPendingGenerationAdmissionForParent(parentThreadId: ThreadId): boolean {
    const row = this.db.prepare(`
      SELECT agent_id FROM subagent_execution_state
      WHERE parent_thread_id = ? AND admission_previous_json IS NOT NULL
      LIMIT 1
    `).get(parentThreadId) as { agent_id: ThreadId } | undefined;
    return Boolean(row && !this.deletedAgentIds.has(row.agent_id));
  }

  completeGenerationAdmissionIfCurrent(
    agentId: ThreadId,
    generation: number,
    turnId: TurnId,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_execution_state SET admission_previous_json = NULL
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
      SELECT admission_previous_json FROM subagent_execution_state
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
      UPDATE subagent_execution_state SET current_turn_id = ?, updated_at = ?
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
      UPDATE subagent_execution_state SET current_turn_id = ?, updated_at = ?
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
      UPDATE subagent_execution_state SET stop_provenance = ?, updated_at = ? WHERE agent_id = ?
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
      UPDATE subagent_execution_state
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

  setSettlementStopProvenanceIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly turnId: TurnId;
    readonly provenance: SubagentStopProvenance;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const result = this.db.prepare(`
      UPDATE subagent_execution_state
      SET stop_provenance = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND execution_mode = 'exhaustedSettlement'
    `).run(
      input.provenance,
      input.updatedAt,
      input.agentId,
      input.generation,
      input.turnId,
    );
    return Number(result.changes) === 1 ? this.touched(input.agentId) : null;
  }

  clearUserStop(agentId: ThreadId, updatedAt: number): SubagentExecutionRecord {
    this.db.prepare(`
      UPDATE subagent_execution_state SET stop_provenance = 'none', updated_at = ?
      WHERE agent_id = ? AND stop_provenance = 'user'
    `).run(updatedAt, agentId);
    return this.touched(agentId);
  }

  addGenerationUsageIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly tokens: number;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    nonNegativeSafeInteger(input.tokens, 'Subagent generation token usage');
    const current = this.read(input.agentId);
    if (!current || current.generation !== input.generation) return null;
    const tokensUsed = checkedTotal(current.tokensUsed, input.tokens);
    const result = this.db.prepare(`
      UPDATE subagent_execution_state SET tokens_used = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND tokens_used = ?
    `).run(tokensUsed, input.updatedAt, input.agentId, input.generation, current.tokensUsed);
    return Number(result.changes) === 1 ? this.touched(input.agentId) : null;
  }

  markBudgetWarningIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly updatedAt: number;
  }): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_execution_state
      SET budget_warning_issued = 1, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND budget_warning_issued = 0
    `).run(input.updatedAt, input.agentId, input.generation);
    if (Number(result.changes) !== 1) return false;
    this.announce(input.agentId);
    return true;
  }

  recordTerminalRoutingIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly turnId: TurnId;
    readonly origin: SubagentTerminalOrigin;
    readonly routing: SubagentTerminalRouting;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const cutoff: SubagentNotificationCutoff = input.routing === 'ordinary' ? 'open' : 'closing';
    const result = this.db.prepare(`
      UPDATE subagent_execution_state
      SET terminal_origin = ?, terminal_routing = ?, notification_cutoff = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND terminal_origin IS NULL AND terminal_routing IS NULL
    `).run(
      input.origin,
      input.routing,
      cutoff,
      input.updatedAt,
      input.agentId,
      input.generation,
      input.turnId,
    );
    if (Number(result.changes) === 1) return this.touched(input.agentId);
    const current = this.read(input.agentId);
    if (
      current?.generation === input.generation
      && current.currentTurnId === input.turnId
      && current.terminalOrigin === input.origin
      && current.terminalRouting === input.routing
    ) return current;
    return null;
  }

  closeNotificationCutoffIfCurrent(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const result = this.db.prepare(`
      UPDATE subagent_execution_state
      SET notification_cutoff = 'closed', updated_at = ?
      WHERE agent_id = ? AND generation = ? AND notification_cutoff = 'closing'
    `).run(input.updatedAt, input.agentId, input.generation);
    return Number(result.changes) === 1 ? this.touched(input.agentId) : null;
  }

  pendingOrdinaryForParent(parentThreadId: ThreadId): readonly SubagentPendingNotification[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_generation_notifications
      WHERE parent_thread_id = ? AND state = 'pending'
        AND delivery_class = 'ordinary' AND batch_id IS NULL
      ORDER BY created_at, agent_id, generation
    `).all(parentThreadId) as unknown as NotificationRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(notificationFromRow);
  }

  eligibleCarryForwardForParent(
    parentThreadId: ThreadId,
    generation: number,
  ): readonly SubagentPendingNotification[] {
    positiveSafeInteger(generation, 'Subagent parent generation');
    const rows = this.db.prepare(`
      SELECT * FROM subagent_generation_notifications
      WHERE parent_thread_id = ? AND state = 'pending'
        AND delivery_class = 'carryForward' AND batch_id IS NULL
        AND eligible_after_generation IS NOT NULL
        AND eligible_after_generation < ?
      ORDER BY created_at, agent_id, generation
    `).all(parentThreadId, generation) as unknown as NotificationRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(notificationFromRow);
  }

  /**
   * Snapshot considered by an explicit parent generation while its gate is
   * held. Ordinary rows will cross the old generation cutoff in the prepare
   * transaction; already-carried rows retain their original eligibility.
   */
  pendingForExplicitAdmission(
    parentThreadId: ThreadId,
    generation: number,
  ): readonly SubagentPendingNotification[] {
    positiveSafeInteger(generation, 'Subagent parent generation');
    const rows = this.db.prepare(`
      SELECT * FROM subagent_generation_notifications
      WHERE parent_thread_id = ? AND state = 'pending' AND batch_id IS NULL
        AND (
          delivery_class = 'ordinary'
          OR (
            delivery_class = 'carryForward'
            AND eligible_after_generation IS NOT NULL
            AND eligible_after_generation < ?
          )
        )
      ORDER BY created_at, agent_id, generation
    `).all(parentThreadId, generation) as unknown as NotificationRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(notificationFromRow);
  }

  hasDeliveringNotificationForParent(parentThreadId: ThreadId): boolean {
    const rows = this.db.prepare(`
      SELECT agent_id FROM subagent_generation_notifications
      WHERE parent_thread_id = ? AND state = 'delivering'
    `).all(parentThreadId) as unknown as Array<{ agent_id: ThreadId }>;
    return rows.some((row) => !this.deletedAgentIds.has(row.agent_id));
  }

  closeCutoffWithoutProvider(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    this.db.exec('BEGIN IMMEDIATE;');
    const changedAgents: ThreadId[] = [];
    try {
      const execution = this.read(input.agentId);
      if (
        !execution
        || execution.generation !== input.generation
        || execution.terminalRouting !== 'closeWithoutProvider'
        || execution.notificationCutoff !== 'closing'
      ) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      const rows = this.db.prepare(`
        SELECT agent_id FROM subagent_generation_notifications
        WHERE parent_thread_id = ? AND state = 'pending'
          AND delivery_class = 'ordinary' AND batch_id IS NULL
      `).all(input.agentId) as unknown as Array<{ agent_id: ThreadId }>;
      this.db.prepare(`
        UPDATE subagent_generation_notifications
        SET delivery_class = 'carryForward', eligible_after_generation = ?
        WHERE parent_thread_id = ? AND state = 'pending'
          AND delivery_class = 'ordinary' AND batch_id IS NULL
      `).run(input.generation, input.agentId);
      const result = this.db.prepare(`
        UPDATE subagent_execution_state
        SET notification_cutoff = 'closed', updated_at = ?
        WHERE agent_id = ? AND generation = ?
          AND terminal_routing = 'closeWithoutProvider'
          AND notification_cutoff = 'closing'
      `).run(input.updatedAt, input.agentId, input.generation);
      if (Number(result.changes) !== 1) throw new Error('Subagent cutoff close raced');
      changedAgents.push(...rows.map((row) => row.agent_id));
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    for (const agentId of changedAgents) this.announce(agentId);
    return this.touched(input.agentId);
  }

  closeEmptyExhaustedCutoff(input: {
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly updatedAt: number;
  }): SubagentExecutionRecord | null {
    const pending = this.pendingOrdinaryForParent(input.agentId);
    if (pending.length > 0 || this.hasDeliveringNotificationForParent(input.agentId)) return null;
    const result = this.db.prepare(`
      UPDATE subagent_execution_state
      SET notification_cutoff = 'closed', updated_at = ?
      WHERE agent_id = ? AND generation = ?
        AND terminal_routing = 'exhaustedSettlement'
        AND notification_cutoff IN ('closing', 'closed') AND active_batch_id IS NULL
    `).run(input.updatedAt, input.agentId, input.generation);
    return Number(result.changes) === 1 ? this.touched(input.agentId) : null;
  }

  prepareExhaustedSettlementBatch(input: {
    readonly batchId: string;
    readonly agentId: ThreadId;
    readonly generation: number;
    readonly expectedTurnId: TurnId;
    readonly reservedTurnId: TurnId;
    readonly envelopeDigest: string;
    readonly origin: Extract<SubagentSettlementCoverage['origin'], 'budgetInterrupted' | 'normalOvershoot'>;
    readonly members: readonly SubagentDeliveryBatchMember[];
    readonly createdAt: number;
  }): SubagentDeliveryBatch | null {
    assertBatchIdentity(input.batchId, input.envelopeDigest);
    if (input.members.length === 0) throw new Error('Exhausted settlement batch must not be empty');
    validateBatchMembers(input.members);
    if (input.members.some((member) => !member.claimed)) {
      throw new Error('Exhausted settlement must claim every cutoff member');
    }
    this.db.exec('BEGIN IMMEDIATE;');
    const changedAgents: ThreadId[] = [];
    try {
      const execution = this.read(input.agentId);
      if (
        !execution
        || execution.generation !== input.generation
        || execution.currentTurnId !== input.expectedTurnId
        || execution.terminalOrigin !== input.origin
        || execution.terminalRouting !== 'exhaustedSettlement'
        || !['closing', 'closed'].includes(execution.notificationCutoff)
        || execution.activeBatchId !== null
      ) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      const pending = this.db.prepare(`
        SELECT * FROM subagent_generation_notifications
        WHERE parent_thread_id = ? AND state = 'pending'
          AND delivery_class = 'ordinary' AND batch_id IS NULL
        ORDER BY created_at, agent_id, generation
      `).all(input.agentId) as unknown as NotificationRow[];
      if (!sameNotificationIdentities(pending, input.members)) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      this.db.prepare(`
        INSERT INTO subagent_delivery_batches(
          batch_id, parent_agent_id, parent_generation, kind, origin, state,
          reserved_turn_id, sidecar_item_id, envelope_digest, previous_turn_id, previous_cutoff,
          provider_attempted, created_at, updated_at
        ) VALUES (?, ?, ?, 'exhaustedSettlement', ?, 'prepared', ?, NULL, ?, ?, ?, 0, ?, ?)
      `).run(
        input.batchId,
        input.agentId,
        input.generation,
        input.origin,
        input.reservedTurnId,
        input.envelopeDigest,
        input.expectedTurnId,
        execution.notificationCutoff,
        input.createdAt,
        input.createdAt,
      );
      const insertMember = this.db.prepare(`
        INSERT INTO subagent_delivery_batch_members(
          batch_id, ordinal, claimed, agent_id, generation, turn_id, status,
          stop_provenance, tokens_used, error_code, source_bytes, source_tokens,
          disposition, omitted_bytes, omitted_tokens, nested_full,
          nested_excerpted, nested_omitted, previous_state,
          previous_delivery_class, previous_eligible_after_generation,
          previous_batch_id, previous_coverage_disposition,
          previous_omitted_bytes, previous_omitted_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateNotification = this.db.prepare(`
        UPDATE subagent_generation_notifications
        SET state = 'delivering', batch_id = ?, coverage_disposition = ?,
            omitted_bytes = ?, omitted_tokens = ?
        WHERE agent_id = ? AND generation = ? AND turn_id = ?
          AND parent_thread_id = ? AND state = 'pending'
          AND delivery_class = 'ordinary' AND batch_id IS NULL
      `);
      for (const member of input.members) {
        const previous = pending.find((row) => (
          row.agent_id === member.agentId && row.generation === member.generation
        ));
        if (!previous) throw new Error('Subagent batch member disappeared during prepare');
        assertBatchMemberMatchesNotification(member, previous);
        insertMember.run(
          input.batchId,
          member.ordinal,
          member.claimed ? 1 : 0,
          member.agentId,
          member.generation,
          member.turnId,
          member.status,
          member.stopProvenance,
          member.tokensUsed,
          member.errorCode,
          member.sourceBytes,
          member.sourceTokens,
          member.disposition,
          member.omittedBytes,
          member.omittedTokens,
          member.nestedFull,
          member.nestedExcerpted,
          member.nestedOmitted,
          previous.state,
          previous.delivery_class,
          previous.eligible_after_generation,
          previous.batch_id,
          previous.coverage_disposition,
          previous.omitted_bytes,
          previous.omitted_tokens,
        );
        const updated = updateNotification.run(
          input.batchId,
          member.disposition,
          member.omittedBytes,
          member.omittedTokens,
          member.agentId,
          member.generation,
          member.turnId,
          input.agentId,
        );
        if (Number(updated.changes) !== 1) throw new Error('Subagent batch notification claim raced');
        changedAgents.push(member.agentId);
      }
      const executionUpdate = this.db.prepare(`
        UPDATE subagent_execution_state
        SET current_turn_id = ?, notification_cutoff = 'closed',
            execution_mode = 'exhaustedSettlement', active_batch_id = ?, updated_at = ?
        WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
          AND notification_cutoff IN ('closing', 'closed') AND active_batch_id IS NULL
      `).run(
        input.reservedTurnId,
        input.batchId,
        input.createdAt,
        input.agentId,
        input.generation,
        input.expectedTurnId,
      );
      if (Number(executionUpdate.changes) !== 1) throw new Error('Subagent batch execution prepare raced');
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    for (const agentId of changedAgents) this.announce(agentId);
    this.announce(input.agentId);
    return this.readDeliveryBatch(input.batchId);
  }

  prepareExplicitGenerationBatch(input: {
    readonly batchId: string;
    readonly agentId: ThreadId;
    readonly expectedGeneration: number;
    readonly expectedTurnId: TurnId;
    readonly reservedTurnId: TurnId;
    readonly sidecarItemId: string | null;
    readonly envelopeDigest: string;
    readonly toolUseId: string;
    readonly runMode: SubagentRunMode;
    readonly tokenBudget: number | null;
    readonly notificationDeliveryClass: SubagentDeliveryClass;
    readonly allowUserStoppedGeneration: boolean;
    readonly previous: SubagentGenerationSnapshot;
    readonly members: readonly SubagentDeliveryBatchMember[];
    readonly createdAt: number;
  }): SubagentDeliveryBatch | null {
    assertBatchIdentity(input.batchId, input.envelopeDigest);
    validateBatchMembers(input.members);
    nullablePositiveSafeInteger(input.tokenBudget, 'Subagent generation token budget');
    if (
      input.previous.generation !== input.expectedGeneration
      || input.previous.currentTurnId !== input.expectedTurnId
    ) throw new Error('Subagent explicit admission snapshot does not match its expected owner');
    const nextGeneration = input.expectedGeneration + 1;
    positiveSafeInteger(nextGeneration, 'Subagent explicit generation');
    this.db.exec('BEGIN IMMEDIATE;');
    const changedAgents: ThreadId[] = [];
    try {
      const execution = this.read(input.agentId);
      if (
        !execution
        || execution.generation !== input.expectedGeneration
        || execution.currentTurnId !== input.expectedTurnId
        || execution.executionMode !== 'ordinary'
        || execution.activeBatchId !== null
        || execution.terminalOrigin === null
        || execution.terminalRouting === null
        || execution.worktreeCleanupStartedAt !== null
        || (!input.allowUserStoppedGeneration && execution.stopProvenance === 'user')
      ) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      const terminal = this.db.prepare(`
        SELECT agent_id FROM subagent_generation_notifications
        WHERE agent_id = ? AND generation = ? AND turn_id = ?
      `).get(input.agentId, input.expectedGeneration, input.expectedTurnId);
      if (!terminal) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      const candidates = this.db.prepare(`
        SELECT * FROM subagent_generation_notifications
        WHERE parent_thread_id = ? AND state = 'pending' AND batch_id IS NULL
          AND (
            delivery_class = 'ordinary'
            OR (
              delivery_class = 'carryForward'
              AND eligible_after_generation IS NOT NULL
              AND eligible_after_generation < ?
            )
          )
        ORDER BY created_at, agent_id, generation
      `).all(input.agentId, nextGeneration) as unknown as NotificationRow[];
      if (!sameNotificationIdentities(candidates, input.members)) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      this.db.prepare(`
        INSERT INTO subagent_delivery_batches(
          batch_id, parent_agent_id, parent_generation, kind, origin, state,
          reserved_turn_id, sidecar_item_id, envelope_digest, previous_turn_id, previous_cutoff,
          provider_attempted, created_at, updated_at
        ) VALUES (?, ?, ?, 'explicitAdmission', 'explicitAdmission', 'prepared',
          ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        input.batchId,
        input.agentId,
        nextGeneration,
        input.reservedTurnId,
        input.sidecarItemId,
        input.envelopeDigest,
        input.expectedTurnId,
        execution.notificationCutoff,
        input.createdAt,
        input.createdAt,
      );
      const insertMember = this.db.prepare(`
        INSERT INTO subagent_delivery_batch_members(
          batch_id, ordinal, claimed, agent_id, generation, turn_id, status,
          stop_provenance, tokens_used, error_code, source_bytes, source_tokens,
          disposition, omitted_bytes, omitted_tokens, nested_full,
          nested_excerpted, nested_omitted, previous_state,
          previous_delivery_class, previous_eligible_after_generation,
          previous_batch_id, previous_coverage_disposition,
          previous_omitted_bytes, previous_omitted_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const updateNotification = this.db.prepare(`
        UPDATE subagent_generation_notifications
        SET state = ?, delivery_class = 'carryForward',
            eligible_after_generation = ?, batch_id = ?, coverage_disposition = ?,
            omitted_bytes = ?, omitted_tokens = ?
        WHERE agent_id = ? AND generation = ? AND turn_id = ?
          AND parent_thread_id = ? AND state = ? AND delivery_class = ?
          AND eligible_after_generation IS ? AND batch_id IS NULL
      `);
      for (const member of input.members) {
        const previous = candidates.find((row) => (
          row.agent_id === member.agentId && row.generation === member.generation
        ));
        if (!previous) throw new Error('Subagent explicit batch member disappeared during prepare');
        assertBatchMemberMatchesNotification(member, previous);
        insertMember.run(
          input.batchId,
          member.ordinal,
          member.claimed ? 1 : 0,
          member.agentId,
          member.generation,
          member.turnId,
          member.status,
          member.stopProvenance,
          member.tokensUsed,
          member.errorCode,
          member.sourceBytes,
          member.sourceTokens,
          member.disposition,
          member.omittedBytes,
          member.omittedTokens,
          member.nestedFull,
          member.nestedExcerpted,
          member.nestedOmitted,
          previous.state,
          previous.delivery_class,
          previous.eligible_after_generation,
          previous.batch_id,
          previous.coverage_disposition,
          previous.omitted_bytes,
          previous.omitted_tokens,
        );
        const eligibleAfter = previous.delivery_class === 'ordinary'
          ? input.expectedGeneration
          : previous.eligible_after_generation;
        const updated = updateNotification.run(
          member.claimed ? 'delivering' : 'pending',
          eligibleAfter,
          member.claimed ? input.batchId : null,
          member.claimed ? member.disposition : null,
          member.claimed ? member.omittedBytes : 0,
          member.claimed ? member.omittedTokens : 0,
          member.agentId,
          member.generation,
          member.turnId,
          input.agentId,
          previous.state,
          previous.delivery_class,
          previous.eligible_after_generation,
        );
        if (Number(updated.changes) !== 1) {
          throw new Error('Subagent explicit notification classification raced');
        }
        changedAgents.push(member.agentId);
      }
      const executionUpdate = this.db.prepare(`
        UPDATE subagent_execution_state
        SET generation = generation + 1, current_turn_id = ?, tool_use_id = ?,
            run_mode = ?, stop_provenance = 'none', token_budget = ?, tokens_used = 0,
            budget_warning_issued = 0, terminal_origin = NULL, terminal_routing = NULL,
            notification_cutoff = 'open', notification_delivery_class = ?,
            execution_mode = 'ordinary', active_batch_id = ?,
            settlement_coverage_json = NULL, worktree_cleanup_started_at = NULL,
            admission_previous_json = ?, updated_at = ?
        WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
          AND execution_mode = 'ordinary' AND active_batch_id IS NULL
          AND admission_previous_json IS NULL AND worktree_cleanup_started_at IS NULL
          AND (? = 1 OR stop_provenance <> 'user')
      `).run(
        input.reservedTurnId,
        input.toolUseId,
        input.runMode,
        input.tokenBudget,
        input.notificationDeliveryClass,
        input.batchId,
        JSON.stringify(input.previous),
        input.createdAt,
        input.agentId,
        input.expectedGeneration,
        input.expectedTurnId,
        input.allowUserStoppedGeneration ? 1 : 0,
      );
      if (Number(executionUpdate.changes) !== 1) {
        throw new Error('Subagent explicit generation prepare raced');
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    for (const agentId of changedAgents) this.announce(agentId);
    this.announce(input.agentId);
    return this.readDeliveryBatch(input.batchId);
  }

  readDeliveryBatch(batchId: string): SubagentDeliveryBatch | null {
    const row = this.db.prepare(`
      SELECT * FROM subagent_delivery_batches WHERE batch_id = ?
    `).get(batchId) as DeliveryBatchRow | undefined;
    if (!row) return null;
    const members = this.db.prepare(`
      SELECT * FROM subagent_delivery_batch_members
      WHERE batch_id = ? ORDER BY ordinal
    `).all(batchId) as unknown as DeliveryBatchMemberRow[];
    return deliveryBatchFromRows(row, members);
  }

  deliveryBatchForTurn(parentAgentId: ThreadId, turnId: TurnId): SubagentDeliveryBatch | null {
    const row = this.db.prepare(`
      SELECT batch_id FROM subagent_delivery_batches
      WHERE parent_agent_id = ? AND reserved_turn_id = ?
    `).get(parentAgentId, turnId) as { batch_id: string } | undefined;
    return row ? this.readDeliveryBatch(row.batch_id) : null;
  }

  preparedDeliveryBatches(): readonly SubagentDeliveryBatch[] {
    const rows = this.db.prepare(`
      SELECT batch_id FROM subagent_delivery_batches
      WHERE state = 'prepared' ORDER BY created_at, batch_id
    `).all() as unknown as Array<{ batch_id: string }>;
    return rows.map((row) => this.readDeliveryBatch(row.batch_id)).filter((batch): batch is SubagentDeliveryBatch => Boolean(batch));
  }

  linkPreparedDeliveryBatch(input: {
    readonly batchId: string;
    readonly parentAgentId: ThreadId;
    readonly reservedTurnId: TurnId;
    readonly envelopeDigest: string;
    readonly updatedAt: number;
  }): SubagentDeliveryBatch | null {
    this.db.exec('BEGIN IMMEDIATE;');
    let memberIds: ThreadId[] = [];
    try {
      const result = this.db.prepare(`
        UPDATE subagent_delivery_batches
        SET state = 'linked', updated_at = ?
        WHERE batch_id = ? AND parent_agent_id = ? AND reserved_turn_id = ?
          AND envelope_digest = ? AND state = 'prepared'
      `).run(
        input.updatedAt,
        input.batchId,
        input.parentAgentId,
        input.reservedTurnId,
        input.envelopeDigest,
      );
      if (Number(result.changes) !== 1) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      const rows = this.db.prepare(`
        SELECT agent_id, generation, claimed
        FROM subagent_delivery_batch_members WHERE batch_id = ?
      `).all(input.batchId) as unknown as Array<{
        agent_id: ThreadId;
        generation: number;
        claimed: number;
      }>;
      const link = this.db.prepare(`
        UPDATE subagent_generation_notifications
        SET delivery_turn_id = COALESCE(delivery_turn_id, ?)
        WHERE agent_id = ? AND generation = ? AND batch_id = ? AND state = 'delivering'
      `);
      for (const row of rows) {
        if (row.claimed === 0) continue;
        if (Number(link.run(
          input.reservedTurnId,
          row.agent_id,
          row.generation,
          input.batchId,
        ).changes) !== 1) throw new Error('Subagent batch member link raced');
      }
      const batch = this.db.prepare(`
        SELECT kind, parent_generation FROM subagent_delivery_batches WHERE batch_id = ?
      `).get(input.batchId) as Pick<DeliveryBatchRow, 'kind' | 'parent_generation'> | undefined;
      if (batch?.kind === 'explicitAdmission') {
        const finalized = this.db.prepare(`
          UPDATE subagent_execution_state
          SET admission_previous_json = NULL
          WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
            AND active_batch_id = ? AND admission_previous_json IS NOT NULL
        `).run(
          input.parentAgentId,
          batch.parent_generation,
          input.reservedTurnId,
          input.batchId,
        );
        if (Number(finalized.changes) !== 1) {
          throw new Error('Subagent explicit generation finalization raced');
        }
      }
      memberIds = rows.map((row) => row.agent_id);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    for (const agentId of memberIds) this.announce(agentId);
    return this.readDeliveryBatch(input.batchId);
  }

  markDeliveryBatchProviderAttempted(batchId: string, updatedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_delivery_batches
      SET provider_attempted = 1, updated_at = ?
      WHERE batch_id = ? AND state = 'linked' AND provider_attempted = 0
    `).run(updatedAt, batchId);
    return Number(result.changes) === 1;
  }

  detachExplicitBatchForOverflow(input: {
    readonly batchId: string;
    readonly parentAgentId: ThreadId;
    readonly reservedTurnId: TurnId;
    readonly updatedAt: number;
  }): SubagentDeliveryBatch | null {
    this.db.exec('BEGIN IMMEDIATE;');
    let memberIds: ThreadId[] = [];
    try {
      const row = this.db.prepare(`
        SELECT * FROM subagent_delivery_batches
        WHERE batch_id = ? AND parent_agent_id = ? AND reserved_turn_id = ?
          AND kind = 'explicitAdmission' AND state = 'linked'
          AND provider_attempted = 1 AND sidecar_item_id IS NOT NULL
      `).get(
        input.batchId,
        input.parentAgentId,
        input.reservedTurnId,
      ) as DeliveryBatchRow | undefined;
      if (!row) {
        this.db.exec('ROLLBACK;');
        return null;
      }
      const members = this.db.prepare(`
        SELECT * FROM subagent_delivery_batch_members WHERE batch_id = ? ORDER BY ordinal
      `).all(input.batchId) as unknown as DeliveryBatchMemberRow[];
      const release = this.db.prepare(`
        UPDATE subagent_generation_notifications
        SET state = 'pending', delivery_turn_id = NULL, batch_id = NULL,
            coverage_disposition = NULL, omitted_bytes = 0, omitted_tokens = 0
        WHERE agent_id = ? AND generation = ? AND batch_id = ? AND state = 'delivering'
      `);
      for (const member of members) {
        if (member.claimed === 0) continue;
        if (Number(release.run(
          member.agent_id,
          member.generation,
          input.batchId,
        ).changes) !== 1) throw new Error('Subagent overflow detach member release raced');
      }
      const coverage: SubagentSettlementCoverage = {
        origin: 'explicitAdmission',
        full: 0,
        excerpted: 0,
        omitted: members.length,
        providerAttempted: true,
      };
      const execution = this.db.prepare(`
        UPDATE subagent_execution_state
        SET active_batch_id = NULL, settlement_coverage_json = ?, updated_at = ?
        WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
          AND active_batch_id = ?
      `).run(
        encodeSettlementCoverage(coverage),
        input.updatedAt,
        input.parentAgentId,
        row.parent_generation,
        input.reservedTurnId,
        input.batchId,
      );
      if (Number(execution.changes) !== 1) {
        throw new Error('Subagent overflow detach execution raced');
      }
      const detached = this.db.prepare(`
        UPDATE subagent_delivery_batches
        SET state = 'detachedForOverflow', updated_at = ?
        WHERE batch_id = ? AND state = 'linked'
      `).run(input.updatedAt, input.batchId);
      if (Number(detached.changes) !== 1) throw new Error('Subagent overflow detach batch raced');
      memberIds = members.map((member) => member.agent_id);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    for (const agentId of memberIds) this.announce(agentId);
    this.announce(input.parentAgentId);
    return this.readDeliveryBatch(input.batchId);
  }

  rollbackPreparedDeliveryBatch(batchId: string, updatedAt: number): boolean {
    this.db.exec('BEGIN IMMEDIATE;');
    let parentAgentId: ThreadId | null = null;
    let memberIds: ThreadId[] = [];
    try {
      const row = this.db.prepare(`
        SELECT * FROM subagent_delivery_batches WHERE batch_id = ? AND state = 'prepared'
      `).get(batchId) as DeliveryBatchRow | undefined;
      if (!row) {
        this.db.exec('ROLLBACK;');
        return false;
      }
      const members = this.db.prepare(`
        SELECT * FROM subagent_delivery_batch_members WHERE batch_id = ? ORDER BY ordinal
      `).all(batchId) as unknown as DeliveryBatchMemberRow[];
      restoreBatchNotifications(this.db, members, batchId);
      const execution = row.kind === 'explicitAdmission'
        ? this.restorePreparedExplicitGeneration(row, updatedAt)
        : this.db.prepare(`
            UPDATE subagent_execution_state
            SET current_turn_id = ?, notification_cutoff = 'closed',
                execution_mode = 'ordinary', active_batch_id = NULL, updated_at = ?
            WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
              AND active_batch_id = ?
          `).run(
            row.previous_turn_id,
            updatedAt,
            row.parent_agent_id,
            row.parent_generation,
            row.reserved_turn_id,
            batchId,
          );
      if (Number(execution.changes) !== 1) throw new Error('Subagent prepared batch rollback raced');
      this.db.prepare(`
        UPDATE subagent_delivery_batches SET state = 'admissionFailed', updated_at = ?
        WHERE batch_id = ? AND state = 'prepared'
      `).run(updatedAt, batchId);
      parentAgentId = row.parent_agent_id;
      memberIds = members.map((member) => member.agent_id);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    for (const agentId of memberIds) this.announce(agentId);
    if (parentAgentId) this.announce(parentAgentId);
    return true;
  }

  private restorePreparedExplicitGeneration(
    row: DeliveryBatchRow,
    updatedAt: number,
  ): { readonly changes: number | bigint } {
    const snapshot = this.pendingGenerationSnapshot(
      row.parent_agent_id,
      row.parent_generation,
      row.reserved_turn_id,
    );
    if (!snapshot) throw new Error('Subagent explicit generation snapshot is unavailable');
    return this.db.prepare(`
      UPDATE subagent_execution_state
      SET generation = ?, current_turn_id = ?, tool_use_id = ?, run_mode = ?,
          stop_provenance = ?, token_budget = ?, tokens_used = ?,
          budget_warning_issued = ?, terminal_origin = ?, terminal_routing = ?,
          notification_cutoff = ?, notification_delivery_class = ?, execution_mode = ?,
          active_batch_id = ?, settlement_coverage_json = ?,
          worktree_cleanup_started_at = ?, admission_previous_json = NULL, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
        AND active_batch_id = ? AND admission_previous_json IS NOT NULL
    `).run(
      snapshot.generation,
      snapshot.currentTurnId,
      snapshot.toolUseId,
      snapshot.runMode,
      snapshot.stopProvenance,
      snapshot.tokenBudget,
      snapshot.tokensUsed,
      snapshot.budgetWarningIssued ? 1 : 0,
      snapshot.terminalOrigin,
      snapshot.terminalRouting,
      snapshot.notificationCutoff,
      snapshot.notificationDeliveryClass,
      snapshot.executionMode,
      snapshot.activeBatchId,
      encodeSettlementCoverage(snapshot.settlementCoverage),
      snapshot.worktreeCleanupStartedAt,
      updatedAt,
      row.parent_agent_id,
      row.parent_generation,
      row.reserved_turn_id,
      row.batch_id,
    );
  }

  failPreparedDeliveryBatchAdmission(batchId: string, updatedAt: number): SubagentDeliveryBatch | null {
    this.db.exec('BEGIN IMMEDIATE;');
    let parentAgentId: ThreadId | null = null;
    let memberIds: ThreadId[] = [];
    try {
      const row = this.db.prepare(`
        SELECT * FROM subagent_delivery_batches WHERE batch_id = ? AND state = 'prepared'
      `).get(batchId) as DeliveryBatchRow | undefined;
      if (!row) {
        this.db.exec('ROLLBACK;');
        return this.readDeliveryBatch(batchId);
      }
      const members = this.db.prepare(`
        SELECT * FROM subagent_delivery_batch_members WHERE batch_id = ? ORDER BY ordinal
      `).all(batchId) as unknown as DeliveryBatchMemberRow[];
      if (row.kind === 'explicitAdmission') {
        const releaseClaimed = this.db.prepare(`
          UPDATE subagent_generation_notifications
          SET state = 'pending', delivery_class = 'carryForward',
              eligible_after_generation = ?, batch_id = NULL,
              coverage_disposition = NULL, omitted_bytes = 0, omitted_tokens = 0
          WHERE agent_id = ? AND generation = ? AND batch_id = ? AND state = 'delivering'
        `);
        const retainUnclaimed = this.db.prepare(`
          UPDATE subagent_generation_notifications
          SET delivery_class = 'carryForward', eligible_after_generation = ?,
              coverage_disposition = NULL, omitted_bytes = 0, omitted_tokens = 0
          WHERE agent_id = ? AND generation = ? AND batch_id IS NULL AND state = 'pending'
        `);
        for (const member of members) {
          const eligibleAfter = member.previous_delivery_class === 'ordinary'
            ? row.parent_generation - 1
            : member.previous_eligible_after_generation;
          const released = member.claimed === 1
            ? releaseClaimed.run(eligibleAfter, member.agent_id, member.generation, batchId)
            : retainUnclaimed.run(eligibleAfter, member.agent_id, member.generation);
          if (Number(released.changes) !== 1) {
            throw new Error('Subagent failed explicit admission member release raced');
          }
        }
      } else {
        const release = this.db.prepare(`
          UPDATE subagent_generation_notifications
          SET state = 'pending', delivery_class = 'carryForward',
              eligible_after_generation = ?, batch_id = NULL,
              coverage_disposition = NULL, omitted_bytes = 0, omitted_tokens = 0
          WHERE agent_id = ? AND generation = ? AND batch_id = ? AND state = 'delivering'
        `);
        for (const member of members) {
          if (Number(release.run(
            row.parent_generation,
            member.agent_id,
            member.generation,
            batchId,
          ).changes) !== 1) throw new Error('Subagent failed admission member release raced');
        }
      }
      const coverage: SubagentSettlementCoverage = {
        origin: row.origin as SubagentSettlementCoverage['origin'],
        full: 0,
        excerpted: 0,
        omitted: members.length,
        providerAttempted: false,
      };
      const execution = this.db.prepare(`
        UPDATE subagent_execution_state
        SET active_batch_id = NULL, settlement_coverage_json = ?,
            admission_previous_json = CASE
              WHEN ? = 'explicitAdmission' THEN NULL
              ELSE admission_previous_json
            END,
            updated_at = ?
        WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
          AND active_batch_id = ?
      `).run(
        encodeSettlementCoverage(coverage),
        row.kind,
        updatedAt,
        row.parent_agent_id,
        row.parent_generation,
        row.reserved_turn_id,
        batchId,
      );
      if (Number(execution.changes) !== 1) throw new Error('Subagent failed admission execution raced');
      this.db.prepare(`
        UPDATE subagent_delivery_batches SET state = 'admissionFailed', updated_at = ?
        WHERE batch_id = ? AND state = 'prepared'
      `).run(updatedAt, batchId);
      parentAgentId = row.parent_agent_id;
      memberIds = members.map((member) => member.agent_id);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    for (const agentId of memberIds) this.announce(agentId);
    if (parentAgentId) this.announce(parentAgentId);
    return this.readDeliveryBatch(batchId);
  }

  settleDeliveryBatch(input: {
    readonly batchId: string;
    readonly success: boolean;
    readonly updatedAt: number;
  }): SubagentDeliveryBatch | null {
    this.db.exec('BEGIN IMMEDIATE;');
    let parentAgentId: ThreadId | null = null;
    let memberIds: ThreadId[] = [];
    try {
      const row = this.db.prepare(`
        SELECT * FROM subagent_delivery_batches
        WHERE batch_id = ? AND state = 'linked'
      `).get(input.batchId) as DeliveryBatchRow | undefined;
      if (!row) {
        this.db.exec('ROLLBACK;');
        return this.readDeliveryBatch(input.batchId);
      }
      const members = this.db.prepare(`
        SELECT * FROM subagent_delivery_batch_members WHERE batch_id = ? ORDER BY ordinal
      `).all(input.batchId) as unknown as DeliveryBatchMemberRow[];
      const updateNotification = input.success
        ? this.db.prepare(`
            UPDATE subagent_generation_notifications
            SET state = 'delivered', delivered_at = ?
            WHERE agent_id = ? AND generation = ? AND batch_id = ? AND state = 'delivering'
          `)
        : this.db.prepare(`
            UPDATE subagent_generation_notifications
            SET state = 'pending', delivery_class = 'carryForward',
                eligible_after_generation = ?, batch_id = NULL,
                coverage_disposition = NULL, omitted_bytes = 0, omitted_tokens = 0
            WHERE agent_id = ? AND generation = ? AND batch_id = ? AND state = 'delivering'
          `);
      for (const member of members) {
        if (member.claimed === 0) continue;
        const failureEligibility = row.kind === 'explicitAdmission'
          ? member.previous_delivery_class === 'ordinary'
            ? row.parent_generation - 1
            : member.previous_eligible_after_generation
          : row.parent_generation;
        const result = input.success
          ? updateNotification.run(input.updatedAt, member.agent_id, member.generation, input.batchId)
          : updateNotification.run(failureEligibility, member.agent_id, member.generation, input.batchId);
        if (Number(result.changes) !== 1) throw new Error('Subagent batch settlement member raced');
      }
      const full = members.filter((member) => member.disposition === 'full').length;
      const excerpted = members.filter((member) => member.disposition === 'excerpted').length;
      const omitted = members.filter((member) => member.disposition === 'omitted').length;
      const coverage: SubagentSettlementCoverage = {
        origin: row.origin as SubagentSettlementCoverage['origin'],
        full,
        excerpted,
        omitted,
        providerAttempted: row.provider_attempted === 1,
      };
      this.db.prepare(`
        UPDATE subagent_execution_state
        SET active_batch_id = NULL, settlement_coverage_json = ?, updated_at = ?
        WHERE agent_id = ? AND generation = ? AND active_batch_id = ?
      `).run(
        encodeSettlementCoverage(coverage),
        input.updatedAt,
        row.parent_agent_id,
        row.parent_generation,
        input.batchId,
      );
      this.db.prepare(`
        UPDATE subagent_delivery_batches SET state = 'settled', updated_at = ?
        WHERE batch_id = ? AND state = 'linked'
      `).run(input.updatedAt, input.batchId);
      parentAgentId = row.parent_agent_id;
      memberIds = members.map((member) => member.agent_id);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    for (const agentId of memberIds) this.announce(agentId);
    if (parentAgentId) this.announce(parentAgentId);
    return this.readDeliveryBatch(input.batchId);
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
      UPDATE subagent_execution_state SET worktree_json = ?, updated_at = ?
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
      UPDATE subagent_execution_state
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
      UPDATE subagent_execution_state
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
      UPDATE subagent_execution_state
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

  /**
   * How one generation ended.
   *
   * `owed` is what separates the two callers. A background generation owes its
   * parent a notification, so its row starts `pending` and the delivery
   * pipeline picks it up. A foreground one owes nothing — its result travels
   * back through the `agent` call itself — but the row is still written, and
   * marked settled on arrival, because this table is also the DURABLE record of
   * how a generation ended: a conversation reopened later loads no child Turns,
   * and without a row here a finished foreground Agent read as `Idle`.
   */
  recordTerminal(
    input: Omit<
      SubagentPendingNotification,
      | 'state'
      | 'deliveredAt'
      | 'deliveryTurnId'
      | 'deliveryClass'
      | 'eligibleAfterGeneration'
      | 'batchId'
      | 'coverageDisposition'
      | 'omittedBytes'
      | 'omittedTokens'
    > & Partial<Pick<
      SubagentPendingNotification,
      | 'deliveryClass'
      | 'eligibleAfterGeneration'
      | 'batchId'
      | 'coverageDisposition'
      | 'omittedBytes'
      | 'omittedTokens'
    >>,
    owed: boolean = true,
  ): boolean {
    if (this.deletedAgentIds.has(input.agentId)) return false;
    validateTerminalInput(input, owed);
    const run = this.require(input.agentId);
    if (run.generation !== input.generation || run.currentTurnId !== input.turnId) return false;
    const result = this.db.prepare(`
      INSERT INTO subagent_generation_notifications(
        agent_id, generation, parent_thread_id, turn_id, tool_use_id,
        status, stop_provenance, error_code, error_message_preview,
        error_omitted_bytes, tokens_used, settlement_coverage_json,
        state, delivery_turn_id, delivery_class,
        eligible_after_generation, batch_id, coverage_disposition,
        omitted_bytes, omitted_tokens, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, generation) DO NOTHING
    `).run(
      input.agentId,
      input.generation,
      input.parentThreadId,
      input.turnId,
      input.toolUseId,
      input.status,
      input.stopProvenance,
      input.error?.code ?? null,
      input.error?.messagePreview ?? null,
      input.error?.omittedBytes ?? 0,
      input.tokensUsed,
      encodeSettlementCoverage(input.settlementCoverage),
      owed ? 'pending' : 'delivered',
      null,
      input.deliveryClass ?? 'ordinary',
      input.eligibleAfterGeneration ?? null,
      input.batchId ?? null,
      input.coverageDisposition ?? null,
      input.omittedBytes ?? 0,
      input.omittedTokens ?? 0,
      input.createdAt,
      owed ? null : input.createdAt,
    );
    if (Number(result.changes) !== 1) {
      const existing = this.terminalNotification(input.agentId, input.generation);
      if (!existing) return false;
      assertTerminalInputMatches(existing, input, owed);
      return true;
    }
    this.announce(input.agentId);
    return true;
  }

  pendingForParent(parentThreadId: ThreadId): readonly SubagentPendingNotification[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_generation_notifications
      WHERE parent_thread_id = ? AND state = 'pending'
      ORDER BY created_at, agent_id, generation
    `).all(parentThreadId) as unknown as NotificationRow[];
    return rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map(notificationFromRow);
  }

  hasUndeliveredForParent(parentThreadId: ThreadId): boolean {
    const rows = this.db.prepare(`
      SELECT agent_id FROM subagent_generation_notifications
      WHERE parent_thread_id = ? AND state <> 'delivered'
    `).all(parentThreadId) as unknown as Array<{ agent_id: ThreadId }>;
    return rows.some((row) => !this.deletedAgentIds.has(row.agent_id));
  }

  hasUndeliveredWork(threadId: ThreadId): boolean {
    if (this.deletedAgentIds.has(threadId)) return false;
    const rows = this.db.prepare(`
      SELECT agent_id AS owner_agent_id FROM subagent_generation_notifications
      WHERE (agent_id = ? OR parent_thread_id = ?) AND state <> 'delivered'
      UNION ALL
      SELECT sender_agent_id AS owner_agent_id FROM subagent_parent_message_queue
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
  terminalNotification(agentId: ThreadId, generation: number): SubagentPendingNotification | null {
    if (this.deletedAgentIds.has(agentId)) return null;
    const row = this.db.prepare(`
      SELECT * FROM subagent_generation_notifications
      WHERE agent_id = ? AND generation = ?
    `).get(agentId, generation) as NotificationRow | undefined;
    return row ? notificationFromRow(row) : null;
  }

  parentsWithPending(): readonly ThreadId[] {
    const rows = this.db.prepare(`
      SELECT parent_thread_id, agent_id FROM subagent_generation_notifications
      WHERE state = 'pending' ORDER BY parent_thread_id
    `).all() as unknown as Array<{ parent_thread_id: ThreadId; agent_id: ThreadId }>;
    return [...new Set(rows
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .map((row) => row.parent_thread_id))];
  }

  claim(agentId: ThreadId, generation: number): boolean {
    if (this.deletedAgentIds.has(agentId)) return false;
    const result = this.db.prepare(`
      UPDATE subagent_generation_notifications SET state = 'delivering'
      WHERE agent_id = ? AND generation = ? AND state = 'pending'
        AND delivery_class = 'ordinary' AND batch_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM subagent_execution_state parent
          WHERE parent.agent_id = subagent_generation_notifications.parent_thread_id
            AND parent.notification_cutoff <> 'open'
        )
    `).run(agentId, generation);
    if (Number(result.changes) !== 1) return false;
    this.announce(agentId);
    return true;
  }

  release(agentId: ThreadId, generation: number): void {
    this.db.prepare(`
      UPDATE subagent_generation_notifications SET state = 'pending'
      WHERE agent_id = ? AND generation = ? AND state = 'delivering'
    `).run(agentId, generation);
    this.announce(agentId);
  }

  markDelivered(
    agentId: ThreadId,
    generation: number,
    deliveryTurnId: TurnId,
    deliveredAt: number,
  ): void {
    this.db.prepare(`
      UPDATE subagent_generation_notifications
      SET state = 'delivered', delivery_turn_id = COALESCE(delivery_turn_id, ?), delivered_at = ?
      WHERE agent_id = ? AND generation = ? AND state = 'delivering'
    `).run(deliveryTurnId, deliveredAt, agentId, generation);
    this.announce(agentId);
  }

  enqueueParentMessage(input: Omit<SubagentParentMessage, 'state' | 'deliveredAt'>): void {
    if (this.deletedAgentIds.has(input.senderAgentId)) return;
    this.db.prepare(`
      INSERT INTO subagent_parent_message_queue(
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
      SELECT * FROM subagent_parent_message_queue
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
      SELECT * FROM subagent_parent_message_queue
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
      SELECT parent_thread_id, sender_agent_id FROM subagent_parent_message_queue
      WHERE state = 'pending' ORDER BY parent_thread_id
    `).all() as unknown as Array<{ parent_thread_id: ThreadId; sender_agent_id: ThreadId }>;
    return [...new Set(rows
      .filter((row) => !this.deletedAgentIds.has(row.sender_agent_id))
      .map((row) => row.parent_thread_id))];
  }

  claimParentMessage(id: string): boolean {
    const owner = this.db.prepare(`
      SELECT sender_agent_id FROM subagent_parent_message_queue WHERE id = ?
    `).get(id) as { sender_agent_id: ThreadId } | undefined;
    if (!owner || this.deletedAgentIds.has(owner.sender_agent_id)) return false;
    const result = this.db.prepare(`
      UPDATE subagent_parent_message_queue SET state = 'delivering'
      WHERE id = ? AND state = 'pending'
    `).run(id);
    return Number(result.changes) === 1;
  }

  releaseParentMessage(id: string): void {
    this.db.prepare(`
      UPDATE subagent_parent_message_queue SET state = 'pending'
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
      DELETE FROM subagent_parent_message_queue
      WHERE id = ? AND state = 'delivering'
    `).run(id);
  }

  markParentMessageDelivered(id: string, deliveredAt: number): void {
    this.db.prepare(`
      UPDATE subagent_parent_message_queue SET state = 'delivered', delivered_at = ?
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
        DELETE FROM subagent_generation_notifications
        WHERE agent_id = ? OR parent_thread_id = ?
      `).run(agentId, agentId);
      this.db.prepare(`
        DELETE FROM subagent_parent_message_queue
        WHERE sender_agent_id = ? OR parent_thread_id = ?
      `).run(agentId, agentId);
      this.db.prepare('DELETE FROM subagent_execution_state WHERE agent_id = ?').run(agentId);
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
        DELETE FROM subagent_generation_notifications
        WHERE agent_id IN (${placeholders}) OR parent_thread_id IN (${placeholders})
      `).run(...ids, ...ids);
      this.db.prepare(`
        DELETE FROM subagent_parent_message_queue
        WHERE sender_agent_id IN (${placeholders}) OR parent_thread_id IN (${placeholders})
      `).run(...ids, ...ids);
      this.db.prepare(`
        DELETE FROM subagent_execution_state
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
      SELECT * FROM subagent_execution_state ORDER BY created_at, agent_id
    `).all() as unknown as ExecutionRow[];
    return executions
      .filter((row) => !this.deletedAgentIds.has(row.agent_id))
      .filter((row) => !knownThreadIds.has(row.agent_id) || !knownThreadIds.has(row.parent_thread_id))
      .map(executionFromRow);
  }

  /** Removes envelopes whose execution or Thread endpoint no longer exists. */
  sweepOrphanEnvelopes(knownThreadIds: ReadonlySet<ThreadId>): number {
    const executions = this.db.prepare(`
      SELECT agent_id FROM subagent_execution_state
    `).all() as unknown as Array<{ agent_id: ThreadId }>;
    const executionAgentIds = new Set(executions.map((row) => row.agent_id));
    const notifications = this.db.prepare(`
      SELECT agent_id, generation, parent_thread_id FROM subagent_generation_notifications
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
      SELECT id, sender_agent_id, parent_thread_id FROM subagent_parent_message_queue
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
      DELETE FROM subagent_generation_notifications WHERE agent_id = ? AND generation = ?
    `);
    const deleteMessage = this.db.prepare(`
      DELETE FROM subagent_parent_message_queue WHERE id = ?
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
  const originRoutingValid = row.terminal_origin === null && row.terminal_routing === null
    || row.terminal_origin === 'ordinary' && row.terminal_routing === 'ordinary'
    || ['budgetInterrupted', 'normalOvershoot'].includes(String(row.terminal_origin))
      && row.terminal_routing === 'exhaustedSettlement'
    || ['providerFailure', 'contextFailure', 'hostFailure', 'rendererStop', 'taskStop', 'hostRestart']
      .includes(String(row.terminal_origin)) && row.terminal_routing === 'closeWithoutProvider';
  if (
    !nonEmptyString(row.agent_id)
    || !nonEmptyString(row.parent_thread_id)
    || typeof row.description !== 'string'
    || !nonEmptyString(row.agent_type)
    || !['foreground', 'background'].includes(row.run_mode)
    || !positiveSafeIntegerValue(row.generation)
    || !nonEmptyString(row.current_turn_id)
    || !nonEmptyString(row.tool_use_id)
    || !['none', 'model', 'user', 'budget', 'hostRestart'].includes(row.stop_provenance)
    || (row.token_budget !== null && !positiveSafeIntegerValue(row.token_budget))
    || !nonNegativeSafeIntegerValue(row.tokens_used)
    || (row.budget_warning_issued !== 0 && row.budget_warning_issued !== 1)
    || !originRoutingValid
    || !['open', 'closing', 'closed'].includes(row.notification_cutoff)
    || !['ordinary', 'carryForward'].includes(row.notification_delivery_class)
    || !['ordinary', 'exhaustedSettlement'].includes(row.execution_mode)
    || (row.active_batch_id !== null && !nonEmptyString(row.active_batch_id))
    || (row.worktree_cleanup_started_at !== null
      && !nonNegativeSafeIntegerValue(row.worktree_cleanup_started_at))
    || !['pending', 'committed'].includes(row.initial_admission_state)
    || !nonNegativeSafeIntegerValue(row.created_at)
    || !nonNegativeSafeIntegerValue(row.updated_at)
  ) throw new Error('Invalid persisted Subagent execution state');
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
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    budgetWarningIssued: row.budget_warning_issued === 1,
    terminalOrigin: row.terminal_origin as SubagentTerminalOrigin | null,
    terminalRouting: row.terminal_routing as SubagentTerminalRouting | null,
    notificationCutoff: row.notification_cutoff as SubagentNotificationCutoff,
    notificationDeliveryClass: row.notification_delivery_class as SubagentDeliveryClass,
    executionMode: row.execution_mode as SubagentExecutionMode,
    activeBatchId: row.active_batch_id,
    settlementCoverage: decodeSettlementCoverage(row.settlement_coverage_json),
    worktree: row.worktree_json === null
      ? null
      : decodeWorktree(JSON.parse(row.worktree_json)),
    worktreeCleanupStartedAt: row.worktree_cleanup_started_at,
    toolPolicy: decodeToolPolicy(JSON.parse(row.tool_policy_json)),
    startupContext: row.startup_context_json === null
      ? null
      : decodeStartupContext(JSON.parse(row.startup_context_json)),
    initialAdmissionState: row.initial_admission_state as SubagentInitialAdmissionState,
    initialWorktreeIntent: row.initial_worktree_intent_json === null
      ? null
      : decodeWorktreeRecoveryIntent(JSON.parse(row.initial_worktree_intent_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deliveryBatchFromRows(
  row: DeliveryBatchRow,
  memberRows: readonly DeliveryBatchMemberRow[],
): SubagentDeliveryBatch {
  if (
    !nonEmptyString(row.batch_id)
    || !nonEmptyString(row.parent_agent_id)
    || !nonEmptyString(row.reserved_turn_id)
    || (row.sidecar_item_id !== null && !nonEmptyString(row.sidecar_item_id))
    || !nonEmptyString(row.previous_turn_id)
    || !['exhaustedSettlement', 'explicitAdmission'].includes(row.kind)
    || !['budgetInterrupted', 'normalOvershoot', 'explicitAdmission'].includes(row.origin)
    || !['prepared', 'linked', 'detachedForOverflow', 'admissionFailed', 'settled'].includes(row.state)
    || !['open', 'closing', 'closed'].includes(row.previous_cutoff)
    || !/^[0-9a-f]{64}$/u.test(row.envelope_digest)
    || !positiveSafeIntegerValue(row.parent_generation)
    || !nonNegativeSafeIntegerValue(row.created_at)
    || !nonNegativeSafeIntegerValue(row.updated_at)
    || (row.provider_attempted !== 0 && row.provider_attempted !== 1)
    || (row.kind === 'exhaustedSettlement' && row.origin === 'explicitAdmission')
    || (row.kind === 'exhaustedSettlement' && row.sidecar_item_id !== null)
    || (row.kind === 'explicitAdmission' && row.origin !== 'explicitAdmission')
  ) throw new Error('Invalid persisted Subagent delivery batch');
  const members = memberRows.map(deliveryBatchMemberFromRow);
  if (members.some((member, index) => member.ordinal !== index)) {
    throw new Error('Invalid persisted Subagent delivery batch member order');
  }
  return {
    batchId: row.batch_id,
    parentAgentId: row.parent_agent_id,
    parentGeneration: row.parent_generation,
    kind: row.kind as SubagentDeliveryBatchKind,
    origin: row.origin as SubagentSettlementCoverage['origin'],
    state: row.state as SubagentDeliveryBatchState,
    reservedTurnId: row.reserved_turn_id,
    sidecarItemId: row.sidecar_item_id,
    envelopeDigest: row.envelope_digest,
    providerAttempted: row.provider_attempted === 1,
    members: Object.freeze(members),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deliveryBatchMemberFromRow(row: DeliveryBatchMemberRow): SubagentDeliveryBatchMember {
  if (
    !nonEmptyString(row.batch_id)
    || !nonEmptyString(row.agent_id)
    || !nonEmptyString(row.turn_id)
    || !nonNegativeSafeIntegerValue(row.ordinal)
    || (row.claimed !== 0 && row.claimed !== 1)
    || !positiveSafeIntegerValue(row.generation)
    || !['finished', 'failed', 'interrupted', 'killed'].includes(row.status)
    || !['none', 'model', 'user', 'budget', 'hostRestart'].includes(row.stop_provenance)
    || !['full', 'excerpted', 'omitted'].includes(row.disposition)
    || !nonNegativeSafeIntegerValue(row.tokens_used)
    || !nonNegativeSafeIntegerValue(row.source_bytes)
    || !nonNegativeSafeIntegerValue(row.source_tokens)
    || !nonNegativeSafeIntegerValue(row.omitted_bytes)
    || !nonNegativeSafeIntegerValue(row.omitted_tokens)
    || !nonNegativeSafeIntegerValue(row.nested_full)
    || !nonNegativeSafeIntegerValue(row.nested_excerpted)
    || !nonNegativeSafeIntegerValue(row.nested_omitted)
    || (row.error_code !== null && Buffer.byteLength(row.error_code, 'utf8') > 128)
  ) throw new Error('Invalid persisted Subagent delivery batch member');
  return {
    ordinal: row.ordinal,
    claimed: row.claimed === 1,
    agentId: row.agent_id,
    generation: row.generation,
    turnId: row.turn_id,
    status: row.status as SubagentTerminalStatus,
    stopProvenance: row.stop_provenance as SubagentStopProvenance,
    tokensUsed: row.tokens_used,
    errorCode: row.error_code,
    sourceBytes: row.source_bytes,
    sourceTokens: row.source_tokens,
    disposition: row.disposition as SubagentCoverageDisposition,
    omittedBytes: row.omitted_bytes,
    omittedTokens: row.omitted_tokens,
    nestedFull: row.nested_full,
    nestedExcerpted: row.nested_excerpted,
    nestedOmitted: row.nested_omitted,
  };
}

function validateBatchMembers(members: readonly SubagentDeliveryBatchMember[]): void {
  const identities = new Set<string>();
  members.forEach((member, index) => {
    if (member.ordinal !== index) throw new Error('Subagent batch member ordinals must be contiguous');
    positiveSafeInteger(member.generation, 'Subagent batch member generation');
    for (const [label, value] of [
      ['tokens used', member.tokensUsed],
      ['source bytes', member.sourceBytes],
      ['source tokens', member.sourceTokens],
      ['omitted bytes', member.omittedBytes],
      ['omitted tokens', member.omittedTokens],
      ['nested full', member.nestedFull],
      ['nested excerpted', member.nestedExcerpted],
      ['nested omitted', member.nestedOmitted],
    ] as const) nonNegativeSafeInteger(value, `Subagent batch member ${label}`);
    if (member.errorCode !== null && Buffer.byteLength(member.errorCode, 'utf8') > 128) {
      throw new Error('Subagent batch member error code exceeds 128 UTF-8 bytes');
    }
    const identity = `${member.agentId}\0${member.generation}`;
    if (identities.has(identity)) throw new Error('Subagent batch contains a duplicate generation');
    identities.add(identity);
  });
}

function sameNotificationIdentities(
  notifications: readonly NotificationRow[],
  members: readonly SubagentDeliveryBatchMember[],
): boolean {
  if (notifications.length !== members.length) return false;
  const identities = new Set(notifications.map((row) => `${row.agent_id}\0${row.generation}\0${row.turn_id}`));
  return members.every((member) => identities.has(`${member.agentId}\0${member.generation}\0${member.turnId}`));
}

function assertBatchMemberMatchesNotification(
  member: SubagentDeliveryBatchMember,
  notification: NotificationRow,
): void {
  if (
    member.turnId !== notification.turn_id
    || member.status !== notification.status
    || member.stopProvenance !== notification.stop_provenance
    || member.errorCode !== notification.error_code
    || member.tokensUsed !== notification.tokens_used
    || member.nestedFull !== (decodeSettlementCoverage(notification.settlement_coverage_json)?.full ?? 0)
    || member.nestedExcerpted !== (decodeSettlementCoverage(notification.settlement_coverage_json)?.excerpted ?? 0)
    || member.nestedOmitted !== (decodeSettlementCoverage(notification.settlement_coverage_json)?.omitted ?? 0)
  ) throw new Error('Subagent batch member facts do not match its terminal notification');
}

function restoreBatchNotifications(
  db: SqliteDatabase,
  members: readonly DeliveryBatchMemberRow[],
  batchId: string,
): void {
  const restoreClaimed = db.prepare(`
    UPDATE subagent_generation_notifications
    SET state = ?, delivery_class = ?, eligible_after_generation = ?, batch_id = ?,
        coverage_disposition = ?, omitted_bytes = ?, omitted_tokens = ?
    WHERE agent_id = ? AND generation = ? AND batch_id = ?
  `);
  const restoreUnclaimed = db.prepare(`
    UPDATE subagent_generation_notifications
    SET state = ?, delivery_class = ?, eligible_after_generation = ?, batch_id = ?,
        coverage_disposition = ?, omitted_bytes = ?, omitted_tokens = ?
    WHERE agent_id = ? AND generation = ? AND batch_id IS NULL
      AND state = 'pending' AND delivery_class = 'carryForward'
  `);
  for (const member of members) {
    const restore = member.claimed === 1 ? restoreClaimed : restoreUnclaimed;
    const result = restore.run(
      member.previous_state,
      member.previous_delivery_class,
      member.previous_eligible_after_generation,
      member.previous_batch_id,
      member.previous_coverage_disposition,
      member.previous_omitted_bytes,
      member.previous_omitted_tokens,
      member.agent_id,
      member.generation,
      ...(member.claimed === 1 ? [batchId] : []),
    );
    if (Number(result.changes) !== 1) throw new Error('Subagent batch notification rollback raced');
  }
}

function assertBatchIdentity(batchId: string, envelopeDigest: string): void {
  if (!batchId.trim()) throw new Error('Subagent delivery batch ID must not be empty');
  if (!/^[0-9a-f]{64}$/u.test(envelopeDigest)) {
    throw new Error('Subagent delivery envelope digest must be lowercase SHA-256');
  }
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
    || (record.removedAt !== null && !nonNegativeSafeIntegerValue(record.removedAt))
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
    !exactObjectKeys(record, [
      'generation', 'currentTurnId', 'toolUseId', 'runMode', 'stopProvenance',
      'tokenBudget', 'tokensUsed', 'budgetWarningIssued', 'terminalOrigin',
      'terminalRouting', 'notificationCutoff', 'notificationDeliveryClass',
      'executionMode', 'activeBatchId', 'settlementCoverage', 'worktree',
      'worktreeCleanupStartedAt', 'updatedAt',
    ])
    ||
    typeof record.generation !== 'number'
    || !positiveSafeIntegerValue(record.generation)
    || !nonEmptyString(record.currentTurnId)
    || !nonEmptyString(record.toolUseId)
    || !['foreground', 'background'].includes(String(record.runMode))
    || !['none', 'model', 'user', 'budget', 'hostRestart'].includes(String(record.stopProvenance))
    || (record.tokenBudget !== null && (
      typeof record.tokenBudget !== 'number'
      || !Number.isSafeInteger(record.tokenBudget)
      || record.tokenBudget < 1
    ))
    || typeof record.tokensUsed !== 'number'
    || !Number.isSafeInteger(record.tokensUsed)
    || record.tokensUsed < 0
    || typeof record.budgetWarningIssued !== 'boolean'
    || (record.terminalOrigin !== null && ![
      'ordinary', 'budgetInterrupted', 'normalOvershoot', 'providerFailure',
      'contextFailure', 'hostFailure', 'rendererStop', 'taskStop', 'hostRestart',
    ].includes(String(record.terminalOrigin)))
    || (record.terminalRouting !== null && ![
      'ordinary', 'exhaustedSettlement', 'closeWithoutProvider',
    ].includes(String(record.terminalRouting)))
    || !['open', 'closing', 'closed'].includes(String(record.notificationCutoff))
    || !['ordinary', 'carryForward'].includes(String(record.notificationDeliveryClass))
    || !['ordinary', 'exhaustedSettlement'].includes(String(record.executionMode))
    || (record.activeBatchId !== null && typeof record.activeBatchId !== 'string')
    || (record.worktree !== null && typeof record.worktree !== 'object')
    || (record.worktreeCleanupStartedAt !== null
      && !nonNegativeSafeIntegerValue(record.worktreeCleanupStartedAt))
    || !nonNegativeSafeIntegerValue(record.updatedAt)
  ) throw new Error('Invalid persisted Subagent generation admission snapshot');
  return {
    generation: record.generation,
    currentTurnId: record.currentTurnId,
    toolUseId: record.toolUseId,
    runMode: record.runMode as SubagentRunMode,
    stopProvenance: record.stopProvenance as SubagentStopProvenance,
    tokenBudget: record.tokenBudget as number | null,
    tokensUsed: record.tokensUsed,
    budgetWarningIssued: record.budgetWarningIssued,
    terminalOrigin: record.terminalOrigin as SubagentTerminalOrigin | null,
    terminalRouting: record.terminalRouting as SubagentTerminalRouting | null,
    notificationCutoff: record.notificationCutoff as SubagentNotificationCutoff,
    notificationDeliveryClass: record.notificationDeliveryClass as SubagentDeliveryClass,
    executionMode: record.executionMode as SubagentExecutionMode,
    activeBatchId: record.activeBatchId as string | null,
    settlementCoverage: decodeSettlementCoverageValue(record.settlementCoverage),
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

type TerminalRecordInput = Parameters<SubagentExecutionLedger['recordTerminal']>[0];

function validateTerminalInput(input: TerminalRecordInput, owed: boolean): void {
  const errorValid = input.error === null
    || (
      nonEmptyString(input.error.code)
      && Buffer.byteLength(input.error.code, 'utf8') <= 128
      && typeof input.error.messagePreview === 'string'
      && Buffer.byteLength(input.error.messagePreview, 'utf8') <= 4_096
      && nonNegativeSafeIntegerValue(input.error.omittedBytes)
    );
  const deliveryClass = input.deliveryClass ?? 'ordinary';
  const eligibleAfterGeneration = input.eligibleAfterGeneration ?? null;
  const batchId = input.batchId ?? null;
  const coverageDisposition = input.coverageDisposition ?? null;
  const omittedBytes = input.omittedBytes ?? 0;
  const omittedTokens = input.omittedTokens ?? 0;
  if (
    !nonEmptyString(input.agentId)
    || !positiveSafeIntegerValue(input.generation)
    || !nonEmptyString(input.parentThreadId)
    || !nonEmptyString(input.turnId)
    || !nonEmptyString(input.toolUseId)
    || !['finished', 'failed', 'interrupted', 'killed'].includes(input.status)
    || !['none', 'model', 'user', 'budget', 'hostRestart'].includes(input.stopProvenance)
    || !errorValid
    || !nonNegativeSafeIntegerValue(input.tokensUsed)
    || !['ordinary', 'carryForward'].includes(deliveryClass)
    || (eligibleAfterGeneration !== null && !positiveSafeIntegerValue(eligibleAfterGeneration))
    || (batchId !== null && !nonEmptyString(batchId))
    || (coverageDisposition !== null
      && !['full', 'excerpted', 'omitted'].includes(coverageDisposition))
    || !nonNegativeSafeIntegerValue(omittedBytes)
    || !nonNegativeSafeIntegerValue(omittedTokens)
    || !nonNegativeSafeIntegerValue(input.createdAt)
    || (deliveryClass === 'ordinary' && eligibleAfterGeneration !== null)
    || (deliveryClass === 'carryForward' && eligibleAfterGeneration === null)
    || ((batchId === null) !== (coverageDisposition === null))
    || (!owed && (
      deliveryClass !== 'ordinary'
      || batchId !== null
      || coverageDisposition !== null
      || omittedBytes !== 0
      || omittedTokens !== 0
    ))
  ) throw new Error('Invalid Subagent terminal notification input');
  decodeSettlementCoverageValue(input.settlementCoverage);
}

function assertTerminalInputMatches(
  existing: SubagentPendingNotification,
  input: TerminalRecordInput,
  owed: boolean,
): void {
  const expectedError = input.error;
  const errorsMatch = existing.error === null
    ? expectedError === null
    : expectedError !== null
      && existing.error.code === expectedError.code
      && existing.error.messagePreview === expectedError.messagePreview
      && existing.error.omittedBytes === expectedError.omittedBytes;
  const coverageMatches = JSON.stringify(existing.settlementCoverage)
    === JSON.stringify(input.settlementCoverage);
  const initialDeliveryMatches = owed
    ? !(
        existing.state === 'delivered'
        && existing.deliveryTurnId === null
        && existing.deliveredAt === existing.createdAt
      )
    : true;
  if (
    existing.agentId !== input.agentId
    || existing.generation !== input.generation
    || existing.parentThreadId !== input.parentThreadId
    || existing.turnId !== input.turnId
    || existing.toolUseId !== input.toolUseId
    || existing.status !== input.status
    || existing.stopProvenance !== input.stopProvenance
    || !errorsMatch
    || existing.tokensUsed !== input.tokensUsed
    || !coverageMatches
    || !initialDeliveryMatches
  ) throw new Error('Conflicting Subagent terminal notification replay');
}

function notificationFromRow(row: NotificationRow): SubagentPendingNotification {
  validateNotificationRow(row);
  return {
    agentId: row.agent_id,
    generation: row.generation,
    parentThreadId: row.parent_thread_id,
    turnId: row.turn_id,
    toolUseId: row.tool_use_id,
    status: row.status as SubagentTerminalStatus,
    stopProvenance: row.stop_provenance as SubagentStopProvenance,
    error: row.error_code === null
      ? null
      : {
          code: row.error_code,
          messagePreview: row.error_message_preview ?? '',
          omittedBytes: row.error_omitted_bytes,
        },
    tokensUsed: row.tokens_used,
    settlementCoverage: decodeSettlementCoverage(row.settlement_coverage_json),
    state: row.state as SubagentNotificationState,
    deliveryTurnId: row.delivery_turn_id,
    deliveryClass: row.delivery_class as SubagentDeliveryClass,
    eligibleAfterGeneration: row.eligible_after_generation,
    batchId: row.batch_id,
    coverageDisposition: row.coverage_disposition as SubagentCoverageDisposition | null,
    omittedBytes: row.omitted_bytes,
    omittedTokens: row.omitted_tokens,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

function validateNotificationRow(row: NotificationRow): void {
  const errorValid = row.error_code === null
    ? row.error_message_preview === null && row.error_omitted_bytes === 0
    : nonEmptyString(row.error_code)
      && Buffer.byteLength(row.error_code, 'utf8') <= 128
      && typeof row.error_message_preview === 'string'
      && Buffer.byteLength(row.error_message_preview, 'utf8') <= 4_096
      && nonNegativeSafeIntegerValue(row.error_omitted_bytes);
  if (
    !nonEmptyString(row.agent_id)
    || !positiveSafeIntegerValue(row.generation)
    || !nonEmptyString(row.parent_thread_id)
    || !nonEmptyString(row.turn_id)
    || !nonEmptyString(row.tool_use_id)
    || !['finished', 'failed', 'interrupted', 'killed'].includes(row.status)
    || !['none', 'model', 'user', 'budget', 'hostRestart'].includes(row.stop_provenance)
    || !errorValid
    || !nonNegativeSafeIntegerValue(row.tokens_used)
    || !['pending', 'delivering', 'delivered'].includes(row.state)
    || (row.delivery_turn_id !== null && !nonEmptyString(row.delivery_turn_id))
    || !['ordinary', 'carryForward'].includes(row.delivery_class)
    || (row.eligible_after_generation !== null
      && !positiveSafeIntegerValue(row.eligible_after_generation))
    || (row.batch_id !== null && !nonEmptyString(row.batch_id))
    || (row.coverage_disposition !== null
      && !['full', 'excerpted', 'omitted'].includes(row.coverage_disposition))
    || !nonNegativeSafeIntegerValue(row.omitted_bytes)
    || !nonNegativeSafeIntegerValue(row.omitted_tokens)
    || !nonNegativeSafeIntegerValue(row.created_at)
    || (row.delivered_at !== null && !nonNegativeSafeIntegerValue(row.delivered_at))
    || (row.delivery_class === 'ordinary' && row.eligible_after_generation !== null)
    || (row.delivery_class === 'carryForward' && row.eligible_after_generation === null)
  ) throw new Error('Invalid persisted Subagent terminal notification');
  decodeSettlementCoverage(row.settlement_coverage_json);
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
    !exactObjectKeys(record, [
      'kind', 'runInBackground', 'worktree', 'allowNesting', 'requestedTools',
    ])
    ||
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
    !exactObjectKeys(record, ['repositoryInstructions', 'gitStatus'])
    ||
    !Array.isArray(record.repositoryInstructions)
    || record.repositoryInstructions.some((entry) => typeof entry !== 'string')
    || (record.gitStatus !== null && typeof record.gitStatus !== 'string')
  ) throw new Error('Invalid persisted Agent startup context');
  return {
    repositoryInstructions: Object.freeze([...record.repositoryInstructions]),
    gitStatus: record.gitStatus as string | null,
  };
}

function encodeSettlementCoverage(coverage: SubagentSettlementCoverage | null): string | null {
  return coverage === null ? null : JSON.stringify(coverage);
}

function decodeSettlementCoverage(value: string | null): SubagentSettlementCoverage | null {
  return value === null ? null : decodeSettlementCoverageValue(JSON.parse(value));
}

function decodeSettlementCoverageValue(value: unknown): SubagentSettlementCoverage | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid persisted Subagent settlement coverage');
  }
  const record = value as Record<string, unknown>;
  if (
    !['budgetInterrupted', 'normalOvershoot', 'explicitAdmission'].includes(String(record.origin))
    || !nonNegativeSafeIntegerValue(record.full)
    || !nonNegativeSafeIntegerValue(record.excerpted)
    || !nonNegativeSafeIntegerValue(record.omitted)
    || typeof record.providerAttempted !== 'boolean'
    || Object.keys(record).some((key) => ![
      'origin', 'full', 'excerpted', 'omitted', 'providerAttempted',
    ].includes(key))
  ) throw new Error('Invalid persisted Subagent settlement coverage');
  return {
    origin: record.origin as SubagentSettlementCoverage['origin'],
    full: record.full as number,
    excerpted: record.excerpted as number,
    omitted: record.omitted as number,
    providerAttempted: record.providerAttempted,
  };
}

function nullablePositiveSafeInteger(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`${label} must be a positive safe integer or null`);
  }
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function nonNegativeSafeIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function exactObjectKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function checkedTotal(current: number, increment: number): number {
  const total = current + increment;
  if (!Number.isSafeInteger(total)) throw new Error('Subagent generation usage exceeds the safe integer range');
  return total;
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
