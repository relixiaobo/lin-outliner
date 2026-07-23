import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeThreadItem, decodeTurn } from '../../../core/agent/codec';
import type {
  AgentCoreNotification,
  ThreadId,
  ThreadItem,
  ThreadItemEntry,
  ThreadItemsListRequest,
  ThreadItemsListResponse,
  ThreadTurnsListRequest,
  ThreadTurnsListResponse,
  Turn,
  TurnItemsView,
} from '../../../core/agent/protocol';
import { decodeCursor, encodeCursor, pageLimit } from './cursor';
import type {
  RolloutEntry,
  RolloutEvent,
  ThreadHistoryRollbackMarker,
} from './RolloutStore';
import { openSqlite, type SqliteDatabase, type SqliteValue } from './sqlite';
import { applyThreadItemDelta } from '../itemDelta';

interface TurnRow {
  thread_id: string;
  turn_id: string;
  position: number;
  provenance_json: string;
  status: string;
  error_json: string;
  execution_json: string;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
}

interface ItemRow {
  thread_id: string;
  turn_id: string;
  item_id: string;
  turn_position: number;
  item_index: number;
  item_type: string;
  item_json: string;
  started_at: number | null;
  completed_at: number | null;
}

interface RollbackRow {
  rollback_id: string;
  thread_id: string;
  marker_ordinal: number;
  omitted_turn_ids_json: string;
  before_projection_version: number;
  after_projection_version: number;
}

export interface ProjectionWatermark {
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly byteOffset: number;
}

export class ThreadHistoryProjectionStore {
  private readonly db: SqliteDatabase;

  constructor(path: string, database?: SqliteDatabase) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? openSqlite(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`
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
    `);
  }

  close(): void {
    this.db.close();
  }

  watermark(threadId: ThreadId): ProjectionWatermark {
    const row = this.db.prepare(`
      SELECT thread_id, ordinal, byte_offset FROM rollout_watermarks WHERE thread_id = ?
    `).get(threadId) as { thread_id: string; ordinal: number; byte_offset: number } | undefined;
    return row
      ? { threadId: row.thread_id, ordinal: row.ordinal, byteOffset: row.byte_offset }
      : { threadId, ordinal: -1, byteOffset: 0 };
  }

  projectionVersion(threadId: ThreadId): number {
    return this.watermark(threadId).ordinal + 1;
  }

  rollbackMarkers(threadId: ThreadId): readonly ThreadHistoryRollbackMarker[] {
    const rows = this.db.prepare(`
      SELECT * FROM history_rollbacks WHERE thread_id = ? ORDER BY marker_ordinal
    `).all(threadId) as unknown as RollbackRow[];
    return rows.map(rollbackMarkerFromRow);
  }

  hasRollbackMarker(rollbackId: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM history_rollbacks WHERE rollback_id = ?
    `).get(rollbackId));
  }

  apply(entry: RolloutEntry): void {
    this.transaction(() => this.applyInside(entry));
  }

  applyMany(entries: readonly RolloutEntry[]): void {
    if (entries.length === 0) return;
    this.transaction(() => {
      for (const entry of entries) this.applyInside(entry);
    });
  }

  rebuildThread(threadId: ThreadId, entries: readonly RolloutEntry[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM thread_turns WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM history_rollbacks WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM rollout_watermarks WHERE thread_id = ?').run(threadId);
      for (const entry of entries) {
        if (entry.event.threadId !== threadId) throw new Error('Cannot rebuild a Thread from another rollout');
        this.applyInside(entry);
      }
    });
  }

  deleteThread(threadId: ThreadId): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM thread_turns WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM history_rollbacks WHERE thread_id = ?').run(threadId);
      this.db.prepare('DELETE FROM rollout_watermarks WHERE thread_id = ?').run(threadId);
    });
  }

  listTurns(request: ThreadTurnsListRequest): ThreadTurnsListResponse {
    const limit = pageLimit(request.limit);
    const direction = request.sortDirection ?? 'asc';
    const itemsView = request.itemsView ?? 'full';
    const cursor = decodeHistoryCursor(request.cursor, direction, 'turn');
    const comparison = direction === 'asc' ? '>' : '<';
    const ordering = direction === 'asc' ? 'ASC' : 'DESC';
    const params: SqliteValue[] = [request.threadId];
    const cursorClause = cursor
      ? `AND (position ${comparison} ? OR (position = ? AND turn_id ${comparison} ?))`
      : '';
    if (cursor) params.push(cursor.position, cursor.position, cursor.id);
    params.push(limit + 1);
    const rows = this.db.prepare(`
      SELECT * FROM thread_turns
      WHERE thread_id = ? ${cursorClause}
      ORDER BY position ${ordering}, turn_id ${ordering}
      LIMIT ?
    `).all(...params) as unknown as TurnRow[];
    const hasNext = rows.length > limit;
    const page = rows.slice(0, limit);
    const turns = page.map((row) => this.turnFromRow(row, itemsView));
    const first = page[0];
    const last = page.at(-1);
    return {
      data: turns,
      nextCursor: hasNext && last
        ? encodeCursor({ kind: 'turn', position: last.position, id: last.turn_id, direction })
        : null,
      backwardsCursor: first
        ? encodeCursor({ kind: 'turn', position: first.position, id: first.turn_id, direction: opposite(direction) })
        : null,
    };
  }

  listItems(request: ThreadItemsListRequest): ThreadItemsListResponse {
    const limit = pageLimit(request.limit);
    const direction = request.sortDirection ?? 'asc';
    const cursor = decodeItemCursor(request.cursor, direction);
    const comparison = direction === 'asc' ? '>' : '<';
    const ordering = direction === 'asc' ? 'ASC' : 'DESC';
    const where = ['thread_id = ?'];
    const params: SqliteValue[] = [request.threadId];
    if (request.turnId) {
      where.push('turn_id = ?');
      params.push(request.turnId);
    }
    if (cursor) {
      where.push(`(
        turn_position ${comparison} ?
        OR (turn_position = ? AND item_index ${comparison} ?)
        OR (turn_position = ? AND item_index = ? AND item_id ${comparison} ?)
      )`);
      params.push(
        cursor.turnPosition,
        cursor.turnPosition,
        cursor.itemIndex,
        cursor.turnPosition,
        cursor.itemIndex,
        cursor.id,
      );
    }
    params.push(limit + 1);
    const rows = this.db.prepare(`
      SELECT * FROM thread_items
      WHERE ${where.join(' AND ')}
      ORDER BY turn_position ${ordering}, item_index ${ordering}, item_id ${ordering}
      LIMIT ?
    `).all(...params) as unknown as ItemRow[];
    const hasNext = rows.length > limit;
    const page = rows.slice(0, limit);
    const first = page[0];
    const last = page.at(-1);
    return {
      data: page.map((row): ThreadItemEntry => ({
        turnId: row.turn_id,
        item: decodeThreadItem(JSON.parse(row.item_json)),
      })),
      nextCursor: hasNext && last ? itemCursor(last, direction) : null,
      backwardsCursor: first ? itemCursor(first, opposite(direction)) : null,
    };
  }

  readTurn(threadId: ThreadId, turnId: string, itemsView: TurnItemsView = 'full'): Turn | null {
    const row = this.db.prepare(`
      SELECT * FROM thread_turns WHERE thread_id = ? AND turn_id = ?
    `).get(threadId, turnId) as TurnRow | undefined;
    return row ? this.turnFromRow(row, itemsView) : null;
  }

  unfinishedItems(threadId: ThreadId, turnId: string): readonly ThreadItem[] {
    const rows = this.db.prepare(`
      SELECT * FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND completed_at IS NULL
      ORDER BY item_index
    `).all(threadId, turnId) as unknown as ItemRow[];
    return rows.map((row) => decodeThreadItem(JSON.parse(row.item_json)));
  }

  private applyInside(entry: RolloutEntry): void {
    const threadId = entry.event.threadId;
    const watermark = this.watermark(threadId);
    if (entry.ordinal <= watermark.ordinal) return;
    if (entry.ordinal !== watermark.ordinal + 1) {
      throw new Error(`Rollout projection gap for ${threadId}: expected ${watermark.ordinal + 1}, got ${entry.ordinal}`);
    }
    this.projectEvent(entry.ordinal, watermark.ordinal + 1, entry.event);
    this.db.prepare(`
      INSERT INTO rollout_watermarks(thread_id, ordinal, byte_offset) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET ordinal = excluded.ordinal, byte_offset = excluded.byte_offset
    `).run(threadId, entry.ordinal, entry.byteOffset + entry.byteLength);
  }

  private projectEvent(ordinal: number, projectionVersion: number, event: RolloutEvent): void {
    if (event.type === 'history/rollback') {
      this.projectRollback(ordinal, projectionVersion, event);
      return;
    }
    this.projectNotification(ordinal, event);
  }

  private projectRollback(
    ordinal: number,
    projectionVersion: number,
    marker: ThreadHistoryRollbackMarker,
  ): void {
    if (marker.beforeProjectionVersion !== projectionVersion) {
      throw new Error(`History rollback before-version mismatch: ${marker.rollbackId}`);
    }
    if (marker.afterProjectionVersion !== projectionVersion + 1) {
      throw new Error(`History rollback after-version mismatch: ${marker.rollbackId}`);
    }
    if (this.hasRollbackMarker(marker.rollbackId)) {
      throw new Error(`History rollback marker was already applied: ${marker.rollbackId}`);
    }
    const suffix = (this.db.prepare(`
      SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY position DESC LIMIT ?
    `).all(marker.threadId, marker.omittedTurnIds.length) as unknown as TurnRow[]).reverse();
    const suffixIds = suffix.map((row) => row.turn_id);
    if (
      suffixIds.length !== marker.omittedTurnIds.length
      || suffixIds.some((turnId, index) => turnId !== marker.omittedTurnIds[index])
    ) {
      throw new Error(`History rollback must omit the current Turn suffix: ${marker.rollbackId}`);
    }
    if (suffix.some((row) => row.status === 'inProgress')) {
      throw new Error(`History rollback cannot omit an active Turn: ${marker.rollbackId}`);
    }
    this.db.prepare(`
      INSERT INTO history_rollbacks(
        rollback_id, thread_id, marker_ordinal, omitted_turn_ids_json,
        before_projection_version, after_projection_version
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      marker.rollbackId,
      marker.threadId,
      ordinal,
      JSON.stringify(marker.omittedTurnIds),
      marker.beforeProjectionVersion,
      marker.afterProjectionVersion,
    );
    for (const turnId of marker.omittedTurnIds) {
      this.db.prepare('DELETE FROM thread_turns WHERE thread_id = ? AND turn_id = ?').run(marker.threadId, turnId);
    }
  }

  private projectNotification(ordinal: number, notification: AgentCoreNotification): void {
    switch (notification.type) {
      case 'turn/started':
        if (this.readTurnRow(notification.threadId, notification.turnId)) {
          throw new Error(`Turn was already started: ${notification.turnId}`);
        }
        this.upsertTurn(notification.threadId, ordinal, notification.turn);
        notification.turn.items.forEach((item, index) => {
          this.upsertItem(notification.threadId, notification.turnId, ordinal, index, item, null, null);
        });
        return;
      case 'turn/completed': {
        const existing = this.readTurnRow(notification.threadId, notification.turnId);
        if (!existing) {
          this.upsertTurn(notification.threadId, ordinal, notification.turn);
          notification.turn.items.forEach((item, index) => {
            this.upsertItem(
              notification.threadId,
              notification.turnId,
              ordinal,
              index,
              item,
              notification.turn.startedAt,
              notification.turn.completedAt,
            );
          });
          return;
        }
        if (existing.status !== 'inProgress') throw new Error(`Terminal Turn is immutable: ${notification.turnId}`);
        this.assertTurnItemsMatch(notification.threadId, notification.turnId, notification.turn.items);
        this.upsertTurn(notification.threadId, ordinal, notification.turn);
        return;
      }
      case 'item/started': {
        const turnPosition = this.requireMutableTurnPosition(notification.threadId, notification.turnId);
        if (this.readItemRow(notification.threadId, notification.itemId)) {
          throw new Error(`Thread Item was already started: ${notification.itemId}`);
        }
        const itemIndex = this.nextItemIndex(notification.threadId, notification.turnId, notification.itemId);
        this.upsertItem(
          notification.threadId,
          notification.turnId,
          turnPosition,
          itemIndex,
          notification.item,
          notification.startedAt,
          null,
        );
        return;
      }
      case 'item/completed': {
        const turnPosition = this.requireMutableTurnPosition(notification.threadId, notification.turnId);
        const existing = this.readItemRow(notification.threadId, notification.itemId);
        if (!existing) throw new Error(`Item completion precedes item start: ${notification.itemId}`);
        if (existing.completed_at !== null) throw new Error(`Completed Thread Item is immutable: ${notification.itemId}`);
        const itemIndex = this.nextItemIndex(notification.threadId, notification.turnId, notification.itemId);
        this.upsertItem(
          notification.threadId,
          notification.turnId,
          turnPosition,
          itemIndex,
          notification.item,
          null,
          notification.completedAt,
        );
        return;
      }
      case 'item/delta':
        this.applyItemDelta(notification.threadId, notification.turnId, notification.itemId, notification.delta);
        return;
      default:
        return;
    }
  }

  private upsertTurn(threadId: ThreadId, position: number, turn: Turn): void {
    const decoded = decodeTurn(turn);
    this.db.prepare(`
      INSERT INTO thread_turns(
        thread_id, turn_id, position, provenance_json, status, error_json, execution_json,
        started_at, completed_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, turn_id) DO UPDATE SET
        provenance_json = excluded.provenance_json,
        status = excluded.status,
        error_json = excluded.error_json,
        execution_json = excluded.execution_json,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        duration_ms = excluded.duration_ms
    `).run(
      threadId,
      decoded.id,
      position,
      JSON.stringify(decoded.provenance),
      decoded.status,
      JSON.stringify(decoded.error),
      JSON.stringify(decoded.execution),
      decoded.startedAt,
      decoded.completedAt,
      decoded.durationMs,
    );
  }

  private upsertItem(
    threadId: ThreadId,
    turnId: string,
    turnPosition: number,
    itemIndex: number,
    item: ThreadItem,
    startedAt: number | null,
    completedAt: number | null,
  ): void {
    const decoded = decodeThreadItem(item);
    this.db.prepare(`
      INSERT INTO thread_items(
        thread_id, turn_id, item_id, turn_position, item_index, item_type,
        item_json, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, item_id) DO UPDATE SET
        item_type = excluded.item_type,
        item_json = excluded.item_json,
        started_at = COALESCE(thread_items.started_at, excluded.started_at),
        completed_at = COALESCE(excluded.completed_at, thread_items.completed_at)
    `).run(
      threadId,
      turnId,
      decoded.id,
      turnPosition,
      itemIndex,
      decoded.type,
      JSON.stringify(decoded),
      startedAt,
      completedAt,
    );
  }

  private applyItemDelta(
    threadId: ThreadId,
    turnId: string,
    itemId: string,
    delta: Extract<AgentCoreNotification, { type: 'item/delta' }>['delta'],
  ): void {
    this.requireMutableTurnPosition(threadId, turnId);
    const row = this.readItemRow(threadId, itemId);
    if (!row) throw new Error(`Item delta precedes item start: ${itemId}`);
    if (row.turn_id !== turnId) throw new Error(`Thread Item does not belong to Turn: ${itemId}`);
    if (row.completed_at !== null) throw new Error(`Completed Thread Item is immutable: ${itemId}`);
    const item = decodeThreadItem(JSON.parse(row.item_json));
    const updated = applyThreadItemDelta(item, delta);
    this.db.prepare(`
      UPDATE thread_items SET item_json = ?, item_type = ? WHERE thread_id = ? AND item_id = ?
    `).run(JSON.stringify(updated), updated.type, threadId, itemId);
  }

  private requireMutableTurnPosition(threadId: ThreadId, turnId: string): number {
    const row = this.readTurnRow(threadId, turnId);
    if (!row) throw new Error(`Item lifecycle precedes Turn start: ${turnId}`);
    if (row.status !== 'inProgress') throw new Error(`Terminal Turn is immutable: ${turnId}`);
    return row.position;
  }

  private readTurnRow(threadId: ThreadId, turnId: string): TurnRow | null {
    return (this.db.prepare(`
      SELECT * FROM thread_turns WHERE thread_id = ? AND turn_id = ?
    `).get(threadId, turnId) as TurnRow | undefined) ?? null;
  }

  private readItemRow(threadId: ThreadId, itemId: string): ItemRow | null {
    return (this.db.prepare(`
      SELECT * FROM thread_items WHERE thread_id = ? AND item_id = ?
    `).get(threadId, itemId) as ItemRow | undefined) ?? null;
  }

  private assertTurnItemsMatch(threadId: ThreadId, turnId: string, items: readonly ThreadItem[]): void {
    const rows = this.db.prepare(`
      SELECT * FROM thread_items WHERE thread_id = ? AND turn_id = ? ORDER BY item_index
    `).all(threadId, turnId) as unknown as ItemRow[];
    if (rows.length !== items.length) throw new Error(`Terminal Turn Items do not match recorded Items: ${turnId}`);
    for (const [index, item] of items.entries()) {
      const row = rows[index]!;
      if (row.item_id !== item.id || row.item_json !== JSON.stringify(decodeThreadItem(item))) {
        throw new Error(`Terminal Turn Item mutation is not allowed: ${item.id}`);
      }
      if (row.completed_at === null) throw new Error(`Terminal Turn contains an unfinished Item: ${item.id}`);
    }
  }

  private nextItemIndex(threadId: ThreadId, turnId: string, itemId: string): number {
    const existing = this.db.prepare(`
      SELECT item_index FROM thread_items WHERE thread_id = ? AND item_id = ?
    `).get(threadId, itemId) as { item_index: number } | undefined;
    if (existing) return existing.item_index;
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(item_index), -1) + 1 AS next_index
      FROM thread_items WHERE thread_id = ? AND turn_id = ?
    `).get(threadId, turnId) as { next_index: number };
    return row.next_index;
  }

  private turnFromRow(row: TurnRow, itemsView: TurnItemsView): Turn {
    const items = itemsView === 'notLoaded'
      ? []
      : (this.db.prepare(`
          SELECT item_json FROM thread_items
          WHERE thread_id = ? AND turn_id = ? ORDER BY item_index
        `).all(row.thread_id, row.turn_id) as unknown as Array<{ item_json: string }>)
        .map((itemRow) => decodeThreadItem(JSON.parse(itemRow.item_json)));
    return decodeTurn({
      id: row.turn_id,
      items,
      itemsView,
      provenance: JSON.parse(row.provenance_json),
      status: row.status,
      error: JSON.parse(row.error_json),
      execution: JSON.parse(row.execution_json),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
    });
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

function rollbackMarkerFromRow(row: RollbackRow): ThreadHistoryRollbackMarker {
  return Object.freeze({
    type: 'history/rollback',
    rollbackId: row.rollback_id,
    threadId: row.thread_id,
    omittedTurnIds: Object.freeze(JSON.parse(row.omitted_turn_ids_json) as string[]),
    beforeProjectionVersion: row.before_projection_version,
    afterProjectionVersion: row.after_projection_version,
  });
}

function decodeHistoryCursor(
  encoded: string | null | undefined,
  direction: 'asc' | 'desc',
  kind: string,
): { position: number; id: string } | null {
  const cursor = decodeCursor(encoded);
  if (!cursor) return null;
  if (
    cursor.kind !== kind
    || cursor.direction !== direction
    || typeof cursor.position !== 'number'
    || !Number.isSafeInteger(cursor.position)
    || typeof cursor.id !== 'string'
  ) {
    throw new Error('Invalid history pagination cursor');
  }
  return { position: cursor.position, id: cursor.id };
}

function decodeItemCursor(
  encoded: string | null | undefined,
  direction: 'asc' | 'desc',
): { turnPosition: number; itemIndex: number; id: string } | null {
  const cursor = decodeCursor(encoded);
  if (!cursor) return null;
  if (
    cursor.kind !== 'item'
    || cursor.direction !== direction
    || typeof cursor.turnPosition !== 'number'
    || !Number.isSafeInteger(cursor.turnPosition)
    || typeof cursor.itemIndex !== 'number'
    || !Number.isSafeInteger(cursor.itemIndex)
    || typeof cursor.id !== 'string'
  ) {
    throw new Error('Invalid Item pagination cursor');
  }
  return { turnPosition: cursor.turnPosition, itemIndex: cursor.itemIndex, id: cursor.id };
}

function itemCursor(row: ItemRow, direction: 'asc' | 'desc'): string {
  return encodeCursor({
    kind: 'item',
    turnPosition: row.turn_position,
    itemIndex: row.item_index,
    id: row.item_id,
    direction,
  });
}

function opposite(direction: 'asc' | 'desc'): 'asc' | 'desc' {
  return direction === 'asc' ? 'desc' : 'asc';
}
