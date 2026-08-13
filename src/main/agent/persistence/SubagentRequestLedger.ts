import type { ThreadId, TurnId } from '../../../core/agent/protocol';
import type { SqliteDatabase } from './sqlite';

/**
 * The smallest per-child cap a model can actually impose.
 *
 * `max_total_tokens` is a circuit breaker sized at definitely-anomalous, not an
 * allocation — but it is model-chosen, and a model guessing at one guesses low.
 * Caps in the thousands starved children mid-answer and handed the parent a
 * refusal instead of the work it delegated. A cap below this describes no real
 * budget and is DROPPED, which returns the child to its request's shared pool;
 * raising it instead would give every capped child a private pool of this size
 * and step over the `subagentTokenBudget` the user configured.
 */
export const MIN_SUBAGENT_TOKEN_CAP = 1_000_000;

export const MAX_SUBAGENT_DEPTH = 3;
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20;

/**
 * A pool key. A delegating Turn owns one request pool, named by that Turn; an
 * explicit `max_total_tokens` with no ancestor pool additionally anchors a
 * capped pool at the child it bounds, so the cap keeps applying to that child's
 * own descendants.
 */
export type SubagentRequestPoolId = string;

export type SubagentRequestPoolScope = 'turn' | 'thread';

interface SubagentRequestPoolRow {
  pool_id: string;
  scope: string;
  origin_thread_id: string;
  origin_turn_id: string;
  token_budget: number | null;
  closed_at: number | null;
  tokens_used: number;
}

interface SubagentRequestMemberRow {
  thread_id: string;
  pool_id: string | null;
  origin_turn_id: string;
  token_cap: number | null;
  tokens_used: number;
}

export interface SubagentRequestPool {
  readonly poolId: SubagentRequestPoolId;
  readonly scope: SubagentRequestPoolScope;
  /** The Thread that ran the originating Turn, or the capped child it anchors. */
  readonly originThreadId: ThreadId;
  readonly originTurnId: TurnId;
  /** `null` means this request is unbounded, not that it has no identity. */
  readonly tokenBudget: number | null;
  /** When the user stopped this request; `null` while it is open. */
  readonly closedAt: number | null;
  readonly tokensUsed: number;
}

export interface SubagentRequestMember {
  readonly threadId: ThreadId;
  readonly poolId: SubagentRequestPoolId | null;
  /** The delegating Turn that owns this Thread's spend. */
  readonly originTurnId: TurnId;
  readonly tokenCap: number | null;
  readonly tokensUsed: number;
}

export interface CreateSubagentRequestPoolInput {
  readonly poolId: SubagentRequestPoolId;
  readonly scope: SubagentRequestPoolScope;
  readonly originThreadId: ThreadId;
  readonly originTurnId: TurnId;
  readonly tokenBudget: number | null;
}

export interface CreateSubagentRequestMemberInput {
  readonly threadId: ThreadId;
  readonly poolId: SubagentRequestPoolId | null;
  readonly originTurnId: TurnId;
  readonly tokenCap: number | null;
}

export interface CreateSubagentRequestAdmissionInput {
  readonly pools: readonly CreateSubagentRequestPoolInput[];
  readonly member: CreateSubagentRequestMemberInput;
}

/** The request one delegating Turn owns. */
export function requestPoolIdForTurn(turnId: TurnId): SubagentRequestPoolId {
  return `turn:${turnId}`;
}

/** The pool an explicit `max_total_tokens` anchors at the child it caps. */
export function cappedChildPoolId(threadId: ThreadId): SubagentRequestPoolId {
  return `thread:${threadId}`;
}

export class SubagentRequestLedger {
  private readonly ephemeralPools = new Map<SubagentRequestPoolId, SubagentRequestPool>();
  private readonly ephemeralMembers = new Map<ThreadId, SubagentRequestMember>();

  constructor(private readonly db: SqliteDatabase) {
    // Pre-release clean cut, the same way `thread_budgets` and the Thread-keyed
    // tables were retired: old names are dropped and the new shape gets new
    // names, so there is no legacy reader and no shape sniffing. The rename is
    // forced rather than cosmetic — `token_budget` becomes nullable, which
    // `CREATE TABLE IF NOT EXISTS` cannot apply to an existing table — and the
    // name follows the concept: the row is the REQUEST, and a budget is one
    // optional attribute of it.
    this.db.exec(`
      DROP TABLE IF EXISTS thread_budgets;
      DROP TABLE IF EXISTS subagent_budget_pools;
      DROP TABLE IF EXISTS subagent_budget_members;
      DROP TABLE IF EXISTS subagent_turn_budget_pools;
      DROP TABLE IF EXISTS subagent_turn_budget_members;
      CREATE TABLE IF NOT EXISTS subagent_request_pools (
        pool_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('turn', 'thread')),
        origin_thread_id TEXT NOT NULL,
        origin_turn_id TEXT NOT NULL,
        token_budget INTEGER CHECK (token_budget IS NULL OR token_budget > 0),
        closed_at INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_request_pools_origin_idx
        ON subagent_request_pools(origin_thread_id);
      CREATE TABLE IF NOT EXISTS subagent_request_members (
        thread_id TEXT PRIMARY KEY,
        pool_id TEXT,
        origin_turn_id TEXT NOT NULL,
        token_cap INTEGER CHECK (token_cap IS NULL OR token_cap > 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_request_members_pool_idx
        ON subagent_request_members(pool_id);
      CREATE INDEX IF NOT EXISTS subagent_request_members_origin_turn_idx
        ON subagent_request_members(origin_turn_id);
    `);
  }

  readPool(poolId: SubagentRequestPoolId): SubagentRequestPool | null {
    return this.ephemeralPools.get(poolId) ?? this.readPersistedPool(poolId);
  }

  readMember(threadId: ThreadId): SubagentRequestMember | null {
    return this.ephemeralMembers.get(threadId) ?? this.readPersistedMember(threadId);
  }

  /**
   * Everything one delegating Turn owns, read by provenance rather than by
   * spend binding. A capped child binds its spend to its own pool, so pool
   * membership would miss it — `originTurnId` is the ownership record, and it
   * is what Stop closes a request over.
   */
  membersForOriginTurn(turnId: TurnId): readonly SubagentRequestMember[] {
    const ephemeral = [...this.ephemeralMembers.values()].filter((member) => member.originTurnId === turnId);
    const rows = this.db.prepare(`
      SELECT thread_id, pool_id, origin_turn_id, token_cap, tokens_used
      FROM subagent_request_members WHERE origin_turn_id = ?
    `).all(turnId) as unknown as SubagentRequestMemberRow[];
    return [...ephemeral, ...rows.map(memberFromRow)];
  }

  /**
   * Close a request. Admission reads this; nothing else changes, so a closed
   * request still accrues the spend of work already in flight and is reclaimed
   * by the ordinary path once its members settle.
   */
  closePool(poolId: SubagentRequestPoolId, closedAt: number): SubagentRequestPool | null {
    const ephemeral = this.ephemeralPools.get(poolId);
    if (ephemeral) {
      const closed = { ...ephemeral, closedAt };
      this.ephemeralPools.set(poolId, closed);
      return closed;
    }
    const pool = this.readPersistedPool(poolId);
    if (!pool) return null;
    this.db.prepare('UPDATE subagent_request_pools SET closed_at = ? WHERE pool_id = ?').run(closedAt, poolId);
    return { ...pool, closedAt };
  }

  membersForPool(poolId: SubagentRequestPoolId): readonly SubagentRequestMember[] {
    const ephemeral = [...this.ephemeralMembers.values()].filter((member) => member.poolId === poolId);
    const rows = this.db.prepare(`
      SELECT thread_id, pool_id, origin_turn_id, token_cap, tokens_used
      FROM subagent_request_members WHERE pool_id = ?
    `).all(poolId) as unknown as SubagentRequestMemberRow[];
    return [...ephemeral, ...rows.map(memberFromRow)];
  }

  createPool(input: CreateSubagentRequestPoolInput, ephemeral: boolean): SubagentRequestPool {
    if (input.tokenBudget !== null) positiveSafeInteger(input.tokenBudget, 'Subagent token pool');
    const record = { ...input, closedAt: null, tokensUsed: 0 } satisfies SubagentRequestPool;
    if (ephemeral) {
      if (this.ephemeralPools.has(input.poolId)) throw new Error(`Subagent token pool already exists: ${input.poolId}`);
      this.ephemeralPools.set(input.poolId, record);
      return record;
    }
    this.db.prepare(`
      INSERT INTO subagent_request_pools(
        pool_id, scope, origin_thread_id, origin_turn_id, token_budget, closed_at, tokens_used
      ) VALUES (?, ?, ?, ?, ?, NULL, 0)
    `).run(input.poolId, input.scope, input.originThreadId, input.originTurnId, input.tokenBudget);
    return record;
  }

  createMember(input: CreateSubagentRequestMemberInput, ephemeral: boolean): SubagentRequestMember {
    if (input.tokenCap !== null) positiveSafeInteger(input.tokenCap, 'Subagent token cap');
    if (input.poolId !== null && !this.readPool(input.poolId)) {
      throw new Error(`Subagent token pool not found: ${input.poolId}`);
    }
    const record = { ...input, tokensUsed: 0 } satisfies SubagentRequestMember;
    if (ephemeral) {
      if (this.ephemeralMembers.has(input.threadId)) throw new Error(`Subagent budget member already exists: ${input.threadId}`);
      this.ephemeralMembers.set(input.threadId, record);
      return record;
    }
    this.db.prepare(`
      INSERT INTO subagent_request_members(thread_id, pool_id, origin_turn_id, token_cap, tokens_used)
      VALUES (?, ?, ?, ?, 0)
    `).run(input.threadId, input.poolId, input.originTurnId, input.tokenCap);
    return record;
  }

  /** Commits every new pool and the child membership as one admission write. */
  createAdmission(
    input: CreateSubagentRequestAdmissionInput,
    ephemeral: boolean,
  ): {
    readonly pools: readonly SubagentRequestPool[];
    readonly member: SubagentRequestMember;
  } {
    const pools = input.pools.map((pool) => this.poolRecord(pool));
    const poolIds = new Set(pools.map((pool) => pool.poolId));
    if (poolIds.size !== pools.length) throw new Error('Subagent request admission contains duplicate pools');
    const member = this.memberRecord(input.member);
    if (
      member.poolId !== null
      && !poolIds.has(member.poolId)
      && !this.readPool(member.poolId)
    ) {
      throw new Error(`Subagent token pool not found: ${member.poolId}`);
    }
    if (ephemeral) {
      for (const pool of pools) {
        if (this.ephemeralPools.has(pool.poolId)) {
          throw new Error(`Subagent token pool already exists: ${pool.poolId}`);
        }
      }
      if (this.ephemeralMembers.has(member.threadId)) {
        throw new Error(`Subagent budget member already exists: ${member.threadId}`);
      }
      for (const pool of pools) this.ephemeralPools.set(pool.poolId, pool);
      this.ephemeralMembers.set(member.threadId, member);
      return { pools, member };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const pool of pools) this.insertPersistedPool(pool);
      this.insertPersistedMember(member);
      this.db.exec('COMMIT;');
      return { pools, member };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  /**
   * Correct a member's pool binding. `originTurnId` moves with it: a Thread
   * re-driven by a later delegation belongs to that request, and a stale
   * originating Turn would otherwise keep healing the binding backwards.
   */
  rebindMemberPool(
    threadId: ThreadId,
    poolId: SubagentRequestPoolId | null,
    originTurnId?: TurnId,
  ): SubagentRequestMember | null {
    const ephemeral = this.ephemeralMembers.get(threadId);
    if (ephemeral) {
      const rebound = {
        ...ephemeral,
        poolId,
        ...(originTurnId === undefined ? {} : { originTurnId }),
      };
      this.ephemeralMembers.set(threadId, rebound);
      return rebound;
    }
    const member = this.readPersistedMember(threadId);
    if (!member) return null;
    const nextOriginTurnId = originTurnId ?? member.originTurnId;
    const result = this.db.prepare(`
      UPDATE subagent_request_members SET pool_id = ?, origin_turn_id = ? WHERE thread_id = ?
    `).run(poolId, nextOriginTurnId, threadId);
    if (result.changes !== 1) return null;
    return { ...member, poolId, originTurnId: nextOriginTurnId };
  }

  deleteMember(threadId: ThreadId): boolean {
    const ephemeralMember = this.ephemeralMembers.delete(threadId);
    const persistedChanges = this.db.prepare(
      'DELETE FROM subagent_request_members WHERE thread_id = ?',
    ).run(threadId).changes;
    return ephemeralMember || Number(persistedChanges) > 0;
  }

  deletePoolRecord(poolId: SubagentRequestPoolId): boolean {
    const ephemeralPool = this.ephemeralPools.delete(poolId);
    const persistedChanges = this.db.prepare(
      'DELETE FROM subagent_request_pools WHERE pool_id = ?',
    ).run(poolId).changes;
    return ephemeralPool || Number(persistedChanges) > 0;
  }

  /**
   * Reclaim a settled Turn pool: the pool row goes, the membership rows stay
   * unbound. Members are kept for two reasons — a cap is a per-Thread lifetime
   * constraint that must survive its pool, and the recorded contribution is the
   * only remaining account of what a child actually spent, which the
   * collaboration views still report after its request is over.
   */
  reapPool(poolId: SubagentRequestPoolId): void {
    for (const member of this.membersForPool(poolId)) {
      this.rebindMemberPool(member.threadId, null);
    }
    this.deletePoolRecord(poolId);
  }

  addUsage(
    threadId: ThreadId,
    poolId: SubagentRequestPoolId | null,
    tokens: number,
  ): { readonly member: SubagentRequestMember | null; readonly pool: SubagentRequestPool | null } | null {
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error('Subagent budget usage increment must be a non-negative integer');
    }
    const ephemeralMember = this.ephemeralMembers.get(threadId) ?? null;
    const ephemeralPool = poolId === null ? null : this.ephemeralPools.get(poolId) ?? null;
    if (ephemeralMember || ephemeralPool) {
      return this.addEphemeralUsage(ephemeralMember, ephemeralPool, poolId, tokens);
    }
    let member = this.readPersistedMember(threadId);
    if (member && member.poolId !== poolId) {
      member = this.rebindMemberPool(threadId, poolId);
    }
    const pool = poolId === null ? null : this.readPersistedPool(poolId);
    if (!member && !pool) return null;
    if (tokens === 0) {
      return { member, pool };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const updatedMember = member
        ? { ...member, tokensUsed: checkedTotal(member.tokensUsed, tokens) }
        : null;
      if (updatedMember) {
        const memberResult = this.db.prepare(`
          UPDATE subagent_request_members SET tokens_used = ? WHERE thread_id = ?
        `).run(updatedMember.tokensUsed, threadId);
        if (memberResult.changes !== 1) throw new Error(`Subagent budget member not found: ${threadId}`);
      }
      const updatedPool = poolId === null ? null : this.addPersistedPoolUsage(poolId, tokens);
      this.db.exec('COMMIT;');
      return { member: updatedMember, pool: updatedPool };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  /**
   * Thread-entity cleanup: the Thread's own membership, plus every pool it
   * originated and that pool's remaining members. The subtree cascade calls this
   * for each deleted descendant, so a pool never outlives the Thread that owns it.
   */
  clearThread(threadId: ThreadId): boolean {
    const ephemeralMember = this.ephemeralMembers.delete(threadId);
    let ephemeralPool = false;
    for (const [poolId, pool] of [...this.ephemeralPools]) {
      if (pool.originThreadId !== threadId) continue;
      ephemeralPool = true;
      this.ephemeralPools.delete(poolId);
      for (const [memberThreadId, member] of [...this.ephemeralMembers]) {
        if (member.poolId === poolId) this.ephemeralMembers.delete(memberThreadId);
      }
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const memberChanges = this.db.prepare(`
        DELETE FROM subagent_request_members
        WHERE thread_id = ?
           OR pool_id IN (SELECT pool_id FROM subagent_request_pools WHERE origin_thread_id = ?)
      `).run(threadId, threadId).changes;
      const poolChanges = this.db.prepare(
        'DELETE FROM subagent_request_pools WHERE origin_thread_id = ?',
      ).run(threadId).changes;
      this.db.exec('COMMIT;');
      return ephemeralMember
        || ephemeralPool
        || Number(memberChanges) > 0
        || Number(poolChanges) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  /**
   * Startup recovery removes a subtree's members and newly empty shared pools
   * in one transaction, so an interrupted cleanup remains fully retryable.
   */
  clearThreadsForRecovery(threadIdsInput: readonly ThreadId[]): boolean {
    const threadIds = [...new Set(threadIdsInput)];
    if (threadIds.length === 0) return false;
    const selected = new Set(threadIds);
    const selectedEphemeralMembers = [...this.ephemeralMembers.values()]
      .filter((member) => selected.has(member.threadId));
    const affectedEphemeralPoolIds = new Set<SubagentRequestPoolId>([
      ...selectedEphemeralMembers.flatMap((member) => member.poolId === null ? [] : [member.poolId]),
      ...selectedEphemeralMembers.map((member) => requestPoolIdForTurn(member.originTurnId)),
      ...[...this.ephemeralPools.values()]
        .filter((pool) => selected.has(pool.originThreadId))
        .map((pool) => pool.poolId),
    ]);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const readMember = this.db.prepare(`
        SELECT pool_id, origin_turn_id FROM subagent_request_members WHERE thread_id = ?
      `);
      const readOriginatedPools = this.db.prepare(`
        SELECT pool_id FROM subagent_request_pools WHERE origin_thread_id = ?
      `);
      const deleteMember = this.db.prepare(
        'DELETE FROM subagent_request_members WHERE thread_id = ?',
      );
      const selectedMemberRows: Array<{
        pool_id: string | null;
        origin_turn_id: string;
      }> = [];
      const originatedPoolRows: Array<{ pool_id: string }> = [];
      let memberChanges = 0;
      for (const threadId of threadIds) {
        const member = readMember.get(threadId) as {
          pool_id: string | null;
          origin_turn_id: string;
        } | undefined;
        if (member) selectedMemberRows.push(member);
        originatedPoolRows.push(...readOriginatedPools.all(threadId) as unknown as Array<{ pool_id: string }>);
        memberChanges += Number(deleteMember.run(threadId).changes);
      }
      const affectedPoolIds = new Set<SubagentRequestPoolId>([
        ...selectedMemberRows.flatMap((row) => row.pool_id === null ? [] : [row.pool_id]),
        ...selectedMemberRows.map((row) => requestPoolIdForTurn(row.origin_turn_id)),
        ...originatedPoolRows.map((row) => row.pool_id),
      ]);
      let poolChanges = 0;
      for (const poolId of affectedPoolIds) {
        poolChanges += Number(this.db.prepare(`
          DELETE FROM subagent_request_pools
          WHERE pool_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM subagent_request_members member
              WHERE CASE subagent_request_pools.scope
                WHEN 'turn' THEN member.origin_turn_id = subagent_request_pools.origin_turn_id
                  OR member.pool_id = subagent_request_pools.pool_id
                ELSE member.pool_id = subagent_request_pools.pool_id
              END
            )
        `).run(poolId).changes);
      }
      this.db.exec('COMMIT;');
      let ephemeralChanged = false;
      for (const threadId of threadIds) {
        ephemeralChanged = this.ephemeralMembers.delete(threadId) || ephemeralChanged;
      }
      for (const poolId of affectedEphemeralPoolIds) {
        const pool = this.ephemeralPools.get(poolId);
        if (!pool) continue;
        const hasMember = [...this.ephemeralMembers.values()].some((member) => (
          pool.scope === 'turn'
            ? member.originTurnId === pool.originTurnId || member.poolId === poolId
            : member.poolId === poolId
        ));
        if (hasMember) continue;
        ephemeralChanged = this.ephemeralPools.delete(poolId) || ephemeralChanged;
      }
      return ephemeralChanged
        || memberChanges > 0
        || poolChanges > 0;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private addEphemeralUsage(
    member: SubagentRequestMember | null,
    pool: SubagentRequestPool | null,
    poolId: SubagentRequestPoolId | null,
    tokens: number,
  ): { readonly member: SubagentRequestMember | null; readonly pool: SubagentRequestPool | null } {
    if (member && member.poolId !== poolId) {
      member = this.rebindMemberPool(member.threadId, poolId);
    }
    if (!member && !pool) throw new Error('Ephemeral Subagent budget record not found');
    if (tokens === 0) {
      return { member, pool };
    }
    const updatedMember = member
      ? { ...member, tokensUsed: checkedTotal(member.tokensUsed, tokens) }
      : null;
    if (updatedMember) this.ephemeralMembers.set(updatedMember.threadId, updatedMember);
    if (poolId === null) return { member: updatedMember, pool: null };
    if (!pool) throw new Error(`Subagent token pool not found: ${poolId}`);
    const updatedPool = { ...pool, tokensUsed: checkedTotal(pool.tokensUsed, tokens) };
    this.ephemeralPools.set(poolId, updatedPool);
    return { member: updatedMember, pool: updatedPool };
  }

  private addPersistedPoolUsage(poolId: SubagentRequestPoolId, tokens: number): SubagentRequestPool {
    const pool = this.readPersistedPool(poolId);
    if (!pool) throw new Error(`Subagent token pool not found: ${poolId}`);
    const tokensUsed = checkedTotal(pool.tokensUsed, tokens);
    const result = this.db.prepare(`
      UPDATE subagent_request_pools SET tokens_used = ? WHERE pool_id = ?
    `).run(tokensUsed, poolId);
    if (result.changes !== 1) throw new Error(`Subagent token pool not found: ${poolId}`);
    return { ...pool, tokensUsed };
  }

  private poolRecord(input: CreateSubagentRequestPoolInput): SubagentRequestPool {
    if (input.tokenBudget !== null) positiveSafeInteger(input.tokenBudget, 'Subagent token pool');
    return { ...input, closedAt: null, tokensUsed: 0 };
  }

  private memberRecord(input: CreateSubagentRequestMemberInput): SubagentRequestMember {
    if (input.tokenCap !== null) positiveSafeInteger(input.tokenCap, 'Subagent token cap');
    return { ...input, tokensUsed: 0 };
  }

  private insertPersistedPool(pool: SubagentRequestPool): void {
    this.db.prepare(`
      INSERT INTO subagent_request_pools(
        pool_id, scope, origin_thread_id, origin_turn_id, token_budget, closed_at, tokens_used
      ) VALUES (?, ?, ?, ?, ?, NULL, 0)
    `).run(pool.poolId, pool.scope, pool.originThreadId, pool.originTurnId, pool.tokenBudget);
  }

  private insertPersistedMember(member: SubagentRequestMember): void {
    this.db.prepare(`
      INSERT INTO subagent_request_members(thread_id, pool_id, origin_turn_id, token_cap, tokens_used)
      VALUES (?, ?, ?, ?, 0)
    `).run(member.threadId, member.poolId, member.originTurnId, member.tokenCap);
  }

  private readPersistedPool(poolId: SubagentRequestPoolId): SubagentRequestPool | null {
    const row = this.db.prepare(`
      SELECT pool_id, scope, origin_thread_id, origin_turn_id, token_budget, closed_at, tokens_used
      FROM subagent_request_pools WHERE pool_id = ?
    `).get(poolId) as SubagentRequestPoolRow | undefined;
    return row ? poolFromRow(row) : null;
  }

  private readPersistedMember(threadId: ThreadId): SubagentRequestMember | null {
    const row = this.db.prepare(`
      SELECT thread_id, pool_id, origin_turn_id, token_cap, tokens_used
      FROM subagent_request_members WHERE thread_id = ?
    `).get(threadId) as SubagentRequestMemberRow | undefined;
    return row ? memberFromRow(row) : null;
  }

}

function poolFromRow(row: SubagentRequestPoolRow): SubagentRequestPool {
  return {
    poolId: row.pool_id,
    scope: row.scope === 'thread' ? 'thread' : 'turn',
    originThreadId: row.origin_thread_id,
    originTurnId: row.origin_turn_id,
    tokenBudget: row.token_budget,
    closedAt: row.closed_at,
    tokensUsed: row.tokens_used,
  };
}

function memberFromRow(row: SubagentRequestMemberRow): SubagentRequestMember {
  return {
    threadId: row.thread_id,
    poolId: row.pool_id,
    originTurnId: row.origin_turn_id,
    tokenCap: row.token_cap,
    tokensUsed: row.tokens_used,
  };
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function checkedTotal(tokensUsed: number, increment: number): number {
  const total = tokensUsed + increment;
  if (!Number.isSafeInteger(total)) throw new Error('Subagent budget usage exceeds the safe integer range');
  return total;
}
