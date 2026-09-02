import { renderedMarkdownNodeReferenceIds } from '../../../../core/markdownNodeReferences';
import type {
  AgentCoreExtension,
  ThreadHistoryRollbackContext,
  ThreadServiceExtensionHost,
  ToolLifecycleResult,
  TurnAdmissionContext,
  TurnAdmissionContribution,
} from '../../../../core/agent/extensions';
import {
  MEMORY_EXTENSION_ID,
  type MemoryFeatureMode,
  type MemorySettingsView,
  type ThreadMemoryMode,
} from '../../../../core/agent/memory';
import type {
  AgentCoreRecordedNotification,
  Thread,
  ThreadId,
  Turn,
  TurnId,
} from '../../../../core/agent/protocol';
import type { DocumentProjection, ProjectionUpdate } from '../../../../core/types';
import {
  checkOutlineSchema,
  OutlineResponseSchema,
  ProjectionResultSchema,
  type Operation,
  type ProjectionResult,
} from '../../../../outline/contract';
import { directOutlineShellInvocation } from '../../capabilities/agentCapabilities';
import { uuidV7 } from '../../uuid';
import {
  MemoryControlStore,
  type MemoryPublicationRecord,
  type MemoryRollbackRecord,
} from './MemoryControlStore';
import { MemoryPipeline, type MemoryPipelineSourceHost, phase1Source } from './MemoryPipeline';
import {
  MemoryMutationIndex,
  type MemoryMutationIndexUpdate,
} from './MemoryMutationIndex';
import {
  Phase1,
  collectMemoryEvidence,
  type MemoryModelRunner,
} from './Phase1';
import { Phase2 } from './Phase2';
import {
  type CanonicalMemoryNode,
  TimelineMemoryStore,
  timelineDigest,
  timelineNodeFingerprint,
  type MemoryVisibilityView,
} from './TimelineMemoryStore';

const EXPLICIT_MEMORY_INTENT = /\b(?:remember|forget)\b|\b(?:save|store|add|update|change|remove|delete)\b[^\n]{0,80}\bmemory\b|\bmemory\b[^\n]{0,80}\b(?:save|store|add|update|change|remove|delete)\b|记住|请记|帮我记|保存.{0,20}记忆|记忆.{0,20}(?:保存|添加|更新|修改|删除|移除)|忘掉|忘记/iu;
const MAX_TRACKED_MEMORY_READS = 8;

interface ResetPublicationPayload {
  readonly epoch: number;
  readonly excludedTurnIds: readonly TurnId[];
  readonly containerIds: readonly string[];
}

interface TurnMemoryUsage {
  readonly nodeIds: Set<string>;
  readonly threadId: ThreadId;
}

export interface MemoryThreadHost extends ThreadServiceExtensionHost {
  persistentRootThreads(): readonly Thread[];
  /** True when `persistentRootThreads()` is hiding a Thread this session quarantined. */
  hasHiddenRootThreads(): boolean;
  activeRootUserTurns(): readonly { threadId: ThreadId; turnId: TurnId }[];
  interruptRootTurns(turns: readonly { threadId: ThreadId; turnId: TurnId }[]): Promise<void>;
  readThread(input: { threadId: ThreadId; includeTurns?: boolean }): { thread: Thread };
  isThreadNavigable(threadId: ThreadId): boolean;
  historyRollbackMarker(rollbackId: string): {
    readonly threadId: ThreadId;
    readonly omittedTurnIds: readonly TurnId[];
    readonly beforeProjectionVersion: number;
    readonly afterProjectionVersion: number;
  } | null;
  runInternalMemoryTurn(input: {
    readonly sourceThreadId: ThreadId;
    readonly name: string;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }): Promise<string>;
}

export interface MemoryExtensionOptions {
  readonly onError?: (error: unknown, operation: 'graph-digest' | 'graph-wake') => void;
}

export class MemoryExtension implements AgentCoreExtension {
  readonly id = MEMORY_EXTENSION_ID;
  private host: MemoryThreadHost | null = null;
  private pipeline: MemoryPipeline | null = null;
  private preparedForTurnAdmission = false;
  private initialized = false;
  private workerStopped = false;
  private workerStopping = false;
  private workerStopPromise: Promise<void> | null = null;
  private storeClosed = false;
  private readonly turnMemoryUsage = new Map<TurnId, TurnMemoryUsage>();
  private lastGraphDigest = '';
  private mutationIndex: MemoryMutationIndex | null = null;
  private graphChangeTimer?: ReturnType<typeof setTimeout>;
  private graphChangePending = false;
  private graphChangeForcesWake = false;
  private graphDigestComputations = 0;

  constructor(
    private readonly control: MemoryControlStore,
    private readonly timeline: TimelineMemoryStore,
    private readonly options: MemoryExtensionOptions = {},
  ) {}

  bindHost(host: MemoryThreadHost): void {
    if (this.host) throw new Error('Memory extension is already bound to ThreadService');
    this.host = host;
    const model: MemoryModelRunner = {
      run: ({ purpose, sourceThread, systemPrompt, prompt, signal }) => host.runInternalMemoryTurn({
        sourceThreadId: sourceThread.id,
        name: purpose === 'extract' ? 'Memory extraction' : 'Memory consolidation',
        systemPrompt,
        prompt,
        signal,
      }),
    };
    const phase1 = new Phase1(this.control, this.timeline, model, (threadId, sourceVersion) => {
      const current = host.readThread({ threadId, includeTurns: true }).thread;
      if (current.status.type !== 'idle') return false;
      const evidence = collectMemoryEvidence(phase1Source(current, current.turns ?? []), this.control);
      return !evidence.polluted && evidence.sourceVersion === sourceVersion;
    });
    const phase2 = new Phase2(
      this.control,
      this.timeline,
      model,
      () => this.consolidationSource(),
    );
    const sources: MemoryPipelineSourceHost = {
      persistentRootThreads: () => host.persistentRootThreads(),
      readSource: (threadId) => {
        try {
          const thread = host.readThread({ threadId, includeTurns: true }).thread;
          return phase1Source(thread, thread.turns ?? []);
        } catch {
          return null;
        }
      },
    };
    this.pipeline = new MemoryPipeline(this.control, this.timeline, phase1, phase2, sources, {
      recoverResetPublication: (record, receiptMatches) => this.recoverPreparedReset(record, receiptMatches),
    });
  }

  initializeMutationIndex(projection: DocumentProjection): void {
    if (this.mutationIndex) {
      this.mutationIndex.applyProjectionUpdate({ kind: 'full', revision: 0, projection });
      return;
    }
    this.mutationIndex = new MemoryMutationIndex(projection);
  }

  mutationIndexFullRebuildCount(): number {
    return this.mutationIndex?.fullRebuildCount() ?? 0;
  }

  graphDigestComputationCount(): number {
    return this.graphDigestComputations;
  }

  async prepareForTurnAdmission(): Promise<void> {
    if (this.preparedForTurnAdmission) return;
    const host = this.requireHost();
    await this.timeline.ensureTagDefinitions();
    this.reconcileRollbackHooks(host);
    // The orphan sweep deletes every admission row whose Turn it cannot see, so it
    // is only sound when every durable Turn is enumerable. A quarantined Thread is
    // excluded from `persistentRootThreads()`, which would make all of its Turns
    // look orphaned and delete their admissions for good — turning a
    // session-scoped, in-memory quarantine into a permanent loss of extraction
    // state. Skip the sweep entirely for that session; the next launch that can
    // read the Thread runs it against the complete set.
    if (!host.hasHiddenRootThreads()) {
      this.control.deleteOrphanAdmissions(new Set(host.persistentRootThreads().flatMap((thread) => (
        host.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.map((turn) => turn.id) ?? []
      ))));
    }
    this.lastGraphDigest = this.currentCanonicalGraphDigest();
    await this.requirePipeline().recover();
    this.preparedForTurnAdmission = true;
  }

  async startWorker(): Promise<void> {
    if (this.initialized) return;
    await this.prepareForTurnAdmission();
    await this.requirePipeline().start();
    this.initialized = true;
  }

  stopWorker(): Promise<void> {
    if (this.workerStopped) return Promise.resolve();
    if (this.workerStopPromise) return this.workerStopPromise;
    this.workerStopping = true;
    this.flushDeferredGraphChange();
    const stop = (async () => {
      try {
        await this.pipeline?.close();
        this.workerStopped = true;
      } finally {
        this.workerStopping = false;
        this.workerStopPromise = null;
      }
    })();
    this.workerStopPromise = stop;
    return stop;
  }

  closeStore(): void {
    if (this.storeClosed) return;
    if (!this.workerStopped) throw new Error('Memory worker must stop before its control store closes');
    this.control.close();
    this.storeClosed = true;
  }

  settings(threadId: ThreadId | null = null): MemorySettingsView {
    return {
      status: {
        ...this.control.status(),
        strayTaggedNodeCount: this.timeline.graph().strayTaggedNodeIds.length,
      },
      thread: threadId ? { threadId, mode: this.control.threadMode(threadId) } : null,
    };
  }

  async setFeatureMode(mode: MemoryFeatureMode): Promise<MemorySettingsView> {
    const host = this.requireHost();
    await host.withHostRootTurnAdmissionBarrier(async () => {
      const active = host.activeRootUserTurns();
      await this.timeline.withWriteGate(async () => {
        this.control.setFeatureMode(mode, mode === 'disabled' ? active.map((entry) => entry.turnId) : []);
      });
      if (mode === 'disabled') {
        this.requirePipeline().suspend();
        await host.interruptRootTurns(active);
      }
    });
    if (mode === 'enabled') {
      this.requirePipeline().resume();
      this.requirePipeline().scanEligibleThreads();
      this.requirePipeline().wakeGlobal('feature-enabled');
    }
    return this.settings();
  }

  async setThreadMode(threadId: ThreadId, mode: ThreadMemoryMode): Promise<MemorySettingsView> {
    const host = this.requireHost();
    await host.withThreadAdmissionBarrier(threadId, async () => {
      await this.timeline.withWriteGate(async () => {
        const thread = host.readThread({ threadId, includeTurns: true }).thread;
        if (thread.ephemeral || thread.parentThreadId !== null || thread.threadSource !== 'user') {
          throw new Error('Memory mode is available only for persistent root user Threads');
        }
        this.control.setThreadMode(threadId, mode);
      });
    });
    if (mode === 'enabled') {
      this.requirePipeline().wakeThread(host.readThread({ threadId, includeTurns: true }).thread);
    }
    return this.settings(threadId);
  }

  async reset(): Promise<MemorySettingsView> {
    const host = this.requireHost();
    try {
      await host.withHostRootTurnAdmissionBarrier(async () => {
        await this.timeline.withWriteGate(async () => {
          const status = this.control.status();
          const epoch = status.resetEpoch + 1;
          const active = host.activeRootUserTurns();
          const excludedTurnIds = active.map((entry) => entry.turnId);
          const containerIds = this.timeline.graph().containers.map((entry) => entry.node.id);
          const operationId = `memory:reset:${uuidV7()}`;
          const generation = this.control.allocatePublicationGeneration();
          const payload: ResetPublicationPayload = { epoch, excludedTurnIds, containerIds };
          const digest = timelineDigest({ operationId, generation, payload });
          const publication: MemoryPublicationRecord<ResetPublicationPayload> = {
            id: operationId,
            kind: 'reset',
            status: 'prepared',
            generation,
            featureGeneration: status.featureModeGeneration,
            resetEpoch: status.resetEpoch,
            digest,
            payload,
            createdAt: Date.now(),
          };
          this.control.prepareReset(publication);
          await this.timeline.resetWithinWriteGate(operationId, generation, digest, containerIds);
          this.control.finalizeReset(operationId, epoch, excludedTurnIds);
        });
      });
    } catch (error) {
      this.requirePipeline().wakePending();
      throw error;
    }
    return this.settings();
  }

  contributeTurnAdmission(context: TurnAdmissionContext): TurnAdmissionContribution {
    const featureMode = this.control.featureMode();
    const threadMode = this.control.threadMode(context.thread.id);
    const status = this.control.status();
    const eligible = !context.thread.ephemeral
      && context.thread.parentThreadId === null
      && context.thread.threadSource === 'user'
      && context.provenance.trigger.kind === 'user'
      && featureMode === 'enabled'
      && threadMode === 'enabled';
    this.control.writeAdmission({
      threadId: context.thread.id,
      turnId: context.turnId,
      featureModeAtAdmission: featureMode,
      threadModeAtAdmission: threadMode,
      eligibleAtAdmission: eligible,
      featureModeGeneration: status.featureModeGeneration,
      resetEpoch: status.resetEpoch,
      memoryVisibilityGeneration: status.memoryVisibilityGeneration,
      admittedAt: Date.now(),
    });
    return { extensionId: this.id, snapshotId: `${status.featureModeGeneration}:${status.resetEpoch}:${status.memoryVisibilityGeneration}` };
  }

  contributeThreadContext(thread: Thread) {
    const activeTurn = this.currentTurn(thread.id);
    if (!activeTurn) return null;
    const admission = this.control.admission(activeTurn.id);
    const explicitlyRequested = activeTurn.provenance.trigger.kind === 'user' && turnHasExplicitMemoryIntent(activeTurn);
    if (!admission?.eligibleAtAdmission || this.control.isTurnExcluded(activeTurn.id)) {
      this.turnMemoryUsage.delete(activeTurn.id);
      return explicitlyRequested ? {
        extensionId: this.id,
        applicationInstructions: true as const,
        additionalContext: {
          memory: {
            kind: 'application' as const,
            value: 'Memory is disabled for this Turn. Do not create, edit, tag, move, or delete Memory Nodes. Tell the user that Memory must be enabled before this request can be applied.',
          },
        },
      } : null;
    }
    if (
      this.control.featureMode() !== 'enabled'
      || admission.featureModeGeneration !== this.control.status().featureModeGeneration
    ) {
      this.turnMemoryUsage.delete(activeTurn.id);
      return explicitlyRequested ? {
        extensionId: this.id,
        applicationInstructions: true as const,
        additionalContext: {
          memory: {
            kind: 'application' as const,
            value: 'Memory became unavailable for this Turn. Do not mutate Memory Nodes. Tell the user to retry after Memory is enabled.',
          },
        },
      } : null;
    }
    if (!this.turnMemoryUsage.has(activeTurn.id)) {
      this.turnMemoryUsage.set(activeTurn.id, {
        nodeIds: new Set(),
        threadId: thread.id,
      });
    }
    return {
      extensionId: this.id,
      applicationInstructions: true as const,
      additionalContext: {
        memory: {
          kind: 'application' as const,
          value: MEMORY_OPERATION_CONTEXT,
        },
      },
    };
  }

  onToolCompleted(context: ToolLifecycleResult): void {
    const usage = this.turnMemoryUsage.get(context.turnId);
    if (!usage || usage.threadId !== context.threadId) return;
    const returnedNodeIds = outlineShowNodeIds(context);
    if (returnedNodeIds.size === 0) return;
    let visible: Map<string, CanonicalMemoryNode>;
    try {
      visible = new Map(this.visibleMemoryNodes().map((entry) => [entry.node.id, entry]));
    } catch {
      return;
    }
    for (const nodeId of returnedNodeIds) {
      if (usage.nodeIds.size >= MAX_TRACKED_MEMORY_READS) break;
      if (usage.nodeIds.has(nodeId) || !visible.has(nodeId)) continue;
      usage.nodeIds.add(nodeId);
    }
  }

  onNotification(notification: AgentCoreRecordedNotification): void {
    if (notification.type !== 'turn/completed') return;
    const usage = this.turnMemoryUsage.get(notification.turnId);
    this.turnMemoryUsage.delete(notification.turnId);
    if (
      !usage
      || usage.threadId !== notification.threadId
      || usage.nodeIds.size === 0
      || notification.turn.status !== 'completed'
    ) return;
    for (const response of notification.turn.items) {
      if (
        response.type !== 'agentMessage'
        || (response.phase !== 'final_answer' && response.phase !== null)
        || !response.text.trim()
      ) continue;
      const citedNodeIds = new Set(renderedMarkdownNodeReferenceIds(response.text));
      for (const nodeId of usage.nodeIds) {
        if (!citedNodeIds.has(nodeId)) continue;
        this.control.recordCitationUsage({
          citationItemId: response.id,
          citationTurnId: notification.turnId,
          nodeId,
          originItemIds: this.control.lineageForNode(nodeId)
            .filter((edge) => this.control.isOriginClaimed(edge.originItemId))
            .map((edge) => edge.originItemId),
        });
      }
    }
  }

  onThreadIdle(thread: Thread): void {
    if (this.initialized) this.requirePipeline().wakeThread(thread);
  }

  prepareHistoryRollback(context: ThreadHistoryRollbackContext): Promise<void> {
    return this.timeline.withWriteGate(async () => {
      const suppression = this.control.generatedNodeIdsSupportedOnlyByTurns(context.omittedTurnIds);
      this.control.prepareRollback({
        rollbackId: context.rollbackId,
        threadId: context.threadId,
        omittedTurnIds: context.omittedTurnIds,
        beforeVersion: context.beforeProjectionVersion,
        afterVersion: context.afterProjectionVersion,
        suppressedNodeIds: suppression.nodeIds,
        suppressAllGenerated: !suppression.complete,
      });
    });
  }

  abortHistoryRollback(context: ThreadHistoryRollbackContext): void {
    this.control.abortRollback(context.rollbackId);
  }

  commitHistoryRollback(context: ThreadHistoryRollbackContext): void {
    this.control.commitRollback(context.rollbackId);
    if (this.initialized) {
      this.requirePipeline().wakeThread(this.requireHost().readThread({ threadId: context.threadId, includeTurns: true }).thread);
      this.requirePipeline().wakeGlobal('history-rollback');
    }
  }

  projectionChanged(delivery: { readonly update: ProjectionUpdate; readonly operation?: Operation }): void {
    const update = delivery.update;
    if (update.kind === 'delta' && update.changedNodes.length === 0 && update.removedIds.length === 0) return;
    const indexUpdate = this.applyProjectionUpdate(update);
    if (isMemoryPublication(delivery.operation)) return;
    const affected = new Set(indexUpdate.affectedCanonicalNodeIds);
    if (indexUpdate.fullRebuild) {
      for (const nodeId of this.control.generatedNodeIds()) affected.add(nodeId);
    }
    const changed = this.reconcileGeneratedNodes(affected);
    this.scheduleDeferredGraphChange(changed);
  }

  private applyProjectionUpdate(update: ProjectionUpdate): MemoryMutationIndexUpdate {
    if (!this.mutationIndex) {
      const projection = update.kind === 'full' ? update.projection : this.timeline.projection();
      this.mutationIndex = new MemoryMutationIndex(projection);
      return {
        affectedCanonicalNodeIds: this.mutationIndex.allCanonicalNodeIds(),
        fullRebuild: true,
      };
    }
    return this.mutationIndex.applyProjectionUpdate(update);
  }

  private reconcileGeneratedNodes(affectedNodeIds: ReadonlySet<string>): boolean {
    if (affectedNodeIds.size === 0) return false;
    const generatedById = this.control.generatedNodesById();
    const index = this.mutationIndex;
    if (!index) return false;
    let changed = false;
    for (const nodeId of affectedNodeIds) {
      const generated = generatedById.get(nodeId);
      if (!generated) continue;
      const entry = index.canonicalNode(nodeId);
      if (!entry) {
        this.control.removeGeneratedNode(nodeId);
        changed = true;
        continue;
      }
      if (
        generated.userAuthoritative
        || generated.fingerprint === timelineNodeFingerprint(entry)
      ) continue;
      this.control.markNodeUserAuthoritative(nodeId);
      changed = true;
    }
    return changed;
  }

  private scheduleDeferredGraphChange(forceWake: boolean): void {
    if (this.workerStopping || this.workerStopped || this.storeClosed) return;
    this.graphChangePending = true;
    this.graphChangeForcesWake ||= forceWake;
    if (this.graphChangeTimer) return;
    this.graphChangeTimer = setTimeout(() => this.flushDeferredGraphChange(), 500);
    this.graphChangeTimer.unref?.();
  }

  private flushDeferredGraphChange(): void {
    if (this.graphChangeTimer) clearTimeout(this.graphChangeTimer);
    this.graphChangeTimer = undefined;
    if (!this.graphChangePending) return;
    const forceWake = this.graphChangeForcesWake;
    this.graphChangePending = false;
    this.graphChangeForcesWake = false;
    if (this.workerStopped || this.storeClosed) return;
    let shouldWake = forceWake;
    try {
      const digest = this.currentCanonicalGraphDigest();
      this.graphDigestComputations += 1;
      if (digest !== this.lastGraphDigest) {
        this.lastGraphDigest = digest;
        shouldWake = true;
      }
    } catch (error) {
      this.reportDeferredGraphError(error, 'graph-digest');
      shouldWake = true;
    }
    if (shouldWake && this.initialized) {
      try {
        this.requirePipeline().wakeGlobal('memory-graph-changed');
      } catch (error) {
        this.reportDeferredGraphError(error, 'graph-wake');
      }
    }
  }

  private currentCanonicalGraphDigest(): string {
    return canonicalGraphDigest(
      this.mutationIndex?.canonicalNodesInGraphOrder() ?? this.timeline.graph().nodes,
    );
  }

  private reportDeferredGraphError(
    error: unknown,
    operation: 'graph-digest' | 'graph-wake',
  ): void {
    try {
      this.options.onError?.(error, operation);
    } catch {
      // Error reporting must not escape a timer callback or the shutdown path.
    }
  }

  private visibleMemoryNodes() {
    const generated = new Set(this.control.generatedNodes()
      .filter((entry) => !entry.userAuthoritative)
      .map((entry) => entry.nodeId));
    const view = this.visibilityView();
    const canonical = this.mutationIndex?.canonicalNodesInGraphOrder() ?? this.timeline.graph().nodes;
    return canonical.filter((entry) => {
      if (!generated.has(entry.node.id)) return true;
      return !view.suppressAllGenerated && !view.suppressedGeneratedNodeIds.has(entry.node.id);
    });
  }

  private visibilityView(): MemoryVisibilityView {
    const active = this.control.activeRollbacks();
    const unsupported = this.control.generatedNodeIdsWithoutCurrentSupport();
    return {
      generation: this.control.status().memoryVisibilityGeneration,
      suppressAllGenerated: active.some((entry) => entry.suppressAllGenerated),
      suppressedGeneratedNodeIds: new Set([
        ...active.flatMap((entry) => entry.suppressedNodeIds),
        ...unsupported,
      ]),
    };
  }

  private currentTurn(threadId: ThreadId): Turn | null {
    const turns = this.requireHost().readThread({ threadId, includeTurns: true }).thread.turns ?? [];
    return [...turns].reverse().find((turn) => turn.status === 'inProgress') ?? null;
  }

  private reconcileRollbackHooks(host: MemoryThreadHost): void {
    for (const rollback of this.control.activeRollbacks()) {
      if (rollback.status !== 'prepared') continue;
      const marker = host.historyRollbackMarker(rollback.rollbackId);
      if (marker && rollbackMatchesMarker(rollback, marker)) this.control.commitRollback(rollback.rollbackId);
      else this.control.abortRollback(rollback.rollbackId);
    }
  }

  private async recoverPreparedReset(record: MemoryPublicationRecord, receiptMatches: boolean): Promise<void> {
    const payload = resetPublicationPayload(record.payload);
    await this.timeline.withWriteGate(async () => {
      if (!receiptMatches) {
        await this.timeline.resetWithinWriteGate(
          record.id,
          record.generation,
          record.digest,
          payload.containerIds,
        );
      }
      this.control.finalizeReset(record.id, payload.epoch, payload.excludedTurnIds);
    });
  }

  private consolidationSource(): Thread | null {
    return this.requireHost().persistentRootThreads().find((thread) => thread.threadSource === 'user') ?? null;
  }

  private requireHost(): MemoryThreadHost {
    if (!this.host) throw new Error('Memory extension is not bound to ThreadService');
    return this.host;
  }

  private requirePipeline(): MemoryPipeline {
    if (!this.pipeline) throw new Error('Memory extension is not bound to ThreadService');
    return this.pipeline;
  }
}

function turnHasExplicitMemoryIntent(turn: Turn): boolean {
  return turn.items.some((item) => item.type === 'userMessage' && item.content.some((part) => (
    part.type === 'text' && EXPLICIT_MEMORY_INTENT.test(part.text)
  )));
}

function isMemoryPublication(operation: Operation | undefined): boolean {
  return operation?.source?.kind === 'automation'
    && operation.source.label?.startsWith('Memory publication generation ') === true;
}

function outlineShowNodeIds(context: ToolLifecycleResult): ReadonlySet<string> {
  if (
    context.identity.namespace !== null
    || context.identity.name !== 'bash'
    || context.error !== null
    || !isRecord(context.arguments)
    || typeof context.arguments.command !== 'string'
  ) return new Set();
  const invocation = directOutlineShellInvocation(context.arguments.command);
  if (!invocation || invocation.command !== 'show' || invocation.output !== 'json') return new Set();
  const stdout = successfulBashStdout(context.result);
  if (stdout === null) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return new Set();
  }
  if (
    !checkOutlineSchema(OutlineResponseSchema, parsed)
    || !parsed.ok
    || parsed.command !== 'show'
    || !checkOutlineSchema(ProjectionResultSchema, parsed.data)
  ) return new Set();
  const projection: ProjectionResult = parsed.data;
  return new Set(projection.nodes.flatMap((node) => (
    isRecord(node) && typeof node.id === 'string' && node.id.trim() ? [node.id] : []
  )));
}

function successfulBashStdout(value: unknown): string | null {
  if (
    !isRecord(value)
    || value.ok !== true
    || value.tool !== 'bash'
    || !isRecord(value.data)
    || typeof value.data.stdout !== 'string'
    || value.data.interrupted === true
    || value.data.outputLimitExceeded === true
    || value.data.backgroundTaskId !== undefined
  ) return null;
  return value.data.stdout.trim();
}

function canonicalGraphDigest(nodes: readonly CanonicalMemoryNode[]): string {
  return timelineDigest(nodes.map((entry) => ({
    id: entry.node.id,
    parentId: entry.node.parentId ?? null,
    category: entry.category,
    sourceDate: entry.sourceDate,
    containerId: entry.containerId,
    episodeId: entry.episodeId,
    tags: entry.node.tags,
    text: entry.node.content.text,
  })));
}

function rollbackMatchesMarker(
  rollback: MemoryRollbackRecord,
  marker: NonNullable<ReturnType<MemoryThreadHost['historyRollbackMarker']>>,
): boolean {
  return rollback.threadId === marker.threadId
    && rollback.beforeVersion === marker.beforeProjectionVersion
    && rollback.afterVersion === marker.afterProjectionVersion
    && rollback.omittedTurnIds.length === marker.omittedTurnIds.length
    && rollback.omittedTurnIds.every((turnId, index) => turnId === marker.omittedTurnIds[index]);
}

const MEMORY_OPERATION_CONTEXT = `Durable Memory is stored as ordinary editable Nodes under source-date Daily Notes.
The canonical hierarchy is one direct #d-memory container under a Daily Note, direct #d-episode children, and optional #d-belief, #d-question, or #d-guidance descendants.
When prior preferences, decisions, commitments, unresolved questions, or recurring workflow facts could materially improve the response, use outline find to locate relevant Memory and inspect only the one or two most relevant results with outline --json show before relying on them. Skip Memory lookup for self-contained requests such as the current date or time, simple formatting or transformation, and questions fully answerable from the current Turn.
When a final answer relies on an ordinary Memory Node you read, cite it inline next to the relevant claim as [[node://UUID]], removing the internal node: prefix. Do not add a separate sources or used-memory section.
Use the public outline workflow only when the user explicitly asks to remember, update, or forget durable information. Reuse a same-date canonical container when present, apply the fixed tag IDs tag:d-memory, tag:d-episode, tag:d-belief, tag:d-question, and tag:d-guidance, and keep the hierarchy valid.
Do not create unsolicited Memory, do not treat routine transcript narration as Memory, and do not modify stray reserved-tag Nodes outside the canonical hierarchy.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resetPublicationPayload(value: unknown): ResetPublicationPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Memory Reset publication payload is invalid');
  }
  const record = value as Record<string, unknown>;
  const epoch = record.epoch;
  const excludedTurnIds = record.excludedTurnIds;
  const containerIds = record.containerIds;
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 1) throw new Error('Memory Reset epoch is invalid');
  if (!Array.isArray(excludedTurnIds) || excludedTurnIds.some((turnId) => typeof turnId !== 'string' || !turnId)) {
    throw new Error('Memory Reset exclusions are invalid');
  }
  if (!Array.isArray(containerIds) || containerIds.some((nodeId) => typeof nodeId !== 'string' || !nodeId)) {
    throw new Error('Memory Reset container IDs are invalid');
  }
  return {
    epoch: Number(epoch),
    excludedTurnIds: Object.freeze([...new Set(excludedTurnIds as string[])]),
    containerIds: Object.freeze([...new Set(containerIds as string[])]),
  };
}

export type { ResetPublicationPayload };
