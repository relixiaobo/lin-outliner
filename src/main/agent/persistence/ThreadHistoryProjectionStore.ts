import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  decodeAgentCoreRecordedNotification,
  decodeThreadItem,
  decodeTurn,
} from '../../../core/agent/codec';
import type {
  AgentCoreRecordedNotification,
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
  RolloutSnapshotEvent,
  ThreadHistoryRetryMarker,
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

export interface ThreadHistoryVisibleEntry {
  readonly threadId: ThreadId;
  readonly turnId: string;
  readonly turnPosition: number;
  readonly itemIndex: number;
  readonly item: ThreadItem;
}

export interface ThreadHistoryTurnPage {
  readonly turns: readonly Turn[];
  readonly oldestPosition: number | null;
  readonly newestPosition: number | null;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

type StreamingItemsByTurn = Map<string, Map<string, ThreadItem>>;

export type ThreadProjectionReconcileResult = 'reconciled' | 'rolloutMissing';

export class ThreadHistoryProjectionStore {
  private readonly db: SqliteDatabase;
  private readonly streamingItems = new Map<ThreadId, StreamingItemsByTurn>();
  private streamingUndoActions: Array<() => void> | null = null;

  constructor(path: string, database?: SqliteDatabase) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? openSqlite(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
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
      CREATE INDEX IF NOT EXISTS thread_items_visible_history_idx
        ON thread_items(thread_id, turn_position, item_index, item_id)
        WHERE item_type IN (
          'userMessage', 'agentMessage', 'commandExecution', 'fileChange',
          'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'
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
    `);
  }

  close(): void {
    this.streamingItems.clear();
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

  rollbackMarker(rollbackId: string): ThreadHistoryRollbackMarker | null {
    const row = this.db.prepare(`
      SELECT * FROM history_rollbacks WHERE rollback_id = ?
    `).get(rollbackId) as unknown as RollbackRow | undefined;
    return row ? rollbackMarkerFromRow(row) : null;
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

  reconcileThread(threadId: ThreadId, entries: readonly RolloutEntry[]): ThreadProjectionReconcileResult {
    if (entries.some((entry) => entry.event.threadId !== threadId)) {
      throw new Error('Cannot reconcile a Thread from another rollout');
    }
    const watermark = this.watermark(threadId);
    if (entries.length === 0 && watermark.ordinal >= 0) return 'rolloutMissing';
    const projectedEntry = watermark.ordinal < 0 ? null : entries[watermark.ordinal];
    const projectedBoundary = watermark.ordinal < 0
      ? 0
      : projectedEntry
        ? projectedEntry.byteOffset + projectedEntry.byteLength
        : null;
    if (projectedBoundary !== watermark.byteOffset) {
      this.rebuildThread(threadId, entries);
      return 'reconciled';
    }
    this.applyMany(entries.slice(watermark.ordinal + 1));
    return 'reconciled';
  }

  rolloutSnapshot(threadId: ThreadId): readonly RolloutSnapshotEvent[] {
    const turnRows = this.db.prepare(`
      SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY position
    `).all(threadId) as unknown as TurnRow[];
    const records: RolloutSnapshotEvent[] = [];
    for (const turnRow of turnRows) {
      const itemRows = this.db.prepare(`
        SELECT * FROM thread_items
        WHERE thread_id = ? AND turn_id = ? ORDER BY item_index
      `).all(threadId, turnRow.turn_id) as unknown as ItemRow[];
      const turn = this.turnFromRow(turnRow, 'full');
      if (turn.status !== 'inProgress') {
        records.push({
          event: decodeAgentCoreRecordedNotification({
            type: 'turn/completed',
            threadId,
            turnId: turn.id,
            turn,
          }),
          recordedAt: turn.completedAt ?? turn.startedAt,
        });
        continue;
      }
      records.push({
        event: decodeAgentCoreRecordedNotification({
          type: 'turn/started',
          threadId,
          turnId: turn.id,
          turn: decodeTurn({ ...turn, items: [] }),
        }),
        recordedAt: turn.startedAt,
      });
      for (const row of itemRows) {
        const item = this.itemFromRow(row);
        if (row.completed_at !== null) {
          records.push({
            event: decodeAgentCoreRecordedNotification({
              type: 'items/completed',
              threadId,
              turnId: turn.id,
              items: [item],
              completedAt: row.completed_at,
            }),
            recordedAt: row.completed_at,
          });
          continue;
        }
        const startedAt = row.started_at ?? turn.startedAt;
        records.push({
          event: decodeAgentCoreRecordedNotification({
            type: 'item/started',
            threadId,
            turnId: turn.id,
            itemId: item.id,
            item,
            startedAt,
          }),
          recordedAt: startedAt,
        });
      }
    }
    return records;
  }

  rebuildThread(threadId: ThreadId, entries: readonly RolloutEntry[]): void {
    this.transaction(() => {
      this.deleteThreadStreamingItems(threadId);
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
      this.deleteThreadStreamingItems(threadId);
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
        item: this.itemFromRow(row),
      })),
      nextCursor: hasNext && last ? itemCursor(last, direction) : null,
      backwardsCursor: first ? itemCursor(first, opposite(direction)) : null,
    };
  }

  /**
   * Every Turn of a Thread, paged. The single owner of that paging contract, so
   * in-process readers and the `agent:dump` CLI cannot drift apart on it.
   */
  allTurns(threadId: ThreadId, itemsView: TurnItemsView = 'full'): Turn[] {
    const turns: Turn[] = [];
    let cursor: string | null = null;
    do {
      const page: ThreadTurnsListResponse = this.listTurns({ threadId, cursor, limit: 100, itemsView });
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return turns;
  }

  readTurn(threadId: ThreadId, turnId: string, itemsView: TurnItemsView = 'full'): Turn | null {
    const row = this.db.prepare(`
      SELECT * FROM thread_turns WHERE thread_id = ? AND turn_id = ?
    `).get(threadId, turnId) as TurnRow | undefined;
    return row ? this.turnFromRow(row, itemsView) : null;
  }

  visibleHistoryEntries(
    threadIds: readonly ThreadId[],
    options: { readonly maximum?: number; readonly newestFirst?: boolean } = {},
  ): ThreadHistoryVisibleEntry[] {
    const maximum = Math.max(1, Math.min(options.maximum ?? 2_000, 5_000));
    const ordering = options.newestFirst === false ? 'ASC' : 'DESC';
    const entries: ThreadHistoryVisibleEntry[] = [];
    const admittedThreadIds = [...new Set(threadIds)].slice(0, maximum);
    if (admittedThreadIds.length === 0) return entries;
    const perThreadMaximum = Math.max(1, Math.floor(maximum / Math.max(1, admittedThreadIds.length)));
    const statement = this.db.prepare(`
      SELECT * FROM thread_items
      WHERE thread_id = ?
        AND item_type IN (
          'userMessage', 'agentMessage', 'commandExecution', 'fileChange',
          'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'
        )
      ORDER BY turn_position ${ordering}, item_index ${ordering}, item_id ${ordering}
      LIMIT ?
    `);
    const rowsByThread = admittedThreadIds.map((threadId) => (
      statement.all(threadId, perThreadMaximum) as unknown as ItemRow[]
    ));
    for (let rank = 0; rank < perThreadMaximum && entries.length < maximum; rank += 1) {
      for (const rows of rowsByThread) {
        const row = rows[rank];
        if (!row) continue;
        entries.push({
          threadId: row.thread_id,
          turnId: row.turn_id,
          turnPosition: row.turn_position,
          itemIndex: row.item_index,
          item: this.itemFromRow(row),
        });
      }
    }
    return entries;
  }

  turnAtPosition(threadId: ThreadId, position: number): Turn | null {
    const row = this.db.prepare(`
      SELECT * FROM thread_turns WHERE thread_id = ? AND position = ?
    `).get(threadId, position) as unknown as TurnRow | undefined;
    return row ? this.turnFromRow(row, 'full') : null;
  }

  turnPosition(threadId: ThreadId, turnId: string): number | null {
    const row = this.db.prepare(`
      SELECT position FROM thread_turns WHERE thread_id = ? AND turn_id = ?
    `).get(threadId, turnId) as { position: number } | undefined;
    return row?.position ?? null;
  }

  historyTurnPage(
    threadId: ThreadId,
    anchorPosition: number | null,
    limit: number,
  ): ThreadHistoryTurnPage {
    const boundedLimit = Math.max(1, Math.min(limit, 10));
    const rows = this.db.prepare(`
      SELECT * FROM thread_turns
      WHERE thread_id = ? AND (? IS NULL OR position <= ?)
      ORDER BY position DESC, turn_id DESC
      LIMIT ?
    `).all(threadId, anchorPosition, anchorPosition, boundedLimit) as unknown as TurnRow[];
    const chronological = [...rows].reverse();
    const oldestPosition = chronological[0]?.position ?? null;
    const newestPosition = chronological.at(-1)?.position ?? null;
    const hasOlder = oldestPosition !== null && Boolean(this.db.prepare(`
      SELECT 1 FROM thread_turns WHERE thread_id = ? AND position < ? LIMIT 1
    `).get(threadId, oldestPosition));
    const hasNewer = newestPosition !== null && Boolean(this.db.prepare(`
      SELECT 1 FROM thread_turns WHERE thread_id = ? AND position > ? LIMIT 1
    `).get(threadId, newestPosition));
    return {
      turns: chronological.map((row) => this.turnFromRow(row, 'full')),
      oldestPosition,
      newestPosition,
      hasOlder,
      hasNewer,
    };
  }

  unfinishedItems(threadId: ThreadId, turnId: string): readonly ThreadItem[] {
    const rows = this.db.prepare(`
      SELECT * FROM thread_items
      WHERE thread_id = ? AND turn_id = ? AND completed_at IS NULL
      ORDER BY item_index
    `).all(threadId, turnId) as unknown as ItemRow[];
    return rows.map((row) => this.itemFromRow(row));
  }

  restoreOpenItemsFromRollout(
    threadId: ThreadId,
    turnId: string,
    entries: readonly RolloutEntry[],
  ): void {
    const openItems = reconstructOpenItems(threadId, turnId, entries);
    this.transaction(() => {
      this.requireMutableTurnPosition(threadId, turnId);
      for (const item of openItems.values()) {
        const row = this.readItemRow(threadId, item.id);
        if (!row) throw new Error(`Recovered Item start is missing from projection: ${item.id}`);
        if (row.turn_id !== turnId) throw new Error(`Recovered Thread Item does not belong to Turn: ${item.id}`);
        if (row.completed_at !== null) throw new Error(`Recovered Thread Item is already complete: ${item.id}`);
        const decoded = decodeThreadItem(item);
        const result = this.db.prepare(`
          UPDATE thread_items SET item_json = ?, item_type = ?
          WHERE thread_id = ? AND turn_id = ? AND item_id = ? AND completed_at IS NULL
        `).run(JSON.stringify(decoded), decoded.type, threadId, turnId, decoded.id);
        if (Number(result.changes) !== 1) throw new Error(`Failed to restore streamed Thread Item: ${item.id}`);
      }
      this.deleteTurnStreamingItems(threadId, turnId);
    });
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
    if (event.type === 'history/retry') {
      this.projectRollback(ordinal, projectionVersion, event);
      this.projectNotification(ordinal, event.replacement);
      return;
    }
    if (event.type === 'history/rollback') {
      this.projectRollback(ordinal, projectionVersion, event);
      return;
    }
    this.projectNotification(ordinal, event);
  }

  private projectRollback(
    ordinal: number,
    projectionVersion: number,
    marker: ThreadHistoryRollbackMarker | ThreadHistoryRetryMarker,
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
      this.deleteTurnStreamingItems(marker.threadId, turnId);
      this.db.prepare('DELETE FROM thread_turns WHERE thread_id = ? AND turn_id = ?').run(marker.threadId, turnId);
    }
  }

  private projectNotification(ordinal: number, notification: AgentCoreRecordedNotification): void {
    switch (notification.type) {
      case 'turn/started':
        if (this.readTurnRow(notification.threadId, notification.turnId)) {
          throw new Error(`Turn was already started: ${notification.turnId}`);
        }
        this.upsertTurn(notification.threadId, ordinal, notification.turn);
        notification.turn.items.forEach((item, index) => {
          this.upsertItem(
            notification.threadId,
            notification.turnId,
            ordinal,
            index,
            item,
            notification.turn.startedAt,
            notification.turn.startedAt,
          );
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
          this.deleteTurnStreamingItems(notification.threadId, notification.turnId);
          return;
        }
        if (existing.status !== 'inProgress') throw new Error(`Terminal Turn is immutable: ${notification.turnId}`);
        this.assertTurnItemsMatch(notification.threadId, notification.turnId, notification.turn.items);
        this.upsertTurn(notification.threadId, ordinal, notification.turn);
        this.deleteTurnStreamingItems(notification.threadId, notification.turnId);
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
        this.deleteStreamingItem(notification.threadId, notification.turnId, notification.itemId);
        return;
      }
      case 'items/completed': {
        const turnPosition = this.requireMutableTurnPosition(notification.threadId, notification.turnId);
        for (const item of notification.items) {
          const existing = this.readItemRow(notification.threadId, item.id);
          if (existing?.turn_id !== undefined && existing.turn_id !== notification.turnId) {
            throw new Error(`Thread Item does not belong to Turn: ${item.id}`);
          }
          if (existing?.completed_at !== null && existing?.completed_at !== undefined) {
            throw new Error(`Completed Thread Item is immutable: ${item.id}`);
          }
          const itemIndex = this.nextItemIndex(notification.threadId, notification.turnId, item.id);
          this.upsertItem(
            notification.threadId,
            notification.turnId,
            turnPosition,
            itemIndex,
            item,
            notification.completedAt,
            notification.completedAt,
          );
          this.deleteStreamingItem(notification.threadId, notification.turnId, item.id);
        }
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
    delta: Extract<AgentCoreRecordedNotification, { type: 'item/delta' }>['delta'],
  ): void {
    this.requireMutableTurnPosition(threadId, turnId);
    const row = this.readItemRow(threadId, itemId);
    if (!row) throw new Error(`Item delta precedes item start: ${itemId}`);
    if (row.turn_id !== turnId) throw new Error(`Thread Item does not belong to Turn: ${itemId}`);
    if (row.completed_at !== null) throw new Error(`Completed Thread Item is immutable: ${itemId}`);
    const item = this.streamingItems.get(threadId)?.get(turnId)?.get(itemId)
      ?? decodeThreadItem(JSON.parse(row.item_json));
    const updated = applyThreadItemDelta(item, delta);
    this.setStreamingItem(threadId, turnId, updated);
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
      // Compare canonical decoded forms, not stored bytes. The invariant is
      // "this terminal Item did not change", independent of JSON formatting.
      const stored = JSON.stringify(decodeThreadItem(JSON.parse(row.item_json)));
      if (row.item_id !== item.id || stored !== JSON.stringify(decodeThreadItem(item))) {
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
          SELECT * FROM thread_items
          WHERE thread_id = ? AND turn_id = ? ORDER BY item_index
        `).all(row.thread_id, row.turn_id) as unknown as ItemRow[])
        .map((itemRow) => this.itemFromRow(itemRow));
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
    if (this.streamingUndoActions) throw new Error('Nested history projection transaction is not allowed');
    const undoActions: Array<() => void> = [];
    this.streamingUndoActions = undoActions;
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      for (let index = undoActions.length - 1; index >= 0; index -= 1) undoActions[index]!();
      if (began) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'History projection transaction failed to roll back');
        }
      }
      throw error;
    } finally {
      this.streamingUndoActions = null;
    }
  }

  private itemFromRow(row: ItemRow): ThreadItem {
    return this.streamingItems.get(row.thread_id)?.get(row.turn_id)?.get(row.item_id)
      ?? decodeThreadItem(JSON.parse(row.item_json));
  }

  private setStreamingItem(threadId: ThreadId, turnId: string, item: ThreadItem): void {
    const previousItems = this.streamingItems.get(threadId)?.get(turnId);
    const hadPrevious = previousItems?.has(item.id) ?? false;
    const previous = previousItems?.get(item.id);
    this.recordStreamingUndo(hadPrevious
      ? () => this.setStreamingItemRaw(threadId, turnId, previous!)
      : () => this.deleteStreamingItemRaw(threadId, turnId, item.id));
    this.setStreamingItemRaw(threadId, turnId, item);
  }

  private setStreamingItemRaw(threadId: ThreadId, turnId: string, item: ThreadItem): void {
    let turns = this.streamingItems.get(threadId);
    if (!turns) {
      turns = new Map();
      this.streamingItems.set(threadId, turns);
    }
    let items = turns.get(turnId);
    if (!items) {
      items = new Map();
      turns.set(turnId, items);
    }
    items.set(item.id, item);
  }

  private deleteStreamingItem(threadId: ThreadId, turnId: string, itemId: string): void {
    const previous = this.streamingItems.get(threadId)?.get(turnId)?.get(itemId);
    if (!previous) return;
    this.recordStreamingUndo(() => this.setStreamingItemRaw(threadId, turnId, previous));
    this.deleteStreamingItemRaw(threadId, turnId, itemId);
  }

  private deleteStreamingItemRaw(threadId: ThreadId, turnId: string, itemId: string): void {
    const turns = this.streamingItems.get(threadId);
    const items = turns?.get(turnId);
    if (!items) return;
    items.delete(itemId);
    if (items.size === 0) turns!.delete(turnId);
    if (turns!.size === 0) this.streamingItems.delete(threadId);
  }

  private deleteTurnStreamingItems(threadId: ThreadId, turnId: string): void {
    const turns = this.streamingItems.get(threadId);
    const previous = turns?.get(turnId);
    if (!turns || !previous) return;
    this.recordStreamingUndo(() => this.setStreamingTurnRaw(threadId, turnId, previous));
    turns.delete(turnId);
    if (turns.size === 0) this.streamingItems.delete(threadId);
  }

  private setStreamingTurnRaw(threadId: ThreadId, turnId: string, items: Map<string, ThreadItem>): void {
    let turns = this.streamingItems.get(threadId);
    if (!turns) {
      turns = new Map();
      this.streamingItems.set(threadId, turns);
    }
    turns.set(turnId, items);
  }

  private deleteThreadStreamingItems(threadId: ThreadId): void {
    const previous = this.streamingItems.get(threadId);
    if (!previous) return;
    this.recordStreamingUndo(() => this.streamingItems.set(threadId, previous));
    this.streamingItems.delete(threadId);
  }

  private recordStreamingUndo(action: () => void): void {
    this.streamingUndoActions?.push(action);
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

function reconstructOpenItems(
  threadId: ThreadId,
  turnId: string,
  entries: readonly RolloutEntry[],
): ReadonlyMap<string, ThreadItem> {
  const openItems = new Map<string, ThreadItem>();
  let turnStarted = false;
  for (const entry of entries) {
    if (entry.event.threadId !== threadId) throw new Error('Cannot recover a Thread from another rollout');
    const event = entry.event;
    if (event.type === 'history/rollback' || event.type === 'history/retry') {
      if (event.omittedTurnIds.includes(turnId)) {
        openItems.clear();
        turnStarted = false;
      }
      if (event.type === 'history/retry' && event.replacement.turnId === turnId) {
        openItems.clear();
        turnStarted = true;
      }
      continue;
    }
    switch (event.type) {
      case 'turn/started':
        if (event.turnId !== turnId) break;
        openItems.clear();
        turnStarted = true;
        break;
      case 'item/started':
        if (event.turnId !== turnId) break;
        if (!turnStarted) throw new Error(`Recovered Item lifecycle precedes Turn start: ${turnId}`);
        if (openItems.has(event.itemId)) throw new Error(`Recovered Thread Item was already started: ${event.itemId}`);
        openItems.set(event.itemId, event.item);
        break;
      case 'item/delta': {
        if (event.turnId !== turnId) break;
        const item = openItems.get(event.itemId);
        if (!item) throw new Error(`Recovered Item delta precedes item start: ${event.itemId}`);
        openItems.set(event.itemId, applyThreadItemDelta(item, event.delta));
        break;
      }
      case 'item/completed':
        if (event.turnId === turnId) openItems.delete(event.itemId);
        break;
      case 'items/completed':
        if (event.turnId === turnId) {
          for (const item of event.items) openItems.delete(item.id);
        }
        break;
      case 'turn/completed':
        if (event.turnId === turnId) {
          openItems.clear();
          turnStarted = false;
        }
        break;
      default:
        break;
    }
  }
  if (!turnStarted) throw new Error(`Cannot recover missing in-progress Turn: ${turnId}`);
  return openItems;
}
