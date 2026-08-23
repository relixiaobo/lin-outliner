import { Core } from '../../core/core';
import type { CoreTransactionMetadata } from '../../core/core';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';
import type { Operation, OutlineEvent } from '../contract/schemas';
import { OUTLINE_PROTOCOL_VERSION } from '../contract/version';
import {
  createOutlineRecoveryPatch,
  recoveryPatchToCorePatch,
  WorkspaceTransactionLog,
  type OutlineAssetDelta,
  type WorkspaceTransactionAppendResult,
  type WorkspaceTransactionLogOptions,
} from './storage';
import { semanticPatchDigest } from './semanticDigest';
import { encodeEventCursor } from './eventCursor';

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
  readonly idFactory?: (prefix: string) => string;
  readonly execute: (candidate: Core) => void | Operation['result'] | Promise<void | Operation['result']>;
  readonly result?: (candidate: Core) => Operation['result'];
}

export interface OutlineRuntimeWorkspaceOptions {
  readonly store?: WorkspaceTransactionLog;
  readonly storeOptions?: WorkspaceTransactionLogOptions;
  readonly initialCore?: Core;
  readonly instanceId?: string;
  readonly now?: () => Date;
}

export class OutlineRuntimeWorkspace {
  private mutationChain: Promise<unknown> = Promise.resolve();
  private settlementUnknown = false;
  private eventListeners = new Set<(event: OutlineEvent) => void>();
  private readonly now: () => Date;

  private constructor(
    private core: Core,
    readonly store: WorkspaceTransactionLog,
    readonly instanceId: string,
    readonly eventBaselineSequence: number,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  static async open(root: string, options: OutlineRuntimeWorkspaceOptions = {}): Promise<OutlineRuntimeWorkspace> {
    const store = options.store ?? new WorkspaceTransactionLog(root, options.storeOptions);
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
    return new OutlineRuntimeWorkspace(
      core,
      store,
      options.instanceId ?? `runtime:${crypto.randomUUID()}`,
      loaded.latestEventSequence,
      options.now,
    );
  }

  revision(): number {
    return this.core.revision();
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

  async mutate(request: OutlineRuntimeMutationRequest): Promise<Operation> {
    return this.enqueueMutation(() => this.applyMutation(request));
  }

  async revert(
    operationId: string,
    options: Pick<OutlineRuntimeMutationRequest, 'origin' | 'causation' | 'idempotencyKey' | 'idempotencyPayloadHash'>,
  ): Promise<Operation> {
    return this.enqueueMutation(async () => {
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
      try {
        return await this.applyMutation({
          ...options,
          changeSetHash,
          diffHash,
          summary: `Reverted Operation ${operationId}.`,
          revertsOperationId: operationId,
          protectedAssetRecordIds: recovery.protectedAssetRecordIds,
          execute: (candidate) => {
            candidate.applyRecoveryPatch(recoveryPatchToCorePatch(recovery));
          },
        });
      } catch (error) {
        if (error instanceof OutlineContractError) throw error;
        throw new OutlineContractError(outlineError(
          'revert_conflict',
          'conflict',
          `Operation cannot be reverted because an affected Node changed: ${operationId}`,
          { details: error instanceof Error ? error.message : String(error) },
        ));
      }
    });
  }

  async undo(options: Pick<OutlineRuntimeMutationRequest, 'origin' | 'causation'>): Promise<Operation> {
    return this.enqueueMutation(async () => {
      const operations = await this.store.operations();
      const target = [...operations].reverse().find((operation) => operation.recovery.state === 'available');
      if (!target) {
        throw new OutlineContractError(outlineError('not_found', 'selection', 'No recoverable Operation is available to undo.'));
      }
      return this.revertInsideQueue(target.operationId, options);
    });
  }

  async redo(options: Pick<OutlineRuntimeMutationRequest, 'origin' | 'causation'>): Promise<Operation> {
    return this.enqueueMutation(async () => {
      const operations = await this.store.operations();
      const target = [...operations].reverse().find((operation) => (
        operation.revertsOperationId && operation.recovery.state === 'available'
      ));
      if (!target) {
        throw new OutlineContractError(outlineError('not_found', 'selection', 'No recoverable revert Operation is available to redo.'));
      }
      return this.revertInsideQueue(target.operationId, options);
    });
  }

  private async revertInsideQueue(
    operationId: string,
    options: Pick<OutlineRuntimeMutationRequest, 'origin' | 'causation'>,
  ): Promise<Operation> {
    const recovery = await this.store.recoveryPatch(operationId);
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
    });
  }

  private async applyMutation(request: OutlineRuntimeMutationRequest): Promise<Operation> {
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
    const admission = await this.store.prepareMutation(request.idempotencyKey ? {
      key: request.idempotencyKey,
      payloadHash: request.idempotencyPayloadHash!,
    } : undefined);
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
      request.revertsOperationId
        ? 'system'
        : request.origin === 'built-in-agent'
          ? 'agent'
          : 'user',
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
      protectedAssetRecordIds: request.protectedAssetRecordIds,
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
        affectedNodeIdsCursor: `operation:${operationId}:affected:${MAX_AFFECTED_NODE_ID_SAMPLE}`,
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
        ...(request.assetDelta ? { assetDelta: request.assetDelta } : {}),
      });
    } catch (error) {
      if (error instanceof OutlineContractError
        && error.outlineError.code !== 'durability_failed') throw error;
      this.settlementUnknown = true;
      throw new OutlineContractError(outlineError(
        'operation_settlement_unknown',
        'durability',
        'The mutation may have committed, but acknowledgement was not completed.',
        { retryable: true, details: error instanceof Error ? error.message : String(error) },
      ));
    }
    if (!appended.idempotent) {
      this.core = candidate;
      for (const listener of this.eventListeners) {
        try {
          listener(appended.event);
        } catch {
          // Observer failure cannot turn a durable Operation into a failed mutation.
        }
      }
    }
    return appended.operation;
  }

  private enqueueMutation<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const next = this.mutationChain.then(task, task);
    this.mutationChain = next.then(() => undefined, () => undefined);
    return next;
  }
}
