/** Shared by the Store constructor and read-only compatibility inspection. */
export const profileFileStoreSchema = `
      CREATE TABLE IF NOT EXISTS profile_documents (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS profile_publications (id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL, request_digest TEXT, updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS profile_invalidations (id TEXT PRIMARY KEY, state TEXT NOT NULL, turn_ids TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS profile_turns (turn_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL) STRICT;
    `;
