import type { ThreadId } from '../../../core/agent/protocol';
import type { SqliteDatabase } from './sqlite';

interface SubagentBudgetRow {
  thread_id: string;
  token_budget: number;
  tokens_used: number;
}

export interface SubagentBudgetRecord {
  readonly threadId: ThreadId;
  readonly tokenBudget: number;
  readonly tokensUsed: number;
}

export class SubagentBudgetLedger {
  private readonly ephemeralBudgets = new Map<ThreadId, SubagentBudgetRecord>();

  constructor(private readonly db: SqliteDatabase) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_budgets (
        thread_id TEXT PRIMARY KEY,
        token_budget INTEGER NOT NULL CHECK (token_budget > 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0)
      ) STRICT;
    `);
  }

  read(threadId: ThreadId): SubagentBudgetRecord | null {
    return this.ephemeralBudgets.get(threadId) ?? this.readPersisted(threadId);
  }

  create(threadId: ThreadId, tokenBudget: number, ephemeral: boolean): SubagentBudgetRecord {
    const record = { threadId, tokenBudget, tokensUsed: 0 } satisfies SubagentBudgetRecord;
    if (ephemeral) {
      if (this.ephemeralBudgets.has(threadId)) throw new Error(`Subagent budget already exists: ${threadId}`);
      this.ephemeralBudgets.set(threadId, record);
      return record;
    }
    this.db.prepare(`
      INSERT INTO thread_budgets(thread_id, token_budget, tokens_used)
      VALUES (?, ?, 0)
    `).run(threadId, tokenBudget);
    return record;
  }

  addUsage(threadId: ThreadId, tokens: number): SubagentBudgetRecord | null {
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error('Subagent budget usage increment must be a non-negative integer');
    }
    const ephemeral = this.ephemeralBudgets.get(threadId);
    if (ephemeral) return this.addEphemeralUsage(ephemeral, tokens);
    const persisted = this.readPersisted(threadId);
    if (!persisted || tokens === 0) return persisted;
    const tokensUsed = checkedTotal(persisted.tokensUsed, tokens);
    const result = this.db.prepare(`
      UPDATE thread_budgets SET tokens_used = ? WHERE thread_id = ?
    `).run(tokensUsed, threadId);
    if (result.changes !== 1) throw new Error(`Subagent budget not found for Thread: ${threadId}`);
    return { ...persisted, tokensUsed };
  }

  clear(threadId: ThreadId): boolean {
    return this.ephemeralBudgets.delete(threadId)
      || this.db.prepare('DELETE FROM thread_budgets WHERE thread_id = ?').run(threadId).changes === 1;
  }

  private addEphemeralUsage(current: SubagentBudgetRecord, tokens: number): SubagentBudgetRecord {
    if (tokens === 0) return current;
    const record = { ...current, tokensUsed: checkedTotal(current.tokensUsed, tokens) };
    this.ephemeralBudgets.set(current.threadId, record);
    return record;
  }

  private readPersisted(threadId: ThreadId): SubagentBudgetRecord | null {
    const row = this.db.prepare(`
      SELECT thread_id, token_budget, tokens_used FROM thread_budgets WHERE thread_id = ?
    `).get(threadId) as SubagentBudgetRow | undefined;
    return row ? {
      threadId: row.thread_id,
      tokenBudget: row.token_budget,
      tokensUsed: row.tokens_used,
    } : null;
  }
}

function checkedTotal(tokensUsed: number, increment: number): number {
  const total = tokensUsed + increment;
  if (!Number.isSafeInteger(total)) throw new Error('Subagent budget usage exceeds the safe integer range');
  return total;
}
