/** Shared by the Store constructor and read-only compatibility inspection. */
export const contentStoreSchema = `
      CREATE TABLE IF NOT EXISTS content_meta(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exact_revisions(
        digest TEXT PRIMARY KEY,
        byte_length INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('publishing', 'published', 'deleting', 'quarantined')),
        owner_pid INTEGER,
        owner_token TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admission_staging(
        stage_id TEXT PRIMARY KEY,
        owner_pid INTEGER NOT NULL,
        owner_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publication_journal(
        digest TEXT PRIMARY KEY REFERENCES exact_revisions(digest) ON DELETE CASCADE,
        byte_length INTEGER NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_token TEXT NOT NULL,
        temp_path TEXT NOT NULL,
        claimed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admission_leases(
        lease_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL REFERENCES exact_revisions(digest) ON DELETE CASCADE,
        byte_length INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admission_leases_digest ON admission_leases(digest);
      CREATE TABLE IF NOT EXISTS retention_anchors(
        anchor_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        record_key TEXT NOT NULL,
        digest TEXT NOT NULL REFERENCES exact_revisions(digest) ON DELETE RESTRICT,
        byte_length INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retention_anchors_namespace ON retention_anchors(namespace);
      CREATE INDEX IF NOT EXISTS retention_anchors_digest ON retention_anchors(digest);
      CREATE UNIQUE INDEX IF NOT EXISTS retention_anchors_coordinate
        ON retention_anchors(namespace, record_key);
      CREATE TABLE IF NOT EXISTS retired_anchor_ids(
        anchor_id TEXT PRIMARY KEY,
        released_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deletion_journal(
        digest TEXT PRIMARY KEY REFERENCES exact_revisions(digest) ON DELETE CASCADE,
        byte_length INTEGER NOT NULL,
        marked_at INTEGER NOT NULL
      );
      `;
