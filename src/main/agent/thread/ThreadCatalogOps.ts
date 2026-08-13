import { decodeThread,decodeThreadItem,decodeTurn } from '../../../core/agent/codec';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import { createThreadHistoryRollbackContext,type AgentCoreExtension,type ThreadHistoryRollbackContext } from '../../../core/agent/extensions';
import { HOST_RESTART_ERROR_CODE,type AgentCoreRequestByMethod,type ContextCursor,type Thread,type ThreadConfigurationResponse,type ThreadConfigurationSetRequest,type ThreadConfigurationSummary,type ThreadDescendantsRequest,type ThreadDescendantsResponse,type ThreadForkRequest,type ThreadId,type ThreadItem,type ThreadItemEntry,type ThreadItemsListRequest,type ThreadItemsListResponse,type ThreadListRequest,type ThreadListResponse,type ThreadReadRequest,type ThreadReadResponse,type ThreadRollbackRequest,type ThreadStartRequest,type ThreadStartResponse,type ThreadTurnsListRequest,type ThreadTurnsListResponse,type Turn,type TurnDiagnosticsPayload } from '../../../core/agent/protocol';
import {
  assertContextPayloadDependencies,
  contextPayloadReferenceKey,
  itemRequiredContextPayloadReferences,
  itemResourceReferences,
  itemToolArgumentPayloadReferences,
  outputReferenceKey,
} from '../context/contextDependencies';
import { ExtensionRegistry } from '../ExtensionRegistry';
import { decodeCursor,encodeCursor,pageLimit } from '../persistence/cursor';
import { type RolloutEntry,type ThreadHistoryRollbackMarker } from '../persistence/RolloutStore';
import { decodeThreadCursor,encodeThreadListCursor,threadFollowsCursor,type ThreadCatalogRecord,type ThreadNameOrigin } from '../persistence/ThreadMetadataStore';
import type { RollbackHookRecoveryTarget } from '../RollbackHookRecoveryQueue';
import type { ThreadNameGenerator } from '../runtime/types';
import type { FeatureRootThreadInput,PersistentThreadExecutionContext,RendererThreadStartDefaults } from '../ThreadService';
import { uuidV7 } from '../uuid';
import { ThreadCore } from './ThreadCore';
import { ThreadResourceOps } from './ThreadResourceOps';
import type { TurnLifecycle } from './TurnLifecycle';

interface PendingThreadNameGeneration {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

interface PendingDelegatedThreadStart {
  readonly thread: Thread;
  attempted: boolean;
  error: Error | null;
}

export interface DelegatedThreadStartPublication {
  readonly published: boolean;
  readonly error: Error | null;
}

export interface ThreadCatalogCollaboration {
  recordEphemeralSpawnEdge(threadId: ThreadId, edge: {
    readonly sessionId: string;
    readonly parentThreadId: ThreadId;
    readonly taskPath: string;
    readonly createdAt: number;
  }): void;
  deleteEphemeralSpawnEdge(threadId: ThreadId): void;
  ephemeralChildThreadIds(parentThreadId: ThreadId): readonly ThreadId[];
  clearThreadCoordinationState(threadIds: readonly ThreadId[]): void;
  beginThreadDeletion(threadIds: readonly ThreadId[]): void;
  drainTerminalSettlements(threadIds: readonly ThreadId[]): Promise<void>;
  finishThreadDeletion(threadIds: readonly ThreadId[]): void;
}

/** What the catalog's descendant cascade owes the account layer. */
export interface ThreadCatalogTranscripts {
  delete(threadId: ThreadId): Promise<void>;
  /** Deletion takes the conversation with it, so its exclusion has nothing left to govern. */
  forgetExclusions(sessionIds: readonly string[]): Promise<void>;
  /** In-session belief state, released with the rest of a Thread's coordination state. */
  forgetBeliefs(threadIds: readonly ThreadId[]): void;
}

export class ThreadCatalogOps {
  private readonly pendingThreadNames = new Map<ThreadId, PendingThreadNameGeneration>();
  private readonly pendingDelegatedThreadStarts = new Map<ThreadId, PendingDelegatedThreadStart>();
  constructor(
    private readonly core: ThreadCore,
    private readonly resourceOps: ThreadResourceOps,
    private readonly extensions: ExtensionRegistry,
    private readonly nameGenerator: ThreadNameGenerator | null,
    private readonly resolveConfiguration: (request: ThreadStartRequest) => EffectiveThreadConfiguration | Promise<EffectiveThreadConfiguration>,
    private readonly resolveRendererStartDefaults: () => RendererThreadStartDefaults | Promise<RendererThreadStartDefaults>,
    private readonly validateRendererConfiguration: (configuration: ThreadConfigurationSummary) => void | Promise<void>,
    private readonly now: () => number,
    private readonly isClosing: () => boolean,
    private readonly turnLifecycle: TurnLifecycle,
    private readonly collaboration: ThreadCatalogCollaboration,
    private readonly hasUndeliveredWork: (threadId: ThreadId) => boolean,
    private readonly transcripts: ThreadCatalogTranscripts,
    private readonly clearGoal: (threadId: ThreadId) => Promise<void>,
    private readonly clearSubagentBudget: (threadId: ThreadId) => void,
    private readonly clearSubagentExecutions: (threadIds: readonly ThreadId[]) => void,
    private readonly clearAgentStartupContexts: (sessionIds: readonly string[]) => void,
    private readonly freezeAgentStartupContext: (
      thread: Pick<Thread, 'id' | 'sessionId' | 'cwd'>,
    ) => Promise<void>,
    private readonly createThreadBusyError: (message: string) => Error,
  ) {}
  pendingNameShutdownHandles(): readonly { abort: () => void; completion: Promise<void> }[] {
    return [...this.pendingThreadNames.values()].map((generation) => ({
      abort: () => generation.controller.abort(),
      completion: generation.completion,
    }));
  }
  persistentRootThreads(): readonly Thread[] {
      const threads: Thread[] = [];
      for (const archived of [false, true]) {
        let cursor: string | null = null;
        do {
          const page = this.core.metadata.list({ archived, cursor, limit: 100, rootsOnly: true });
          threads.push(...page.data.filter((thread) => !thread.ephemeral));
          cursor = page.nextCursor;
        } while (cursor);
      }
      return threads;
    }
  persistentThreadExecutionContext(threadId: ThreadId): PersistentThreadExecutionContext {
      const record = this.core.requireThread(threadId);
      if (record.thread.ephemeral || record.archived || record.thread.parentThreadId !== null) {
        throw new Error(`Automation destination must be a persistent, active root Thread: ${threadId}`);
      }
      return { thread: record.thread, configuration: record.configuration };
    }
  async ensureFeatureRootThread(input: FeatureRootThreadInput): Promise<Thread> {
      return this.core.hostRootMutex.run(async () => {
        const existing = this.core.metadata.read(input.id);
        if (existing) {
          const thread = existing.thread;
          if (
            existing.archived
            || thread.ephemeral
            || thread.parentThreadId !== null
            || thread.threadSource !== input.threadSource
            || thread.cwd !== input.cwd
            || thread.modelProvider !== input.modelProvider
            || JSON.stringify(existing.configuration) !== JSON.stringify(input.configuration)
          ) {
            throw new Error(`Existing Thread does not match the feature claim: ${input.id}`);
          }
          return thread;
        }
        return this.createThread({
          id: input.id,
          name: input.name,
          ephemeral: false,
          source: input.source,
          threadSource: input.threadSource,
          modelProvider: input.modelProvider,
          cwd: input.cwd,
        }, {
          sessionId: input.id,
          parentThreadId: null,
          forkedFromId: null,
          agentRole: null,
          agentNickname: null,
          configuration: input.configuration,
          nameOrigin: 'derived',
        });
      });
    }
  isThreadNavigable(threadId: ThreadId): boolean {
      const ephemeral = this.core.ephemeral.get(threadId);
      if (ephemeral) return !ephemeral.record.archived;
      const persisted = this.core.metadata.read(threadId);
      return Boolean(persisted && !persisted.archived);
    }
  listTurns(request: ThreadTurnsListRequest): ThreadTurnsListResponse {
      const state = this.core.ephemeral.get(request.threadId);
      if (!state) return this.core.history.listTurns(request);
      const direction = request.sortDirection ?? 'asc';
      const selected = pageEphemeralTurns(state.turns, request, direction);
      return {
        data: selected.data.map((turn) => request.itemsView === 'notLoaded'
          ? decodeTurn({ ...turn, items: [], itemsView: 'notLoaded' })
          : turn),
        nextCursor: selected.nextCursor,
        backwardsCursor: selected.backwardsCursor,
      };
    }
  listItems(request: ThreadItemsListRequest): ThreadItemsListResponse {
      const state = this.core.ephemeral.get(request.threadId);
      if (!state) return this.core.history.listItems(request);
      const entries = state.turns.flatMap((turn): ThreadItemEntry[] => (
        request.turnId && request.turnId !== turn.id
          ? []
          : turn.items.map((item) => ({ turnId: turn.id, item }))
      ));
      return pageEphemeralItems(entries, request);
    }
  /**
   * Root conversations only. A child Thread is an execution artifact of a Turn,
   * not a conversation the user had; it is reachable from the parent transcript
   * and from parent Thread Details. Filtering in SQL rather than after the page
   * is load-bearing — a post-filter would shrink pages and let children keep
   * consuming keyset cursor slots.
   */
  listThreads(request: ThreadListRequest = {}): ThreadListResponse {
      const direction = request.sortDirection ?? 'desc';
      const limit = pageLimit(request.limit);
      const cursor = decodeThreadCursor(request.cursor, direction);
      const persisted = this.core.metadata.list({ ...request, limit, rootsOnly: true });
      const ephemeral = request.archived === true ? [] : [...this.core.ephemeral.values()]
        .filter((state) => !this.core.hiddenEphemeralThreads.has(state.record.thread.id))
        .filter((state) => state.record.archived === (request.archived ?? false))
        .map((state) => state.record.thread)
        .filter((thread) => thread.parentThreadId === null)
        .filter((thread) => !request.threadSources || request.threadSources.includes(thread.threadSource))
        .filter((thread) => threadFollowsCursor(thread, cursor, direction));
      const candidates = [...persisted.data, ...ephemeral]
        .sort((left, right) => direction === 'desc'
          ? right.updatedAt - left.updatedAt || right.id.localeCompare(left.id)
          : left.updatedAt - right.updatedAt || left.id.localeCompare(right.id));
      const data = candidates.slice(0, limit);
      const hasNext = candidates.length > limit || persisted.nextCursor !== null;
      const last = data.at(-1);
      return {
        data,
        nextCursor: hasNext && last
          ? encodeThreadListCursor({ updatedAt: last.updatedAt, id: last.id }, direction)
          : null,
      };
    }
  /**
   * The parent-side browse surface for children, now that they are not list
   * rows. Ordered newest activity first, the whole subtree rather than direct
   * children only, so a grandchild is reachable in one place.
   */
  listThreadDescendants(request: ThreadDescendantsRequest): ThreadDescendantsResponse {
      const data = this.threadSubtreeIds(request.threadId)
        .filter((threadId) => threadId !== request.threadId)
        .filter((threadId) => !this.core.hiddenEphemeralThreads.has(threadId))
        .map((threadId) => this.core.requireThread(threadId).thread)
        .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
      return {
        data,
        queuedWorkThreadIds: data
          .filter((thread) => this.hasUndeliveredWork(thread.id))
          .map((thread) => thread.id),
      };
    }
  readThread(request: ThreadReadRequest): ThreadReadResponse {
      const record = this.core.requireThread(request.threadId);
      if (!request.includeTurns) return { thread: record.thread };
      return { thread: decodeThread({ ...record.thread, turns: this.core.allTurns(request.threadId) }) };
    }
  getThreadConfiguration(threadId: ThreadId): ThreadConfigurationResponse {
      const record = this.requireRendererConfigurableThread(threadId);
      return {
        thread: record.thread,
        configuration: threadConfigurationSummary(record),
      };
    }
  async setThreadConfiguration(request: ThreadConfigurationSetRequest): Promise<ThreadConfigurationResponse> {
      return this.core.threadMutex.run(request.threadId, async () => {
        const record = this.requireRendererConfigurableThread(request.threadId);
        if (this.turnLifecycle.hasActiveTurn(request.threadId)) {
        throw this.createThreadBusyError('Cannot change Thread configuration during an active Turn');
        }
        const configuration: ThreadConfigurationSummary = {
          modelProvider: request.modelProvider,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        };
        await this.validateRendererConfiguration(configuration);
        const effectiveConfiguration: EffectiveThreadConfiguration = Object.freeze({
          ...record.configuration,
          model: configuration.model,
          reasoningEffort: configuration.reasoningEffort,
        });
        const now = this.now();
        const thread = decodeThread({
          ...record.thread,
          modelProvider: configuration.modelProvider,
          updatedAt: now,
        });
        const state = this.core.ephemeral.get(request.threadId);
        if (state) {
          state.record = { ...record, thread, configuration: effectiveConfiguration };
        } else {
          this.core.metadata.setRootConfiguration(
            request.threadId,
            configuration.modelProvider,
            effectiveConfiguration,
            now,
          );
        }
        return { thread, configuration };
      });
    }
  async startThread(requestInput: AgentCoreRequestByMethod['thread/start']): Promise<ThreadStartResponse> {
      const defaults = requestInput.modelProvider && requestInput.cwd
        ? null
        : await this.resolveRendererStartDefaults();
      const request: ThreadStartRequest = {
        ...requestInput,
        source: requestInput.source ?? 'app',
        threadSource: requestInput.threadSource ?? 'user',
        modelProvider: requestInput.modelProvider ?? defaults?.modelProvider ?? '',
        cwd: requestInput.cwd ?? defaults?.cwd ?? '',
      };
      return this.core.hostRootMutex.run(async () => {
        const thread = await this.createThread(request, {
          sessionId: uuidV7(this.now()),
          parentThreadId: null,
          forkedFromId: null,
          agentRole: null,
          agentNickname: null,
        });
        return { thread };
      });
    }
  async resumeThread(threadId: ThreadId): Promise<{ thread: Thread }> {
      return this.core.threadMutex.run(threadId, async () => {
        const thread = this.core.requireThread(threadId).thread;
        await this.extensions.threadResumed(thread);
        return { thread };
      });
    }
  async forkThread(request: ThreadForkRequest): Promise<{ thread: Thread }> {
      return this.core.hostRootMutex.run(async () => this.core.threadMutex.run(request.threadId, async () => {
        const sourceRecord = this.core.requireThread(request.threadId);
        const source = sourceRecord.thread;
        const turns = this.core.allTurns(source.id);
        const boundaryIndex = turns.findIndex((turn) => turn.id === request.boundary.turnId);
        if (boundaryIndex < 0) throw new Error(`Fork boundary Turn not found: ${request.boundary.turnId}`);
        const inherited = turns.slice(0, request.boundary.kind === 'afterTurn' ? boundaryIndex + 1 : boundaryIndex);
        if (inherited.some((turn) => turn.status === 'inProgress')) throw new Error('Cannot fork through an active Turn');
        const now = this.now();
        const name = request.name ?? this.nextForkName(source);
        const thread = await this.createThread({
          name,
          ephemeral: source.ephemeral,
          source: 'app',
          threadSource: 'user',
          modelProvider: source.modelProvider,
          cwd: source.cwd,
        }, {
          sessionId: uuidV7(now),
          parentThreadId: null,
          forkedFromId: source.id,
          agentRole: null,
          agentNickname: null,
          configuration: sourceRecord.configuration,
          nameOrigin: request.name === undefined ? 'derived' : 'manual',
        });
        try {
          const copiedTurns = inherited.map((turn) => copyTurn(turn, now));
          const cursorMap = forkedCursorMap(inherited, copiedTurns);
          for (let index = 0; index < copiedTurns.length; index += 1) {
            copiedTurns[index] = rewriteForkedContextCursors(copiedTurns[index]!, cursorMap);
            copiedTurns[index] = await this.copyForkedTurnPayloads(
              source.id,
              thread.id,
              inherited[index]!,
              copiedTurns[index]!,
            );
          }
          for (const copied of copiedTurns) {
            await this.core.recordNotification({
              type: 'turn/completed',
              threadId: thread.id,
              turnId: copied.id,
              turn: copied,
            });
          }
        } catch (error) {
          await this.deleteThread(thread.id);
          throw error;
        }
        return { thread: this.core.requireThread(thread.id).thread };
      }));
    }

  private async copyForkedTurnPayloads(
      sourceThreadId: ThreadId,
      targetThreadId: ThreadId,
      sourceTurn: Turn,
      copiedTurn: Turn,
    ): Promise<Turn> {
      let diagnosticsRef = copiedTurn.execution.diagnosticsRef;
      const copiedOutputKeys = new Set<string>();
      const copyOutput = async (ref: Parameters<typeof outputReferenceKey>[0]): Promise<void> => {
        const key = outputReferenceKey(ref);
        if (copiedOutputKeys.has(key)) return;
        copiedOutputKeys.add(key);
        const copied = await this.core.payloads.copyTextToThread(sourceThreadId, targetThreadId, ref);
        if (!copied) console.warn(`[agent] Fork retained unavailable tool output: ${ref.id}`);
      };
      if (diagnosticsRef) {
        try {
          const payload = await this.core.payloads.readTurnDiagnostics(sourceThreadId, diagnosticsRef);
          if (!payload) {
            diagnosticsRef = null;
          } else {
            const itemIds = new Map(sourceTurn.items.map((item, index) => [item.id, copiedTurn.items[index]!.id]));
            diagnosticsRef = await this.core.payloads.writeTurnDiagnostics(
              targetThreadId,
              rewriteForkedTurnDiagnostics(payload, itemIds),
            );
          }
        } catch {
          diagnosticsRef = null;
        }
      }
      for (const item of copiedTurn.items) {
        for (const ref of itemResourceReferences(item)) {
          const copied = await this.core.payloads.copyResourceToThread(sourceThreadId, targetThreadId, ref);
          if (!copied) console.warn(`[agent] Fork retained unavailable managed resource: ${ref.id}`);
        }
        if (item.type === 'contextEvidence' || item.type === 'contextCompaction') {
          const directContextRefs = item.type === 'contextEvidence'
            ? [item.payloadRef]
            : [item.summaryRef, item.restoredStateRef, ...(item.instructionsRef ? [item.instructionsRef] : [])];
          for (const ref of directContextRefs) {
            const payload = await this.core.payloads.readContext(sourceThreadId, ref).catch(() => null);
            if (!payload) {
              console.warn(`[agent] Fork retained unavailable context payload: ${ref.id}`);
              continue;
            }
            try {
              assertContextPayloadDependencies(item, payload);
            } catch (error) {
              console.warn(`[agent] Fork retained context payload with unavailable dependencies: ${ref.id}`, error);
            }
          }
          for (const ref of item.outputRefs) {
            await copyOutput(ref);
          }
        }
        const requiredContextRefs = itemRequiredContextPayloadReferences(item);
        const requiredContextKeys = new Set(requiredContextRefs.map(contextPayloadReferenceKey));
        for (const ref of requiredContextRefs) {
          const payloadCopied = await this.core.payloads.copyContextToThread(sourceThreadId, targetThreadId, ref);
          if (!payloadCopied) console.warn(`[agent] Fork retained unavailable context payload: ${ref.id}`);
        }
        for (const ref of itemToolArgumentPayloadReferences(item)) {
          if (requiredContextKeys.has(contextPayloadReferenceKey(ref))) continue;
          const payloadCopied = await this.core.payloads.copyContextToThread(sourceThreadId, targetThreadId, ref);
          if (!payloadCopied) {
            console.warn(`[agent] Fork retained unavailable tool-call arguments: ${ref.id}`);
          }
        }
        if ('outputRef' in item && item.outputRef) {
          await copyOutput(item.outputRef);
        }
      }
      return diagnosticsRef === copiedTurn.execution.diagnosticsRef
        ? copiedTurn
        : decodeTurn({ ...copiedTurn, execution: { ...copiedTurn.execution, diagnosticsRef } });
    }
  async rollbackThread(request: ThreadRollbackRequest): Promise<{ thread: Thread }> {
      return this.core.threadMutex.run(request.threadId, async () => {
        const record = this.core.requireThread(request.threadId);
        const thread = record.thread;
        if (thread.ephemeral || thread.parentThreadId !== null || thread.threadSource !== 'user') {
          throw new Error('History rollback is available only for persistent root user Threads');
        }
        if (record.archived || this.core.stoppingThreads.has(thread.id)) {
        throw this.createThreadBusyError('Cannot roll back an archived or stopping Thread');
        }
        if (this.turnLifecycle.hasActiveTurn(thread.id) || thread.status.type !== 'idle') {
        throw this.createThreadBusyError('Cannot roll back a Thread with an active Turn');
        }
        await this.flushThreadNotificationsBestEffort(thread.id);
        const turns = this.core.allTurns(thread.id);
        if (request.numTurns > turns.length) {
          throw new Error('History rollback exceeds the current Turn count');
        }
        const omitted = turns.slice(-request.numTurns);
        if (omitted.some((turn) => turn.status === 'inProgress')) {
        throw this.createThreadBusyError('History rollback requires terminal Turns');
        }
        const beforeProjectionVersion = this.core.history.projectionVersion(thread.id);
        const context = createThreadHistoryRollbackContext(
          uuidV7(this.now()),
          thread.id,
          omitted.map((turn) => turn.id),
          beforeProjectionVersion,
          beforeProjectionVersion + 1,
        );
        const prepared: AgentCoreExtension[] = [];
        try {
          for (const extension of this.extensions.historyRollbackExtensions()) {
            await this.extensions.invokeHistoryRollbackHook(extension, 'prepare', context);
            prepared.push(extension);
          }
        } catch (error) {
          await this.finalizeHistoryRollbackHooks([...prepared].reverse(), 'abort', context);
          throw error;
        }

        let markerEntry: RolloutEntry | undefined;
        try {
          markerEntry = await this.core.rollout.appendHistoryRollback(context, this.now());
        } catch (error) {
          markerEntry = (await this.core.rollout.read(thread.id)).find((entry) => (
            entry.event.type === 'history/rollback' && entry.event.rollbackId === context.rollbackId
          ));
          if (!markerEntry) {
            await this.finalizeHistoryRollbackHooks([...prepared].reverse(), 'abort', context);
            throw error;
          }
        }
        let projectionError: unknown = null;
        try {
          this.core.history.apply(markerEntry);
        } catch {
          try {
            this.core.history.rebuildThread(thread.id, await this.core.rollout.read(thread.id));
          } catch (error) {
            projectionError = error;
          }
        }
        await this.finalizeHistoryRollbackHooks(prepared, 'commit', context);
        if (projectionError) throw projectionError;
        // The rollback marker is already durable. Orphan cleanup is retried at startup
        // and must not turn a committed rollback into a reported operation failure.
        //
        // RESOURCES are reclaimed against the surviving history PLUS the Turns
        // just removed. A rollback exists to be followed by a re-send of the
        // very content it removed — Edit does it, and Retry does it on the
        // failure case, where an attachment is most likely to still matter — so
        // a payload the omitted Turns referenced is one the next call is about
        // to reference again, and deleting it leaves the resent message pointing
        // at nothing. What neither set references is true garbage no re-send can
        // reach, and reclaiming it here keeps those bytes out of the resource
        // quota, which counts every byte on disk but can only ever offer
        // surviving history as reclaim candidates.
        //
        // The other three belong to the Turn that went away and nothing re-sends
        // them. Startup sweeps all four for every known Thread.
        const resurrectable = [
          ...this.resourceOps.threadResourceReferences(thread.id),
          ...omitted.flatMap((turn) => turn.items.flatMap(itemResourceReferences)),
        ];
        await Promise.all([
          this.core.payloads.pruneUnreferencedResources(thread.id, resurrectable),
          this.core.payloads.pruneUnreferencedContexts(thread.id, this.resourceOps.threadContextPayloadReferences(thread.id)),
          this.core.payloads.pruneUnreferencedTurnDiagnostics(
            thread.id,
            this.resourceOps.threadTurnDiagnosticsReferences(thread.id),
          ),
          this.core.payloads.pruneUnreferencedTextOutputs(thread.id, this.resourceOps.threadTextPayloadReferences(thread.id)),
        ]).catch(() => undefined);
        if (request.numTurns === turns.length) this.clearAutomaticThreadName(thread.id);
        return { thread: this.core.requireThread(thread.id).thread };
      });
    }
  historyProjectionVersion(threadId: ThreadId): number {
      this.core.requireThread(threadId);
      return this.core.history.projectionVersion(threadId);
    }
  hasHistoryRollbackMarker(rollbackId: string): boolean {
      return this.core.history.hasRollbackMarker(rollbackId);
    }
  historyRollbackMarker(rollbackId: string): ThreadHistoryRollbackMarker | null {
      return this.core.history.rollbackMarker(rollbackId);
    }
  async setThreadName(threadId: ThreadId, name: string | null): Promise<void> {
      this.pendingThreadNames.get(threadId)?.controller.abort();
      await this.core.threadMutex.run(threadId, async () => {
        const state = this.core.ephemeral.get(threadId);
        if (state) {
          state.record = {
            ...state.record,
            nameOrigin: 'manual',
            thread: decodeThread({ ...state.record.thread, name }),
          };
        } else {
          this.core.metadata.setManualName(threadId, name);
        }
        this.core.emitTransientNotification({
          type: 'thread/name/updated',
          threadId,
          ...(name === null ? {} : { threadName: name }),
        });
      });
    }
  async setThreadArchived(threadId: ThreadId, archived: boolean): Promise<void> {
      if (!archived) {
        await this.core.threadMutex.run(threadId, async () => this.updateThreadArchived(threadId, false));
        return;
      }
      const subtree = await this.beginThreadSubtreeStop(threadId);
      try {
        await this.stopThreadSubtree(subtree.threadIds);
        await this.core.threadTreeMutex.run(async () => {
          for (const descendantId of subtree.threadIds) this.updateThreadArchived(descendantId, true);
          this.clearThreadCoordinationState(subtree.threadIds);
        });
        for (const record of [...subtree.records].reverse()) {
          if (this.core.hiddenEphemeralThreads.has(record.thread.id)) continue;
          if (this.pendingDelegatedThreadStarts.has(record.thread.id)) continue;
          await this.extensions.threadStopped(record.thread);
        }
      } finally {
        this.finishThreadSubtreeStop(subtree.threadIds);
      }
    }
  async deleteThread(threadId: ThreadId): Promise<void> {
      const subtree = await this.beginThreadSubtreeStop(threadId, true);
      try {
        await this.stopThreadSubtree(subtree.threadIds);
        await this.collaboration.drainTerminalSettlements(subtree.threadIds);
        for (const descendantId of [...subtree.threadIds].reverse()) {
          await this.flushThreadNotificationsBestEffort(descendantId);
          await this.clearGoal(descendantId);
          this.clearSubagentBudget(descendantId);
          this.core.history.deleteThread(descendantId);
          await this.core.rollout.delete(descendantId);
          await this.core.payloads.deleteThread(descendantId);
        }
        for (const record of [...subtree.records].reverse()) {
          if (this.core.hiddenEphemeralThreads.has(record.thread.id)) continue;
          if (this.pendingDelegatedThreadStarts.has(record.thread.id)) continue;
          await this.extensions.threadStopped(record.thread);
        }
        await this.core.threadTreeMutex.run(async () => {
          if (subtree.records[0]?.thread.ephemeral) {
            for (const descendantId of [...subtree.threadIds].reverse()) {
              this.collaboration.deleteEphemeralSpawnEdge(descendantId);
              this.core.ephemeral.delete(descendantId);
              this.core.hiddenEphemeralThreads.delete(descendantId);
            }
          } else {
            this.core.metadata.delete(threadId);
          }
          // Metadata is the deletion commit point. Retire Agent identities only
          // after it succeeds; durable ledger cleanup may retry at startup and
          // must not turn an already-committed Thread deletion into an error.
          try {
            this.clearSubagentExecutions(subtree.threadIds);
          } catch (error) {
            console.warn('[agent] Agent ledger cleanup deferred after Thread deletion', error);
          }
          this.clearThreadCoordinationState(subtree.threadIds);
          for (const descendantId of subtree.threadIds) this.pendingDelegatedThreadStarts.delete(descendantId);
          // A session snapshot belongs to its root. Deleting one child must not
          // invalidate startup inputs still used by the surviving parent and
          // sibling Agents in the same session.
          this.clearAgentStartupContexts(subtree.records
            .filter((record) => record.thread.parentThreadId === null)
            .map((record) => record.thread.sessionId));
        });
        // After coordination-state teardown, so no append the cascade raced can
        // land behind the removal and resurrect a transcript the user deleted.
        for (const descendantId of [...subtree.threadIds].reverse()) {
          await this.transcripts.delete(descendantId);
        }
        await this.transcripts.forgetExclusions(subtree.records.map((record) => record.thread.sessionId));
      } finally {
        this.collaboration.finishThreadDeletion(subtree.threadIds);
        this.finishThreadSubtreeStop(subtree.threadIds);
      }
    }

  private async beginThreadSubtreeStop(threadId: ThreadId, deleting = false): Promise<{
      readonly threadIds: readonly ThreadId[];
      readonly records: readonly ThreadCatalogRecord[];
    }> {
      return this.core.threadTreeMutex.run(async () => {
        const threadIds = this.threadSubtreeIds(threadId);
        if (threadIds.some((id) => this.core.stoppingThreads.has(id))) {
          throw this.createThreadBusyError('Thread subtree is already stopping');
        }
        const records = threadIds.map((id) => this.core.requireThread(id));
        for (const id of threadIds) this.core.stoppingThreads.add(id);
        if (deleting) this.collaboration.beginThreadDeletion(threadIds);
        return { threadIds, records };
      });
    }

  private async stopThreadSubtree(threadIds: readonly ThreadId[]): Promise<void> {
      const pendingNames = threadIds.flatMap((id) => {
        const pending = this.pendingThreadNames.get(id);
        if (!pending) return [];
        pending.controller.abort();
        return [pending];
      });
      for (const id of threadIds) await this.turnLifecycle.abortForSubtreeStop(id);
      await Promise.all([
        ...threadIds.map((id) => this.turnLifecycle.waitForIdle(id)),
        ...pendingNames.map((pending) => pending.completion),
      ]);
    }
  private finishThreadSubtreeStop(threadIds: readonly ThreadId[]): void {
      for (const id of threadIds) this.core.stoppingThreads.delete(id);
    }
  /**
   * The Threads a records decision applies to: the addressed Thread and every
   * delegated descendant. Persistent members only — an ephemeral child never had
   * an artifact to remove or restore.
   */
  recordedSessionThreads(threadId: ThreadId): readonly Thread[] {
      return this.threadSubtreeIds(threadId)
        .map((id) => this.core.metadata.read(id)?.thread ?? null)
        .filter((thread): thread is Thread => thread !== null && !thread.ephemeral);
    }
  private threadSubtreeIds(threadId: ThreadId): ThreadId[] {
      const root = this.core.requireThread(threadId).thread;
      if (!root.ephemeral) {
        return [threadId, ...this.core.metadata.childEdges(threadId, true).map((edge) => edge.childThreadId)];
      }
      const ids = [threadId];
      for (let index = 0; index < ids.length; index += 1) {
        const parentId = ids[index]!;
        ids.push(...this.collaboration.ephemeralChildThreadIds(parentId));
      }
      return ids;
    }
  private updateThreadArchived(threadId: ThreadId, archived: boolean): void {
      const state = this.core.ephemeral.get(threadId);
      const now = this.now();
      if (state) {
        state.record = {
          ...state.record,
          archived,
          thread: decodeThread({ ...state.record.thread, updatedAt: now }),
        };
      } else {
        this.core.metadata.setArchived(threadId, archived, now);
      }
    }
  private clearThreadCoordinationState(threadIds: readonly ThreadId[]): void {
      this.collaboration.clearThreadCoordinationState(threadIds);
      // Beliefs are in-session state like the rest of this, and the rebuild path
      // is what makes releasing them safe: a Thread that runs again reconstructs
      // them from its record. Without this the set grew for the process
      // lifetime, one entry per node any Thread ever read.
      this.transcripts.forgetBeliefs(threadIds);
      this.core.clearThreadAdmissionBarriers(threadIds);
    }
  async createThread(
      request: ThreadStartRequest,
      lineage: {
        sessionId: string;
        parentThreadId: ThreadId | null;
        forkedFromId: ThreadId | null;
        agentRole: string | null;
        agentNickname: string | null;
        configuration?: EffectiveThreadConfiguration;
        toolCeiling?: readonly string[] | null;
        modelOverride?: string | null;
        reasoningEffortOverride?: EffectiveThreadConfiguration['reasoningEffort'] | null;
        taskPath?: string;
        nameOrigin?: ThreadNameOrigin;
        hidden?: boolean;
      },
    ): Promise<Thread> {
      const now = this.now();
      const id = request.id ?? uuidV7(now);
      const thread = decodeThread({
        id,
        sessionId: lineage.sessionId,
        parentThreadId: lineage.parentThreadId,
        forkedFromId: lineage.forkedFromId,
        agentNickname: lineage.agentNickname,
        agentRole: lineage.agentRole,
        name: request.name ?? null,
        preview: '',
        ephemeral: request.ephemeral ?? false,
        source: request.source,
        threadSource: request.threadSource,
        modelProvider: request.modelProvider,
        cwd: request.cwd,
        createdAt: now,
        updatedAt: now,
        status: { type: 'idle' },
        historyMode: 'paginated',
      });
      const configuration = lineage.configuration ?? await this.resolveConfiguration(request);
      const record = {
        thread,
        nameOrigin: lineage.nameOrigin ?? (thread.name === null ? 'none' : 'manual'),
        archived: false,
        configuration,
        toolCeiling: lineage.toolCeiling ?? null,
        modelOverride: lineage.modelOverride ?? null,
        reasoningEffortOverride: lineage.reasoningEffortOverride ?? null,
      };
      if (thread.ephemeral) {
        this.core.ephemeral.set(thread.id, { record, turns: [], completedItemIds: new Set() });
        if (lineage.hidden) this.core.hiddenEphemeralThreads.add(thread.id);
        if (thread.parentThreadId) {
          this.collaboration.recordEphemeralSpawnEdge(thread.id, {
            sessionId: thread.sessionId,
            parentThreadId: thread.parentThreadId,
            taskPath: lineage.taskPath ?? `/root/${thread.id}`,
            createdAt: now,
          });
        }
      } else if (thread.parentThreadId) {
        this.core.metadata.createChild(record, {
          sessionId: thread.sessionId,
          parentThreadId: thread.parentThreadId,
          childThreadId: thread.id,
          taskPath: lineage.taskPath ?? `/root/${thread.id}`,
          createdAt: now,
        });
      } else {
        this.core.metadata.create(record);
      }
      if (thread.parentThreadId === null && !lineage.hidden) {
        await this.freezeAgentStartupContext(thread);
      }
      const delegatedAdmission = thread.threadSource === 'subagent';
      if (delegatedAdmission) {
        this.pendingDelegatedThreadStarts.set(thread.id, { thread, attempted: false, error: null });
      }
      await this.core.recordNotification(
        { type: 'thread/started', threadId: thread.id, thread },
        { deferObservers: delegatedAdmission },
      );
      if (!delegatedAdmission && !this.core.hiddenEphemeralThreads.has(thread.id)) {
        await this.extensions.threadStarted(thread);
      }
      return thread;
    }
  hasPendingDelegatedThreadStart(threadId: ThreadId): boolean {
      return this.pendingDelegatedThreadStarts.has(threadId);
    }
  async publishDelegatedThreadStart(threadId: ThreadId): Promise<DelegatedThreadStartPublication> {
      const pending = this.pendingDelegatedThreadStarts.get(threadId);
      if (!pending) return { published: true, error: null };
      if (pending.attempted) {
        return {
          published: false,
          error: pending.error ?? new Error(`Delegated Thread start publication is unavailable: ${threadId}`),
        };
      }
      pending.attempted = true;
      try {
        await this.core.publishRecordedNotification({ type: 'thread/started', threadId, thread: pending.thread });
      } catch (error) {
        pending.error = error instanceof Error ? error : new Error(String(error));
        return { published: false, error: pending.error };
      }
      let lifecycleError: Error | null = null;
      try {
        if (!this.core.hiddenEphemeralThreads.has(threadId)) await this.extensions.threadStarted(pending.thread);
      } catch (error) {
        lifecycleError = error instanceof Error ? error : new Error(String(error));
      } finally {
        // Start hooks are attempted once. A post-commit hook failure belongs to
        // the admitted Turn; it must not turn later deletion into a staged
        // rollback or replay an already-published notification.
        this.pendingDelegatedThreadStarts.delete(threadId);
      }
      return { published: true, error: lifecycleError };
    }
  private requireRendererConfigurableThread(threadId: ThreadId): ThreadCatalogRecord {
      const record = this.core.requireThread(threadId);
      if (record.thread.parentThreadId || record.thread.threadSource !== 'user') {
        throw new Error('Only root user Threads have renderer-editable configuration');
      }
      return record;
    }
  setInitialPreview(threadId: ThreadId, preview: string, updatedAt: number): void {
      const state = this.core.ephemeral.get(threadId);
      if (state) {
        if (state.record.thread.preview.trim()) return;
        state.record = {
          ...state.record,
          thread: decodeThread({ ...state.record.thread, preview, updatedAt }),
        };
        return;
      }
      if (this.core.metadata.require(threadId).thread.preview.trim()) return;
      this.core.metadata.setPreview(threadId, preview, updatedAt);
    }
  private nextForkName(source: Thread): string {
      const sourceRecord = this.core.requireThread(source.id);
      const displayed = source.name?.trim() || source.preview.trim() || 'Untitled Thread';
      const base = sourceRecord.nameOrigin === 'derived'
        ? displayed.replace(/\s+\(([1-9]\d*)\)$/, '').trim() || displayed
        : displayed;
      const names = source.ephemeral
        ? this.ephemeralForkFamilyNames(source.id)
        : this.core.metadata.forkFamilyNames(source.id);
      let highest = 0;
      for (const candidateValue of names) {
        const candidate = candidateValue?.trim();
        if (!candidate) continue;
        if (candidate === base) {
          highest = Math.max(highest, 0);
          continue;
        }
        if (!candidate.startsWith(`${base} (`) || !candidate.endsWith(')')) continue;
        const suffix = candidate.slice(base.length + 2, -1);
        const index = Number(suffix);
        if (/^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(index)) highest = Math.max(highest, index);
      }
      return `${base} (${highest + 1})`;
    }
  private ephemeralForkFamilyNames(threadId: ThreadId): readonly (string | null)[] {
      let root = this.core.requireThread(threadId).thread;
      const visited = new Set<ThreadId>();
      while (root.forkedFromId) {
        if (visited.has(root.id)) throw new Error('Thread fork lineage contains a cycle');
        visited.add(root.id);
        root = this.core.requireThread(root.forkedFromId).thread;
      }
      const family = [root.id];
      for (let index = 0; index < family.length; index += 1) {
        const parentId = family[index]!;
        for (const [candidateId, state] of this.core.ephemeral) {
          if (state.record.thread.forkedFromId === parentId) family.push(candidateId);
        }
      }
      return family.map((id) => this.core.requireThread(id).thread.name);
    }
  scheduleAutomaticThreadName(
      thread: Thread,
      turn: Turn,
      configuration: EffectiveThreadConfiguration,
    ): void {
      if (
        !this.nameGenerator
        || this.isClosing()
        || this.core.stoppingThreads.has(thread.id)
        || thread.ephemeral
        || thread.parentThreadId !== null
        || thread.threadSource !== 'user'
        || turn.status === 'inProgress'
        || turn.provenance.trigger.kind !== 'user'
        || this.pendingThreadNames.has(thread.id)
      ) return;
      const record = this.core.requireThread(thread.id);
      const turns = this.core.allTurns(thread.id);
      if (record.thread.name !== null || record.nameOrigin !== 'none' || turns.length !== 1 || turns[0]?.id !== turn.id) {
        return;
      }
      const controller = new AbortController();
      let pending!: PendingThreadNameGeneration;
      const completion = Promise.resolve()
        .then(() => this.generateAutomaticThreadName(thread.id, turn, configuration, controller.signal))
        .catch((error) => {
          if (!controller.signal.aborted) console.warn('[agent] automatic Thread name generation failed', error);
        })
        .finally(() => {
          if (this.pendingThreadNames.get(thread.id) === pending) this.pendingThreadNames.delete(thread.id);
        });
      pending = { turnId: turn.id, controller, completion };
      this.pendingThreadNames.set(thread.id, pending);
    }

  private async generateAutomaticThreadName(
      threadId: ThreadId,
      turn: Turn,
      configuration: EffectiveThreadConfiguration,
      signal: AbortSignal,
    ): Promise<void> {
      const thread = this.core.requireThread(threadId).thread;
      const name = await this.nameGenerator!.generateName({ thread, turn, configuration, signal });
      if (!name || signal.aborted) return;
      await this.core.threadMutex.run(threadId, async () => {
        if (
          signal.aborted
          || this.core.stoppingThreads.has(threadId)
          || this.pendingThreadNames.get(threadId)?.turnId !== turn.id
        ) return;
        const record = this.core.requireThread(threadId);
        const turns = this.core.allTurns(threadId);
        if (
          record.thread.name !== null
          || record.nameOrigin !== 'none'
          || turns.length !== 1
          || turns[0]?.id !== turn.id
          || turns[0]?.status === 'inProgress'
        ) return;
        if (!this.core.metadata.setAutomaticNameIfEligible(threadId, name)) return;
        this.core.emitTransientNotification({ type: 'thread/name/updated', threadId, threadName: name });
      });
    }
  private clearAutomaticThreadName(threadId: ThreadId): void {
      if (!this.core.metadata.clearAutomaticName(threadId)) return;
      this.core.emitTransientNotification({ type: 'thread/name/updated', threadId });
    }
  async reconcileThread(threadId: ThreadId): Promise<void> {
      let entries = await this.core.rollout.read(threadId);
      const reconcileResult = this.core.history.reconcileThread(threadId, entries);
      const rollbackMarkers = this.core.history.rollbackMarkers(threadId);
      for (const marker of rollbackMarkers) {
        await this.finalizeHistoryRollbackHooks(this.extensions.historyRollbackExtensions(), 'commit', marker);
      }
      if (reconcileResult === 'rolloutMissing') {
        entries = await this.core.rollout.restoreMissing(threadId, this.core.history.rolloutSnapshot(threadId));
        this.core.history.rebuildThread(threadId, entries);
      }
      let cursor: string | null = null;
      do {
        const page = this.core.history.listItems({ threadId, cursor, limit: 100 });
        for (const entry of page.data) {
          if (entry.item.type === 'userMessage' && entry.item.clientId) {
            this.core.metadata.bindClientInput({
              threadId,
              clientId: entry.item.clientId,
              turnId: entry.turnId,
              itemId: entry.item.id,
              createdAt: this.core.requireThread(threadId).thread.createdAt,
            });
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      const latest = this.core.history.listTurns({ threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' }).data[0];
      if (latest?.status === 'inProgress') {
        this.core.history.restoreOpenItemsFromRollout(threadId, latest.id, entries);
        const recovered = this.core.history.readTurn(threadId, latest.id, 'full');
        if (!recovered) throw new Error(`Recovered Turn is missing from history: ${latest.id}`);
        await this.finishCrashedTurn(threadId, recovered);
      }
      const record = this.core.metadata.require(threadId);
      if (record.nameOrigin === 'automatic' && this.core.allTurns(threadId).length === 0) {
        this.clearAutomaticThreadName(threadId);
      }
      // `active` is a Turn that did not survive the process. `systemError` is a
      // lock a previous version left behind and nothing ever released: it
      // persists, and both rollback and Turn admission refuse anything but
      // `idle`, so the conversation stayed dead across restarts. Healing it here
      // is what gives those Threads back — nothing writes the status any more.
      if (record.thread.status.type === 'active' || record.thread.status.type === 'systemError') {
        await this.turnLifecycle.setStatus(threadId, { type: 'idle' });
      }
    }

  private async flushThreadNotificationsBestEffort(threadId: ThreadId): Promise<void> {
      try {
        await this.core.flushThreadNotifications(threadId);
      } catch (error) {
        console.error(`[agent] failed to flush Thread notifications for ${threadId}`, error);
      }
    }

  private async finalizeHistoryRollbackHooks(
      extensions: readonly AgentCoreExtension[],
      target: RollbackHookRecoveryTarget,
      context: ThreadHistoryRollbackContext,
    ): Promise<void> {
      for (const extension of extensions) {
        try {
          await this.extensions.invokeHistoryRollbackHook(extension, target, context);
        } catch {
          this.core.rollbackRecovery.enqueue({
            extensionId: extension.id,
            rollbackId: context.rollbackId,
            target,
            run: () => this.extensions.invokeHistoryRollbackHook(extension, target, context),
          });
        }
      }
    }

  private async finishCrashedTurn(threadId: ThreadId, turn: Turn): Promise<void> {
      const completedAt = this.now();
      const unfinishedItemIds = new Set(
        this.core.history.unfinishedItems(threadId, turn.id).map((item) => item.id),
      );
      const items = turn.items.map((item) => {
        if (!unfinishedItemIds.has(item.id) || !('status' in item) || item.status !== 'inProgress') return item;
        return decodeThreadItem({ ...item, status: 'interrupted' });
      });
      for (const item of items) {
        if (!unfinishedItemIds.has(item.id)) continue;
        await this.core.recordNotification({
          type: 'item/completed',
          threadId,
          turnId: turn.id,
          itemId: item.id,
          item,
          completedAt,
        });
      }
      const interrupted = decodeTurn({
        ...turn,
        items,
        status: 'interrupted',
        error: { message: 'Turn interrupted by host restart', code: HOST_RESTART_ERROR_CODE },
        completedAt,
        durationMs: Math.max(0, completedAt - turn.startedAt),
      });
      await this.core.recordNotification({
        type: 'turn/completed',
        threadId,
        turnId: turn.id,
        turn: interrupted,
      });
    }
}

function threadConfigurationSummary(record: ThreadCatalogRecord): ThreadConfigurationSummary {
  return Object.freeze({
    modelProvider: record.thread.modelProvider,
    model: record.configuration.model,
    reasoningEffort: record.configuration.reasoningEffort,
  });
}

function pageEphemeralTurns(
  turns: readonly Turn[],
  request: ThreadTurnsListRequest,
  direction: 'asc' | 'desc',
): { data: readonly Turn[]; nextCursor: string | null; backwardsCursor: string | null } {
  const positioned = turns.map((turn, position) => ({ value: turn, position, id: turn.id }));
  return pageEphemeral(positioned, request.cursor, request.limit, direction, 'ephemeralTurn');
}

function pageEphemeralItems(
  entries: readonly ThreadItemEntry[],
  request: ThreadItemsListRequest,
): ThreadItemsListResponse {
  const positioned = entries.map((entry, position) => ({ value: entry, position, id: entry.item.id }));
  const page = pageEphemeral(
    positioned,
    request.cursor,
    request.limit,
    request.sortDirection ?? 'asc',
    'ephemeralItem',
  );
  return page;
}

function pageEphemeral<T>(
  values: readonly { value: T; position: number; id: string }[],
  cursorInput: string | null | undefined,
  limitInput: number | null | undefined,
  direction: 'asc' | 'desc',
  kind: string,
): { data: readonly T[]; nextCursor: string | null; backwardsCursor: string | null } {
  const cursor = decodeCursor(cursorInput);
  if (cursor && (
    cursor.kind !== kind
    || cursor.direction !== direction
    || typeof cursor.position !== 'number'
    || !Number.isSafeInteger(cursor.position)
    || typeof cursor.id !== 'string'
  )) throw new Error('Invalid ephemeral history cursor');
  const cursorPosition = cursor?.position as number | undefined;
  const cursorId = cursor?.id as string | undefined;
  const filtered = values
    .filter((entry) => cursorPosition === undefined || cursorId === undefined || (direction === 'asc'
      ? entry.position > cursorPosition || (entry.position === cursorPosition && entry.id > cursorId)
      : entry.position < cursorPosition || (entry.position === cursorPosition && entry.id < cursorId)))
    .sort((left, right) => direction === 'asc'
      ? left.position - right.position || left.id.localeCompare(right.id)
      : right.position - left.position || right.id.localeCompare(left.id));
  const limit = pageLimit(limitInput);
  const page = filtered.slice(0, limit);
  const first = page[0];
  const last = page.at(-1);
  return {
    data: page.map((entry) => entry.value),
    nextCursor: filtered.length > limit && last
      ? encodeCursor({ kind, position: last.position, id: last.id, direction })
      : null,
    backwardsCursor: first
      ? encodeCursor({
          kind,
          position: first.position,
          id: first.id,
          direction: direction === 'asc' ? 'desc' : 'asc',
        })
      : null,
  };
}

function copyTurn(source: Turn, now: number): Turn {
  const id = uuidV7(now);
  return decodeTurn({
    ...source,
    id,
    items: source.items.map((item) => copyItem(item, now)),
    itemsView: 'full',
  });
}

function rewriteForkedTurnDiagnostics(
  payload: TurnDiagnosticsPayload,
  itemIds: ReadonlyMap<string, string>,
): TurnDiagnosticsPayload {
  const rewriteItemId = (itemId: string): string => {
    const copied = itemIds.get(itemId);
    if (!copied) throw new Error(`Turn diagnostics Item is outside the forked Turn: ${itemId}`);
    return copied;
  };
  return {
    ...payload,
    activities: payload.activities.map((activity) => {
      if (activity.type === 'acceptedInput') {
        return { ...activity, itemIds: activity.itemIds.map(rewriteItemId) };
      }
      if (activity.type === 'toolExecutionBatch') {
        return {
          ...activity,
          executions: activity.executions.map((execution) => ({
            ...execution,
            itemId: execution.itemId === null ? null : rewriteItemId(execution.itemId),
          })),
        };
      }
      if (activity.type === 'contextCompaction') {
        return { ...activity, itemId: rewriteItemId(activity.itemId) };
      }
      return activity;
    }),
  };
}

function forkedCursorMap(sourceTurns: readonly Turn[], copiedTurns: readonly Turn[]): Map<string, ContextCursor> {
  const cursors = new Map<string, ContextCursor>();
  for (let turnIndex = 0; turnIndex < sourceTurns.length; turnIndex += 1) {
    const sourceTurn = sourceTurns[turnIndex]!;
    const copiedTurn = copiedTurns[turnIndex]!;
    for (let itemIndex = 0; itemIndex < sourceTurn.items.length; itemIndex += 1) {
      const sourceItem = sourceTurn.items[itemIndex]!;
      const copiedItem = copiedTurn.items[itemIndex]!;
      cursors.set(contextCursorKey({ turnId: sourceTurn.id, itemId: sourceItem.id }), {
        turnId: copiedTurn.id,
        itemId: copiedItem.id,
      });
    }
  }
  return cursors;
}

function rewriteForkedContextCursors(turn: Turn, cursorMap: ReadonlyMap<string, ContextCursor>): Turn {
  return decodeTurn({
    ...turn,
    items: turn.items.map((item) => {
      if (item.type === 'contextReset') {
        return { ...item, clearedThrough: rewriteForkedContextCursor(item.clearedThrough, cursorMap) };
      }
      if (item.type === 'contextCompaction') {
        return {
          ...item,
          coveredFrom: rewriteForkedContextCursor(item.coveredFrom, cursorMap),
          coveredThrough: rewriteForkedContextCursor(item.coveredThrough, cursorMap),
          preservedFrom: item.preservedFrom
            ? rewriteForkedContextCursor(item.preservedFrom, cursorMap)
            : null,
        };
      }
      return item;
    }),
  });
}

function rewriteForkedContextCursor(
  cursor: ContextCursor,
  cursorMap: ReadonlyMap<string, ContextCursor>,
): ContextCursor {
  const copied = cursorMap.get(contextCursorKey(cursor));
  if (!copied) throw new Error(`Context cursor is outside the forked history: ${cursor.turnId}/${cursor.itemId}`);
  return copied;
}

function contextCursorKey(cursor: ContextCursor): string {
  return `${cursor.turnId}\0${cursor.itemId}`;
}

function copyItem(source: ThreadItem, now: number): ThreadItem {
  const id = uuidV7(now);
  return decodeThreadItem({
    ...source,
    id,
    ...(source.type === 'userMessage' ? { clientId: null } : {}),
  });
}
