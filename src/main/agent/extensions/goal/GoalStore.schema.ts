/** Shared by the Store constructor and read-only compatibility inspection. */
export const goalStoreSchema = `
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
    `;
