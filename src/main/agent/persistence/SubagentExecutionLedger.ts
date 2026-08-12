import type { ThreadId, TurnId } from '../../../core/agent/protocol';
import type { SubagentToolPolicy } from '../capabilities/subagentToolPolicy';
import type { AgentWorktreeMetadata } from '../worktree/AgentWorktree';
import type { SqliteDatabase } from './sqlite';
import type { AgentStartupContextSnapshot } from '../context/AgentStartupContext';

export type { AgentStartupContextSnapshot } from '../context/AgentStartupContext';

export type SubagentRunMode = 'foreground' | 'background';
export type SubagentStopProvenance = 'none' | 'model' | 'user' | 'budget' | 'hostRestart';
export type SubagentTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'killed';
export type SubagentNotificationState = 'pending' | 'delivering' | 'delivered';

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
  readonly toolPolicy: SubagentRecordedToolPolicy;
  readonly startupContext: AgentStartupContextSnapshot | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SubagentGenerationSnapshot {
  readonly generation: number;
  readonly currentTurnId: TurnId;
  readonly toolUseId: string;
  readonly runMode: SubagentRunMode;
  readonly stopProvenance: SubagentStopProvenance;
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
  tool_policy_json: string;
  startup_context_json: string | null;
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
  content: string;
  delivery_mode: string;
  state: string;
  created_at: number;
  delivered_at: number | null;
}

/**
 * Persistent execution state that is not already represented by Thread/Turn.
 * Agent identity is the child Thread id; model, cwd, Role, and transcript stay
 * in their existing authorities and are deliberately not duplicated here.
 */
export class SubagentExecutionLedger {
  private readonly deletedAgentIds = new Set<ThreadId>();

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_executions (
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
        tool_policy_json TEXT NOT NULL,
        startup_context_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_executions_parent_idx
        ON subagent_executions(parent_thread_id, created_at, agent_id);
      CREATE TABLE IF NOT EXISTS subagent_notifications (
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
      CREATE INDEX IF NOT EXISTS subagent_notifications_pending_idx
        ON subagent_notifications(parent_thread_id, state, created_at, agent_id, generation);
      CREATE TABLE IF NOT EXISTS subagent_parent_messages (
        id TEXT PRIMARY KEY,
        sender_agent_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        content TEXT NOT NULL,
        delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('foreground', 'background')),
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered')),
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_parent_messages_pending_idx
        ON subagent_parent_messages(parent_thread_id, state, created_at, id);
    `);
    // A process may die after claiming but before admitting the parent Turn.
    // Client-input idempotency makes replay safe, so claims are recoverable.
    this.db.prepare("UPDATE subagent_notifications SET state = 'pending' WHERE state = 'delivering'").run();
    this.db.prepare("UPDATE subagent_parent_messages SET state = 'pending' WHERE state = 'delivering'").run();
  }

  create(input: Omit<SubagentExecutionRecord, 'generation' | 'stopProvenance'>): SubagentExecutionRecord {
    this.db.prepare(`
      INSERT INTO subagent_executions(
        agent_id, parent_thread_id, description, agent_type, run_mode, generation,
        current_turn_id, tool_use_id, stop_provenance, worktree_json, tool_policy_json,
        startup_context_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'none', ?, ?, ?, ?, ?)
    `).run(
      input.agentId,
      input.parentThreadId,
      input.description,
      input.agentType,
      input.runMode,
      input.currentTurnId,
      input.toolUseId,
      input.worktree === null ? null : JSON.stringify(input.worktree),
      JSON.stringify(input.toolPolicy),
      input.startupContext === null ? null : JSON.stringify(input.startupContext),
      input.createdAt,
      input.updatedAt,
    );
    return this.require(input.agentId);
  }

  read(agentId: ThreadId): SubagentExecutionRecord | null {
    if (this.deletedAgentIds.has(agentId)) return null;
    const row = this.db.prepare('SELECT * FROM subagent_executions WHERE agent_id = ?')
      .get(agentId) as ExecutionRow | undefined;
    return row ? executionFromRow(row) : null;
  }

  startupContextForTurn(agentId: ThreadId, turnId: TurnId): AgentStartupContextSnapshot | null {
    const record = this.read(agentId);
    if (!record || record.generation !== 1 || record.currentTurnId !== turnId) return null;
    return record.startupContext;
  }

  require(agentId: ThreadId): SubagentExecutionRecord {
    const record = this.read(agentId);
    if (!record) throw new Error(`Subagent execution not found: ${agentId}`);
    return record;
  }

  listByParent(parentThreadId: ThreadId): readonly SubagentExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_executions
      WHERE parent_thread_id = ? ORDER BY created_at, agent_id
    `).all(parentThreadId) as unknown as ExecutionRow[];
    return rows.map(executionFromRow);
  }

  all(): readonly SubagentExecutionRecord[] {
    const rows = this.db.prepare('SELECT * FROM subagent_executions ORDER BY created_at, agent_id')
      .all() as unknown as ExecutionRow[];
    return rows.map(executionFromRow);
  }

  beginNextGeneration(input: {
    readonly agentId: ThreadId;
    readonly turnId: TurnId;
    readonly toolUseId: string;
    readonly runMode: SubagentRunMode;
    readonly updatedAt: number;
  }): SubagentExecutionRecord {
    const result = this.db.prepare(`
      UPDATE subagent_executions
      SET generation = generation + 1, current_turn_id = ?, tool_use_id = ?,
          run_mode = ?, stop_provenance = 'none', updated_at = ?
      WHERE agent_id = ? AND stop_provenance <> 'user'
    `).run(input.turnId, input.toolUseId, input.runMode, input.updatedAt, input.agentId);
    if (Number(result.changes) !== 1) {
      const existing = this.read(input.agentId);
      if (!existing) throw new Error(`Subagent execution not found: ${input.agentId}`);
      throw new Error(existing.stopProvenance === 'user'
        ? 'A user-stopped Agent cannot be resumed by another Agent'
        : `Subagent generation was not advanced: ${input.agentId}`);
    }
    return this.require(input.agentId);
  }

  generationSnapshot(agentId: ThreadId): SubagentGenerationSnapshot {
    const record = this.require(agentId);
    return {
      generation: record.generation,
      currentTurnId: record.currentTurnId,
      toolUseId: record.toolUseId,
      runMode: record.runMode,
      stopProvenance: record.stopProvenance,
      updatedAt: record.updatedAt,
    };
  }

  rollbackGeneration(
    agentId: ThreadId,
    expectedGeneration: number,
    snapshot: SubagentGenerationSnapshot,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_executions
      SET generation = ?, current_turn_id = ?, tool_use_id = ?, run_mode = ?,
          stop_provenance = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ?
    `).run(
      snapshot.generation,
      snapshot.currentTurnId,
      snapshot.toolUseId,
      snapshot.runMode,
      snapshot.stopProvenance,
      snapshot.updatedAt,
      agentId,
      expectedGeneration,
    );
    return Number(result.changes) === 1;
  }

  continueGeneration(input: {
    readonly agentId: ThreadId;
    readonly expectedGeneration: number;
    readonly expectedTurnId: TurnId;
    readonly turnId: TurnId;
    readonly updatedAt: number;
  }): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_executions SET current_turn_id = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
    `).run(
      input.turnId,
      input.updatedAt,
      input.agentId,
      input.expectedGeneration,
      input.expectedTurnId,
    );
    return Number(result.changes) === 1;
  }

  rollbackContinuation(input: {
    readonly agentId: ThreadId;
    readonly expectedGeneration: number;
    readonly expectedTurnId: TurnId;
    readonly snapshot: SubagentGenerationSnapshot;
  }): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_executions SET current_turn_id = ?, updated_at = ?
      WHERE agent_id = ? AND generation = ? AND current_turn_id = ?
    `).run(
      input.snapshot.currentTurnId,
      input.snapshot.updatedAt,
      input.agentId,
      input.expectedGeneration,
      input.expectedTurnId,
    );
    return Number(result.changes) === 1;
  }

  recordStop(
    agentId: ThreadId,
    provenance: Exclude<SubagentStopProvenance, 'none'>,
    updatedAt: number,
  ): SubagentExecutionRecord {
    const existing = this.require(agentId);
    const next = higherPriorityStop(existing.stopProvenance, provenance);
    this.db.prepare(`
      UPDATE subagent_executions SET stop_provenance = ?, updated_at = ? WHERE agent_id = ?
    `).run(next, updatedAt, agentId);
    return this.require(agentId);
  }

  clearUserStop(agentId: ThreadId, updatedAt: number): SubagentExecutionRecord {
    this.db.prepare(`
      UPDATE subagent_executions SET stop_provenance = 'none', updated_at = ?
      WHERE agent_id = ? AND stop_provenance = 'user'
    `).run(updatedAt, agentId);
    return this.require(agentId);
  }

  setWorktree(
    agentId: ThreadId,
    worktree: AgentWorktreeMetadata | null,
    updatedAt: number,
  ): SubagentExecutionRecord {
    this.db.prepare(`
      UPDATE subagent_executions SET worktree_json = ?, updated_at = ? WHERE agent_id = ?
    `).run(worktree === null ? null : JSON.stringify(worktree), updatedAt, agentId);
    return this.require(agentId);
  }

  recordTerminal(input: Omit<SubagentPendingNotification, 'state' | 'deliveredAt'>): void {
    if (this.deletedAgentIds.has(input.agentId)) return;
    const run = this.require(input.agentId);
    if (run.generation !== input.generation || run.currentTurnId !== input.turnId) return;
    this.db.prepare(`
      INSERT INTO subagent_notifications(
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
  }

  pendingForParent(parentThreadId: ThreadId): readonly SubagentPendingNotification[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_notifications
      WHERE parent_thread_id = ? AND state = 'pending'
      ORDER BY created_at, agent_id, generation
    `).all(parentThreadId) as unknown as NotificationRow[];
    return rows.map(notificationFromRow);
  }

  hasUndeliveredForParent(parentThreadId: ThreadId): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS present FROM subagent_notifications
      WHERE parent_thread_id = ? AND state <> 'delivered' LIMIT 1
    `).get(parentThreadId) as { present: number } | undefined;
    return row !== undefined;
  }

  notificationState(
    agentId: ThreadId,
    generation: number,
  ): SubagentNotificationState | null {
    const row = this.db.prepare(`
      SELECT state FROM subagent_notifications
      WHERE agent_id = ? AND generation = ?
    `).get(agentId, generation) as { state: string } | undefined;
    return row ? row.state as SubagentNotificationState : null;
  }

  parentsWithPending(): readonly ThreadId[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT parent_thread_id FROM subagent_notifications
      WHERE state = 'pending' ORDER BY parent_thread_id
    `).all() as unknown as Array<{ parent_thread_id: string }>;
    return rows.map((row) => row.parent_thread_id);
  }

  claim(agentId: ThreadId, generation: number): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_notifications SET state = 'delivering'
      WHERE agent_id = ? AND generation = ? AND state = 'pending'
    `).run(agentId, generation);
    return Number(result.changes) === 1;
  }

  release(agentId: ThreadId, generation: number): void {
    this.db.prepare(`
      UPDATE subagent_notifications SET state = 'pending'
      WHERE agent_id = ? AND generation = ? AND state = 'delivering'
    `).run(agentId, generation);
  }

  markDelivered(agentId: ThreadId, generation: number, deliveredAt: number): void {
    this.db.prepare(`
      UPDATE subagent_notifications SET state = 'delivered', delivered_at = ?
      WHERE agent_id = ? AND generation = ? AND state = 'delivering'
    `).run(deliveredAt, agentId, generation);
  }

  enqueueParentMessage(input: Omit<SubagentParentMessage, 'state' | 'deliveredAt'>): void {
    if (this.deletedAgentIds.has(input.senderAgentId)) return;
    this.db.prepare(`
      INSERT INTO subagent_parent_messages(
        id, sender_agent_id, parent_thread_id, content, delivery_mode, state, created_at, delivered_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)
      ON CONFLICT(id) DO NOTHING
    `).run(
      input.id,
      input.senderAgentId,
      input.parentThreadId,
      input.content,
      input.deliveryMode,
      input.createdAt,
    );
  }

  pendingParentMessages(parentThreadId: ThreadId): readonly SubagentParentMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_parent_messages
      WHERE parent_thread_id = ? AND state = 'pending' ORDER BY created_at, id
    `).all(parentThreadId) as unknown as ParentMessageRow[];
    return rows.map(parentMessageFromRow);
  }

  pendingForegroundParentMessages(parentThreadId: ThreadId): readonly SubagentParentMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM subagent_parent_messages
      WHERE parent_thread_id = ? AND state = 'pending' AND delivery_mode = 'foreground'
      ORDER BY created_at, id
    `).all(parentThreadId) as unknown as ParentMessageRow[];
    return rows.map(parentMessageFromRow);
  }

  parentsWithPendingMessages(): readonly ThreadId[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT parent_thread_id FROM subagent_parent_messages
      WHERE state = 'pending' ORDER BY parent_thread_id
    `).all() as unknown as Array<{ parent_thread_id: string }>;
    return rows.map((row) => row.parent_thread_id);
  }

  claimParentMessage(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE subagent_parent_messages SET state = 'delivering'
      WHERE id = ? AND state = 'pending'
    `).run(id);
    return Number(result.changes) === 1;
  }

  releaseParentMessage(id: string): void {
    this.db.prepare(`
      UPDATE subagent_parent_messages SET state = 'pending'
      WHERE id = ? AND state = 'delivering'
    `).run(id);
  }

  markParentMessageDelivered(id: string, deliveredAt: number): void {
    this.db.prepare(`
      UPDATE subagent_parent_messages SET state = 'delivered', delivered_at = ?
      WHERE id = ? AND state = 'delivering'
    `).run(deliveredAt, id);
  }

  deleteAgent(agentId: ThreadId): void {
    this.deleteAgents([agentId]);
  }

  deleteAgents(agentIds: readonly ThreadId[]): void {
    const ids = [...new Set(agentIds)];
    if (ids.length === 0) return;
    for (const agentId of ids) this.deletedAgentIds.add(agentId);
    const placeholders = ids.map(() => '?').join(', ');
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        DELETE FROM subagent_notifications
        WHERE agent_id IN (${placeholders}) OR parent_thread_id IN (${placeholders})
      `).run(...ids, ...ids);
      this.db.prepare(`
        DELETE FROM subagent_parent_messages
        WHERE sender_agent_id IN (${placeholders}) OR parent_thread_id IN (${placeholders})
      `).run(...ids, ...ids);
      this.db.prepare(`
        DELETE FROM subagent_executions
        WHERE agent_id IN (${placeholders}) OR parent_thread_id IN (${placeholders})
      `).run(...ids, ...ids);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }
}

function executionFromRow(row: ExecutionRow): SubagentExecutionRecord {
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
    toolPolicy: decodeToolPolicy(JSON.parse(row.tool_policy_json)),
    startupContext: row.startup_context_json === null
      ? null
      : decodeStartupContext(JSON.parse(row.startup_context_json)),
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
