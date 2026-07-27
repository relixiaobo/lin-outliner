import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeThreadGoal } from '../../../../core/agent/codec';
import type { AgentWritableThreadGoalStatus, ThreadGoal, ThreadGoalStatus } from '../../../../core/agent/goal';
import type { ThreadId } from '../../../../core/agent/protocol';
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

export class GoalStore {
  private readonly db: SqliteDatabase;

  constructor(path: string, database?: SqliteDatabase) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? openSqlite(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
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
    if (!normalized) throw new Error('Goal objective must be non-empty');
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1)) {
      throw new Error('Goal token budget must be a positive integer');
    }
    const existing = this.read(threadId);
    if (existing && existing.goal.status !== 'complete') {
      throw new Error('An unfinished Goal already exists for this Thread');
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
    });
    return this.read(threadId)!;
  }

  updateFromAgent(
    threadId: ThreadId,
    status: AgentWritableThreadGoalStatus,
    now = Date.now(),
  ): GoalRecord {
    if (status !== 'blocked' && status !== 'complete') throw new Error('Agents may set only blocked or complete');
    return this.setStatus(threadId, status, now);
  }

  setStatus(threadId: ThreadId, status: ThreadGoalStatus, now = Date.now()): GoalRecord {
    const current = this.read(threadId);
    if (!current) throw new Error(`Goal not found for Thread: ${threadId}`);
    const result = this.db.prepare(`
      UPDATE goals SET status = ?, updated_at = ? WHERE thread_id = ?
    `).run(status, now, threadId);
    if (result.changes !== 1) throw new Error(`Goal not found for Thread: ${threadId}`);
    if (status !== 'active') this.clearDeferral(threadId);
    return this.read(threadId)!;
  }

  addUsage(threadId: ThreadId, tokens: number, timeSeconds: number, now = Date.now()): GoalRecord {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(timeSeconds) || timeSeconds < 0) {
      throw new Error('Goal usage increments must be non-negative integers');
    }
    const current = this.read(threadId);
    if (!current) throw new Error(`Goal not found for Thread: ${threadId}`);
    const tokensUsed = current.goal.tokensUsed + tokens;
    const timeUsedSeconds = current.goal.timeUsedSeconds + timeSeconds;
    const status = current.goal.tokenBudget !== null && tokensUsed >= current.goal.tokenBudget
      ? 'budgetLimited'
      : current.goal.status;
    this.db.prepare(`
      UPDATE goals
      SET tokens_used = ?, time_used_seconds = ?, status = ?, updated_at = ?
      WHERE thread_id = ?
    `).run(tokensUsed, timeUsedSeconds, status, now, threadId);
    if (status !== 'active') this.clearDeferral(threadId);
    return this.read(threadId)!;
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
    return this.db.prepare('DELETE FROM goals WHERE thread_id = ?').run(threadId).changes === 1;
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
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
