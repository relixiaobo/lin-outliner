/** Shared by the Store constructor and read-only compatibility inspection. */
export const memoryControlStoreSchema = `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS thread_modes (
        thread_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('enabled', 'disabled')),
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS turn_admissions (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        feature_mode TEXT NOT NULL CHECK (feature_mode IN ('enabled', 'disabled')),
        thread_mode TEXT NOT NULL CHECK (thread_mode IN ('enabled', 'disabled')),
        eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
        feature_generation INTEGER NOT NULL,
        reset_epoch INTEGER NOT NULL,
        visibility_generation INTEGER NOT NULL,
        admitted_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_admissions_thread_idx ON turn_admissions(thread_id, admitted_at);
      CREATE TABLE IF NOT EXISTS turn_exclusions (
        turn_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('globalDisable', 'reset')),
        epoch INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(turn_id, reason)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_records (
        thread_id TEXT PRIMARY KEY,
        source_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'succeededNoOutput', 'failed')),
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS origin_claims (
        origin_item_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        source_date TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('reader', 'host', 'assistant', 'tool', 'web', 'mcp')),
        has_reader_text INTEGER NOT NULL CHECK (has_reader_text IN (0, 1) AND (has_reader_text = 0 OR source = 'reader'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS processed_origins (
        origin_item_id TEXT PRIMARY KEY REFERENCES origin_claims(origin_item_id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS generated_nodes (
        subject TEXT NOT NULL CHECK (subject IN ('user', 'context')),
        node_id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        source_date TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        user_authoritative INTEGER NOT NULL DEFAULT 0 CHECK (user_authoritative IN (0, 1)),
        generated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS node_lineage (
        node_id TEXT NOT NULL REFERENCES generated_nodes(node_id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        origin_item_id TEXT NOT NULL,
        PRIMARY KEY(node_id, origin_item_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS citation_usage (
        citation_item_id TEXT NOT NULL,
        citation_turn_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        origin_item_id TEXT NOT NULL,
        used_at INTEGER NOT NULL,
        PRIMARY KEY(citation_item_id, node_id, origin_item_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('stage1', 'stage2', 'reset')),
        status TEXT NOT NULL CHECK (status IN ('prepared', 'finalized', 'conflicted')),
        generation INTEGER NOT NULL,
        feature_generation INTEGER NOT NULL,
        reset_epoch INTEGER NOT NULL,
        digest TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rollback_invalidations (
        rollback_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'committed', 'reconciled', 'aborted')),
        omitted_turn_ids_json TEXT NOT NULL,
        before_version INTEGER NOT NULL,
        after_version INTEGER NOT NULL,
        suppressed_node_ids_json TEXT NOT NULL,
        suppress_all_generated INTEGER NOT NULL CHECK (suppress_all_generated IN (0, 1)),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS dirty_jobs (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `;
