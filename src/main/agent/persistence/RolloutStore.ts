import { mkdir, open, readFile, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeAgentCoreNotification } from '../../../core/agent/codec';
import {
  createThreadHistoryRollbackContext,
  type ThreadHistoryRollbackContext,
} from '../../../core/agent/extensions';
import type { AgentCoreNotification, ThreadId } from '../../../core/agent/protocol';

export interface ThreadHistoryRollbackMarker extends ThreadHistoryRollbackContext {
  readonly type: 'history/rollback';
}

export type RolloutEvent = AgentCoreNotification | ThreadHistoryRollbackMarker;

export interface RolloutRecord {
  readonly ordinal: number;
  readonly recordedAt: number;
  readonly event: RolloutEvent;
}

export interface RolloutEntry extends RolloutRecord {
  readonly byteOffset: number;
  readonly byteLength: number;
}

interface RolloutEnvelope {
  readonly ordinal: number;
  readonly recordedAt: number;
  readonly event: unknown;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RolloutStore {
  private readonly queues = new Map<ThreadId, Promise<unknown>>();
  private readonly nextOrdinals = new Map<ThreadId, number>();

  constructor(private readonly rootPath: string) {}

  async append(
    threadId: ThreadId,
    notificationInput: AgentCoreNotification,
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

  private async appendEvent(
    threadId: ThreadId,
    eventInput: RolloutEvent,
    recordedAt: number,
  ): Promise<RolloutEntry> {
    assertThreadId(threadId);
    const event = decodeRolloutEvent(eventInput);
    if (event.threadId !== threadId) throw new Error('Rollout event Thread does not match its file owner');
    return this.serialized(threadId, async () => {
      await mkdir(this.rootPath, { recursive: true });
      const path = this.pathFor(threadId);
      let ordinal = this.nextOrdinals.get(threadId);
      if (ordinal === undefined) {
        const entries = await readEntries(path, true);
        ordinal = entries.length === 0 ? 0 : entries.at(-1)!.ordinal + 1;
      }
      const envelope: RolloutEnvelope = { ordinal, recordedAt, event };
      const encoded = `${JSON.stringify(envelope)}\n`;
      const byteOffset = await fileSize(path);
      const handle = await open(path, 'a');
      try {
        await handle.write(encoded, null, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.nextOrdinals.set(threadId, ordinal + 1);
      return {
        ordinal,
        recordedAt,
        event,
        byteOffset,
        byteLength: Buffer.byteLength(encoded),
      };
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

  async delete(threadId: ThreadId): Promise<void> {
    assertThreadId(threadId);
    await this.serialized(threadId, async () => {
      await rm(this.pathFor(threadId), { force: true });
      this.nextOrdinals.delete(threadId);
    });
  }

  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.catch(() => undefined)));
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
    event: decodeRolloutEvent(value.event),
    byteOffset,
    byteLength,
  };
}

function decodeRolloutEvent(value: unknown): RolloutEvent {
  if (!isRecord(value) || value.type !== 'history/rollback') {
    return decodeAgentCoreNotification(value);
  }
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
