import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
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
  AgentDreamProcessedRun,
  AgentDreamProcessedConversation,
  AgentDreamTrigger,
  AgentDreamWatermark,
  AgentMemoryEntry,
  AgentMemoryEpisode,
  AgentMemoryStreamSource,
  AgentMemoryEvent,
  AgentMemorySource,
  AgentMemoryAccessVia,
  AgentRunTrigger,
} from '../core/agentEventLog';
import { agentIdOfRunAnchor, appendAgentEventToReplayState, conversationIdOfRun, getAgentEventActivePath, mergeUniquePrincipals, principalKey, replayAgentEvents, samePrincipal } from '../core/agentEventLog';
import {
  buildMemoryOverview,
  cloneMemoryAccessStats,
  computeMemoryStrength,
  emptyMemoryAccessStats,
  type AgentMemoryAccessStats,
  type AgentMemoryOverview,
  type AgentMemoryRankedEntry,
  type AgentMemoryStrength,
} from '../core/agentMemoryActivation';
import {
  rankMemoryEntriesForBriefing,
  rankMemoryEntriesForRecall,
} from '../core/agentMemoryRetrieval';
import {
  analyzeTextSearchQuery,
  normalizeSearchText,
  textSearchTextMatchesQuery,
} from '../core/textSearchAnalyzer';
import { nodeReferenceMarkersToText } from '../core/referenceMarkup';
import type { ErrorReport, ErrorReportContext } from '../core/errorObservability';
import { AppendOnlySeqLog, serializeJsonl, type AppendOnlySeqLogTail } from './appendOnlySeqLog';
import { atomicWriteFile } from './jsonFileStore';

const CONVERSATION_SEGMENT_FILE = '000001.jsonl';
const CONVERSATION_RUN_INDEX_FILE = 'runs.json';
const AGENT_RUN_INDEX_FILE = 'runs.json';
const RUN_EVENT_LOG_FILE = 'events.jsonl';
const RUN_META_FILE = 'meta.json';
const AGENT_IDENTITY_FILE = 'identity.json';
const CONVERSATION_INDEX_FILE = 'conversation-index.json';
const SEARCH_INDEX_FILE = 'search-index.json';
// The storage-generation sentinel ([[agent-run-unification]] Design 6): ONE
// root file `layout.json {v}` written once per on-disk format generation.
// Startup reads this single line — current generation proceeds with no
// per-conversation probing; a stale or missing sentinel is positive proof of
// another generation and wipes the agent data root (pre-release clean-cut, no
// migration); an unreadable/corrupt sentinel is AMBIGUITY and fails open to
// the current layout (log + re-probe next launch — never wipe on error).
// Future format breaks bump the integer instead of authoring a new detector.
export const LAYOUT_SENTINEL_FILE = 'layout.json';
// v3 = memory realignment PR-2: memory sources are a discriminated union
// (`{stream, streamId, range}` or `{episodeId}`) and memory-owned episode gist
// nodes live in the principal memory log. No legacy source reader; pre-release
// clean-cut wipes old agent data.
// v2 = run unification: a delegated run is its own ledger (`runs/<runId>/
// events.jsonl`, own seq space) excluded from conversation replay; the
// conversation stream keeps only the slim child_run.started/updated markers.
// The pre-unification entity-grade events and transcript-snapshot payloads
// are gone.
export const STORAGE_LAYOUT_VERSION = 3;
const CHECKPOINT_VERSION = 5;
const SEARCH_INDEX_VERSION = 2;
const DEFAULT_CHECKPOINT_EVENT_INTERVAL = 100;
const MAX_CHECKPOINTS_PER_CONVERSATION = 3;
const MAX_SEARCH_INDEX_TEXT_CHARS = 20_000;
const SEARCH_INDEX_PREVIEW_CHARS = 240;
export const MAX_AGENT_MEMORY_FACT_CHARS = 2_000;
const MEMORY_COMPACTION_MIN_EVENTS = 64;
const MEMORY_COMPACTION_CHURN_FACTOR = 2;
const MEMORY_ACTIVATION_CACHE_BUCKET_MS = 24 * 60 * 60 * 1000;
const MEMORY_BRIEFING_ACCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

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

export interface AgentMemoryEpisodeInput {
  id?: string;
  gist: string;
  originWorkspace?: string;
  sources: AgentMemoryStreamSource[];
  createdAt?: number;
}

export interface AgentMemoryEntryPatch {
  fact?: string;
  originWorkspace?: string;
  sources?: AgentMemorySource[];
  status?: AgentMemoryEntry['status'];
}

export interface AgentMemoryAccessInput {
  via: AgentMemoryAccessVia;
  entryIds: readonly string[];
  createdAt?: number;
}

export interface AgentMemoryActivationResult {
  entries: AgentMemoryRankedEntry[];
  overview: AgentMemoryOverview;
  totalEntries: number;
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
    runs?: Record<string, AgentDreamProcessedRun>;
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
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  latestSeq: number;
  lastMessageSnippet: string | null;
  lastMessageAt: number | null;
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

type AgentEventFileTail = AppendOnlySeqLogTail;
type ErrorReporter = (report: ErrorReport) => void | Promise<void>;

interface AgentEventStoreOptions {
  errorReporter?: ErrorReporter;
}

interface AgentEventCheckpointTargets {
  conversationByteOffset: number;
  runByteOffsets: Record<string, number>;
}

interface AgentConversationRunIndex {
  v: 2;
  runIds: string[];
  latestSeqByRunId: Record<string, number>;
  /**
   * Runs whose ledgers are their OWN streams (kind 'delegation'): excluded from
   * the conversation replay join, checkpoint targets, and the conversation's
   * latest-seq derivation — a delegated run has its own seq space and its own
   * message tree, replayed independently (run unification).
   */
  delegationRunIds: string[];
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
  episodes: Map<string, AgentMemoryEpisode>;
  memoryIdsByEpisodeId: Map<string, Set<string>>;
  accessStatsByEntryId: Map<string, AgentMemoryAccessStats>;
  activationCache?: {
    latestSeq: number;
    dayBucket: number;
    ranked: AgentMemoryRankedEntry[];
    overview: AgentMemoryOverview;
  };
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
  // Delegated-run ledgers get the memory log's torn-tail policy, NOT the
  // conversation log's strict one: they are high-write append-only sidecars, so
  // a half-written FINAL line is a routine crash artifact of an interrupted
  // child-message append (the run is marked interrupted on restore anyway). A
  // tolerant parse keeps the transcript readable — and keeps one corrupt child
  // ledger from bricking its whole parent conversation — and lets the
  // before-append repair truncate the fragment so a resume can append again.
  // Mid-file corruption still fails loudly on both logs.
  private readonly runEventLog = new AppendOnlySeqLog<AgentEvent>('agent run event', parseRunEventsJsonl);
  private readonly memoryEventLog = new AppendOnlySeqLog<AgentMemoryEvent>('agent memory event', parseMemoryEventsJsonl);
  private indexQueue = Promise.resolve();
  private readonly memoryProjectionByPrincipal = new Map<string, AgentMemoryProjectionCache>();
  private storageLayoutPromise: Promise<void> | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly options: AgentEventStoreOptions = {},
  ) {}

  private reportStorageWarning(message: string, error?: unknown, context?: ErrorReportContext, code?: string): void {
    if (!this.options.errorReporter) {
      console.warn(message);
      return;
    }
    try {
      this.options.errorReporter({
        domain: 'persistence',
        severity: 'warn',
        ...(code ? { code } : {}),
        message,
        ...(context ? { context } : {}),
        ...(error !== undefined ? { error } : {}),
      });
    } catch (reportError) {
      console.warn(message);
      console.error('[diagnostics] storage error reporter failed', reportError);
    }
  }

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

  /**
   * Append to a delegated run's OWN ledger (run unification): the run is its
   * own stream with its own seq space, so events bypass the conversation
   * write-time split and never touch the conversation indexes. Run meta + the
   * conversation run index (which marks the run `delegation` so the join
   * paths exclude it) are still maintained.
   */
  async appendRunStreamEvents(conversationId: string, runId: string, events: readonly AgentEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureStorageLayout();
    this.assertEventBatch(conversationId, events);
    for (const event of events) {
      if (event.runId !== runId) {
        throw new Error(`Run-stream event runId mismatch: ${event.runId ?? '(none)'} != ${runId}`);
      }
    }
    const runPaths = this.runPaths(runId);
    await this.runEventLog.enqueue(runStreamLogKey(runId), async () => {
      const latestSeq = await this.runEventLog.latestSeq(runStreamLogKey(runId), () => [runPaths.runEventsPath]);
      const firstSeq = events[0]!.seq;
      if (firstSeq <= latestSeq) {
        throw new Error(`Run-stream event seq ${firstSeq} is not after existing seq ${latestSeq}`);
      }
      await this.runEventLog.append(runPaths.runEventsPath, events);
      this.runEventLog.setLatestSeq(runStreamLogKey(runId), events.at(-1)!.seq);
      const metaEvents = events.filter((event) => !isStreamingDeltaEvent(event));
      if (metaEvents.length > 0) {
        const meta = await this.updateRunMeta(conversationId, runId, metaEvents);
        if (meta) await this.updateRunIndexes(meta);
      }
    });
  }

  /** Read a delegated run's own ledger (its independent event stream). */
  async readRunStreamEvents(runId: string): Promise<AgentEvent[]> {
    await this.ensureStorageLayout();
    return this.runEventLog.readIfExists(this.runPaths(runId).runEventsPath);
  }

  /**
   * Read ONLY the conversation segment (not the joined run streams). The
   * run-grounded debug view ([[agent-debug-run-grounded]]) reads it once to recover
   * the conversation-stream events a run's own ledger lacks — the triggering user
   * message, `child_run.started` parent links, and conversation-budget
   * `tool_result.replaced` slimming — far cheaper than the full merged `readEvents`.
   */
  async readConversationStreamEvents(conversationId: string): Promise<AgentEvent[]> {
    await this.ensureStorageLayout();
    return this.agentEventLog.readIfExists(this.paths(conversationId).conversationEventsPath);
  }

  /** Replay a delegated run's ledger into its own independent state. */
  async replayRunStream(runId: string): Promise<AgentEventReplayState> {
    return replayAgentEvents(await this.readRunStreamEvents(runId));
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
    const runIds = await this.listRunIdsForConversation(conversationId);
    await rm(this.paths(conversationId).conversationDir, { recursive: true, force: true });
    await Promise.all(runIds.map((runId) => (
      rm(this.runPaths(runId).runDir, { recursive: true, force: true })
    )));
    this.agentEventLog.deleteKey(conversationId);
    for (const runId of runIds) {
      this.agentEventLog.deleteKey(runStreamLogKey(runId));
      this.runEventLog.deleteKey(runStreamLogKey(runId));
    }
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

  /**
   * EVERY run anchored to a conversation (turn + delegation), in creation order.
   * The run-grounded debug view ([[agent-debug-run-grounded]]) enumerates these,
   * then derives each run's rounds from its own stream.
   */
  async listConversationRunMetaProjections(
    conversationId: string,
    options: { limit?: number } = {},
  ): Promise<AgentRunMetaProjection[]> {
    await this.ensureStorageLayout();
    const index = await this.ensureConversationRunIndex(conversationId);
    const limit = typeof options.limit === 'number' ? Math.max(0, Math.trunc(options.limit)) : null;
    const runIds = limit === null
      ? index.runIds
      : limit === 0
        ? []
        : index.runIds.slice(-limit);
    const metas: AgentRunMetaProjection[] = [];
    for (const runId of runIds) {
      const meta = await this.readRunMeta(runId);
      if (meta) metas.push(meta);
    }
    return metas.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  /**
   * Bounded conversation-run retention for channels that intentionally keep run
   * transcripts as audit history (currently the Dream channel). Pruning removes
   * old run ledgers and their message-trigger anchors, then rebuilds the derived
   * conversation/search indexes from the retained log.
   */
  async retainRecentConversationRuns(
    conversationId: string,
    retainRunCount: number,
  ): Promise<{ prunedRunIds: string[]; retainedRunIds: string[] }> {
    await this.ensureStorageLayout();
    const retainCount = Number.isFinite(retainRunCount) ? Math.max(0, Math.trunc(retainRunCount)) : 0;
    return this.agentEventLog.enqueue(conversationId, async () => {
      const paths = this.paths(conversationId);
      const existing = await this.ensureConversationRunIndex(conversationId);
      if (existing.runIds.length <= retainCount) {
        return { prunedRunIds: [], retainedRunIds: existing.runIds.slice() };
      }

      const retainedRunIds = retainCount === 0 ? [] : existing.runIds.slice(-retainCount);
      const retainedRunIdSet = new Set(retainedRunIds);
      const prunedRunIds = existing.runIds.filter((runId) => !retainedRunIdSet.has(runId));
      const prunedRunIdSet = new Set(prunedRunIds);
      const conversationEvents = await this.agentEventLog.readIfExists(paths.conversationEventsPath);
      const retainedRunEvents = await this.readRunEventsByRunId(existing, retainedRunIds);
      const prunedRunEvents = await this.readRunEventsByRunId(existing, prunedRunIds);
      const prunedMessageIds = new Set<string>();
      for (const meta of await Promise.all(prunedRunIds.map((runId) => this.readRunMeta(runId)))) {
        if (meta?.trigger.type === 'message') prunedMessageIds.add(meta.trigger.messageId);
      }
      for (const events of prunedRunEvents.values()) collectMessageIdsFromEvents(events, prunedMessageIds);
      for (const event of conversationEvents) {
        if (event.type === 'dream.finished' && event.runId && prunedRunIdSet.has(event.runId)) {
          prunedMessageIds.add(event.messageId);
        }
      }
      const retainedConversationEvents = conversationEvents.flatMap((event) => {
        const retained = retainConversationStreamEventAfterRunPrune(event, prunedRunIdSet, prunedMessageIds);
        return retained ? [retained] : [];
      });
      const nextIndex: AgentConversationRunIndex = {
        v: 2,
        runIds: retainedRunIds,
        latestSeqByRunId: Object.fromEntries(retainedRunIds.map((runId) => [
          runId,
          existing.latestSeqByRunId[runId] ?? 0,
        ])),
        delegationRunIds: existing.delegationRunIds.filter((runId) => retainedRunIdSet.has(runId)),
      };
      const retainedEvents = [
        ...retainedConversationEvents,
        ...retainedRunIds.flatMap((runId) => retainedRunEvents.get(runId) ?? []),
      ].sort(compareAgentEventsForReplay);
      const replayState = replayAgentEvents(retainedEvents);

      await mkdir(paths.conversationSegmentsDir, { recursive: true });
      await atomicWriteFile(paths.conversationEventsPath, serializeJsonl(retainedConversationEvents));
      await this.enqueueIndexWrite(async () => {
        await mkdir(paths.conversationDir, { recursive: true });
        await atomicWriteFile(paths.conversationRunIndexPath, `${JSON.stringify(nextIndex)}\n`);
      });
      await rm(paths.checkpointsDir, { recursive: true, force: true });
      await this.writeConversationMetaFromReplayState(conversationId, replayState);
      await this.replaceConversationInIndexes(conversationId, replayState, retainedEvents);
      this.agentEventLog.setLatestSeq(conversationId, replayState.latestSeq);
      await Promise.all(prunedRunIds.map(async (runId) => {
        await rm(this.runPaths(runId).runDir, { recursive: true, force: true });
        this.agentEventLog.deleteKey(runStreamLogKey(runId));
        this.runEventLog.deleteKey(runStreamLogKey(runId));
      }));
      return { prunedRunIds, retainedRunIds };
    });
  }

  /**
   * The conversation's member roster + meta (a cheap meta-file read, no replay).
   * The run-grounded debug view ([[agent-debug-run-grounded]]) reads it to decide
   * shape (DM vs Channel) from the authoritative roster, not from run executors.
   */
  async readConversationMetaProjection(conversationId: string): Promise<AgentConversationMetaProjection | null> {
    await this.ensureStorageLayout();
    return this.readConversationMeta(conversationId);
  }

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

  async recordMemoryEpisode(principal: AgentPrincipal, input: AgentMemoryEpisodeInput): Promise<AgentMemoryEpisode> {
    await this.ensureStorageLayout();
    const key = principalKey(principal);
    return this.memoryEventLog.enqueue(key, async () => {
      const createdAt = input.createdAt ?? Date.now();
      const episode = normalizeMemoryEpisode({
        id: input.id ?? `episode-${randomUUID()}`,
        principal,
        gist: input.gist,
        originWorkspace: input.originWorkspace,
        sources: input.sources,
        createdAt,
      });
      if (!episode) throw new Error('Invalid agent memory episode.');
      const event = await this.nextMemoryEvent(principal, {
        type: 'memory.episode_recorded',
        createdAt,
        episode,
      });
      const projection = await this.getMemoryProjection(principal);
      await this.appendMemoryEvents(principal, [event]);
      projection.episodes.set(episode.id, episode);
      projection.latestSeq = event.seq;
      projection.eventCount += 1;
      await this.maybeCompactMemoryLog(principal, projection);
      return episode;
    });
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
      setMemoryProjectionEntry(projection, entry, projection.entries.get(entry.id));
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
      setMemoryProjectionEntry(projection, next, current);
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
      setMemoryProjectionEntry(projection, next, current);
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
          runs: normalizeDreamProcessedRuns(input.processed.runs),
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

  async getMemoryEpisode(principal: AgentPrincipal, episodeId: string): Promise<AgentMemoryEpisode | null> {
    await this.ensureStorageLayout();
    const projection = await this.getMemoryProjection(principal);
    return projection.episodes.get(episodeId) ?? null;
  }

  async listMemoryEntriesForEpisode(principal: AgentPrincipal, episodeId: string): Promise<AgentMemoryEntry[]> {
    await this.ensureStorageLayout();
    const projection = await this.getMemoryProjection(principal);
    const ids = projection.memoryIdsByEpisodeId.get(episodeId) ?? new Set<string>();
    return [...ids]
      .map((id) => projection.entries.get(id))
      .filter((entry): entry is AgentMemoryEntry => !!entry)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
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
    const poolEntries = [...projection.entries.values()]
      .filter((entry) => options.includeInvalidated || entry.status === 'active');
    const entries = rankMemoryEntriesForRecall(poolEntries, {
      query: options.query,
      accessStatsByEntryId: projection.accessStatsByEntryId,
    }).map((item) => item.entry);
    return {
      entries: entries.slice(0, clampMemoryLimit(options.limit)),
      totalEntries: entries.length,
    };
  }

  async activateMemoryEntries(
    principal: AgentPrincipal,
    options: { limit?: number; now?: number } = {},
  ): Promise<AgentMemoryActivationResult> {
    await this.ensureStorageLayout();
    const now = options.now ?? Date.now();
    const projection = await this.getMemoryProjection(principal);
    const dayBucket = memoryActivationDayBucket(now);
    const cached = projection.activationCache;
    if (cached && cached.latestSeq === projection.latestSeq && cached.dayBucket === dayBucket) {
      return {
        entries: cached.ranked.slice(0, clampMemoryLimit(options.limit)),
        overview: { ...cached.overview, generatedAt: now },
        totalEntries: cached.ranked.length,
      };
    }
    const ranked = rankMemoryEntriesForBriefing(
      [...projection.entries.values()].filter((entry) => entry.status === 'active'),
      projection.accessStatsByEntryId,
      now,
    );
    const overview = buildMemoryOverview(ranked, { generatedAt: now });
    projection.activationCache = {
      latestSeq: projection.latestSeq,
      dayBucket,
      ranked,
      overview,
    };
    return {
      entries: ranked.slice(0, clampMemoryLimit(options.limit)),
      overview,
      totalEntries: ranked.length,
    };
  }

  async memoryStrength(principal: AgentPrincipal, entryId: string, now = Date.now()): Promise<AgentMemoryStrength | null> {
    await this.ensureStorageLayout();
    const projection = await this.getMemoryProjection(principal);
    const entry = projection.entries.get(entryId);
    if (!entry) return null;
    return computeMemoryStrength(entry, projection.accessStatsByEntryId.get(entryId), now);
  }

  async recordMemoryAccess(
    principal: AgentPrincipal,
    input: AgentMemoryAccessInput,
  ): Promise<Extract<AgentMemoryEvent, { type: 'memory.accessed' }> | null> {
    await this.ensureStorageLayout();
    const key = principalKey(principal);
    return this.memoryEventLog.enqueue(key, async () => {
      const projection = await this.getMemoryProjection(principal);
      const seen = new Set<string>();
      const createdAt = input.createdAt ?? Date.now();
      const accesses = input.entryIds
        .filter((entryId) => {
          if (seen.has(entryId)) return false;
          seen.add(entryId);
          const entry = projection.entries.get(entryId);
          if (!entry || entry.status !== 'active') return false;
          if (input.via === 'briefing' && wasBriefedRecently(projection.accessStatsByEntryId.get(entryId), createdAt)) {
            return false;
          }
          return true;
        })
        .map((entryId) => ({ entryId, count: 1 }));
      if (accesses.length === 0) return null;
      const event = await this.nextMemoryEvent(principal, {
        type: 'memory.accessed',
        createdAt,
        via: input.via,
        accesses,
      }) as Extract<AgentMemoryEvent, { type: 'memory.accessed' }>;
      await this.appendMemoryEvents(principal, [event]);
      applyMemoryAccessEvent(projection.accessStatsByEntryId, event);
      projection.latestSeq = event.seq;
      projection.eventCount += 1;
      await this.maybeCompactMemoryLog(principal, projection);
      return event;
    });
  }

  async readMemoryEvents(principal: AgentPrincipal): Promise<AgentMemoryEvent[]> {
    await this.ensureStorageLayout();
    return this.memoryEventLog.readIfExists(this.memoryPaths(principal).memoryEventsPath);
  }

  private ensureStorageLayout(): Promise<void> {
    // Fail-open (gate #180 finding #2, carried onto the sentinel): a probe/wipe
    // failure must NOT memoize a rejected promise — that would brick every store
    // access until restart. Log, continue on the current layout, and let the
    // next launch re-probe.
    this.storageLayoutPromise ??= this.ensureStorageGeneration().catch((error) => {
      this.reportStorageWarning(
        'Agent storage generation probe failed; continuing on the current layout.',
        error,
        { operation: 'ensureStorageGeneration' },
        'agent-storage-generation-probe-failed',
      );
    });
    return this.storageLayoutPromise;
  }

  /**
   * The `layout.json {v}` storage-generation sentinel. Pre-release clean-cut
   * (no migration, no legacy reader): a missing sentinel (pre-sentinel data or
   * a fresh install — wiping an empty root is harmless) or a parsed sentinel
   * from ANOTHER generation is positive proof, and the whole agent data root
   * is deleted and recreated lazily. An unreadable/corrupt sentinel is
   * ambiguity, not proof — fail open to operation (#180 invariants: content
   * can never trip a wipe; probe errors never brick the store).
   */
  private async ensureStorageGeneration(): Promise<void> {
    const sentinelPath = path.join(this.rootDir, LAYOUT_SENTINEL_FILE);
    let raw: string | null = null;
    try {
      raw = await readFile(sentinelPath, 'utf8');
    } catch (error) {
      if (!isNotFoundError(error)) {
        // Unreadable (permissions, I/O): ambiguity — never wipe on error.
        this.reportStorageWarning(
          'Agent storage sentinel unreadable; continuing on the current layout.',
          error,
          { operation: 'readLayoutSentinel' },
          'agent-storage-sentinel-unreadable',
        );
        return;
      }
    }
    if (raw !== null) {
      const sentinel = parseJsonRecord(raw.trim());
      if (!sentinel || !Number.isInteger(sentinel.v)) {
        // Corrupt sentinel: ambiguity — fail open, re-probe next launch.
        this.reportStorageWarning(
          'Agent storage sentinel is corrupt; continuing on the current layout.',
          undefined,
          { operation: 'parseLayoutSentinel' },
          'agent-storage-sentinel-corrupt',
        );
        return;
      }
      if (sentinel.v === STORAGE_LAYOUT_VERSION) return;
    }
    // Positive proof of another generation (stale `v` or no sentinel at all).
    this.reportStorageWarning(
      `Agent storage layout generation changed (found ${raw === null ? 'no sentinel' : `v=${parseJsonRecord(raw.trim())?.v}`}, `
      + `current v=${STORAGE_LAYOUT_VERSION}); wiping agent data root`,
      undefined,
      {
        operation: 'cleanCutStorageLayout',
        currentVersion: STORAGE_LAYOUT_VERSION,
        ...(raw === null ? {} : { foundVersion: Number(parseJsonRecord(raw.trim())?.v ?? 0) }),
      },
      'agent-storage-layout-generation-changed',
    );
    await rm(this.rootDir, { recursive: true, force: true });
    this.agentEventLog.clear();
    this.runEventLog.clear();
    this.memoryEventLog.clear();
    this.memoryProjectionByPrincipal.clear();
    await mkdir(this.rootDir, { recursive: true });
    await atomicWriteFile(sentinelPath, `${JSON.stringify({ v: STORAGE_LAYOUT_VERSION })}\n`);
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
    input: Omit<Extract<AgentMemoryEvent, { type: 'memory.episode_recorded' }>, 'v' | 'eventId' | 'seq' | 'principal'>
      | Omit<Extract<AgentMemoryEvent, { type: 'memory.entry_added' }>, 'v' | 'eventId' | 'seq' | 'principal'>
      | Omit<Extract<AgentMemoryEvent, { type: 'memory.entry_updated' }>, 'v' | 'eventId' | 'seq' | 'principal'>
      | Omit<Extract<AgentMemoryEvent, { type: 'memory.entry_removed' }>, 'v' | 'eventId' | 'seq' | 'principal'>
      | Omit<Extract<AgentMemoryEvent, { type: 'memory.accessed' }>, 'v' | 'eventId' | 'seq' | 'principal'>
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
      episodes: projected.episodes,
      memoryIdsByEpisodeId: projected.memoryIdsByEpisodeId,
      accessStatsByEntryId: projected.accessStatsByEntryId,
      dream: projected.dream,
    };
    this.memoryProjectionByPrincipal.set(key, projection);
    return projection;
  }

  private async maybeCompactMemoryLog(principal: AgentPrincipal, projection: AgentMemoryProjectionCache): Promise<void> {
    if (projection.eventCount < MEMORY_COMPACTION_MIN_EVENTS) return;
    const projectedEntryCount = Math.max(1, projection.entries.size);
    if (projection.eventCount < projectedEntryCount * MEMORY_COMPACTION_CHURN_FACTOR) return;

    const events = compactMemoryProjection(
      principal,
      projection.episodes,
      projection.entries,
      projection.accessStatsByEntryId,
      projection.dream.lastCompleted,
    );
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
      ...(await this.listJoinedRunIdsForConversation(conversationId)).map((runId) => this.runPaths(runId).runEventsPath),
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
    for (const runId of await this.listJoinedRunIdsForConversation(conversationId)) {
      events.push(...await this.agentEventLog.readIfExists(this.runPaths(runId).runEventsPath));
    }
    return events;
  }

  private async readRunEventsByRunId(
    index: AgentConversationRunIndex,
    runIds: readonly string[],
  ): Promise<Map<string, AgentEvent[]>> {
    const delegated = new Set(index.delegationRunIds);
    const eventsByRunId = new Map<string, AgentEvent[]>();
    for (const runId of runIds) {
      const events = delegated.has(runId)
        ? await this.runEventLog.readIfExists(this.runPaths(runId).runEventsPath)
        : await this.agentEventLog.readIfExists(this.runPaths(runId).runEventsPath);
      eventsByRunId.set(runId, events);
    }
    return eventsByRunId;
  }

  /** EVERY run anchored to the conversation, delegation runs included. */
  private async listRunIdsForConversation(conversationId: string): Promise<string[]> {
    return (await this.ensureConversationRunIndex(conversationId)).runIds;
  }

  /**
   * The runs whose ledgers JOIN the conversation replay (turn/background/…) —
   * delegation runs are their own streams and are excluded everywhere the
   * conversation state is assembled (replay, checkpoints, latest-seq).
   */
  private async listJoinedRunIdsForConversation(conversationId: string): Promise<string[]> {
    const index = await this.ensureConversationRunIndex(conversationId);
    if (index.delegationRunIds.length === 0) return index.runIds;
    const delegated = new Set(index.delegationRunIds);
    return index.runIds.filter((runId) => !delegated.has(runId));
  }

  private async ensureConversationRunIndex(conversationId: string): Promise<AgentConversationRunIndex> {
    const index = await this.readConversationRunIndex(conversationId);
    if (index) return index;
    if (!await this.conversationDirExists(conversationId)) {
      return { v: 2, runIds: [], latestSeqByRunId: {}, delegationRunIds: [] };
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
    const delegationRunIds: string[] = [];
    try {
      const entries = await readdir(paths.runsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(paths.runsDir, entry.name);
        try {
          const meta = normalizeRunMeta(JSON.parse(await readFile(path.join(runDir, RUN_META_FILE), 'utf8')));
          if (!meta || conversationIdOfRun(meta) !== conversationId) continue;
          latestSeqByRunId[meta.id] = Math.max(latestSeqByRunId[meta.id] ?? 0, meta.latestSeq);
          if (meta.kind === 'delegation') delegationRunIds.push(meta.id);
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
    const index: AgentConversationRunIndex = { v: 2, runIds, latestSeqByRunId, delegationRunIds: delegationRunIds.sort() };
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
    for (const runId of await this.listJoinedRunIdsForConversation(conversationId)) {
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
    for (const runId of await this.listJoinedRunIdsForConversation(conversationId)) {
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
      await this.updateConversationRunIndex(conversationId, meta.id, meta.latestSeq, meta.kind);
    }
    if (meta.anchor.type === 'principal') {
      await this.updatePrincipalRunIndex(meta.anchor.principal, meta.id, meta.updatedAt);
    }
  }

  // Both run indexes are read-modify-write on a shared file reached from TWO
  // serial queues (the per-run ledger queue and the per-conversation event
  // queue), so the merge itself must serialize on `indexQueue` — otherwise a
  // child-run append racing a parent conversation append writes back a stale
  // runIds list and permanently drops a finished run from the index (cold
  // replay then silently misses that run's events; the index only self-heals
  // on a missing FILE, not a missing entry).
  private async updateConversationRunIndex(conversationId: string, runId: string, latestSeq: number, kind: AgentRunKind) {
    await this.enqueueIndexWrite(async () => {
      const paths = this.paths(conversationId);
      const existing = await this.ensureConversationRunIndex(conversationId);
      const runIds = existing.runIds.includes(runId) ? existing.runIds : [...existing.runIds, runId];
      const delegationRunIds = kind === 'delegation'
        ? (existing.delegationRunIds.includes(runId) ? existing.delegationRunIds : [...existing.delegationRunIds, runId])
        : existing.delegationRunIds.filter((id) => id !== runId);
      const index: AgentConversationRunIndex = {
        v: 2,
        runIds,
        latestSeqByRunId: {
          ...existing.latestSeqByRunId,
          [runId]: Math.max(existing.latestSeqByRunId[runId] ?? 0, latestSeq),
        },
        delegationRunIds,
      };
      await mkdir(paths.conversationDir, { recursive: true });
      await atomicWriteFile(paths.conversationRunIndexPath, `${JSON.stringify(index)}\n`);
    });
  }

  private async updatePrincipalRunIndex(principal: AgentPrincipal, runId: string, updatedAt: number) {
    await this.enqueueIndexWrite(async () => {
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
    });
  }

  private async updateRunMeta(conversationId: string, runId: string, events: readonly AgentEvent[]): Promise<AgentRunMetaProjection | null> {
    const existing = await this.readRunMeta(runId);
    const latest = events.at(-1);
    if (!latest) return null;
    const terminal = [...events].reverse().find(isRunTerminalEvent);
    const started = events.find((event) => event.type === 'run.started');
    const agentId = asAgentId(existing?.agentId ?? (started?.type === 'run.started' ? started.agentId ?? (started.anchor ? agentIdOfRunAnchor(started.anchor) : undefined) : undefined) ?? agentIdFromEvents(events) ?? 'built-in:tenon:assistant')!;
    const anchor = existing?.anchor ?? (started?.type === 'run.started' ? normalizeRunAnchor(started.anchor, agentId) : null) ?? conversationRunAnchor(agentId, conversationId);
    const trigger = existing?.trigger ?? (started?.type === 'run.started' ? started.trigger : undefined);
    const meta: AgentRunMetaProjection = {
      v: 1,
      id: runId,
      agentId,
      anchor,
      // The parent side of the run tree: a delegated run's trigger names the
      // run that spawned it ({type:'parent-run'}), and the meta mirrors it so
      // `runs WHERE parentRunId=X` is answerable from metas alone.
      parentRunId: existing?.parentRunId ?? (trigger?.type === 'parent-run' ? trigger.parentRunId : undefined),
      kind: existing?.kind ?? (started?.type === 'run.started' ? started.kind : undefined) ?? 'turn',
      status: terminal ? runStatusFromTerminalEvent(terminal) : existing?.status ?? 'running',
      trigger: trigger ?? { type: 'manual' },
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

  private async writeConversationMetaFromReplayState(
    conversationId: string,
    state: AgentEventReplayState,
  ): Promise<void> {
    const conversation = state.conversation;
    if (!conversation) {
      await rm(this.paths(conversationId).conversationMetaPath, { force: true });
      return;
    }
    const meta: AgentConversationMetaProjection = {
      v: 1,
      id: conversationId,
      members: conversation.members.slice(),
      goal: conversation.goal,
      createdAt: conversation.createdAt,
      title: conversation.title,
      name: conversation.title ?? undefined,
      updatedAt: conversation.updatedAt,
      latestSeq: state.latestSeq,
    };
    const paths = this.paths(conversationId);
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
            settings: entry?.settings ?? {},
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
            messageCount: entry?.messageCount ?? 0,
            latestSeq: event.seq,
            lastMessageSnippet: entry?.lastMessageSnippet ?? null,
            lastMessageAt: entry?.lastMessageAt ?? null,
            unreadCount: entry?.unreadCount ?? 0,
          };
        } else if (entry) {
          entry = updateConversationIndexEntry(entry, event);
        }
      }
      if (entry && events.some(shouldRecomputeConversationListSummary)) {
        entry = {
          ...entry,
          ...conversationListSummaryFromReplayState(await this.replay(conversationId)),
        };
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
      removeConversationEntriesFromSearchIndex(index, conversationId);
      await this.writeSearchIndex(index);
    });
  }

  private async replaceConversationInIndexes(
    conversationId: string,
    state: AgentEventReplayState,
    events: readonly AgentEvent[],
  ) {
    await this.enqueueIndexWrite(async () => {
      const conversationIndex = await this.readConversationIndex() ?? { conversations: {} };
      const conversationEntry = conversationIndexEntryFromReplayState(conversationId, state);
      if (conversationEntry) {
        conversationIndex.conversations[conversationId] = conversationEntry;
      } else {
        delete conversationIndex.conversations[conversationId];
      }
      await this.writeConversationIndex(conversationIndex);

      const searchIndex = await this.readSearchIndex() ?? createEmptySearchIndex();
      removeConversationEntriesFromSearchIndex(searchIndex, conversationId);
      for (const event of events) applyAgentEventToSearchIndex(searchIndex, event);
      await this.writeSearchIndex(searchIndex);
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
      if (!conversationIndexEntryHasCurrentShape(index.conversations[id])) return false;
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
  if (event.type === 'conversation.settings_changed') {
    next.settings = { ...next.settings, ...event.settings };
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
  if (event.type === 'user_message.created') {
    const summary = conversationListSummaryFromContent(event.content, event.createdAt);
    if (summary) {
      next.lastMessageSnippet = summary.lastMessageSnippet;
      next.lastMessageAt = summary.lastMessageAt;
    }
  }
  if (event.type === 'assistant_message.completed') {
    const summary = conversationListSummaryFromContent(event.content, event.createdAt);
    if (summary) {
      next.lastMessageSnippet = summary.lastMessageSnippet;
      next.lastMessageAt = summary.lastMessageAt;
    }
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
    settings: { ...state.conversation.settings },
    createdAt: state.conversation.createdAt,
    updatedAt: state.conversation.updatedAt,
    messageCount: Object.keys(state.messages).length,
    latestSeq: state.latestSeq,
    ...conversationListSummaryFromReplayState(state),
    unreadCount: state.attentionByConversationId[conversationId]?.unreadCount ?? 0,
  };
}

function conversationIndexEntryHasCurrentShape(entry: AgentConversationIndexEntry | undefined): boolean {
  if (!entry) return false;
  return Object.prototype.hasOwnProperty.call(entry, 'lastMessageSnippet')
    && Object.prototype.hasOwnProperty.call(entry, 'lastMessageAt')
    && isRecord(entry.settings);
}

// The list snippet is derived from the active path's latest user/assistant
// message, so only events that can change which message that is — or its text —
// warrant a replay-backed recompute. `tool_result.replaced` is deliberately
// excluded: it only ever rewrites a `toolResult` record (never a user/assistant
// message), so recomputing on it would replay the log on the run hot path
// (microcompaction slims tool output repeatedly) only to land on the same snippet.
function shouldRecomputeConversationListSummary(event: AgentEvent): boolean {
  return event.type === 'branch.selected'
    || event.type === 'user_message.edited';
}

function conversationListSummaryFromReplayState(
  state: AgentEventReplayState,
): Pick<AgentConversationIndexEntry, 'lastMessageSnippet' | 'lastMessageAt'> {
  for (const message of [...getAgentEventActivePath(state)].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const summary = conversationListSummaryFromContent(message.content, message.updatedAt);
    if (summary) return summary;
  }
  return { lastMessageSnippet: null, lastMessageAt: null };
}

function conversationListSummaryFromContent(
  content: readonly AgentPersistedContent[],
  timestamp: number,
): Pick<AgentConversationIndexEntry, 'lastMessageSnippet' | 'lastMessageAt'> | null {
  const text = persistedTextContent(content).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return {
    lastMessageSnippet: nodeReferenceMarkersToText(text).slice(0, 140),
    lastMessageAt: timestamp,
  };
}

function persistedTextContent(content: readonly AgentPersistedContent[]): string {
  return content
    .filter((part): part is Extract<AgentPersistedContent, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
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
    const outputPayloadIds = event.outputRef ? [event.outputRef.id] : [];
    if (event.type === 'tool_result.replaced') {
      // A replace is a model-context-only slim; NEVER index the slim bytes. The
      // canonical full output was indexed by tool_result.created and stays
      // searchable — preserve it, only advancing the seq and registering the
      // offload payload so the full bytes remain retrievable. If the creation
      // entry is somehow absent (a stray or partial replay), skip rather than fall
      // through and index the slim `event.content` as if it were the full output.
      if (current) {
        index.messages[key] = {
          ...current,
          updatedAt: event.createdAt,
          latestSeq: event.seq,
          payloadIds: uniqueStrings([...current.payloadIds, ...outputPayloadIds]),
        };
      }
      return;
    }
    const content = indexDetailsFromContent([
      ...event.content,
      { type: 'text', text: event.outputSummary },
    ]);
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

function removeConversationEntriesFromSearchIndex(index: AgentEventSearchIndex, conversationId: string): void {
  for (const [key, entry] of Object.entries(index.messages)) {
    if (entry.conversationId === conversationId) delete index.messages[key];
  }
  for (const [key, entry] of Object.entries(index.userMessages)) {
    if (entry.conversationId === conversationId) delete index.userMessages[key];
  }
  delete index.latestSeqByConversationId[conversationId];
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

function compareAgentEventsForReplay(left: AgentEvent, right: AgentEvent): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId);
}

function agentRunIdForEvent(event: AgentEvent): string | null {
  return typeof event.runId === 'string' && event.runId.length > 0 ? event.runId : null;
}

function collectMessageIdsFromEvents(events: Iterable<AgentEvent>, target: Set<string>): void {
  for (const event of events) {
    if (event.type === 'user_message.created') target.add(event.messageId);
    if (event.type === 'assistant_message.started') target.add(event.messageId);
    if (event.type === 'tool_result.created') target.add(event.messageId);
  }
}

function retainConversationStreamEventAfterRunPrune(
  event: AgentEvent,
  prunedRunIds: ReadonlySet<string>,
  prunedMessageIds: ReadonlySet<string>,
): AgentEvent | null {
  const runId = agentRunIdForEvent(event);
  if (runId && prunedRunIds.has(runId)) return null;
  if (event.type === 'payload.created' && event.payload.scope?.type === 'run' && prunedRunIds.has(event.payload.scope.runId)) return null;
  if (event.type === 'payload.derived' && event.payload.scope?.type === 'run' && prunedRunIds.has(event.payload.scope.runId)) return null;
  if (event.type === 'user_message.created') {
    if (prunedMessageIds.has(event.messageId)) return null;
    if (event.parentMessageId && prunedMessageIds.has(event.parentMessageId)) {
      return { ...event, parentMessageId: null };
    }
  }
  if (event.type === 'user_message.edited' && prunedMessageIds.has(event.messageId)) return null;
  if (event.type === 'branch.selected' && prunedMessageIds.has(event.leafMessageId)) return null;
  if (event.type === 'compaction.completed') {
    if (prunedMessageIds.has(event.messageId)) return null;
    if (
      prunedMessageIds.has(event.source.fromMessageId)
      || prunedMessageIds.has(event.source.throughMessageId)
    ) return null;
  }
  if (event.type === 'dream.finished' && prunedMessageIds.has(event.messageId)) return null;
  return event;
}

/**
 * Serialization/latest-seq key for a delegated run's OWN ledger stream — kept
 * distinct from conversation log keys (a conversation id and a run id could in
 * principle collide as raw strings).
 */
function runStreamLogKey(runId: string): string {
  return `run-stream:${runId}`;
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
  if (!isRecord(value) || value.v !== 2 || !Array.isArray(value.runIds)) return null;
  const latestSeqByRunId = isRecord(value.latestSeqByRunId)
    ? Object.fromEntries(Object.entries(value.latestSeqByRunId).filter((entry): entry is [string, number] => (
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
      )))
    : {};
  const runIds = uniqueStrings(value.runIds.filter((runId): runId is string => typeof runId === 'string'));
  const delegationRunIds = Array.isArray(value.delegationRunIds)
    ? uniqueStrings(value.delegationRunIds.filter((runId): runId is string => typeof runId === 'string'))
        .filter((runId) => runIds.includes(runId))
    : [];
  return { v: 2, runIds, latestSeqByRunId, delegationRunIds };
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
    || value === 'delegation'
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

/**
 * The delegated-run ledger parse: like {@link parseEventsJsonl} but a torn FINAL
 * line — the crash artifact of an interrupted child-message append — is dropped
 * with a warning instead of failing the read (same policy as the memory log:
 * the run is marked interrupted on restore, so the lost in-flight event is
 * accounted for). A malformed line in the middle is real corruption and still
 * fails loudly.
 */
function parseRunEventsJsonl(raw: string, source: string): AgentEvent[] {
  const events: AgentEvent[] = [];
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
      events.push(JSON.parse(line) as AgentEvent);
    } catch (error) {
      if (index === lastContentIndex) {
        console.warn(`Dropping torn trailing agent run event at ${source}:${index + 1}`);
        break;
      }
      throw new Error(`Invalid agent run event JSON at ${source}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
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
  episodes: Map<string, AgentMemoryEpisode>;
  memoryIdsByEpisodeId: Map<string, Set<string>>;
  accessStatsByEntryId: Map<string, AgentMemoryAccessStats>;
  dream: AgentDreamState;
} {
  const entries = new Map<string, AgentMemoryEntry>();
  const episodes = new Map<string, AgentMemoryEpisode>();
  const accessStatsByEntryId = new Map<string, AgentMemoryAccessStats>();
  let lastCompletedDream: Extract<AgentMemoryEvent, { type: 'dream.completed' }> | null = null;
  for (const event of [...events].sort(compareMemoryEventsForReplay)) {
    if (event.type === 'memory.episode_recorded') {
      const episode = normalizeMemoryEpisode(event.episode);
      if (episode) episodes.set(episode.id, episode);
      continue;
    }

    if (event.type === 'memory.entry_added') {
      const entry = normalizeMemoryEntry(event.entry);
      if (entry) entries.set(entry.id, entry);
      continue;
    }

    if (event.type === 'dream.completed') {
      lastCompletedDream = event;
      continue;
    }

    if (event.type === 'memory.accessed') {
      applyMemoryAccessEvent(accessStatsByEntryId, event);
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
  const memoryIdsByEpisodeId = buildMemoryEpisodeReverseIndex(entries);
  return {
    entries,
    episodes,
    memoryIdsByEpisodeId,
    accessStatsByEntryId,
    dream: lastCompletedDream ? dreamStateFromCompleted(lastCompletedDream) : emptyDreamState(),
  };
}

function compactMemoryProjection(
  principal: AgentPrincipal,
  episodes: ReadonlyMap<string, AgentMemoryEpisode>,
  entries: ReadonlyMap<string, AgentMemoryEntry>,
  accessStatsByEntryId: ReadonlyMap<string, AgentMemoryAccessStats>,
  lastCompletedDream: Extract<AgentMemoryEvent, { type: 'dream.completed' }> | null,
): AgentMemoryEvent[] {
  const createdAt = Date.now();
  const episodeEvents = [...episodes.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((episode, index): AgentMemoryEvent => ({
      v: 1,
      type: 'memory.episode_recorded',
      eventId: `episode-compact-${randomUUID()}`,
      seq: index + 1,
      principal,
      createdAt,
      episode,
    }));
  const entryEvents = [...entries.values()]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((entry, index): AgentMemoryEvent => ({
      v: 1,
      type: 'memory.entry_added',
      eventId: `memory-compact-${randomUUID()}`,
      seq: episodeEvents.length + index + 1,
      principal,
      createdAt,
      entry,
    }));
  const activeEntryIds = new Set(entries.keys());
  const accessEvents = compactMemoryAccessEvents(
    principal,
    accessStatsByEntryId,
    activeEntryIds,
    episodeEvents.length + entryEvents.length,
  );
  const events = [...episodeEvents, ...entryEvents, ...accessEvents];
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

function buildMemoryEpisodeReverseIndex(
  entries: ReadonlyMap<string, AgentMemoryEntry>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entry of entries.values()) {
    indexMemoryEntryEpisodeSources(index, entry);
  }
  return index;
}

function compactMemoryAccessEvents(
  principal: AgentPrincipal,
  accessStatsByEntryId: ReadonlyMap<string, AgentMemoryAccessStats>,
  activeEntryIds: ReadonlySet<string>,
  seqOffset: number,
): AgentMemoryEvent[] {
  const events: AgentMemoryEvent[] = [];
  for (const via of ['briefing', 'recall'] as const) {
    const accesses = [...accessStatsByEntryId.entries()]
      .map(([entryId, stats]) => ({
        entryId,
        count: via === 'briefing' ? stats.briefingCount : stats.recallCount,
        createdAt: via === 'briefing' ? stats.lastBriefingAt : stats.lastRecallAt,
      }))
      .filter((access) => activeEntryIds.has(access.entryId) && access.count > 0 && access.createdAt !== null)
      .sort((left, right) => left.entryId.localeCompare(right.entryId));
    if (accesses.length === 0) continue;
    events.push({
      v: 1,
      type: 'memory.accessed',
      eventId: `access-compact-${randomUUID()}`,
      seq: seqOffset + events.length + 1,
      principal,
      createdAt: Math.max(...accesses.map((access) => access.createdAt ?? 0)),
      via,
      accesses: accesses.map(({ entryId, count, createdAt }) => ({
        entryId,
        count,
        accessedAt: createdAt ?? undefined,
      })),
    });
  }
  return events;
}

function applyMemoryAccessEvent(
  accessStatsByEntryId: Map<string, AgentMemoryAccessStats>,
  event: Extract<AgentMemoryEvent, { type: 'memory.accessed' }>,
): void {
  for (const access of event.accesses) {
    const count = Math.max(1, Math.trunc(access.count));
    const accessedAt = access.accessedAt ?? event.createdAt;
    const current = cloneMemoryAccessStats(accessStatsByEntryId.get(access.entryId) ?? emptyMemoryAccessStats());
    if (event.via === 'recall') {
      current.recallCount += count;
      current.lastRecallAt = Math.max(current.lastRecallAt ?? 0, accessedAt);
    } else {
      current.briefingCount += count;
      current.lastBriefingAt = Math.max(current.lastBriefingAt ?? 0, accessedAt);
    }
    accessStatsByEntryId.set(access.entryId, current);
  }
}

function setMemoryProjectionEntry(
  projection: AgentMemoryProjectionCache,
  entry: AgentMemoryEntry,
  previous?: AgentMemoryEntry,
): void {
  if (previous) deindexMemoryEntryEpisodeSources(projection.memoryIdsByEpisodeId, previous);
  projection.entries.set(entry.id, entry);
  indexMemoryEntryEpisodeSources(projection.memoryIdsByEpisodeId, entry);
}

function indexMemoryEntryEpisodeSources(index: Map<string, Set<string>>, entry: AgentMemoryEntry): void {
  for (const source of entry.sources) {
    if (!('episodeId' in source)) continue;
    const ids = index.get(source.episodeId) ?? new Set<string>();
    ids.add(entry.id);
    index.set(source.episodeId, ids);
  }
}

function deindexMemoryEntryEpisodeSources(index: Map<string, Set<string>>, entry: AgentMemoryEntry): void {
  for (const source of entry.sources) {
    if (!('episodeId' in source)) continue;
    const ids = index.get(source.episodeId);
    if (!ids) continue;
    ids.delete(entry.id);
    if (ids.size === 0) index.delete(source.episodeId);
  }
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

  if (value.type === 'memory.episode_recorded') {
    const episode = normalizeMemoryEpisode(value.episode);
    if (!episode || !samePrincipal(episode.principal, principal)) return null;
    return {
      v: 1,
      type: 'memory.episode_recorded',
      eventId: value.eventId,
      seq,
      principal,
      createdAt,
      episode,
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

  if (value.type === 'memory.accessed') {
    const via = value.via === 'briefing' || value.via === 'recall' ? value.via : null;
    const accesses = normalizeMemoryAccesses(value.accesses);
    if (!via || accesses.length === 0) return null;
    return {
      v: 1,
      type: 'memory.accessed',
      eventId: value.eventId,
      seq,
      principal,
      createdAt,
      via,
      accesses,
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

function normalizeMemoryEpisode(value: unknown): AgentMemoryEpisode | null {
  if (!isRecord(value)) return null;
  const principal = normalizePrincipal(value.principal);
  if (typeof value.id !== 'string' || !principal) return null;
  const gist = normalizeMemoryGist(value.gist);
  const createdAt = numberOrNull(value.createdAt);
  if (!gist || createdAt === null) return null;
  const sources = Array.isArray(value.sources) ? value.sources.map(normalizeMemoryStreamSource).filter(isPresent) : [];
  if (sources.length === 0) return null;
  return {
    id: value.id,
    principal,
    gist,
    originWorkspace: normalizeOptionalString(value.originWorkspace),
    sources,
    createdAt,
  };
}

function emptyDreamState(): AgentDreamState {
  return {
    lastCompleted: null,
    watermark: { conversations: {}, runs: {} },
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
  if (!isRecord(value) || !isRecord(value.conversations)) return { conversations: {}, runs: {} };
  const conversations: AgentDreamWatermark['conversations'] = {};
  for (const [conversationId, rawCursor] of Object.entries(value.conversations)) {
    const cursor = normalizeDreamWatermarkCursor(rawCursor);
    if (cursor) conversations[conversationId] = cursor;
  }
  // ONE cursor shape for run streams too (run unification).
  const runs: NonNullable<AgentDreamWatermark['runs']> = {};
  if (isRecord(value.runs)) {
    for (const [runId, rawCursor] of Object.entries(value.runs)) {
      const cursor = normalizeDreamWatermarkCursor(rawCursor);
      if (cursor) runs[runId] = cursor;
    }
  }
  return { conversations, runs };
}

function normalizeDreamWatermarkCursor(value: unknown): AgentDreamWatermark['conversations'][string] | null {
  if (!isRecord(value)) return null;
  const seq = numberOrNull(value.seq);
  if (seq === null || seq < 0) return null;
  const eventId = typeof value.eventId === 'string' || value.eventId === null ? value.eventId : null;
  return { seq: Math.trunc(seq), eventId };
}

function normalizeDreamProcessed(value: unknown): Extract<AgentMemoryEvent, { type: 'dream.completed' }>['processed'] | null {
  if (!isRecord(value) || !isRecord(value.conversations)) return null;
  return {
    conversations: normalizeDreamProcessedConversations(value.conversations),
    runs: normalizeDreamProcessedRuns(value.runs),
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

function normalizeDreamProcessedRuns(value: unknown): Record<string, AgentDreamProcessedRun> {
  if (!isRecord(value)) return {};
  const runs: Record<string, AgentDreamProcessedRun> = {};
  for (const [runId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.conversationId !== 'string' || raw.conversationId.length === 0) continue;
    const fromSeqExclusive = numberOrNull(raw.fromSeqExclusive);
    const throughSeq = numberOrNull(raw.throughSeq);
    if (fromSeqExclusive === null || throughSeq === null || fromSeqExclusive < 0 || throughSeq < fromSeqExclusive) continue;
    runs[runId] = {
      conversationId: raw.conversationId,
      fromSeqExclusive: Math.trunc(fromSeqExclusive),
      throughSeq: Math.trunc(throughSeq),
      throughEventId: typeof raw.throughEventId === 'string' || raw.throughEventId === null ? raw.throughEventId : null,
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

function normalizeMemoryAccesses(value: unknown): Extract<AgentMemoryEvent, { type: 'memory.accessed' }>['accesses'] {
  if (!Array.isArray(value)) return [];
  const accesses: Extract<AgentMemoryEvent, { type: 'memory.accessed' }>['accesses'] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.entryId !== 'string' || raw.entryId.length === 0) continue;
    if (seen.has(raw.entryId)) continue;
    const count = nonNegativeInteger(raw.count);
    if (count <= 0) continue;
    const accessedAt = numberOrNull(raw.accessedAt);
    seen.add(raw.entryId);
    accesses.push({
      entryId: raw.entryId,
      count,
      ...(accessedAt === null ? {} : { accessedAt }),
    });
  }
  return accesses;
}

function normalizeMemorySource(value: unknown): AgentMemorySource | null {
  if (!isRecord(value)) return null;
  if (typeof value.episodeId === 'string' && value.episodeId.length > 0) {
    return { episodeId: value.episodeId };
  }
  return normalizeMemoryStreamSource(value);
}

function normalizeMemoryStreamSource(value: unknown): AgentMemoryStreamSource | null {
  if (!isRecord(value)) return null;
  if (value.stream !== 'conversation' && value.stream !== 'run') return null;
  if (typeof value.streamId !== 'string' || value.streamId.length === 0) return null;
  const range = normalizeMemorySourceRange(value.range);
  if (!range) return null;
  return {
    stream: value.stream,
    streamId: value.streamId,
    range,
  };
}

function normalizeMemorySourceRange(value: unknown): AgentMemoryStreamSource['range'] | null {
  if (!isRecord(value)) return null;
  const fromSeqExclusive = numberOrNull(value.fromSeqExclusive);
  const throughSeq = numberOrNull(value.throughSeq);
  if (
    fromSeqExclusive === null
    || throughSeq === null
    || fromSeqExclusive < 0
    || throughSeq < fromSeqExclusive
  ) {
    return null;
  }
  return {
    fromSeqExclusive: Math.trunc(fromSeqExclusive),
    throughSeq: Math.trunc(throughSeq),
    throughEventId: typeof value.throughEventId === 'string' || value.throughEventId === null
      ? value.throughEventId
      : null,
  };
}

function normalizeMemoryFact(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const fact = normalizeDisplayText(value);
  if (!fact) return null;
  if (fact.length <= MAX_AGENT_MEMORY_FACT_CHARS) return fact;
  return `${fact.slice(0, MAX_AGENT_MEMORY_FACT_CHARS - 3).trimEnd()}...`;
}

function normalizeMemoryGist(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const gist = normalizeDisplayText(value);
  if (!gist) return null;
  const maxChars = 4_000;
  if (gist.length <= maxChars) return gist;
  return `${gist.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function clampMemoryLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function compareMemoryEventsForReplay(left: AgentMemoryEvent, right: AgentMemoryEvent): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId);
}

function memoryActivationDayBucket(now: number): number {
  return Math.floor(now / MEMORY_ACTIVATION_CACHE_BUCKET_MS);
}

function wasBriefedRecently(stats: AgentMemoryAccessStats | undefined, now: number): boolean {
  if (!stats || stats.lastBriefingAt === null) return false;
  return now - stats.lastBriefingAt < MEMORY_BRIEFING_ACCESS_WINDOW_MS;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function cloneReplayState(state: AgentEventReplayState): AgentEventReplayState {
  return JSON.parse(JSON.stringify(state)) as AgentEventReplayState;
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
  if (!isRecord(state.childRuns) || !isRecord(state.compactionsByMessageId)) return null;
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
