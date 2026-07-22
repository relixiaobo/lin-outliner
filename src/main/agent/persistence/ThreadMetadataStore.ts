import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeThread } from '../../../core/agent/codec';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import type {
  Thread,
  ThreadId,
  ThreadListRequest,
  ThreadListResponse,
  ThreadSource,
  ThreadStatus,
  TurnId,
  ThreadItemId,
} from '../../../core/agent/protocol';
import { decodeCursor, encodeCursor, pageLimit } from './cursor';
import { openSqlite, type SqliteDatabase, type SqliteValue } from './sqlite';

export interface ThreadCatalogRecord {
  readonly thread: Thread;
  readonly archived: boolean;
  readonly configuration: EffectiveThreadConfiguration;
}

export interface ClientInputBinding {
  readonly threadId: ThreadId;
  readonly clientId: string;
  readonly turnId: TurnId;
  readonly itemId: ThreadItemId;
  readonly createdAt: number;
}

export interface SpawnEdge {
  readonly parentThreadId: ThreadId;
  readonly childThreadId: ThreadId;
  readonly taskPath: string;
  readonly createdAt: number;
}

interface ThreadRow {
  id: string;
  session_id: string;
  parent_thread_id: string | null;
  forked_from_id: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  name: string | null;
  preview: string;
  ephemeral: number;
  source: string;
  thread_source: string;
  model_provider: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  status_json: string;
  archived: number;
  configuration_json: string;
}

export class ThreadMetadataStore {
  private readonly db: SqliteDatabase;

  constructor(path: string, database?: SqliteDatabase) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? openSqlite(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        forked_from_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        agent_nickname TEXT,
        agent_role TEXT,
        name TEXT,
        preview TEXT NOT NULL,
        ephemeral INTEGER NOT NULL CHECK (ephemeral IN (0, 1)),
        source TEXT NOT NULL,
        thread_source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status_json TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        configuration_json TEXT NOT NULL,
        CHECK (NOT (parent_thread_id IS NOT NULL AND forked_from_id IS NOT NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS threads_list_idx ON threads(archived, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS threads_session_idx ON threads(session_id, created_at, id);
      CREATE TABLE IF NOT EXISTS spawn_edges (
        parent_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        child_thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        task_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS client_inputs (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, client_id)
      ) STRICT;
    `);
  }

  close(): void {
    this.db.close();
  }

  create(record: ThreadCatalogRecord): void {
    const thread = decodeThread(record.thread);
    if (thread.ephemeral) throw new Error('Ephemeral Threads do not belong in the persistent catalog');
    if (thread.parentThreadId) {
      throw new Error('Child Threads must be inserted with createChild() so their spawn edge is atomic');
    }
    this.db.prepare(`
      INSERT INTO threads (
        id, session_id, parent_thread_id, forked_from_id, agent_nickname, agent_role,
        name, preview, ephemeral, source, thread_source, model_provider, cwd,
        created_at, updated_at, status_json, archived, configuration_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.id,
      thread.sessionId,
      thread.parentThreadId,
      thread.forkedFromId,
      thread.agentNickname,
      thread.agentRole,
      thread.name,
      thread.preview,
      thread.ephemeral ? 1 : 0,
      thread.source,
      thread.threadSource,
      thread.modelProvider,
      thread.cwd,
      thread.createdAt,
      thread.updatedAt,
      JSON.stringify(thread.status),
      record.archived ? 1 : 0,
      JSON.stringify(record.configuration),
    );
  }

  createChild(record: ThreadCatalogRecord, edge: SpawnEdge): void {
    if (record.thread.parentThreadId !== edge.parentThreadId || record.thread.id !== edge.childThreadId) {
      throw new Error('Spawn edge must match the child Thread lineage');
    }
    this.transaction(() => {
      this.insertThread(record);
      this.db.prepare(`
        INSERT INTO spawn_edges(parent_thread_id, child_thread_id, task_path, created_at)
        VALUES (?, ?, ?, ?)
      `).run(edge.parentThreadId, edge.childThreadId, edge.taskPath, edge.createdAt);
    });
  }

  private insertThread(record: ThreadCatalogRecord): void {
    const thread = decodeThread(record.thread);
    if (thread.ephemeral) throw new Error('Ephemeral Threads do not belong in the persistent catalog');
    this.db.prepare(`
      INSERT INTO threads (
        id, session_id, parent_thread_id, forked_from_id, agent_nickname, agent_role,
        name, preview, ephemeral, source, thread_source, model_provider, cwd,
        created_at, updated_at, status_json, archived, configuration_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      thread.id, thread.sessionId, thread.parentThreadId, thread.forkedFromId,
      thread.agentNickname, thread.agentRole, thread.name, thread.preview,
      thread.ephemeral ? 1 : 0, thread.source, thread.threadSource, thread.modelProvider,
      thread.cwd, thread.createdAt, thread.updatedAt, JSON.stringify(thread.status),
      record.archived ? 1 : 0, JSON.stringify(record.configuration),
    );
  }

  read(threadId: ThreadId): ThreadCatalogRecord | null {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as ThreadRow | undefined;
    return row ? recordFromRow(row) : null;
  }

  require(threadId: ThreadId): ThreadCatalogRecord {
    const record = this.read(threadId);
    if (!record) throw new Error(`Thread not found: ${threadId}`);
    return record;
  }

  list(request: ThreadListRequest = {}): ThreadListResponse {
    const limit = pageLimit(request.limit);
    const direction = request.sortDirection ?? 'desc';
    const archived = request.archived ?? false;
    const cursor = decodeThreadCursor(request.cursor, direction);
    const sources = request.threadSources ? [...new Set(request.threadSources)] : [];
    const comparison = direction === 'desc' ? '<' : '>';
    const ordering = direction === 'desc' ? 'DESC' : 'ASC';
    const where = ['archived = ?'];
    const params: SqliteValue[] = [archived ? 1 : 0];
    if (sources.length > 0) {
      where.push(`thread_source IN (${sources.map(() => '?').join(', ')})`);
      params.push(...sources);
    }
    if (cursor) {
      where.push(`(updated_at ${comparison} ? OR (updated_at = ? AND id ${comparison} ?))`);
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    params.push(limit + 1);
    const rows = this.db.prepare(`
      SELECT * FROM threads
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at ${ordering}, id ${ordering}
      LIMIT ?
    `).all(...params) as unknown as ThreadRow[];
    const hasNext = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => recordFromRow(row).thread),
      nextCursor: hasNext && last
        ? encodeCursor({ updatedAt: last.updated_at, id: last.id, direction })
        : null,
    };
  }

  setName(threadId: ThreadId, name: string | null, updatedAt: number): void {
    this.updateOne('UPDATE threads SET name = ?, updated_at = ? WHERE id = ?', [name, updatedAt, threadId], threadId);
  }

  setPreview(threadId: ThreadId, preview: string, updatedAt: number): void {
    this.updateOne('UPDATE threads SET preview = ?, updated_at = ? WHERE id = ?', [preview, updatedAt, threadId], threadId);
  }

  setStatus(threadId: ThreadId, status: ThreadStatus, updatedAt: number): void {
    this.updateOne(
      'UPDATE threads SET status_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(status), updatedAt, threadId],
      threadId,
    );
  }

  setArchived(threadId: ThreadId, archived: boolean, updatedAt: number): void {
    this.updateOne(
      'UPDATE threads SET archived = ?, updated_at = ? WHERE id = ?',
      [archived ? 1 : 0, updatedAt, threadId],
      threadId,
    );
  }

  delete(threadId: ThreadId): void {
    const result = this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    if (result.changes !== 1) throw new Error(`Thread not found: ${threadId}`);
  }

  bindClientInput(binding: ClientInputBinding): ClientInputBinding {
    this.db.prepare(`
      INSERT INTO client_inputs(thread_id, client_id, turn_id, item_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, client_id) DO NOTHING
    `).run(binding.threadId, binding.clientId, binding.turnId, binding.itemId, binding.createdAt);
    return this.readClientInput(binding.threadId, binding.clientId)!;
  }

  readClientInput(threadId: ThreadId, clientId: string): ClientInputBinding | null {
    const row = this.db.prepare(`
      SELECT thread_id, client_id, turn_id, item_id, created_at
      FROM client_inputs WHERE thread_id = ? AND client_id = ?
    `).get(threadId, clientId) as {
      thread_id: string;
      client_id: string;
      turn_id: string;
      item_id: string;
      created_at: number;
    } | undefined;
    return row ? {
      threadId: row.thread_id,
      clientId: row.client_id,
      turnId: row.turn_id,
      itemId: row.item_id,
      createdAt: row.created_at,
    } : null;
  }

  deleteClientInput(threadId: ThreadId, clientId: string): void {
    this.db.prepare('DELETE FROM client_inputs WHERE thread_id = ? AND client_id = ?').run(threadId, clientId);
  }

  childEdges(parentThreadId: ThreadId, recursive = false): readonly SpawnEdge[] {
    const rows = recursive
      ? this.db.prepare(`
          WITH RECURSIVE descendants(parent_thread_id, child_thread_id, task_path, created_at) AS (
            SELECT parent_thread_id, child_thread_id, task_path, created_at
            FROM spawn_edges WHERE parent_thread_id = ?
            UNION ALL
            SELECT edge.parent_thread_id, edge.child_thread_id, edge.task_path, edge.created_at
            FROM spawn_edges edge JOIN descendants parent ON edge.parent_thread_id = parent.child_thread_id
          )
          SELECT * FROM descendants ORDER BY created_at, child_thread_id
        `).all(parentThreadId)
      : this.db.prepare(`
          SELECT parent_thread_id, child_thread_id, task_path, created_at
          FROM spawn_edges WHERE parent_thread_id = ? ORDER BY created_at, child_thread_id
        `).all(parentThreadId);
    return (rows as unknown as Array<{
      parent_thread_id: string;
      child_thread_id: string;
      task_path: string;
      created_at: number;
    }>).map((row) => ({
      parentThreadId: row.parent_thread_id,
      childThreadId: row.child_thread_id,
      taskPath: row.task_path,
      createdAt: row.created_at,
    }));
  }

  private updateOne(sql: string, params: readonly SqliteValue[], threadId: ThreadId): void {
    const result = this.db.prepare(sql).run(...params);
    if (result.changes !== 1) throw new Error(`Thread not found: ${threadId}`);
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function recordFromRow(row: ThreadRow): ThreadCatalogRecord {
  const thread = decodeThread({
    id: row.id,
    sessionId: row.session_id,
    parentThreadId: row.parent_thread_id,
    forkedFromId: row.forked_from_id,
    agentNickname: row.agent_nickname,
    agentRole: row.agent_role,
    name: row.name,
    preview: row.preview,
    ephemeral: row.ephemeral === 1,
    source: row.source,
    threadSource: row.thread_source,
    modelProvider: row.model_provider,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: JSON.parse(row.status_json),
    historyMode: 'paginated',
  });
  return {
    thread,
    archived: row.archived === 1,
    configuration: JSON.parse(row.configuration_json) as EffectiveThreadConfiguration,
  };
}

function decodeThreadCursor(
  encoded: string | null | undefined,
  direction: 'asc' | 'desc',
): { updatedAt: number; id: string } | null {
  const cursor = decodeCursor(encoded);
  if (!cursor) return null;
  if (
    typeof cursor.updatedAt !== 'number'
    || !Number.isFinite(cursor.updatedAt)
    || typeof cursor.id !== 'string'
    || cursor.direction !== direction
  ) {
    throw new Error('Invalid Thread pagination cursor');
  }
  return { updatedAt: cursor.updatedAt, id: cursor.id };
}
