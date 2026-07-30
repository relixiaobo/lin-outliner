import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ThreadId } from '../../../../core/agent/protocol';
import { openSqlite, type SqliteDatabase } from '../../persistence/sqlite';

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
  private readonly db: SqliteDatabase;
  private readonly ephemeralBudgets = new Map<ThreadId, SubagentBudgetRecord>();

  constructor(path: string, database?: SqliteDatabase) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? openSqlite(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_budgets (
        thread_id TEXT PRIMARY KEY,
        token_budget INTEGER NOT NULL CHECK (token_budget > 0),
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0)
      ) STRICT;
    `);
  }

  close(): void {
    this.db.close();
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

  addUsage(threadId: ThreadId, tokens: number, ephemeral: boolean): SubagentBudgetRecord | null {
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      throw new Error('Subagent budget usage increment must be a non-negative integer');
    }
    const current = this.read(threadId);
    if (!current || tokens === 0) return current;
    const tokensUsed = current.tokensUsed + tokens;
    if (!Number.isSafeInteger(tokensUsed)) throw new Error('Subagent budget usage exceeds the safe integer range');
    const record = { ...current, tokensUsed };
    if (ephemeral) {
      this.ephemeralBudgets.set(threadId, record);
      return record;
    }
    const result = this.db.prepare(`
      UPDATE thread_budgets SET tokens_used = ? WHERE thread_id = ?
    `).run(tokensUsed, threadId);
    if (result.changes !== 1) throw new Error(`Subagent budget not found for Thread: ${threadId}`);
    return record;
  }

  clear(threadId: ThreadId): boolean {
    return this.ephemeralBudgets.delete(threadId)
      || this.db.prepare('DELETE FROM thread_budgets WHERE thread_id = ?').run(threadId).changes === 1;
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
