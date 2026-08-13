import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
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

export interface WorkspacePersistenceLoad {
  snapshot: WorkspacePersistenceEnvelopeV3 | null;
  snapshotRaw: string | null;
  snapshotDigest: string | null;
  replay: WorkspacePersistenceReplayEntry[];
  replayBytes: number;
  recovery?: WorkspacePersistenceRecovery;
}

export interface WorkspacePersistenceRecovery {
  error: unknown;
  quarantinedLogPath?: string;
  recoveryError?: unknown;
}

export interface WorkspacePersistenceStoreOptions {
  snapshotFileName?: string;
  updateLogFileName?: string;
  fsync?: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>;
  afterSnapshotRename?: () => void | Promise<void>;
}

export class WorkspacePersistenceResnapshotRequiredError extends Error {}

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

interface UpdateLogCursor {
  snapshotDigest: string;
  lastRecord: UpdateLogRecordSummary | null;
  bytes: number;
  device?: number;
  inode?: number;
}

interface UpdateLogRecordSummary {
  persistenceRevision: number;
  metadataSequence: number;
  installationId: string;
  replicaId: string;
  digest: string;
}

interface ReadLogResult {
  entries: WorkspacePersistenceReplayEntry[];
  records: UpdateLogRecord[];
  bytes: number;
  exists: boolean;
  headerMatches: boolean;
  tornTail: boolean;
  lastRecord: UpdateLogRecordSummary | null;
  device?: number;
  inode?: number;
  corruption?: unknown;
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
  private logCursor: UpdateLogCursor | undefined;
  private appendHandle: FileHandle | undefined;
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
    let replay: ReadLogResult;
    let recovery: WorkspacePersistenceRecovery | undefined;
    try {
      replay = await this.readLog(snapshotDigest, snapshot);
    } catch (error) {
      recovery = await this.recoverUnreadableLog(snapshotDigest, [], error);
      replay = emptyReadLogResult(true);
    }
    this.snapshotDigestValue = snapshotDigest;
    this.snapshotPersistenceRevisionValue = snapshot.persistenceRevision;
    this.snapshotMetadataSequenceValue = snapshot.persistenceMetadataSequence;
    this.snapshotIdentityValue = {
      installationId: snapshot.local.installationId,
      replicaId: snapshot.local.replicaId,
    };
    if (!recovery && replay.corruption) {
      recovery = await this.recoverUnreadableLog(snapshotDigest, replay.records, replay.corruption);
      replay = recoveredReadLogResult(snapshotDigest, replay);
    } else if (!recovery && replay.exists && !replay.headerMatches) {
      try {
        await this.replaceLogHeader(snapshotDigest);
        replay = emptyReadLogResult(true);
      } catch (error) {
        recovery = { error };
      }
    } else if (!recovery && replay.tornTail) {
      try {
        await this.replaceLogRecords(snapshotDigest, replay.records);
        replay = recoveredReadLogResult(snapshotDigest, replay);
      } catch (error) {
        recovery = { error };
      }
    }
    if (!recovery && replay.exists && replay.headerMatches && !replay.tornTail) {
      this.logCursor ??= {
        snapshotDigest,
        lastRecord: replay.lastRecord,
        bytes: replay.bytes,
        device: replay.device,
        inode: replay.inode,
      };
    }
    return {
      snapshot,
      snapshotRaw,
      snapshotDigest,
      replay: replay.entries,
      replayBytes: replay.bytes,
      ...(recovery ? { recovery } : {}),
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
      const cursor = await this.prepareLogForAppend(snapshotDigest);
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
      const lastRecord = cursor.lastRecord;
      if (lastRecord) {
        if (
          lastRecord.installationId !== record.local.installationId
          || lastRecord.replicaId !== record.local.replicaId
        ) throw new Error(`Workspace update log replica identity mismatch at ${this.updateLogPath}`);
        if (lastRecord.persistenceRevision > record.persistenceRevision
          || lastRecord.metadataSequence > record.metadataSequence) {
          throw new Error(`Non-monotonic workspace update log append at ${this.updateLogPath}`);
        }
        if (lastRecord.persistenceRevision === record.persistenceRevision) {
          if (lastRecord.digest !== updateLogRecordDigest(record)) {
            throw new Error(`Conflicting workspace update log retry at ${this.updateLogPath}`);
          }
          // The prior call may have failed after writing the complete record.
          // Re-sync it before acknowledging the idempotent retry as durable.
          try {
            return await this.syncOpenLog(cursor);
          } catch (error) {
            await this.invalidateLogCursor();
            throw error;
          }
        }
      }
      try {
        const size = await this.appendOpenLog(`${JSON.stringify(record)}\n`, cursor);
        cursor.lastRecord = summarizeUpdateLogRecord(record);
        cursor.bytes = size;
        return size;
      } catch (error) {
        // The bytes may have reached the file before fsync reported failure.
        // Force the next retry through the one-time tail recovery/validation path.
        await this.invalidateLogCursor();
        throw error;
      }
    });
  }

  async compact(snapshotRaw: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const snapshotDigest = digest(snapshotRaw);
      const snapshot = Core.deserializeState(snapshotRaw);
      try {
        await this.closeAppendHandle();
        await atomicWriteDurable(
          this.snapshotPath,
          snapshotRaw,
          this.fsyncHandle,
          this.afterSnapshotRename,
        );
        this.snapshotDigestValue = snapshotDigest;
        this.snapshotPersistenceRevisionValue = snapshot.persistenceRevision;
        this.snapshotMetadataSequenceValue = snapshot.persistenceMetadataSequence;
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
        const logStat = await stat(this.updateLogPath);
        this.logCursor = {
          snapshotDigest,
          lastRecord: null,
          bytes: Buffer.byteLength(`${JSON.stringify(logHeader(snapshotDigest))}\n`),
          device: logStat.dev,
          inode: logStat.ino,
        };
      } catch (error) {
        // A failed directory sync or log reset may still have completed a rename.
        // Re-read the authoritative snapshot before any later append instead of
        // continuing with a cached digest for a file that may no longer exist.
        this.snapshotDigestValue = undefined;
        this.snapshotPersistenceRevisionValue = undefined;
        this.snapshotMetadataSequenceValue = undefined;
        this.snapshotIdentityValue = undefined;
        this.logCursor = undefined;
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
      this.snapshotPersistenceRevisionValue = snapshot.persistenceRevision;
      this.snapshotMetadataSequenceValue = snapshot.persistenceMetadataSequence;
      this.snapshotIdentityValue = {
        installationId: snapshot.local.installationId,
        replicaId: snapshot.local.replicaId,
      };
      return this.snapshotPersistenceRevisionValue;
    } catch (error) {
      throw error;
    }
  }

  private async snapshotMetadataSequence(): Promise<number> {
    if (this.snapshotMetadataSequenceValue !== undefined) return this.snapshotMetadataSequenceValue;
    await this.snapshotPersistenceRevision();
    if (this.snapshotMetadataSequenceValue === undefined) {
      throw new Error('Workspace snapshot metadata sequence is unavailable');
    }
    return this.snapshotMetadataSequenceValue;
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
  ): Promise<ReadLogResult> {
    const handle = await open(this.updateLogPath, 'r').catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!handle) return emptyReadLogResult(false);
    let raw: string;
    let logStat: Awaited<ReturnType<FileHandle['stat']>>;
    try {
      raw = await handle.readFile('utf8');
      logStat = await handle.stat();
    } finally {
      await handle.close();
    }
    if (logStat.size !== Buffer.byteLength(raw)) {
      throw new Error(`Workspace update log changed while being read at ${this.updateLogPath}`);
    }
    if (raw.length === 0) throw new Error(`Invalid workspace update log at ${this.updateLogPath}`);
    if (!raw.trim()) throw new Error(`Invalid workspace update log at ${this.updateLogPath}`);
    const lines = raw.split('\n');
    const hasTerminatingNewline = raw.endsWith('\n');
    if (hasTerminatingNewline) lines.pop();
    const header = parseHeader(lines.shift() ?? '', this.updateLogPath);
    if (header.snapshotDigest !== snapshotDigest) {
      assertStaleLogAbsorbed(lines, hasTerminatingNewline, snapshot, this.updateLogPath);
      return {
        ...emptyReadLogResult(true),
        bytes: Buffer.byteLength(raw),
        headerMatches: false,
      };
    }
    const replay: WorkspacePersistenceReplayEntry[] = [];
    const records: UpdateLogRecord[] = [];
    const replayDocument = new LoroOutlinerDocument({ shared: snapshot.shared.document });
    const snapshotRevision = snapshot.persistenceRevision;
    const snapshotMetadataSequence = snapshot.persistenceMetadataSequence;
    let previousRevision = snapshotRevision;
    let previousMetadataSequence = snapshotMetadataSequence;
    let lastRecord: UpdateLogRecordSummary | null = null;
    let tornTail = !hasTerminatingNewline;
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
        const update = decode(record.update);
        const version = decode(record.version);
        replayDocument.importUpdates([update]);
        if (!versionVectorsEqual(replayDocument.versionVector(), version)) {
          throw new Error(`Workspace update log replay version mismatch at ${this.updateLogPath}`);
        }
        previousRevision = record.persistenceRevision;
        previousMetadataSequence = record.metadataSequence;
        lastRecord = summarizeUpdateLogRecord(record);
        records.push(record);
        replay.push({
          persistenceRevision: record.persistenceRevision,
          metadataSequence: record.metadataSequence,
          version,
          update,
          local: cloneLocalDelta(record.local),
        });
      } catch (error) {
        const isLast = index === lines.length - 1;
        if (isLast && !hasTerminatingNewline && error instanceof JsonSyntaxError) {
          tornTail = true;
          break;
        }
        return {
          entries: replay,
          records,
          bytes: Buffer.byteLength(raw),
          exists: true,
          headerMatches: true,
          tornTail: false,
          lastRecord,
          device: logStat.dev,
          inode: logStat.ino,
          corruption: error,
        };
      }
    }
    return {
      entries: replay,
      records,
      bytes: Buffer.byteLength(raw),
      exists: true,
      headerMatches: true,
      tornTail,
      lastRecord,
      device: logStat.dev,
      inode: logStat.ino,
    };
  }

  private async prepareLogForAppend(snapshotDigest: string): Promise<UpdateLogCursor> {
    if (this.logCursor?.snapshotDigest === snapshotDigest) {
      let pathStat: Awaited<ReturnType<typeof stat>> | undefined;
      try {
        pathStat = await stat(this.updateLogPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      if (pathStat
        && pathStat.size === this.logCursor.bytes
        && this.logCursor.device === pathStat.dev
        && this.logCursor.inode === pathStat.ino) return this.logCursor;
      await this.invalidateLogCursor();
      throw new WorkspacePersistenceResnapshotRequiredError(
        `Workspace update log changed outside the persistence store at ${this.updateLogPath}`,
      );
    }

    const snapshot = await this.readSnapshotForDigest(snapshotDigest);
    let read: ReadLogResult;
    try {
      read = await this.readLog(snapshotDigest, snapshot);
    } catch (error) {
      const recovery = await this.recoverUnreadableLog(snapshotDigest, [], error);
      if (recovery.recoveryError) {
        throw new AggregateError(
          [error, recovery.recoveryError],
          'Workspace update log recovery failed',
        );
      }
      read = emptyReadLogResult(true);
    }

    if (read.corruption) {
      const recovery = await this.recoverUnreadableLog(snapshotDigest, read.records, read.corruption);
      if (recovery.recoveryError) {
        throw new AggregateError(
          [read.corruption, recovery.recoveryError],
          'Workspace update log recovery failed',
        );
      }
      read = recoveredReadLogResult(snapshotDigest, read);
    } else if (!read.exists || !read.headerMatches) {
      await this.replaceLogHeader(snapshotDigest);
      read = emptyReadLogResult(true);
    } else if (read.tornTail) {
      await this.replaceLogRecords(snapshotDigest, read.records);
      read = recoveredReadLogResult(snapshotDigest, read);
    }

    this.logCursor ??= {
      snapshotDigest,
      lastRecord: read.lastRecord,
      bytes: read.bytes,
      device: read.device,
      inode: read.inode,
    };
    return this.logCursor;
  }

  private async recoverUnreadableLog(
    snapshotDigest: string,
    records: readonly UpdateLogRecord[],
    error: unknown,
  ): Promise<WorkspacePersistenceRecovery> {
    await this.closeAppendHandle();
    this.logCursor = undefined;
    const quarantinedLogPath = `${this.updateLogPath}.unreadable-${Date.now()}-${crypto.randomUUID()}`;
    try {
      await copyFileDurable(this.updateLogPath, quarantinedLogPath, this.fsyncHandle);
      await this.replaceLogRecords(snapshotDigest, records);
      return { error, quarantinedLogPath };
    } catch (recoveryError) {
      if (isNotFound(recoveryError)) {
        try {
          await this.replaceLogRecords(snapshotDigest, records);
          return { error };
        } catch (replaceError) {
          return { error, recoveryError: replaceError };
        }
      }
      return { error, recoveryError };
    }
  }

  private async appendOpenLog(data: string, cursor: UpdateLogCursor): Promise<number> {
    const handle = await this.openAppendHandle();
    await this.assertOpenLogMatchesCursor(handle, cursor);
    await writeAll(handle, Buffer.from(data), null);
    await this.fsyncHandle(handle);
    const expectedSize = cursor.bytes + Buffer.byteLength(data);
    const size = await this.assertOpenLogMatchesPath(handle, expectedSize);
    return size;
  }

  private async syncOpenLog(cursor: UpdateLogCursor): Promise<number> {
    const handle = await this.openAppendHandle();
    await this.assertOpenLogMatchesCursor(handle, cursor);
    await this.fsyncHandle(handle);
    return this.assertOpenLogMatchesPath(handle, cursor.bytes);
  }

  private async openAppendHandle(): Promise<FileHandle> {
    this.appendHandle ??= await open(this.updateLogPath, 'a', 0o600);
    return this.appendHandle;
  }

  private async closeAppendHandle(): Promise<void> {
    const handle = this.appendHandle;
    this.appendHandle = undefined;
    await handle?.close();
  }

  private async invalidateLogCursor(): Promise<void> {
    this.logCursor = undefined;
    await this.closeAppendHandle().catch(() => undefined);
  }

  private async assertOpenLogMatchesCursor(handle: FileHandle, cursor: UpdateLogCursor): Promise<void> {
    const handleStat = await handle.stat();
    if (
      handleStat.size !== cursor.bytes
      || handleStat.dev !== cursor.device
      || handleStat.ino !== cursor.inode
    ) throw this.resnapshotRequiredError();
    await this.assertPathMatchesStat(handleStat);
  }

  private async assertOpenLogMatchesPath(handle: FileHandle, expectedSize: number): Promise<number> {
    const handleStat = await handle.stat();
    if (handleStat.size !== expectedSize) throw this.resnapshotRequiredError();
    await this.assertPathMatchesStat(handleStat);
    return handleStat.size;
  }

  private async assertPathMatchesStat(handleStat: Awaited<ReturnType<FileHandle['stat']>>): Promise<void> {
    let pathStat: Awaited<ReturnType<typeof stat>>;
    try {
      pathStat = await stat(this.updateLogPath);
    } catch (error) {
      if (isNotFound(error)) throw this.resnapshotRequiredError();
      throw error;
    }
    if (
      pathStat.size !== handleStat.size
      || pathStat.dev !== handleStat.dev
      || pathStat.ino !== handleStat.ino
    ) throw this.resnapshotRequiredError();
  }

  private resnapshotRequiredError(): WorkspacePersistenceResnapshotRequiredError {
    return new WorkspacePersistenceResnapshotRequiredError(
      `Workspace update log changed outside the persistence store at ${this.updateLogPath}`,
    );
  }

  private async replaceLogHeader(snapshotDigest: string): Promise<void> {
    await this.replaceLogRecords(snapshotDigest, []);
  }

  private async replaceLogRecords(
    snapshotDigest: string,
    records: readonly UpdateLogRecord[],
  ): Promise<void> {
    await this.closeAppendHandle();
    const data = serializeLog(snapshotDigest, records);
    await replaceFileDurable(
      this.updateLogPath,
      data,
      this.fsyncHandle,
    );
    const logStat = await stat(this.updateLogPath);
    this.logCursor = {
      snapshotDigest,
      lastRecord: records.length > 0 ? summarizeUpdateLogRecord(records[records.length - 1]!) : null,
      bytes: Buffer.byteLength(data),
      device: logStat.dev,
      inode: logStat.ino,
    };
  }
}

function assertStaleLogAbsorbed(
  lines: readonly string[],
  hasTerminatingNewline: boolean,
  snapshot: WorkspacePersistenceEnvelopeV3,
  source: string,
): void {
  const snapshotRevision = snapshot.persistenceRevision;
  const snapshotMetadataSequence = snapshot.persistenceMetadataSequence;
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

function serializeLog(snapshotDigest: string, records: readonly UpdateLogRecord[]): string {
  return [logHeader(snapshotDigest), ...records].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
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

function summarizeUpdateLogRecord(record: UpdateLogRecord): UpdateLogRecordSummary {
  return {
    persistenceRevision: record.persistenceRevision,
    metadataSequence: record.metadataSequence,
    installationId: record.local.installationId,
    replicaId: record.local.replicaId,
    digest: updateLogRecordDigest(record),
  };
}

function updateLogRecordDigest(record: UpdateLogRecord): string {
  return digest(JSON.stringify(record));
}

function emptyReadLogResult(exists: boolean): ReadLogResult {
  return {
    entries: [],
    records: [],
    bytes: 0,
    exists,
    headerMatches: exists,
    tornTail: false,
    lastRecord: null,
  };
}

function recoveredReadLogResult(snapshotDigest: string, read: ReadLogResult): ReadLogResult {
  return {
    entries: read.entries,
    records: read.records,
    bytes: Buffer.byteLength(serializeLog(snapshotDigest, read.records)),
    exists: true,
    headerMatches: true,
    tornTail: false,
    lastRecord: read.lastRecord,
  };
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

function versionVectorsEqual(left: Uint8Array, right: Uint8Array): boolean {
  return versionVectorIncludes(left, right) && versionVectorIncludes(right, left);
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

async function copyFileDurable(
  sourcePath: string,
  destinationPath: string,
  fsyncHandle: (handle: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<void> {
  await copyFile(sourcePath, destinationPath);
  const handle = await open(destinationPath, 'r');
  try {
    await fsyncHandle(handle);
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(destinationPath), fsyncHandle);
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

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
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

class JsonSyntaxError extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
