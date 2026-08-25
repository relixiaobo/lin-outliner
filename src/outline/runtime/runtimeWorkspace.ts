import { Core } from '../../core/core';
import type { CoreTransactionMetadata } from '../../core/core';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';
import type { Operation, OutlineEvent, RevertConflictDiff } from '../contract/schemas';
import type { Node } from '../../core/types';
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
  type WorkspaceTransactionAppendResult,
  type WorkspaceTransactionLogOptions,
} from './storage';
import { semanticPatchDigest } from './semanticDigest';
import { encodeEventCursor } from './eventCursor';
import { encodeOperationLogCursor } from './operationLogCursor';

const MAX_AFFECTED_NODE_ID_SAMPLE = 1_000;

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
  readonly revertsOperationId?: string;
  readonly protectedAssetRecordIds?: readonly string[];
  readonly assetDelta?: OutlineAssetDelta;
  readonly assetLeases?: Readonly<Record<string, string>>;
  readonly idFactory?: (prefix: string) => string;
  readonly execute: (candidate: Core) => void | Operation['result'] | Promise<void | Operation['result']>;
  readonly result?: (candidate: Core) => Operation['result'];
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
  readonly assetStoreOptions?: OutlineAssetStoreOptions;
}

export class OutlineRuntimeWorkspace {
  private mutationChain: Promise<unknown> = Promise.resolve();
  private settlementUnknown = false;
  private eventListeners = new Set<(event: OutlineEvent) => void>();
  private readonly now: () => Date;

  private constructor(
    private core: Core,
    readonly store: WorkspaceTransactionLog,
    readonly assets: OutlineAssetStore,
    readonly instanceId: string,
    readonly eventBaselineSequence: number,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
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
    const assets = new OutlineAssetStore(root, store, {
      ...options.assetStoreOptions,
      ...(options.now ? { now: options.now } : {}),
    });
    const workspace = new OutlineRuntimeWorkspace(
      core,
      store,
      assets,
      instanceId,
      loaded.latestEventSequence,
      options.now,
    );
    await workspace.maintain({ compactIfNeeded: true }).catch(() => undefined);
    return workspace;
  }

  revision(): number {
    return this.core.revision();
  }

  async status() {
    return {
      revision: this.revision(),
      ...await this.store.health(),
    };
  }

  projection() {
    return this.core.projection();
  }

  documentState() {
    return this.core.state();
  }

  forkCore(options: { idFactory?: (prefix: string) => string } = {}): Core {
    return this.core.forkForRuntime(options);
  }

  subscribe(listener: (event: OutlineEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  collectAssetGarbage(): Promise<readonly string[]> {
    return this.enqueueMutation(() => this.assets.collectGarbage([
      ...assetRecordIdsInNodes(Object.values(this.core.state().nodes)),
    ]));
  }

  maintain(options: { readonly compactIfNeeded?: boolean } = {}): Promise<void> {
    return this.enqueueMutation(() => this.runMaintenance(options.compactIfNeeded === true));
  }

  async mutate(request: OutlineRuntimeMutationRequest): Promise<Operation> {
    return this.enqueueMutation(() => this.applyMutation(request));
  }

  async settledOperation(idempotencyKey: string, payloadHash: string): Promise<Operation | undefined> {
    return this.enqueueMutation(async () => {
      const admission = await this.store.prepareMutation(
        { key: idempotencyKey, payloadHash },
        { instanceId: this.instanceId, revision: this.revision() },
      );
      this.publishEvents(admission.maintenanceEvents);
      if (admission.existingOperation) {
        this.settlementUnknown = false;
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
      return this.applyMutation({
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
      const operationId = operationHistory(
        filterHistoryOperations(operations, options.selectionOrigin ?? options.origin),
      ).undo.at(-1);
      if (!operationId) {
        throw new OutlineContractError(outlineError('not_found', 'selection', 'No recoverable Operation is available to undo.'));
      }
      assertExpectedHistoryOperation('undo', operationId, options.expectOperationId);
      return this.revertInsideQueue(operationId, options, admission);
    });
  }

  async redo(
    options: OutlineHistoryMutationOptions,
  ): Promise<Operation> {
    return this.enqueueMutation(async () => {
      const admission = await this.prepareMutation(options);
      if (admission.existingOperation) return admission.existingOperation;
      const operations = await this.store.operations();
      const operationId = operationHistory(
        filterHistoryOperations(operations, options.selectionOrigin ?? options.origin),
      ).redo.at(-1);
      if (!operationId) {
        throw new OutlineContractError(outlineError('not_found', 'selection', 'No recoverable revert Operation is available to redo.'));
      }
      assertExpectedHistoryOperation('redo', operationId, options.expectOperationId);
      return this.revertInsideQueue(operationId, options, admission);
    });
  }

  private async revertInsideQueue(
    operationId: string,
    options: Pick<OutlineRuntimeMutationRequest, 'origin' | 'causation' | 'idempotencyKey' | 'idempotencyPayloadHash'>,
    admission: WorkspaceMutationAdmission,
  ): Promise<Operation> {
    const recovery = await this.store.recoveryPatch(operationId);
    this.assertRecoveryPreconditions(operationId, recovery);
    return this.applyMutation({
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

  private assertRecoveryPreconditions(
    operationId: string,
    recovery: Awaited<ReturnType<WorkspaceTransactionLog['recoveryPatch']>>,
  ): void {
    const nodes = this.core.state().nodes;
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
  ): Promise<Operation> {
    const admission = preparedAdmission ?? await this.prepareMutation(request);
    if (admission.existingOperation) return admission.existingOperation;

    const candidate = this.core.forkForRuntime({ idFactory: request.idFactory });
    const fromVersion = candidate.replicationVersionVector();
    const afterMetadataSequence = candidate.persistenceMetadataSequence();
    const operationId = `operation:${crypto.randomUUID()}`;
    const metadata: CoreTransactionMetadata = {
      operationId,
      command: request.revertsOperationId ? 'outline_revert' : 'outline_apply',
      summary: request.summary,
      ...(request.causation ? { causation: request.causation } : {}),
    };
    const { result: transactionResult, patch } = await candidate.transactionWithPatch(
      'system',
      () => request.execute(candidate),
      metadata,
    );
    if (patch.nodes.length === 0 && !patch.systemChanged) {
      throw new OutlineContractError(outlineError(
        'precondition_failed',
        'conflict',
        'The mutation produced no document changes.',
      ));
    }
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
    const beforeLiveAssetIds = assetRecordIdsInNodes(Object.values(this.core.state().nodes));
    const afterLiveAssetIds = assetRecordIdsInNodes(Object.values(candidate.state().nodes));
    for (const assetId of Object.values(request.assetLeases ?? {})) {
      if (!afterLiveAssetIds.has(assetId)) {
        throw new OutlineContractError(outlineError(
          'precondition_failed',
          'conflict',
          `Consumed asset lease is not referenced by the settled document: ${assetId}`,
        ));
      }
    }
    const patchAssetIds = assetRecordIdsInNodes(patch.nodes.flatMap((entry) => (
      [entry.before, entry.after].filter((node): node is Node => node !== null)
    )));
    const protectedAssetRecordIds = await this.assets.expandAssetIds([
      ...patchAssetIds,
      ...request.protectedAssetRecordIds ?? [],
    ]);
    const recoveryOnlyAssetIds = protectedAssetRecordIds.filter((assetId) => !afterLiveAssetIds.has(assetId));
    const assetDelta: OutlineAssetDelta = {
      consumedLeaseIds: Object.keys(request.assetLeases ?? {}).sort(),
      liveAddedAssetRecordIds: [...afterLiveAssetIds].filter((assetId) => !beforeLiveAssetIds.has(assetId)).sort(),
      liveRemovedAssetRecordIds: [...beforeLiveAssetIds].filter((assetId) => !afterLiveAssetIds.has(assetId)).sort(),
      recoveryOnlyBytes: await this.assets.byteSizeOf(recoveryOnlyAssetIds),
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
    const persistence = candidate.capturePersistenceUpdate(fromVersion, afterMetadataSequence);
    const result = request.result?.(candidate) ?? transactionResult;
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
      ...(request.revertsOperationId ? { revertsOperationId: request.revertsOperationId } : {}),
      ...(result ? { result } : {}),
    };
    const eventSequence = admission.latestEventSequence + 1;
    const event: OutlineEvent = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      kind: 'outline.event',
      type: request.revertsOperationId ? 'operation.reverted' : 'operation.committed',
      instanceId: this.instanceId,
      sequence: eventSequence,
      revision: operation.revisionAfter,
      cursor: encodeEventCursor({
        instanceId: this.instanceId,
        sequence: eventSequence,
        revision: operation.revisionAfter,
      }),
      operation,
      changes: {
        todayId: candidate.todayId(),
        changedNodes: patch.nodes.flatMap((entry) => entry.after ? [projectNode(entry.after)] : []),
        removedIds: patch.nodes.flatMap((entry) => entry.after ? [] : [entry.id]),
      },
    };
    let appended: WorkspaceTransactionAppendResult;
    try {
      appended = await this.store.append({
        persistence,
        operation,
        recoveryPatch,
        event,
        ...(request.idempotencyKey ? {
          idempotency: {
            key: request.idempotencyKey,
            payloadHash: request.idempotencyPayloadHash!,
            operationId,
          },
        } : {}),
        assetDelta,
      });
    } catch (error) {
      if (error instanceof OutlineContractError
        && error.outlineError.code !== 'durability_failed') throw error;
      this.settlementUnknown = true;
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
    if (!appended.idempotent) {
      this.core = candidate;
      this.publishEvents(appended.maintenanceEvents);
      this.publishEvents([appended.event]);
      await this.runMaintenance(true).catch(() => undefined);
    }
    return appended.operation;
  }

  private async runMaintenance(compactIfNeeded: boolean): Promise<void> {
    const context = { instanceId: this.instanceId, revision: this.revision() };
    this.publishEvents(await this.store.maintain(context));
    await this.assets.collectGarbage([
      ...assetRecordIdsInNodes(Object.values(this.core.state().nodes)),
    ]);
    if (compactIfNeeded && await this.store.needsCompaction()) {
      this.publishEvents(await this.store.compact(this.core.serializeState(), context));
    }
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

  private enqueueMutation<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const next = this.mutationChain.then(task, task);
    this.mutationChain = next.then(() => undefined, () => undefined);
    return next;
  }
}

function assetRecordIdsInNodes(nodes: readonly Node[]): Set<string> {
  const result = new Set<string>();
  for (const node of nodes) {
    if (node.bannerAssetId) result.add(node.bannerAssetId);
    if (node.icon && (node.iconKind === 'image' || node.iconKind === 'generated')) result.add(node.icon);
    if ((node.type === 'image' || node.type === 'attachment') && node.assetId) result.add(node.assetId);
    if (node.type === 'attachment' && node.thumbnailAssetId) result.add(node.thumbnailAssetId);
  }
  return result;
}

function operationHistory(operations: readonly Operation[]): {
  readonly undo: readonly string[];
  readonly redo: readonly string[];
} {
  const undo: string[] = [];
  const redo: string[] = [];
  for (const operation of operations) {
    const target = operation.revertsOperationId;
    if (!target) {
      undo.push(operation.operationId);
      redo.length = 0;
      continue;
    }
    if (undo.at(-1) === target) {
      undo.pop();
      redo.push(operation.operationId);
      continue;
    }
    if (redo.at(-1) === target) {
      redo.pop();
      undo.push(operation.operationId);
      continue;
    }
    removeOperationId(undo, target);
    removeOperationId(redo, target);
    undo.push(operation.operationId);
    redo.length = 0;
  }
  const available = new Set(operations
    .filter((operation) => operation.recovery.state === 'available')
    .map((operation) => operation.operationId));
  return {
    undo: undo.filter((operationId) => available.has(operationId)),
    redo: redo.filter((operationId) => available.has(operationId)),
  };
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
  while (current.revertsOperationId) {
    if (visited.has(current.operationId)) return undefined;
    visited.add(current.operationId);
    const target = byId.get(current.revertsOperationId);
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

function removeOperationId(stack: string[], operationId: string): void {
  const index = stack.lastIndexOf(operationId);
  if (index >= 0) stack.splice(index, 1);
}
