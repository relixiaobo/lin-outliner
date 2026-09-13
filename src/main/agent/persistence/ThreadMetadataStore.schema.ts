/** Shared by the Store constructor and read-only compatibility inspection. */
export const threadMetadataStoreSchema = `
      CREATE TABLE IF NOT EXISTS thread_recovery_operations (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        forked_from_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        name TEXT,
        name_origin TEXT NOT NULL CHECK (name_origin IN ('none', 'automatic', 'manual', 'derived')),
        preview TEXT NOT NULL,
        ephemeral INTEGER NOT NULL CHECK (ephemeral IN (0, 1)),
        source TEXT NOT NULL,
        thread_source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        configuration_source_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status_json TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        configuration_json TEXT NOT NULL,
        tool_ceiling_json TEXT,
        CHECK (NOT (parent_thread_id IS NOT NULL AND forked_from_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS threads_list_idx ON threads(archived, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS threads_session_idx ON threads(session_id, created_at, id);
      CREATE TABLE IF NOT EXISTS spawn_edges (
        session_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        child_thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        task_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, task_path)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS client_inputs (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, client_id)
      ) STRICT;
    `;
