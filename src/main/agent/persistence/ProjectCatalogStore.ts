import { decodeProject, type Project, type ProjectMembership } from '../../../core/agent/project';
import { uuidV7 } from '../uuid';
import type { SqliteDatabase } from './sqlite';

interface ProjectRow { payload: string; deleting: number }

/** Shares the Thread catalog database so membership and deletion are atomic. */
export class ProjectCatalogStore {
  constructor(private readonly db: SqliteDatabase) {
    db.exec(`
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
      CREATE TRIGGER IF NOT EXISTS project_membership_inherit AFTER INSERT ON threads
      BEGIN
        INSERT INTO project_memberships(thread_id, project_id, revision)
        SELECT NEW.id, p.id, 1 FROM project_memberships m JOIN projects p ON p.id = m.project_id
        WHERE m.thread_id = COALESCE(NEW.parent_thread_id, NEW.forked_from_id) AND p.deleting = 0;
      END;
    `);
  }

  list(): readonly Project[] {
    return (this.db.prepare('SELECT payload FROM projects WHERE deleting = 0 ORDER BY id').all() as ProjectRow[])
      .map((row) => decodeProject(JSON.parse(row.payload))).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  read(id: string, includeDeleting = false): Project | null {
    const row = this.db.prepare('SELECT payload, deleting FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row && (includeDeleting || !row.deleting) ? decodeProject(JSON.parse(row.payload)) : null;
  }
  require(id: string, expectedRevision?: number): Project {
    const project = this.read(id);
    if (!project) throw new Error('Project is missing or being deleted');
    if (expectedRevision !== undefined && project.revision !== expectedRevision) throw new Error('Project changed; inspect it again before retrying');
    return project;
  }
  create(name: string, rootHint: string | null, now: number): Project {
    if (this.list().length >= 1_000) throw new Error('Project catalog limit reached');
    const project = decodeProject({ id: uuidV7(now), name, rootHint, revision: 1, createdAt: now, updatedAt: now });
    this.db.prepare('INSERT INTO projects(id, payload) VALUES (?, ?)').run(project.id, JSON.stringify(project));
    return project;
  }
  update(id: string, revision: number, name: string, rootHint: string | null, now: number): Project {
    const project = decodeProject({ ...this.require(id, revision), name, rootHint, revision: revision + 1, updatedAt: now });
    this.db.prepare('UPDATE projects SET payload = ? WHERE id = ?').run(JSON.stringify(project), id);
    return project;
  }
  membership(threadId: string): ProjectMembership {
    const row = this.db.prepare('SELECT project_id, revision FROM project_memberships WHERE thread_id = ?')
      .get(threadId) as { project_id: string | null; revision: number } | undefined;
    return { threadId, projectId: row?.project_id ?? null, revision: row?.revision ?? 0 };
  }
  /** The caller owns the surrounding Thread creation transaction. */
  admit(threadId: string, projectId: string, revision: number): void {
    this.require(projectId, revision);
    this.writeMembership(threadId, projectId);
  }
  lineage(threadId: string): string[] {
    return (this.db.prepare(`WITH RECURSIVE family(id) AS (
      SELECT id FROM threads WHERE id = ?
      UNION SELECT t.id FROM threads t JOIN family f ON t.parent_thread_id = f.id OR t.forked_from_id = f.id
    ) SELECT id FROM family ORDER BY id`).all(threadId) as { id: string }[]).map((row) => row.id);
  }
  bind(threadId: string, projectId: string | null, revision: number | null, membershipRevision: number): readonly string[] {
    return this.transaction(() => {
      if (projectId) this.require(projectId, revision!);
      if (this.membership(threadId).revision !== membershipRevision) throw new Error('Thread Project membership changed; inspect it again');
      const family = this.lineage(threadId);
      if (!family.length) throw new Error('Thread no longer exists');
      for (const id of family) this.writeMembership(id, projectId);
      return family;
    });
  }
  beginDeletion(id: string, revision: number): void {
    this.require(id, revision);
    this.db.prepare('UPDATE projects SET deleting = 1 WHERE id = ?').run(id);
  }
  cancelDeletion(id: string): void { this.db.prepare('UPDATE projects SET deleting = 0 WHERE id = ?').run(id); }
  deletionIntents(): readonly string[] {
    return (this.db.prepare('SELECT id FROM projects WHERE deleting = 1 ORDER BY id').all() as { id: string }[]).map((row) => row.id);
  }
  finishDeletion(id: string): readonly string[] {
    return this.transaction(() => {
      if (!this.deletionIntents().includes(id)) throw new Error('Project deletion has no durable intent');
      // Membership rows only seed the traversal. Canonical edges enumerate all
      // descendants even when an intermediate membership row is missing.
      const family = (this.db.prepare(`WITH RECURSIVE family(id) AS (
        SELECT thread_id FROM project_memberships WHERE project_id = ?
        UNION SELECT t.id FROM threads t JOIN family f ON t.parent_thread_id = f.id OR t.forked_from_id = f.id
      ) SELECT id FROM family ORDER BY id`).all(id) as { id: string }[]).map((row) => row.id);
      for (const threadId of family) {
        const membership = this.membership(threadId);
        if (membership.projectId === id) this.writeMembership(threadId, null);
      }
      this.db.prepare('DELETE FROM projects WHERE id = ? AND deleting = 1').run(id);
      return family;
    });
  }
  private writeMembership(threadId: string, projectId: string | null): void {
    this.db.prepare(`INSERT INTO project_memberships(thread_id, project_id, revision) VALUES (?, ?, 1)
      ON CONFLICT(thread_id) DO UPDATE SET project_id = excluded.project_id, revision = revision + 1`).run(threadId, projectId);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
