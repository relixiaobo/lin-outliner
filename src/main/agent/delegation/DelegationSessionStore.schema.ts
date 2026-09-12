/** Shared by the Store constructor and read-only compatibility inspection. */
export const delegationSessionStoreSchema = `
      CREATE TABLE IF NOT EXISTS delegation_sessions (
        session_id TEXT PRIMARY KEY,
        owner_thread_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        policy_json TEXT NOT NULL,
        adapter_session_id TEXT,
        current_task_id TEXT,
        previous_task_id TEXT,
        message_sequence INTEGER NOT NULL DEFAULT 0 CHECK (message_sequence >= 0),
        stop_fence_json TEXT,
        last_resume_json TEXT,
        worktree_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        CHECK ((state = 'closed') = (closed_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delegation_sessions_owner_idx
        ON delegation_sessions(owner_thread_id, state, updated_at, session_id);

      CREATE TABLE IF NOT EXISTS delegation_root_messages (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES delegation_sessions(session_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        digest TEXT NOT NULL,
        prefix_digest TEXT NOT NULL,
        body TEXT,
        state TEXT NOT NULL CHECK (state IN ('queued', 'committed', 'blocked')),
        source_task_id TEXT NOT NULL,
        source_root_turn_id TEXT NOT NULL,
        source_root_item_id TEXT NOT NULL,
        source_root_intent_revision INTEGER CHECK (
          source_root_intent_revision IS NULL OR source_root_intent_revision > 0
        ),
        delivery_turn_id TEXT,
        blocked_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence),
        UNIQUE(session_id, source_root_item_id),
        CHECK ((state = 'queued') = (body IS NOT NULL)),
        CHECK ((state = 'committed') = (delivery_turn_id IS NOT NULL)),
        CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delegation_messages_pending_idx
        ON delegation_root_messages(session_id, state, sequence);

      CREATE TABLE IF NOT EXISTS delegation_execution_settlements (
        settlement_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES delegation_sessions(session_id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        message_sequence INTEGER NOT NULL CHECK (message_sequence >= 0),
        message_sequence_digest TEXT NOT NULL,
        prepared_result_digest TEXT,
        final_receipt_digest TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'awaiting_result', 'prepared', 'context_committed', 'committed', 'blocked'
        )),
        blocked_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (state = 'awaiting_result' AND prepared_result_digest IS NULL)
          OR state = 'blocked'
          OR (state IN ('prepared', 'context_committed', 'committed') AND prepared_result_digest IS NOT NULL)
        ),
        CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS delegation_settlements_recovery_idx
        ON delegation_execution_settlements(state, updated_at, settlement_id);
      CREATE INDEX IF NOT EXISTS delegation_settlements_session_idx
        ON delegation_execution_settlements(session_id, created_at, settlement_id);
    `;
