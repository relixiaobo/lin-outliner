/** Shared by the Store constructor and read-only compatibility inspection. */
export const projectCatalogStoreSchema = `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL,
        deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_memberships (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id), revision INTEGER NOT NULL CHECK (revision > 0)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS project_membership_project_idx ON project_memberships(project_id);
      CREATE INDEX IF NOT EXISTS threads_parent_idx ON threads(parent_thread_id);
      CREATE INDEX IF NOT EXISTS threads_fork_idx ON threads(forked_from_id);
      CREATE TABLE IF NOT EXISTS project_deletion_receipts (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        source_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL, digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS project_operation_receipts (
        source_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL, digest TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY(source_thread_id, operation_id)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS project_membership_inherit AFTER INSERT ON threads
      BEGIN
        INSERT INTO project_memberships(thread_id, project_id, revision)
        SELECT NEW.id, p.id, 1 FROM project_memberships m JOIN projects p ON p.id = m.project_id
        WHERE m.thread_id = COALESCE(NEW.parent_thread_id, NEW.forked_from_id) AND p.deleting = 0;
      END;
    `;
