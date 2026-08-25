import { mkdir, open, readFile, rename, rm, stat, truncate, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeAgentCoreRecordedNotification,
  decodePersistedAgentCoreRecordedNotification,
} from '../../../core/agent/codec';
import {
  createThreadHistoryRollbackContext,
  type ThreadHistoryRollbackContext,
} from '../../../core/agent/extensions';
import type { AgentCoreRecordedNotification, ThreadId } from '../../../core/agent/protocol';

export interface ThreadHistoryRollbackMarker extends ThreadHistoryRollbackContext {
  readonly type: 'history/rollback';
}

export interface ThreadHistoryRetryMarker extends ThreadHistoryRollbackContext {
  readonly type: 'history/retry';
  readonly replacement: Extract<AgentCoreRecordedNotification, { readonly type: 'turn/started' }>;
}

export type RolloutEvent =
  | AgentCoreRecordedNotification
  | ThreadHistoryRollbackMarker
  | ThreadHistoryRetryMarker;

export interface RolloutRecord {
  readonly ordinal: number;
  readonly recordedAt: number;
  readonly event: RolloutEvent;
}

export interface RolloutEntry extends RolloutRecord {
  readonly byteOffset: number;
  readonly byteLength: number;
}

export interface RolloutSnapshotEvent {
  readonly event: AgentCoreRecordedNotification;
  readonly recordedAt: number;
}

interface RolloutEnvelope {
  readonly ordinal: number;
  readonly recordedAt: number;
  readonly event: unknown;
}

type RolloutDecodeMode = 'strict' | 'persisted';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLLOUT_GROUP_COMMIT_DELAY_MS = 150;
const ROLLOUT_OPEN_HANDLE_LIMIT = 16;

export interface RolloutStoreOptions {
  readonly groupCommitDelayMs?: number;
  readonly openHandleLimit?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => unknown;
  readonly cancelScheduled?: (handle: unknown) => void;
  readonly onDidSync?: (threadId: ThreadId) => void;
  readonly syncFile?: (threadId: ThreadId, handle: FileHandle) => Promise<void>;
  readonly closeFile?: (threadId: ThreadId, handle: FileHandle) => Promise<void>;
  readonly onBackgroundError?: (message: string, error: unknown) => void;
}

interface OpenRolloutFile {
  readonly handle: FileHandle;
  byteOffset: number;
  unsynced: boolean;
  scheduledSync: unknown | null;
  lastUsed: number;
  busy: number;
}

export class RolloutStore {
  private readonly queues = new Map<ThreadId, Promise<unknown>>();
  private readonly nextOrdinals = new Map<ThreadId, number>();
  private readonly openFiles = new Map<ThreadId, OpenRolloutFile>();
  private readonly groupCommitDelayMs: number;
  private readonly openHandleLimit: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private readonly onDidSync: (threadId: ThreadId) => void;
  private readonly syncFile: (threadId: ThreadId, handle: FileHandle) => Promise<void>;
  private readonly closeFile: (threadId: ThreadId, handle: FileHandle) => Promise<void>;
  private readonly onBackgroundError: (message: string, error: unknown) => void;
  private useOrder = 0;

  constructor(private readonly rootPath: string, options: RolloutStoreOptions = {}) {
    this.groupCommitDelayMs = options.groupCommitDelayMs ?? ROLLOUT_GROUP_COMMIT_DELAY_MS;
    this.openHandleLimit = options.openHandleLimit ?? ROLLOUT_OPEN_HANDLE_LIMIT;
    if (!Number.isFinite(this.groupCommitDelayMs) || this.groupCommitDelayMs < 0) {
      throw new Error('Rollout group commit delay must be a non-negative finite number');
    }
    if (!Number.isSafeInteger(this.openHandleLimit) || this.openHandleLimit < 1) {
      throw new Error('Rollout open handle limit must be a positive safe integer');
    }
    this.schedule = options.schedule ?? scheduleTimer;
    this.cancelScheduled = options.cancelScheduled ?? cancelTimer;
    this.onDidSync = options.onDidSync ?? (() => undefined);
    this.syncFile = options.syncFile ?? ((_threadId, handle) => handle.sync());
    this.closeFile = options.closeFile ?? ((_threadId, handle) => handle.close());
    this.onBackgroundError = options.onBackgroundError ?? ((message, error) => console.error(message, error));
  }

  async append(
    threadId: ThreadId,
    notificationInput: AgentCoreRecordedNotification,
    recordedAt = Date.now(),
  ): Promise<RolloutEntry> {
    return this.appendEvent(threadId, notificationInput, recordedAt);
  }

  async appendHistoryRollback(
    context: ThreadHistoryRollbackContext,
    recordedAt = Date.now(),
  ): Promise<RolloutEntry> {
    return this.appendEvent(context.threadId, { type: 'history/rollback', ...context }, recordedAt);
  }

  async appendHistoryRetry(
    context: ThreadHistoryRollbackContext,
    replacementInput: Extract<AgentCoreRecordedNotification, { readonly type: 'turn/started' }>,
    recordedAt = Date.now(),
  ): Promise<RolloutEntry> {
    const replacement = decodeAgentCoreRecordedNotification(replacementInput);
    if (replacement.type !== 'turn/started') throw new Error('History retry replacement must start a Turn');
    return this.appendEvent(context.threadId, {
      type: 'history/retry',
      ...context,
      replacement,
    }, recordedAt);
  }

  private async appendEvent(
    threadId: ThreadId,
    eventInput: RolloutEvent,
    recordedAt: number,
  ): Promise<RolloutEntry> {
    assertThreadId(threadId);
    const event = decodeRolloutEvent(eventInput, 'strict');
    if (event.threadId !== threadId) throw new Error('Rollout event Thread does not match its file owner');
    return this.serialized(threadId, async () => {
      await mkdir(this.rootPath, { recursive: true });
      const file = await this.acquireOpenFile(threadId);
      try {
        const ordinal = this.nextOrdinals.get(threadId)!;
        const envelope: RolloutEnvelope = { ordinal, recordedAt, event };
        const encoded = `${JSON.stringify(envelope)}\n`;
        const byteLength = Buffer.byteLength(encoded);
        const byteOffset = file.byteOffset;
        const result = await file.handle.write(encoded, null, 'utf8');
        if (result.bytesWritten !== byteLength) {
          throw new Error(`Incomplete rollout append: wrote ${result.bytesWritten} of ${byteLength} bytes`);
        }
        file.byteOffset += byteLength;
        file.unsynced = true;
        file.lastUsed = ++this.useOrder;
        this.nextOrdinals.set(threadId, ordinal + 1);
        if (isSyncBarrier(event)) await this.syncOpenFile(threadId, file);
        else this.scheduleSync(threadId, file);
        return {
          ordinal,
          recordedAt,
          event,
          byteOffset,
          byteLength,
        };
      } catch (error) {
        this.nextOrdinals.delete(threadId);
        await this.discardOpenFile(threadId, file).catch(() => undefined);
        throw error;
      } finally {
        file.busy -= 1;
        try {
          await this.trimOpenFiles();
        } catch (error) {
          this.reportBackgroundError('[agent] rollout LRU eviction failed', error);
        }
      }
    });
  }

  async restoreMissing(
    threadId: ThreadId,
    records: readonly RolloutSnapshotEvent[],
  ): Promise<readonly RolloutEntry[]> {
    assertThreadId(threadId);
    const encoded = encodeSnapshot(threadId, records);
    return this.serialized(threadId, async () => {
      await mkdir(this.rootPath, { recursive: true });
      const openFile = this.openFiles.get(threadId);
      if (openFile) await this.closeOpenFile(threadId, openFile, false);
      const path = this.pathFor(threadId);
      if ((await readEntries(path, true)).length > 0) {
        throw new Error(`Cannot restore a non-empty rollout for ${threadId}`);
      }
      const temporaryPath = `${path}.repair`;
      let handle: FileHandle | null = null;
      try {
        handle = await open(temporaryPath, 'w');
        const result = await handle.write(encoded.text, null, 'utf8');
        if (result.bytesWritten !== Buffer.byteLength(encoded.text)) {
          throw new Error(`Incomplete rollout restore: wrote ${result.bytesWritten} bytes`);
        }
        await this.syncFile(threadId, handle);
        this.observeSync(threadId);
        await this.closeFile(threadId, handle);
        handle = null;
        await rename(temporaryPath, path);
      } catch (error) {
        if (handle) await this.closeFile(threadId, handle).catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
      this.nextOrdinals.set(threadId, encoded.entries.length);
      return encoded.entries;
    });
  }

  async read(threadId: ThreadId): Promise<readonly RolloutEntry[]> {
    assertThreadId(threadId);
    await this.waitForThread(threadId);
    return readEntries(this.pathFor(threadId), true);
  }

  async readAfter(threadId: ThreadId, ordinal: number): Promise<readonly RolloutEntry[]> {
    if (!Number.isSafeInteger(ordinal) || ordinal < -1) throw new Error('Rollout ordinal must be at least -1');
    return (await this.read(threadId)).filter((entry) => entry.ordinal > ordinal);
  }

  /**
   * Read without the torn-tail repair `read` performs. For out-of-process
   * readers (the `agent:dump` operator CLI) that must never write to a log the
   * running app owns: a partial trailing line is dropped from the result
   * instead of being truncated on disk.
   */
  async readSnapshot(threadId: ThreadId): Promise<readonly RolloutEntry[]> {
    assertThreadId(threadId);
    await this.waitForThread(threadId);
    return readEntries(this.pathFor(threadId), false);
  }

  async delete(threadId: ThreadId): Promise<void> {
    assertThreadId(threadId);
    await this.serialized(threadId, async () => {
      const file = this.openFiles.get(threadId);
      if (file) {
        file.busy += 1;
        try {
          await this.closeOpenFile(threadId, file, false);
        } catch (error) {
          this.reportBackgroundError(`[agent] failed to close deleted rollout for ${threadId}`, error);
        } finally {
          file.busy -= 1;
        }
      }
      try {
        await rm(this.pathFor(threadId), { force: true });
      } finally {
        this.nextOrdinals.delete(threadId);
      }
    });
  }

  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.catch(() => undefined)));
    const results = await Promise.allSettled([...this.openFiles.keys()].map((threadId) => (
      this.serialized(threadId, async () => {
        const file = this.openFiles.get(threadId);
        if (!file) return;
        file.busy += 1;
        try {
          await this.closeOpenFile(threadId, file, true);
        } finally {
          file.busy -= 1;
        }
      })
    )));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'RolloutStore failed to flush');
  }

  pathFor(threadId: ThreadId): string {
    assertThreadId(threadId);
    return join(this.rootPath, `${threadId}.jsonl`);
  }

  private async serialized<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.queues.set(threadId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(threadId) === current) this.queues.delete(threadId);
    }
  }

  private async waitForThread(threadId: ThreadId): Promise<void> {
    await this.queues.get(threadId)?.catch(() => undefined);
  }

  private async acquireOpenFile(threadId: ThreadId): Promise<OpenRolloutFile> {
    const existing = this.openFiles.get(threadId);
    if (existing) {
      existing.busy += 1;
      existing.lastUsed = ++this.useOrder;
      return existing;
    }
    const path = this.pathFor(threadId);
    let ordinal = this.nextOrdinals.get(threadId);
    let byteOffset: number;
    if (ordinal === undefined) {
      const entries = await readEntries(path, true);
      ordinal = entries.length === 0 ? 0 : entries.at(-1)!.ordinal + 1;
      byteOffset = entries.length === 0 ? 0 : entries.at(-1)!.byteOffset + entries.at(-1)!.byteLength;
      this.nextOrdinals.set(threadId, ordinal);
    } else {
      byteOffset = await fileSize(path);
    }
    const file: OpenRolloutFile = {
      handle: await open(path, 'a'),
      byteOffset,
      unsynced: false,
      scheduledSync: null,
      lastUsed: ++this.useOrder,
      busy: 1,
    };
    this.openFiles.set(threadId, file);
    return file;
  }

  private scheduleSync(threadId: ThreadId, file: OpenRolloutFile): void {
    if (file.scheduledSync !== null) return;
    file.scheduledSync = this.schedule(() => {
      file.scheduledSync = null;
      if (this.openFiles.get(threadId) !== file) return;
      void this.serialized(threadId, async () => {
        if (this.openFiles.get(threadId) !== file) return;
        file.busy += 1;
        try {
          await this.syncOpenFile(threadId, file);
        } finally {
          file.busy -= 1;
          await this.trimOpenFiles();
        }
      }).catch((error) => {
        this.reportBackgroundError('[agent] rollout group commit failed', error);
      });
    }, this.groupCommitDelayMs);
  }

  private async syncOpenFile(threadId: ThreadId, file: OpenRolloutFile): Promise<void> {
    this.cancelScheduledSync(file);
    if (!file.unsynced) return;
    await this.syncFile(threadId, file.handle);
    file.unsynced = false;
    this.observeSync(threadId);
  }

  private observeSync(threadId: ThreadId): void {
    try {
      this.onDidSync(threadId);
    } catch (error) {
      this.reportBackgroundError('[agent] rollout sync observer failed', error);
    }
  }

  private async closeOpenFile(threadId: ThreadId, file: OpenRolloutFile, forceSync: boolean): Promise<void> {
    if (this.openFiles.get(threadId) === file) this.openFiles.delete(threadId);
    this.cancelScheduledSync(file);
    const failures: unknown[] = [];
    if (forceSync) {
      try {
        await this.syncOpenFile(threadId, file);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.closeFile(threadId, file.handle);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to close rollout for ${threadId}`);
  }

  private async discardOpenFile(threadId: ThreadId, file: OpenRolloutFile): Promise<void> {
    await this.closeOpenFile(threadId, file, false);
  }

  private cancelScheduledSync(file: OpenRolloutFile): void {
    if (file.scheduledSync === null) return;
    this.cancelScheduled(file.scheduledSync);
    file.scheduledSync = null;
  }

  private async trimOpenFiles(): Promise<void> {
    while (this.openFiles.size > this.openHandleLimit) {
      const candidate = [...this.openFiles.entries()]
        .filter(([, file]) => file.busy === 0)
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
      if (!candidate) return;
      await this.closeOpenFile(candidate[0], candidate[1], true);
    }
  }

  private reportBackgroundError(message: string, error: unknown): void {
    try {
      this.onBackgroundError(message, error);
    } catch (observerError) {
      console.error('[agent] rollout error observer failed', observerError);
    }
  }
}

function encodeSnapshot(
  threadId: ThreadId,
  records: readonly RolloutSnapshotEvent[],
): { readonly text: string; readonly entries: readonly RolloutEntry[] } {
  const entries: RolloutEntry[] = [];
  const lines: string[] = [];
  let byteOffset = 0;
  for (const [ordinal, record] of records.entries()) {
    if (!Number.isFinite(record.recordedAt)) throw new Error('Invalid rollout snapshot timestamp');
    const event = decodeAgentCoreRecordedNotification(record.event);
    if (event.threadId !== threadId) throw new Error('Rollout snapshot event Thread does not match its file owner');
    const line = `${JSON.stringify({ ordinal, recordedAt: record.recordedAt, event })}\n`;
    const byteLength = Buffer.byteLength(line);
    lines.push(line);
    entries.push({ ordinal, recordedAt: record.recordedAt, event, byteOffset, byteLength });
    byteOffset += byteLength;
  }
  return { text: lines.join(''), entries };
}

async function readEntries(path: string, repairTail: boolean): Promise<RolloutEntry[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  let durableLength = bytes.length;
  if (bytes.length > 0 && bytes.at(-1) !== 0x0a) {
    const lastNewline = bytes.lastIndexOf(0x0a);
    durableLength = lastNewline < 0 ? 0 : lastNewline + 1;
    if (repairTail) await truncate(path, durableLength);
    bytes = bytes.subarray(0, durableLength);
  }

  const entries: RolloutEntry[] = [];
  let byteOffset = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line) continue;
    const byteLength = Buffer.byteLength(line) + 1;
    const entry = decodeEnvelope(line, byteOffset, byteLength);
    if (entry.ordinal !== entries.length) {
      throw new Error(`Rollout ordinal gap at ${entry.ordinal}; expected ${entries.length}`);
    }
    entries.push(entry);
    byteOffset += byteLength;
  }
  return entries;
}

function decodeEnvelope(encoded: string, byteOffset: number, byteLength: number): RolloutEntry {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error(`Invalid rollout JSON at byte ${byteOffset}`);
  }
  if (!isRecord(value)) throw new Error(`Invalid rollout record at byte ${byteOffset}`);
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'event,ordinal,recordedAt') {
    throw new Error(`Invalid rollout record fields at byte ${byteOffset}`);
  }
  if (!Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0) {
    throw new Error(`Invalid rollout ordinal at byte ${byteOffset}`);
  }
  if (typeof value.recordedAt !== 'number' || !Number.isFinite(value.recordedAt)) {
    throw new Error(`Invalid rollout timestamp at byte ${byteOffset}`);
  }
  return {
    ordinal: value.ordinal as number,
    recordedAt: value.recordedAt,
    event: decodeRolloutEvent(value.event, 'persisted'),
    byteOffset,
    byteLength,
  };
}

function decodeRolloutEvent(value: unknown, mode: RolloutDecodeMode): RolloutEvent {
  const decodeNotification = mode === 'persisted'
    ? decodePersistedAgentCoreRecordedNotification
    : decodeAgentCoreRecordedNotification;
  if (!isRecord(value)) return decodeNotification(value);
  if (value.type === 'history/retry') return decodeHistoryRetryMarker(value, mode);
  if (value.type !== 'history/rollback') return decodeNotification(value);
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'afterProjectionVersion,beforeProjectionVersion,omittedTurnIds,rollbackId,threadId,type') {
    throw new Error('Invalid history rollback marker fields');
  }
  if (!Array.isArray(value.omittedTurnIds)) throw new Error('Invalid history rollback omitted Turn IDs');
  assertThreadId(String(value.threadId));
  for (const turnId of value.omittedTurnIds) assertThreadId(String(turnId));
  const context = createThreadHistoryRollbackContext(
    String(value.rollbackId),
    value.threadId as ThreadId,
    value.omittedTurnIds as string[],
    Number(value.beforeProjectionVersion),
    Number(value.afterProjectionVersion),
  );
  return Object.freeze({ type: 'history/rollback', ...context });
}

function decodeHistoryRetryMarker(
  value: Record<string, unknown>,
  mode: RolloutDecodeMode,
): ThreadHistoryRetryMarker {
  const keys = Object.keys(value).sort();
  if (
    keys.join(',')
    !== 'afterProjectionVersion,beforeProjectionVersion,omittedTurnIds,replacement,rollbackId,threadId,type'
  ) {
    throw new Error('Invalid history retry marker fields');
  }
  if (!Array.isArray(value.omittedTurnIds) || value.omittedTurnIds.length !== 1) {
    throw new Error('History retry must replace exactly one Turn');
  }
  assertThreadId(String(value.threadId));
  for (const turnId of value.omittedTurnIds) assertThreadId(String(turnId));
  const context = createThreadHistoryRollbackContext(
    String(value.rollbackId),
    value.threadId as ThreadId,
    value.omittedTurnIds as string[],
    Number(value.beforeProjectionVersion),
    Number(value.afterProjectionVersion),
  );
  const replacement = mode === 'persisted'
    ? decodePersistedAgentCoreRecordedNotification(value.replacement)
    : decodeAgentCoreRecordedNotification(value.replacement);
  if (replacement.type !== 'turn/started') throw new Error('History retry replacement must start a Turn');
  if (replacement.threadId !== context.threadId) {
    throw new Error('History retry replacement Thread does not match its rollback');
  }
  if (context.omittedTurnIds.includes(replacement.turnId)) {
    throw new Error('History retry replacement must use a new Turn id');
  }
  return Object.freeze({ type: 'history/retry', ...context, replacement });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

function assertThreadId(threadId: string): void {
  if (!UUID_V7_PATTERN.test(threadId)) throw new Error(`Invalid rollout Thread id: ${threadId}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isSyncBarrier(event: RolloutEvent): boolean {
  return event.type !== 'item/delta';
}

function scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

function cancelTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
