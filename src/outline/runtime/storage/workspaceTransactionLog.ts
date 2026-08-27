import { createHash } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Value } from 'typebox/value';
import type { ContentAnchorCoordinate } from '../../../content';
import type { ProjectionUpdate } from '../../../core/types';
import type {
  CorePersistenceCapture,
  WorkspacePersistenceEnvelopeV3,
  WorkspacePersistenceLocalDelta,
  WorkspacePersistenceReplayEntry,
} from '../../../core/core';
import { Core } from '../../../core/core';
import { isOperationHistoryEntry } from '../../../core/operationJournal';
import { canonicalJson, canonicalSha256 } from '../../contract/canonical';
import { OutlineContractError, outlineError } from '../../contract/errors';
import {
  AcceptedDesktopChangeSetMutationSchema,
  EventSchema,
  OperationSchema,
  AssetLeaseSchema,
  AssetRecordSchema,
  type AssetLease,
  type AssetRecord,
  type Diff,
  type Operation,
  type OutlineEvent,
} from '../../contract/schemas';
import {
  OUTLINE_EVENT_RETENTION,
  OUTLINE_RECOVERY_BUDGET_BYTES,
  OUTLINE_RECOVERY_MINIMUM_DAYS,
  OUTLINE_RECOVERY_MINIMUM_OPERATIONS,
  OUTLINE_STORAGE_VERSION,
} from '../../contract/version';
import {
  assertOutlineRecoveryPatch,
  type OutlineRecoveryPatch,
} from './recoveryPatch';
import {
  assertOutlineAssetRetentionCoordinate,
  assertOutlineAssetStage,
  assertOutlineAssetStageCoordinate,
  assertOutlineStoredAssetRecord,
  type OutlineAssetRetentionCoordinate,
  type OutlineAssetStage,
  type OutlineAssetStageCoordinate,
  type OutlineStoredAssetRecord,
} from './assetTypes';
import { encodeEventCursor } from '../eventCursor';

const SNAPSHOT_FILE = 'outline.snapshot.json';
const TRANSACTION_LOG_FILE = 'outline.transactions.jsonl';
const RECOVERY_DIRECTORY = 'recovery';
const SNAPSHOT_KIND = 'outline.workspace-snapshot';
const LOG_HEADER_KIND = 'outline.transaction-log';
const TRANSACTION_KIND = 'outline.transaction';
const RECOVERY_EXPIRY_KIND = 'outline.recovery-expiry';
const ASSET_STAGE_KIND = 'outline.asset-stage';
const ASSET_GC_KIND = 'outline.asset-gc';
const DEFAULT_INLINE_RECOVERY_BYTES = 64 * 1024;
const DEFAULT_COMPACTION_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_COMPACTION_RECORDS = 1_000;

export interface OutlineAssetDelta {
  readonly consumedLeaseIds: readonly string[];
  readonly liveAddedAssetRecordIds: readonly string[];
  readonly liveRemovedAssetRecordIds: readonly string[];
}

export type ExactRevisionByteMeasurer = (
  coordinates: readonly ContentAnchorCoordinate[],
  excluding?: readonly ContentAnchorCoordinate[],
) => Promise<number>;

export interface OutlineIdempotencyRecord {
  readonly key: string;
  readonly payloadHash: string;
  readonly operationId: string;
  readonly accepted?: {
    readonly update: ProjectionUpdate;
    readonly diff: Diff;
  };
}

export interface WorkspaceTransactionInput {
  readonly persistence: CorePersistenceCapture;
  readonly operation: Operation;
  readonly recoveryPatch: OutlineRecoveryPatch;
  readonly event: OutlineEvent;
  readonly idempotency?: OutlineIdempotencyRecord;
  readonly assetDelta?: OutlineAssetDelta;
  readonly measureExactRevisionBytes?: ExactRevisionByteMeasurer;
}

export interface WorkspaceTransactionBatchInput extends Omit<WorkspaceTransactionInput, 'event'> {
  readonly createEvent: (sequence: number) => OutlineEvent;
}

export interface WorkspaceTransactionAppendResult {
  readonly operation: Operation;
  readonly event: OutlineEvent;
  readonly sequence: number;
  readonly idempotent: boolean;
  readonly maintenanceEvents: readonly OutlineEvent[];
}

export interface WorkspaceMutationAdmission {
  readonly latestEventSequence: number;
  readonly existingOperation?: Operation;
  readonly maintenanceEvents: readonly OutlineEvent[];
}

export interface WorkspaceIdempotencySettlement {
  readonly operation: Operation;
  readonly accepted?: NonNullable<OutlineIdempotencyRecord['accepted']>;
}

export interface WorkspaceMaintenanceContext {
  readonly instanceId: string;
  readonly revision: number;
}

export interface WorkspaceTransactionLogHealth {
  readonly transactionLog: {
    readonly health: 'healthy' | 'degraded' | 'blocked';
    readonly sequence: number;
    readonly eventSequence: number;
    readonly snapshotSequence: number;
    readonly validBytes: number;
    readonly totalBytes: number;
    readonly tornTail: boolean;
    readonly stale: boolean;
    readonly inconsistent: boolean;
    readonly maintenancePending: boolean;
  };
  readonly recovery: {
    readonly available: number;
    readonly conflicted: number;
    readonly reverted: number;
    readonly expired: number;
    readonly retainedBytes: number;
    readonly budgetBytes: number;
    readonly orphanBlobCount: number;
  };
}

export interface WorkspaceTransactionLoad {
  readonly snapshot: WorkspacePersistenceEnvelopeV3 | null;
  readonly replay: readonly WorkspacePersistenceReplayEntry[];
  readonly operations: readonly Operation[];
  readonly idempotency: readonly OutlineIdempotencyRecord[];
  readonly events: readonly OutlineEvent[];
  readonly latestSequence: number;
  readonly latestEventSequence: number;
  readonly tornTail: boolean;
  readonly orphanRecoveryBlobs: readonly string[];
  readonly inconsistent?: Error;
}

export interface WorkspaceTransactionLogOptions {
  readonly snapshotFileName?: string;
  readonly transactionLogFileName?: string;
  readonly inlineRecoveryBytes?: number;
  readonly recoveryBudgetBytes?: number;
  readonly minimumRetentionDays?: number;
  readonly minimumRetentionOperations?: number;
  readonly eventRetention?: number;
  readonly compactionLogBytes?: number;
  readonly compactionRecords?: number;
  readonly now?: () => Date;
  readonly fsync?: (handle: FileHandle) => Promise<void>;
  readonly afterRecoveryBlobFsync?: (patch: OutlineRecoveryPatch) => void | Promise<void>;
  readonly afterTransactionFsync?: (operation: Operation) => void | Promise<void>;
  readonly afterSnapshotRename?: () => void | Promise<void>;
}

interface RecoveryReference {
  readonly recoveryPatchId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly storage: 'inline' | 'blob';
  readonly inline?: OutlineRecoveryPatch;
  readonly protectedAssetRecordIds: readonly string[];
}

interface EncodedPersistenceCapture {
  readonly persistenceRevision: number;
  readonly metadataSequence: number;
  readonly update: string;
  readonly version: string;
  readonly local: WorkspacePersistenceLocalDelta;
}

interface TransactionRecordBody {
  readonly kind: typeof TRANSACTION_KIND;
  readonly storageVersion: typeof OUTLINE_STORAGE_VERSION;
  readonly sequence: number;
  readonly previousChecksum: string;
  readonly persistence: EncodedPersistenceCapture;
  readonly operation: Operation;
  readonly recovery: RecoveryReference;
  readonly event: OutlineEvent;
  readonly idempotency?: OutlineIdempotencyRecord;
  readonly assetDelta: OutlineAssetDelta;
}

interface RecoveryExpiryRecordBody {
  readonly kind: typeof RECOVERY_EXPIRY_KIND;
  readonly storageVersion: typeof OUTLINE_STORAGE_VERSION;
  readonly sequence: number;
  readonly previousChecksum: string;
  readonly operationIds: readonly string[];
  readonly recoveryPatchIds: readonly string[];
  readonly event: OutlineEvent;
}

interface AssetStageRecordBody {
  readonly kind: typeof ASSET_STAGE_KIND;
  readonly storageVersion: typeof OUTLINE_STORAGE_VERSION;
  readonly sequence: number;
  readonly previousChecksum: string;
  readonly stage: OutlineAssetStageCoordinate;
}

interface AssetGcRecordBody {
  readonly kind: typeof ASSET_GC_KIND;
  readonly storageVersion: typeof OUTLINE_STORAGE_VERSION;
  readonly sequence: number;
  readonly previousChecksum: string;
  readonly assetIds: readonly string[];
}

type LogRecordBody = TransactionRecordBody | RecoveryExpiryRecordBody | AssetStageRecordBody | AssetGcRecordBody;
type LogRecord = LogRecordBody & { readonly checksum: string };

interface LogHeaderBody {
  readonly kind: typeof LOG_HEADER_KIND;
  readonly storageVersion: typeof OUTLINE_STORAGE_VERSION;
  readonly snapshotChecksum: string;
  readonly snapshotSequence: number;
}

type LogHeader = LogHeaderBody & { readonly checksum: string };

interface SnapshotBody {
  readonly kind: typeof SNAPSHOT_KIND;
  readonly storageVersion: typeof OUTLINE_STORAGE_VERSION;
  readonly sequence: number;
  readonly latestEventSequence: number;
  readonly createdAt: string;
  readonly document: WorkspacePersistenceEnvelopeV3;
  readonly operations: readonly Operation[];
  readonly recovery: Readonly<Record<string, RecoveryReference>>;
  readonly idempotency: readonly OutlineIdempotencyRecord[];
  readonly events: readonly OutlineEvent[];
  readonly assetRecords: readonly OutlineAssetRetentionCoordinate[];
  readonly assetLeases: readonly AssetLease[];
  readonly liveAssetRecordIds: readonly string[];
}

type SnapshotEnvelope = SnapshotBody & { readonly checksum: string };

interface LoadedState {
  snapshot: SnapshotEnvelope;
  snapshotChecksum: string;
  replay: WorkspacePersistenceReplayEntry[];
  operations: Operation[];
  operationById: Map<string, Operation>;
  recoveryByOperationId: Map<string, RecoveryReference>;
  idempotencyByKey: Map<string, OutlineIdempotencyRecord>;
  events: OutlineEvent[];
  assetRecordById: Map<string, OutlineStoredAssetRecord>;
  degradedAssetRecordById: Map<string, OutlineAssetRetentionCoordinate>;
  assetLeaseById: Map<string, AssetLease>;
  liveAssetRecordIds: Set<string>;
  latestSequence: number;
  latestEventSequence: number;
  headChecksum: string;
  logValidBytes: number;
  tornTail: boolean;
  staleLog: boolean;
  orphanRecoveryBlobs: string[];
  inconsistent?: Error;
}

const EMPTY_ASSET_DELTA: OutlineAssetDelta = Object.freeze({
  consumedLeaseIds: [],
  liveAddedAssetRecordIds: [],
  liveRemovedAssetRecordIds: [],
});

export class WorkspaceTransactionLog {
  readonly snapshotPath: string;
  readonly transactionLogPath: string;
  readonly recoveryDirectory: string;
  private readonly inlineRecoveryBytes: number;
  private readonly recoveryBudgetBytes: number;
  private readonly minimumRetentionDays: number;
  private readonly minimumRetentionOperations: number;
  private readonly eventRetention: number;
  private readonly compactionLogBytes: number;
  private readonly compactionRecords: number;
  private readonly now: () => Date;
  private readonly fsyncHandle: (handle: FileHandle) => Promise<void>;
  private readonly afterRecoveryBlobFsync?: WorkspaceTransactionLogOptions['afterRecoveryBlobFsync'];
  private readonly afterTransactionFsync?: WorkspaceTransactionLogOptions['afterTransactionFsync'];
  private readonly afterSnapshotRename?: WorkspaceTransactionLogOptions['afterSnapshotRename'];
  private state?: LoadedState;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string, options: WorkspaceTransactionLogOptions = {}) {
    this.snapshotPath = path.join(root, options.snapshotFileName ?? SNAPSHOT_FILE);
    this.transactionLogPath = path.join(root, options.transactionLogFileName ?? TRANSACTION_LOG_FILE);
    this.recoveryDirectory = path.join(root, RECOVERY_DIRECTORY);
    this.inlineRecoveryBytes = Math.max(0, options.inlineRecoveryBytes ?? DEFAULT_INLINE_RECOVERY_BYTES);
    this.recoveryBudgetBytes = Math.max(0, options.recoveryBudgetBytes ?? OUTLINE_RECOVERY_BUDGET_BYTES);
    this.minimumRetentionDays = Math.max(0, options.minimumRetentionDays ?? OUTLINE_RECOVERY_MINIMUM_DAYS);
    this.minimumRetentionOperations = Math.max(
      0,
      options.minimumRetentionOperations ?? OUTLINE_RECOVERY_MINIMUM_OPERATIONS,
    );
    this.eventRetention = Math.max(1, options.eventRetention ?? OUTLINE_EVENT_RETENTION);
    this.compactionLogBytes = Math.max(1, options.compactionLogBytes ?? DEFAULT_COMPACTION_LOG_BYTES);
    this.compactionRecords = Math.max(1, options.compactionRecords ?? DEFAULT_COMPACTION_RECORDS);
    this.now = options.now ?? (() => new Date());
    this.fsyncHandle = options.fsync ?? (async (handle) => handle.sync());
    this.afterRecoveryBlobFsync = options.afterRecoveryBlobFsync;
    this.afterTransactionFsync = options.afterTransactionFsync;
    this.afterSnapshotRename = options.afterSnapshotRename;
  }

  workspaceRoot(): string {
    return this.root;
  }

  async initialize(documentSnapshotRaw: string): Promise<void> {
    return this.enqueueWrite(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await mkdir(this.recoveryDirectory, { recursive: true, mode: 0o700 });
      const existing = await this.readSnapshot().catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (existing) {
        this.state = await this.readState(existing);
        return;
      }
      const document = Core.deserializeState(documentSnapshotRaw);
      const snapshot = snapshotEnvelope({
        kind: SNAPSHOT_KIND,
        storageVersion: OUTLINE_STORAGE_VERSION,
        sequence: 0,
        latestEventSequence: 0,
        createdAt: this.now().toISOString(),
        document,
        operations: [],
        recovery: {},
        idempotency: [],
        events: [],
        assetRecords: [],
        assetLeases: [],
        liveAssetRecordIds: [],
      });
      await writeJsonDurable(this.snapshotPath, snapshot, this.fsyncHandle);
      await this.afterSnapshotRename?.();
      await writeJsonlDurable(
        this.transactionLogPath,
        `${JSON.stringify(logHeader(snapshot.checksum, snapshot.sequence))}\n`,
        this.fsyncHandle,
      );
      this.state = await this.readState(snapshot);
    });
  }

  async load(): Promise<WorkspaceTransactionLoad> {
    return this.enqueueWrite(async () => {
      const snapshot = await this.readSnapshot().catch((error: unknown) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (!snapshot) {
        const logExists = await fileExists(this.transactionLogPath);
        if (logExists) throw new Error('Outline transaction log exists without a verified snapshot');
        this.state = undefined;
        return {
          snapshot: null,
          replay: [],
          operations: [],
          idempotency: [],
          events: [],
          latestSequence: 0,
          latestEventSequence: 0,
          tornTail: false,
          orphanRecoveryBlobs: [],
        };
      }
      this.state = await this.readState(snapshot);
      return this.publicLoad(this.state);
    });
  }

  async health(measureExactRevisionBytes?: ExactRevisionByteMeasurer): Promise<WorkspaceTransactionLogHealth> {
    return this.enqueueWrite(async () => this.publicHealth(await this.ensureState(), measureExactRevisionBytes));
  }

  async needsCompaction(): Promise<boolean> {
    return this.enqueueWrite(async () => this.compactionNeeded(await this.ensureState()));
  }

  async maintain(context: WorkspaceMaintenanceContext): Promise<readonly OutlineEvent[]> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      if (state.inconsistent) return [];
      await this.prepareLogForAppend(state);
      const event = await this.expireEligibleRecovery(state, this.now(), context);
      await this.collectOrphanRecoveryBlobs(state);
      return event ? [event] : [];
    });
  }

  async append(input: WorkspaceTransactionInput): Promise<WorkspaceTransactionAppendResult> {
    return this.enqueueWrite(async () => {
      const state = await this.requireWritableState();
      assertTransactionInput(input);
      const idempotent = input.idempotency
        ? this.resolveIdempotency(state, input.idempotency)
        : undefined;
      if (idempotent) {
        const event = [...state.events].reverse()
          .find((candidate) => candidate.operation?.operationId === idempotent.operationId);
        if (!event) throw new Error(`Committed idempotent Operation has no retained Event: ${idempotent.operationId}`);
        return {
          operation: idempotent,
          event,
          sequence: state.latestSequence,
          idempotent: true,
          maintenanceEvents: [],
        };
      }
      if (state.operationById.has(input.operation.operationId)) {
        throw new Error(`Outline Operation already exists: ${input.operation.operationId}`);
      }

      const maintenanceEvent = await this.expireEligibleRecovery(state, this.now(), {
        instanceId: input.event.instanceId,
        revision: input.operation.revisionBefore,
      });
      assertAssetDeltaAdmission(input.assetDelta ?? EMPTY_ASSET_DELTA, state, this.now());
      assertEventSequence(input.event, state);
      const encodedPatch = canonicalJson(input.recoveryPatch);
      const patchBytes = Buffer.byteLength(encodedPatch);
      const currentRecoveryBytes = await this.availableRecoveryBytes(
        state,
        input.measureExactRevisionBytes,
      );
      const candidateAssetBytes = await this.measureRecoveryAssetBytes(
        state,
        input.measureExactRevisionBytes,
        input.recoveryPatch.protectedAssetRecordIds,
        input.assetDelta ?? EMPTY_ASSET_DELTA,
      );
      const currentPatchBytes = this.recoveryPatchBytes(state);
      const candidateRecoveryBytes = currentPatchBytes + patchBytes + candidateAssetBytes;
      if (candidateRecoveryBytes > this.recoveryBudgetBytes) {
        throw new OutlineContractError(outlineError(
          'recovery_capacity_exceeded',
          'durability',
          'Recovery capacity is exhausted; no document changes were committed.',
          {
            details: {
              budgetBytes: this.recoveryBudgetBytes,
              retainedBytes: currentRecoveryBytes,
              requestedBytes: Math.max(0, candidateRecoveryBytes - currentRecoveryBytes),
            },
          },
        ));
      }

      const recovery = await this.persistRecovery(input.recoveryPatch, encodedPatch);
      const body: TransactionRecordBody = {
        kind: TRANSACTION_KIND,
        storageVersion: OUTLINE_STORAGE_VERSION,
        sequence: state.latestSequence + 1,
        previousChecksum: state.headChecksum,
        persistence: encodePersistenceCapture(input.persistence),
        operation: clone(input.operation),
        recovery,
        event: clone(input.event),
        ...(input.idempotency ? { idempotency: clone(input.idempotency) } : {}),
        assetDelta: clone(input.assetDelta ?? EMPTY_ASSET_DELTA),
      };
      const record = logRecord(body);
      assertReplayedRecord(record, state);
      await this.prepareLogForAppend(state);
      try {
        await appendJsonlDurable(this.transactionLogPath, record, this.fsyncHandle);
      } catch (error) {
        this.state = undefined;
        throw new OutlineContractError(outlineError(
          'durability_failed',
          'durability',
          'The transaction log could not confirm durable settlement.',
          { retryable: true, details: errorMessage(error) },
        ));
      }
      applyTransactionRecord(state, record, this.eventRetention);
      state.logValidBytes += jsonlRecordBytes(record);
      await this.afterTransactionFsync?.(clone(input.operation));
      return {
        operation: clone(input.operation),
        event: clone(input.event),
        sequence: record.sequence,
        idempotent: false,
        maintenanceEvents: maintenanceEvent ? [maintenanceEvent] : [],
      };
    });
  }

  async appendBatch(
    inputs: readonly WorkspaceTransactionBatchInput[],
  ): Promise<readonly WorkspaceTransactionAppendResult[]> {
    if (inputs.length === 0) return [];
    return this.enqueueWrite(async () => {
      const state = await this.requireWritableState();
      const initialInputs = inputs.map((batchInput): WorkspaceTransactionInput => {
        const { createEvent, ...input } = batchInput;
        return { ...input, event: createEvent(state.latestEventSequence + 1) };
      });
      const existingOperations = initialInputs.map((input) => {
        assertTransactionInput(input);
        const existing = input.idempotency
          ? this.resolveIdempotency(state, input.idempotency)
          : undefined;
        if (!existing && state.operationById.has(input.operation.operationId)) {
          throw new Error(`Outline Operation already exists: ${input.operation.operationId}`);
        }
        return existing;
      });
      const firstNewInputIndex = existingOperations.findIndex((operation) => operation === undefined);
      if (firstNewInputIndex < 0) {
        return existingOperations.map((operation) => {
          if (!operation) throw new Error('Idempotent batch settlement is missing its Operation.');
          const event = [...state.events].reverse()
            .find((candidate) => candidate.operation?.operationId === operation.operationId);
          if (!event) throw new Error(`Committed idempotent Operation has no retained Event: ${operation.operationId}`);
          return {
            operation,
            event,
            sequence: state.latestSequence,
            idempotent: true,
            maintenanceEvents: [],
          };
        });
      }
      const firstNewInput = initialInputs[firstNewInputIndex]!;
      const maintenanceEvent = await this.expireEligibleRecovery(state, this.now(), {
        instanceId: firstNewInput.event.instanceId,
        revision: firstNewInput.operation.revisionBefore,
      });
      await this.prepareLogForAppend(state);
      const staged = stageLoadedState(state);
      const records: Array<TransactionRecordBody & { readonly checksum: string }> = [];
      const results: WorkspaceTransactionAppendResult[] = [];

      for (const batchInput of inputs) {
        const { createEvent, ...transactionInput } = batchInput;
        const input: WorkspaceTransactionInput = {
          ...transactionInput,
          event: createEvent(staged.latestEventSequence + 1),
        };
        assertTransactionInput(input);
        const idempotent = input.idempotency
          ? this.resolveIdempotency(staged, input.idempotency)
          : undefined;
        if (idempotent) {
          const committedEvent = [...staged.events].reverse()
            .find((candidate) => candidate.operation?.operationId === idempotent.operationId);
          if (!committedEvent) {
            throw new Error(`Committed idempotent Operation has no retained Event: ${idempotent.operationId}`);
          }
          results.push({
            operation: idempotent,
            event: committedEvent,
            sequence: staged.latestSequence,
            idempotent: true,
            maintenanceEvents: [],
          });
          continue;
        }
        if (staged.operationById.has(input.operation.operationId)) {
          throw new Error(`Outline Operation already exists: ${input.operation.operationId}`);
        }

        assertAssetDeltaAdmission(input.assetDelta ?? EMPTY_ASSET_DELTA, staged, this.now());
        assertEventSequence(input.event, staged);
        const encodedPatch = canonicalJson(input.recoveryPatch);
        const patchBytes = Buffer.byteLength(encodedPatch);
        const currentRecoveryBytes = await this.availableRecoveryBytes(
          staged,
          input.measureExactRevisionBytes,
        );
        const candidateAssetBytes = await this.measureRecoveryAssetBytes(
          staged,
          input.measureExactRevisionBytes,
          input.recoveryPatch.protectedAssetRecordIds,
          input.assetDelta ?? EMPTY_ASSET_DELTA,
        );
        const candidateRecoveryBytes = this.recoveryPatchBytes(staged) + patchBytes + candidateAssetBytes;
        if (candidateRecoveryBytes > this.recoveryBudgetBytes) {
          throw new OutlineContractError(outlineError(
            'recovery_capacity_exceeded',
            'durability',
            'Recovery capacity is exhausted; no document changes were committed.',
            {
              details: {
                budgetBytes: this.recoveryBudgetBytes,
                retainedBytes: currentRecoveryBytes,
                requestedBytes: Math.max(0, candidateRecoveryBytes - currentRecoveryBytes),
              },
            },
          ));
        }

        const recovery = await this.persistRecovery(input.recoveryPatch, encodedPatch);
        const body: TransactionRecordBody = {
          kind: TRANSACTION_KIND,
          storageVersion: OUTLINE_STORAGE_VERSION,
          sequence: staged.latestSequence + 1,
          previousChecksum: staged.headChecksum,
          persistence: encodePersistenceCapture(input.persistence),
          operation: clone(input.operation),
          recovery,
          event: clone(input.event),
          ...(input.idempotency ? { idempotency: clone(input.idempotency) } : {}),
          assetDelta: clone(input.assetDelta ?? EMPTY_ASSET_DELTA),
        };
        const record = logRecord(body);
        assertReplayedRecord(record, staged);
        applyTransactionRecord(staged, record, this.eventRetention);
        staged.logValidBytes += jsonlRecordBytes(record);
        records.push(record);
        results.push({
          operation: clone(input.operation),
          event: clone(input.event),
          sequence: record.sequence,
          idempotent: false,
          maintenanceEvents: [],
        });
      }

      if (maintenanceEvent && results[firstNewInputIndex]) {
        results[firstNewInputIndex] = {
          ...results[firstNewInputIndex]!,
          maintenanceEvents: [maintenanceEvent],
        };
      }
      if (records.length === 0) return results;
      try {
        await appendJsonlBatchDurable(this.transactionLogPath, records, this.fsyncHandle);
      } catch (error) {
        this.state = undefined;
        throw uncertainDurabilityError(error);
      }
      this.state = staged;
      try {
        for (const record of records) {
          await this.afterTransactionFsync?.(clone(record.operation));
        }
      } catch (error) {
        this.state = undefined;
        throw error;
      }
      return results;
    });
  }

  async prepareMutation(
    idempotency?: Pick<OutlineIdempotencyRecord, 'key' | 'payloadHash'>,
    context?: WorkspaceMaintenanceContext,
  ): Promise<WorkspaceMutationAdmission> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      if (idempotency) {
        const existing = this.resolveIdempotency(state, idempotency);
        if (existing) {
          return { latestEventSequence: state.latestEventSequence, existingOperation: existing, maintenanceEvents: [] };
        }
      }
      if (state.inconsistent) {
        throw new OutlineContractError(outlineError(
          'recovery_inconsistent',
          'durability',
          'The verified workspace prefix is readable, but mutations are blocked by inconsistent recovery data.',
          { details: state.inconsistent.message },
        ));
      }
      const event = await this.expireEligibleRecovery(state, this.now(), context);
      return {
        latestEventSequence: state.latestEventSequence,
        maintenanceEvents: event ? [event] : [],
      };
    });
  }

  async recoveryPatch(operationId: string): Promise<OutlineRecoveryPatch> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      const operation = state.operationById.get(operationId);
      if (!operation) {
        throw new OutlineContractError(outlineError('not_found', 'selection', `Operation not found: ${operationId}`));
      }
      if (operation.recovery.state === 'expired') {
        throw new OutlineContractError(outlineError(
          'recovery_expired',
          'conflict',
          `Recovery has expired for Operation: ${operationId}`,
        ));
      }
      const recovery = state.recoveryByOperationId.get(operationId);
      if (!recovery) throw new Error(`Operation recovery index is missing: ${operationId}`);
      return this.readRecoveryReference(recovery);
    });
  }

  async operation(operationId: string): Promise<Operation | undefined> {
    return this.enqueueWrite(async () => {
      const operation = (await this.ensureState()).operationById.get(operationId);
      return operation ? clone(operation) : undefined;
    });
  }

  async operationForIdempotencyKey(key: string): Promise<Operation | undefined> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      const idempotency = state.idempotencyByKey.get(key);
      if (!idempotency) return undefined;
      const operation = state.operationById.get(idempotency.operationId);
      if (!operation) throw new Error(`Idempotency index references a missing Operation: ${key}`);
      return clone(operation);
    });
  }

  async idempotencySettlement(
    key: string,
    payloadHash: string,
  ): Promise<WorkspaceIdempotencySettlement | undefined> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      const operation = this.resolveIdempotency(state, { key, payloadHash });
      if (!operation) return undefined;
      const record = state.idempotencyByKey.get(key);
      if (!record) throw new Error(`Idempotency index disappeared during settlement lookup: ${key}`);
      return {
        operation: clone(operation),
        ...(record.accepted ? { accepted: clone(record.accepted) } : {}),
      };
    });
  }

  async operations(): Promise<readonly Operation[]> {
    return this.enqueueWrite(async () => clone((await this.ensureState()).operations));
  }

  async eventsAfter(sequence: number): Promise<readonly OutlineEvent[]> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      return clone(state.events.filter((event) => event.sequence > sequence));
    });
  }

  async stageAsset(stage: OutlineAssetStage): Promise<void> {
    return this.enqueueWrite(async () => {
      const state = await this.requireWritableState();
      assertOutlineAssetStage(stage);
      if (state.assetRecordById.has(stage.record.assetId)) {
        throw new Error(`Outline AssetRecord already exists: ${stage.record.assetId}`);
      }
      if (state.assetLeaseById.has(stage.lease.leaseId)) {
        throw new Error(`Outline AssetLease already exists: ${stage.lease.leaseId}`);
      }
      const body: AssetStageRecordBody = {
        kind: ASSET_STAGE_KIND,
        storageVersion: OUTLINE_STORAGE_VERSION,
        sequence: state.latestSequence + 1,
        previousChecksum: state.headChecksum,
        stage: clone(stage),
      };
      const record = logRecord(body);
      assertReplayedRecord(record, state);
      await this.prepareLogForAppend(state);
      try {
        await appendJsonlDurable(this.transactionLogPath, record, this.fsyncHandle);
      } catch (error) {
        this.state = undefined;
        throw uncertainDurabilityError(error);
      }
      applyAssetStageRecord(state, record);
      state.logValidBytes += jsonlRecordBytes(record);
    });
  }

  async assetRecord(assetId: string): Promise<AssetRecord | undefined> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      assertAssetRecordAvailable(state, assetId);
      const stored = state.assetRecordById.get(assetId);
      return stored ? clone(stored.record) : undefined;
    });
  }

  async assetRecords(): Promise<readonly AssetRecord[]> {
    return this.enqueueWrite(async () => clone(
      [...(await this.ensureState()).assetRecordById.values()].map((stored) => stored.record),
    ));
  }

  async storedAssetRecord(assetId: string): Promise<OutlineStoredAssetRecord | undefined> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      assertAssetRecordAvailable(state, assetId);
      const stored = state.assetRecordById.get(assetId);
      return stored ? clone(stored) : undefined;
    });
  }

  async verifiedStoredAssetRecords(): Promise<readonly OutlineAssetRetentionCoordinate[]> {
    return this.enqueueWrite(async () => {
      const state = await this.requireCompleteState();
      return clone([
        ...state.assetRecordById.values(),
        ...state.degradedAssetRecordById.values(),
      ]);
    });
  }

  async resolveAssetLeases(
    leaseIds: readonly string[],
    now = this.now(),
  ): Promise<ReadonlyMap<string, AssetLease>> {
    return this.enqueueWrite(async () => {
      const state = await this.requireWritableState();
      const result = new Map<string, AssetLease>();
      for (const leaseId of [...new Set(leaseIds)]) {
        const lease = state.assetLeaseById.get(leaseId);
        if (!lease) {
          throw new OutlineContractError(outlineError(
            'precondition_failed',
            'conflict',
            `Asset lease is unavailable or was already consumed: ${leaseId}`,
          ));
        }
        if (Date.parse(lease.expiresAt) <= now.getTime()) {
          throw new OutlineContractError(outlineError(
            'precondition_failed',
            'conflict',
            `Asset lease has expired: ${leaseId}`,
          ));
        }
        result.set(leaseId, clone(lease));
      }
      return result;
    });
  }

  async collectUnprotectedAssetRecords(
    liveAssetRecordIds: readonly string[],
    now = this.now(),
  ): Promise<readonly OutlineStoredAssetRecord[]> {
    return this.enqueueWrite(async () => {
      const state = await this.requireWritableState();
      // A degraded record may still contain logical links, such as a thumbnail
      // AssetRecord ID, that cannot be trusted or traversed. Keep collection
      // conservative until that one record is repaired instead of allowing its
      // invalid metadata to remove otherwise healthy logical records.
      if (state.degradedAssetRecordById.size > 0) return [];
      const protectedIds = new Set(liveAssetRecordIds);
      for (const lease of state.assetLeaseById.values()) {
        if (Date.parse(lease.expiresAt) > now.getTime()) protectedIds.add(lease.assetId);
      }
      for (const [operationId, reference] of state.recoveryByOperationId) {
        if (state.operationById.get(operationId)?.recovery.state === 'expired') continue;
        for (const assetId of reference.protectedAssetRecordIds) protectedIds.add(assetId);
      }
      expandThumbnailProtection(protectedIds, state.assetRecordById);
      const removed = [...state.assetRecordById.values()]
        .filter((stored) => !protectedIds.has(stored.record.assetId));
      if (removed.length === 0) return [];
      const body: AssetGcRecordBody = {
        kind: ASSET_GC_KIND,
        storageVersion: OUTLINE_STORAGE_VERSION,
        sequence: state.latestSequence + 1,
        previousChecksum: state.headChecksum,
        assetIds: removed.map((stored) => stored.record.assetId).sort(),
      };
      const record = logRecord(body);
      assertReplayedRecord(record, state);
      await this.prepareLogForAppend(state);
      try {
        await appendJsonlDurable(this.transactionLogPath, record, this.fsyncHandle);
      } catch (error) {
        this.state = undefined;
        throw uncertainDurabilityError(error);
      }
      applyAssetGcRecord(state, record);
      state.logValidBytes += jsonlRecordBytes(record);
      return clone(removed);
    });
  }

  async compact(
    documentSnapshotRaw: string,
    context?: WorkspaceMaintenanceContext,
  ): Promise<readonly OutlineEvent[]> {
    return this.enqueueWrite(async () => {
      try {
        const state = await this.requireWritableState();
        const document = Core.deserializeState(documentSnapshotRaw);
        const now = this.now();
        const maintenanceEvent = await this.expireEligibleRecovery(state, now, context);
        const retainedOperationIds = this.retainedOperationIds(state, now);
        const operations = state.operations.filter((operation) => retainedOperationIds.has(operation.operationId));
        const recovery = Object.fromEntries([...state.recoveryByOperationId]
          .filter(([operationId]) => (
            retainedOperationIds.has(operationId)
            && state.operationById.get(operationId)?.recovery.state !== 'expired'
          )));
        const idempotency = [...state.idempotencyByKey.values()]
          .filter((entry) => retainedOperationIds.has(entry.operationId));
        const snapshot = snapshotEnvelope({
          kind: SNAPSHOT_KIND,
          storageVersion: OUTLINE_STORAGE_VERSION,
          sequence: state.latestSequence,
          latestEventSequence: state.latestEventSequence,
          createdAt: this.now().toISOString(),
          document,
          operations: clone(operations),
          recovery: clone(recovery),
          idempotency: clone(idempotency),
          events: clone(state.events.slice(-this.eventRetention)),
          assetRecords: clone([
            ...state.assetRecordById.values(),
            ...state.degradedAssetRecordById.values(),
          ]),
          assetLeases: clone([...state.assetLeaseById.values()]),
          liveAssetRecordIds: [...state.liveAssetRecordIds].sort(),
        });
        await writeJsonDurable(this.snapshotPath, snapshot, this.fsyncHandle);
        await this.afterSnapshotRename?.();
        await writeJsonlDurable(
          this.transactionLogPath,
          `${JSON.stringify(logHeader(snapshot.checksum, snapshot.sequence))}\n`,
          this.fsyncHandle,
        );
        this.state = await this.readState(snapshot);
        await this.collectOrphanRecoveryBlobs(this.state);
        return maintenanceEvent ? [maintenanceEvent] : [];
      } catch (error) {
        this.state = undefined;
        throw error;
      }
    });
  }

  async collectOrphanRecoveryBlobsNow(): Promise<readonly string[]> {
    return this.enqueueWrite(async () => {
      const state = await this.ensureState();
      return this.collectOrphanRecoveryBlobs(state);
    });
  }

  private async readSnapshot(): Promise<SnapshotEnvelope> {
    const raw = await readFile(this.snapshotPath, 'utf8');
    const value = JSON.parse(raw) as unknown;
    assertSnapshotEnvelope(value);
    return value;
  }

  private async readState(snapshot: SnapshotEnvelope): Promise<LoadedState> {
    const snapshotChecksum = snapshot.checksum;
    const classifiedAssets = classifySnapshotAssetRecords(snapshot.assetRecords);
    const state: LoadedState = {
      snapshot,
      snapshotChecksum,
      replay: [],
      operations: clone([...snapshot.operations]),
      operationById: new Map(snapshot.operations.map((operation) => [operation.operationId, clone(operation)])),
      recoveryByOperationId: new Map(Object.entries(clone(snapshot.recovery))),
      idempotencyByKey: new Map(snapshot.idempotency.map((entry) => [entry.key, clone(entry)])),
      events: clone([...snapshot.events]),
      assetRecordById: classifiedAssets.valid,
      degradedAssetRecordById: classifiedAssets.degraded,
      assetLeaseById: new Map(snapshot.assetLeases
        .filter((lease) => classifiedAssets.valid.has(lease.assetId))
        .map((lease) => [lease.leaseId, clone(lease)])),
      liveAssetRecordIds: new Set(snapshot.liveAssetRecordIds),
      latestSequence: snapshot.sequence,
      latestEventSequence: snapshot.latestEventSequence,
      headChecksum: snapshotChecksum,
      logValidBytes: 0,
      tornTail: false,
      staleLog: false,
      orphanRecoveryBlobs: [],
    };
    const raw = await readFile(this.transactionLogPath, 'utf8').catch((error: unknown) => {
      if (isNotFound(error)) return '';
      throw error;
    });
    if (!raw) {
      state.staleLog = true;
      state.orphanRecoveryBlobs = await this.findOrphanRecoveryBlobs(state);
      return state;
    }
    const lastNewline = raw.lastIndexOf('\n');
    const completeRaw = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : '';
    state.tornTail = completeRaw.length !== raw.length;
    const lines = completeRaw.split('\n');
    lines.pop();
    if (lines.length === 0) {
      state.staleLog = true;
      state.logValidBytes = 0;
      state.orphanRecoveryBlobs = await this.findOrphanRecoveryBlobs(state);
      return state;
    }
    let header: LogHeader;
    try {
      header = JSON.parse(lines[0]!) as LogHeader;
      assertLogHeader(header);
    } catch (error) {
      state.inconsistent = asError(error, 'Invalid outline transaction log header');
      state.logValidBytes = Buffer.byteLength(`${lines[0]}\n`);
      state.orphanRecoveryBlobs = await this.findOrphanRecoveryBlobs(state);
      return state;
    }
    state.logValidBytes = Buffer.byteLength(`${lines[0]}\n`);
    if (header.snapshotChecksum !== snapshotChecksum) {
      if (header.snapshotSequence <= snapshot.sequence) {
        state.staleLog = true;
        state.tornTail = false;
      } else {
        state.inconsistent = new Error('Outline transaction log references a newer or different snapshot');
      }
      state.orphanRecoveryBlobs = await this.findOrphanRecoveryBlobs(state);
      return state;
    }
    for (const line of lines.slice(1)) {
      try {
        const record = JSON.parse(line) as LogRecord;
        assertLogRecord(record, state.latestSequence + 1, state.headChecksum);
        assertReplayedRecord(record, state);
        if (record.kind === TRANSACTION_KIND) {
          applyTransactionRecord(state, record, this.eventRetention);
          try {
            await this.verifyRecoveryReference(record.recovery, record.operation);
          } catch (error) {
            state.inconsistent ??= asError(
              error,
              `Invalid referenced outline recovery patch: ${record.recovery.recoveryPatchId}`,
            );
          }
        } else if (record.kind === RECOVERY_EXPIRY_KIND) {
          applyRecoveryExpiryRecord(state, record, this.eventRetention);
        } else if (record.kind === ASSET_STAGE_KIND) {
          applyAssetStageRecord(state, record);
        } else {
          applyAssetGcRecord(state, record);
        }
        state.logValidBytes += Buffer.byteLength(`${line}\n`);
      } catch (error) {
        state.inconsistent = asError(error, `Invalid committed outline transaction at sequence ${state.latestSequence + 1}`);
        break;
      }
    }
    for (const [operationId, recovery] of state.recoveryByOperationId) {
      if (state.operationById.get(operationId)?.recovery.state === 'expired') continue;
      try {
        await this.verifyRecoveryReference(recovery, state.operationById.get(operationId));
      } catch (error) {
        state.inconsistent ??= asError(error, `Invalid referenced outline recovery patch: ${recovery.recoveryPatchId}`);
      }
    }
    state.orphanRecoveryBlobs = await this.findOrphanRecoveryBlobs(state);
    return state;
  }

  private publicLoad(state: LoadedState): WorkspaceTransactionLoad {
    return {
      snapshot: clone(state.snapshot.document),
      replay: state.replay.map(cloneReplayEntry),
      operations: clone(state.operations),
      idempotency: clone([...state.idempotencyByKey.values()]),
      events: clone(state.events),
      latestSequence: state.latestSequence,
      latestEventSequence: state.latestEventSequence,
      tornTail: state.tornTail,
      orphanRecoveryBlobs: [...state.orphanRecoveryBlobs],
      ...(state.inconsistent ? { inconsistent: state.inconsistent } : {}),
    };
  }

  private async publicHealth(
    state: LoadedState,
    measureExactRevisionBytes?: ExactRevisionByteMeasurer,
  ): Promise<WorkspaceTransactionLogHealth> {
    const totalBytes = (await stat(this.transactionLogPath).catch((error: unknown) => {
      if (isNotFound(error)) return { size: 0 };
      throw error;
    })).size;
    const recovery = { available: 0, conflicted: 0, reverted: 0, expired: 0 };
    for (const operation of state.operations) recovery[operation.recovery.state] += 1;
    const maintenancePending = state.tornTail
      || state.staleLog
      || state.orphanRecoveryBlobs.length > 0
      || this.compactionNeeded(state, totalBytes);
    const health = state.inconsistent
      ? 'blocked'
      : maintenancePending ? 'degraded' : 'healthy';
    return {
      transactionLog: {
        health,
        sequence: state.latestSequence,
        eventSequence: state.latestEventSequence,
        snapshotSequence: state.snapshot.sequence,
        validBytes: state.logValidBytes,
        totalBytes,
        tornTail: state.tornTail,
        stale: state.staleLog,
        inconsistent: state.inconsistent !== undefined,
        maintenancePending,
      },
      recovery: {
        ...recovery,
        retainedBytes: await this.availableRecoveryBytes(state, measureExactRevisionBytes),
        budgetBytes: this.recoveryBudgetBytes,
        orphanBlobCount: state.orphanRecoveryBlobs.length,
      },
    };
  }

  private compactionNeeded(state: LoadedState, totalBytes = state.logValidBytes): boolean {
    return state.latestSequence - state.snapshot.sequence >= this.compactionRecords
      || totalBytes >= this.compactionLogBytes;
  }

  private async ensureState(): Promise<LoadedState> {
    if (this.state) return this.state;
    const snapshot = await this.readSnapshot().catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    if (!snapshot) throw new Error('Outline workspace transaction log is not initialized');
    this.state = await this.readState(snapshot);
    return this.state;
  }

  private async requireWritableState(): Promise<LoadedState> {
    const state = await this.ensureState();
    if (state.inconsistent) {
      throw new OutlineContractError(outlineError(
        'recovery_inconsistent',
        'durability',
        'The verified workspace prefix is readable, but mutations are blocked by inconsistent recovery data.',
        { details: state.inconsistent.message },
      ));
    }
    return state;
  }

  private async requireCompleteState(): Promise<LoadedState> {
    const state = await this.ensureState();
    if (state.inconsistent) {
      throw new OutlineContractError(outlineError(
        'recovery_inconsistent',
        'durability',
        'The complete workspace state cannot be enumerated because persisted data is inconsistent.',
        { details: state.inconsistent.message },
      ));
    }
    return state;
  }

  private resolveIdempotency(
    state: LoadedState,
    requested: Pick<OutlineIdempotencyRecord, 'key' | 'payloadHash'>,
  ): Operation | undefined {
    const existing = state.idempotencyByKey.get(requested.key);
    if (!existing) return undefined;
    if (existing.payloadHash !== requested.payloadHash) {
      throw new OutlineContractError(outlineError(
        'idempotency_conflict',
        'conflict',
        `Idempotency key was already used with a different payload: ${requested.key}`,
      ));
    }
    const operation = state.operationById.get(existing.operationId);
    if (!operation) throw new Error(`Idempotency index references a missing Operation: ${existing.operationId}`);
    return clone(operation);
  }

  private async persistRecovery(
    patch: OutlineRecoveryPatch,
    encoded: string,
  ): Promise<RecoveryReference> {
    assertOutlineRecoveryPatch(patch);
    const sha256 = sha256Text(encoded);
    const byteSize = Buffer.byteLength(encoded);
    const base = {
      recoveryPatchId: patch.recoveryPatchId,
      sha256,
      byteSize,
      protectedAssetRecordIds: [...patch.protectedAssetRecordIds],
    };
    if (byteSize <= this.inlineRecoveryBytes) return { ...base, storage: 'inline', inline: clone(patch) };
    await mkdir(this.recoveryDirectory, { recursive: true, mode: 0o700 });
    const blobPath = this.recoveryBlobPath(sha256);
    if (await fileExists(blobPath)) {
      const existing = await readFile(blobPath, 'utf8');
      if (sha256Text(existing) !== sha256) throw new Error(`Recovery blob digest collision: ${sha256}`);
    } else {
      await writeTextDurable(blobPath, encoded, this.fsyncHandle);
    }
    await this.afterRecoveryBlobFsync?.(clone(patch));
    return { ...base, storage: 'blob' };
  }

  private async verifyRecoveryReference(reference: RecoveryReference, operation?: Operation): Promise<void> {
    const patch = await this.readRecoveryReference(reference);
    if (patch.recoveryPatchId !== reference.recoveryPatchId) {
      throw new Error(`Recovery patch identity mismatch: ${reference.recoveryPatchId}`);
    }
    if (operation && (
      patch.operationId !== operation.operationId
      || patch.changeSetHash !== operation.changeSetHash
      || patch.diffHash !== operation.diffHash
      || patch.revisionBefore !== operation.revisionBefore
      || patch.revisionAfter !== operation.revisionAfter
      || canonicalSha256(patch.protectedAssetRecordIds) !== canonicalSha256(reference.protectedAssetRecordIds)
    )) {
      throw new Error(`Recovery patch Operation mismatch: ${operation.operationId}`);
    }
  }

  private async readRecoveryReference(reference: RecoveryReference): Promise<OutlineRecoveryPatch> {
    let raw: string;
    if (reference.storage === 'inline') {
      if (!reference.inline) throw new Error(`Inline recovery patch is missing: ${reference.recoveryPatchId}`);
      raw = canonicalJson(reference.inline);
    } else {
      raw = await readFile(this.recoveryBlobPath(reference.sha256), 'utf8');
    }
    if (Buffer.byteLength(raw) !== reference.byteSize || sha256Text(raw) !== reference.sha256) {
      throw new Error(`Recovery patch checksum mismatch: ${reference.recoveryPatchId}`);
    }
    const patch = JSON.parse(raw) as unknown;
    assertOutlineRecoveryPatch(patch);
    return clone(patch);
  }

  private async availableRecoveryBytes(
    state: LoadedState,
    measureExactRevisionBytes?: ExactRevisionByteMeasurer,
  ): Promise<number> {
    return this.recoveryPatchBytes(state)
      + await this.measureRecoveryAssetBytes(state, measureExactRevisionBytes);
  }

  private recoveryPatchBytes(state: LoadedState): number {
    let total = 0;
    for (const operation of state.operations) {
      if (operation.recovery.state === 'expired') continue;
      const reference = state.recoveryByOperationId.get(operation.operationId);
      if (reference) total += reference.byteSize;
    }
    return total;
  }

  private async measureRecoveryAssetBytes(
    state: LoadedState,
    measureExactRevisionBytes: ExactRevisionByteMeasurer | undefined,
    additionalProtectedAssetIds: readonly string[] = [],
    delta: OutlineAssetDelta = EMPTY_ASSET_DELTA,
  ): Promise<number> {
    const protectedAssetIds = new Set<string>();
    for (const [operationId, reference] of state.recoveryByOperationId) {
      if (state.operationById.get(operationId)?.recovery.state === 'expired') continue;
      for (const assetId of reference.protectedAssetRecordIds) protectedAssetIds.add(assetId);
    }
    for (const assetId of additionalProtectedAssetIds) protectedAssetIds.add(assetId);
    const liveAfter = new Set(state.liveAssetRecordIds);
    for (const assetId of delta.liveRemovedAssetRecordIds) liveAfter.delete(assetId);
    for (const assetId of delta.liveAddedAssetRecordIds) liveAfter.add(assetId);
    const recoveryCoordinates: ContentAnchorCoordinate[] = [];
    for (const assetId of protectedAssetIds) {
      if (liveAfter.has(assetId)) continue;
      const stored = storedAssetCoordinate(state, assetId);
      if (!stored) {
        throw new OutlineContractError(outlineError(
          'recovery_inconsistent',
          'durability',
          `Recovery references an unavailable AssetRecord: ${assetId}`,
        ));
      }
      recoveryCoordinates.push({
        namespace: 'outline',
        recordKey: assetId,
        reference: stored.exactRevision,
      });
    }
    if (recoveryCoordinates.length === 0) return 0;
    if (!measureExactRevisionBytes) {
      throw new OutlineContractError(outlineError(
        'recovery_inconsistent',
        'durability',
        'Exact-revision accounting is unavailable for recovery admission.',
      ));
    }
    const liveCoordinates: ContentAnchorCoordinate[] = [];
    for (const assetId of liveAfter) {
      const stored = storedAssetCoordinate(state, assetId);
      if (!stored) {
        throw new OutlineContractError(outlineError(
          'recovery_inconsistent',
          'durability',
          `The live document references an unavailable AssetRecord: ${assetId}`,
        ));
      }
      liveCoordinates.push({
        namespace: 'outline',
        recordKey: assetId,
        reference: stored.exactRevision,
      });
    }
    return measureExactRevisionBytes(recoveryCoordinates, liveCoordinates);
  }

  private async expireEligibleRecovery(
    state: LoadedState,
    now: Date,
    context?: WorkspaceMaintenanceContext,
  ): Promise<OutlineEvent | undefined> {
    const protectedIds = new Set(
      (this.minimumRetentionOperations === 0 ? [] : state.operations.slice(-this.minimumRetentionOperations))
        .map((operation) => operation.operationId),
    );
    const cutoff = now.getTime() - this.minimumRetentionDays * 86_400_000;
    const eligible = state.operations.filter((operation) => (
      operation.recovery.state !== 'expired'
      && !protectedIds.has(operation.operationId)
      && Date.parse(operation.createdAt) <= cutoff
    ));
    if (eligible.length === 0) return undefined;
    const instanceId = context?.instanceId
      ?? state.events.at(-1)?.instanceId
      ?? 'runtime:storage-maintenance';
    const revision = context?.revision
      ?? state.operations.at(-1)?.revisionAfter
      ?? state.events.at(-1)?.revision
      ?? 0;
    const eventSequence = state.latestEventSequence + 1;
    const event: OutlineEvent = {
      protocolVersion: eligible[0]!.protocolVersion,
      kind: 'outline.event',
      type: 'operation.recovery-expired',
      instanceId,
      sequence: eventSequence,
      revision,
      cursor: encodeEventCursor({ instanceId, sequence: eventSequence, revision }),
      recovery: {
        operationIds: eligible.map((operation) => operation.operationId),
        recoveryPatchIds: eligible.map((operation) => operation.recovery.recoveryPatchId),
      },
    };
    const body: RecoveryExpiryRecordBody = {
      kind: RECOVERY_EXPIRY_KIND,
      storageVersion: OUTLINE_STORAGE_VERSION,
      sequence: state.latestSequence + 1,
      previousChecksum: state.headChecksum,
      operationIds: eligible.map((operation) => operation.operationId),
      recoveryPatchIds: eligible.map((operation) => operation.recovery.recoveryPatchId),
      event,
    };
    const record = logRecord(body);
    await this.prepareLogForAppend(state);
    await appendJsonlDurable(this.transactionLogPath, record, this.fsyncHandle);
    applyRecoveryExpiryRecord(state, record, this.eventRetention);
    state.logValidBytes += jsonlRecordBytes(record);
    const referencedBlobDigests = new Set([...state.recoveryByOperationId.values()]
      .filter((reference) => reference.storage === 'blob')
      .filter((reference) => {
        const operation = state.operations.find((candidate) => (
          candidate.recovery.recoveryPatchId === reference.recoveryPatchId
        ));
        return operation?.recovery.state !== 'expired';
      })
      .map((reference) => reference.sha256));
    for (const operation of eligible) {
      const reference = state.recoveryByOperationId.get(operation.operationId);
      if (reference?.storage === 'blob' && !referencedBlobDigests.has(reference.sha256)) {
        await rm(this.recoveryBlobPath(reference.sha256), { force: true }).catch(() => undefined);
      }
    }
    state.orphanRecoveryBlobs = await this.findOrphanRecoveryBlobs(state);
    return event;
  }

  private retainedOperationIds(state: LoadedState, now: Date): Set<string> {
    const retained = new Set(
      (this.minimumRetentionOperations === 0 ? [] : state.operations.slice(-this.minimumRetentionOperations))
        .map((operation) => operation.operationId),
    );
    const cutoff = now.getTime() - this.minimumRetentionDays * 86_400_000;
    for (const operation of state.operations) {
      if (Date.parse(operation.createdAt) > cutoff) retained.add(operation.operationId);
    }
    return retained;
  }

  private async prepareLogForAppend(state: LoadedState): Promise<void> {
    if (state.staleLog) {
      await writeJsonlDurable(
        this.transactionLogPath,
        `${JSON.stringify(logHeader(state.snapshotChecksum, state.snapshot.sequence))}\n`,
        this.fsyncHandle,
      );
      state.logValidBytes = Buffer.byteLength(`${JSON.stringify(logHeader(
        state.snapshotChecksum,
        state.snapshot.sequence,
      ))}\n`);
      state.staleLog = false;
      state.tornTail = false;
      return;
    }
    if (!state.tornTail) return;
    const handle = await open(this.transactionLogPath, 'r+');
    try {
      await handle.truncate(state.logValidBytes);
      await this.fsyncHandle(handle);
    } finally {
      await handle.close();
    }
    state.tornTail = false;
  }

  private recoveryBlobPath(sha256: string): string {
    return path.join(this.recoveryDirectory, `${sha256}.json`);
  }

  private async findOrphanRecoveryBlobs(state: LoadedState): Promise<string[]> {
    const entries = await readdir(this.recoveryDirectory).catch((error: unknown) => {
      if (isNotFound(error)) return [] as string[];
      throw error;
    });
    const referenced = new Set([...state.recoveryByOperationId.values()]
      .filter((entry) => entry.storage === 'blob')
      .filter((entry) => {
        const operation = state.operations.find((candidate) => (
          candidate.recovery.recoveryPatchId === entry.recoveryPatchId
        ));
        return operation?.recovery.state !== 'expired';
      })
      .map((entry) => `${entry.sha256}.json`));
    return entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry) && !referenced.has(entry)).sort();
  }

  private async collectOrphanRecoveryBlobs(state: LoadedState): Promise<readonly string[]> {
    const orphans = await this.findOrphanRecoveryBlobs(state);
    for (const fileName of orphans) await rm(path.join(this.recoveryDirectory, fileName), { force: true });
    state.orphanRecoveryBlobs = [];
    return orphans;
  }

  private enqueueWrite<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }
}

function expandThumbnailProtection(
  protectedIds: Set<string>,
  records: ReadonlyMap<string, OutlineStoredAssetRecord>,
): void {
  const queue = [...protectedIds];
  while (queue.length > 0) {
    const thumbnailAssetId = records.get(queue.shift()!)?.record.metadata.thumbnailAssetId;
    if (!thumbnailAssetId || protectedIds.has(thumbnailAssetId)) continue;
    protectedIds.add(thumbnailAssetId);
    queue.push(thumbnailAssetId);
  }
}

function storedAssetCoordinate(
  state: LoadedState,
  assetId: string,
): OutlineAssetRetentionCoordinate | undefined {
  return state.assetRecordById.get(assetId) ?? state.degradedAssetRecordById.get(assetId);
}

function snapshotEnvelope(body: SnapshotBody): SnapshotEnvelope {
  return { ...body, checksum: canonicalSha256(body) };
}

function logHeader(snapshotChecksum: string, snapshotSequence: number): LogHeader {
  const body: LogHeaderBody = {
    kind: LOG_HEADER_KIND,
    storageVersion: OUTLINE_STORAGE_VERSION,
    snapshotChecksum,
    snapshotSequence,
  };
  return { ...body, checksum: canonicalSha256(body) };
}

function logRecord<T extends LogRecordBody>(body: T): T & { readonly checksum: string } {
  return { ...body, checksum: canonicalSha256(body) };
}

function jsonlRecordBytes(record: LogRecord): number {
  return Buffer.byteLength(`${JSON.stringify(record)}\n`);
}

function applyTransactionRecord(state: LoadedState, record: TransactionRecordBody & { checksum: string }, eventRetention: number) {
  const operation = clone(record.operation);
  for (const operationId of operationRevertTargetIds(operation)) {
    const reverted = state.operationById.get(operationId);
    if (!reverted) throw new Error(`Revert references a missing Operation: ${operationId}`);
    replaceOperation(state, {
      ...clone(reverted),
      recovery: { ...clone(reverted.recovery), state: 'reverted' },
    });
  }
  state.replay.push(decodePersistenceCapture(record.persistence));
  state.operations.push(operation);
  state.operationById.set(operation.operationId, operation);
  state.recoveryByOperationId.set(operation.operationId, clone(record.recovery));
  if (record.idempotency) state.idempotencyByKey.set(record.idempotency.key, clone(record.idempotency));
  for (const leaseId of record.assetDelta.consumedLeaseIds) state.assetLeaseById.delete(leaseId);
  for (const assetId of record.assetDelta.liveAddedAssetRecordIds) state.liveAssetRecordIds.add(assetId);
  for (const assetId of record.assetDelta.liveRemovedAssetRecordIds) state.liveAssetRecordIds.delete(assetId);
  state.events.push(clone(record.event));
  if (state.events.length > eventRetention) state.events.splice(0, state.events.length - eventRetention);
  state.latestSequence = record.sequence;
  state.latestEventSequence = Math.max(state.latestEventSequence, record.event.sequence);
  state.headChecksum = record.checksum;
}

function stageLoadedState(state: LoadedState): LoadedState {
  return {
    ...state,
    replay: [...state.replay],
    operations: [...state.operations],
    operationById: new Map(state.operationById),
    recoveryByOperationId: new Map(state.recoveryByOperationId),
    idempotencyByKey: new Map(state.idempotencyByKey),
    events: [...state.events],
    assetRecordById: new Map(state.assetRecordById),
    degradedAssetRecordById: new Map(state.degradedAssetRecordById),
    assetLeaseById: new Map(state.assetLeaseById),
    liveAssetRecordIds: new Set(state.liveAssetRecordIds),
    orphanRecoveryBlobs: [...state.orphanRecoveryBlobs],
  };
}

function applyAssetStageRecord(state: LoadedState, record: AssetStageRecordBody & { checksum: string }): void {
  try {
    assertOutlineAssetStage(record.stage);
    const { lease: _lease, ...stored } = record.stage;
    state.assetRecordById.set(record.stage.record.assetId, clone(stored));
    state.assetLeaseById.set(record.stage.lease.leaseId, clone(record.stage.lease));
  } catch {
    const { lease: _lease, ...stored } = record.stage;
    state.degradedAssetRecordById.set(record.stage.record.assetId, clone(stored));
  }
  state.latestSequence = record.sequence;
  state.headChecksum = record.checksum;
}

function applyAssetGcRecord(state: LoadedState, record: AssetGcRecordBody & { checksum: string }): void {
  const removed = new Set(record.assetIds);
  for (const assetId of removed) {
    state.assetRecordById.delete(assetId);
    state.degradedAssetRecordById.delete(assetId);
    state.liveAssetRecordIds.delete(assetId);
  }
  for (const [leaseId, lease] of state.assetLeaseById) {
    if (removed.has(lease.assetId)) state.assetLeaseById.delete(leaseId);
  }
  state.latestSequence = record.sequence;
  state.headChecksum = record.checksum;
}

function classifySnapshotAssetRecords(records: readonly OutlineAssetRetentionCoordinate[]): {
  readonly valid: Map<string, OutlineStoredAssetRecord>;
  readonly degraded: Map<string, OutlineAssetRetentionCoordinate>;
} {
  const valid = new Map<string, OutlineStoredAssetRecord>();
  const degraded = new Map<string, OutlineAssetRetentionCoordinate>();
  for (const candidate of records) {
    const stored = clone(candidate);
    try {
      assertOutlineStoredAssetRecord(stored);
      valid.set(stored.record.assetId, stored);
    } catch {
      degraded.set(stored.record.assetId, stored);
    }
  }
  return { valid, degraded };
}

function assertAssetRecordAvailable(state: LoadedState, assetId: string): void {
  if (!state.degradedAssetRecordById.has(assetId)) return;
  throw new OutlineContractError(outlineError(
    'recovery_inconsistent',
    'durability',
    `Outline AssetRecord metadata is invalid: ${assetId}`,
  ));
}

function replaceOperation(state: LoadedState, operation: Operation): void {
  const index = state.operations.findIndex((entry) => entry.operationId === operation.operationId);
  if (index < 0) throw new Error(`Operation index is missing: ${operation.operationId}`);
  state.operations[index] = operation;
  state.operationById.set(operation.operationId, operation);
}

function applyRecoveryExpiryRecord(
  state: LoadedState,
  record: RecoveryExpiryRecordBody & { checksum: string },
  eventRetention: number,
) {
  for (const operationId of record.operationIds) {
    const operation = state.operationById.get(operationId);
    if (!operation) throw new Error(`Recovery expiry references a missing Operation: ${operationId}`);
    const replacement = clone(operation);
    replacement.recovery.state = 'expired';
    replaceOperation(state, replacement);
  }
  state.events.push(clone(record.event));
  if (state.events.length > eventRetention) state.events.splice(0, state.events.length - eventRetention);
  state.latestSequence = record.sequence;
  state.latestEventSequence = Math.max(state.latestEventSequence, record.event.sequence);
  state.headChecksum = record.checksum;
}

function encodePersistenceCapture(capture: CorePersistenceCapture): EncodedPersistenceCapture {
  return {
    persistenceRevision: capture.persistenceRevision,
    metadataSequence: capture.metadataSequence,
    update: Buffer.from(capture.update).toString('base64'),
    version: Buffer.from(capture.version).toString('base64'),
    local: clone(capture.local),
  };
}

function decodePersistenceCapture(capture: EncodedPersistenceCapture): WorkspacePersistenceReplayEntry {
  return {
    persistenceRevision: capture.persistenceRevision,
    metadataSequence: capture.metadataSequence,
    update: new Uint8Array(Buffer.from(capture.update, 'base64')),
    version: new Uint8Array(Buffer.from(capture.version, 'base64')),
    local: clone(capture.local),
  };
}

function cloneReplayEntry(entry: WorkspacePersistenceReplayEntry): WorkspacePersistenceReplayEntry {
  return {
    persistenceRevision: entry.persistenceRevision,
    metadataSequence: entry.metadataSequence,
    update: entry.update.slice(),
    version: entry.version.slice(),
    local: clone(entry.local),
  };
}

function assertSnapshotEnvelope(value: unknown): asserts value is SnapshotEnvelope {
  if (!isRecord(value)
    || value.kind !== SNAPSHOT_KIND
    || value.storageVersion !== OUTLINE_STORAGE_VERSION
    || !Number.isSafeInteger(value.sequence)
    || !Number.isSafeInteger(value.latestEventSequence)
    || typeof value.createdAt !== 'string'
    || !Array.isArray(value.operations)
    || !isRecord(value.recovery)
    || !Array.isArray(value.idempotency)
    || !Array.isArray(value.events)
    || !Array.isArray(value.assetRecords)
    || !Array.isArray(value.assetLeases)
    || !isStringArray(value.liveAssetRecordIds)
    || typeof value.checksum !== 'string') {
    throw new Error('Invalid outline workspace snapshot');
  }
  const { checksum, ...body } = value;
  if (checksum !== canonicalSha256(body)) throw new Error('Outline workspace snapshot checksum mismatch');
  Core.deserializeState(JSON.stringify(value.document));
  if (!value.operations.every((operation) => Value.Check(OperationSchema, operation))
    || !value.events.every((event) => Value.Check(EventSchema, event))
    || !value.idempotency.every(isIdempotencyRecord)
    || !value.assetRecords.every((record) => {
      try {
        assertOutlineAssetRetentionCoordinate(record);
        return true;
      } catch {
        return false;
      }
    })
    || !value.assetLeases.every((lease) => Value.Check(AssetLeaseSchema, lease))) {
    throw new Error('Outline workspace snapshot indexes are invalid');
  }
  for (const reference of Object.values(value.recovery)) assertRecoveryReferenceShape(reference);
  const operations = new Map<string, Operation>();
  for (const operation of value.operations) {
    if (operations.has(operation.operationId)) throw new Error(`Duplicate snapshot Operation: ${operation.operationId}`);
    operations.set(operation.operationId, operation);
    const recovery = value.recovery[operation.operationId];
    if (operation.recovery.state !== 'expired'
      && (!recovery || recovery.recoveryPatchId !== operation.recovery.recoveryPatchId)) {
      throw new Error(`Snapshot Operation recovery index mismatch: ${operation.operationId}`);
    }
  }
  for (const entry of value.idempotency) {
    const operation = operations.get(entry.operationId);
    if (!operation) {
      throw new Error(`Snapshot idempotency index references a missing Operation: ${entry.operationId}`);
    }
    assertAcceptedIdempotencyMatchesOperation(entry, operation);
  }
  const assetIds = new Set<string>();
  const assetAnchorIds = new Set<string>();
  for (const stored of value.assetRecords) {
    if (assetIds.has(stored.record.assetId)) throw new Error(`Duplicate snapshot AssetRecord: ${stored.record.assetId}`);
    if (assetAnchorIds.has(stored.exactRevision.anchorId)) {
      throw new Error(`Duplicate snapshot asset anchor: ${stored.exactRevision.anchorId}`);
    }
    assetIds.add(stored.record.assetId);
    assetAnchorIds.add(stored.exactRevision.anchorId);
  }
  const leaseIds = new Set<string>();
  for (const lease of value.assetLeases) {
    if (leaseIds.has(lease.leaseId) || !assetIds.has(lease.assetId)) {
      throw new Error(`Duplicate or dangling snapshot AssetLease: ${lease.leaseId}`);
    }
    leaseIds.add(lease.leaseId);
  }
  if (value.liveAssetRecordIds.some((assetId) => !assetIds.has(assetId))) {
    throw new Error('Snapshot live asset index references a missing AssetRecord');
  }
  let priorEventSequence = -1;
  for (const event of value.events) {
    if (event.sequence <= priorEventSequence || event.sequence > value.latestEventSequence) {
      throw new Error('Snapshot Event sequence is not strictly increasing');
    }
    priorEventSequence = event.sequence;
  }
}

function assertLogHeader(value: unknown): asserts value is LogHeader {
  if (!isRecord(value)
    || value.kind !== LOG_HEADER_KIND
    || value.storageVersion !== OUTLINE_STORAGE_VERSION
    || typeof value.snapshotChecksum !== 'string'
    || !Number.isSafeInteger(value.snapshotSequence)
    || typeof value.checksum !== 'string') {
    throw new Error('Invalid outline transaction log header');
  }
  const { checksum, ...body } = value;
  if (checksum !== canonicalSha256(body)) throw new Error('Outline transaction log header checksum mismatch');
}

function assertLogRecord(value: unknown, sequence: number, previousChecksum: string): asserts value is LogRecord {
  if (!isRecord(value)
    || ![TRANSACTION_KIND, RECOVERY_EXPIRY_KIND, ASSET_STAGE_KIND, ASSET_GC_KIND].includes(value.kind as string)
    || value.storageVersion !== OUTLINE_STORAGE_VERSION
    || value.sequence !== sequence
    || value.previousChecksum !== previousChecksum
    || typeof value.checksum !== 'string') {
    throw new Error('Invalid outline transaction log record ordering');
  }
  const { checksum, ...body } = value;
  if (checksum !== canonicalSha256(body)) throw new Error('Outline transaction log record checksum mismatch');
  if (value.kind === TRANSACTION_KIND) {
    if (!isRecord(value.persistence)
      || !isRecord(value.operation)
      || !isRecord(value.recovery)
      || !isRecord(value.event)
      || !isRecord(value.assetDelta)) {
      throw new Error('Invalid outline transaction record');
    }
    assertEncodedPersistenceCapture(value.persistence);
    assertRecoveryReferenceShape(value.recovery);
    assertAssetDelta(value.assetDelta);
    if (!Value.Check(OperationSchema, value.operation) || !Value.Check(EventSchema, value.event)) {
      throw new Error('Outline transaction public records do not match their schemas');
    }
    if (value.idempotency !== undefined && !isIdempotencyRecord(value.idempotency)) {
      throw new Error('Invalid outline transaction idempotency record');
    }
  } else if (value.kind === RECOVERY_EXPIRY_KIND && (!Array.isArray(value.operationIds)
    || !Array.isArray(value.recoveryPatchIds)
    || !value.operationIds.every((entry) => typeof entry === 'string')
    || !value.recoveryPatchIds.every((entry) => typeof entry === 'string')
    || value.operationIds.length !== value.recoveryPatchIds.length
    || !Value.Check(EventSchema, value.event)
    || value.event.type !== 'operation.recovery-expired')) {
    throw new Error('Invalid outline recovery expiry record');
  } else if (value.kind === ASSET_STAGE_KIND) {
    assertOutlineAssetStageCoordinate(value.stage);
  } else if (value.kind === ASSET_GC_KIND && (!isStringArray(value.assetIds) || new Set(value.assetIds).size !== value.assetIds.length)) {
    throw new Error('Invalid outline asset GC record');
  }
}

function assertReplayedRecord(record: LogRecord, state: LoadedState): void {
  if (record.kind === ASSET_STAGE_KIND) {
    if (state.assetRecordById.has(record.stage.record.assetId)
      || state.degradedAssetRecordById.has(record.stage.record.assetId)
      || state.assetLeaseById.has(record.stage.lease.leaseId)
      || [...state.assetRecordById.values(), ...state.degradedAssetRecordById.values()]
        .some((stored) => stored.exactRevision.anchorId === record.stage.exactRevision.anchorId)) {
      throw new Error(`Duplicate committed outline asset stage: ${record.stage.lease.leaseId}`);
    }
    return;
  }
  if (record.kind === ASSET_GC_KIND) {
    for (const assetId of record.assetIds) {
      if (!state.assetRecordById.has(assetId) && !state.degradedAssetRecordById.has(assetId)) {
        throw new Error(`Asset GC references a missing AssetRecord: ${assetId}`);
      }
    }
    return;
  }
  if (record.event.sequence !== state.latestEventSequence + 1) {
    throw new Error('Committed outline Event sequence is not monotonic');
  }
  if (record.kind === RECOVERY_EXPIRY_KIND) {
    const currentRevision = state.operations.at(-1)?.revisionAfter ?? state.events.at(-1)?.revision ?? 0;
    if (record.event.revision !== currentRevision) {
      throw new Error('Recovery expiry Event does not use the current document revision');
    }
    for (let index = 0; index < record.operationIds.length; index += 1) {
      const operation = state.operationById.get(record.operationIds[index]!);
      if (!operation || operation.recovery.recoveryPatchId !== record.recoveryPatchIds[index]) {
        throw new Error(`Recovery expiry references inconsistent Operation data: ${record.operationIds[index]}`);
      }
    }
    return;
  }
  if (state.operationById.has(record.operation.operationId)) {
    throw new Error(`Duplicate committed outline Operation: ${record.operation.operationId}`);
  }
  for (const operationId of operationRevertTargetIds(record.operation)) {
    if (!state.operationById.has(operationId)) {
      throw new Error(`Committed revert references a missing Operation: ${operationId}`);
    }
  }
  if (record.operation.recovery.recoveryPatchId !== record.recovery.recoveryPatchId) {
    throw new Error(`Committed Operation recovery identity mismatch: ${record.operation.operationId}`);
  }
  if (record.event.operation?.operationId !== record.operation.operationId
    || record.event.revision !== record.operation.revisionAfter) {
    throw new Error(`Committed Event does not match Operation: ${record.operation.operationId}`);
  }
  const currentRevision = state.operations.at(-1)?.revisionAfter ?? state.events.at(-1)?.revision ?? 0;
  if (record.operation.revisionBefore !== currentRevision
    || record.operation.revisionAfter <= record.operation.revisionBefore) {
    throw new Error(`Committed document revision is not monotonic: ${record.operation.operationId}`);
  }
  if (record.idempotency) {
    if (record.idempotency.operationId !== record.operation.operationId
      || state.idempotencyByKey.has(record.idempotency.key)) {
      throw new Error(`Duplicate or inconsistent idempotency record: ${record.idempotency.key}`);
    }
    assertAcceptedIdempotencyMatchesOperation(record.idempotency, record.operation);
  }
  const previousPersistenceRevision = state.replay.at(-1)?.persistenceRevision
    ?? state.snapshot.document.persistenceRevision;
  const previousMetadataSequence = state.replay.at(-1)?.metadataSequence
    ?? state.snapshot.document.persistenceMetadataSequence;
  if (record.persistence.persistenceRevision <= previousPersistenceRevision
    || record.persistence.metadataSequence < previousMetadataSequence) {
    throw new Error(`Committed persistence ordering is not monotonic: ${record.operation.operationId}`);
  }
}

function assertTransactionInput(input: WorkspaceTransactionInput): void {
  assertOutlineRecoveryPatch(input.recoveryPatch);
  const operationValid = Value.Check(OperationSchema, input.operation);
  const eventValid = Value.Check(EventSchema, input.event);
  if (!operationValid || !eventValid) {
    const [error] = operationValid
      ? Value.Errors(EventSchema, input.event)
      : Value.Errors(OperationSchema, input.operation);
    const record = operationValid ? 'Event' : 'Operation';
    throw new Error(`Outline transaction ${record} does not match its schema at ${error?.instancePath || '/'}: ${error?.message ?? 'invalid value'}`);
  }
  assertAssetDelta(input.assetDelta ?? EMPTY_ASSET_DELTA);
  if (input.operation.operationId !== input.recoveryPatch.operationId
    || input.operation.operationId !== input.event.operation?.operationId
    || input.operation.changeSetHash !== input.recoveryPatch.changeSetHash
    || input.operation.diffHash !== input.recoveryPatch.diffHash
    || input.operation.revisionBefore !== input.recoveryPatch.revisionBefore
    || input.operation.revisionAfter !== input.recoveryPatch.revisionAfter
    || input.event.revision !== input.operation.revisionAfter) {
    throw new Error('Outline transaction components do not describe one Operation');
  }
  if (input.operation.revertsOperationId
    && input.operation.revertsOperationIds
    && !input.operation.revertsOperationIds.includes(input.operation.revertsOperationId)) {
    throw new Error('Outline transaction plural revert targets must include the primary revert target');
  }
  const expectedEventType = operationRevertsAny(input.operation)
    ? 'operation.reverted'
    : 'operation.committed';
  if (input.event.type !== expectedEventType) {
    throw new Error(`Outline transaction Event type must be ${expectedEventType}`);
  }
  if (input.idempotency && input.idempotency.operationId !== input.operation.operationId) {
    throw new Error('Outline idempotency record references a different Operation');
  }
  if (input.idempotency && !isIdempotencyRecord(input.idempotency)) {
    throw new Error('Invalid outline transaction idempotency record');
  }
  if (input.idempotency) assertAcceptedIdempotencyMatchesOperation(input.idempotency, input.operation);
}

function operationRevertsAny(operation: Operation): boolean {
  return operationRevertTargetIds(operation).length > 0;
}

function operationRevertTargetIds(operation: Operation): readonly string[] {
  if (operation.revertsOperationIds && operation.revertsOperationIds.length > 0) return operation.revertsOperationIds;
  return operation.revertsOperationId ? [operation.revertsOperationId] : [];
}

function assertEventSequence(event: OutlineEvent, state: LoadedState): void {
  if (event.sequence !== state.latestEventSequence + 1) {
    throw new Error('Outline Event sequence is not monotonic');
  }
}

function assertEncodedPersistenceCapture(value: Record<string, any>): asserts value is EncodedPersistenceCapture {
  if (!Number.isSafeInteger(value.persistenceRevision)
    || value.persistenceRevision < 0
    || !Number.isSafeInteger(value.metadataSequence)
    || value.metadataSequence < 0
    || !isCanonicalBase64(value.update)
    || !isCanonicalBase64(value.version)
    || !isRecord(value.local)
    || typeof value.local.installationId !== 'string'
    || typeof value.local.replicaId !== 'string'
    || !Array.isArray(value.local.operationHistoryUpserts)
    || !value.local.operationHistoryUpserts.every(isOperationHistoryEntry)
    || !Array.isArray(value.local.operationHistoryDeletes)
    || !value.local.operationHistoryDeletes.every((entry: unknown) => typeof entry === 'string')
    || (value.local.loroPendingUpdates !== undefined
      && (!Array.isArray(value.local.loroPendingUpdates)
        || !value.local.loroPendingUpdates.every((entry: unknown) => isCanonicalBase64(entry))))) {
    throw new Error('Invalid encoded Core persistence capture');
  }
}

function assertRecoveryReferenceShape(value: unknown): asserts value is RecoveryReference {
  if (!isRecord(value)
    || typeof value.recoveryPatchId !== 'string'
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.byteSize)
    || value.byteSize < 0
    || (value.storage !== 'inline' && value.storage !== 'blob')
    || !isStringArray(value.protectedAssetRecordIds)) {
    throw new Error('Invalid outline recovery reference');
  }
  if (value.storage === 'inline') {
    assertOutlineRecoveryPatch(value.inline);
  } else if (value.inline !== undefined) {
    throw new Error('Blob recovery reference contains inline data');
  }
}

function assertAssetDelta(value: unknown): asserts value is OutlineAssetDelta {
  if (!isRecord(value)
    || !isStringArray(value.consumedLeaseIds)
    || !isStringArray(value.liveAddedAssetRecordIds)
    || !isStringArray(value.liveRemovedAssetRecordIds)) {
    throw new Error('Invalid outline asset delta');
  }
}

function assertAssetDeltaAdmission(delta: OutlineAssetDelta, state: LoadedState, now: Date): void {
  const consumed = new Set(delta.consumedLeaseIds);
  const added = new Set(delta.liveAddedAssetRecordIds);
  const removed = new Set(delta.liveRemovedAssetRecordIds);
  if (consumed.size !== delta.consumedLeaseIds.length
    || added.size !== delta.liveAddedAssetRecordIds.length
    || removed.size !== delta.liveRemovedAssetRecordIds.length
    || [...added].some((assetId) => removed.has(assetId))) {
    throw new Error('Outline asset delta contains duplicate or contradictory entries');
  }
  for (const leaseId of consumed) {
    const lease = state.assetLeaseById.get(leaseId);
    if (!lease || Date.parse(lease.expiresAt) <= now.getTime()) {
      throw new OutlineContractError(outlineError(
        'precondition_failed',
        'conflict',
        `Asset lease is unavailable, expired, or already consumed: ${leaseId}`,
      ));
    }
  }
  for (const assetId of [...added, ...removed]) {
    if (!state.assetRecordById.has(assetId)) {
      throw new OutlineContractError(outlineError(
        'precondition_failed',
        'conflict',
        `AssetRecord is unavailable: ${assetId}`,
      ));
    }
  }
  if ([...added].some((assetId) => state.liveAssetRecordIds.has(assetId))
    || [...removed].some((assetId) => !state.liveAssetRecordIds.has(assetId))) {
    throw new Error('Outline asset delta does not match the committed live asset index');
  }
}

function isIdempotencyRecord(value: unknown): value is OutlineIdempotencyRecord {
  return isRecord(value)
    && typeof value.key === 'string'
    && value.key.length > 0
    && typeof value.payloadHash === 'string'
    && /^[a-f0-9]{64}$/.test(value.payloadHash)
    && typeof value.operationId === 'string'
    && (value.accepted === undefined
      || (isRecord(value.accepted)
        && Value.Check(AcceptedDesktopChangeSetMutationSchema.properties.update, value.accepted.update)
        && Value.Check(AcceptedDesktopChangeSetMutationSchema.properties.diff, value.accepted.diff)));
}

function assertAcceptedIdempotencyMatchesOperation(
  idempotency: OutlineIdempotencyRecord,
  operation: Operation,
): void {
  const accepted = idempotency.accepted;
  if (!accepted) return;
  if (accepted.update.revision !== operation.revisionAfter
    || accepted.diff.changeSetHash !== operation.changeSetHash
    || accepted.diff.normalizedChangeSet.idempotencyKey !== idempotency.key) {
    throw new Error(`Accepted idempotency receipt does not match Operation: ${operation.operationId}`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function appendJsonlDurable(
  filePath: string,
  value: unknown,
  fsyncHandle: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  const handle = await open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await fsyncHandle(handle);
  } finally {
    await handle.close();
  }
}

async function appendJsonlBatchDurable(
  filePath: string,
  values: readonly unknown[],
  fsyncHandle: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  const handle = await open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(values.map((value) => `${JSON.stringify(value)}\n`).join(''), 'utf8');
    await fsyncHandle(handle);
  } finally {
    await handle.close();
  }
}

async function writeJsonDurable(
  filePath: string,
  value: unknown,
  fsyncHandle: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  await writeTextDurable(filePath, JSON.stringify(value), fsyncHandle);
}

async function writeJsonlDurable(
  filePath: string,
  value: string,
  fsyncHandle: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  await writeTextDurable(filePath, value, fsyncHandle);
}

async function writeTextDurable(
  filePath: string,
  value: string,
  fsyncHandle: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await fsyncHandle(handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath), fsyncHandle);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function syncDirectory(directory: string, fsyncHandle: (handle: FileHandle) => Promise<void>): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await fsyncHandle(handle);
  } finally {
    await handle.close();
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uncertainDurabilityError(error: unknown): OutlineContractError {
  return new OutlineContractError(outlineError(
    'durability_failed',
    'durability',
    'The transaction log could not confirm durable settlement.',
    { retryable: true, details: errorMessage(error) },
  ));
}

function asError(error: unknown, prefix: string): Error {
  return new Error(`${prefix}: ${errorMessage(error)}`);
}
