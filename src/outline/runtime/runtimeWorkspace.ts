import {
  Core,
  type CoreTransactionMetadata,
  type CoreTransactionPatch,
} from '../../core/core';
import { runTransientSearchExpr } from '../../core/searchEngine';
import type { NodeAccessStats } from '../../core/nodeAccessRanking';
import { ContentStore, type ContentStoreOptions } from '../../content';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';
import type { Diff, Operation, OutlineEvent, RevertConflictDiff, NoChangeResult } from '../contract/schemas';
import {
  SOURCE_FIELD_ID,
  type DocumentState,
  type Node,
  type ProjectionUpdate,
  type SearchHit,
} from '../../core/types';
import { projectNode } from '../../core/projection';
import { OUTLINE_PROTOCOL_VERSION } from '../contract/version';
import {
  createOutlineRecoveryPatch,
  recoveryPatchToCorePatch,
  WorkspaceTransactionLog,
  OutlineAssetStore,
  type OutlineAssetStoreOptions,
  type OutlineAssetDelta,
  type WorkspaceMutationAdmission,
  type WorkspaceTransactionInput,
  type WorkspaceTransactionAppendResult,
  type WorkspaceTransactionLogOptions,
} from './storage';
import { semanticPatchDigest } from './semanticDigest';
import { encodeEventCursor } from './eventCursor';
import { encodeOperationLogCursor } from './operationLogCursor';
import { DocumentReadModel } from './documentReadModel';
import type { Projection, ProjectionResult } from '../contract/schemas';
import { createSelectionIndex } from './selector';
import { projectOutlineFromSelectionIndex } from './projection';
import { assertProtectedMemoryDefinitionPatch } from './protectedDefinitions';
import { parseAssetSourceUri } from '../../core/source';

const MAX_AFFECTED_NODE_ID_SAMPLE = 1_000;
const DURABILITY_IDLE_DELAY_MS = 700;
const DURABILITY_MAX_WAIT_MS = 5_000;

interface AppendedMutationSettlement {
  readonly kind: 'appended';
  readonly appended: WorkspaceTransactionAppendResult;
  readonly projectionUpdate: ProjectionUpdate;
  readonly assetReferenceCounts: Map<string, number>;
}

interface NoChangeMutationSettlement {
  readonly kind: 'no-change';
  readonly result: NoChangeResult;
  readonly patch: CoreTransactionPatch;
}

type MutationSettlement = AppendedMutationSettlement | NoChangeMutationSettlement | DeferredMutationSettlement;

type DeferredTransactionInput = Omit<WorkspaceTransactionInput, 'event'>;

interface DeferredMutationSettlement {
  readonly kind: 'deferred';
  readonly input: DeferredTransactionInput;
  readonly projectionUpdate: ProjectionUpdate;
  readonly assetReferenceCounts: Map<string, number>;
  readonly patch: CoreTransactionPatch;
}

interface PendingDurability {
  readonly input: DeferredTransactionInput;
  readonly projectionUpdate: ProjectionUpdate;
}

export interface OutlineAcceptedMutation {
  readonly settlement: Operation | NoChangeResult;
  readonly update: ProjectionUpdate;
  readonly patch?: CoreTransactionPatch;
  readonly diff?: Diff;
}

export interface OutlineDurabilityStatus {
  readonly acceptedRevision: number;
  readonly durableRevision: number;
  readonly admissionFrozen: boolean;
  readonly failure?: { readonly message: string };
}

class ExistingOperationSettlement extends Error {
  constructor(readonly operation: Operation) {
    super(`Operation settled idempotently: ${operation.operationId}`);
  }
}

export interface OutlineRuntimeMutationRequest {
  readonly origin: Operation['origin'];
  readonly causation?: Operation['causation'];
  readonly source?: Operation['source'];
  readonly changeSetHash: string;
  readonly diffHash: string;
  readonly expectedPatchHash?: string;
  readonly summary: string;
  readonly idempotencyKey?: string;
  readonly idempotencyPayloadHash?: string;
  readonly undoGroup?: Operation['undoGroup'];
  readonly revertsOperationId?: string;
  readonly revertsOperationIds?: readonly string[];
  readonly protectedAssetRecordIds?: readonly string[];
  readonly assetLeases?: Readonly<Record<string, string>>;
  readonly idFactory?: (prefix: string) => string;
  readonly execute: (candidate: Core) => void | Operation['result'] | Promise<void | Operation['result']>;
  readonly result?: (candidate: Core) => Operation['result'];
  readonly noChangeResult?: (candidate: Core) => NoChangeResult;
  readonly acceptedDiff?: (patch: CoreTransactionPatch) => Diff;
}

export interface OutlineHistoryMutationOptions extends Pick<
  OutlineRuntimeMutationRequest,
  'origin' | 'causation' | 'idempotencyKey' | 'idempotencyPayloadHash'
> {
  readonly selectionOrigin?: Operation['origin'] | 'all';
  readonly expectOperationId?: string;
}

export interface OutlineRuntimeWorkspaceOptions {
  readonly store?: WorkspaceTransactionLog;
  readonly storeOptions?: WorkspaceTransactionLogOptions;
  readonly initialCore?: Core;
  readonly instanceId?: string;
  readonly now?: () => Date;
  readonly contentRoot?: string;
  readonly contentStore?: ContentStore;
  readonly contentStoreOptions?: ContentStoreOptions;
  readonly assetStoreOptions?: OutlineAssetStoreOptions;
  readonly durabilityIdleDelayMs?: number;
  readonly durabilityMaxWaitMs?: number;
  readonly durabilitySchedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly durabilityCancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class OutlineRuntimeWorkspace {
  private mutationChain: Promise<unknown> = Promise.resolve();
  private settlementUnknown = false;
  private settlementUnknownIdempotencyKey?: string;
  private eventListeners = new Set<(event: OutlineEvent) => void>();
  private readonly now: () => Date;
  private readonly readModel: DocumentReadModel;
  private assetReferenceCounts: Map<string, number>;
  private pendingPublicationPatch?: CoreTransactionPatch;
  private readonly pendingDurability: PendingDurability[] = [];
  private readonly acceptedByIdempotencyKey = new Map<string, {
    readonly payloadHash: string;
    readonly result?: OutlineAcceptedMutation;
  }>();
  private durabilityRun?: Promise<void>;
  private durabilityFailure?: unknown;
  private durableRevisionValue: number;
  private readonly durabilityIdleDelayMs: number;
  private readonly durabilityMaxWaitMs: number;
  private readonly durabilitySchedule: NonNullable<OutlineRuntimeWorkspaceOptions['durabilitySchedule']>;
  private readonly durabilityCancel: NonNullable<OutlineRuntimeWorkspaceOptions['durabilityCancel']>;
  private durabilityIdleTimer?: ReturnType<typeof setTimeout>;
  private durabilityMaxWaitTimer?: ReturnType<typeof setTimeout>;
  private firstDirtyAt?: number;
  private lastDirtyAt?: number;
  private mutationAdmissionFrozen = false;
  private mutationAdmissionCommitted = false;
  private personalAccessRanking = new Map<string, NodeAccessStats>();

  private constructor(
    private core: Core,
    readonly store: WorkspaceTransactionLog,
    readonly assets: OutlineAssetStore,
    readonly instanceId: string,
    readonly eventBaselineSequence: number,
    now?: () => Date,
    durabilityOptions: Pick<
      OutlineRuntimeWorkspaceOptions,
      'durabilityIdleDelayMs' | 'durabilityMaxWaitMs' | 'durabilitySchedule' | 'durabilityCancel'
    > = {},
  ) {
    this.now = now ?? (() => new Date());
    this.core.setSearchAssetMetadataProvider(() => this.assets.metadataSnapshot());
    this.durabilityIdleDelayMs = Math.max(0, durabilityOptions.durabilityIdleDelayMs ?? DURABILITY_IDLE_DELAY_MS);
    this.durabilityMaxWaitMs = Math.max(
      this.durabilityIdleDelayMs,
      durabilityOptions.durabilityMaxWaitMs ?? DURABILITY_MAX_WAIT_MS,
    );
    this.durabilitySchedule = durabilityOptions.durabilitySchedule ?? ((callback, delayMs) => (
      setTimeout(callback, delayMs)
    ));
    this.durabilityCancel = durabilityOptions.durabilityCancel ?? ((timer) => clearTimeout(timer));
    this.readModel = DocumentReadModel.fromProjection(core.revision(), core.projection());
    this.assetReferenceCounts = countAssetReferences(core.state());
    this.durableRevisionValue = core.revision();
  }

  static async open(root: string, options: OutlineRuntimeWorkspaceOptions = {}): Promise<OutlineRuntimeWorkspace> {
    const instanceId = options.instanceId ?? `runtime:${crypto.randomUUID()}`;
    const store = options.store ?? new WorkspaceTransactionLog(root, {
      ...options.storeOptions,
      ...(options.now ? { now: options.now } : {}),
    });
    let loaded = await store.load();
    if (!loaded.snapshot) {
      const initialCore = options.initialCore ?? Core.new();
      await store.initialize(initialCore.serializeState());
      loaded = await store.load();
    }
    if (!loaded.snapshot) throw new Error('Outline Runtime workspace initialization did not produce a snapshot');
    const revision = loaded.events.at(-1)?.revision
      ?? loaded.operations.at(-1)?.revisionAfter
      ?? 0;
    const core = loaded.replay.length > 0
      ? Core.fromPersistenceState(loaded.snapshot, loaded.replay, {
          installationId: loaded.snapshot.local.installationId,
          revision,
        })
      : Core.fromState(loaded.snapshot, {
          installationId: loaded.snapshot.local.installationId,
          revision,
        });
    if (core.requiresInitialPersist()) {
      // Core reconciliation may create durable system state, such as today's
      // Daily Note. Make that state the verified baseline before a transaction
      // can capture an update that causally depends on it.
      await store.compact(core.serializeState(), { instanceId, revision: core.revision() });
    }
    const contentStore = options.contentStore
      ?? (options.contentRoot ? await ContentStore.open(options.contentRoot, options.contentStoreOptions) : undefined);
    if (!contentStore) {
      throw new Error('Outline Runtime requires an explicit ContentStore root.');
    }
    const assets = new OutlineAssetStore(contentStore, store, {
      ...options.assetStoreOptions,
      ...(options.now ? { now: options.now } : {}),
    });
    try {
      await assets.reconcileAnchors();
      const workspace = new OutlineRuntimeWorkspace(
        core,
        store,
        assets,
        instanceId,
        loaded.latestEventSequence,
        options.now,
        options,
      );
      for (const idempotency of loaded.idempotency) {
        workspace.acceptedByIdempotencyKey.set(idempotency.key, {
          payloadHash: idempotency.payloadHash,
        });
      }
      return workspace;
    } catch (error) {
      if (!options.contentStore) contentStore.close();
      throw error;
    }
  }

  revision(): number {
    return this.readModel.revision;
  }

  durableRevision(): number {
    return this.durableRevisionValue;
  }

  async freezeMutationAdmission(): Promise<number> {
    return this.enqueueMutation(async () => {
      this.mutationAdmissionFrozen = true;
      return this.revision();
    });
  }

  unfreezeMutationAdmission(): void {
    if (!this.mutationAdmissionCommitted) this.mutationAdmissionFrozen = false;
  }

  commitMutationAdmissionFreeze(): void {
    this.mutationAdmissionFrozen = true;
    this.mutationAdmissionCommitted = true;
  }

  durabilityStatus(): OutlineDurabilityStatus {
    return {
      acceptedRevision: this.revision(),
      durableRevision: this.durableRevisionValue,
      admissionFrozen: this.mutationAdmissionFrozen,
      ...(this.durabilityFailure ? {
        failure: {
          message: this.durabilityFailure instanceof Error
            ? this.durabilityFailure.message
            : String(this.durabilityFailure),
        },
      } : {}),
    };
  }

  async drainDurability(targetRevision = this.revision()): Promise<void> {
    if (targetRevision > this.revision()) {
      throw new Error(`Cannot drain unaccepted Outline revision ${targetRevision}.`);
    }
    while (this.durableRevisionValue < targetRevision) {
      if (this.durabilityFailure) this.durabilityFailure = undefined;
      this.startDurabilityRun();
      const run = this.durabilityRun;
      if (!run) throw new Error(`Outline durability stopped before revision ${targetRevision}.`);
      await run;
      if (this.durabilityFailure) throw this.durabilityFailure;
    }
  }

  close(): void {
    this.clearDurabilityTimers();
    this.assets.close();
  }

  async status() {
    return {
      revision: this.revision(),
      ...await this.store.health((coordinates, excluding) => (
        this.assets.measureExactRevisionBytes(coordinates, excluding)
      )),
    };
  }

  projection() {
    return this.readModel.projection;
  }

  searchText(query: string, limit: number): SearchHit[] {
    const text = query.trim();
    if (!text) return [];
    const result = runTransientSearchExpr(
      this.readModel.projection,
      { kind: 'rule', op: 'STRING_MATCH', text },
      {
        limit,
        textIndex: this.readModel.textIndex,
        personalAccessRanking: {
          getNodeAccessStats: (nodeId) => this.personalAccessRanking.get(nodeId),
          now: this.now().getTime(),
        },
      },
    );
    return result.ok ? result.hits : [];
  }

  replacePersonalAccessRanking(entries: ReadonlyMap<string, NodeAccessStats>): void {
    this.personalAccessRanking = new Map(entries);
  }

  upsertPersonalAccessRanking(entries: ReadonlyMap<string, NodeAccessStats>): void {
    for (const [nodeId, stats] of entries) this.personalAccessRanking.set(nodeId, stats);
  }

  removePersonalAccessRanking(nodeIds: readonly string[]): void {
    for (const nodeId of nodeIds) this.personalAccessRanking.delete(nodeId);
  }

  selectionIndex() {
    return createSelectionIndex(this.readModel.projection, {
      nodesById: this.readModel.nodes,
      textIndex: this.readModel.textIndex,
      assetMetadataById: this.assets.metadataSnapshot(),
    });
  }

  project(
    projection: Projection,
    bindings: Readonly<Record<string, readonly string[]>> = {},
  ): ProjectionResult {
    return projectOutlineFromSelectionIndex(
      this.revision(),
      this.selectionIndex(),
      projection,
      bindings,
    );
  }

  documentState() {
    const state = this.core.state();
    const patch = this.pendingPublicationPatch;
    if (!patch) return state;
    for (const entry of patch.nodes) {
      if (entry.before) state.nodes[entry.id] = cloneNode(entry.before);
      else delete state.nodes[entry.id];
    }
    return state;
  }

  forkCore(options: { idFactory?: (prefix: string) => string } = {}): Core {
    return this.core.forkForRuntime(options);
  }

  subscribe(listener: (event: OutlineEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  collectAssetGarbage(): Promise<readonly string[]> {
    return this.enqueueMutation(async () => {
      await this.drainDurability();
      return this.assets.collectGarbage([...this.assetReferenceCounts.keys()]);
    });
  }

  async maintain(options: { readonly compactIfNeeded?: boolean } = {}): Promise<void> {
    let compaction: Promise<void> | undefined;
    await this.enqueueMutation(async () => {
      await this.drainDurability();
      const context = { instanceId: this.instanceId, revision: this.revision() };
      this.publishEvents(await this.store.maintain(context));
      await this.assets.collectGarbage([...this.assetReferenceCounts.keys()]);
      if (options.compactIfNeeded === true && await this.store.needsCompaction()) {
        const snapshot = this.core.serializeState();
        compaction = this.store.compact(snapshot, context).then((events) => {
          this.publishEvents(events);
        });
      }
    });
    if (compaction) await compaction;
  }

  async mutate(request: OutlineRuntimeMutationRequest): Promise<Operation> {
    return this.enqueueMutation(() => this.applyRequiredMutation(request));
  }

  async commit(request: OutlineRuntimeMutationRequest): Promise<Operation | NoChangeResult> {
    return this.enqueueMutation(() => this.applyMutation(request));
  }

  async commitPrepared(
    admissionRequest: Pick<OutlineRuntimeMutationRequest, 'idempotencyKey' | 'idempotencyPayloadHash'>,
    prepare: () => OutlineRuntimeMutationRequest | Promise<OutlineRuntimeMutationRequest>,
  ): Promise<Operation | NoChangeResult> {
    return this.enqueueMutation(async () => {
      this.assertMutationAdmission();
      const admission = await this.prepareMutation(admissionRequest);
      if (admission.existingOperation) return admission.existingOperation;
      return this.applyMutation(await prepare(), admission);
    });
  }

  async commitAcceptedPrepared(
    admissionRequest: Pick<OutlineRuntimeMutationRequest, 'idempotencyKey' | 'idempotencyPayloadHash'>,
    prepare: () => OutlineRuntimeMutationRequest | Promise<OutlineRuntimeMutationRequest>,
  ): Promise<OutlineAcceptedMutation> {
    return this.enqueueMutation(async () => {
      this.assertMutationAdmission();
      const idempotencyKey = admissionRequest.idempotencyKey;
      const payloadHash = admissionRequest.idempotencyPayloadHash;
      if (!idempotencyKey || !payloadHash) {
        throw new OutlineContractError(outlineError(
          'invalid_input',
          'usage',
          'Accepted desktop mutations require an idempotency key and payload hash.',
        ));
      }
      const existing = this.acceptedByIdempotencyKey.get(idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new OutlineContractError(outlineError(
            'idempotency_conflict',
            'conflict',
            `Idempotency key was already used with different input: ${idempotencyKey}`,
          ));
        }
        if (existing.result) return existing.result;
        const persisted = await this.store.idempotencySettlement(idempotencyKey, payloadHash);
        if (persisted?.accepted) {
          return {
            settlement: persisted.operation,
            update: persisted.accepted.update,
            diff: persisted.accepted.diff,
          };
        }
        throw new OutlineContractError(outlineError(
          'idempotency_conflict',
          'conflict',
          `Idempotency key is already bound to a non-desktop settlement: ${idempotencyKey}`,
        ));
      }
      const result = await this.applyAcceptedMutation(await prepare());
      this.acceptedByIdempotencyKey.set(idempotencyKey, {
        payloadHash,
        ...((result.settlement.kind === 'outline.no-change'
          || result.settlement.revisionAfter > this.durableRevisionValue) ? { result } : {}),
      });
      return result;
    });
  }

  async settledOperation(idempotencyKey: string, payloadHash: string): Promise<Operation | undefined> {
    return this.enqueueMutation(async () => {
      const admission = await this.store.prepareMutation(
        { key: idempotencyKey, payloadHash },
        { instanceId: this.instanceId, revision: this.revision() },
      );
      this.publishEvents(admission.maintenanceEvents);
      if (admission.existingOperation) {
        if (this.settlementUnknown) {
          if (this.settlementUnknownIdempotencyKey !== idempotencyKey) {
            throw new OutlineContractError(outlineError(
              'operation_settlement_unknown',
              'durability',
              'A different mutation may have committed; resolve it by its idempotency key or restart before writing again.',
              { retryable: true },
            ));
          }
          if (!admission.existingEvent) {
            throw new Error(`Committed idempotent Operation has no retained Event: ${admission.existingOperation.operationId}`);
          }
          await this.reloadDurableState(admission.existingOperation.revisionAfter);
          this.publishEvents([admission.existingEvent]);
        }
        this.settlementUnknown = false;
        this.settlementUnknownIdempotencyKey = undefined;
        return admission.existingOperation;
      }
      if (this.settlementUnknown) {
        throw new OutlineContractError(outlineError(
          'operation_settlement_unknown',
          'durability',
          'A prior mutation may have committed; resolve it by idempotency key or restart before writing again.',
          { retryable: true, details: { idempotencyKey } },
        ));
      }
      return undefined;
    });
  }

  async revert(
    operationId: string,
    options: Pick<OutlineRuntimeMutationRequest, 'origin' | 'causation' | 'idempotencyKey' | 'idempotencyPayloadHash'>,
  ): Promise<Operation> {
    return this.enqueueMutation(async () => {
      const admission = await this.prepareMutation(options);
      if (admission.existingOperation) return admission.existingOperation;
      const target = await this.store.operation(operationId);
      if (!target) {
        throw new OutlineContractError(outlineError('not_found', 'selection', `Operation not found: ${operationId}`));
      }
      const recovery = await this.store.recoveryPatch(operationId);
      const changeSetHash = canonicalSha256({ kind: 'outline.revert', operationId });
      const diffHash = canonicalSha256({
        kind: 'outline.revert-diff',
        operationId,
        afterStateHash: recovery.afterStateHash,
        beforeStateHash: recovery.beforeStateHash,
      });
      this.assertRecoveryPreconditions(operationId, recovery);
      return this.applyRequiredMutation({
        ...options,
        changeSetHash,
        diffHash,
        summary: `Reverted Operation ${operationId}.`,
        revertsOperationId: operationId,
        protectedAssetRecordIds: recovery.protectedAssetRecordIds,
        execute: (candidate) => {
          candidate.applyRecoveryPatch(recoveryPatchToCorePatch(recovery));
        },
      }, admission);
    });
  }

  async undo(
    options: OutlineHistoryMutationOptions,
  ): Promise<Operation> {
    return this.enqueueMutation(async () => {
      const admission = await this.prepareMutation(options);
      if (admission.existingOperation) return admission.existingOperation;
      const operations = await this.store.operations();
      const target = operationHistory(
        filterHistoryOperations(operations, options.selectionOrigin ?? options.origin),
      ).undo.at(-1);
      if (!target) {
        throw new OutlineContractError(outlineError('not_found', 'selection', 'No recoverable Operation is available to undo.'));
      }
      assertExpectedHistoryOperation('undo', target.stackOperationId, options.expectOperationId);
      return target.operationIds.length === 1
        ? this.revertInsideQueue(target.operationIds[0]!, options, admission)
        : this.revertGroupInsideQueue(target.operationIds, options, admission);
    });
  }

  async redo(
    options: OutlineHistoryMutationOptions,
  ): Promise<Operation> {
    return this.enqueueMutation(async () => {
      const admission = await this.prepareMutation(options);
      if (admission.existingOperation) return admission.existingOperation;
      const operations = await this.store.operations();
      const target = operationHistory(
        filterHistoryOperations(operations, options.selectionOrigin ?? options.origin),
      ).redo.at(-1);
      if (!target) {
        throw new OutlineContractError(outlineError('not_found', 'selection', 'No recoverable revert Operation is available to redo.'));
      }
      assertExpectedHistoryOperation('redo', target.stackOperationId, options.expectOperationId);
      return target.operationIds.length === 1
        ? this.revertInsideQueue(target.operationIds[0]!, options, admission)
        : this.revertGroupInsideQueue(target.operationIds, options, admission);
    });
  }

  private async revertInsideQueue(
    operationId: string,
    options: Pick<OutlineRuntimeMutationRequest, 'origin' | 'causation' | 'idempotencyKey' | 'idempotencyPayloadHash'>,
    admission: WorkspaceMutationAdmission,
  ): Promise<Operation> {
    const recovery = await this.store.recoveryPatch(operationId);
    this.assertRecoveryPreconditions(operationId, recovery);
    return this.applyRequiredMutation({
      ...options,
      changeSetHash: canonicalSha256({ kind: 'outline.revert', operationId }),
      diffHash: canonicalSha256({
        kind: 'outline.revert-diff',
        operationId,
        afterStateHash: recovery.afterStateHash,
        beforeStateHash: recovery.beforeStateHash,
      }),
      summary: `Reverted Operation ${operationId}.`,
      revertsOperationId: operationId,
      protectedAssetRecordIds: recovery.protectedAssetRecordIds,
      execute: (candidate) => {
        candidate.applyRecoveryPatch(recoveryPatchToCorePatch(recovery));
      },
    }, admission);
  }

  private async revertGroupInsideQueue(
    operationIds: readonly string[],
    options: Pick<OutlineRuntimeMutationRequest, 'origin' | 'causation' | 'idempotencyKey' | 'idempotencyPayloadHash'>,
    admission: WorkspaceMutationAdmission,
  ): Promise<Operation> {
    const orderedOperationIds = [...operationIds];
    const recoveries = await Promise.all(orderedOperationIds.map((operationId) => this.store.recoveryPatch(operationId)));
    const revertOrder = [...recoveries].reverse();
    const latestOperationId = orderedOperationIds.at(-1)!;
    const changeSetHash = canonicalSha256({ kind: 'outline.revert-group', operationIds: orderedOperationIds });
    const diffHash = canonicalSha256({
      kind: 'outline.revert-group-diff',
      operationIds: orderedOperationIds,
      recoveries: recoveries.map((recovery) => ({
        operationId: recovery.operationId,
        afterStateHash: recovery.afterStateHash,
        beforeStateHash: recovery.beforeStateHash,
      })),
    });
    return this.applyRequiredMutation({
      ...options,
      changeSetHash,
      diffHash,
      summary: `Reverted ${orderedOperationIds.length} grouped Operations ending at ${latestOperationId}.`,
      revertsOperationId: latestOperationId,
      revertsOperationIds: orderedOperationIds,
      protectedAssetRecordIds: recoveries.flatMap((recovery) => recovery.protectedAssetRecordIds),
      execute: (candidate) => {
        for (const recovery of revertOrder) {
          this.assertRecoveryPreconditionsOnCore(candidate, recovery.operationId, recovery);
          candidate.applyRecoveryPatch(recoveryPatchToCorePatch(recovery));
        }
      },
    }, admission);
  }

  private assertRecoveryPreconditions(
    operationId: string,
    recovery: Awaited<ReturnType<WorkspaceTransactionLog['recoveryPatch']>>,
  ): void {
    this.assertRecoveryPreconditionsOnCore(this.core, operationId, recovery);
  }

  private assertRecoveryPreconditionsOnCore(
    core: Core,
    operationId: string,
    recovery: Awaited<ReturnType<WorkspaceTransactionLog['recoveryPatch']>>,
  ): void {
    const nodes = core.state().nodes;
    const changedPreconditions: RevertConflictDiff['changedPreconditions'] = recovery.nodes.flatMap((entry) => {
      const current = nodes[entry.id];
      const actualDigest = current ? canonicalSha256(current) : null;
      return actualDigest === entry.afterDigest ? [] : [{
        id: entry.id,
        expectedAfterDigest: entry.afterDigest,
        actualDigest,
      }];
    });
    if (changedPreconditions.length === 0) return;
    const conflictDiff: RevertConflictDiff = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      kind: 'outline.revert-conflict-diff',
      operationId,
      currentRevision: this.core.revision(),
      changedPreconditions,
    };
    throw new OutlineContractError(outlineError(
      'revert_conflict',
      'conflict',
      `Operation cannot be reverted because ${changedPreconditions.length} affected Node precondition(s) changed: ${operationId}`,
      { details: { conflictDiff } },
    ));
  }

  private async prepareMutation(
    request: Pick<OutlineRuntimeMutationRequest, 'idempotencyKey' | 'idempotencyPayloadHash'>,
  ): Promise<WorkspaceMutationAdmission> {
    this.assertMutationAdmission();
    await this.drainDurability();
    if (this.settlementUnknown) {
      throw new OutlineContractError(outlineError(
        'operation_settlement_unknown',
        'durability',
        'A prior mutation may have committed; restart or resolve it by idempotency key before writing again.',
        { retryable: true },
      ));
    }
    if (request.idempotencyKey && !request.idempotencyPayloadHash) {
      throw new OutlineContractError(outlineError(
        'invalid_input',
        'usage',
        'An idempotency payload hash is required with an idempotency key.',
      ));
    }
    const admission = await this.store.prepareMutation(
      request.idempotencyKey ? {
        key: request.idempotencyKey,
        payloadHash: request.idempotencyPayloadHash!,
      } : undefined,
      { instanceId: this.instanceId, revision: this.revision() },
    );
    this.publishEvents(admission.maintenanceEvents);
    return admission;
  }

  private async applyMutation(
    request: OutlineRuntimeMutationRequest,
    preparedAdmission?: WorkspaceMutationAdmission,
  ): Promise<Operation | NoChangeResult> {
    const result = await this.applyMutationWithSettlement(request, preparedAdmission, false);
    if ('settlement' in result) return result.settlement;
    return result;
  }

  private applyAcceptedMutation(request: OutlineRuntimeMutationRequest): Promise<OutlineAcceptedMutation> {
    return this.applyMutationWithSettlement(request, undefined, true) as Promise<OutlineAcceptedMutation>;
  }

  private async applyMutationWithSettlement(
    request: OutlineRuntimeMutationRequest,
    preparedAdmission: WorkspaceMutationAdmission | undefined,
    deferDurability: boolean,
  ): Promise<Operation | NoChangeResult | OutlineAcceptedMutation> {
    this.assertMutationAdmission();
    const admission = deferDurability
      ? undefined
      : preparedAdmission ?? await this.prepareMutation(request);
    if (admission?.existingOperation) return admission.existingOperation;

    const fromVersion = this.core.replicationVersionVector();
    const afterMetadataSequence = this.core.persistenceMetadataSequence();
    const operationId = `operation:${crypto.randomUUID()}`;
    const metadata: CoreTransactionMetadata = {
      operationId,
      command: request.revertsOperationId ? 'outline_revert' : 'outline_apply',
      summary: request.summary,
      ...(request.causation ? { causation: request.causation } : {}),
    };
    try {
      const { settlement } = await this.core.transactionWithPatchSettlement(
        'system',
        () => request.execute(this.core),
        async ({ result: transactionResult, patch }): Promise<MutationSettlement> => {
          assertProtectedMemoryDefinitionPatch(patch);
          if (patch.nodes.length === 0 && !patch.systemChanged) {
            const noChange = request.noChangeResult?.(this.core);
            if (noChange) return { kind: 'no-change', result: noChange, patch };
            throw new OutlineContractError(outlineError(
              'precondition_failed',
              'conflict',
              'The mutation produced no document changes.',
            ));
          }

          this.pendingPublicationPatch = patch;
          const resolvedLeases = await this.assets.resolveLeases(Object.keys(request.assetLeases ?? {}));
          for (const [leaseId, expectedAssetId] of Object.entries(request.assetLeases ?? {})) {
            if (resolvedLeases.get(leaseId)?.assetId !== expectedAssetId) {
              throw new OutlineContractError(outlineError(
                'precondition_failed',
                'conflict',
                `Asset lease resolution changed before settlement: ${leaseId}`,
              ));
            }
          }

          const nextState = this.core.state();
          const nextAssetReferenceCounts = applyAssetReferencePatch(this.assetReferenceCounts, patch, nextState);
          const liveAddedAssetRecordIds = changedAssetIds(
            this.assetReferenceCounts,
            nextAssetReferenceCounts,
            (before, after) => before === 0 && after > 0,
          );
          const recoveryProtectedAssetRecordIds = new Set(
            request.revertsOperationId ? request.protectedAssetRecordIds ?? [] : [],
          );
          const implicitlyConsumedLeases = await this.assets.resolveLeasesForAssetIds(
            liveAddedAssetRecordIds.filter((assetId) => !recoveryProtectedAssetRecordIds.has(assetId)),
          );
          const consumedLeaseIds = [...new Set([
            ...Object.keys(request.assetLeases ?? {}),
            ...implicitlyConsumedLeases.keys(),
          ])].sort();
          for (const assetId of Object.values(request.assetLeases ?? {})) {
            if ((nextAssetReferenceCounts.get(assetId) ?? 0) === 0) {
              throw new OutlineContractError(outlineError(
                'precondition_failed',
                'conflict',
                `Consumed asset lease is not referenced by the settled document: ${assetId}`,
              ));
            }
          }
          const patchAssetIds = assetRecordIdsInPatch(patch, nextState);
          const protectedAssetRecordIds = await this.assets.expandAssetIds([
            ...patchAssetIds,
            ...request.protectedAssetRecordIds ?? [],
          ]);
          const assetDelta: OutlineAssetDelta = {
            consumedLeaseIds,
            liveAddedAssetRecordIds,
            liveRemovedAssetRecordIds: changedAssetIds(
              this.assetReferenceCounts,
              nextAssetReferenceCounts,
              (before, after) => before > 0 && after === 0,
            ),
          };
          const patchHash = semanticPatchDigest(patch.nodes);
          if (request.expectedPatchHash && request.expectedPatchHash !== patchHash) {
            throw new OutlineContractError(outlineError(
              'diff_mismatch',
              'conflict',
              'The applied Node patch does not match the reviewed Diff.',
              { details: { expected: request.expectedPatchHash, actual: patchHash } },
            ));
          }

          const persistence = this.core.capturePersistenceUpdate(fromVersion, afterMetadataSequence);
          const result = request.result?.(this.core) ?? transactionResult;
          const createdAt = this.now().toISOString();
          const recoveryPatch = createOutlineRecoveryPatch({
            operationId,
            origin: request.origin,
            causation: request.causation,
            changeSetHash: request.changeSetHash,
            diffHash: request.diffHash,
            corePatch: patch,
            protectedAssetRecordIds,
            createdAt,
          });
          const affectedNodeIds = patch.nodes.map((entry) => entry.id);
          const affectedNodeIdsSample = affectedNodeIds.slice(0, MAX_AFFECTED_NODE_ID_SAMPLE);
          const operation: Operation = {
            protocolVersion: OUTLINE_PROTOCOL_VERSION,
            kind: 'outline.operation',
            operationId,
            changeSetHash: request.changeSetHash,
            diffHash: request.diffHash,
            origin: request.origin,
            ...(request.causation ? { causation: request.causation } : {}),
            ...(request.source ? { source: request.source } : {}),
            summary: request.summary,
            affectedNodeIds: affectedNodeIdsSample,
            affectedNodeCount: affectedNodeIds.length,
            affectedNodeIdsHash: canonicalSha256(affectedNodeIds),
            ...(affectedNodeIds.length > MAX_AFFECTED_NODE_ID_SAMPLE ? {
              affectedNodeIdsTruncated: true,
              affectedNodeIdsCursor: encodeOperationLogCursor({
                kind: 'affected',
                filterHash: canonicalSha256({ operationId }),
                operationId,
                offset: MAX_AFFECTED_NODE_ID_SAMPLE,
              }),
            } : {}),
            revisionBefore: patch.revisionBefore,
            revisionAfter: patch.revisionAfter,
            createdAt,
            recovery: {
              recoveryPatchId: recoveryPatch.recoveryPatchId,
              state: 'available',
              retainedUntilAtLeast: recoveryPatch.retainedUntilAtLeast,
            },
            ...(request.undoGroup ? { undoGroup: request.undoGroup } : {}),
            ...(request.revertsOperationId ? { revertsOperationId: request.revertsOperationId } : {}),
            ...(request.revertsOperationIds ? { revertsOperationIds: [...request.revertsOperationIds] } : {}),
            ...(result ? { result } : {}),
          };
          const projectionUpdate: ProjectionUpdate = {
            kind: 'delta',
            revision: operation.revisionAfter,
            todayId: this.core.todayId(),
            changedNodes: patch.nodes.flatMap((entry) => entry.after ? [projectNode(entry.after)] : []),
            removedIds: patch.nodes.flatMap((entry) => entry.after ? [] : [entry.id]),
          };
          const acceptedDiff = deferDurability ? request.acceptedDiff?.(patch) : undefined;
          const deferredInput: DeferredTransactionInput = {
            persistence,
            operation,
            recoveryPatch,
            ...(request.idempotencyKey ? {
              idempotency: {
                key: request.idempotencyKey,
                payloadHash: request.idempotencyPayloadHash!,
                operationId,
                ...(acceptedDiff ? {
                  accepted: {
                    update: projectionUpdate,
                    diff: acceptedDiff,
                  },
                } : {}),
              },
            } : {}),
            assetDelta,
            measureExactRevisionBytes: (coordinates, excluding) => (
              this.assets.measureExactRevisionBytes(coordinates, excluding)
            ),
          };
          if (deferDurability) {
            return {
              kind: 'deferred',
              input: deferredInput,
              projectionUpdate,
              assetReferenceCounts: nextAssetReferenceCounts,
              patch,
            };
          }
          if (!admission) throw new Error('Durable Outline mutation is missing admission state.');
          const event = operationEvent(
            this.instanceId,
            admission.latestEventSequence + 1,
            operation,
            projectionUpdate,
          );
          let appended: WorkspaceTransactionAppendResult;
          try {
            appended = await this.store.append({
              ...deferredInput,
              event,
            });
          } catch (error) {
            if (error instanceof OutlineContractError
              && error.outlineError.code !== 'durability_failed') throw error;
            this.settlementUnknown = true;
            this.settlementUnknownIdempotencyKey = request.idempotencyKey;
            throw new OutlineContractError(outlineError(
              'operation_settlement_unknown',
              'durability',
              'The mutation may have committed, but acknowledgement was not completed.',
              {
                retryable: true,
                details: {
                  ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
                  cause: error instanceof Error ? error.message : String(error),
                },
              },
            ));
          }
          if (appended.idempotent) throw new ExistingOperationSettlement(appended.operation);
          return {
            kind: 'appended',
            appended,
            projectionUpdate,
            assetReferenceCounts: nextAssetReferenceCounts,
          };
        },
        metadata,
        { idFactory: request.idFactory },
      );

      if (settlement.kind === 'no-change') {
        if (!deferDurability) return settlement.result;
        return {
          settlement: settlement.result,
          update: {
            kind: 'delta',
            revision: settlement.result.revision,
            todayId: this.core.todayId(),
            changedNodes: [],
            removedIds: [],
          },
          patch: settlement.patch,
          ...(request.acceptedDiff ? { diff: request.acceptedDiff(settlement.patch) } : {}),
        };
      }
      this.assetReferenceCounts = settlement.assetReferenceCounts;
      const readModelApplied = request.source?.kind === 'import'
        ? await this.readModel.applyUpdateYielding(settlement.projectionUpdate, { yieldEveryNodes: 250 })
        : this.readModel.applyUpdate(settlement.projectionUpdate);
      if (!readModelApplied) {
        this.readModel.reseed(this.core.revision(), this.core.projection());
      }
      if (settlement.kind === 'deferred') {
        const result: OutlineAcceptedMutation = {
          settlement: settlement.input.operation,
          update: settlement.projectionUpdate,
          patch: settlement.patch,
          ...(settlement.input.idempotency?.accepted
            ? { diff: settlement.input.idempotency.accepted.diff }
            : {}),
        };
        this.pendingDurability.push({
          input: settlement.input,
          projectionUpdate: settlement.projectionUpdate,
        });
        this.scheduleDurability();
        return result;
      }
      this.durableRevisionValue = Math.max(
        this.durableRevisionValue,
        settlement.appended.operation.revisionAfter,
      );
      this.publishEvents(settlement.appended.maintenanceEvents);
      this.publishEvents([settlement.appended.event]);
      if (request.idempotencyKey) {
        this.acceptedByIdempotencyKey.set(request.idempotencyKey, {
          payloadHash: request.idempotencyPayloadHash!,
        });
      }
      return settlement.appended.operation;
    } catch (error) {
      if (error instanceof ExistingOperationSettlement) return error.operation;
      throw error;
    } finally {
      this.pendingPublicationPatch = undefined;
    }
  }

  private async applyRequiredMutation(
    request: OutlineRuntimeMutationRequest,
    preparedAdmission?: WorkspaceMutationAdmission,
  ): Promise<Operation> {
    const result = await this.applyMutation(request, preparedAdmission);
    if (result.kind === 'outline.no-change') {
      throw new OutlineContractError(outlineError(
        'precondition_failed',
        'conflict',
        'The mutation produced no document changes.',
      ));
    }
    return result;
  }

  private publishEvents(events: readonly OutlineEvent[]): void {
    for (const event of events) {
      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch {
          // Observer failure cannot turn durable maintenance or an Operation into a failed mutation.
        }
      }
    }
  }

  private async reloadDurableState(expectedRevision: number): Promise<void> {
    const loaded = await this.store.load();
    if (!loaded.snapshot) throw new Error('Durable settlement recovery has no workspace snapshot');
    if (loaded.inconsistent) throw loaded.inconsistent;
    const revision = loaded.events.at(-1)?.revision
      ?? loaded.operations.at(-1)?.revisionAfter
      ?? 0;
    if (revision < expectedRevision) {
      throw new Error(`Durable settlement recovery stopped at revision ${revision}, expected at least ${expectedRevision}`);
    }
    const recovered = loaded.replay.length > 0
      ? Core.fromPersistenceState(loaded.snapshot, loaded.replay, {
          installationId: loaded.snapshot.local.installationId,
          revision,
        })
      : Core.fromState(loaded.snapshot, {
          installationId: loaded.snapshot.local.installationId,
          revision,
        });
    if (recovered.requiresInitialPersist()) {
      throw new Error('Durable settlement recovery requires workspace reconciliation before writes can resume');
    }
    await this.assets.reconcileAnchors();
    recovered.setSearchAssetMetadataProvider(() => this.assets.metadataSnapshot());
    this.core = recovered;
    this.readModel.reseed(recovered.revision(), recovered.projection());
    this.assetReferenceCounts = countAssetReferences(recovered.state());
    this.durableRevisionValue = recovered.revision();
    for (const idempotency of loaded.idempotency) {
      this.acceptedByIdempotencyKey.set(idempotency.key, { payloadHash: idempotency.payloadHash });
    }
  }

  private scheduleDurability(): void {
    const now = this.now().getTime();
    this.firstDirtyAt ??= now;
    this.lastDirtyAt = now;
    if (this.durabilityIdleTimer) this.durabilityCancel(this.durabilityIdleTimer);
    this.durabilityIdleTimer = this.durabilitySchedule(() => {
      this.durabilityIdleTimer = undefined;
      this.startDurabilityRun();
    }, this.durabilityIdleDelayMs);
    this.ensureDurabilityMaxWaitTimer();
  }

  private ensureDurabilityTimers(): void {
    if (this.pendingDurability.length === 0 || this.durabilityFailure) return;
    const now = this.now().getTime();
    this.firstDirtyAt ??= now;
    this.lastDirtyAt ??= now;
    if (!this.durabilityIdleTimer) {
      const idleElapsed = now - this.lastDirtyAt;
      this.durabilityIdleTimer = this.durabilitySchedule(() => {
        this.durabilityIdleTimer = undefined;
        this.startDurabilityRun();
      }, Math.max(0, this.durabilityIdleDelayMs - idleElapsed));
    }
    this.ensureDurabilityMaxWaitTimer();
  }

  private ensureDurabilityMaxWaitTimer(): void {
    if (this.durabilityMaxWaitTimer || this.firstDirtyAt === undefined) return;
    const elapsed = this.now().getTime() - this.firstDirtyAt;
    this.durabilityMaxWaitTimer = this.durabilitySchedule(() => {
      this.durabilityMaxWaitTimer = undefined;
      this.startDurabilityRun();
    }, Math.max(0, this.durabilityMaxWaitMs - elapsed));
  }

  private clearDurabilityTimers(): void {
    if (this.durabilityIdleTimer) this.durabilityCancel(this.durabilityIdleTimer);
    if (this.durabilityMaxWaitTimer) this.durabilityCancel(this.durabilityMaxWaitTimer);
    this.durabilityIdleTimer = undefined;
    this.durabilityMaxWaitTimer = undefined;
  }

  private startDurabilityRun(): void {
    if (this.durabilityRun || this.durabilityFailure || this.pendingDurability.length === 0) return;
    this.clearDurabilityTimers();
    this.firstDirtyAt = undefined;
    this.lastDirtyAt = undefined;
    const batch = this.pendingDurability.slice();
    const run = this.flushDurability(batch);
    const wrapped = run.catch((error: unknown) => {
      this.durabilityFailure = error;
    }).finally(() => {
      if (this.durabilityRun !== wrapped) return;
      this.durabilityRun = undefined;
      this.ensureDurabilityTimers();
    });
    this.durabilityRun = wrapped;
  }

  private async flushDurability(batch: readonly PendingDurability[]): Promise<void> {
    const appendedBatch = await this.store.appendBatch(batch.map((pending) => ({
      ...pending.input,
      createEvent: (sequence: number) => operationEvent(
        this.instanceId,
        sequence,
        pending.input.operation,
        pending.projectionUpdate,
      ),
    })));
    for (let index = 0; index < batch.length; index += 1) {
      const pending = batch[index]!;
      const operation = pending.input.operation;
      const appended = appendedBatch[index]!;
      if (appended.operation.operationId !== operation.operationId) {
        throw new OutlineContractError(outlineError(
          'idempotency_conflict',
          'conflict',
          `Accepted Operation settled to a different idempotent result: ${operation.operationId}`,
        ));
      }
      this.durableRevisionValue = Math.max(this.durableRevisionValue, operation.revisionAfter);
      if (pending.input.idempotency) {
        this.acceptedByIdempotencyKey.set(pending.input.idempotency.key, {
          payloadHash: pending.input.idempotency.payloadHash,
        });
      }
      this.core.acknowledgePersistenceMetadata(pending.input.persistence.metadataSequence);
      this.publishEvents(appended.maintenanceEvents);
      this.publishEvents([appended.event]);
    }
    this.pendingDurability.splice(0, batch.length);
  }

  private assertMutationAdmission(): void {
    if (this.mutationAdmissionFrozen) {
      throw new OutlineContractError(outlineError(
        'runtime_unavailable',
        'unavailable',
        'Outline mutation admission is frozen.',
        { retryable: true },
      ));
    }
    if (this.durabilityFailure) {
      throw new OutlineContractError(outlineError(
        'durability_failed',
        'durability',
        'A previously accepted Outline mutation is not durable; drain or restart before writing again.',
        {
          retryable: true,
          details: this.durabilityFailure instanceof Error
            ? this.durabilityFailure.message
            : String(this.durabilityFailure),
        },
      ));
    }
  }

  private enqueueMutation<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const next = this.mutationChain.then(task, task);
    this.mutationChain = next.then(() => undefined, () => undefined);
    return next;
  }
}

function operationEvent(
  instanceId: string,
  sequence: number,
  operation: Operation,
  update: ProjectionUpdate,
): OutlineEvent {
  return {
    protocolVersion: OUTLINE_PROTOCOL_VERSION,
    kind: 'outline.event',
    type: operationRevertsAny(operation) ? 'operation.reverted' : 'operation.committed',
    instanceId,
    sequence,
    revision: operation.revisionAfter,
    cursor: encodeEventCursor({
      instanceId,
      sequence,
      revision: operation.revisionAfter,
    }),
    operation,
    changes: {
      todayId: update.kind === 'delta' ? update.todayId : update.projection.todayId,
      changedNodes: update.kind === 'delta' ? update.changedNodes : update.projection.nodes,
      removedIds: update.kind === 'delta' ? update.removedIds : [],
    },
  };
}

function assetRecordIdsInNode(node: Node, isBuiltInUriValue: boolean): Set<string> {
  const result = new Set<string>();
  if (node.bannerAssetId) result.add(node.bannerAssetId);
  if (node.icon && (node.iconKind === 'image' || node.iconKind === 'generated')) result.add(node.icon);
  if (isBuiltInUriValue) {
    const assetId = parseAssetSourceUri(node.content.text);
    if (assetId) result.add(assetId);
  }
  return result;
}

function countAssetReferences(state: DocumentState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of Object.values(state.nodes)) {
    const parent = node.parentId ? state.nodes[node.parentId] : undefined;
    const isBuiltInUriValue = parent?.type === 'fieldEntry' && parent.fieldDefId === SOURCE_FIELD_ID;
    for (const assetId of assetRecordIdsInNode(node, isBuiltInUriValue)) {
      counts.set(assetId, (counts.get(assetId) ?? 0) + 1);
    }
  }
  return counts;
}

function applyAssetReferencePatch(
  current: ReadonlyMap<string, number>,
  patch: CoreTransactionPatch,
  nextState: DocumentState,
): Map<string, number> {
  const next = new Map(current);
  const patchById = new Map(patch.nodes.map((entry) => [entry.id, entry]));
  for (const nodeId of assetReferenceCandidateNodeIds(patch)) {
    const before = patchNodeAtPhase(nodeId, 'before', patchById, nextState);
    if (before) {
      for (const assetId of assetRecordIdsInNode(
        before,
        patchNodeIsSourceValue(before, 'before', patchById, nextState),
      )) {
        const count = (next.get(assetId) ?? 0) - 1;
        if (count > 0) next.set(assetId, count);
        else next.delete(assetId);
      }
    }
    const after = patchNodeAtPhase(nodeId, 'after', patchById, nextState);
    if (after) {
      for (const assetId of assetRecordIdsInNode(
        after,
        patchNodeIsSourceValue(after, 'after', patchById, nextState),
      )) {
        next.set(assetId, (next.get(assetId) ?? 0) + 1);
      }
    }
  }
  return next;
}

function assetRecordIdsInPatch(patch: CoreTransactionPatch, nextState: DocumentState): Set<string> {
  const result = new Set<string>();
  const patchById = new Map(patch.nodes.map((entry) => [entry.id, entry]));
  for (const nodeId of assetReferenceCandidateNodeIds(patch)) {
    for (const phase of ['before', 'after'] as const) {
      const node = patchNodeAtPhase(nodeId, phase, patchById, nextState);
      if (!node) continue;
      for (const assetId of assetRecordIdsInNode(
        node,
        patchNodeIsSourceValue(node, phase, patchById, nextState),
      )) {
        result.add(assetId);
      }
    }
  }
  return result;
}

function patchNodeIsSourceValue(
  node: Node,
  phase: 'before' | 'after',
  patchById: ReadonlyMap<string, CoreTransactionPatch['nodes'][number]>,
  nextState: DocumentState,
): boolean {
  if (!node.parentId) return false;
  const parent = patchNodeAtPhase(node.parentId, phase, patchById, nextState);
  return parent?.type === 'fieldEntry' && parent.fieldDefId === SOURCE_FIELD_ID;
}

function assetReferenceCandidateNodeIds(patch: CoreTransactionPatch): Set<string> {
  const result = new Set(patch.nodes.map((entry) => entry.id));
  for (const entry of patch.nodes) {
    const beforeIsBuiltInUri = entry.before?.type === 'fieldEntry'
      && entry.before.fieldDefId === SOURCE_FIELD_ID;
    const afterIsBuiltInUri = entry.after?.type === 'fieldEntry'
      && entry.after.fieldDefId === SOURCE_FIELD_ID;
    if (beforeIsBuiltInUri === afterIsBuiltInUri) continue;
    for (const childId of entry.before?.children ?? []) result.add(childId);
    for (const childId of entry.after?.children ?? []) result.add(childId);
  }
  return result;
}

function patchNodeAtPhase(
  nodeId: string,
  phase: 'before' | 'after',
  patchById: ReadonlyMap<string, CoreTransactionPatch['nodes'][number]>,
  nextState: DocumentState,
): Node | undefined {
  const entry = patchById.get(nodeId);
  return entry ? (entry[phase] as Node | null) ?? undefined : nextState.nodes[nodeId];
}

function changedAssetIds(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
  matches: (beforeCount: number, afterCount: number) => boolean,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((assetId) => matches(before.get(assetId) ?? 0, after.get(assetId) ?? 0))
    .sort();
}

function cloneNode(node: Readonly<Node>): Node {
  return JSON.parse(JSON.stringify(node)) as Node;
}

interface HistoryStackItem {
  readonly operationIds: readonly string[];
  readonly stackOperationId: string;
  readonly undoGroupId?: string;
}

function operationHistory(operations: readonly Operation[]): {
  readonly undo: readonly HistoryStackItem[];
  readonly redo: readonly HistoryStackItem[];
} {
  const undo: HistoryStackItem[] = [];
  const redo: HistoryStackItem[] = [];
  for (const operation of operations) {
    const targets = operationRevertTargetIds(operation);
    if (targets.length === 0) {
      pushHistoryOperation(undo, operation);
      redo.length = 0;
      continue;
    }
    if (historyItemMatchesTargets(undo.at(-1), targets)) {
      undo.pop();
      redo.push(historyItemForOperation(operation));
      continue;
    }
    if (historyItemMatchesTargets(redo.at(-1), targets)) {
      redo.pop();
      undo.push(historyItemForOperation(operation));
      continue;
    }
    removeOperationTargets(undo, targets);
    removeOperationTargets(redo, targets);
    pushHistoryOperation(undo, operation);
    redo.length = 0;
  }
  const available = new Set(operations
    .filter((operation) => operation.recovery.state === 'available')
    .map((operation) => operation.operationId));
  return {
    undo: undo.filter((item) => item.operationIds.every((operationId) => available.has(operationId))),
    redo: redo.filter((item) => item.operationIds.every((operationId) => available.has(operationId))),
  };
}

function pushHistoryOperation(stack: HistoryStackItem[], operation: Operation): void {
  const groupId = operation.undoGroup?.groupId;
  const last = stack.at(-1);
  if (groupId && last?.undoGroupId === groupId) {
    stack[stack.length - 1] = {
      operationIds: [...last.operationIds, operation.operationId],
      stackOperationId: operation.operationId,
      undoGroupId: groupId,
    };
    return;
  }
  stack.push(historyItemForOperation(operation));
}

function historyItemForOperation(operation: Operation): HistoryStackItem {
  return {
    operationIds: [operation.operationId],
    stackOperationId: operation.operationId,
    ...(operation.undoGroup?.groupId ? { undoGroupId: operation.undoGroup.groupId } : {}),
  };
}

function historyItemMatchesTargets(item: HistoryStackItem | undefined, targets: readonly string[]): boolean {
  return Boolean(item)
    && item!.operationIds.length === targets.length
    && item!.operationIds.every((operationId, index) => operationId === targets[index]);
}

function removeOperationTargets(stack: HistoryStackItem[], targets: readonly string[]): void {
  const targetSet = new Set(targets);
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]!.operationIds.some((operationId) => targetSet.has(operationId))) {
      stack.splice(index, 1);
    }
  }
}

function filterHistoryOperations(
  operations: readonly Operation[],
  origin: Operation['origin'] | 'all',
): readonly Operation[] {
  if (origin === 'all') return operations;
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  return operations.filter((operation) => rootOperationOrigin(operation, byId) === origin);
}

function rootOperationOrigin(
  operation: Operation,
  byId: ReadonlyMap<string, Operation>,
): Operation['origin'] | undefined {
  let current = operation;
  const visited = new Set<string>();
  while (operationRevertsAny(current)) {
    if (visited.has(current.operationId)) return undefined;
    visited.add(current.operationId);
    const targetId = current.revertsOperationId ?? current.revertsOperationIds?.at(-1);
    if (!targetId) return undefined;
    const target = byId.get(targetId);
    if (!target) return undefined;
    current = target;
  }
  return current.origin;
}

function assertExpectedHistoryOperation(
  command: 'undo' | 'redo',
  actualOperationId: string,
  expectedOperationId: string | undefined,
): void {
  if (!expectedOperationId || expectedOperationId === actualOperationId) return;
  throw new OutlineContractError(outlineError(
    'stale_revision',
    'conflict',
    `The ${command} stack top changed before recovery.`,
    { details: { expectedOperationId, actualOperationId } },
  ));
}

function operationRevertsAny(operation: Operation): boolean {
  return operationRevertTargetIds(operation).length > 0;
}

function operationRevertTargetIds(operation: Operation): readonly string[] {
  if (operation.revertsOperationIds && operation.revertsOperationIds.length > 0) return operation.revertsOperationIds;
  return operation.revertsOperationId ? [operation.revertsOperationId] : [];
}
