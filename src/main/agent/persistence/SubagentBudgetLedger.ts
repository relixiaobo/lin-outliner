import type { ThreadId } from '../../../core/agent/protocol';
import type { SqliteDatabase } from './sqlite';

export const MAX_SUBAGENT_DEPTH = 2;
export const MAX_SUBAGENT_SPAWNS_PER_THREAD = 16;

interface SubagentBudgetPoolRow {
  pool_thread_id: string;
  token_budget: number;
  tokens_used: number;
}

interface SubagentBudgetMemberRow {
  thread_id: string;
  pool_thread_id: string | null;
  token_cap: number | null;
  tokens_used: number;
}

interface SubagentSpawnCountRow {
  spawn_count: number;
}

export interface SubagentBudgetPool {
  readonly poolThreadId: ThreadId;
  readonly tokenBudget: number;
  readonly tokensUsed: number;
}

export interface SubagentBudgetMember {
  readonly threadId: ThreadId;
  readonly poolThreadId: ThreadId | null;
  readonly tokenCap: number | null;
  readonly tokensUsed: number;
}

export class SubagentBudgetLedger {
  private readonly ephemeralPools = new Map<ThreadId, SubagentBudgetPool>();
  private readonly ephemeralMembers = new Map<ThreadId, SubagentBudgetMember>();
  private readonly ephemeralSpawnCounts = new Map<ThreadId, number>();

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(`
      DROP TABLE IF EXISTS thread_budgets;
      CREATE TABLE IF NOT EXISTS subagent_budget_pools (
        pool_thread_id TEXT PRIMARY KEY,
        token_budget INTEGER NOT NULL CHECK (token_budget > 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS subagent_budget_members (
        thread_id TEXT PRIMARY KEY,
        pool_thread_id TEXT,
        token_cap INTEGER CHECK (token_cap IS NULL OR token_cap > 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS subagent_budget_members_pool_idx
        ON subagent_budget_members(pool_thread_id);
      CREATE TABLE IF NOT EXISTS subagent_spawn_counts (
        spawner_thread_id TEXT PRIMARY KEY,
        spawn_count INTEGER NOT NULL CHECK (spawn_count >= 0)
      ) STRICT;
    `);
  }

  readPool(poolThreadId: ThreadId): SubagentBudgetPool | null {
    return this.ephemeralPools.get(poolThreadId) ?? this.readPersistedPool(poolThreadId);
  }

  readMember(threadId: ThreadId): SubagentBudgetMember | null {
    return this.ephemeralMembers.get(threadId) ?? this.readPersistedMember(threadId);
  }

  readSpawnCount(spawnerThreadId: ThreadId): number {
    return this.ephemeralSpawnCounts.get(spawnerThreadId) ?? this.readPersistedSpawnCount(spawnerThreadId);
  }

  createPool(poolThreadId: ThreadId, tokenBudget: number, ephemeral: boolean): SubagentBudgetPool {
    positiveSafeInteger(tokenBudget, 'Subagent token pool');
    const record = { poolThreadId, tokenBudget, tokensUsed: 0 } satisfies SubagentBudgetPool;
    if (ephemeral) {
      if (this.ephemeralPools.has(poolThreadId)) throw new Error(`Subagent token pool already exists: ${poolThreadId}`);
      this.ephemeralPools.set(poolThreadId, record);
      return record;
    }
    this.db.prepare(`
      INSERT INTO subagent_budget_pools(pool_thread_id, token_budget, tokens_used)
      VALUES (?, ?, 0)
    `).run(poolThreadId, tokenBudget);
    return record;
  }

  createMember(
    threadId: ThreadId,
    poolThreadId: ThreadId | null,
    tokenCap: number | null,
    ephemeral: boolean,
  ): SubagentBudgetMember {
    if (tokenCap !== null) positiveSafeInteger(tokenCap, 'Subagent token cap');
    const record = { threadId, poolThreadId, tokenCap, tokensUsed: 0 } satisfies SubagentBudgetMember;
    if (ephemeral) {
      if (this.ephemeralMembers.has(threadId)) throw new Error(`Subagent budget member already exists: ${threadId}`);
      this.ephemeralMembers.set(threadId, record);
      return record;
    }
    this.db.prepare(`
      INSERT INTO subagent_budget_members(thread_id, pool_thread_id, token_cap, tokens_used)
      VALUES (?, ?, ?, 0)
    `).run(threadId, poolThreadId, tokenCap);
    return record;
  }

  recordSpawnCount(spawnerThreadId: ThreadId, spawnCount: number, ephemeral: boolean): number {
    if (!Number.isSafeInteger(spawnCount) || spawnCount < 0) {
      throw new Error('Subagent spawn count must be a non-negative integer');
    }
    if (ephemeral) {
      const recorded = Math.max(this.ephemeralSpawnCounts.get(spawnerThreadId) ?? 0, spawnCount);
      this.ephemeralSpawnCounts.set(spawnerThreadId, recorded);
      return recorded;
    }
    this.db.prepare(`
      INSERT INTO subagent_spawn_counts(spawner_thread_id, spawn_count)
      VALUES (?, ?)
      ON CONFLICT(spawner_thread_id) DO UPDATE SET
        spawn_count = MAX(subagent_spawn_counts.spawn_count, excluded.spawn_count)
    `).run(spawnerThreadId, spawnCount);
    return this.readPersistedSpawnCount(spawnerThreadId);
  }

  addUsage(
    threadId: ThreadId,
    poolThreadId: ThreadId | null,
    tokens: number,
  ): { readonly member: SubagentBudgetMember; readonly pool: SubagentBudgetPool | null } | null {
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error('Subagent budget usage increment must be a non-negative integer');
    }
    const ephemeral = this.ephemeralMembers.get(threadId);
    if (ephemeral) return this.addEphemeralUsage(ephemeral, poolThreadId, tokens);
    const member = this.readPersistedMember(threadId);
    if (!member) return null;
    if (member.poolThreadId !== poolThreadId) {
      throw new Error(`Subagent budget pool mismatch for Thread: ${threadId}`);
    }
    if (tokens === 0) {
      return { member, pool: poolThreadId === null ? null : this.readPersistedPool(poolThreadId) };
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const updatedMember = { ...member, tokensUsed: checkedTotal(member.tokensUsed, tokens) };
      const memberResult = this.db.prepare(`
        UPDATE subagent_budget_members SET tokens_used = ? WHERE thread_id = ?
      `).run(updatedMember.tokensUsed, threadId);
      if (memberResult.changes !== 1) throw new Error(`Subagent budget member not found: ${threadId}`);
      const updatedPool = poolThreadId === null ? null : this.addPersistedPoolUsage(poolThreadId, tokens);
      this.db.exec('COMMIT;');
      return { member: updatedMember, pool: updatedPool };
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  clearThread(threadId: ThreadId): boolean {
    const ephemeralMember = this.ephemeralMembers.delete(threadId);
    const ephemeralPool = this.ephemeralPools.delete(threadId);
    const ephemeralSpawnCount = this.ephemeralSpawnCounts.delete(threadId);
    if (ephemeralPool) {
      for (const [memberThreadId, member] of this.ephemeralMembers) {
        if (member.poolThreadId === threadId) this.ephemeralMembers.delete(memberThreadId);
      }
    }

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const memberChanges = this.db.prepare(
        'DELETE FROM subagent_budget_members WHERE thread_id = ? OR pool_thread_id = ?',
      ).run(threadId, threadId).changes;
      const poolChanges = this.db.prepare(
        'DELETE FROM subagent_budget_pools WHERE pool_thread_id = ?',
      ).run(threadId).changes;
      const spawnCountChanges = this.db.prepare(
        'DELETE FROM subagent_spawn_counts WHERE spawner_thread_id = ?',
      ).run(threadId).changes;
      this.db.exec('COMMIT;');
      return ephemeralMember
        || ephemeralPool
        || ephemeralSpawnCount
        || Number(memberChanges) > 0
        || Number(poolChanges) > 0
        || Number(spawnCountChanges) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  private addEphemeralUsage(
    member: SubagentBudgetMember,
    poolThreadId: ThreadId | null,
    tokens: number,
  ): { readonly member: SubagentBudgetMember; readonly pool: SubagentBudgetPool | null } {
    if (member.poolThreadId !== poolThreadId) {
      throw new Error(`Subagent budget pool mismatch for Thread: ${member.threadId}`);
    }
    if (tokens === 0) {
      return { member, pool: poolThreadId === null ? null : this.ephemeralPools.get(poolThreadId) ?? null };
    }
    const updatedMember = { ...member, tokensUsed: checkedTotal(member.tokensUsed, tokens) };
    this.ephemeralMembers.set(member.threadId, updatedMember);
    if (poolThreadId === null) return { member: updatedMember, pool: null };
    const pool = this.ephemeralPools.get(poolThreadId);
    if (!pool) throw new Error(`Subagent token pool not found: ${poolThreadId}`);
    const updatedPool = { ...pool, tokensUsed: checkedTotal(pool.tokensUsed, tokens) };
    this.ephemeralPools.set(poolThreadId, updatedPool);
    return { member: updatedMember, pool: updatedPool };
  }

  private addPersistedPoolUsage(poolThreadId: ThreadId, tokens: number): SubagentBudgetPool {
    const pool = this.readPersistedPool(poolThreadId);
    if (!pool) throw new Error(`Subagent token pool not found: ${poolThreadId}`);
    const tokensUsed = checkedTotal(pool.tokensUsed, tokens);
    const result = this.db.prepare(`
      UPDATE subagent_budget_pools SET tokens_used = ? WHERE pool_thread_id = ?
    `).run(tokensUsed, poolThreadId);
    if (result.changes !== 1) throw new Error(`Subagent token pool not found: ${poolThreadId}`);
    return { ...pool, tokensUsed };
  }

  private readPersistedPool(poolThreadId: ThreadId): SubagentBudgetPool | null {
    const row = this.db.prepare(`
      SELECT pool_thread_id, token_budget, tokens_used
      FROM subagent_budget_pools WHERE pool_thread_id = ?
    `).get(poolThreadId) as SubagentBudgetPoolRow | undefined;
    return row ? {
      poolThreadId: row.pool_thread_id,
      tokenBudget: row.token_budget,
      tokensUsed: row.tokens_used,
    } : null;
  }

  private readPersistedMember(threadId: ThreadId): SubagentBudgetMember | null {
    const row = this.db.prepare(`
      SELECT thread_id, pool_thread_id, token_cap, tokens_used
      FROM subagent_budget_members WHERE thread_id = ?
    `).get(threadId) as SubagentBudgetMemberRow | undefined;
    return row ? {
      threadId: row.thread_id,
      poolThreadId: row.pool_thread_id,
      tokenCap: row.token_cap,
      tokensUsed: row.tokens_used,
    } : null;
  }

  private readPersistedSpawnCount(spawnerThreadId: ThreadId): number {
    const row = this.db.prepare(`
      SELECT spawn_count FROM subagent_spawn_counts WHERE spawner_thread_id = ?
    `).get(spawnerThreadId) as SubagentSpawnCountRow | undefined;
    return row?.spawn_count ?? 0;
  }
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function checkedTotal(tokensUsed: number, increment: number): number {
  const total = tokensUsed + increment;
  if (!Number.isSafeInteger(total)) throw new Error('Subagent budget usage exceeds the safe integer range');
  return total;
}
