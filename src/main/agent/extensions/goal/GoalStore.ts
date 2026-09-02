import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeThreadGoal } from '../../../../core/agent/codec';
import type { AgentWritableThreadGoalStatus, ThreadGoal, ThreadGoalStatus } from '../../../../core/agent/goal';
import type { ThreadId, TurnId, TurnStatus } from '../../../../core/agent/protocol';
import { AgentToolFailure } from '../../AgentToolFailure';
import { openSqlite, type SqliteDatabase } from '../../persistence/sqlite';

interface GoalRow {
  thread_id: string;
  generation: number;
  objective: string;
  status: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at: number;
  updated_at: number;
}

interface GoalContinuationStateRow {
  thread_id: string;
  generation: number;
  admitted_count: number;
  wrap_up_eligible: number;
  wrap_up_admitted: number;
  pending_turn_id: string | null;
  pending_kind: string | null;
}

export interface GoalRecord {
  readonly goal: ThreadGoal;
  readonly generation: number;
}

export interface GoalDeferral {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly reason: string;
  readonly createdAt: number;
}

export type GoalContinuationKind = 'normal' | 'budgetLimitedWrapUp';

export interface GoalContinuationReservation {
  readonly turnId: TurnId;
  readonly kind: GoalContinuationKind;
  readonly number: number;
}

export interface GoalContinuationState {
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly admittedCount: number;
  readonly wrapUpEligible: boolean;
  readonly wrapUpAdmitted: boolean;
  readonly pending: GoalContinuationReservation | null;
}

export class GoalStore {
  private readonly db: SqliteDatabase;

  constructor(path: string, database?: SqliteDatabase) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? openSqlite(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        thread_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN (
          'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'
        )),
        token_budget INTEGER CHECK (token_budget IS NULL OR token_budget > 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
        time_used_seconds INTEGER NOT NULL DEFAULT 0 CHECK (time_used_seconds >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS continuation_deferrals (
        thread_id TEXT PRIMARY KEY REFERENCES goals(thread_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS goal_continuation_state (
        thread_id TEXT PRIMARY KEY REFERENCES goals(thread_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL,
        admitted_count INTEGER NOT NULL DEFAULT 0 CHECK (admitted_count >= 0),
        wrap_up_eligible INTEGER NOT NULL DEFAULT 0 CHECK (wrap_up_eligible IN (0, 1)),
        wrap_up_admitted INTEGER NOT NULL DEFAULT 0 CHECK (wrap_up_admitted IN (0, 1)),
        pending_turn_id TEXT,
        pending_kind TEXT CHECK (pending_kind IS NULL OR pending_kind IN ('normal', 'budgetLimitedWrapUp')),
        CHECK ((pending_turn_id IS NULL) = (pending_kind IS NULL))
      ) STRICT;
    `);
  }

  close(): void {
    this.db.close();
  }

  read(threadId: ThreadId): GoalRecord | null {
    const row = this.db.prepare('SELECT * FROM goals WHERE thread_id = ?').get(threadId) as GoalRow | undefined;
    return row ? recordFromRow(row) : null;
  }

  create(threadId: ThreadId, objective: string, tokenBudget: number | null, now = Date.now()): GoalRecord {
    const normalized = objective.trim();
    if (!normalized) {
      throw new AgentToolFailure(
        'invalid_goal',
        'Goal objective must be non-empty',
        'Provide a non-empty objective and retry create_goal.',
      );
    }
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
      throw new AgentToolFailure(
        'invalid_goal',
        'Goal token budget must be a positive integer',
        'Provide a positive integer token_budget or omit it, then retry create_goal.',
      );
    }
    const existing = this.read(threadId);
    if (existing && existing.goal.status !== 'complete') {
      throw new AgentToolFailure(
        'goal_already_exists',
        'An unfinished Goal already exists for this Thread',
        'Call get_goal and continue the existing Goal. Complete or block it before creating another Goal.',
      );
    }
    const generation = (existing?.generation ?? 0) + 1;
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO goals(
          thread_id, generation, objective, status, token_budget,
          tokens_used, time_used_seconds, created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, 0, 0, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          generation = excluded.generation,
          objective = excluded.objective,
          status = excluded.status,
          token_budget = excluded.token_budget,
          tokens_used = 0,
          time_used_seconds = 0,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(threadId, generation, normalized, tokenBudget, now, now);
      this.db.prepare('DELETE FROM continuation_deferrals WHERE thread_id = ?').run(threadId);
      this.db.prepare(`
        INSERT INTO goal_continuation_state(
          thread_id, generation, admitted_count, wrap_up_eligible, wrap_up_admitted,
          pending_turn_id, pending_kind
        ) VALUES (?, ?, 0, 0, 0, NULL, NULL)
        ON CONFLICT(thread_id) DO UPDATE SET
          generation = excluded.generation,
          admitted_count = 0,
          wrap_up_eligible = 0,
          wrap_up_admitted = 0,
          pending_turn_id = NULL,
          pending_kind = NULL
      `).run(threadId, generation);
    });
    return this.read(threadId)!;
  }

  updateFromAgent(
    threadId: ThreadId,
    status: AgentWritableThreadGoalStatus,
    now = Date.now(),
  ): GoalRecord {
    if (status !== 'blocked' && status !== 'complete') {
      throw new AgentToolFailure(
        'invalid_goal_status',
        'Agents may set only blocked or complete',
        'Retry update_goal with status set to blocked or complete.',
      );
    }
    return this.setStatus(threadId, status, now);
  }

  setStatus(threadId: ThreadId, status: ThreadGoalStatus, now = Date.now()): GoalRecord {
    const current = this.read(threadId);
    if (!current) {
      throw new AgentToolFailure(
        'goal_not_found',
        `Goal not found for Thread: ${threadId}`,
        'Call create_goal before attempting to update the Goal.',
      );
    }
    const result = this.db.prepare(`
      UPDATE goals SET status = ?, updated_at = ? WHERE thread_id = ?
    `).run(status, now, threadId);
    if (result.changes !== 1) {
      throw new AgentToolFailure(
        'goal_not_found',
        `Goal not found for Thread: ${threadId}`,
        'Call get_goal to refresh the current state, then create a Goal if none exists.',
      );
    }
    if (status !== 'active') this.clearDeferral(threadId);
    return this.read(threadId)!;
  }

  addUsage(
    threadId: ThreadId,
    tokens: number,
    timeSeconds: number,
    now = Date.now(),
    terminalStatus: TurnStatus = 'completed',
  ): GoalRecord {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(timeSeconds) || timeSeconds < 0) {
      throw new Error('Goal usage increments must be non-negative integers');
    }
    const current = this.read(threadId);
    if (!current) throw new Error(`Goal not found for Thread: ${threadId}`);
    const tokensUsed = current.goal.tokensUsed + tokens;
    const timeUsedSeconds = current.goal.timeUsedSeconds + timeSeconds;
    const crossedBudget = current.goal.tokenBudget !== null
      && current.goal.tokensUsed < current.goal.tokenBudget
      && tokensUsed >= current.goal.tokenBudget;
    const status = current.goal.status !== 'complete'
      && current.goal.tokenBudget !== null
      && tokensUsed >= current.goal.tokenBudget
      ? 'budgetLimited'
      : current.goal.status;
    this.transaction(() => {
      this.db.prepare(`
        UPDATE goals
        SET tokens_used = ?, time_used_seconds = ?, status = ?, updated_at = ?
        WHERE thread_id = ?
      `).run(tokensUsed, timeUsedSeconds, status, now, threadId);
      if (status !== 'active') this.db.prepare('DELETE FROM continuation_deferrals WHERE thread_id = ?').run(threadId);
      if (crossedBudget && terminalStatus === 'completed' && current.goal.status !== 'complete') {
        this.db.prepare(`
          INSERT INTO goal_continuation_state(
            thread_id, generation, admitted_count, wrap_up_eligible, wrap_up_admitted,
            pending_turn_id, pending_kind
          ) VALUES (?, ?, 0, 1, 0, NULL, NULL)
          ON CONFLICT(thread_id) DO UPDATE SET
            wrap_up_eligible = CASE
              WHEN goal_continuation_state.generation = excluded.generation
                AND goal_continuation_state.wrap_up_admitted = 0
              THEN 1 ELSE goal_continuation_state.wrap_up_eligible
            END
        `).run(threadId, current.generation);
      }
    });
    return this.read(threadId)!;
  }

  readContinuationState(threadId: ThreadId): GoalContinuationState | null {
    const row = this.db.prepare(`
      SELECT * FROM goal_continuation_state WHERE thread_id = ?
    `).get(threadId) as GoalContinuationStateRow | undefined;
    return row ? continuationStateFromRow(row) : null;
  }

  reserveContinuation(
    threadId: ThreadId,
    generation: number,
    kind: GoalContinuationKind,
    turnId: TurnId,
  ): GoalContinuationReservation | null {
    return this.transaction(() => {
      const goal = this.read(threadId);
      if (!goal || goal.generation !== generation) return null;
      let state = this.readContinuationState(threadId);
      if (!state) {
        if (kind !== 'normal' || goal.goal.status !== 'active') return null;
        this.db.prepare(`
          INSERT INTO goal_continuation_state(
            thread_id, generation, admitted_count, wrap_up_eligible, wrap_up_admitted,
            pending_turn_id, pending_kind
          ) VALUES (?, ?, 0, 0, 0, NULL, NULL)
        `).run(threadId, generation);
        state = this.readContinuationState(threadId)!;
      }
      if (state.generation !== generation || state.pending) return null;
      if (kind === 'normal' && goal.goal.status !== 'active') return null;
      if (
        kind === 'budgetLimitedWrapUp'
        && (
          goal.goal.status !== 'budgetLimited'
          || !state.wrapUpEligible
          || state.wrapUpAdmitted
        )
      ) return null;
      const result = this.db.prepare(`
        UPDATE goal_continuation_state
        SET pending_turn_id = ?, pending_kind = ?
        WHERE thread_id = ? AND generation = ? AND pending_turn_id IS NULL
      `).run(turnId, kind, threadId, generation);
      return result.changes === 1
        ? { turnId, kind, number: state.admittedCount + 1 }
        : null;
    });
  }

  commitContinuation(
    threadId: ThreadId,
    generation: number,
    turnId: TurnId,
  ): GoalContinuationState | null {
    return this.transaction(() => {
      const state = this.readContinuationState(threadId);
      if (state?.generation !== generation || state.pending?.turnId !== turnId) return null;
      const wrapUp = state.pending.kind === 'budgetLimitedWrapUp';
      const result = this.db.prepare(`
        UPDATE goal_continuation_state
        SET admitted_count = admitted_count + 1,
            wrap_up_eligible = CASE WHEN ? = 1 THEN 0 ELSE wrap_up_eligible END,
            wrap_up_admitted = CASE WHEN ? = 1 THEN 1 ELSE wrap_up_admitted END,
            pending_turn_id = NULL,
            pending_kind = NULL
        WHERE thread_id = ? AND generation = ? AND pending_turn_id = ?
      `).run(wrapUp ? 1 : 0, wrapUp ? 1 : 0, threadId, generation, turnId);
      return result.changes === 1 ? this.readContinuationState(threadId) : null;
    });
  }

  releaseContinuation(threadId: ThreadId, generation: number, turnId: TurnId): boolean {
    return this.db.prepare(`
      UPDATE goal_continuation_state
      SET pending_turn_id = NULL, pending_kind = NULL
      WHERE thread_id = ? AND generation = ? AND pending_turn_id = ?
    `).run(threadId, generation, turnId).changes === 1;
  }

  deferContinuation(threadId: ThreadId, generation: number, reason: string, now = Date.now()): GoalDeferral {
    const current = this.read(threadId);
    if (!current || current.generation !== generation || current.goal.status !== 'active') {
      throw new Error('Cannot defer a stale or inactive Goal continuation');
    }
    const normalized = reason.trim();
    if (!normalized) throw new Error('Goal continuation deferral reason must be non-empty');
    this.db.prepare(`
      INSERT INTO continuation_deferrals(thread_id, generation, reason, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        generation = excluded.generation,
        reason = excluded.reason,
        created_at = excluded.created_at
    `).run(threadId, generation, normalized, now);
    return { threadId, generation, reason: normalized, createdAt: now };
  }

  readDeferral(threadId: ThreadId): GoalDeferral | null {
    const row = this.db.prepare(`
      SELECT thread_id, generation, reason, created_at
      FROM continuation_deferrals WHERE thread_id = ?
    `).get(threadId) as {
      thread_id: string;
      generation: number;
      reason: string;
      created_at: number;
    } | undefined;
    return row ? {
      threadId: row.thread_id,
      generation: row.generation,
      reason: row.reason,
      createdAt: row.created_at,
    } : null;
  }

  clearDeferral(threadId: ThreadId): void {
    this.db.prepare('DELETE FROM continuation_deferrals WHERE thread_id = ?').run(threadId);
  }

  clear(threadId: ThreadId): boolean {
    return this.transaction(() => (
      this.db.prepare('DELETE FROM goals WHERE thread_id = ?').run(threadId).changes === 1
    ));
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function continuationStateFromRow(row: GoalContinuationStateRow): GoalContinuationState {
  const pendingKind = row.pending_kind;
  if (pendingKind !== null && pendingKind !== 'normal' && pendingKind !== 'budgetLimitedWrapUp') {
    throw new Error(`Invalid Goal continuation kind: ${pendingKind}`);
  }
  return {
    threadId: row.thread_id,
    generation: row.generation,
    admittedCount: row.admitted_count,
    wrapUpEligible: row.wrap_up_eligible === 1,
    wrapUpAdmitted: row.wrap_up_admitted === 1,
    pending: row.pending_turn_id === null || pendingKind === null
      ? null
      : { turnId: row.pending_turn_id, kind: pendingKind, number: row.admitted_count + 1 },
  };
}

function recordFromRow(row: GoalRow): GoalRecord {
  return {
    generation: row.generation,
    goal: decodeThreadGoal({
      threadId: row.thread_id,
      objective: row.objective,
      status: row.status,
      tokenBudget: row.token_budget,
      tokensUsed: row.tokens_used,
      timeUsedSeconds: row.time_used_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  };
}
