import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type {
  CorePersistenceCapture,
  WorkspacePersistenceEnvelopeV3,
  WorkspacePersistenceLocalDelta,
  WorkspacePersistenceReplayEntry,
} from '../core/core';
import { Core } from '../core/core';
import { LoroOutlinerDocument, versionVectorIncludes } from '../core/loroDocument';
import { isOperationHistoryEntry } from '../core/operationJournal';

const SNAPSHOT_FILE = 'workspace.loro.json';
const UPDATE_LOG_FILE = 'workspace.loro.updates.jsonl';
const LOG_KIND = 'tenon-workspace-update-log';
const LOG_SCHEMA_VERSION = 1;
const MAX_HEADER_BYTES = 64 * 1024;

export interface WorkspacePersistenceLoad {
  snapshot: WorkspacePersistenceEnvelopeV3 | null;
  snapshotRaw: string | null;
  snapshotDigest: string | null;
  replay: WorkspacePersistenceReplayEntry[];
  replayBytes: number;
}

export interface WorkspacePersistenceStoreOptions {
  snapshotFileName?: string;
  updateLogFileName?: string;
  fsync?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
  afterSnapshotRename?: () => void | Promise<void>;
}

interface UpdateLogHeader {
  kind: typeof LOG_KIND;
  schemaVersion: typeof LOG_SCHEMA_VERSION;
  snapshotDigest: string;
}

interface UpdateLogRecord {
  kind: 'update';
  persistenceRevision: number;
  metadataSequence: number;
  update: string;
  version: string;
  local: WorkspacePersistenceLocalDelta;
}

export class WorkspacePersistenceStore {
  readonly snapshotPath: string;
  readonly updateLogPath: string;
  private readonly fsyncHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
  private readonly afterSnapshotRename?: () => void | Promise<void>;
  private snapshotDigestValue: string | null | undefined;
  private snapshotPersistenceRevisionValue: number | undefined;
  private snapshotMetadataSequenceValue: number | undefined;
  private snapshotIdentityValue: { installationId: string; replicaId: string } | undefined;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly root: string,
    options: WorkspacePersistenceStoreOptions = {},
  ) {
    this.snapshotPath = path.join(root, options.snapshotFileName ?? SNAPSHOT_FILE);
    this.updateLogPath = path.join(root, options.updateLogFileName ?? UPDATE_LOG_FILE);
    this.fsyncHandle = options.fsync ?? (async (handle) => handle.sync());
    this.afterSnapshotRename = options.afterSnapshotRename;
  }

  async load(): Promise<WorkspacePersistenceLoad> {
    return this.enqueueWrite(() => this.readLoad());
  }

  private async readLoad(): Promise<WorkspacePersistenceLoad> {
    let snapshotRaw: string;
    try {
      snapshotRaw = await readFile(this.snapshotPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) {
        try {
          await readFile(this.updateLogPath, 'utf8');
        } catch (logError) {
          if (isNotFound(logError)) {
            return { snapshot: null, snapshotRaw: null, snapshotDigest: null, replay: [], replayBytes: 0 };
          }
          throw logError;
        }
        throw new Error('Workspace update log exists without a snapshot');
      }
      throw error;
    }
    const snapshot = Core.deserializeState(snapshotRaw);
    const snapshotDigest = digest(snapshotRaw);
    const replay = await this.readLog(snapshotDigest, snapshot);
    this.snapshotDigestValue = snapshotDigest;
    this.snapshotPersistenceRevisionValue = snapshot.persistenceRevision ?? 0;
    this.snapshotMetadataSequenceValue = snapshot.persistenceMetadataSequence ?? 0;
    this.snapshotIdentityValue = {
      installationId: snapshot.local.installationId,
      replicaId: snapshot.local.replicaId,
    };
    return {
      snapshot,
      snapshotRaw,
      snapshotDigest,
      replay: replay.entries,
      replayBytes: replay.bytes,
    };
  }

  async append(capture: CorePersistenceCapture): Promise<number> {
    return this.enqueueWrite(async () => {
      const snapshotDigest = await this.snapshotDigest();
      if (!snapshotDigest) throw new Error('Cannot append workspace update without a snapshot');
      const record: UpdateLogRecord = {
        kind: 'update',
        persistenceRevision: capture.persistenceRevision,
        metadataSequence: capture.metadataSequence,
        update: encode(capture.update),
        version: encode(capture.version),
        local: cloneLocalDelta(capture.local),
      };
      await mkdir(this.root, { recursive: true });
      let needsHeader = false;
      try {
        const firstLine = await readFirstLine(this.updateLogPath);
        if (firstLine === null) needsHeader = true;
        else {
          const header = parseHeader(firstLine, this.updateLogPath);
          if (header.snapshotDigest !== snapshotDigest) {
            // A stale log can only be left by a crash between snapshot replacement
            // and log reset. Prove that the new snapshot has absorbed every
            // complete record before discarding the old log.
            const snapshot = await this.readSnapshotForDigest(snapshotDigest);
            await this.readLog(snapshotDigest, snapshot);
            await this.replaceLogHeader(snapshotDigest);
          }
        }
      } catch (error) {
        if (isNotFound(error)) needsHeader = true;
        else throw error;
      }
      if (needsHeader) await this.ensureLogHeader(snapshotDigest);
      await repairTrailingLogLine(this.updateLogPath, this.fsyncHandle, (tail) => {
        parseCompleteLogTail(tail, this.updateLogPath);
      });
      const lastRecord = await readLastUpdateRecord(this.updateLogPath);
      const snapshotPersistenceRevision = await this.snapshotPersistenceRevision();
      const snapshotMetadataSequence = await this.snapshotMetadataSequence();
      const snapshotIdentity = await this.snapshotIdentity();
      if (record.persistenceRevision <= snapshotPersistenceRevision
        || record.metadataSequence < snapshotMetadataSequence) {
        throw new Error(
          `Workspace update log record (${record.persistenceRevision}, ${record.metadataSequence}) does not extend snapshot baseline (${snapshotPersistenceRevision}, ${snapshotMetadataSequence})`,
        );
      }
      if (record.local.installationId !== snapshotIdentity.installationId
        || record.local.replicaId !== snapshotIdentity.replicaId) {
        throw new Error(`Workspace update log replica identity mismatch at ${this.updateLogPath}`);
      }
      if (lastRecord) {
        if (
          lastRecord.local.installationId !== record.local.installationId
          || lastRecord.local.replicaId !== record.local.replicaId
        ) throw new Error(`Workspace update log replica identity mismatch at ${this.updateLogPath}`);
        if (lastRecord.persistenceRevision > record.persistenceRevision
          || lastRecord.metadataSequence > record.metadataSequence) {
          throw new Error(`Non-monotonic workspace update log append at ${this.updateLogPath}`);
        }
        if (lastRecord.persistenceRevision === record.persistenceRevision) {
          if (!sameUpdateLogRecord(lastRecord, record)) {
            throw new Error(`Conflicting workspace update log retry at ${this.updateLogPath}`);
          }
          // The prior call may have failed after writing the complete record.
          // Re-sync it before acknowledging the idempotent retry as durable.
          return syncDurableSize(this.updateLogPath, this.fsyncHandle);
        }
      }
      return appendDurable(this.updateLogPath, `${JSON.stringify(record)}\n`, this.fsyncHandle);
    });
  }

  async compact(snapshotRaw: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const snapshotDigest = digest(snapshotRaw);
      const snapshot = Core.deserializeState(snapshotRaw);
      try {
        await atomicWriteDurable(
          this.snapshotPath,
          snapshotRaw,
          this.fsyncHandle,
          this.afterSnapshotRename,
        );
        this.snapshotDigestValue = snapshotDigest;
        this.snapshotPersistenceRevisionValue = snapshot.persistenceRevision ?? 0;
        this.snapshotMetadataSequenceValue = snapshot.persistenceMetadataSequence ?? 0;
        this.snapshotIdentityValue = {
          installationId: snapshot.local.installationId,
          replicaId: snapshot.local.replicaId,
        };
        // The snapshot is authoritative before this reset. If interrupted here,
        // load() sees the old header digest and ignores the absorbed log.
        await replaceFileDurable(
          this.updateLogPath,
          `${JSON.stringify(logHeader(snapshotDigest))}\n`,
          this.fsyncHandle,
        );
      } catch (error) {
        // A failed directory sync or log reset may still have completed a rename.
        // Re-read the authoritative snapshot before any later append instead of
        // continuing with a cached digest for a file that may no longer exist.
        this.snapshotDigestValue = undefined;
        this.snapshotPersistenceRevisionValue = undefined;
        this.snapshotMetadataSequenceValue = undefined;
        this.snapshotIdentityValue = undefined;
        throw error;
      }
    });
  }

  private async snapshotDigest(): Promise<string | null> {
    if (this.snapshotDigestValue !== undefined) return this.snapshotDigestValue;
    try {
      const raw = await readFile(this.snapshotPath, 'utf8');
      this.snapshotDigestValue = digest(raw);
      return this.snapshotDigestValue;
    } catch (error) {
      if (isNotFound(error)) {
        this.snapshotDigestValue = null;
        return null;
      }
      throw error;
    }
  }

  private async snapshotPersistenceRevision(): Promise<number> {
    if (this.snapshotPersistenceRevisionValue !== undefined) return this.snapshotPersistenceRevisionValue;
    try {
      const raw = await readFile(this.snapshotPath, 'utf8');
      const snapshot = Core.deserializeState(raw);
      this.snapshotDigestValue ??= digest(raw);
      this.snapshotPersistenceRevisionValue = snapshot.persistenceRevision ?? 0;
      this.snapshotMetadataSequenceValue = snapshot.persistenceMetadataSequence ?? 0;
      this.snapshotIdentityValue = {
        installationId: snapshot.local.installationId,
        replicaId: snapshot.local.replicaId,
      };
      return this.snapshotPersistenceRevisionValue;
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
  }

  private async snapshotMetadataSequence(): Promise<number> {
    if (this.snapshotMetadataSequenceValue !== undefined) return this.snapshotMetadataSequenceValue;
    await this.snapshotPersistenceRevision();
    return this.snapshotMetadataSequenceValue ?? 0;
  }

  private async snapshotIdentity(): Promise<{ installationId: string; replicaId: string }> {
    if (this.snapshotIdentityValue) return this.snapshotIdentityValue;
    await this.snapshotPersistenceRevision();
    if (!this.snapshotIdentityValue) throw new Error('Workspace snapshot identity is unavailable');
    return this.snapshotIdentityValue;
  }

  private async readSnapshotForDigest(expectedDigest: string): Promise<WorkspacePersistenceEnvelopeV3> {
    const raw = await readFile(this.snapshotPath, 'utf8');
    if (digest(raw) !== expectedDigest) {
      throw new Error(`Workspace snapshot changed while validating update log at ${this.snapshotPath}`);
    }
    return Core.deserializeState(raw);
  }

  private enqueueWrite<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async readLog(
    snapshotDigest: string,
    snapshot: WorkspacePersistenceEnvelopeV3,
  ): Promise<{ entries: WorkspacePersistenceReplayEntry[]; bytes: number }> {
    let raw: string;
    try {
      raw = await readFile(this.updateLogPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return { entries: [], bytes: 0 };
      throw error;
    }
    if (raw.length === 0) throw new Error(`Invalid workspace update log at ${this.updateLogPath}`);
    if (!raw.trim()) throw new Error(`Invalid workspace update log at ${this.updateLogPath}`);
    const lines = raw.split('\n');
    const hasTerminatingNewline = raw.endsWith('\n');
    if (hasTerminatingNewline) lines.pop();
    const header = parseHeader(lines.shift() ?? '', this.updateLogPath);
    if (header.snapshotDigest !== snapshotDigest) {
      assertStaleLogAbsorbed(lines, hasTerminatingNewline, snapshot, this.updateLogPath);
      return { entries: [], bytes: 0 };
    }
    const replay: WorkspacePersistenceReplayEntry[] = [];
    const snapshotRevision = snapshot.persistenceRevision ?? 0;
    const snapshotMetadataSequence = snapshot.persistenceMetadataSequence ?? 0;
    let previousRevision = snapshotRevision;
    let previousMetadataSequence = snapshotMetadataSequence;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        const record = parseRecord(line, this.updateLogPath);
        if (record.persistenceRevision <= previousRevision || record.metadataSequence < previousMetadataSequence) {
          throw new Error(`Non-monotonic workspace update log record at ${this.updateLogPath}`);
        }
        if (record.persistenceRevision <= snapshotRevision || record.metadataSequence < snapshotMetadataSequence) {
          throw new Error(
            `Workspace update log record (${record.persistenceRevision}, ${record.metadataSequence}) does not extend snapshot baseline (${snapshotRevision}, ${snapshotMetadataSequence})`,
          );
        }
        if (
          record.local.installationId !== snapshot.local.installationId
          || record.local.replicaId !== snapshot.local.replicaId
        ) {
          throw new Error(`Workspace update log replica identity mismatch at ${this.updateLogPath}`);
        }
        previousRevision = record.persistenceRevision;
        previousMetadataSequence = record.metadataSequence;
        replay.push({
          persistenceRevision: record.persistenceRevision,
          metadataSequence: record.metadataSequence,
          version: decode(record.version),
          update: decode(record.update),
          local: cloneLocalDelta(record.local),
        });
      } catch (error) {
        const isLast = index === lines.length - 1;
        if (isLast && !hasTerminatingNewline && error instanceof JsonSyntaxError) break;
        throw error;
      }
    }
    return { entries: replay, bytes: Buffer.byteLength(raw) };
  }

  private async ensureLogHeader(snapshotDigest: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.updateLogPath, 'r');
      const stat = await handle.stat();
      if (stat.size > 0) {
        throw new Error(`Invalid workspace update log: missing header at ${this.updateLogPath}`);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    } finally {
      await handle?.close();
    }
    await replaceFileDurable(
      this.updateLogPath,
      `${JSON.stringify(logHeader(snapshotDigest))}\n`,
      this.fsyncHandle,
    );
  }

  private async replaceLogHeader(snapshotDigest: string): Promise<void> {
    await replaceFileDurable(
      this.updateLogPath,
      `${JSON.stringify(logHeader(snapshotDigest))}\n`,
      this.fsyncHandle,
    );
  }
}

function assertStaleLogAbsorbed(
  lines: readonly string[],
  hasTerminatingNewline: boolean,
  snapshot: WorkspacePersistenceEnvelopeV3,
  source: string,
): void {
  const snapshotRevision = snapshot.persistenceRevision ?? 0;
  const snapshotMetadataSequence = snapshot.persistenceMetadataSequence ?? 0;
  const snapshotDocument = new LoroOutlinerDocument({ shared: snapshot.shared.document });
  const snapshotVersion = snapshotDocument.versionVector();
  let previousRevision = -1;
  let previousMetadataSequence = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    try {
      const record = parseRecord(line, source);
      if (record.persistenceRevision <= previousRevision
        || record.metadataSequence < previousMetadataSequence) {
        throw new Error(`Non-monotonic workspace update log record at ${source}`);
      }
      if (record.local.installationId !== snapshot.local.installationId
        || record.local.replicaId !== snapshot.local.replicaId) {
        throw new Error(`Workspace update log replica identity mismatch at ${source}`);
      }
      if (record.persistenceRevision > snapshotRevision
        || record.metadataSequence > snapshotMetadataSequence) {
        throw new Error(`Workspace update log is not absorbed by snapshot at ${source}`);
      }
      if (!versionVectorIncludes(snapshotVersion, decode(record.version))) {
        throw new Error(`Workspace update log version is not absorbed by snapshot at ${source}`);
      }
      previousRevision = record.persistenceRevision;
      previousMetadataSequence = record.metadataSequence;
    } catch (error) {
      const isLast = index === lines.length - 1;
      if (isLast && !hasTerminatingNewline && error instanceof JsonSyntaxError) return;
      throw error;
    }
  }
}

function logHeader(snapshotDigest: string): UpdateLogHeader {
  return { kind: LOG_KIND, schemaVersion: LOG_SCHEMA_VERSION, snapshotDigest };
}

function parseHeader(raw: string, source: string): UpdateLogHeader {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid workspace update log header at ${source}: ${message(error)}`);
  }
  if (
    !value || typeof value !== 'object'
    || (value as UpdateLogHeader).kind !== LOG_KIND
    || (value as UpdateLogHeader).schemaVersion !== LOG_SCHEMA_VERSION
    || !/^[a-f0-9]{64}$/u.test((value as UpdateLogHeader).snapshotDigest)
  ) throw new Error(`Invalid workspace update log header at ${source}`);
  return value as UpdateLogHeader;
}

function parseRecord(raw: string, source: string): UpdateLogRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new JsonSyntaxError(`Invalid workspace update log record at ${source}: ${message(error)}`);
  }
  const record = value as Partial<UpdateLogRecord>;
  if (
    !value || typeof value !== 'object'
    || record.kind !== 'update'
    || typeof record.persistenceRevision !== 'number'
    || !Number.isSafeInteger(record.persistenceRevision) || record.persistenceRevision < 0
    || typeof record.metadataSequence !== 'number'
    || !Number.isSafeInteger(record.metadataSequence) || record.metadataSequence < 0
    || typeof record.update !== 'string' || !isCanonicalBase64(record.update)
    || typeof record.version !== 'string' || !isCanonicalBase64(record.version)
    || !isLocalDelta(record.local)
  ) throw new Error(`Invalid workspace update log record at ${source}`);
  return record as UpdateLogRecord;
}

function parseCompleteLogTail(raw: string, source: string): void {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new JsonSyntaxError(`Invalid workspace update log tail at ${source}: ${message(error)}`);
  }
  if (value && typeof value === 'object' && (value as { kind?: unknown }).kind === LOG_KIND) {
    parseHeader(raw, source);
    return;
  }
  parseRecord(raw, source);
}

function isLocalDelta(value: unknown): value is WorkspacePersistenceLocalDelta {
  if (!value || typeof value !== 'object') return false;
  const delta = value as WorkspacePersistenceLocalDelta;
  return typeof delta.installationId === 'string'
    && typeof delta.replicaId === 'string'
    && Array.isArray(delta.operationHistoryUpserts)
    && delta.operationHistoryUpserts.every(isOperationHistoryEntry)
    && Array.isArray(delta.operationHistoryDeletes)
    && delta.operationHistoryDeletes.every((id) => typeof id === 'string')
    && (delta.loroPendingUpdates === undefined
      || (Array.isArray(delta.loroPendingUpdates)
        && delta.loroPendingUpdates.every((item) => typeof item === 'string' && isCanonicalBase64(item))));
}

function cloneLocalDelta(delta: WorkspacePersistenceLocalDelta): WorkspacePersistenceLocalDelta {
  return {
    installationId: delta.installationId,
    replicaId: delta.replicaId,
    operationHistoryUpserts: delta.operationHistoryUpserts.map((entry) => structuredClone(entry)),
    operationHistoryDeletes: [...delta.operationHistoryDeletes],
    ...(delta.loroPendingUpdates ? { loroPendingUpdates: [...delta.loroPendingUpdates] } : {}),
  };
}

function sameUpdateLogRecord(left: UpdateLogRecord, right: UpdateLogRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function decode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function isCanonicalBase64(value: string): boolean {
  return encode(decode(value)) === value;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function appendDurable(
  filePath: string,
  data: string,
  fsyncHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<number> {
  const handle = await open(filePath, 'a', 0o600);
  try {
    await writeAll(handle, Buffer.from(data), null);
    await fsyncHandle(handle);
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

async function syncDurableSize(
  filePath: string,
  fsyncHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<number> {
  const handle = await open(filePath, 'r+');
  try {
    await fsyncHandle(handle);
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

async function atomicWriteDurable(
  filePath: string,
  data: string,
  fsyncHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
  afterRename?: () => void | Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await writeAll(handle, Buffer.from(data), 0);
    await fsyncHandle(handle);
    await handle.close();
    handle = undefined;
    await rename(tempPath, filePath);
    renamed = true;
    await afterRename?.();
    await syncDirectory(path.dirname(filePath), fsyncHandle);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!renamed) await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function replaceFileDurable(
  filePath: string,
  data: string,
  fsyncHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<void> {
  await atomicWriteDurable(filePath, data, fsyncHandle);
}

async function syncDirectory(
  directory: string,
  fsyncHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await fsyncHandle(handle);
  } finally {
    await handle.close();
  }
}

async function repairTrailingLogLine(
  filePath: string,
  fsyncHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
  validateCompleteTail: (tail: string) => void,
): Promise<void> {
  const handle = await open(filePath, 'r+').catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!handle) return;
  let size: number;
  try {
    size = (await handle.stat()).size;
    if (size === 0) return;
    const lastByte = Buffer.alloc(1);
    await readExactly(handle, lastByte, size - 1);
    if (lastByte[0] === 0x0a) return;

    const lastNewline = await findLastNewline(handle, size);
    const tailStart = lastNewline + 1;
    const tail = Buffer.alloc(size - tailStart);
    await readExactly(handle, tail, tailStart);
    const tailText = tail.toString('utf8');
    try {
      // A syntactically incomplete final record is the only recoverable case.
      JSON.parse(tailText);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await handle.truncate(tailStart);
      await fsyncHandle(handle);
      return;
    }

    // The JSON is complete, so validate the record. Schema/identity/ordering
    // failures are real corruption and must not be silently discarded.
    validateCompleteTail(tailText);
    await writeAll(handle, Buffer.from('\n'), size);
    await fsyncHandle(handle);
  } finally {
    await handle.close();
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function readFirstLine(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r').catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return null;
    const chunks: Buffer[] = [];
    const limit = Math.min(stat.size, MAX_HEADER_BYTES);
    let offset = 0;
    let foundNewline = false;
    while (offset < limit) {
      const chunk = Buffer.alloc(Math.min(4096, limit - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const newline = chunk.subarray(0, bytesRead).indexOf(0x0a);
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk.subarray(0, bytesRead));
      if (newline >= 0) {
        foundNewline = true;
        break;
      }
    }
    const line = Buffer.concat(chunks).toString('utf8');
    if (!foundNewline && stat.size > MAX_HEADER_BYTES) {
      throw new Error(`Workspace update log header exceeds ${MAX_HEADER_BYTES} bytes at ${filePath}`);
    }
    const trimmed = line.trim();
    return trimmed || null;
  } finally {
    await handle.close();
  }
}

async function readLastUpdateRecord(filePath: string): Promise<UpdateLogRecord | null> {
  const handle = await open(filePath, 'r');
  try {
    let end = (await handle.stat()).size;
    const byte = Buffer.alloc(1);
    while (end > 0) {
      await readExactly(handle, byte, end - 1);
      if (byte[0] !== 0x0a && byte[0] !== 0x0d) break;
      end -= 1;
    }
    if (end === 0) return null;
    const previousNewline = await findLastNewline(handle, end);
    const line = Buffer.alloc(end - previousNewline - 1);
    await readExactly(handle, line, previousNewline + 1);
    const raw = line.toString('utf8').trim();
    if (!raw) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid workspace update log tail at ${filePath}: ${message(error)}`);
    }
    if ((value as Partial<UpdateLogHeader> | null)?.kind === LOG_KIND) {
      parseHeader(raw, filePath);
      return null;
    }
    return parseRecord(raw, filePath);
  } finally {
    await handle.close();
  }
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, position + offset);
    if (bytesRead === 0) throw new Error('Unexpected end of workspace update log');
    offset += bytesRead;
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer, position: number | null): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const writePosition = position === null ? null : position + offset;
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.byteLength - offset,
      writePosition,
    );
    if (bytesWritten === 0) throw new Error('Workspace persistence write made no progress');
    offset += bytesWritten;
  }
}

async function findLastNewline(handle: FileHandle, size: number): Promise<number> {
  const chunkSize = 4096;
  let cursor = size;
  while (cursor > 0) {
    const start = Math.max(0, cursor - chunkSize);
    const chunk = Buffer.alloc(cursor - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, start);
    for (let index = bytesRead - 1; index >= 0; index -= 1) {
      if (chunk[index] === 0x0a) return start + index;
    }
    cursor = start;
  }
  return -1;
}

class JsonSyntaxError extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
