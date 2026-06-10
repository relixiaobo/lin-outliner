import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, appendFile, rename, rm, writeFile, open, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  Usage,
} from '../core/agentTypes';
import type {
  AgentConversationMeta,
  AgentEvent,
  AgentEventMessageRole,
  AgentPrincipal,
  AgentEventReplayState,
  AgentPersistedContent,
  AgentPayloadDisplayMetadata,
  AgentPayloadRef,
  AgentPayloadRole,
  AgentId,
  AgentRunAnchor,
  AgentRunFingerprint,
  AgentRunKind,
  AgentRunMeta,
  AgentRunRetention,
  AgentRunStatus,
  AgentIdentityRecord,
  AgentDreamCompletedChanges,
  AgentDreamProcessedAgentRun,
  AgentDreamProcessedConversation,
  AgentDreamTrigger,
  AgentDreamWatermark,
  AgentMemoryEntry,
  AgentMemoryEvent,
  AgentMemorySource,
  AgentRunTrigger,
} from '../core/agentEventLog';
import { agentIdOfRunAnchor, appendAgentEventToReplayState, conversationIdOfRun, mergeUniquePrincipals, principalKey, replayAgentEvents, samePrincipal } from '../core/agentEventLog';
import {
  analyzeTextSearchQuery,
  normalizeSearchText,
  textSearchTextMatchesQuery,
} from '../core/textSearchAnalyzer';

const CONVERSATION_SEGMENT_FILE = '000001.jsonl';
const CONVERSATION_RUN_INDEX_FILE = 'runs.json';
const AGENT_RUN_INDEX_FILE = 'runs.json';
const RUN_EVENT_LOG_FILE = 'events.jsonl';
const RUN_META_FILE = 'meta.json';
const AGENT_IDENTITY_FILE = 'identity.json';
const CONVERSATION_INDEX_FILE = 'conversation-index.json';
// Pre-clean-cut artifact names, referenced ONLY by the old-format detector
// (hasLegacyStorageArtifacts) — never constructed for reads or writes.
const LEGACY_SESSIONS_DIR = 'sessions';
const LEGACY_SESSION_INDEX_FILE = 'session-index.json';
const SEARCH_INDEX_FILE = 'search-index.json';
const CHECKPOINT_VERSION = 4;
const SEARCH_INDEX_VERSION = 2;
const DEFAULT_CHECKPOINT_EVENT_INTERVAL = 100;
const MAX_CHECKPOINTS_PER_CONVERSATION = 3;
const MAX_SEARCH_INDEX_TEXT_CHARS = 20_000;
const SEARCH_INDEX_PREVIEW_CHARS = 240;
export const MAX_AGENT_MEMORY_FACT_CHARS = 2_000;
const MEMORY_COMPACTION_MIN_EVENTS = 64;
const MEMORY_COMPACTION_CHURN_FACTOR = 2;

export interface AgentPayloadWriteInput {
  id?: string;
  data: Buffer | Uint8Array | string;
  encoding?: BufferEncoding;
  mimeType: string;
  runId?: string;
  role?: AgentPayloadRole;
  summary?: string;
  truncated?: boolean;
  display?: AgentPayloadDisplayMetadata;
}

export interface AgentEventStorePaths {
  rootDir: string;
  indexesDir: string;
  agentsDir: string;
  conversationsDir: string;
  conversationDir: string;
  conversationMetaPath: string;
  conversationCursorsPath: string;
  conversationRunIndexPath: string;
  conversationSegmentsDir: string;
  conversationEventsPath: string;
  conversationPayloadsDir: string;
  checkpointsDir: string;
  runsDir: string;
}

export interface AgentRunEventStorePaths {
  rootDir: string;
  runsDir: string;
  runDir: string;
  runMetaPath: string;
  runEventsPath: string;
  payloadsDir: string;
}

export interface AgentRunMetaProjection extends AgentRunMeta {
  v: 1;
  updatedAt: number;
  latestSeq: number;
}

export interface AgentConversationMetaProjection extends AgentConversationMeta {
  v: 1;
  title: string | null;
  updatedAt: number;
  latestSeq: number;
}

export interface AgentMemoryEntryInput {
  id?: string;
  fact: string;
  originWorkspace?: string;
  sources: AgentMemorySource[];
  createdAt?: number;
}

export interface AgentMemoryEntryPatch {
  fact?: string;
  originWorkspace?: string;
  sources?: AgentMemorySource[];
  status?: AgentMemoryEntry['status'];
}

export interface AgentDreamCompletedInput {
  dreamId?: string;
  runId: string;
  trigger: AgentDreamTrigger;
  startedAt: number;
  completedAt?: number;
  watermark: AgentDreamWatermark;
  processed: {
    conversations: Record<string, AgentDreamProcessedConversation>;
    agentRuns?: Record<string, AgentDreamProcessedAgentRun>;
    totalMessageCount: number;
    totalCharCount: number;
    consolidateOnly: boolean;
  };
  changes: AgentDreamCompletedChanges;
}

export interface AgentDreamState {
  lastCompleted: Extract<AgentMemoryEvent, { type: 'dream.completed' }> | null;
  watermark: AgentDreamWatermark;
  lastSuccessAt: number | null;
}

export interface AgentConversationIndexEntry {
  id: string;
  title: string | null;
  members: AgentPrincipal[];
  goal?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  latestSeq: number;
  /**
   * Folded off-floor unread count for this conversation, persisted so the badge
   * survives restart (the live `conversation_attention` event only fires for
   * conversations touched this run). Sourced from replay state, single source of truth.
   */
  unreadCount: number;
}

export interface AgentEventCheckpoint {
  v: typeof CHECKPOINT_VERSION;
  conversationId: string;
  seq: number;
  latestEventId: string | null;
  createdAt: number;
  targets: AgentEventCheckpointTargets;
  state: AgentEventReplayState;
}

interface AgentEventFileTail {
  seq: number;
  eventId: string | null;
}

interface AgentEventCheckpointTargets {
  conversationByteOffset: number;
  runByteOffsets: Record<string, number>;
}

interface AgentConversationRunIndex {
  v: 1;
  runIds: string[];
  latestSeqByRunId: Record<string, number>;
}

/**
 * Derived index of the reflective runs anchored to one principal (the runs maintaining that
 * principal's pool). Lives in the principal's pool directory; rebuilt from `runs/` on miss.
 */
interface AgentPrincipalRunIndex {
  v: 1;
  principalKey: string;
  runIds: string[];
  updatedAtByRunId: Record<string, number>;
}

interface AgentMemoryProjectionCache {
  latestSeq: number;
  eventCount: number;
  entries: Map<string, AgentMemoryEntry>;
  dream: AgentDreamState;
}

export interface AgentEventSearchIndexEntry {
  conversationId: string;
  messageId: string;
  role: AgentEventMessageRole;
  parentMessageId: string | null;
  createdAt: number;
  updatedAt: number;
  latestSeq: number;
  text: string;
  normalizedText: string;
  preview: string;
  payloadIds: string[];
}

export interface AgentEventUserMessageIndexEntry extends AgentEventSearchIndexEntry {
  role: 'user';
  replacesMessageId?: string;
  hasAttachments: boolean;
}

interface AgentEventSearchIndex {
  v: typeof SEARCH_INDEX_VERSION;
  messages: Record<string, AgentEventSearchIndexEntry>;
  userMessages: Record<string, AgentEventUserMessageIndexEntry>;
  latestSeqByConversationId: Record<string, number>;
}

export class AgentEventStore {
  private readonly agentEventLog = new AppendOnlySeqLog<AgentEvent>('agent event', parseEventsJsonl);
  private readonly memoryEventLog = new AppendOnlySeqLog<AgentMemoryEvent>('agent memory event', parseMemoryEventsJsonl);
  private indexQueue = Promise.resolve();
  private readonly memoryProjectionByPrincipal = new Map<string, AgentMemoryProjectionCache>();
  private storageLayoutPromise: Promise<void> | null = null;

  constructor(private readonly rootDir: string) {}

  paths(conversationId: string): AgentEventStorePaths {
    const conversationsDir = path.join(this.rootDir, 'conversations');
    const conversationDir = path.join(conversationsDir, agentConversationDirName(conversationId));
    const conversationSegmentsDir = path.join(conversationDir, 'segments');
    return {
      rootDir: this.rootDir,
      indexesDir: path.join(this.rootDir, 'indexes'),
      agentsDir: path.join(this.rootDir, 'agents'),
      conversationsDir,
      conversationDir,
      conversationMetaPath: path.join(conversationDir, 'meta.json'),
      conversationCursorsPath: path.join(conversationDir, 'cursors.json'),
      conversationRunIndexPath: path.join(conversationDir, CONVERSATION_RUN_INDEX_FILE),
      conversationSegmentsDir,
      conversationEventsPath: path.join(conversationSegmentsDir, CONVERSATION_SEGMENT_FILE),
      conversationPayloadsDir: path.join(conversationDir, 'payloads'),
      checkpointsDir: path.join(conversationDir, 'checkpoints'),
      runsDir: path.join(this.rootDir, 'runs'),
    };
  }

  runPaths(runId: string): AgentRunEventStorePaths {
    const runsDir = path.join(this.rootDir, 'runs');
    const runDir = path.join(runsDir, agentRunDirName(runId));
    return {
      rootDir: this.rootDir,
      runsDir,
      runDir,
      runMetaPath: path.join(runDir, RUN_META_FILE),
      runEventsPath: path.join(runDir, RUN_EVENT_LOG_FILE),
      payloadsDir: path.join(runDir, 'payloads'),
    };
  }

  /** The agent's identity directory — holds ONLY `identity.json`; pools live under `principals/`. */
  agentPaths(agentId: string): { agentDir: string; identityPath: string } {
    const agentDir = path.join(this.rootDir, 'agents', agentIdentityDirName(agentId));
    return {
      agentDir,
      identityPath: path.join(agentDir, AGENT_IDENTITY_FILE),
    };
  }

  /**
   * On-disk location of a principal's memory pool. One path rule for every
   * principal type: `principals/<agent-<agentId> | user-<userId>>/memory/`.
   * The pool is the subject's self-model — see [[agent-data-model]] §4.
   */
  memoryPaths(principal: AgentPrincipal): { poolDir: string; memoryEventsPath: string; runIndexPath: string } {
    const poolDir = path.join(this.rootDir, 'principals', agentPrincipalDirName(principal));
    return {
      poolDir,
      memoryEventsPath: path.join(poolDir, 'memory', RUN_EVENT_LOG_FILE),
      // The derived index of reflective runs maintaining this pool — lives beside the pool, so
      // run history and dream state are keyed by the same principal (no cross-pool join).
      runIndexPath: path.join(poolDir, AGENT_RUN_INDEX_FILE),
    };
  }

  async appendEvents(conversationId: string, events: readonly AgentEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureStorageLayout();
    this.assertEventBatch(conversationId, events);
    await this.agentEventLog.enqueue(conversationId, async () => {
      const latestSeq = await this.getLatestSeq(conversationId);
      const firstSeq = events[0]!.seq;
      if (firstSeq <= latestSeq) {
        throw new Error(`Agent event seq ${firstSeq} is not after existing seq ${latestSeq}`);
      }

      await this.appendSplitEvents(conversationId, events);
      this.agentEventLog.setLatestSeq(conversationId, events.at(-1)!.seq);
      // Streaming assistant deltas carry no index content: the conversation/search
      // indexes derive assistant text from assistant_message.completed, and a
      // delta only nudges latestSeq/updatedAt (cosmetic ordering, self-healed by
      // the completed/run events that follow). Skipping the whole-file index
      // rewrite for delta-only batches avoids re-reading + re-serializing both
      // index files on every streamed token. The events.jsonl append above is
      // the source of truth and still happens per delta.
      if (events.some((event) => !isStreamingDeltaEvent(event))) {
        await this.updateConversationIndex(conversationId, events);
        await this.updateSearchIndex(conversationId, events);
      }
    });
  }

  async readEvents(conversationId: string): Promise<AgentEvent[]> {
    await this.ensureStorageLayout();
    const paths = this.paths(conversationId);
    const events = [
      ...await this.agentEventLog.readIfExists(paths.conversationEventsPath),
      ...await this.readRunEventsForConversation(conversationId),
    ];
    return events.sort(compareAgentEventsForReplay);
  }

  async replay(conversationId: string): Promise<AgentEventReplayState> {
    await this.ensureStorageLayout();
    const checkpointed = await this.replayFromCheckpoint(conversationId);
    if (checkpointed) return checkpointed;
    return replayAgentEvents(await this.readEvents(conversationId));
  }

  async writeCheckpoint(conversationId: string, state: AgentEventReplayState): Promise<AgentEventCheckpoint | null> {
    if (!state.conversation || state.conversation.id !== conversationId || state.latestSeq <= 0) return null;
    await this.ensureStorageLayout();
    return this.agentEventLog.enqueue(conversationId, async () => {
      const tail = await this.readEventFileTail(conversationId);
      if (tail.seq !== state.latestSeq || tail.eventId !== state.latestEventId) return null;
      const checkpoint: AgentEventCheckpoint = {
        v: CHECKPOINT_VERSION,
        conversationId,
        seq: state.latestSeq,
        latestEventId: state.latestEventId,
        createdAt: Date.now(),
        targets: await this.checkpointTargets(conversationId),
        state: cloneReplayState(state),
      };
      const paths = this.paths(conversationId);
      await mkdir(paths.checkpointsDir, { recursive: true });
      await atomicWriteFile(this.checkpointPath(conversationId, checkpoint.seq), `${JSON.stringify(checkpoint)}\n`);
      await this.pruneCheckpoints(conversationId).catch(() => undefined);
      return checkpoint;
    });
  }

  async maybeWriteCheckpoint(
    conversationId: string,
    state: AgentEventReplayState,
    options: { minEventDelta?: number; force?: boolean } = {},
  ): Promise<AgentEventCheckpoint | null> {
    if (!state.conversation || state.conversation.id !== conversationId || state.latestSeq <= 0) return null;
    const latest = await this.readLatestCheckpoint(conversationId);
    const minEventDelta = options.minEventDelta ?? DEFAULT_CHECKPOINT_EVENT_INTERVAL;
    if (!options.force && latest && state.latestSeq - latest.seq < minEventDelta) return null;
    return this.writeCheckpoint(conversationId, state);
  }

  async writePayload(conversationId: string, input: AgentPayloadWriteInput): Promise<AgentPayloadRef> {
    await this.ensureStorageLayout();
    const bytes = typeof input.data === 'string'
      ? Buffer.from(input.data, input.encoding ?? 'utf8')
      : Buffer.from(input.data);
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: input.id ?? `payload-${randomUUID()}`,
      storage: 'file',
      mimeType: input.mimeType,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      scope: input.runId
        ? { type: 'run', conversationId: conversationId, runId: input.runId }
        : { type: 'conversation', conversationId: conversationId },
      role: input.role,
      summary: input.summary,
      truncated: input.truncated,
      display: input.display,
    };

    const payloadDir = input.runId ? this.runPaths(input.runId).payloadsDir : this.paths(conversationId).conversationPayloadsDir;
    await mkdir(payloadDir, { recursive: true });
    await writeFile(this.payloadPath(conversationId, payload), bytes);
    return payload;
  }

  async readPayload(conversationId: string, payload: AgentPayloadRef): Promise<Buffer> {
    await this.ensureStorageLayout();
    return readFile(this.payloadPath(conversationId, payload));
  }

  payloadPath(
    conversationId: string,
    payload: Pick<AgentPayloadRef, 'id' | 'mimeType'> & Partial<Pick<AgentPayloadRef, 'scope'>>,
  ): string {
    const scope = payload.scope;
    const payloadDir = scope?.type === 'run'
      ? this.runPaths(scope.runId).payloadsDir
      : this.paths(conversationId).conversationPayloadsDir;
    return path.join(payloadDir, agentPayloadFileName(payload.id, payload.mimeType));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.ensureStorageLayout();
    await rm(this.paths(conversationId).conversationDir, { recursive: true, force: true });
    await Promise.all((await this.listRunIdsForConversation(conversationId)).map((runId) => (
      rm(this.runPaths(runId).runDir, { recursive: true, force: true })
    )));
    this.agentEventLog.deleteKey(conversationId);
    await this.removeConversationFromIndex(conversationId);
    await this.removeConversationFromSearchIndex(conversationId);
  }

  async listConversationIds(): Promise<string[]> {
    await this.ensureStorageLayout();
    try {
      const entries = await readdir(this.paths('__placeholder__').conversationsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => decodeAgentConversationDirName(entry.name));
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async listConversationIndexEntries(): Promise<AgentConversationIndexEntry[]> {
    await this.ensureStorageLayout();
    const index = await this.readConversationIndex();
    if (index && await this.conversationIndexMatchesConversations(index)) {
      return Object.values(index.conversations).sort((left, right) => right.updatedAt - left.updatedAt);
    }
    return this.rebuildConversationIndex();
  }

  async listUserMessageIndexEntries(conversationId?: string): Promise<AgentEventUserMessageIndexEntry[]> {
    await this.ensureStorageLayout();
    const index = await this.getSearchIndex();
    return Object.values(index.userMessages)
      .filter((entry) => !conversationId || entry.conversationId === conversationId)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async listMessageIndexEntries(): Promise<AgentEventSearchIndexEntry[]> {
    await this.ensureStorageLayout();
    const index = await this.getSearchIndex();
    return Object.values(index.messages)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async findMessageIndexEntry(messageId: string): Promise<AgentEventSearchIndexEntry | null> {
    await this.ensureStorageLayout();
    const index = await this.getSearchIndex();
    return Object.values(index.messages)
      .filter((entry) => entry.messageId === messageId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async searchMessages(
    query: string,
    options: { conversationId?: string; limit?: number } = {},
  ): Promise<AgentEventSearchIndexEntry[]> {
    await this.ensureStorageLayout();
    const terms = normalizeSearchTerms(query);
    if (terms.length === 0) return [];
    const analysis = { ...analyzeTextSearchQuery(query), terms };
    const index = await this.getSearchIndex();
    return Object.values(index.messages)
      .filter((entry) => !options.conversationId || entry.conversationId === options.conversationId)
      .filter((entry) => textSearchTextMatchesQuery(entry.normalizedText, analysis))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, clampSearchLimit(options.limit));
  }

  checkpointPath(conversationId: string, seq: number): string {
    return path.join(this.paths(conversationId).checkpointsDir, agentCheckpointFileName(seq));
  }

  async writeAgentIdentity(identity: AgentIdentityRecord): Promise<void> {
    await this.ensureStorageLayout();
    const paths = this.agentPaths(identity.agentId);
    await mkdir(paths.agentDir, { recursive: true });
    await atomicWriteFile(paths.identityPath, `${JSON.stringify({ v: 1, ...identity })}\n`);
  }

  async writeRunMeta(meta: AgentRunMetaProjection): Promise<void> {
    await this.ensureStorageLayout();
    const normalized = normalizeRunMeta(meta);
    if (!normalized) throw new Error('Invalid agent run meta.');
    const runPaths = this.runPaths(normalized.id);
    await mkdir(runPaths.runDir, { recursive: true });
    await atomicWriteFile(runPaths.runMetaPath, `${JSON.stringify(normalized)}\n`);
    await this.updateRunIndexes(normalized);
  }

  async readRunMetaProjection(runId: string): Promise<AgentRunMetaProjection | null> {
    await this.ensureStorageLayout();
    return this.readRunMeta(runId);
  }

  /** Reflective runs anchored to one principal (the runs maintaining that principal's pool). */
  async listPrincipalRunMetaProjections(
    principal: AgentPrincipal,
    options: { limit?: number } = {},
  ): Promise<AgentRunMetaProjection[]> {
    await this.ensureStorageLayout();
    const index = await this.ensurePrincipalRunIndex(principal);
    const limit = Math.max(0, Math.min(100, Math.trunc(options.limit ?? 50)));
    const metas: AgentRunMetaProjection[] = [];
    for (const runId of index.runIds) {
      const meta = await this.readRunMeta(runId);
      if (!meta || meta.anchor.type !== 'principal' || !samePrincipal(meta.anchor.principal, principal)) continue;
      metas.push(meta);
    }
    return metas
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, limit);
  }

  async readAgentIdentity(agentId: string): Promise<AgentIdentityRecord | null> {
    await this.ensureStorageLayout();
    const paths = this.agentPaths(agentId);
    try {
      const raw = await readFile(paths.identityPath, 'utf8');
      return normalizeAgentIdentity(JSON.parse(raw));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async addMemoryEntry(principal: AgentPrincipal, input: AgentMemoryEntryInput): Promise<AgentMemoryEntry> {
    await this.ensureStorageLayout();
    const key = principalKey(principal);
    return this.memoryEventLog.enqueue(key, async () => {
      const createdAt = input.createdAt ?? Date.now();
      const entry = normalizeMemoryEntry({
        id: input.id ?? `memory-${randomUUID()}`,
        principal,
        fact: input.fact,
        originWorkspace: input.originWorkspace,
        sources: input.sources,
        status: 'active',
        createdAt,
      });
      if (!entry) throw new Error('Invalid agent memory entry.');
      const event = await this.nextMemoryEvent(principal, {
        type: 'memory.entry_added',
        createdAt,
        entry,
      });
      const projection = await this.getMemoryProjection(principal);
      await this.appendMemoryEvents(principal, [event]);
      projection.entries.set(entry.id, entry);
      projection.latestSeq = event.seq;
      projection.eventCount += 1;
      await this.maybeCompactMemoryLog(principal, projection);
      return entry;
    });
  }

  async updateMemoryEntry(
    principal: AgentPrincipal,
    entryId: string,
    patch: AgentMemoryEntryPatch,
  ): Promise<AgentMemoryEntry | null> {
    await this.ensureStorageLayout();
    const key = principalKey(principal);
    return this.memoryEventLog.enqueue(key, async () => {
      if ('fact' in patch && !normalizeMemoryFact(patch.fact)) {
        throw new Error('Memory fact cannot be empty.');
      }
      const projection = await this.getMemoryProjection(principal);
      const current = projection.entries.get(entryId);
      if (!current) return null;
      const normalizedPatch = normalizeMemoryEntryPatch(patch);
      if (Object.keys(normalizedPatch).length === 0) return current;
      const event = await this.nextMemoryEvent(principal, {
        type: 'memory.entry_updated',
        createdAt: Date.now(),
        entryId,
        patch: normalizedPatch,
      });
      await this.appendMemoryEvents(principal, [event]);
      const next = normalizeMemoryEntry({ ...current, ...normalizedPatch }) ?? current;
      projection.entries.set(next.id, next);
      projection.latestSeq = event.seq;
      projection.eventCount += 1;
      await this.maybeCompactMemoryLog(principal, projection);
      return next;
    });
  }

  async removeMemoryEntry(principal: AgentPrincipal, entryId: string, reason?: string): Promise<AgentMemoryEntry | null> {
    await this.ensureStorageLayout();
    const key = principalKey(principal);
    return this.memoryEventLog.enqueue(key, async () => {
      const projection = await this.getMemoryProjection(principal);
      const current = projection.entries.get(entryId);
      if (!current) return null;
      if (current.status === 'invalidated') return current;
      const event = await this.nextMemoryEvent(principal, {
        type: 'memory.entry_removed',
        createdAt: Date.now(),
        entryId,
        reason,
      });
      await this.appendMemoryEvents(principal, [event]);
      const next: AgentMemoryEntry = { ...current, status: 'invalidated' };
      projection.entries.set(next.id, next);
      projection.latestSeq = event.seq;
      projection.eventCount += 1;
      await this.maybeCompactMemoryLog(principal, projection);
      return next;
    });
  }

  async appendDreamCompleted(principal: AgentPrincipal, input: AgentDreamCompletedInput): Promise<Extract<AgentMemoryEvent, { type: 'dream.completed' }>> {
    await this.ensureStorageLayout();
    const key = principalKey(principal);
    return this.memoryEventLog.enqueue(key, async () => {
      const completedAt = input.completedAt ?? Date.now();
      const event = await this.nextMemoryEvent(principal, {
        type: 'dream.completed',
        createdAt: completedAt,
        dreamId: input.dreamId ?? `dream-${randomUUID()}`,
        runId: input.runId,
        trigger: input.trigger,
        startedAt: input.startedAt,
        completedAt,
        watermark: normalizeDreamWatermark(input.watermark),
        processed: {
          conversations: normalizeDreamProcessedConversations(input.processed.conversations),
          agentRuns: normalizeDreamProcessedAgentRuns(input.processed.agentRuns),
          totalMessageCount: Math.max(0, Math.trunc(input.processed.totalMessageCount)),
          totalCharCount: Math.max(0, Math.trunc(input.processed.totalCharCount)),
          consolidateOnly: input.processed.consolidateOnly,
        },
        changes: normalizeDreamChanges(input.changes),
      }) as Extract<AgentMemoryEvent, { type: 'dream.completed' }>;
      const projection = await this.getMemoryProjection(principal);
      await this.appendMemoryEvents(principal, [event]);
      projection.dream = dreamStateFromCompleted(event);
      projection.latestSeq = event.seq;
      projection.eventCount += 1;
      await this.maybeCompactMemoryLog(principal, projection);
      return event;
    });
  }

  async readDreamState(principal: AgentPrincipal): Promise<AgentDreamState> {
    await this.ensureStorageLayout();
    return cloneDreamState((await this.getMemoryProjection(principal)).dream);
  }

  async getMemoryEntry(principal: AgentPrincipal, entryId: string): Promise<AgentMemoryEntry | null> {
    await this.ensureStorageLayout();
    const projection = await this.getMemoryProjection(principal);
    return projection.entries.get(entryId) ?? null;
  }

  async listMemoryEntries(
    principal: AgentPrincipal,
    options: { includeInvalidated?: boolean; limit?: number; query?: string } = {},
  ): Promise<AgentMemoryEntry[]> {
    return (await this.queryMemoryEntries(principal, options)).entries;
  }

  // A pool is one undivided self-model: no workspace filter here by design — `originWorkspace`
  // on an entry is provenance metadata, never a retrieval fence.
  async queryMemoryEntries(
    principal: AgentPrincipal,
    options: { includeInvalidated?: boolean; limit?: number; query?: string } = {},
  ): Promise<{ entries: AgentMemoryEntry[]; totalEntries: number }> {
    await this.ensureStorageLayout();
    const projection = await this.getMemoryProjection(principal);
    const entries = rankMemoryEntries([...projection.entries.values()]
      .filter((entry) => options.includeInvalidated || entry.status === 'active'),
      options.query);
    return {
      entries: entries.slice(0, clampMemoryLimit(options.limit)),
      totalEntries: entries.length,
    };
  }

  async readMemoryEvents(principal: AgentPrincipal): Promise<AgentMemoryEvent[]> {
    await this.ensureStorageLayout();
    return this.memoryEventLog.readIfExists(this.memoryPaths(principal).memoryEventsPath);
  }

  private ensureStorageLayout(): Promise<void> {
    // Fail-open (gate #180 finding #2): a probe/wipe failure must NOT memoize a
    // rejected promise — that would brick every store access until restart. Log,
    // continue on the current layout, and let the next launch re-probe.
    this.storageLayoutPromise ??= this.cleanLegacyStorageLayout().catch((error) => {
      console.warn(`Agent storage clean-cut probe failed; continuing on the current layout: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.storageLayoutPromise;
  }

  /**
   * Pre-release clean-cut (no migration, no legacy reader): when any
   * pre-conversation-vocabulary artifact is detected, the WHOLE agent data root
   * is deleted and recreated lazily — identities, conversations, runs, pools and
   * indexes all start fresh (M0 #150 precedent; [[agent-storage-clean-cut]]).
   */
  private async cleanLegacyStorageLayout(): Promise<void> {
    if (!await this.hasLegacyStorageArtifacts()) return;
    await rm(this.rootDir, { recursive: true, force: true });
    this.agentEventLog.clear();
    this.memoryEventLog.clear();
    this.memoryProjectionByPrincipal.clear();
  }

  private async hasLegacyStorageArtifacts(): Promise<boolean> {
    // Pre-#151 layout: a flat `sessions/` tree or its derived index.
    if (await pathExists(path.join(this.rootDir, LEGACY_SESSIONS_DIR))) return true;
    if (await pathExists(path.join(this.rootDir, 'indexes', LEGACY_SESSION_INDEX_FILE))) return true;
    // Pre-clean-cut pool layout: an agent pool inside the identity directory.
    if (await this.hasLegacyAgentPool()) return true;
    // Pre-clean-cut event vocabulary: a conversation log written with `session.*` events.
    return this.hasLegacyEventVocabulary();
  }

  private async hasLegacyAgentPool(): Promise<boolean> {
    const agentsDir = this.paths('__placeholder__').agentsDir;
    try {
      for (const entry of await readdir(agentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (await pathExists(path.join(agentsDir, entry.name, 'memory'))) return true;
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    return false;
  }

  private async hasLegacyEventVocabulary(): Promise<boolean> {
    // Every old event carried a `sessionId` FIELD (and logs opened with a
    // `session.created` head), so one head line tells the vocabularies apart.
    // The check is structural (parse, then inspect fields) — NEVER a substring
    // probe: the head event carries user-controllable title/goal text that may
    // legitimately contain '"sessionId"' (gate #180 finding #1), and a wipe must
    // not be content-triggerable. A torn/corrupt/over-long head is ambiguity,
    // not a legacy marker — the destructive path requires positive proof.
    const conversationsDir = this.paths('__placeholder__').conversationsDir;
    try {
      for (const entry of await readdir(conversationsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const head = await readFirstLine(
          path.join(conversationsDir, entry.name, 'segments', CONVERSATION_SEGMENT_FILE),
        );
        if (!head) continue;
        const event = parseJsonRecord(head);
        if (!event) continue;
        if (typeof event.sessionId === 'string') return true;
        if (typeof event.type === 'string' && event.type.startsWith('session.')) return true;
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    return false;
  }

  private async replayFromCheckpoint(conversationId: string): Promise<AgentEventReplayState | null> {
    const checkpoint = await this.readLatestCheckpoint(conversationId);
    if (!checkpoint) return null;
    try {
      const tail = await this.readEventFileTail(conversationId);
      if (tail.seq < checkpoint.seq) return null;
      if (tail.seq === checkpoint.seq && tail.eventId !== checkpoint.latestEventId) return null;
      if (!await this.checkpointTargetsAreUsable(conversationId, checkpoint.targets)) return null;
      const tailEvents = await this.readEventsAfterCheckpoint(conversationId, checkpoint);
      const state = cloneReplayState(checkpoint.state);
      for (const event of tailEvents) {
        appendAgentEventToReplayState(state, event);
      }
      return state;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  private async getLatestSeq(conversationId: string): Promise<number> {
    return this.agentEventLog.latestSeq(conversationId, () => this.eventLogPathsForConversation(conversationId));
  }

  private assertEventBatch(conversationId: string, events: readonly AgentEvent[]) {
    let previousSeq = 0;
    const eventIds = new Set<string>();
    for (const event of events) {
      if (event.conversationId !== conversationId) {
        throw new Error(`Agent event conversation mismatch: ${event.conversationId}`);
      }
      if (eventIds.has(event.eventId)) {
        throw new Error(`Duplicate agent event id in append batch: ${event.eventId}`);
      }
      if (event.seq <= previousSeq) {
        throw new Error(`Agent event batch is not strictly ordered at seq ${event.seq}`);
      }
      eventIds.add(event.eventId);
      previousSeq = event.seq;
    }
  }

  private async nextMemoryEvent(
    principal: AgentPrincipal,
    input: Omit<Extract<AgentMemoryEvent, { type: 'memory.entry_added' }>, 'v' | 'eventId' | 'seq' | 'principal'>
      | Omit<Extract<AgentMemoryEvent, { type: 'memory.entry_updated' }>, 'v' | 'eventId' | 'seq' | 'principal'>
      | Omit<Extract<AgentMemoryEvent, { type: 'memory.entry_removed' }>, 'v' | 'eventId' | 'seq' | 'principal'>
      | Omit<Extract<AgentMemoryEvent, { type: 'dream.completed' }>, 'v' | 'eventId' | 'seq' | 'principal'>,
  ): Promise<AgentMemoryEvent> {
    const key = principalKey(principal);
    const seq = await this.memoryEventLog.latestSeq(key, () => [this.memoryPaths(principal).memoryEventsPath]) + 1;
    return {
      v: 1,
      eventId: `memory-event-${randomUUID()}`,
      seq,
      principal,
      ...input,
    } as AgentMemoryEvent;
  }

  private async appendMemoryEvents(principal: AgentPrincipal, events: readonly AgentMemoryEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.memoryEventLog.appendForKey(principalKey(principal), this.memoryPaths(principal).memoryEventsPath, events);
  }

  private async getMemoryProjection(principal: AgentPrincipal): Promise<AgentMemoryProjectionCache> {
    const key = principalKey(principal);
    const latestSeq = await this.memoryEventLog.latestSeq(key, () => [this.memoryPaths(principal).memoryEventsPath]);
    const cached = this.memoryProjectionByPrincipal.get(key);
    if (cached && cached.latestSeq === latestSeq) return cached;

    const events = await this.readMemoryEvents(principal);
    const projected = projectMemoryEvents(events);
    const projection: AgentMemoryProjectionCache = {
      latestSeq,
      eventCount: events.length,
      entries: projected.entries,
      dream: projected.dream,
    };
    this.memoryProjectionByPrincipal.set(key, projection);
    return projection;
  }

  private async maybeCompactMemoryLog(principal: AgentPrincipal, projection: AgentMemoryProjectionCache): Promise<void> {
    if (projection.eventCount < MEMORY_COMPACTION_MIN_EVENTS) return;
    const projectedEntryCount = Math.max(1, projection.entries.size);
    if (projection.eventCount < projectedEntryCount * MEMORY_COMPACTION_CHURN_FACTOR) return;

    const events = compactMemoryProjection(principal, projection.entries, projection.dream.lastCompleted);
    const filePath = this.memoryPaths(principal).memoryEventsPath;
    await mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, serializeJsonl(events));
    const latestSeq = events.at(-1)?.seq ?? 0;
    projection.latestSeq = latestSeq;
    projection.eventCount = events.length;
    this.memoryEventLog.setLatestSeq(principalKey(principal), latestSeq);
  }

  private async readEventFileTail(conversationId: string): Promise<AgentEventFileTail> {
    return this.agentEventLog.latestTailForFiles(await this.eventLogPathsForConversation(conversationId));
  }

  private async eventLogPathsForConversation(conversationId: string): Promise<string[]> {
    const paths = this.paths(conversationId);
    return [
      paths.conversationEventsPath,
      ...(await this.listRunIdsForConversation(conversationId)).map((runId) => this.runPaths(runId).runEventsPath),
    ];
  }

  private async appendSplitEvents(conversationId: string, events: readonly AgentEvent[]): Promise<void> {
    const paths = this.paths(conversationId);
    const conversationEvents: AgentEvent[] = [];
    const runEvents = new Map<string, AgentEvent[]>();

    for (const event of events) {
      const runId = agentRunIdForEvent(event);
      if (runId && isRunLogEvent(event)) {
        const group = runEvents.get(runId) ?? [];
        group.push(event);
        runEvents.set(runId, group);
      } else {
        conversationEvents.push(event);
      }
    }

    if (conversationEvents.length > 0) {
      await this.agentEventLog.append(paths.conversationEventsPath, conversationEvents);
    } else {
      await mkdir(paths.conversationDir, { recursive: true });
    }

    for (const [runId, group] of runEvents) {
      const runPaths = this.runPaths(runId);
      const metaEvents = group.filter((event) => !isStreamingDeltaEvent(event));
      await this.agentEventLog.append(runPaths.runEventsPath, group);
      if (metaEvents.length > 0) {
        const meta = await this.updateRunMeta(conversationId, runId, metaEvents);
        if (meta) await this.updateRunIndexes(meta);
      }
    }

    const metaEvents = events.filter((event) => !isStreamingDeltaEvent(event));
    if (metaEvents.length > 0) await this.updateConversationMeta(conversationId, metaEvents);
  }

  private async readRunEventsForConversation(conversationId: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for (const runId of await this.listRunIdsForConversation(conversationId)) {
      events.push(...await this.agentEventLog.readIfExists(this.runPaths(runId).runEventsPath));
    }
    return events;
  }

  private async listRunIdsForConversation(conversationId: string): Promise<string[]> {
    return (await this.ensureConversationRunIndex(conversationId)).runIds;
  }

  private async ensureConversationRunIndex(conversationId: string): Promise<AgentConversationRunIndex> {
    const index = await this.readConversationRunIndex(conversationId);
    if (index) return index;
    if (!await this.conversationDirExists(conversationId)) {
      return { v: 1, runIds: [], latestSeqByRunId: {} };
    }
    return this.rebuildConversationRunIndex(conversationId);
  }

  private async ensurePrincipalRunIndex(principal: AgentPrincipal): Promise<AgentPrincipalRunIndex> {
    const index = await this.readPrincipalRunIndex(principal);
    if (index) return index;
    return this.rebuildPrincipalRunIndex(principal);
  }

  private async conversationDirExists(conversationId: string): Promise<boolean> {
    try {
      await readdir(this.paths(conversationId).conversationDir);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  private async rebuildConversationRunIndex(conversationId: string): Promise<AgentConversationRunIndex> {
    const paths = this.paths(conversationId);
    const latestSeqByRunId: Record<string, number> = {};
    try {
      const entries = await readdir(paths.runsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(paths.runsDir, entry.name);
        try {
          const meta = normalizeRunMeta(JSON.parse(await readFile(path.join(runDir, RUN_META_FILE), 'utf8')));
          if (!meta || conversationIdOfRun(meta) !== conversationId) continue;
          latestSeqByRunId[meta.id] = Math.max(latestSeqByRunId[meta.id] ?? 0, meta.latestSeq);
        } catch (error) {
          if (isNotFoundError(error) || error instanceof SyntaxError) continue;
          throw error;
        }
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    const runIds = Object.keys(latestSeqByRunId).sort((left, right) => (
      latestSeqByRunId[left]! - latestSeqByRunId[right]! || left.localeCompare(right)
    ));
    const index: AgentConversationRunIndex = { v: 1, runIds, latestSeqByRunId };
    await mkdir(paths.conversationDir, { recursive: true });
    await atomicWriteFile(paths.conversationRunIndexPath, `${JSON.stringify(index)}\n`);
    return index;
  }

  private async rebuildPrincipalRunIndex(principal: AgentPrincipal): Promise<AgentPrincipalRunIndex> {
    const updatedAtByRunId: Record<string, number> = {};
    const paths = this.paths('__placeholder__');
    try {
      const entries = await readdir(paths.runsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(paths.runsDir, entry.name);
        try {
          const meta = normalizeRunMeta(JSON.parse(await readFile(path.join(runDir, RUN_META_FILE), 'utf8')));
          if (!meta || meta.anchor.type !== 'principal' || !samePrincipal(meta.anchor.principal, principal)) continue;
          updatedAtByRunId[meta.id] = Math.max(updatedAtByRunId[meta.id] ?? 0, meta.updatedAt);
        } catch (error) {
          if (isNotFoundError(error) || error instanceof SyntaxError) continue;
          throw error;
        }
      }
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    const runIds = Object.keys(updatedAtByRunId).sort((left, right) => (
      updatedAtByRunId[right]! - updatedAtByRunId[left]! || left.localeCompare(right)
    ));
    const index: AgentPrincipalRunIndex = { v: 1, principalKey: principalKey(principal), runIds, updatedAtByRunId };
    const poolPaths = this.memoryPaths(principal);
    await mkdir(poolPaths.poolDir, { recursive: true });
    await atomicWriteFile(poolPaths.runIndexPath, `${JSON.stringify(index)}\n`);
    return index;
  }

  private async readEventsAfterCheckpoint(
    conversationId: string,
    checkpoint: AgentEventCheckpoint,
  ): Promise<AgentEvent[]> {
    const paths = this.paths(conversationId);
    const events = [
      ...await this.agentEventLog.readFromOffsetIfExists(
        paths.conversationEventsPath,
        checkpoint.targets.conversationByteOffset,
        checkpoint.seq,
      ),
    ];
    for (const runId of await this.listRunIdsForConversation(conversationId)) {
      events.push(...await this.agentEventLog.readFromOffsetIfExists(
        this.runPaths(runId).runEventsPath,
        checkpoint.targets.runByteOffsets[runId] ?? 0,
        checkpoint.seq,
      ));
    }
    return events.sort(compareAgentEventsForReplay);
  }

  private async checkpointTargets(conversationId: string): Promise<AgentEventCheckpointTargets> {
    const paths = this.paths(conversationId);
    const runByteOffsets: Record<string, number> = {};
    for (const runId of await this.listRunIdsForConversation(conversationId)) {
      runByteOffsets[runId] = await this.agentEventLog.fileSizeIfExists(this.runPaths(runId).runEventsPath);
    }
    return {
      conversationByteOffset: await this.agentEventLog.fileSizeIfExists(paths.conversationEventsPath),
      runByteOffsets,
    };
  }

  private async checkpointTargetsAreUsable(
    conversationId: string,
    targets: AgentEventCheckpointTargets,
  ): Promise<boolean> {
    const paths = this.paths(conversationId);
    if (targets.conversationByteOffset > await this.agentEventLog.fileSizeIfExists(paths.conversationEventsPath)) return false;
    for (const [runId, byteOffset] of Object.entries(targets.runByteOffsets)) {
      if (byteOffset > await this.agentEventLog.fileSizeIfExists(this.runPaths(runId).runEventsPath)) return false;
    }
    return true;
  }

  private async readRunMeta(runId: string): Promise<AgentRunMetaProjection | null> {
    try {
      const raw = await readFile(this.runPaths(runId).runMetaPath, 'utf8');
      return normalizeRunMeta(JSON.parse(raw));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async readConversationRunIndex(conversationId: string): Promise<AgentConversationRunIndex | null> {
    try {
      const raw = await readFile(this.paths(conversationId).conversationRunIndexPath, 'utf8');
      return normalizeConversationRunIndex(JSON.parse(raw));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async readPrincipalRunIndex(principal: AgentPrincipal): Promise<AgentPrincipalRunIndex | null> {
    try {
      const raw = await readFile(this.memoryPaths(principal).runIndexPath, 'utf8');
      return normalizePrincipalRunIndex(JSON.parse(raw), principalKey(principal));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async updateRunIndexes(meta: AgentRunMetaProjection) {
    const conversationId = conversationIdOfRun(meta);
    if (conversationId) {
      await this.updateConversationRunIndex(conversationId, meta.id, meta.latestSeq);
    }
    if (meta.anchor.type === 'principal') {
      await this.updatePrincipalRunIndex(meta.anchor.principal, meta.id, meta.updatedAt);
    }
  }

  private async updateConversationRunIndex(conversationId: string, runId: string, latestSeq: number) {
    const paths = this.paths(conversationId);
    const existing = await this.ensureConversationRunIndex(conversationId);
    const runIds = existing.runIds.includes(runId) ? existing.runIds : [...existing.runIds, runId];
    const index: AgentConversationRunIndex = {
      v: 1,
      runIds,
      latestSeqByRunId: {
        ...existing.latestSeqByRunId,
        [runId]: Math.max(existing.latestSeqByRunId[runId] ?? 0, latestSeq),
      },
    };
    await mkdir(paths.conversationDir, { recursive: true });
    await atomicWriteFile(paths.conversationRunIndexPath, `${JSON.stringify(index)}\n`);
  }

  private async updatePrincipalRunIndex(principal: AgentPrincipal, runId: string, updatedAt: number) {
    const poolPaths = this.memoryPaths(principal);
    const existing = await this.ensurePrincipalRunIndex(principal);
    const runIds = existing.runIds.includes(runId) ? existing.runIds : [...existing.runIds, runId];
    const index: AgentPrincipalRunIndex = {
      v: 1,
      principalKey: principalKey(principal),
      runIds,
      updatedAtByRunId: {
        ...existing.updatedAtByRunId,
        [runId]: Math.max(existing.updatedAtByRunId[runId] ?? 0, updatedAt),
      },
    };
    index.runIds.sort((left, right) => (
      index.updatedAtByRunId[right]! - index.updatedAtByRunId[left]! || left.localeCompare(right)
    ));
    await mkdir(poolPaths.poolDir, { recursive: true });
    await atomicWriteFile(poolPaths.runIndexPath, `${JSON.stringify(index)}\n`);
  }

  private async updateRunMeta(conversationId: string, runId: string, events: readonly AgentEvent[]): Promise<AgentRunMetaProjection | null> {
    const existing = await this.readRunMeta(runId);
    const latest = events.at(-1);
    if (!latest) return null;
    const terminal = [...events].reverse().find(isRunTerminalEvent);
    const started = events.find((event) => event.type === 'run.started');
    const agentId = asAgentId(existing?.agentId ?? (started?.type === 'run.started' ? started.agentId ?? (started.anchor ? agentIdOfRunAnchor(started.anchor) : undefined) : undefined) ?? agentIdFromEvents(events) ?? 'built-in:tenon:assistant')!;
    const anchor = existing?.anchor ?? (started?.type === 'run.started' ? normalizeRunAnchor(started.anchor, agentId) : null) ?? conversationRunAnchor(agentId, conversationId);
    const meta: AgentRunMetaProjection = {
      v: 1,
      id: runId,
      agentId,
      anchor,
      parentRunId: existing?.parentRunId,
      kind: existing?.kind ?? (started?.type === 'run.started' ? started.kind : undefined) ?? 'turn',
      status: terminal ? runStatusFromTerminalEvent(terminal) : existing?.status ?? 'running',
      trigger: existing?.trigger ?? (started?.type === 'run.started' ? started.trigger : undefined) ?? { type: 'manual' },
      usage: terminal?.usage ?? existing?.usage,
      fingerprint: existing?.fingerprint ?? (started?.type === 'run.started' ? started.fingerprint : undefined) ?? emptyRunFingerprint(),
      retention: existing?.retention ?? (started?.type === 'run.started' ? started.retention : undefined) ?? 'hot',
      createdAt: existing?.createdAt ?? started?.createdAt ?? events[0]!.createdAt,
      updatedAt: latest.createdAt,
      latestSeq: latest.seq,
    };
    const runPaths = this.runPaths(runId);
    await mkdir(runPaths.runDir, { recursive: true });
    await atomicWriteFile(runPaths.runMetaPath, `${JSON.stringify(meta)}\n`);
    return meta;
  }

  private async updateConversationMeta(conversationId: string, events: readonly AgentEvent[]) {
    const paths = this.paths(conversationId);
    const existing = await this.readConversationMeta(conversationId);
    const created = events.find((event) => event.type === 'conversation.created');
    const renamed = [...events].reverse().find((event) => event.type === 'conversation.renamed');
    const latest = events.at(-1);
    if (!created && !renamed && !latest) return;
    const members = foldMembers(existing?.members ?? [], events);
    const meta: AgentConversationMetaProjection = {
      v: 1,
      id: conversationId,
      members,
      goal: renamed?.goal ?? created?.goal ?? existing?.goal,
      createdAt: existing?.createdAt ?? created?.createdAt ?? latest!.createdAt,
      title: renamed?.title ?? created?.title ?? existing?.title ?? null,
      name: renamed?.title ?? created?.title ?? existing?.name,
      updatedAt: Math.max(existing?.updatedAt ?? 0, latest?.createdAt ?? 0),
      latestSeq: Math.max(existing?.latestSeq ?? 0, latest?.seq ?? 0),
    };
    await mkdir(paths.conversationDir, { recursive: true });
    await atomicWriteFile(paths.conversationMetaPath, `${JSON.stringify(meta)}\n`);
  }

  private async readConversationMeta(conversationId: string): Promise<AgentConversationMetaProjection | null> {
    try {
      const raw = await readFile(this.paths(conversationId).conversationMetaPath, 'utf8');
      return normalizeConversationMeta(JSON.parse(raw));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private enqueueIndexWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.indexQueue.then(operation, operation);
    this.indexQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async updateConversationIndex(conversationId: string, events: readonly AgentEvent[]) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readConversationIndex() ?? { conversations: {} };
      let entry: AgentConversationIndexEntry | null = index.conversations[conversationId] ?? null;
      for (const event of events) {
        if (event.type === 'conversation.created') {
          entry = {
            id: conversationId,
            title: event.title,
            members: event.members?.slice() ?? [],
            goal: event.goal,
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
            messageCount: entry?.messageCount ?? 0,
            latestSeq: event.seq,
            unreadCount: entry?.unreadCount ?? 0,
          };
        } else if (entry) {
          entry = updateConversationIndexEntry(entry, event);
        }
      }
      if (!entry) entry = conversationIndexEntryFromReplayState(conversationId, await this.replay(conversationId));
      if (entry) index.conversations[conversationId] = entry;
      await this.writeConversationIndex(index);
    });
  }

  private async removeConversationFromIndex(conversationId: string) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readConversationIndex();
      if (!index || !index.conversations[conversationId]) return;
      delete index.conversations[conversationId];
      await this.writeConversationIndex(index);
    });
  }

  private async rebuildConversationIndex(): Promise<AgentConversationIndexEntry[]> {
    const ids = await this.listConversationIds();
    const entries: AgentConversationIndexEntry[] = [];
    for (const id of ids) {
      const state = await this.replay(id);
      const entry = conversationIndexEntryFromReplayState(id, state);
      if (entry) entries.push(entry);
    }
    const conversations = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    await this.writeConversationIndex({ conversations });
    return entries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async getSearchIndex(): Promise<AgentEventSearchIndex> {
    return await this.readSearchIndex() ?? await this.rebuildSearchIndex();
  }

  private async updateSearchIndex(_conversationId: string, events: readonly AgentEvent[]) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readSearchIndex() ?? await this.buildSearchIndexFromEventLogs();
      for (const event of events) applyAgentEventToSearchIndex(index, event);
      await this.writeSearchIndex(index);
    });
  }

  private async removeConversationFromSearchIndex(conversationId: string) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readSearchIndex();
      if (!index) return;
      for (const [key, entry] of Object.entries(index.messages)) {
        if (entry.conversationId === conversationId) delete index.messages[key];
      }
      for (const [key, entry] of Object.entries(index.userMessages)) {
        if (entry.conversationId === conversationId) delete index.userMessages[key];
      }
      delete index.latestSeqByConversationId[conversationId];
      await this.writeSearchIndex(index);
    });
  }

  private async rebuildSearchIndex(): Promise<AgentEventSearchIndex> {
    const index = await this.buildSearchIndexFromEventLogs();
    await this.writeSearchIndex(index);
    return index;
  }

  private async buildSearchIndexFromEventLogs(): Promise<AgentEventSearchIndex> {
    const index = createEmptySearchIndex();
    const ids = await this.listConversationIds();
    for (const id of ids) {
      for (const event of await this.readEvents(id)) {
        applyAgentEventToSearchIndex(index, event);
      }
    }
    return index;
  }

  private async readLatestCheckpoint(conversationId: string): Promise<AgentEventCheckpoint | null> {
    const paths = this.paths(conversationId);
    let entries: string[] = [];
    try {
      entries = await readdir(paths.checkpointsDir);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }

    const candidates = entries
      .map((name) => ({
        name,
        seq: parseCheckpointSeq(name),
      }))
      .filter((candidate): candidate is { name: string; seq: number } => candidate.seq !== null)
      .sort((left, right) => right.seq - left.seq);

    for (const candidate of candidates) {
      try {
        const raw = await readFile(path.join(paths.checkpointsDir, candidate.name), 'utf8');
        const checkpoint = normalizeCheckpoint(JSON.parse(raw), conversationId);
        if (!checkpoint) continue;
        return checkpoint;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async pruneCheckpoints(conversationId: string) {
    const paths = this.paths(conversationId);
    let entries: string[] = [];
    try {
      entries = await readdir(paths.checkpointsDir);
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }

    const valid: Array<{ name: string; seq: number }> = [];
    const stale: string[] = [];
    for (const name of entries) {
      const seq = parseCheckpointSeq(name);
      if (seq === null) {
        if (isCheckpointTempFile(name)) stale.push(name);
        continue;
      }
      try {
        const raw = await readFile(path.join(paths.checkpointsDir, name), 'utf8');
        if (normalizeCheckpoint(JSON.parse(raw), conversationId)) valid.push({ name, seq });
        else stale.push(name);
      } catch {
        stale.push(name);
      }
    }

    valid.sort((left, right) => right.seq - left.seq);
    stale.push(...valid.slice(MAX_CHECKPOINTS_PER_CONVERSATION).map((entry) => entry.name));
    await Promise.all(stale.map(async (name) => {
      try {
        await rm(path.join(paths.checkpointsDir, name), { force: true });
      } catch {
        // Checkpoints are derived caches. A failed cleanup must not block chat restore.
      }
    }));
  }

  private conversationIndexPath(): string {
    return path.join(this.rootDir, 'indexes', CONVERSATION_INDEX_FILE);
  }

  private searchIndexPath(): string {
    return path.join(this.rootDir, 'indexes', SEARCH_INDEX_FILE);
  }

  private async readConversationIndex(): Promise<{ conversations: Record<string, AgentConversationIndexEntry> } | null> {
    const indexPath = this.conversationIndexPath();
    try {
      const raw = await readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as { conversations?: unknown };
      return {
        conversations: isRecord(parsed.conversations) ? parsed.conversations as Record<string, AgentConversationIndexEntry> : {},
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw new Error(`Invalid agent conversation index at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async conversationIndexMatchesConversations(index: {
    conversations: Record<string, AgentConversationIndexEntry>;
  }): Promise<boolean> {
    const indexedIds = new Set(Object.keys(index.conversations));
    const conversationIds = new Set(await this.listConversationIds());
    if (indexedIds.size !== conversationIds.size) return false;
    for (const id of indexedIds) {
      if (!conversationIds.has(id)) return false;
    }
    return true;
  }

  private async writeConversationIndex(index: { conversations: Record<string, AgentConversationIndexEntry> }) {
    const indexPath = this.conversationIndexPath();
    await mkdir(path.dirname(indexPath), { recursive: true });
    await atomicWriteFile(indexPath, `${JSON.stringify(index)}\n`);
  }

  private async readSearchIndex(): Promise<AgentEventSearchIndex | null> {
    const indexPath = this.searchIndexPath();
    try {
      const raw = await readFile(indexPath, 'utf8');
      return normalizeSearchIndex(JSON.parse(raw));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw new Error(`Invalid agent search index at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeSearchIndex(index: AgentEventSearchIndex) {
    const indexPath = this.searchIndexPath();
    await mkdir(path.dirname(indexPath), { recursive: true });
    await atomicWriteFile(indexPath, `${JSON.stringify(index)}\n`);
  }
}

function updateConversationIndexEntry(
  entry: AgentConversationIndexEntry,
  event: AgentEvent,
): AgentConversationIndexEntry {
  // notification.created/read are off-floor attention bookkeeping, not activity:
  // they must not bump updatedAt (which sorts + timestamps the list). Mirrors the
  // replay reducer's touchConversationUpdatedAt skip.
  const isAttentionEvent =
    event.type === 'notification.created' || event.type === 'notification.read';
  const next: AgentConversationIndexEntry = {
    ...entry,
    updatedAt: isAttentionEvent ? entry.updatedAt : Math.max(entry.updatedAt, event.createdAt),
    latestSeq: Math.max(entry.latestSeq, event.seq),
  };
  // Fold unreadCount in O(1), not via a full replay. A created notification always
  // carries the highest seq (so it is unread by construction → +1). The fold's
  // `read → 0` relies on the invariant that the ONLY emitter of notification.read
  // (markConversationRead) takes throughSeq INSIDE the serial append, i.e. reads
  // through the tail-at-write-time, so a read genuinely clears the whole conversation
  // — even if a notification completed in the gap. (A future partial-read emitter
  // would have to recompute this fold or rebuild from replay.) The replay reducer
  // remains the authority for the full-rebuild path, which this matches.
  if (event.type === 'notification.created') {
    next.unreadCount += 1;
  } else if (event.type === 'notification.read') {
    next.unreadCount = 0;
  }
  if (event.type === 'conversation.renamed') {
    next.title = event.title;
    next.goal = event.goal ?? next.goal;
  }
  if (event.type === 'member.added') {
    next.members = mergePrincipals(next.members, [event.member]);
  }
  if (event.type === 'member.removed') {
    const key = principalKey(event.member);
    next.members = next.members.filter((member) => principalKey(member) !== key);
  }
  if (
    event.type === 'user_message.created'
    || event.type === 'assistant_message.started'
    || event.type === 'tool_result.created'
  ) {
    next.messageCount += 1;
  }
  return next;
}

function conversationIndexEntryFromReplayState(
  conversationId: string,
  state: AgentEventReplayState,
): AgentConversationIndexEntry | null {
  if (!state.conversation) return null;
  return {
    id: conversationId,
    title: state.conversation.title,
    members: state.conversation.members.slice(),
    goal: state.conversation.goal,
    createdAt: state.conversation.createdAt,
    updatedAt: state.conversation.updatedAt,
    messageCount: Object.keys(state.messages).length,
    latestSeq: state.latestSeq,
    unreadCount: state.attentionByConversationId[conversationId]?.unreadCount ?? 0,
  };
}

function createEmptySearchIndex(): AgentEventSearchIndex {
  return {
    v: SEARCH_INDEX_VERSION,
    messages: {},
    userMessages: {},
    latestSeqByConversationId: {},
  };
}

function applyAgentEventToSearchIndex(index: AgentEventSearchIndex, event: AgentEvent) {
  index.latestSeqByConversationId[event.conversationId] = Math.max(
    index.latestSeqByConversationId[event.conversationId] ?? 0,
    event.seq,
  );

  if (event.type === 'user_message.created') {
    const content = indexDetailsFromContent(event.content);
    const payloadIds = uniqueStrings([
      ...content.payloadIds,
      ...(event.attachments ?? []).map((payload) => payload.id),
    ]);
    const entry: AgentEventUserMessageIndexEntry = {
      conversationId: event.conversationId,
      messageId: event.messageId,
      role: 'user',
      parentMessageId: event.parentMessageId,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      latestSeq: event.seq,
      text: content.text,
      normalizedText: content.normalizedText,
      preview: content.preview,
      payloadIds,
      replacesMessageId: event.replacesMessageId,
      hasAttachments: payloadIds.length > 0 || event.content.some((part) => part.type === 'image' || part.type === 'payload_ref'),
    };
    const key = searchIndexKey(event.conversationId, event.messageId);
    index.messages[key] = entry;
    index.userMessages[key] = entry;
    return;
  }

  if (event.type === 'user_message.edited') {
    const key = searchIndexKey(event.conversationId, event.messageId);
    const current = index.messages[key];
    if (!current || current.role !== 'user') return;
    const content = indexDetailsFromContent(event.content);
    const updated: AgentEventUserMessageIndexEntry = {
      ...current,
      role: 'user',
      updatedAt: event.createdAt,
      latestSeq: event.seq,
      text: content.text,
      normalizedText: content.normalizedText,
      preview: content.preview,
      payloadIds: content.payloadIds,
      replacesMessageId: index.userMessages[key]?.replacesMessageId,
      hasAttachments: content.payloadIds.length > 0
        || event.content.some((part) => part.type === 'image' || part.type === 'payload_ref')
        || index.userMessages[key]?.hasAttachments === true,
    };
    index.messages[key] = updated;
    index.userMessages[key] = updated;
    return;
  }

  if (event.type === 'assistant_message.started') {
    const key = searchIndexKey(event.conversationId, event.messageId);
    index.messages[key] ??= {
      conversationId: event.conversationId,
      messageId: event.messageId,
      role: 'assistant',
      parentMessageId: event.parentMessageId,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      latestSeq: event.seq,
      text: '',
      normalizedText: '',
      preview: '',
      payloadIds: [],
    };
    return;
  }

  if (event.type === 'assistant_message.completed') {
    const key = searchIndexKey(event.conversationId, event.messageId);
    const current = index.messages[key];
    const content = indexDetailsFromContent(event.content);
    index.messages[key] = {
      conversationId: event.conversationId,
      messageId: event.messageId,
      role: 'assistant',
      parentMessageId: current?.parentMessageId ?? null,
      createdAt: current?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
      latestSeq: event.seq,
      text: content.text,
      normalizedText: content.normalizedText,
      preview: content.preview,
      payloadIds: content.payloadIds,
    };
    return;
  }

  if (event.type === 'tool_result.created' || event.type === 'tool_result.replaced') {
    const key = searchIndexKey(event.conversationId, event.messageId);
    const current = index.messages[key];
    const content = indexDetailsFromContent([
      ...event.content,
      { type: 'text', text: event.outputSummary },
    ]);
    const outputPayloadIds = event.outputRef ? [event.outputRef.id] : [];
    index.messages[key] = {
      conversationId: event.conversationId,
      messageId: event.messageId,
      role: 'toolResult',
      parentMessageId: event.type === 'tool_result.created'
        ? event.parentMessageId
        : current?.parentMessageId ?? null,
      createdAt: current?.createdAt ?? event.createdAt,
      updatedAt: event.createdAt,
      latestSeq: event.seq,
      text: content.text,
      normalizedText: content.normalizedText,
      preview: content.preview,
      payloadIds: uniqueStrings([...content.payloadIds, ...outputPayloadIds]),
    };
  }
}

function indexDetailsFromContent(content: readonly AgentPersistedContent[]): {
  text: string;
  normalizedText: string;
  preview: string;
  payloadIds: string[];
} {
  const payloadIds: string[] = [];
  const pieces: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      pieces.push(part.text);
      continue;
    }
    if (part.type === 'toolCall') {
      pieces.push(`tool:${part.name}`);
      continue;
    }
    if (part.type === 'image') {
      payloadIds.push(part.imageRef.id);
      pieces.push(part.alt ?? part.imageRef.summary ?? `[image:${part.imageRef.id}]`);
      continue;
    }
    if (part.type === 'payload_ref') {
      payloadIds.push(part.payload.id);
      pieces.push(part.label ?? part.payload.summary ?? `[payload:${part.payload.id}]`);
    }
  }

  const text = truncateIndexText(normalizeDisplayText(pieces.join('\n')), MAX_SEARCH_INDEX_TEXT_CHARS);
  return {
    text,
    normalizedText: normalizeIndexText(text),
    preview: truncateIndexText(text, SEARCH_INDEX_PREVIEW_CHARS),
    payloadIds: uniqueStrings(payloadIds),
  };
}

function normalizeSearchIndex(value: unknown): AgentEventSearchIndex | null {
  if (!isRecord(value) || value.v !== SEARCH_INDEX_VERSION) return null;
  if (!isRecord(value.messages) || !isRecord(value.userMessages)) return null;
  const latestSeqByConversationId = isRecord(value.latestSeqByConversationId)
    ? value.latestSeqByConversationId as Record<string, number>
    : {};
  return {
    v: SEARCH_INDEX_VERSION,
    messages: value.messages as Record<string, AgentEventSearchIndexEntry>,
    userMessages: value.userMessages as Record<string, AgentEventUserMessageIndexEntry>,
    latestSeqByConversationId,
  };
}

function searchIndexKey(conversationId: string, messageId: string): string {
  return `${encodeURIComponent(conversationId)}:${encodeURIComponent(messageId)}`;
}

function normalizeSearchTerms(query: string): string[] {
  return analyzeTextSearchQuery(query).terms.slice(0, 12);
}

function normalizeIndexText(text: string): string {
  return normalizeSearchText(normalizeDisplayText(text));
}

function normalizeDisplayText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateIndexText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}...`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function serializeJsonl(events: readonly unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

class AppendOnlySeqLog<TEvent extends { seq: number; eventId?: string }> {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly latestSeqByKey = new Map<string, number>();

  constructor(
    private readonly label: string,
    private readonly parse: (raw: string, source: string) => TEvent[],
  ) {}

  enqueue<TResult>(key: string, operation: () => Promise<TResult>): Promise<TResult> {
    const current = this.writeQueues.get(key) ?? Promise.resolve();
    const next = current.then(operation, operation);
    this.writeQueues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  async latestSeq(key: string, paths: () => Promise<readonly string[]> | readonly string[]): Promise<number> {
    const cached = this.latestSeqByKey.get(key);
    if (cached !== undefined) return cached;
    const tail = await this.latestTailForFiles(await paths());
    this.latestSeqByKey.set(key, tail.seq);
    return tail.seq;
  }

  setLatestSeq(key: string, seq: number): void {
    this.latestSeqByKey.set(key, Math.max(0, Math.trunc(seq)));
  }

  deleteKey(key: string): void {
    this.latestSeqByKey.delete(key);
    this.writeQueues.delete(key);
  }

  clear(): void {
    this.latestSeqByKey.clear();
    this.writeQueues.clear();
  }

  async append(filePath: string, events: readonly TEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(path.dirname(filePath), { recursive: true });
    await this.repairTornTailBeforeAppend(filePath);
    await appendFile(filePath, serializeJsonl(events), 'utf8');
  }

  async appendForKey(key: string, filePath: string, events: readonly TEvent[]): Promise<void> {
    await this.append(filePath, events);
    this.setLatestSeq(key, events.at(-1)!.seq);
  }

  /**
   * Every intact log ends with '\n' (serializeJsonl and compaction both write it), so a
   * missing trailing newline means the previous append was interrupted mid-line. Appending
   * onto the torn fragment would weld two events into one garbage line — silently dropped
   * as the tail by a tolerant parser today, then bricking the log as a mid-file bad line
   * after the NEXT append. Truncate the fragment first; appends are serialized through the
   * per-key write queue, so the repair cannot race another write. The parse function still
   * owns the torn-tail policy: if it throws on the torn file, the append fails loudly
   * instead of writing past corruption.
   */
  private async repairTornTailBeforeAppend(filePath: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(filePath, 'r+');
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (stats.size === 0) return;
      const lastByte = Buffer.alloc(1);
      await handle.read(lastByte, 0, 1, stats.size - 1);
      if (lastByte[0] === 0x0a) return;
      const buffer = Buffer.alloc(stats.size);
      await handle.read(buffer, 0, stats.size, 0);
      const lastNewline = buffer.lastIndexOf(0x0a);
      const fragment = buffer.subarray(lastNewline + 1).toString('utf8');
      try {
        // A tear can land between the JSON text and its newline: the final line is then a
        // complete, readable event that must not be destroyed — only its newline was lost.
        JSON.parse(fragment);
        await handle.write('\n', stats.size, 'utf8');
        return;
      } catch {
        // Genuinely torn mid-line; fall through to the truncating repair.
      }
      this.parse(buffer.toString('utf8'), filePath);
      const keep = lastNewline === -1 ? 0 : lastNewline + 1;
      console.warn(`Repairing torn trailing ${this.label} line at ${filePath} (truncating ${stats.size - keep} bytes)`);
      await handle.truncate(keep);
    } finally {
      await handle.close();
    }
  }

  async readIfExists(filePath: string): Promise<TEvent[]> {
    try {
      return this.parse(await readFile(filePath, 'utf8'), filePath);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async readFromOffsetIfExists(filePath: string, byteOffset: number, minSeqExclusive: number): Promise<TEvent[]> {
    try {
      const raw = await this.readFileFromOffset(filePath, byteOffset);
      if (!raw.trim()) return [];
      return this.parse(raw, filePath).filter((event) => event.seq > minSeqExclusive);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async latestTailForFiles(filePaths: readonly string[]): Promise<AgentEventFileTail> {
    const tails = await Promise.all(filePaths.map((filePath) => this.readTail(filePath)));
    return tails.reduce((latest, candidate) => (
      candidate.seq > latest.seq ? candidate : latest
    ), { seq: 0, eventId: null });
  }

  async fileSizeIfExists(filePath: string): Promise<number> {
    try {
      const handle = await open(filePath, 'r');
      try {
        return (await handle.stat()).size;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNotFoundError(error)) return 0;
      throw error;
    }
  }

  private async readTail(filePath: string): Promise<AgentEventFileTail> {
    let line: string | null = null;
    try {
      line = await this.readLastNonEmptyLine(filePath);
      if (!line) return { seq: 0, eventId: null };
      const event = JSON.parse(line) as TEvent;
      return {
        seq: typeof event.seq === 'number' ? event.seq : 0,
        eventId: typeof event.eventId === 'string' ? event.eventId : null,
      };
    } catch (error) {
      if (isNotFoundError(error)) return { seq: 0, eventId: null };
      if (line !== null) {
        // The last line may be a torn crash artifact of an interrupted append. The log's
        // parse function owns the torn-tail policy: if it tolerates the tear, the tail is
        // the last intact event; if it throws, this log treats the file as corrupt.
        const events = this.parse(await readFile(filePath, 'utf8'), filePath);
        const last = events.at(-1);
        return { seq: last?.seq ?? 0, eventId: last?.eventId ?? null };
      }
      throw new Error(`Invalid ${this.label} tail at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readFileFromOffset(filePath: string, byteOffset: number): Promise<string> {
    const handle = await open(filePath, 'r');
    try {
      const stats = await handle.stat();
      const offset = Math.max(0, Math.trunc(byteOffset));
      if (offset > stats.size) throw new Error(`${this.label} checkpoint offset ${offset} exceeds ${filePath} size ${stats.size}`);
      if (offset === stats.size) return '';
      const buffer = Buffer.alloc(stats.size - offset);
      await handle.read(buffer, 0, buffer.byteLength, offset);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  private async readLastNonEmptyLine(filePath: string): Promise<string | null> {
    const handle = await open(filePath, 'r');
    try {
      const stats = await handle.stat();
      if (stats.size === 0) return null;
      const chunkSize = 4096;
      let position = stats.size;
      let suffix = '';
      while (position > 0) {
        const readSize = Math.min(chunkSize, position);
        position -= readSize;
        const buffer = Buffer.alloc(readSize);
        await handle.read(buffer, 0, readSize, position);
        const text = buffer.toString('utf8');
        suffix = text + suffix;
        const lines = suffix.split('\n').filter((line) => line.trim().length > 0);
        if (lines.length > 0 && (position === 0 || text.startsWith('\n'))) return lines.at(-1)!;
        if (lines.length > 1) return lines.at(-1)!;
      }
      const trimmed = suffix.trim();
      return trimmed || null;
    } finally {
      await handle.close();
    }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

/** First line of a file (bounded read), or null when the file is missing or empty. */
async function readFirstLine(filePath: string, maxBytes = 64 * 1024): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, 'r');
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    const size = Math.min(stats.size, maxBytes);
    if (size === 0) return null;
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    const text = buffer.toString('utf8');
    const newlineIndex = text.indexOf('\n');
    return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  } finally {
    await handle.close();
  }
}

function compareAgentEventsForReplay(left: AgentEvent, right: AgentEvent): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId);
}

function agentRunIdForEvent(event: AgentEvent): string | null {
  return typeof event.runId === 'string' && event.runId.length > 0 ? event.runId : null;
}

function isRunLogEvent(event: AgentEvent): boolean {
  switch (event.type) {
    case 'payload.created':
    case 'payload.derived':
      return event.payload.scope?.type === 'run' || agentRunIdForEvent(event) !== null;
    case 'conversation.created':
    case 'conversation.renamed':
    case 'conversation.settings_changed':
    case 'branch.selected':
    case 'user_message.created':
    case 'user_message.edited':
    case 'follow_up.queued':
    case 'follow_up.applied':
    case 'compaction.completed':
    case 'dream.finished':
    case 'checkpoint.created':
      return false;
    default:
      return agentRunIdForEvent(event) !== null;
  }
}

function isStreamingDeltaEvent(event: AgentEvent): boolean {
  return event.type === 'assistant_message.delta'
    || event.type === 'thinking.delta'
    || event.type === 'tool_call.delta';
}

function isRunTerminalEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' }> {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled';
}

function runStatusFromTerminalEvent(event: Extract<AgentEvent, { type: 'run.completed' | 'run.failed' | 'run.cancelled' }>): AgentRunStatus {
  if (event.type === 'run.completed') return 'completed';
  if (event.type === 'run.failed') return 'failed';
  return 'cancelled';
}

function agentIdFromEvents(events: readonly AgentEvent[]): string | null {
  for (const event of events) {
    if (event.actor.type === 'agent') return event.actor.agentId;
  }
  return null;
}

/**
 * Ordered membership fold for the conversation meta projection. ONLY the
 * membership events (the head's member set, member.added, member.removed)
 * move the roster: deriving members from ordinary events' actors would re-add
 * a removed member from its own in-flight run events, permanently diverging
 * meta.json from the replay reducer (the meta fold has no rebuild path).
 * Mirrors the replay reducer exactly.
 */
function foldMembers(current: readonly AgentPrincipal[], events: readonly AgentEvent[]): AgentPrincipal[] {
  let members = current.slice();
  for (const event of events) {
    if (event.type === 'conversation.created') {
      members = mergePrincipals(members, event.members?.slice() ?? []);
      continue;
    }
    if (event.type === 'member.removed') {
      const key = principalKey(event.member);
      members = members.filter((member) => principalKey(member) !== key);
      continue;
    }
    if (event.type === 'member.added') {
      members = mergePrincipals(members, [event.member]);
    }
  }
  return members;
}

/** Store-side merge: sorted by key for a stable list-index serialization. */
function mergePrincipals(current: readonly AgentPrincipal[], next: readonly AgentPrincipal[]): AgentPrincipal[] {
  return mergeUniquePrincipals(current, next)
    .sort((left, right) => principalKey(left).localeCompare(principalKey(right)));
}

function emptyRunFingerprint(): AgentRunFingerprint {
  return {
    appVersion: 'unknown',
    promptHash: 'unknown',
    toolSchemaHash: 'unknown',
    skillBindings: [],
    modelConfig: 'unknown',
  };
}

function normalizeConversationRunIndex(value: unknown): AgentConversationRunIndex | null {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.runIds)) return null;
  const latestSeqByRunId = isRecord(value.latestSeqByRunId)
    ? Object.fromEntries(Object.entries(value.latestSeqByRunId).filter((entry): entry is [string, number] => (
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )))
    : {};
  return {
    v: 1,
    runIds: uniqueStrings(value.runIds.filter((runId): runId is string => typeof runId === 'string')),
    latestSeqByRunId,
  };
}

function normalizePrincipalRunIndex(value: unknown, expectedPrincipalKey: string): AgentPrincipalRunIndex | null {
  if (!isRecord(value) || value.v !== 1 || value.principalKey !== expectedPrincipalKey || !Array.isArray(value.runIds)) return null;
  const updatedAtByRunId = isRecord(value.updatedAtByRunId)
    ? Object.fromEntries(Object.entries(value.updatedAtByRunId).filter((entry): entry is [string, number] => (
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )))
    : {};
  const runIds = uniqueStrings(value.runIds.filter((runId): runId is string => typeof runId === 'string'))
    .sort((left, right) => (
      (updatedAtByRunId[right] ?? 0) - (updatedAtByRunId[left] ?? 0) || left.localeCompare(right)
    ));
  return {
    v: 1,
    principalKey: expectedPrincipalKey,
    runIds,
    updatedAtByRunId,
  };
}

function normalizeRunMeta(value: unknown): AgentRunMetaProjection | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (typeof value.agentId !== 'string') return null;
  if (typeof value.id !== 'string') return null;
  const anchor = normalizeRunAnchor(value.anchor, value.agentId) ?? (
    typeof value.conversationId === 'string'
      ? conversationRunAnchor(value.agentId, value.conversationId)
      : null
  );
  if (!anchor) return null;
  if (!isAgentRunStatus(value.status) || !isAgentRunRetention(value.retention)) return null;
  if (!isRecord(value.trigger) || typeof value.trigger.type !== 'string') return null;
  if (!isRecord(value.fingerprint)) return null;
  const createdAt = numberOrNull(value.createdAt);
  const updatedAt = numberOrNull(value.updatedAt);
  const latestSeq = numberOrNull(value.latestSeq);
  if (createdAt === null || updatedAt === null || latestSeq === null) return null;
  return {
    v: 1,
    id: value.id,
    agentId: asAgentId(value.agentId)!,
    anchor,
    parentRunId: typeof value.parentRunId === 'string' ? value.parentRunId : undefined,
    kind: isAgentRunKind(value.kind) ? value.kind : 'turn',
    status: value.status,
    trigger: value.trigger as AgentRunTrigger,
    usage: isRecord(value.usage) ? value.usage as unknown as Usage : undefined,
    fingerprint: value.fingerprint as unknown as AgentRunFingerprint,
    retention: value.retention,
    createdAt,
    updatedAt,
    latestSeq,
  };
}

function normalizeRunAnchor(value: unknown, fallbackAgentId?: string): AgentRunAnchor | null {
  if (!isRecord(value)) return null;
  if (value.type === 'principal' && isAgentPrincipal(value.principal)) {
    return { type: 'principal', principal: value.principal };
  }
  if (typeof value.agentId === 'string' && fallbackAgentId && value.agentId !== fallbackAgentId) return null;
  const agentId = asAgentId(typeof value.agentId === 'string' ? value.agentId : fallbackAgentId);
  if (!agentId) return null;
  if (value.type === 'conversation' && typeof value.conversationId === 'string') {
    return conversationRunAnchor(agentId, value.conversationId);
  }
  return null;
}

function conversationRunAnchor(agentId: string, conversationId: string): AgentRunAnchor {
  return { type: 'conversation', agentId: asAgentId(agentId)!, conversationId };
}

function asAgentId(value: string | undefined): AgentId | null {
  return value ? value as AgentId : null;
}

function normalizeConversationMeta(value: unknown): AgentConversationMetaProjection | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.id !== 'string') return null;
  const createdAt = numberOrNull(value.createdAt);
  const updatedAt = numberOrNull(value.updatedAt);
  const latestSeq = numberOrNull(value.latestSeq);
  if (createdAt === null || updatedAt === null || latestSeq === null) return null;
  return {
    v: 1,
    id: value.id,
    members: Array.isArray(value.members) ? value.members.filter(isAgentPrincipal) : [],
    goal: typeof value.goal === 'string' ? value.goal : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    createdAt,
    title: typeof value.title === 'string' || value.title === null ? value.title : null,
    updatedAt,
    latestSeq,
  };
}

function normalizeAgentIdentity(value: unknown): AgentIdentityRecord | null {
  if (!isRecord(value) || typeof value.agentId !== 'string') return null;
  if (typeof value.displayName !== 'string' || typeof value.model !== 'string') return null;
  if (typeof value.systemPrompt !== 'string' || !Array.isArray(value.skills)) return null;
  return {
    agentId: value.agentId as AgentIdentityRecord['agentId'],
    displayName: value.displayName,
    model: value.model,
    effort: typeof value.effort === 'string' ? value.effort : undefined,
    systemPrompt: value.systemPrompt,
    skills: value.skills.filter((skill): skill is string => typeof skill === 'string'),
  };
}

function isAgentPrincipal(value: unknown): value is AgentPrincipal {
  if (!isRecord(value)) return false;
  if (value.type === 'user') return typeof value.userId === 'string';
  if (value.type === 'agent') return typeof value.agentId === 'string';
  return false;
}

function normalizePrincipal(value: unknown): AgentPrincipal | null {
  if (!isRecord(value)) return null;
  if (value.type === 'user' && typeof value.userId === 'string') return { type: 'user', userId: value.userId };
  if (value.type === 'agent' && typeof value.agentId === 'string') return { type: 'agent', agentId: value.agentId };
  return null;
}

function isAgentRunKind(value: unknown): value is AgentRunKind {
  return value === 'turn'
    || value === 'background'
    || value === 'subagent'
    || value === 'scheduled'
    || value === 'reflective';
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled';
}

function isAgentRunRetention(value: unknown): value is AgentRunRetention {
  return value === 'hot' || value === 'cold-archived' || value === 'summarized-only' || value === 'deleted';
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function agentConversationDirName(conversationId: string): string {
  return encodeAgentDirName(conversationId);
}

export function decodeAgentConversationDirName(dirName: string): string {
  return decodeAgentDirName(dirName);
}

export function agentRunDirName(runId: string): string {
  return encodeAgentDirName(runId);
}

export function decodeAgentRunDirName(dirName: string): string {
  return decodeAgentDirName(dirName);
}

export function agentIdentityDirName(agentId: string): string {
  return encodeAgentDirName(agentId);
}

/** Pool directory name under `principals/`: `agent-<agentId>` / `user-<userId>`, filesystem-encoded. */
export function agentPrincipalDirName(principal: AgentPrincipal): string {
  return principal.type === 'agent'
    ? `agent-${encodeAgentDirName(principal.agentId)}`
    : `user-${encodeAgentDirName(principal.userId)}`;
}

export function decodeAgentIdentityDirName(dirName: string): string {
  return decodeAgentDirName(dirName);
}

function encodeAgentDirName(value: string): string {
  return encodeURIComponent(value).replace(/\./g, '%2E');
}

function decodeAgentDirName(value: string): string {
  return decodeURIComponent(value);
}

export function agentPayloadFileName(payloadId: string, mimeType: string): string {
  const hash = createHash('sha256').update(payloadId).digest('hex').slice(0, 12);
  return `${safePayloadId(payloadId)}-${hash}${payloadExtension(mimeType)}`;
}

export function agentCheckpointFileName(seq: number): string {
  return `checkpoint-${Math.max(0, Math.trunc(seq))}.json`;
}

function parseCheckpointSeq(fileName: string): number | null {
  const match = /^checkpoint-(\d+)\.json$/.exec(fileName);
  if (!match) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}

function isCheckpointTempFile(fileName: string): boolean {
  return /^checkpoint-\d+\.json\..+\.tmp$/.test(fileName);
}

function safePayloadId(payloadId: string): string {
  const safe = payloadId
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
    .replace(/[._-]+$/g, '');
  return safe || 'payload';
}

function payloadExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'application/json') return '.json';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized.startsWith('text/')) return '.txt';
  return '.bin';
}

function parseEventsJsonl(raw: string, source: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as AgentEvent);
    } catch (error) {
      throw new Error(`Invalid agent event JSON at ${source}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
}

function parseMemoryEventsJsonl(raw: string, source: string): AgentMemoryEvent[] {
  const events: AgentMemoryEvent[] = [];
  const lines = raw.split(/\r?\n/);
  let lastContentIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim().length > 0) {
      lastContentIndex = index;
      break;
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    try {
      const event = normalizeMemoryEvent(JSON.parse(line));
      if (event) events.push(event);
    } catch (error) {
      // A torn FINAL line is a crash artifact of an interrupted append (e.g. quit mid-Dream):
      // drop it and keep the pool readable — the watermark makes the lost write re-derivable.
      // A malformed line in the middle is real corruption and still fails loudly.
      if (index === lastContentIndex) {
        console.warn(`Dropping torn trailing agent memory event at ${source}:${index + 1}`);
        break;
      }
      throw new Error(`Invalid agent memory event JSON at ${source}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
}

function projectMemoryEvents(events: readonly AgentMemoryEvent[]): {
  entries: Map<string, AgentMemoryEntry>;
  dream: AgentDreamState;
} {
  const entries = new Map<string, AgentMemoryEntry>();
  let lastCompletedDream: Extract<AgentMemoryEvent, { type: 'dream.completed' }> | null = null;
  for (const event of [...events].sort(compareMemoryEventsForReplay)) {
    if (event.type === 'memory.entry_added') {
      const entry = normalizeMemoryEntry(event.entry);
      if (entry) entries.set(entry.id, entry);
      continue;
    }

    if (event.type === 'dream.completed') {
      lastCompletedDream = event;
      continue;
    }

    const current = entries.get(event.entryId);
    if (!current) continue;
    if (event.type === 'memory.entry_updated') {
      const next = normalizeMemoryEntry({ ...current, ...normalizeMemoryEntryPatch(event.patch) });
      if (next) entries.set(next.id, next);
      continue;
    }

    entries.set(current.id, { ...current, status: 'invalidated' });
  }
  return {
    entries,
    dream: lastCompletedDream ? dreamStateFromCompleted(lastCompletedDream) : emptyDreamState(),
  };
}

function compactMemoryProjection(
  principal: AgentPrincipal,
  entries: ReadonlyMap<string, AgentMemoryEntry>,
  lastCompletedDream: Extract<AgentMemoryEvent, { type: 'dream.completed' }> | null,
): AgentMemoryEvent[] {
  const createdAt = Date.now();
  const events = [...entries.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((entry, index): AgentMemoryEvent => ({
      v: 1,
      type: 'memory.entry_added',
      eventId: `memory-compact-${randomUUID()}`,
      seq: index + 1,
      principal,
      createdAt,
      entry,
    }));
  if (lastCompletedDream) {
    events.push({
      ...lastCompletedDream,
      eventId: `dream-compact-${randomUUID()}`,
      seq: events.length + 1,
      createdAt,
    });
  }
  return events;
}

function normalizeMemoryEvent(value: unknown): AgentMemoryEvent | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const principal = normalizePrincipal(value.principal);
  if (typeof value.eventId !== 'string' || !principal) return null;
  const seq = numberOrNull(value.seq);
  const createdAt = numberOrNull(value.createdAt);
  if (seq === null || createdAt === null) return null;

  if (value.type === 'memory.entry_added') {
    const entry = normalizeMemoryEntry(value.entry);
    if (!entry || !samePrincipal(entry.principal, principal)) return null;
    return {
      v: 1,
      type: 'memory.entry_added',
      eventId: value.eventId,
      seq,
      principal,
      createdAt,
      entry,
    };
  }

  if (value.type === 'memory.entry_updated') {
    if (typeof value.entryId !== 'string') return null;
    return {
      v: 1,
      type: 'memory.entry_updated',
      eventId: value.eventId,
      seq,
      principal,
      createdAt,
      entryId: value.entryId,
      patch: normalizeMemoryEntryPatch(isRecord(value.patch) ? value.patch : {}),
    };
  }

  if (value.type === 'memory.entry_removed') {
    if (typeof value.entryId !== 'string') return null;
    return {
      v: 1,
      type: 'memory.entry_removed',
      eventId: value.eventId,
      seq,
      principal,
      createdAt,
      entryId: value.entryId,
      reason: typeof value.reason === 'string' ? value.reason : undefined,
    };
  }

  if (value.type === 'dream.completed') {
    if (typeof value.dreamId !== 'string' || typeof value.runId !== 'string') return null;
    const trigger = value.trigger === 'manual' || value.trigger === 'schedule' ? value.trigger : null;
    const startedAt = numberOrNull(value.startedAt);
    const completedAt = numberOrNull(value.completedAt);
    const watermark = normalizeDreamWatermark(value.watermark);
    const processed = normalizeDreamProcessed(value.processed);
    const changes = normalizeDreamChanges(isRecord(value.changes) ? value.changes : {});
    if (!trigger || startedAt === null || completedAt === null || !processed) return null;
    return {
      v: 1,
      type: 'dream.completed',
      eventId: value.eventId,
      seq,
      principal,
      createdAt,
      dreamId: value.dreamId,
      runId: value.runId,
      trigger,
      startedAt,
      completedAt,
      watermark,
      processed,
      changes,
    };
  }

  return null;
}

function normalizeMemoryEntry(value: unknown): AgentMemoryEntry | null {
  if (!isRecord(value)) return null;
  const principal = normalizePrincipal(value.principal);
  if (typeof value.id !== 'string' || !principal) return null;
  const fact = normalizeMemoryFact(value.fact);
  const createdAt = numberOrNull(value.createdAt);
  if (!fact || createdAt === null) return null;
  return {
    id: value.id,
    principal,
    fact,
    originWorkspace: normalizeOptionalString(value.originWorkspace),
    sources: Array.isArray(value.sources) ? value.sources.map(normalizeMemorySource).filter(isPresent) : [],
    status: value.status === 'invalidated' ? 'invalidated' : 'active',
    createdAt,
  };
}

function emptyDreamState(): AgentDreamState {
  return {
    lastCompleted: null,
    watermark: { conversations: {}, agentRuns: {} },
    lastSuccessAt: null,
  };
}

function dreamStateFromCompleted(event: Extract<AgentMemoryEvent, { type: 'dream.completed' }>): AgentDreamState {
  return {
    lastCompleted: event,
    watermark: normalizeDreamWatermark(event.watermark),
    lastSuccessAt: event.completedAt,
  };
}

function cloneDreamState(state: AgentDreamState): AgentDreamState {
  return {
    lastCompleted: state.lastCompleted ? JSON.parse(JSON.stringify(state.lastCompleted)) as AgentDreamState['lastCompleted'] : null,
    watermark: normalizeDreamWatermark(state.watermark),
    lastSuccessAt: state.lastSuccessAt,
  };
}

function normalizeDreamWatermark(value: unknown): AgentDreamWatermark {
  if (!isRecord(value) || !isRecord(value.conversations)) return { conversations: {}, agentRuns: {} };
  const conversations: AgentDreamWatermark['conversations'] = {};
  for (const [conversationId, rawCursor] of Object.entries(value.conversations)) {
    const cursor = normalizeDreamWatermarkCursor(rawCursor);
    if (cursor) conversations[conversationId] = cursor;
  }
  const agentRuns: NonNullable<AgentDreamWatermark['agentRuns']> = {};
  if (isRecord(value.agentRuns)) {
    for (const [runId, rawCursor] of Object.entries(value.agentRuns)) {
      const cursor = normalizeDreamAgentRunWatermarkCursor(rawCursor);
      if (cursor) agentRuns[runId] = cursor;
    }
  }
  return { conversations, agentRuns };
}

function normalizeDreamWatermarkCursor(value: unknown): AgentDreamWatermark['conversations'][string] | null {
  if (!isRecord(value)) return null;
  const seq = numberOrNull(value.seq);
  if (seq === null || seq < 0) return null;
  const eventId = typeof value.eventId === 'string' || value.eventId === null ? value.eventId : null;
  return { seq: Math.trunc(seq), eventId };
}

function normalizeDreamAgentRunWatermarkCursor(value: unknown): NonNullable<AgentDreamWatermark['agentRuns']>[string] | null {
  if (!isRecord(value)) return null;
  const messageCount = numberOrNull(value.messageCount);
  if (messageCount === null || messageCount < 0) return null;
  const payloadId = typeof value.payloadId === 'string' || value.payloadId === null ? value.payloadId : null;
  return { messageCount: Math.trunc(messageCount), payloadId };
}

function normalizeDreamProcessed(value: unknown): Extract<AgentMemoryEvent, { type: 'dream.completed' }>['processed'] | null {
  if (!isRecord(value) || !isRecord(value.conversations)) return null;
  return {
    conversations: normalizeDreamProcessedConversations(value.conversations),
    agentRuns: normalizeDreamProcessedAgentRuns(value.agentRuns),
    totalMessageCount: nonNegativeInteger(value.totalMessageCount),
    totalCharCount: nonNegativeInteger(value.totalCharCount),
    consolidateOnly: value.consolidateOnly === true,
  };
}

function normalizeDreamProcessedConversations(value: unknown): Record<string, AgentDreamProcessedConversation> {
  if (!isRecord(value)) return {};
  const conversations: Record<string, AgentDreamProcessedConversation> = {};
  for (const [conversationId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const fromSeqExclusive = numberOrNull(raw.fromSeqExclusive);
    const throughSeq = numberOrNull(raw.throughSeq);
    if (fromSeqExclusive === null || throughSeq === null || fromSeqExclusive < 0 || throughSeq < fromSeqExclusive) continue;
    conversations[conversationId] = {
      fromSeqExclusive: Math.trunc(fromSeqExclusive),
      throughSeq: Math.trunc(throughSeq),
      throughEventId: typeof raw.throughEventId === 'string' || raw.throughEventId === null ? raw.throughEventId : null,
      messageCount: nonNegativeInteger(raw.messageCount),
      charCount: nonNegativeInteger(raw.charCount),
    };
  }
  return conversations;
}

function normalizeDreamProcessedAgentRuns(value: unknown): Record<string, AgentDreamProcessedAgentRun> {
  if (!isRecord(value)) return {};
  const runs: Record<string, AgentDreamProcessedAgentRun> = {};
  for (const [runId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.parentConversationId !== 'string' || raw.parentConversationId.length === 0) continue;
    const fromMessageCountExclusive = numberOrNull(raw.fromMessageCountExclusive);
    const throughMessageCount = numberOrNull(raw.throughMessageCount);
    if (
      fromMessageCountExclusive === null
      || throughMessageCount === null
      || fromMessageCountExclusive < 0
      || throughMessageCount < fromMessageCountExclusive
    ) continue;
    runs[runId] = {
      parentConversationId: raw.parentConversationId,
      parentToolCallId: normalizeOptionalString(raw.parentToolCallId),
      fromMessageCountExclusive: Math.trunc(fromMessageCountExclusive),
      throughMessageCount: Math.trunc(throughMessageCount),
      transcriptPayloadId: typeof raw.transcriptPayloadId === 'string' || raw.transcriptPayloadId === null ? raw.transcriptPayloadId : null,
      messageCount: nonNegativeInteger(raw.messageCount),
      charCount: nonNegativeInteger(raw.charCount),
    };
  }
  return runs;
}

function normalizeDreamChanges(value: unknown): AgentDreamCompletedChanges {
  const record = isRecord(value) ? value : {};
  return {
    added: nonNegativeInteger(record.added),
    updated: nonNegativeInteger(record.updated),
    forgotten: nonNegativeInteger(record.forgotten),
    skipped: nonNegativeInteger(record.skipped),
  };
}

function normalizeMemoryEntryPatch(value: unknown): AgentMemoryEntryPatch {
  if (!isRecord(value)) return {};
  const patch: AgentMemoryEntryPatch = {};
  if ('fact' in value) {
    const fact = normalizeMemoryFact(value.fact);
    if (fact) patch.fact = fact;
  }
  if ('originWorkspace' in value) {
    patch.originWorkspace = normalizeOptionalString(value.originWorkspace);
  }
  if ('sources' in value) {
    patch.sources = Array.isArray(value.sources) ? value.sources.map(normalizeMemorySource).filter(isPresent) : [];
  }
  if (value.status === 'active' || value.status === 'invalidated') {
    patch.status = value.status;
  }
  return patch;
}

function normalizeMemorySource(value: unknown): AgentMemorySource | null {
  if (!isRecord(value) || typeof value.conversationId !== 'string' || value.conversationId.length === 0) return null;
  const source: AgentMemorySource = { conversationId: value.conversationId };
  if (value.kind === 'conversation' || value.kind === 'agent_run') source.kind = value.kind;
  if (typeof value.summaryId === 'string' && value.summaryId.length > 0) source.summaryId = value.summaryId;
  if (Array.isArray(value.messageRange) && value.messageRange.length === 2) {
    const [from, to] = value.messageRange;
    if (typeof from === 'string' && typeof to === 'string') source.messageRange = [from, to];
  }
  if (typeof value.runId === 'string' && value.runId.length > 0) source.runId = value.runId;
  if (typeof value.subagentRunId === 'string' && value.subagentRunId.length > 0) source.subagentRunId = value.subagentRunId;
  if (typeof value.agentId === 'string' && value.agentId.length > 0) source.agentId = value.agentId;
  if (typeof value.parentToolCallId === 'string' && value.parentToolCallId.length > 0) source.parentToolCallId = value.parentToolCallId;
  if (typeof value.eventId === 'string' && value.eventId.length > 0) source.eventId = value.eventId;
  return source;
}

function normalizeMemoryFact(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const fact = normalizeDisplayText(value);
  if (!fact) return null;
  if (fact.length <= MAX_AGENT_MEMORY_FACT_CHARS) return fact;
  return `${fact.slice(0, MAX_AGENT_MEMORY_FACT_CHARS - 3).trimEnd()}...`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function rankMemoryEntries(entries: readonly AgentMemoryEntry[], query: string | undefined): AgentMemoryEntry[] {
  const fallbackSort = (left: AgentMemoryEntry, right: AgentMemoryEntry) => (
    right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  );
  if (!query || normalizeSearchText(query).length === 0) return [...entries].sort(fallbackSort);
  const analysis = analyzeTextSearchQuery(query);
  const terms = normalizeSearchTerms(query);
  if (analysis.normalized.length === 0 || terms.length === 0) return [...entries].sort(fallbackSort);
  return entries
    .map((entry) => ({ entry, score: memoryEntrySearchScore(entry, analysis.normalized, terms) }))
    .filter((ranked) => ranked.score > 0)
    .sort((left, right) => right.score - left.score || fallbackSort(left.entry, right.entry))
    .map((ranked) => ranked.entry);
}

function memoryEntrySearchScore(entry: AgentMemoryEntry, normalizedQuery: string, terms: readonly string[]): number {
  const fact = normalizeSearchText(entry.fact);
  const id = normalizeSearchText(entry.id);
  let score = 0;
  if (fact.includes(normalizedQuery)) score += 100;
  for (const term of terms) {
    if (fact.includes(term)) score += 10;
    if (id.includes(term)) score += 4;
  }
  return score;
}

function clampMemoryLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function compareMemoryEventsForReplay(left: AgentMemoryEvent, right: AgentMemoryEvent): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function cloneReplayState(state: AgentEventReplayState): AgentEventReplayState {
  return JSON.parse(JSON.stringify(state)) as AgentEventReplayState;
}

async function atomicWriteFile(filePath: string, data: string | Buffer) {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizeCheckpoint(value: unknown, conversationId: string): AgentEventCheckpoint | null {
  if (!isRecord(value)) return null;
  if (value.v !== CHECKPOINT_VERSION) return null;
  if (value.conversationId !== conversationId) return null;
  const seq = typeof value.seq === 'number' && Number.isSafeInteger(value.seq) ? value.seq : null;
  if (seq === null || seq <= 0) return null;
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    ? value.createdAt
    : null;
  if (createdAt === null) return null;
  const latestEventId = typeof value.latestEventId === 'string' || value.latestEventId === null
    ? value.latestEventId
    : undefined;
  if (latestEventId === undefined) return null;
  if (!isRecord(value.state)) return null;

  const state = value.state as Partial<AgentEventReplayState>;
  if (state.latestSeq !== seq) return null;
  if (state.latestEventId !== latestEventId) return null;
  if (!isRecord(state.conversation) || state.conversation.id !== conversationId) return null;
  if (!isRecord(state.messages) || !isRecord(state.payloads) || !isRecord(state.runs)) return null;
  if (!isRecord(state.subagents) || !isRecord(state.compactionsByMessageId)) return null;
  if (!isRecord(state.dreamsByMessageId) || !isRecord(state.userQuestions)) return null;
  if (!Array.isArray(state.rootMessageIds)) return null;
  if (!isRecord(state.childrenByParentId) || !isRecord(state.derivedPayloadsBySourceId)) return null;
  const targets = normalizeCheckpointTargets(value.targets);
  if (!targets) return null;

  return {
    v: CHECKPOINT_VERSION,
    conversationId,
    seq,
    latestEventId,
    createdAt,
    targets,
    state: value.state as unknown as AgentEventReplayState,
  };
}

function normalizeCheckpointTargets(value: unknown): AgentEventCheckpointTargets | null {
  if (!isRecord(value)) return null;
  const conversationByteOffset = numberOrNull(value.conversationByteOffset);
  if (conversationByteOffset === null || conversationByteOffset < 0) return null;
  if (!isRecord(value.runByteOffsets)) return null;
  const runByteOffsets: Record<string, number> = {};
  for (const [runId, byteOffset] of Object.entries(value.runByteOffsets)) {
    if (typeof byteOffset !== 'number' || !Number.isFinite(byteOffset) || byteOffset < 0) return null;
    runByteOffsets[runId] = byteOffset;
  }
  return { conversationByteOffset, runByteOffsets };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON.parse to a plain object, or null on any parse failure / non-object value. */
function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
