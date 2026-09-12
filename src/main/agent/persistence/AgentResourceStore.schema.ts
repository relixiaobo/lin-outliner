/** Shared by the Store constructor and read-only compatibility inspection. */
export const agentResourceStoreSchema = `
      CREATE TABLE IF NOT EXISTS resource_references (
        reference_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        media_type TEXT,
        source_json TEXT,
        revision_anchor_id TEXT,
        revision_byte_length INTEGER,
        availability TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        CHECK ((revision_anchor_id IS NULL) = (revision_byte_length IS NULL))
      );
      CREATE TABLE IF NOT EXISTS resource_links (
        thread_id TEXT NOT NULL,
        reference_id TEXT NOT NULL REFERENCES resource_references(reference_id) ON DELETE CASCADE,
        PRIMARY KEY (thread_id, reference_id)
      );
      CREATE INDEX IF NOT EXISTS resource_links_reference_idx
        ON resource_links(reference_id);
      CREATE TABLE IF NOT EXISTS resource_scopes (
        scope_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        root_path TEXT NOT NULL,
        readable INTEGER NOT NULL,
        editable INTEGER NOT NULL,
        revealable INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS final_citations (
        thread_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        marker_ordinal INTEGER NOT NULL,
        reference_id TEXT REFERENCES resource_references(reference_id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (thread_id, item_id, marker_ordinal)
      );
    `;
