import type { DocumentCommand } from '../../../../core/commands';
import { parseNodeReferenceMarkers } from '../../../../core/referenceMarkup';
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
  MEMORY_TAG_DEFINITIONS,
  type MemoryFeatureMode,
  type MemorySettingsView,
  type ThreadMemoryMode,
} from '../../../../core/agent/memory';
import type {
  AgentCoreNotification,
  AgentMutationCausation,
  Thread,
  ThreadId,
  Turn,
  TurnId,
} from '../../../../core/agent/protocol';
import { TAG_DAY_ID, TRASH_ID, type DocumentProjection, type NodeProjection } from '../../../../core/types';
import type { DocumentMutationMeta } from '../../../documentService';
import { uuidV7 } from '../../uuid';
import {
  MemoryControlStore,
  type MemoryPublicationRecord,
  type MemoryRollbackRecord,
} from './MemoryControlStore';
import { MemoryPipeline, type MemoryPipelineSourceHost, phase1Source } from './MemoryPipeline';
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

const MAX_TRACKED_MEMORY_READS = 8;
const EXPLICIT_MEMORY_INTENT = /\b(?:remember|forget)\b|\b(?:save|store|add|update|change|remove|delete)\b[^\n]{0,80}\bmemory\b|\bmemory\b[^\n]{0,80}\b(?:save|store|add|update|change|remove|delete)\b|记住|请记|帮我记|保存.{0,20}记忆|记忆.{0,20}(?:保存|添加|更新|修改|删除|移除)|忘掉|忘记/iu;

interface ResetPublicationPayload {
  readonly epoch: number;
  readonly excludedTurnIds: readonly TurnId[];
  readonly containerIds: readonly string[];
}

export interface MemoryThreadHost extends ThreadServiceExtensionHost {
  persistentRootThreads(): readonly Thread[];
  activeRootUserTurns(): readonly { threadId: ThreadId; turnId: TurnId }[];
  interruptRootTurns(turns: readonly { threadId: ThreadId; turnId: TurnId }[]): Promise<void>;
  readThread(input: { threadId: ThreadId; includeTurns: true }): { thread: Thread };
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

export interface MemoryDocumentPolicy {
  authorizeMutation(
    command: DocumentCommand,
    args: Readonly<Record<string, unknown>>,
    meta: DocumentMutationMeta,
    projection: DocumentProjection,
  ): boolean;
  filterProjection(projection: DocumentProjection, causation: AgentMutationCausation): DocumentProjection;
  documentChanged(operationId?: string): void;
}

interface TurnMemoryUsage {
  readonly nodeIds: Set<string>;
  readonly threadId: ThreadId;
}

export class MemoryExtension implements AgentCoreExtension, MemoryDocumentPolicy {
  readonly id = MEMORY_EXTENSION_ID;
  private host: MemoryThreadHost | null = null;
  private pipeline: MemoryPipeline | null = null;
  private preparedForTurnAdmission = false;
  private initialized = false;
  private workerStopped = false;
  private storeClosed = false;
  private readonly turnMemoryUsage = new Map<TurnId, TurnMemoryUsage>();
  private lastGraphDigest = '';

  constructor(
    private readonly control: MemoryControlStore,
    private readonly timeline: TimelineMemoryStore,
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

  async prepareForTurnAdmission(): Promise<void> {
    if (this.preparedForTurnAdmission) return;
    const host = this.requireHost();
    await this.timeline.ensureTagDefinitions();
    this.reconcileRollbackHooks(host);
    this.control.deleteOrphanAdmissions(new Set(host.persistentRootThreads().flatMap((thread) => (
      host.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.map((turn) => turn.id) ?? []
    ))));
    this.lastGraphDigest = canonicalGraphDigest(this.timeline);
    await this.requirePipeline().recover();
    this.preparedForTurnAdmission = true;
  }

  async startWorker(): Promise<void> {
    if (this.initialized) return;
    await this.prepareForTurnAdmission();
    await this.requirePipeline().start();
    this.initialized = true;
  }

  async stopWorker(): Promise<void> {
    if (this.workerStopped) return;
    await this.pipeline?.close();
    this.workerStopped = true;
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
    this.turnMemoryUsage.delete(activeTurn.id);
    const admission = this.control.admission(activeTurn.id);
    const explicitlyRequested = activeTurn.provenance.trigger.kind === 'user' && turnHasExplicitMemoryIntent(activeTurn);
    if (!admission?.eligibleAtAdmission || this.control.isTurnExcluded(activeTurn.id)) {
      return explicitlyRequested ? {
        extensionId: this.id,
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
      return explicitlyRequested ? {
        extensionId: this.id,
        additionalContext: {
          memory: {
            kind: 'application' as const,
            value: 'Memory became unavailable for this Turn. Do not mutate Memory Nodes. Tell the user to retry after Memory is enabled.',
          },
        },
      } : null;
    }
    this.turnMemoryUsage.set(activeTurn.id, {
      nodeIds: new Set(),
      threadId: thread.id,
    });
    return {
      extensionId: this.id,
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
    if (
      !usage
      || usage.threadId !== context.threadId
      || context.identity.namespace !== null
      || context.identity.name !== 'node_read'
      || context.error !== null
      || !successfulNodeRead(context.result)
    ) return;

    const requestedNodeIds = nodeReadRequestIds(context.arguments);
    if (requestedNodeIds.length === 0) return;
    const returnedNodeIds = nodeReadResultIds(context.result);
    let visible: Map<string, CanonicalMemoryNode>;
    try {
      visible = new Map(this.visibleMemoryNodes().map((entry) => [entry.node.id, entry]));
    } catch {
      return;
    }
    for (const nodeId of requestedNodeIds) {
      if (usage.nodeIds.size >= MAX_TRACKED_MEMORY_READS) break;
      if (usage.nodeIds.has(nodeId) || !returnedNodeIds.has(nodeId)) continue;
      const entry = visible.get(nodeId);
      if (!entry) continue;
      usage.nodeIds.add(nodeId);
    }
  }

  onNotification(notification: AgentCoreNotification): void {
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
      const citedNodeIds = new Set(parseNodeReferenceMarkers(response.text).map((marker) => marker.nodeId));
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

  authorizeMutation(
    command: DocumentCommand,
    args: Readonly<Record<string, unknown>>,
    meta: DocumentMutationMeta,
    projection: DocumentProjection,
  ): boolean {
    const generatedNodeIds = new Set(this.control.generatedNodes().map((entry) => entry.nodeId));
    if (!memoryGraphMayChange(command, args, projection, this.timeline, generatedNodeIds)) return false;
    const origin = meta.origin ?? 'user';
    if (origin === 'user' && !meta.causation) {
      return true;
    }
    if (origin === 'system' && meta.operationId?.startsWith('memory:')) return true;
    const causation = meta.causation;
    if (!causation) throw new Error('Memory Nodes can be changed only by the user or an authorized foreground Turn');
    const admission = this.control.admission(causation.turnId);
    const status = this.control.status();
    const turn = this.turn(causation.threadId, causation.turnId);
    const thread = this.requireHost().readThread({ threadId: causation.threadId, includeTurns: true }).thread;
    if (
      !admission?.eligibleAtAdmission
      || admission.resetEpoch !== status.resetEpoch
      || admission.featureModeGeneration !== status.featureModeGeneration
      || this.control.isTurnExcluded(causation.turnId)
      || status.featureMode !== 'enabled'
      || thread.parentThreadId !== null
      || thread.threadSource !== 'user'
      || turn?.provenance.trigger.kind !== 'user'
      || !turnHasExplicitMemoryIntent(turn)
    ) {
      throw new Error('This Turn is not authorized to change Memory Nodes');
    }
    return true;
  }

  filterProjection(projection: DocumentProjection, causation: AgentMutationCausation): DocumentProjection {
    const explicit = this.explicitNodeReferences(causation.threadId, causation.turnId);
    const graph = this.timeline.graph(projection);
    const generated = new Set(this.control.generatedNodes()
      .filter((entry) => !entry.userAuthoritative)
      .map((entry) => entry.nodeId));
    const admission = this.control.admission(causation.turnId);
    const implicitEnabled = Boolean(admission?.eligibleAtAdmission)
      && !this.control.isTurnExcluded(causation.turnId)
      && this.control.featureMode() === 'enabled'
      && admission?.featureModeGeneration === this.control.status().featureModeGeneration;
    const visible = implicitEnabled
      ? new Set(this.timeline.visibleNodes(this.visibilityView(), generated).map((entry) => entry.node.id))
      : new Set<string>();
    const canonical = new Set(graph.nodes.map((entry) => entry.node.id));
    const explicitExpanded = expandExplicitReferences(explicit, projection.nodes);
    const hidden = new Set([...canonical].filter((nodeId) => !visible.has(nodeId) && !explicitExpanded.has(nodeId)));
    if (hidden.size === 0) return projection;
    return filteredProjection(projection, hidden);
  }

  documentChanged(operationId?: string): void {
    if (operationId?.startsWith('memory:')) return;
    let changed = false;
    const graph = new Map(this.timeline.graph().nodes.map((entry) => [entry.node.id, entry]));
    for (const generated of this.control.generatedNodes()) {
      const entry = graph.get(generated.nodeId);
      if (!entry) {
        this.control.removeGeneratedNode(generated.nodeId);
        changed = true;
        continue;
      }
      if (generated.fingerprint === timelineNodeFingerprint(entry)) continue;
      this.control.markNodeUserAuthoritative(generated.nodeId);
      changed = true;
    }
    const digest = canonicalGraphDigest(this.timeline);
    if (changed || digest !== this.lastGraphDigest) {
      this.lastGraphDigest = digest;
      if (this.initialized) this.requirePipeline().wakeGlobal('memory-graph-changed');
    }
  }

  private visibleMemoryNodes() {
    const generated = new Set(this.control.generatedNodes()
      .filter((entry) => !entry.userAuthoritative)
      .map((entry) => entry.nodeId));
    return this.timeline.visibleNodes(this.visibilityView(), generated);
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

  private turn(threadId: ThreadId, turnId: TurnId): Turn | null {
    return this.requireHost().readThread({ threadId, includeTurns: true }).thread.turns?.find((turn) => turn.id === turnId) ?? null;
  }

  private explicitNodeReferences(threadId: ThreadId, turnId: TurnId): ReadonlySet<string> {
    const turn = this.turn(threadId, turnId);
    return new Set(turn?.items.flatMap((item) => item.type === 'userMessage'
      ? item.content.flatMap((part) => part.type === 'nodeReference' ? [part.nodeId] : [])
      : []) ?? []);
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

function memoryGraphMayChange(
  command: DocumentCommand,
  args: Readonly<Record<string, unknown>>,
  projection: DocumentProjection,
  timeline: TimelineMemoryStore,
  generatedNodeIds: ReadonlySet<string>,
): boolean {
  const reservedTagIds = new Set<string>(MEMORY_TAG_DEFINITIONS.map((entry) => entry.tagId));
  const index = new Map(projection.nodes.map((node) => [node.id, node]));
  if (commandUsesReservedTag(command, args, projection.nodes, index, reservedTagIds)) return true;
  const reservedTaggedNodes = projection.nodes.filter((node) => node.tags.some((tagId) => reservedTagIds.has(tagId)));
  const reservedTaggedIds = new Set(reservedTaggedNodes.map((node) => node.id));
  const protectedAncestors = new Set<string>();
  for (const tagged of reservedTaggedNodes) {
    let current = tagged.parentId ? index.get(tagged.parentId) : undefined;
    while (current && !protectedAncestors.has(current.id)) {
      protectedAncestors.add(current.id);
      current = current.parentId ? index.get(current.parentId) : undefined;
    }
  }
  const graph = timeline.graph(projection);
  const owned = new Set<string>();
  for (const container of graph.containers) {
    addDescendants(container.node.id, index, owned);
    let current: NodeProjection | undefined = container.node.parentId
      ? index.get(container.node.parentId)
      : undefined;
    while (current) {
      protectedAncestors.add(current.id);
      current = current.parentId ? index.get(current.parentId) : undefined;
    }
  }
  const direct = (key: string) => typeof args[key] === 'string' ? args[key] as string : null;
  const directArray = (key: string) => Array.isArray(args[key])
    ? (args[key] as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  const changesOwned = (...nodeIds: Array<string | null>) => nodeIds.some((nodeId) => (
    nodeId !== null && owned.has(nodeId)
  ));
  const changesIdentity = (...nodeIds: Array<string | null>) => nodeIds.some((nodeId) => (
    nodeId !== null && (owned.has(nodeId) || protectedAncestors.has(nodeId))
  ));
  const changesStructure = (...nodeIds: Array<string | null>) => nodeIds.some((nodeId) => (
    nodeId !== null && (owned.has(nodeId) || reservedTaggedIds.has(nodeId) || protectedAncestors.has(nodeId))
  ));
  const createsInsideMemory = (parentId: string | null) => parentId !== null && owned.has(parentId);
  const changesOwnedArray = (key: string) => directArray(key).some((nodeId) => changesOwned(nodeId));
  const changesStructureArray = (key: string) => directArray(key).some((nodeId) => changesStructure(nodeId));
  const changesDayIdentity = (...nodeIds: Array<string | null>) => direct('tagId') === TAG_DAY_ID
    && nodeIds.some((nodeId) => nodeId !== null && protectedAncestors.has(nodeId));
  const historyNodeIsProtected = (nodeId: string) => owned.has(nodeId)
    || reservedTaggedIds.has(nodeId)
    || protectedAncestors.has(nodeId)
    || reservedTagIds.has(nodeId)
    || generatedNodeIds.has(nodeId);

  switch (command) {
    case 'get_projection':
    case 'search_nodes':
    case 'backlinks':
    case 'create_tag':
    case 'create_field_definition':
    case 'ensure_date_node':
    case 'ensure_tag_search':
      return false;
    case 'init_workspace':
      return owned.size > 0 || reservedTaggedIds.size > 0;
    case 'create_node':
      return changesOwned(direct('id')) || createsInsideMemory(direct('parentId'));
    case 'create_rich_text_node':
    case 'create_tagged_node':
    case 'create_tag_and_tagged_node':
    case 'create_nodes_from_tree':
    case 'create_image_node':
    case 'create_attachment_node':
    case 'create_search_node':
      return createsInsideMemory(direct('parentId'));
    case 'create_capture': {
      const input = args.input && typeof args.input === 'object' && !Array.isArray(args.input)
        ? args.input as Record<string, unknown>
        : {};
      return createsInsideMemory(typeof input.destinationParentId === 'string' ? input.destinationParentId : null);
    }
    case 'paste_nodes_into_node':
    case 'update_node_description':
    case 'set_node_checkbox_visible':
    case 'set_code_block':
    case 'set_code_language':
    case 'set_node_image':
    case 'set_view_toolbar_visible':
    case 'set_view_mode':
    case 'clear_sort_rules':
    case 'clear_filter_rules':
    case 'set_group_field':
    case 'add_display_field':
    case 'set_node_icon':
    case 'set_node_banner':
    case 'toggle_done':
    case 'cycle_done_state':
    case 'set_search_node':
    case 'set_search_query_outline':
    case 'refresh_search_node_results':
      return changesOwned(direct('nodeId'));
    case 'apply_node_text_patch':
      return changesIdentity(direct('nodeId'));
    case 'split_node':
      return changesStructure(direct('nodeId')) || createsInsideMemory(direct('targetParentId'));
    case 'add_sort_rule':
    case 'add_filter_rule':
      return changesOwned(direct('nodeId'), direct('field'));
    case 'update_sort_rule':
    case 'update_filter_rule':
    case 'remove_sort_rule':
    case 'remove_filter_rule':
      return changesOwned(direct('ruleId'), direct('field'));
    case 'update_display_field':
    case 'remove_display_field':
      return changesOwned(direct('displayFieldId'), direct('field'));
    case 'merge_node_into':
      return changesStructure(direct('nodeId'), direct('targetId'));
    case 'move_node':
      return changesStructure(direct('nodeId')) || createsInsideMemory(direct('parentId'));
    case 'batch_move_nodes':
      return Array.isArray(args.moves) && args.moves.some((move) => {
        if (!move || typeof move !== 'object' || Array.isArray(move)) return true;
        const entry = move as Record<string, unknown>;
        return changesStructure(typeof entry.nodeId === 'string' ? entry.nodeId : null)
          || createsInsideMemory(typeof entry.parentId === 'string' ? entry.parentId : null);
      });
    case 'indent_node': {
      const nodeId = direct('nodeId');
      const node = nodeId ? index.get(nodeId) : undefined;
      const siblings = node?.parentId ? index.get(node.parentId)?.children ?? [] : [];
      const position = node ? siblings.indexOf(node.id) : -1;
      const previousSiblingId = position > 0 ? siblings[position - 1] ?? null : null;
      return changesStructure(nodeId) || createsInsideMemory(previousSiblingId);
    }
    case 'outdent_node':
    case 'trash_node':
    case 'restore_node':
    case 'delete_node':
      return changesStructure(direct('nodeId'));
    case 'batch_trash_nodes':
    case 'batch_outdent_nodes':
    case 'batch_duplicate_nodes':
      return changesStructureArray('nodeIds');
    case 'batch_indent_nodes':
      return directArray('nodeIds').some((nodeId) => {
        const node = index.get(nodeId);
        const siblings = node?.parentId ? index.get(node.parentId)?.children ?? [] : [];
        const position = node ? siblings.indexOf(node.id) : -1;
        return changesStructure(nodeId) || createsInsideMemory(position > 0 ? siblings[position - 1] ?? null : null);
      });
    case 'batch_toggle_done':
    case 'batch_cycle_done_state':
    case 'batch_move_nodes_up':
    case 'batch_move_nodes_down':
      return changesOwnedArray('nodeIds');
    case 'batch_apply_tag':
      return changesOwnedArray('nodeIds') || changesDayIdentity(...directArray('nodeIds'));
    case 'apply_tag':
    case 'remove_tag':
      return changesOwned(direct('nodeId')) || changesDayIdentity(direct('nodeId'));
    case 'set_tag_config':
      return changesOwned(direct('tagId'));
    case 'set_field_config':
      return changesOwned(direct('fieldId'));
    case 'create_field_def':
      return changesOwned(direct('tagId'));
    case 'create_inline_field_after_node':
      return changesOwned(direct('afterNodeId'));
    case 'create_inline_field':
      return createsInsideMemory(direct('parentId')) || changesOwned(direct('targetDefId'));
    case 'reuse_field_definition':
      return changesOwned(direct('entryId'), direct('targetDefId'));
    case 'merge_definitions':
      return changesOwned(direct('targetId')) || changesOwnedArray('sourceIds');
    case 'register_collected_option':
      return changesOwned(direct('fieldDefId'));
    case 'create_collected_field_option':
      return changesOwned(direct('fieldEntryId'), direct('id'));
    case 'select_field_option':
      return changesOwned(direct('fieldEntryId'), direct('id'));
    case 'set_field_free_text_value':
      return changesOwned(direct('fieldEntryId'), direct('id'));
    case 'clear_field_value':
      return changesOwned(direct('fieldEntryId'));
    case 'remove_field_value':
      return changesOwned(direct('valueId'));
    case 'add_reference':
    case 'add_reference_conversion':
      return createsInsideMemory(direct('parentId'));
    case 'set_reference_target':
      return changesOwned(direct('referenceId'));
    case 'replace_node_with_reference':
    case 'replace_node_with_reference_conversion':
    case 'replace_node_with_inline_reference':
    case 'restore_inline_reference_node_to_reference':
      return changesStructure(direct('nodeId'));
    case 'convert_reference_to_inline_node':
      return changesStructure(direct('referenceId'));
    case 'undo':
    case 'redo':
      return historyMutationMayChangeMemory(args.historyMutation, historyNodeIsProtected);
    default:
      return true;
  }
}

function historyMutationMayChangeMemory(
  value: unknown,
  nodeIsProtected: (nodeId: string) => boolean,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const context = value as Record<string, unknown>;
  if (context.status === 'none') {
    return !Array.isArray(context.targets) || context.targets.length > 0;
  }
  if (context.status !== 'known' || !Array.isArray(context.targets)) return true;
  if (context.targets.length === 0) return true;

  for (const valueTarget of context.targets) {
    if (!valueTarget || typeof valueTarget !== 'object' || Array.isArray(valueTarget)) return true;
    const target = valueTarget as Record<string, unknown>;
    if (
      typeof target.operationId !== 'string'
      || !Array.isArray(target.affectedNodeIds)
      || !target.affectedNodeIds.every((nodeId) => typeof nodeId === 'string')
      || typeof target.affectedNodeCount !== 'number'
      || !Number.isInteger(target.affectedNodeCount)
      || target.affectedNodeCount < 0
      || target.affectedNodeCount !== target.affectedNodeIds.length
      || (target.affectedNodeIdsTruncated !== undefined && typeof target.affectedNodeIdsTruncated !== 'boolean')
      || target.affectedNodeIdsTruncated === true
      || typeof target.affectsMemory !== 'boolean'
    ) {
      return true;
    }
    if (target.affectsMemory || (target.affectedNodeIds as string[]).some(nodeIsProtected)) return true;
  }
  return false;
}

function commandUsesReservedTag(
  command: DocumentCommand,
  args: Readonly<Record<string, unknown>>,
  nodes: readonly NodeProjection[],
  index: ReadonlyMap<string, NodeProjection>,
  reservedTagIds: ReadonlySet<string>,
): boolean {
  if (
    (command === 'create_tagged_node'
      || command === 'apply_tag'
      || command === 'remove_tag'
      || command === 'batch_apply_tag')
    && typeof args.tagId === 'string'
    && reservedTagIds.has(args.tagId)
  ) {
    return true;
  }

  const activeDefinitions = nodes.filter((node) => (
    node.type === 'tagDef' && !projectionNodeIsInTrash(node, index)
  ));
  const firstDefinitionByName = new Map<string, string>();
  const materializedDefinitionByName = new Map<string, string>();
  for (const definition of activeDefinitions) {
    const key = definitionNameKey(definition.content.text);
    if (!key) continue;
    if (!firstDefinitionByName.has(key)) firstDefinitionByName.set(key, definition.id);
    materializedDefinitionByName.set(key, definition.id);
  }
  const resolvesToReserved = (name: unknown, definitions: ReadonlyMap<string, string>) => (
    typeof name === 'string' && reservedTagIds.has(definitions.get(definitionNameKey(name)) ?? '')
  );
  const materializedNameIsReserved = (name: unknown) => resolvesToReserved(name, materializedDefinitionByName);

  switch (command) {
    case 'create_tag_and_tagged_node':
      return resolvesToReserved(args.name, firstDefinitionByName);
    case 'create_nodes_from_tree':
      return createNodeTreesUseReservedTag(args.nodes, materializedNameIsReserved);
    case 'paste_nodes_into_node':
      return pasteRowMetaUsesReservedTag(args.firstMeta, materializedNameIsReserved)
        || createNodeTreesUseReservedTag(args.children, materializedNameIsReserved)
        || createNodeTreesUseReservedTag(args.siblingsAfter, materializedNameIsReserved);
    default:
      return false;
  }
}

function createNodeTreesUseReservedTag(
  value: unknown,
  nameIsReserved: (name: unknown) => boolean,
): boolean {
  if (!Array.isArray(value)) return false;
  const pending = [...value];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const tree = entry as Record<string, unknown>;
    if (pasteRowMetaUsesReservedTag(tree, nameIsReserved)) return true;
    if (Array.isArray(tree.children)) pending.push(...tree.children);
  }
  return false;
}

function pasteRowMetaUsesReservedTag(
  value: unknown,
  nameIsReserved: (name: unknown) => boolean,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const tags = (value as Record<string, unknown>).tags;
  return Array.isArray(tags) && tags.some(nameIsReserved);
}

function projectionNodeIsInTrash(
  node: NodeProjection,
  index: ReadonlyMap<string, NodeProjection>,
): boolean {
  let current: NodeProjection | undefined = node;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === TRASH_ID) return true;
    visited.add(current.id);
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  return false;
}

function definitionNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function addDescendants(rootId: string, index: ReadonlyMap<string, NodeProjection>, output: Set<string>): void {
  const stack = [rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (output.has(nodeId)) continue;
    output.add(nodeId);
    stack.push(...(index.get(nodeId)?.children ?? []));
  }
}

function expandExplicitReferences(references: ReadonlySet<string>, nodes: readonly NodeProjection[]): ReadonlySet<string> {
  const index = new Map(nodes.map((node) => [node.id, node]));
  const expanded = new Set<string>();
  for (const nodeId of references) {
    addDescendants(nodeId, index, expanded);
    let current = index.get(nodeId);
    while (current) {
      expanded.add(current.id);
      current = current.parentId ? index.get(current.parentId) : undefined;
    }
  }
  return expanded;
}

function filteredProjection(projection: DocumentProjection, hidden: ReadonlySet<string>): DocumentProjection {
  return {
    ...projection,
    nodes: projection.nodes
      .filter((node) => !hidden.has(node.id))
      .map((node) => ({
        ...node,
        ...(node.parentId && hidden.has(node.parentId) ? { parentId: undefined } : {}),
        children: node.children.filter((childId) => !hidden.has(childId)),
      })),
  };
}

function canonicalGraphDigest(timeline: TimelineMemoryStore): string {
  return timelineDigest(timeline.graph().nodes.map((entry) => ({
    id: entry.node.id,
    parentId: entry.node.parentId ?? null,
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
When prior preferences, decisions, commitments, unresolved questions, or recurring workflow facts could materially improve the response, use node_search to find relevant Memory and read only the one or two most relevant results with node_read before relying on them. Skip Memory lookup for self-contained requests such as the current date or time, simple formatting or transformation, and questions fully answerable from the current Turn.
When a final answer relies on a Memory Node you read, cite that Node inline next to the relevant claim with [[node:^exact-id]]. Do not add a separate sources or used-memory section.
Use the ordinary Node tools only when the user explicitly asks to remember, update, or forget durable information. Reuse a same-date canonical container when present, apply the fixed tag IDs tag:d-memory, tag:d-episode, tag:d-belief, tag:d-question, and tag:d-guidance, and keep the hierarchy valid.
Do not create unsolicited Memory, do not treat routine transcript narration as Memory, and do not modify stray reserved-tag Nodes outside the canonical hierarchy.`;

function successfulNodeRead(value: unknown): boolean {
  return isRecord(value) && value.ok === true;
}

function nodeReadRequestIds(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  if (typeof value.node_id === 'string' && value.node_id.trim()) return [value.node_id.trim()];
  if (!Array.isArray(value.node_ids)) return [];
  return [...new Set(value.node_ids
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim()))];
}

function nodeReadResultIds(value: unknown): ReadonlySet<string> {
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.items)) return new Set();
  return new Set(value.data.items.flatMap((entry) => (
    isRecord(entry) && typeof entry.nodeId === 'string' ? [entry.nodeId] : []
  )));
}

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
