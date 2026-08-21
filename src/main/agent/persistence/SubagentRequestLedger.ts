import type { ThreadId, TurnId } from '../../../core/agent/protocol';
import type { SqliteDatabase } from './sqlite';

export const MAX_SUBAGENT_DEPTH = 3;
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20;

interface SubagentRequestRow {
  origin_turn_id: string;
  origin_thread_id: string;
  closed_at: number | null;
}

interface SubagentRequestChildRow {
  thread_id: string;
  origin_turn_id: string;
}

/** One delegating Turn's cancellation ownership record. */
export interface SubagentRequest {
  readonly originTurnId: TurnId;
  readonly originThreadId: ThreadId;
  readonly closedAt: number | null;
}

/** One direct child owned by the Turn that delegated it. */
export interface SubagentRequestChild {
  readonly threadId: ThreadId;
  readonly originTurnId: TurnId;
}

export interface CreateSubagentRequestInput {
  readonly originTurnId: TurnId;
  readonly originThreadId: ThreadId;
}

export interface CreateSubagentRequestChildInput {
  readonly threadId: ThreadId;
  readonly originTurnId: TurnId;
}

export interface CreateSubagentRequestAdmissionInput {
  readonly request: CreateSubagentRequestInput;
  readonly child: CreateSubagentRequestChildInput;
}

/**
 * Cancellation ownership for delegated work.
 *
 * Token accounting deliberately does not live here. A request may own a whole
 * descendant set for Stop while every execution generation has an independent
 * breaker in the execution ledger.
 */
export class SubagentRequestLedger {
  private readonly ephemeralRequests = new Map<TurnId, SubagentRequest>();
  private readonly ephemeralChildren = new Map<ThreadId, SubagentRequestChild>();

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(`
      DROP TABLE IF EXISTS thread_budgets;
      DROP TABLE IF EXISTS subagent_budget_pools;
      DROP TABLE IF EXISTS subagent_budget_members;
      DROP TABLE IF EXISTS subagent_turn_budget_pools;
      DROP TABLE IF EXISTS subagent_turn_budget_members;
      DROP TABLE IF EXISTS subagent_request_pools;
      DROP TABLE IF EXISTS subagent_request_members;
      CREATE TABLE IF NOT EXISTS subagent_request_owners (
        origin_turn_id TEXT PRIMARY KEY,
        origin_thread_id TEXT NOT NULL,
        closed_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_request_owners_thread_idx
        ON subagent_request_owners(origin_thread_id);
      CREATE TABLE IF NOT EXISTS subagent_request_children (
        thread_id TEXT PRIMARY KEY,
        origin_turn_id TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_request_children_origin_idx
        ON subagent_request_children(origin_turn_id);
    `);
  }

  readRequest(originTurnId: TurnId): SubagentRequest | null {
    return this.ephemeralRequests.get(originTurnId) ?? this.readPersistedRequest(originTurnId);
  }

  readChild(threadId: ThreadId): SubagentRequestChild | null {
    return this.ephemeralChildren.get(threadId) ?? this.readPersistedChild(threadId);
  }

  childrenForOriginTurn(originTurnId: TurnId): readonly SubagentRequestChild[] {
    const ephemeral = [...this.ephemeralChildren.values()]
      .filter((child) => child.originTurnId === originTurnId);
    const rows = this.db.prepare(`
      SELECT thread_id, origin_turn_id
      FROM subagent_request_children WHERE origin_turn_id = ?
    `).all(originTurnId) as unknown as SubagentRequestChildRow[];
    return [...ephemeral, ...rows.map(childFromRow)];
  }

  createAdmission(
    input: CreateSubagentRequestAdmissionInput,
    ephemeral: boolean,
  ): { readonly request: SubagentRequest; readonly child: SubagentRequestChild } {
    if (input.child.originTurnId !== input.request.originTurnId) {
      throw new Error('Subagent request child does not match its owning Turn');
    }
    const request = {
      ...input.request,
      closedAt: null,
    } satisfies SubagentRequest;
    const child = { ...input.child } satisfies SubagentRequestChild;

    if (ephemeral) {
      const existing = this.ephemeralRequests.get(request.originTurnId);
      if (existing && existing.originThreadId !== request.originThreadId) {
        throw new Error(`Subagent request owner does not match: ${request.originTurnId}`);
      }
      if (this.ephemeralChildren.has(child.threadId)) {
        throw new Error(`Subagent request child already exists: ${child.threadId}`);
      }
      this.ephemeralRequests.set(request.originTurnId, existing ?? request);
      this.ephemeralChildren.set(child.threadId, child);
      return { request: existing ?? request, child };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare(`
        INSERT INTO subagent_request_owners(origin_turn_id, origin_thread_id, closed_at)
        VALUES (?, ?, NULL)
        ON CONFLICT(origin_turn_id) DO NOTHING
      `).run(request.originTurnId, request.originThreadId);
      const persisted = this.readPersistedRequest(request.originTurnId);
      if (!persisted || persisted.originThreadId !== request.originThreadId) {
        throw new Error(`Subagent request owner does not match: ${request.originTurnId}`);
      }
      this.db.prepare(`
        INSERT INTO subagent_request_children(thread_id, origin_turn_id)
        VALUES (?, ?)
      `).run(child.threadId, child.originTurnId);
      this.db.exec('COMMIT;');
      return { request: persisted, child };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  closeRequest(originTurnId: TurnId, closedAt: number): SubagentRequest | null {
    const ephemeral = this.ephemeralRequests.get(originTurnId);
    if (ephemeral) {
      const closed = { ...ephemeral, closedAt };
      this.ephemeralRequests.set(originTurnId, closed);
      return closed;
    }
    const request = this.readPersistedRequest(originTurnId);
    if (!request) return null;
    this.db.prepare(`
      UPDATE subagent_request_owners SET closed_at = ? WHERE origin_turn_id = ?
    `).run(closedAt, originTurnId);
    return { ...request, closedAt };
  }

  deleteChild(threadId: ThreadId): boolean {
    const ephemeral = this.ephemeralChildren.delete(threadId);
    const persisted = this.db.prepare(
      'DELETE FROM subagent_request_children WHERE thread_id = ?',
    ).run(threadId).changes;
    return ephemeral || Number(persisted) > 0;
  }

  deleteRequestIfEmpty(originTurnId: TurnId): boolean {
    const ephemeralHasChild = [...this.ephemeralChildren.values()]
      .some((child) => child.originTurnId === originTurnId);
    const ephemeral = !ephemeralHasChild && this.ephemeralRequests.delete(originTurnId);
    const persisted = this.db.prepare(`
      DELETE FROM subagent_request_owners
      WHERE origin_turn_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM subagent_request_children child
          WHERE child.origin_turn_id = subagent_request_owners.origin_turn_id
        )
    `).run(originTurnId).changes;
    return ephemeral || Number(persisted) > 0;
  }

  clearThread(threadId: ThreadId): boolean {
    const ephemeralChild = this.ephemeralChildren.delete(threadId);
    let ephemeralRequest = false;
    for (const [originTurnId, request] of [...this.ephemeralRequests]) {
      if (request.originThreadId !== threadId) continue;
      ephemeralRequest = true;
      this.ephemeralRequests.delete(originTurnId);
      for (const [childId, child] of [...this.ephemeralChildren]) {
        if (child.originTurnId === originTurnId) this.ephemeralChildren.delete(childId);
      }
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const childChanges = this.db.prepare(`
        DELETE FROM subagent_request_children
        WHERE thread_id = ?
           OR origin_turn_id IN (
             SELECT origin_turn_id FROM subagent_request_owners WHERE origin_thread_id = ?
           )
      `).run(threadId, threadId).changes;
      const requestChanges = this.db.prepare(`
        DELETE FROM subagent_request_owners WHERE origin_thread_id = ?
      `).run(threadId).changes;
      this.db.exec('COMMIT;');
      return ephemeralChild
        || ephemeralRequest
        || Number(childChanges) > 0
        || Number(requestChanges) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  clearThreadsForRecovery(threadIdsInput: readonly ThreadId[]): boolean {
    const threadIds = [...new Set(threadIdsInput)];
    if (threadIds.length === 0) return false;
    const selected = new Set(threadIds);
    let ephemeralChanged = false;
    for (const threadId of threadIds) {
      ephemeralChanged = this.ephemeralChildren.delete(threadId) || ephemeralChanged;
    }
    for (const [originTurnId, request] of [...this.ephemeralRequests]) {
      if (selected.has(request.originThreadId)) {
        ephemeralChanged = this.ephemeralRequests.delete(originTurnId) || ephemeralChanged;
        for (const [childId, child] of [...this.ephemeralChildren]) {
          if (child.originTurnId === originTurnId) this.ephemeralChildren.delete(childId);
        }
        continue;
      }
      const hasChild = [...this.ephemeralChildren.values()]
        .some((child) => child.originTurnId === originTurnId);
      if (!hasChild) ephemeralChanged = this.ephemeralRequests.delete(originTurnId) || ephemeralChanged;
    }

    const placeholders = threadIds.map(() => '?').join(', ');
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const childChanges = this.db.prepare(`
        DELETE FROM subagent_request_children
        WHERE thread_id IN (${placeholders})
           OR origin_turn_id IN (
             SELECT origin_turn_id FROM subagent_request_owners
             WHERE origin_thread_id IN (${placeholders})
           )
      `).run(...threadIds, ...threadIds).changes;
      const requestChanges = this.db.prepare(`
        DELETE FROM subagent_request_owners
        WHERE origin_thread_id IN (${placeholders})
           OR NOT EXISTS (
             SELECT 1 FROM subagent_request_children child
             WHERE child.origin_turn_id = subagent_request_owners.origin_turn_id
           )
      `).run(...threadIds).changes;
      this.db.exec('COMMIT;');
      return ephemeralChanged || Number(childChanges) > 0 || Number(requestChanges) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private readPersistedRequest(originTurnId: TurnId): SubagentRequest | null {
    const row = this.db.prepare(`
      SELECT origin_turn_id, origin_thread_id, closed_at
      FROM subagent_request_owners WHERE origin_turn_id = ?
    `).get(originTurnId) as SubagentRequestRow | undefined;
    return row ? requestFromRow(row) : null;
  }

  private readPersistedChild(threadId: ThreadId): SubagentRequestChild | null {
    const row = this.db.prepare(`
      SELECT thread_id, origin_turn_id
      FROM subagent_request_children WHERE thread_id = ?
    `).get(threadId) as SubagentRequestChildRow | undefined;
    return row ? childFromRow(row) : null;
  }
}

function requestFromRow(row: SubagentRequestRow): SubagentRequest {
  return {
    originTurnId: row.origin_turn_id,
    originThreadId: row.origin_thread_id,
    closedAt: row.closed_at,
  };
}

function childFromRow(row: SubagentRequestChildRow): SubagentRequestChild {
  return {
    threadId: row.thread_id,
    originTurnId: row.origin_turn_id,
  };
}
