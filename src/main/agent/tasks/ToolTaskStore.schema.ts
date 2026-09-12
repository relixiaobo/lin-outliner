/** Shared by the Store constructor and read-only compatibility inspection. */
export const toolTaskStoreSchema = `
      CREATE TABLE IF NOT EXISTS tool_tasks (
        task_id TEXT PRIMARY KEY,
        continuation_json TEXT NOT NULL,
        control_receipts_json TEXT NOT NULL DEFAULT '[]',
        owner_thread_id TEXT NOT NULL,
        source_turn_id TEXT NOT NULL,
        source_item_id TEXT NOT NULL,
        producer TEXT NOT NULL,
        description TEXT NOT NULL,
        command_digest TEXT NOT NULL,
        cwd TEXT NOT NULL,
        execution_context_json TEXT NOT NULL,
        isolation_json TEXT NOT NULL,
        operation_kind TEXT NOT NULL CHECK (operation_kind IN ('process', 'host')),
        parent_task_id TEXT,
        nonce TEXT NOT NULL,
        detail_path TEXT NOT NULL,
        background_enabled INTEGER NOT NULL CHECK (background_enabled IN (0, 1)),
        supervisor_pid INTEGER,
        child_pid INTEGER,
        state TEXT NOT NULL CHECK (state IN (
          'running', 'settling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'lost'
        )),
        delivery_state TEXT NOT NULL CHECK (delivery_state IN (
          'pending', 'delivering', 'delivered', 'blocked', 'silent', 'handled'
        )),
        progress_json TEXT,
        exit_code INTEGER,
        signal TEXT,
        outcome_reason TEXT,
        error_message TEXT,
        detail_state TEXT NOT NULL CHECK (detail_state IN ('available', 'expired', 'cleared', 'storage_pressure')),
        timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),
        stop_requested_at INTEGER,
        terminal_digest TEXT,
        stdout_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stdout_bytes >= 0),
        stderr_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stderr_bytes >= 0),
        output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        quiesced_at INTEGER,
        delivery_turn_id TEXT,
        delivered_at INTEGER,
        updated_at INTEGER NOT NULL,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        artifact_warnings_json TEXT NOT NULL DEFAULT '[]',
        artifacts_settled INTEGER NOT NULL DEFAULT 0 CHECK (artifacts_settled IN (0, 1)),
        reservation_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reservation_bytes >= 0),
        detail_bytes INTEGER NOT NULL DEFAULT 0 CHECK (detail_bytes >= 0),
        storage_pressure_json TEXT,
        CHECK ((state IN ('running', 'settling')) = (completed_at IS NULL)),
        CHECK ((terminal_digest IS NULL) = (state IN ('running', 'settling')))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tool_tasks_owner_idx
        ON tool_tasks(owner_thread_id, started_at, task_id);
      CREATE INDEX IF NOT EXISTS tool_tasks_recovery_idx
        ON tool_tasks(state, updated_at, task_id);
      CREATE INDEX IF NOT EXISTS tool_tasks_delivery_idx
        ON tool_tasks(owner_thread_id, delivery_state, completed_at, task_id);

      CREATE TABLE IF NOT EXISTS tool_task_delivery_batches (
        batch_id TEXT PRIMARY KEY,
        owner_thread_id TEXT NOT NULL,
        reserved_turn_id TEXT NOT NULL,
        client_id TEXT NOT NULL UNIQUE,
        envelope_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'linked', 'rolled_back', 'blocked')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS tool_task_delivery_turn_idx
        ON tool_task_delivery_batches(owner_thread_id, reserved_turn_id);
      CREATE TABLE IF NOT EXISTS tool_task_delivery_members (
        batch_id TEXT NOT NULL REFERENCES tool_task_delivery_batches(batch_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tool_tasks(task_id) ON DELETE CASCADE,
        terminal_digest TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY(batch_id, task_id),
        UNIQUE(batch_id, ordinal)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tool_task_leases (
        task_id TEXT PRIMARY KEY REFERENCES tool_tasks(task_id) ON DELETE CASCADE,
        owner_thread_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        producer TEXT NOT NULL,
        pool TEXT NOT NULL,
        configuration_revision TEXT NOT NULL,
        max_concurrent_producer INTEGER NOT NULL CHECK (max_concurrent_producer > 0),
        max_concurrent_pool INTEGER NOT NULL CHECK (max_concurrent_pool > 0),
        state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'released')),
        created_at INTEGER NOT NULL,
        acquired_at INTEGER,
        released_at INTEGER,
        CHECK ((state = 'queued') = (acquired_at IS NULL AND released_at IS NULL)),
        CHECK ((state = 'active') = (acquired_at IS NOT NULL AND released_at IS NULL)),
        CHECK ((state = 'released') = (released_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tool_task_leases_admission_idx
        ON tool_task_leases(state, created_at, task_id);
      CREATE INDEX IF NOT EXISTS tool_task_leases_thread_idx
        ON tool_task_leases(owner_thread_id, state);

      CREATE TABLE IF NOT EXISTS tool_task_context_successors (
        predecessor_ref TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tool_tasks(task_id) ON DELETE CASCADE,
        payload_ref_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivered', 'blocked'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tool_task_context_successors_task_idx
        ON tool_task_context_successors(task_id);
    `;
