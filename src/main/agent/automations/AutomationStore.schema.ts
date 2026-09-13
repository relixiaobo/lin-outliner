/** Shared by the Store constructor and read-only compatibility inspection. */
export const automationStoreSchema = `
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        materials_json TEXT NOT NULL,
        origin_json TEXT,
        schedule_json TEXT NOT NULL,
        destination_json TEXT NOT NULL,
        context_hints_json TEXT NOT NULL,
        configuration_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS automation_binding_cursors (
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        context_hint_id TEXT NOT NULL,
        evaluated_through INTEGER NOT NULL,
        overlap_deferred INTEGER NOT NULL DEFAULT 0 CHECK (overlap_deferred IN (0, 1)),
        PRIMARY KEY (automation_id, context_hint_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS automation_missed_occurrences (
        automation_id TEXT NOT NULL REFERENCES automations(id),
        context_hint_id TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        resolution TEXT CHECK (resolution IN ('fulfilled', 'skipped', 'replaced')),
        resolved_at INTEGER,
        PRIMARY KEY (automation_id, context_hint_id, scheduled_for)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS automation_operation_receipts (
        request_id TEXT PRIMARY KEY,
        input_json TEXT NOT NULL,
        receipt_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS automation_issue_acknowledgements (
        run_id TEXT NOT NULL REFERENCES automation_runs(id),
        issue_key TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, issue_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS automation_run_event_clock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sequence INTEGER NOT NULL CHECK (sequence >= 0)
      ) STRICT;
      INSERT OR IGNORE INTO automation_run_event_clock(id, sequence) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES automations(id),
        automation_revision INTEGER NOT NULL CHECK (automation_revision > 0),
        event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
        created_sequence INTEGER NOT NULL CHECK (created_sequence > 0),
        scheduled_for INTEGER NOT NULL,
        context_hint_id TEXT NOT NULL,
        occurrence_key TEXT NOT NULL,
        dispatch_snapshot_ref_json TEXT,
        snapshot_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'failed', 'omitted')),
        thread_id TEXT,
        turn_id TEXT,
        worktree_json TEXT,
        omission_json TEXT,
        error TEXT,
        read_at INTEGER,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (automation_id, context_hint_id, occurrence_key),
        CHECK (
          (state = 'dispatched' AND thread_id IS NOT NULL AND turn_id IS NOT NULL AND omission_json IS NULL)
          OR (state = 'omitted' AND thread_id IS NULL AND turn_id IS NULL AND omission_json IS NOT NULL)
          OR (state IN ('pending', 'failed') AND turn_id IS NULL AND omission_json IS NULL)
        )
      ) STRICT;
      CREATE INDEX IF NOT EXISTS automation_runs_dispatch_idx
        ON automation_runs(state, created_at);
      CREATE INDEX IF NOT EXISTS automation_runs_automation_idx
        ON automation_runs(automation_id, scheduled_for DESC);
    `;
