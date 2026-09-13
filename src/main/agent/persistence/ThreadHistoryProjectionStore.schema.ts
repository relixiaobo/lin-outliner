/** Shared by the Store constructor and read-only compatibility inspection. */
export const threadHistoryProjectionStoreSchema = `
      CREATE TABLE IF NOT EXISTS thread_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        provenance_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error_json TEXT NOT NULL,
        execution_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER,
        PRIMARY KEY(thread_id, turn_id),
        UNIQUE(thread_id, position)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS thread_turns_page_idx
        ON thread_turns(thread_id, position, turn_id);
      CREATE TABLE IF NOT EXISTS thread_items (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        turn_position INTEGER NOT NULL,
        item_index INTEGER NOT NULL,
        item_type TEXT NOT NULL,
        item_json TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        PRIMARY KEY(thread_id, item_id),
        UNIQUE(thread_id, turn_id, item_index),
        FOREIGN KEY(thread_id, turn_id) REFERENCES thread_turns(thread_id, turn_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS thread_items_page_idx
        ON thread_items(thread_id, turn_position, item_index, item_id);
      CREATE INDEX IF NOT EXISTS thread_items_visible_history_idx
        ON thread_items(thread_id, turn_position, item_index, item_id)
        WHERE item_type IN (
          'userMessage', 'agentMessage', 'commandExecution', 'fileChange',
          'mcpToolCall', 'dynamicToolCall', 'webSearch'
        );
      CREATE TABLE IF NOT EXISTS rollout_watermarks (
        thread_id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL,
        byte_offset INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS history_rollbacks (
        rollback_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        marker_ordinal INTEGER NOT NULL,
        omitted_turn_ids_json TEXT NOT NULL,
        before_projection_version INTEGER NOT NULL,
        after_projection_version INTEGER NOT NULL,
        UNIQUE(thread_id, marker_ordinal)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS history_rollbacks_thread_idx
        ON history_rollbacks(thread_id, marker_ordinal);
    `;
