import { profileFileDigest, type ProfileFileStore } from '../../profile/ProfileFileStore';
import { isoLocalDate } from '../../../../core/localDate';
import { captureProfileTurn, captureReplayedProfileTurn, profileStateForTurn } from '../../profile/ProfileContext';
import type { ProfileFileKind, ProfileEvidence, ProfileSourceView } from '../../../../core/agent/profileFiles';
import { renderedMarkdownNodeReferenceIds } from '../../../../core/markdownNodeReferences';
import type {
  AgentCoreExtension,
  ThreadHistoryRollbackContext,
  ThreadContextInput,
  ThreadServiceExtensionHost,
  ToolLifecycleResult,
  TurnAdmissionContext,
  TurnAdmissionContribution,
} from '../../../../core/agent/extensions';
import {
  MEMORY_EXTENSION_ID,
  type MemoryFeatureMode,
  type MemoryView,
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
import { AgentToolFailure } from '../../AgentToolFailure';
import { OutlineContractError } from '../../../../outline/contract/errors';
import { MEMORY_ERROR_MAX_CHARS, type MemoryResetView, type MemoryThreadView } from '../../../../core/agent/memoryOperations';
import { captureMemoryResetTarget, decodeMemoryResetTarget, requireMatchingMemoryResetTarget, type MemoryResetTarget } from './MemoryResetTarget';
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
  memorySourcePendingDates,
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
  readonly target: MemoryResetTarget;
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
  readonly profiles?: ProfileFileStore;
  readonly canRun?: () => boolean;
  readonly restoredGeneration?: string | null;
  readonly onError?: (error: unknown, operation: 'graph-digest' | 'graph-wake' | 'profile-context') => void;
}

export class MemoryExtension implements AgentCoreExtension {
  readonly id = MEMORY_EXTENSION_ID;
  private host: MemoryThreadHost | null = null;
  private pipeline: MemoryPipeline | null = null;
  private turnAdmissionPreparation: Promise<void> | null = null;
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
      return evidence.sourceVersion === sourceVersion;
    }, this.options.profiles);
    const phase2 = new Phase2(
      this.control,
      this.timeline,
      model,
      () => this.consolidationSource(),
      { sourceReadiness: () => {
        if (host.hasHiddenRootThreads()) return { kind: 'unavailable' };
        const pendingDates = new Set<string>();
        for (const root of host.persistentRootThreads()) {
          const thread = host.readThread({ threadId: root.id, includeTurns: true }).thread;
          for (const date of memorySourcePendingDates(phase1Source(thread, thread.turns ?? []), this.control)) pendingDates.add(date);
        }
        return { kind: 'known', pendingDates };
      } },
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
      canRun: this.options.canRun,
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

  prepareForTurnAdmission(): Promise<void> {
    if (!this.turnAdmissionPreparation) {
      this.turnAdmissionPreparation = this.prepareTurnAdmission().catch((error) => {
        this.turnAdmissionPreparation = null;
        throw error;
      });
    }
    return this.turnAdmissionPreparation;
  }

  private async prepareTurnAdmission(): Promise<void> {
    const host = this.requireHost();
    await this.timeline.ensureTagDefinitions();
    // Restored pending work remains inspectable; startup cannot recreate its
    // publication authority. Fresh turns may enqueue newly authorized work.
    if (this.options.restoredGeneration) return;
    this.reconcileRollbackHooks(host);
    try { this.options.profiles?.recover(); } catch (error) { this.options.onError?.(error, 'profile-context'); }
    // The orphan sweep deletes every admission row whose Turn it cannot see, so it
    // is only sound when every durable Turn is enumerable. A quarantined Thread is
    // excluded from `persistentRootThreads()`, which would make all of its Turns
    // look orphaned and delete their admissions for good — turning a
    // session-scoped, in-memory quarantine into a permanent loss of extraction
    // state. Skip the sweep entirely for that session; the next launch that can
    // read the Thread runs it against the complete set.
    if (!host.hasHiddenRootThreads()) {
      const retainedTurnIds = new Set(host.persistentRootThreads().flatMap((thread) => (
        host.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.map((turn) => turn.id) ?? []
      )));
      this.control.deleteOrphanAdmissions(retainedTurnIds);
      try { this.options.profiles?.pruneTurnSnapshots(retainedTurnIds); }
      catch (error) { this.options.onError?.(error, 'profile-context'); }
    }
    this.lastGraphDigest = this.currentCanonicalGraphDigest();
    await this.requirePipeline().recover();
  }

  async startWorker(): Promise<void> {
    if (this.initialized) return;
    await this.prepareForTurnAdmission();
    await this.requirePipeline().start({ recoverHistoricalWork: !this.options.restoredGeneration });
    this.initialized = true;
  }

  wakeWorker(): void {
    this.pipeline?.wakePending();
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
    this.options.profiles?.close();
    this.control.close();
    this.storeClosed = true;
  }

  view(threadId: ThreadId | null = null): MemoryView {
    if (!this.mutationIndex) this.initializeMutationIndex(this.timeline.projection());
    const status = this.control.status();
    return {
      status: {
        ...status,
        lastError: status.lastError?.slice(0, MEMORY_ERROR_MAX_CHARS) ?? null,
        strayTaggedNodeCount: this.mutationIndex!.strayTaggedNodeCount(),
      },
      thread: threadId ? this.threadView(threadId) : null,
    };
  }

  subscribe(listener: () => void): () => void { return this.control.subscribe(listener); }

  threadView(threadId: ThreadId): MemoryThreadView {
    const host = this.requireHost();
    if (!host.isThreadNavigable(threadId)) throw memoryFailure('memory_thread_unavailable', 'The Thread is unavailable.');
    const thread = host.readThread({ threadId }).thread;
    if (thread.ephemeral || thread.parentThreadId !== null || thread.threadSource !== 'user') {
      throw memoryFailure('memory_thread_ineligible', 'Memory mode is only available for persistent root user Threads.');
    }
    return { threadId, mode: this.control.threadMode(threadId), revision: this.control.threadModeRevision(threadId), appliesAt: 'subsequent_admissions' };
  }

  async setFeatureMode(mode: MemoryFeatureMode): Promise<MemoryView> {
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
    return this.view();
  }

  async setThreadMode(threadId: ThreadId, mode: ThreadMemoryMode, expectedRevision: number, authorize: () => Promise<void>): Promise<MemoryThreadView> {
    const host = this.requireHost();
    let result!: MemoryThreadView;
    await host.withThreadAdmissionBarrier(threadId, async () => {
      await this.timeline.withWriteGate(async () => {
        await authorize();
        const current = this.threadView(threadId);
        if (current.revision !== expectedRevision) throw memoryFailure('stale_memory_thread', 'The Thread Memory mode changed. Inspect it again.');
        this.control.setThreadMode(threadId, mode);
        result = this.threadView(threadId);
      });
    });
    if (mode === 'enabled') {
      try { this.requirePipeline().wakeThread(host.readThread({ threadId, includeTurns: true }).thread); }
      catch (error) { console.warn('[memory] mode saved but worker wake failed', error); }
    }
    return result;
  }

  reviewReset(): MemoryResetTarget {
    const target = captureMemoryResetTarget(this.timeline.projection(), this.control.status().resetEpoch);
    return this.options.profiles ? { ...target, profile: this.options.profiles.resetTarget() } : target;
  }

  inspectReset(operationId: string): MemoryResetView {
    const record = this.control.publication(operationId);
    if (!record || record.kind !== 'reset') return { operationId, state: 'unknown', admittedAt: null, targetEpoch: null };
    const payload = resetPublicationPayload(record.payload);
    return { operationId, state: record.status, admittedAt: record.createdAt, targetEpoch: payload.epoch,
      ...(payload.target.profile ? { profileState: this.options.profiles?.receipt(`${operationId}:profile`) ? 'removed' as const : 'pending' as const } : {}),
    };
  }

  async reset(target: MemoryResetTarget, authorize: () => Promise<void>): Promise<MemoryResetView> {
    const host = this.requireHost();
    const operationId = `memory:reset:${uuidV7()}`;
    return host.withHostRootTurnAdmissionBarrier(() => this.timeline.withWriteGate(async () => {
      await authorize();
      if (this.control.preparedPublications().some((entry) => entry.kind === 'reset')) {
        throw memoryFailure('memory_reset_pending', 'An earlier Memory Reset is still awaiting settlement.');
      }
      return this.commitReviewedReset(target, authorize, operationId);
    }));
  }

  private validateProfileReset(target: MemoryResetTarget, operationId: string): void {
    if (!target.profile) return;
    const profiles = this.options.profiles;
    if (!profiles) throw new Error('Profile Reset owner is unavailable');
    if (profiles.receipt(`${operationId}:profile`)) return;
    const current = profiles.resetTarget();
    if (JSON.stringify(current) !== JSON.stringify(target.profile)) {
      throw memoryFailure('stale_memory_reset', 'The user profile changed after Reset review. Review it again.');
    }
  }

  private async commitReviewedReset(target: MemoryResetTarget, authorize: () => Promise<void>, operationId: string): Promise<MemoryResetView> {
    const host = this.requireHost();
    let record: MemoryPublicationRecord<ResetPublicationPayload> | undefined;
    const generation = this.control.allocatePublicationGeneration();
    const status = this.control.status();
    const payload: ResetPublicationPayload = {
      epoch: status.resetEpoch + 1,
      excludedTurnIds: host.activeRootUserTurns().map((entry) => entry.turnId),
      target: decodeMemoryResetTarget(target),
    };
    const digest = timelineDigest({ operationId, generation, payload });
    try {
      await this.timeline.resetWithinWriteGate(operationId, generation, digest, target.containerIds, async (projection) => {
        await authorize();
        requireMatchingMemoryResetTarget(projection, this.control.status().resetEpoch, target);
        this.validateProfileReset(target, operationId);
        const prepared: MemoryPublicationRecord<ResetPublicationPayload> = {
          id: operationId, kind: 'reset', status: 'prepared', generation,
          featureGeneration: status.featureModeGeneration, resetEpoch: status.resetEpoch,
          digest, payload, createdAt: Date.now(),
        };
        this.control.prepareReset(prepared);
        record = prepared;
        if (payload.target.profile) {
          if (!this.options.profiles) throw new Error('Profile Reset owner is unavailable');
          this.options.profiles.reset(`${operationId}:profile`, payload.target.profile);
        }
      });
      this.control.finalizeReset(operationId, payload.epoch, payload.excludedTurnIds);
    } catch (error) {
      if (!record) throw error;
      try {
        if (await this.timeline.hasPublication(operationId, digest)) {
          this.control.finalizeReset(operationId, payload.epoch, payload.excludedTurnIds);
        } else if (definitiveResetRejection(error)) {
          this.control.conflictReset(operationId);
        }
      } catch {
        return { operationId, state: 'unknown', admittedAt: record.createdAt, targetEpoch: payload.epoch };
      } finally {
        try { this.requirePipeline().wakePending(); } catch (wakeError) { console.warn('[memory] Reset wake failed', wakeError); }
      }
    }
    return this.inspectReset(operationId);
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
    if (this.options.profiles && !context.thread.ephemeral && context.thread.parentThreadId === null) {
      try {
        if (context.replayedTurnId) captureReplayedProfileTurn(this.options.profiles, context.turnId, context.replayedTurnId);
        else captureProfileTurn(this.options.profiles, context.thread.id, context.turnId, context.configuration.profileName ?? 'default', eligible);
      }
      catch (error) { this.options.onError?.(error, 'profile-context'); }
    }
    return { extensionId: this.id, snapshotId: `${status.featureModeGeneration}:${status.resetEpoch}:${status.memoryVisibilityGeneration}` };
  }

  private profileContext(thread: Thread, turnId: string) {
    if (!this.options.profiles || thread.ephemeral || thread.parentThreadId !== null) return {};
    const admission = this.control.admission(turnId);
    const learned = Boolean(admission?.eligibleAtAdmission) && this.control.featureMode() === 'enabled'
      && admission?.featureModeGeneration === this.control.status().featureModeGeneration
      && admission?.resetEpoch === this.control.status().resetEpoch && !this.control.isTurnExcluded(turnId);
    try { return profileStateForTurn(this.options.profiles, turnId, learned); }
    catch (error) { this.options.onError?.(error, 'profile-context'); return {}; }
  }

  inspectProfileFiles(profileName = 'default') {
    if (!this.options.profiles) throw new Error('Profile files are unavailable');
    return (['identity', 'style', 'user'] as const).map((kind) => this.options.profiles!.inspect(kind, profileName));
  }

  inspectProfileSource(key: string, originItemId: string): ProfileSourceView {
    const entry = this.options.profiles?.inspect('user').entries.find((entry) => entry.key === key);
    const source = entry?.sources.find((source) => source.originItemId === originItemId);
    if (!source) throw new Error('Profile evidence changed; refresh before opening its source');
    try {
      const thread = this.requireHost().readThread({ threadId: source.threadId, includeTurns: true }).thread;
      const item = thread.turns?.find((turn) => turn.id === source.turnId)?.items.find((item) => item.provenance.originItemId === source.originItemId);
      if (item) {
        const content = item.type === 'userMessage' ? item.content.map((part) => part.type === 'text' ? part.text : `[${part.type}]`).join('\n')
          : item.type === 'agentMessage' ? item.text : JSON.stringify(item, null, 2);
        return { state: 'available', source, content: content.slice(0, 16_000), truncated: content.length > 16_000 };
      }
    } catch { /* Source availability never changes accepted provenance. */ }
    return { state: 'unavailable', source, content: '', truncated: false };
  }

  editProfileFile(input: { kind: ProfileFileKind; profileName: string; expectedDigest: string | null; content: string }, authorize: () => Promise<void>) {
    return this.timeline.withWriteGate(async () => {
      await authorize();
      if (!this.options.profiles) throw new Error('Profile files are unavailable');
      return this.options.profiles.edit({ ...input, author: 'manual' });
    });
  }

  async writeProfileFile(input: { path: string; content: string; previousContent: string | null; operationId: string }, thread: Thread, turn: Turn): Promise<boolean> {
    const profiles = this.options.profiles;
    const target = profiles?.identifyPath(input.path);
    if (!profiles || !target) return false;
    if (thread.parentThreadId !== null || thread.ephemeral || thread.threadSource !== 'user' || turn.provenance.trigger.kind !== 'user') {
      throw new Error('Profile editing requires a foreground reader Turn');
    }
    const sources: ProfileEvidence[] = turn.items.filter((item) => item.type === 'userMessage' && item.author.kind === 'reader'
      && item.content.some((part) => part.type === 'text' && part.text.trim())).map((item) => ({
      threadId: thread.id, turnId: turn.id, originItemId: item.provenance.originItemId, readerText: true,
      sourceDate: isoLocalDate(new Date(turn.startedAt)), observedAt: Date.now(),
    }));
    if (!sources.length) throw new Error('Profile editing requires reader-authored text');
    await this.timeline.withWriteGate(async () => {
      profiles.edit({ ...target, content: input.content, expectedDigest: profileFileDigest(input.previousContent),
        author: 'agent', sources, operationId: `profile:file:${input.operationId}` });
    });
    return true;
  }

  contributeThreadContext(thread: Thread, input: ThreadContextInput) {
    const additionalContext = this.profileContext(thread, input.turnId);
    const admission = this.control.admission(input.turnId);
    const unavailable = !admission?.eligibleAtAdmission || this.control.isTurnExcluded(input.turnId)
      || this.control.featureMode() !== 'enabled'
      || admission.featureModeGeneration !== this.control.status().featureModeGeneration
      || admission.resetEpoch !== this.control.status().resetEpoch;
    if (unavailable) {
      this.turnMemoryUsage.delete(input.turnId);
      const explicitlyRequested = input.content.some((part) => part.type === 'text' && EXPLICIT_MEMORY_INTENT.test(part.text));
      return { extensionId: this.id, additionalContext: {
        ...additionalContext,
        ...(explicitlyRequested ? { memory: {
          kind: 'application' as const, scope: 'Memory',
          value: 'Automatic Memory is unavailable for this Turn. Do not mutate Memory Nodes or create learned profile entries. Explicitly authored configuration can still be edited through its owner.',
        } } : {}),
      } };
    }
    if (!this.turnMemoryUsage.has(input.turnId)) this.turnMemoryUsage.set(input.turnId, { nodeIds: new Set(), threadId: thread.id });
    return { extensionId: this.id, additionalContext: {
      ...additionalContext,
      memory: { kind: 'application' as const, scope: 'Memory', value: MEMORY_OPERATION_CONTEXT },
    } };
  }

  onToolCompleted(context: ToolLifecycleResult): void {
    const usage = this.turnMemoryUsage.get(context.turnId);
    if (!usage || usage.threadId !== context.threadId) return;
    const returnedNodeIds = outlineGetNodeIds(context);
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

  onThreadDeleted(thread: Thread): void {
    try { this.options.profiles?.deleteThreadState(thread.id); }
    catch (error) { this.options.onError?.(error, 'profile-context'); }
  }

  recoveryParticipant(): import('../../recovery/ThreadRecoveryService').ThreadRecoveryParticipant {
    return {
      name: 'memory-and-profile',
      withLock: (_ids, operation) => this.timeline.withWriteGate(operation),
      inspect: async (ids) => {
        const blockers: string[] = [];
        if (!this.options.profiles) blockers.push('Profile ownership is unavailable; recovery cannot verify pending learning.');
        if (this.control.activeRollbacks().some((entry) => ids.includes(entry.threadId))) {
          blockers.push('Memory rollback is pending for this conversation.');
        }
        for (const publication of this.control.preparedPublications()) {
          const threadId = (publication.payload as { threadId?: string }).threadId;
          if (publication.kind === 'stage1' && threadId && ids.includes(threadId)
            && await this.timeline.hasPublication(publication.id, publication.digest)) {
            blockers.push('A published Memory update must finish its owner reconciliation before recovery.');
          }
        }
        return { state: { memory: this.control.recoveryState(ids), profiles: this.options.profiles?.recoveryState() ?? null }, blockers };
      },
      retain: async (_ids, evidence) => {
        if (!this.options.profiles) throw new Error('Profile recovery owner is unavailable');
        await this.control.retainRecovery(evidence);
        await this.options.profiles.retainRecovery(evidence);
      },
      remove: async (ids) => {
        if (!this.options.profiles) throw new Error('Profile recovery owner is unavailable');
        this.control.removeRecoverySources(ids);
        for (const id of ids) this.options.profiles.deleteThreadState(id);
      },
    };
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
      this.options.profiles?.prepareInvalidation(context.rollbackId, context.omittedTurnIds);
    });
  }

  abortHistoryRollback(context: ThreadHistoryRollbackContext): void {
    this.options.profiles?.abortInvalidation(context.rollbackId);
    this.control.abortRollback(context.rollbackId);
  }

  commitHistoryRollback(context: ThreadHistoryRollbackContext): void {
    this.options.profiles?.commitInvalidation(context.rollbackId, context.omittedTurnIds);
    this.control.commitRollback(context.rollbackId);
    if (this.initialized) {
      this.requirePipeline().wakeThread(this.requireHost().readThread({ threadId: context.threadId, includeTurns: true }).thread);
      this.requirePipeline().wakeGlobal('history-rollback');
    }
  }

  projectionChanged(delivery: { readonly update: ProjectionUpdate; readonly operation?: Operation }): void {
    const update = delivery.update;
    if (update.kind === 'delta' && update.changedNodes.length === 0 && update.removedIds.length === 0) return;
    const previousStrayCount = this.mutationIndex?.strayTaggedNodeCount();
    const indexUpdate = this.applyProjectionUpdate(update);
    if (indexUpdate.fullRebuild || previousStrayCount !== this.mutationIndex?.strayTaggedNodeCount()) this.control.changed();
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
    operation: 'graph-digest' | 'graph-wake' | 'profile-context',
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

  private reconcileRollbackHooks(host: MemoryThreadHost): void {
    for (const rollback of this.control.activeRollbacks()) {
      if (rollback.status !== 'prepared') continue;
      const marker = host.historyRollbackMarker(rollback.rollbackId);
      if (marker && rollbackMatchesMarker(rollback, marker)) {
        this.options.profiles?.commitInvalidation(rollback.rollbackId, rollback.omittedTurnIds);
        this.control.commitRollback(rollback.rollbackId);
      } else {
        this.options.profiles?.abortInvalidation(rollback.rollbackId);
        this.control.abortRollback(rollback.rollbackId);
      }
    }
  }

  private async recoverPreparedReset(record: MemoryPublicationRecord, receiptMatches: boolean): Promise<void> {
    const payload = resetPublicationPayload(record.payload);
    await this.timeline.withWriteGate(async () => {
      if (this.control.publication(record.id)?.status !== 'prepared') return;
      if (!receiptMatches && !(await this.timeline.hasPublication(record.id, record.digest))) {
        try {
          await this.timeline.resetWithinWriteGate(
            record.id,
            record.generation,
            record.digest,
            payload.target.containerIds,
            (projection) => {
              requireMatchingMemoryResetTarget(projection, this.control.status().resetEpoch, payload.target);
              this.validateProfileReset(payload.target, record.id);
              if (payload.target.profile) {
                if (!this.options.profiles) throw new Error('Profile Reset owner is unavailable');
                this.options.profiles.reset(`${record.id}:profile`, payload.target.profile);
              }
            },
          );
        } catch (error) {
          if (await this.timeline.hasPublication(record.id, record.digest)) {
            this.control.finalizeReset(record.id, payload.epoch, payload.excludedTurnIds);
            return;
          }
          if (!definitiveResetRejection(error)) throw error;
          this.control.conflictReset(record.id);
          return;
        }
      }
      if (payload.target.profile && !this.options.profiles?.receipt(`${record.id}:profile`)) throw new Error('Profile Reset has not settled');
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

function isMemoryPublication(operation: Operation | undefined): boolean {
  return operation?.source?.kind === 'automation'
    && operation.source.label?.startsWith('Memory publication generation ') === true;
}

function outlineGetNodeIds(context: ToolLifecycleResult): ReadonlySet<string> {
  if (
    context.identity.namespace !== null
    || context.identity.name !== 'bash'
    || context.error !== null
    || !isRecord(context.arguments)
    || typeof context.arguments.command !== 'string'
  ) return new Set();
  const invocation = directOutlineShellInvocation(context.arguments.command);
  if (!invocation || invocation.command !== 'get' || invocation.output !== 'json') return new Set();
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
    || parsed.command !== 'get'
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
The canonical hierarchy is one direct #mem-day container under a source-date Daily Note. New containers start as Memory; after the source day ends and its evidence finishes processing, consolidation gives it a vivid, memorable title grounded in its actual contents. Independently useful #mem-episode context is optional; #mem-belief, #mem-question, and #mem-guidance records can be direct children of the container or descendants of an episode. Update generated day titles as their retained content changes, preserve titles edited by the user, and never create an empty container.
When prior preferences, decisions, commitments, unresolved questions, or recurring workflow facts could materially improve the response, use outline find to locate relevant Memory and inspect only the one or two most relevant results with outline --json get before relying on them. Skip Memory lookup for self-contained requests such as the current date or time, simple formatting or transformation, and questions fully answerable from the current Turn.
When a final answer relies on an ordinary Memory Node you read, cite it inline next to the relevant claim as [[node://UUID]], removing the internal node: prefix. Do not add a separate sources or used-memory section.
Stable personal preferences and background belong in USER.md through the configuration Skill and ordinary file tools. Use the public outline workflow for explicitly requested dated events, contextual knowledge and decisions; never duplicate a routine profile preference as a Node. Reuse a same-date canonical container when present, apply the fixed tag IDs tag:mem-day, tag:mem-episode, tag:mem-belief, tag:mem-question, and tag:mem-guidance, and keep the hierarchy valid.
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
  const target = decodeMemoryResetTarget(record.target);
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 1) throw new Error('Memory Reset epoch is invalid');
  if (!Array.isArray(excludedTurnIds) || excludedTurnIds.some((turnId) => typeof turnId !== 'string' || !turnId)) {
    throw new Error('Memory Reset exclusions are invalid');
  }
  if (target.resetEpoch + 1 !== epoch) throw new Error('Memory Reset target epoch is invalid');
  return {
    epoch: Number(epoch),
    excludedTurnIds: Object.freeze([...new Set(excludedTurnIds as string[])]),
    target,
  };
}

export type { ResetPublicationPayload };

function memoryFailure(code: string, message: string): AgentToolFailure {
  return new AgentToolFailure(code, message, 'Inspect Memory again before retrying. Never edit the private Memory store.');
}

function definitiveResetRejection(error: unknown): boolean {
  return error instanceof AgentToolFailure
    || (error instanceof OutlineContractError && ['invalid_input', 'not_found', 'precondition_failed', 'stale_revision', 'diff_mismatch', 'idempotency_conflict', 'confirmation_required'].includes(error.outlineError.code));
}
