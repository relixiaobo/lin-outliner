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
  AgentRunContextPolicy,
  AgentRunDisposition,
  AgentRunFingerprint,
  AgentRunKind,
  AgentObjectiveStatus,
  AgentRunBudget,
  AgentRunMeta,
  AgentRunObjectiveRole,
  AgentRunPurpose,
  AgentRunProfileId,
  AgentRunRetention,
  AgentRunScope,
  AgentRunStatus,
  AgentIdentityRecord,
  AgentRunTrigger,
} from '../core/agentEventLog';
import { agentIdOfRunAnchor, appendAgentEventToReplayState, conversationIdOfRun, getAgentEventActivePath, mergeUniquePrincipals, principalKey, replayAgentEvents, samePrincipal } from '../core/agentEventLog';
import { DEFAULT_DREAM_CHANNEL_ID } from '../core/agentChannel';
import {
  assertValidRunExecutionStatusTransition,
  assertValidRunObjectiveStatusTransition,
} from '../core/agentRunStateMachine';
import {
  analyzeTextSearchQuery,
  normalizeSearchText,
  textSearchTextMatchesQuery,
} from '../core/textSearchAnalyzer';
import { nodeReferenceMarkersToText } from '../core/referenceMarkup';
import type { ErrorReport, ErrorReportContext } from '../core/errorObservability';
import { AppendOnlySeqLog, serializeJsonl, type AppendOnlySeqLogTail } from './appendOnlySeqLog';
import { atomicWriteFile } from './jsonFileStore';
import {
  isRunProfileId,
  objectiveRoleForRun,
  runProfileFromStartedRun,
} from './agentRunProfiles';
import {
  AGENT_DELETION_LOG_FILE,
  AGENT_DELETION_VERSION,
  AGENT_PORTABLE_CATALOG_VERSION,
  applyDeletionTombstone,
  cloneAgentActor,
  cloneDeletionEntity,
  cloneDeletionTombstone,
  comparePortableStreamIdentities,
  deletionEntityIsDeleted,
  deletionEntityKey,
  emptyDeletionState,
  parseDeletionTombstonesJsonl,
  portableAgentEvent,
  portablePayloadCatalog,
  portableStreamCatalogEntry,
  portableStreamIsDeleted,
  type AgentDeletionContext,
  type AgentDeletionEntity,
  type AgentDeletionState,
  type AgentDeletionTombstone,
  type AgentEventIdentity,
  type AgentPortableCatalog,
  type AgentPortableStreamCatalogEntry,
  type AgentPortableStreamIdentity,
} from './agentLedgerPortability';

export { AGENT_DELETION_LOG_FILE } from './agentLedgerPortability';
export type {
  AgentDeletionContext,
  AgentDeletionEntity,
  AgentDeletionReason,
  AgentDeletionTombstone,
  AgentEventIdentity,
  AgentPortableCatalog,
  AgentPortablePayloadCatalogEntry,
  AgentPortablePayloadRole,
  AgentPortableStreamCatalogEntry,
  AgentPortableStreamIdentity,
} from './agentLedgerPortability';

const CONVERSATION_SEGMENT_FILE = '000001.jsonl';
const CONVERSATION_RUN_INDEX_FILE = 'runs.json';
const AGENT_RUN_INDEX_FILE = 'runs.json';
const RUN_EVENT_LOG_FILE = 'events.jsonl';
const RUN_META_FILE = 'meta.json';
const AGENT_IDENTITY_FILE = 'identity.json';
const CONVERSATION_INDEX_FILE = 'conversation-index.json';
const SEARCH_INDEX_FILE = 'search-index.json';
const AGENT_DELETION_LOG_KEY = 'workspace-deletions';
const CONVERSATION_INDEX_VERSION = 1;
// The storage-generation sentinel ([[agent-run-unification]] Design 6): ONE
// event-store root file `layout.json {v}` written once per on-disk format generation.
// Startup reads this single line — current generation proceeds with no
// per-conversation probing; a stale or missing sentinel is positive proof of
// another generation and wipes only event-log owned paths (pre-release clean-cut,
// no migration); an unreadable/corrupt sentinel is AMBIGUITY and fails open to
// the current layout (log + re-probe next launch — never wipe on error).
// Future format breaks bump the integer instead of authoring a new detector.
export const LAYOUT_SENTINEL_FILE = 'layout.json';
// v7 = agent-run-graph-cleanup: conversation logs no longer store
// child_run.started/updated lifecycle markers. The Run index and each run's
// ledger are the durable execution record; conversation logs keep only chat,
// permissions, notifications, and other conversation-local events.
// v6 = agent-run-graph-cleanup: run meta v2 stores nested execution/objective
// state plus parentToolCallId, runProfile, and context. Old flat run metas are
// pre-release data and are wiped by the sentinel.
// v5 = agent-goal: run `kind` is no longer stored; run meta stores
// `disposition` and derives presentation kind from provenance/lineage.
// v4 = Dream channel PR-3: remove the principal memory event log/projection.
// Durable memory now lives only in outline nodes; principal sidecars keep only
// reflective-run indexes. No legacy memory reader; pre-release clean-cut wipes
// old agent data.
// v3 = memory realignment PR-2: memory sources were a discriminated union and
// principal-owned episode gist nodes were still persisted outside the outline.
// v2 = run unification: a delegated run is its own ledger (`runs/<runId>/
// events.jsonl`, own seq space) excluded from conversation replay. The
// pre-unification entity-grade events and transcript-snapshot payloads are gone.
export const STORAGE_LAYOUT_VERSION = 7;
// Checkpoints are disposable replay caches. Bump this whenever a required
// AgentEventReplayState field changes so older shapes fall back to full replay.
const CHECKPOINT_VERSION = 6;
const SEARCH_INDEX_VERSION = 3;
const DEFAULT_CHECKPOINT_EVENT_INTERVAL = 100;
const MAX_CHECKPOINTS_PER_CONVERSATION = 3;
const MAX_SEARCH_INDEX_TEXT_CHARS = 20_000;
const SEARCH_INDEX_PREVIEW_CHARS = 240;
const EVENT_STORE_CLEAN_CUT_PATHS = [
  'agents',
  'conversations',
  AGENT_DELETION_LOG_FILE,
  'indexes',
  'principals',
  'runs',
] as const;

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
  v: 2;
}

export function deriveAgentRunKind(meta: Pick<AgentRunMetaProjection, 'id' | 'anchor' | 'parentRunId' | 'trigger' | 'disposition'>): AgentRunKind {
  if (meta.parentRunId || isDelegationRunId(meta.id)) return 'delegation';
  if (meta.anchor.type === 'principal') return 'reflective';
  if (meta.anchor.type === 'conversation' && meta.anchor.conversationId === DEFAULT_DREAM_CHANNEL_ID) return 'reflective';
  if (meta.trigger.type === 'schedule') return 'scheduled';
  return meta.disposition === 'detached' ? 'background' : 'turn';
}

export interface AgentConversationMetaProjection extends AgentConversationMeta {
  v: 1;
  title: string | null;
  updatedAt: number;
  latestSeq: number;
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

interface AgentConversationIndex {
  v: typeof CONVERSATION_INDEX_VERSION;
  deletionSeq: number;
  conversations: Record<string, AgentConversationIndexEntry>;
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
   * Runs whose ledgers are their OWN streams (derived presentation kind
   * 'delegation'): excluded from the conversation replay join, checkpoint targets,
   * and the conversation's latest-seq derivation — a delegated run has its own seq
   * space and its own message tree, replayed independently (run unification).
   */
  delegationRunIds: string[];
}

/**
 * Derived index of the reflective runs anchored to one principal. Lives in the
 * principal sidecar directory; rebuilt from `runs/` on miss.
 */
interface AgentPrincipalRunIndex {
  v: 1;
  principalKey: string;
  runIds: string[];
  updatedAtByRunId: Record<string, number>;
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
  deletionSeq: number;
  messages: Record<string, AgentEventSearchIndexEntry>;
  userMessages: Record<string, AgentEventUserMessageIndexEntry>;
  latestSeqByConversationId: Record<string, number>;
}

interface PendingAgentDeletion {
  entity: AgentDeletionEntity;
  lastKnownEvent: AgentEventIdentity | null;
}

export class AgentEventStore {
  private readonly agentEventLog = new AppendOnlySeqLog<AgentEvent>('agent event', parseEventsJsonl);
  // Delegated-run ledgers get the tolerant sidecar torn-tail policy, NOT the
  // conversation log's strict one: they are high-write append-only sidecars, so
  // a half-written FINAL line is a routine crash artifact of an interrupted
  // child-message append (the run is marked interrupted on restore anyway). A
  // tolerant parse keeps the transcript readable — and keeps one corrupt child
  // ledger from bricking its whole parent conversation — and lets the
  // before-append repair truncate the fragment so a resume can append again.
  // Mid-file corruption still fails loudly on both logs.
  private readonly runEventLog = new AppendOnlySeqLog<AgentEvent>('agent run event', parseRunEventsJsonl);
  private readonly deletionLog = new AppendOnlySeqLog<AgentDeletionTombstone>(
    'agent deletion tombstone',
    parseDeletionTombstonesJsonl,
  );
  private indexQueue = Promise.resolve();
  private storageLayoutPromise: Promise<void> | null = null;
  private deletionStatePromise: Promise<AgentDeletionState> | null = null;

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

  /** The agent's identity directory — holds ONLY `identity.json`; principal sidecars live under `principals/`. */
  agentPaths(agentId: string): { agentDir: string; identityPath: string } {
    const agentDir = path.join(this.rootDir, 'agents', agentIdentityDirName(agentId));
    return {
      agentDir,
      identityPath: path.join(agentDir, AGENT_IDENTITY_FILE),
    };
  }

  /**
   * On-disk location of a principal's reflective-run sidecars. One path rule for
   * every principal type: `principals/<agent-<agentId> | user-<userId>>/`.
   */
  principalPaths(principal: AgentPrincipal): { principalDir: string; runIndexPath: string } {
    const principalDir = path.join(this.rootDir, 'principals', agentPrincipalDirName(principal));
    return {
      principalDir,
      runIndexPath: path.join(principalDir, AGENT_RUN_INDEX_FILE),
    };
  }

  async appendEvents(conversationId: string, events: readonly AgentEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureStorageLayout();
    this.assertEventBatch(conversationId, events);
    await this.agentEventLog.enqueue(conversationId, async () => {
      await this.assertConversationWritable(conversationId);
      for (const runId of runIdsReferencedByEvents(events)) {
        await this.assertRunWritable(conversationId, runId);
      }
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
    if (await this.isConversationDeleted(conversationId)) return [];
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
      await this.assertConversationWritable(conversationId);
      await this.assertRunWritable(conversationId, runId);
      const latestSeq = await this.runEventLog.latestSeq(runStreamLogKey(runId), () => [runPaths.runEventsPath]);
      const firstSeq = events[0]!.seq;
      if (firstSeq <= latestSeq) {
        throw new Error(`Run-stream event seq ${firstSeq} is not after existing seq ${latestSeq}`);
      }
      await this.runEventLog.append(runPaths.runEventsPath, events);
      this.runEventLog.setLatestSeq(runStreamLogKey(runId), events.at(-1)!.seq);
      await this.removeRunWriteIfDeleted(conversationId, runId);
      const metaEvents = events.filter((event) => !isStreamingDeltaEvent(event));
      if (metaEvents.length > 0) {
        const meta = await this.updateRunMeta(conversationId, runId, metaEvents);
        if (meta) await this.updateRunIndexes(meta);
      }
      await this.removeRunWriteIfDeleted(conversationId, runId);
    });
  }

  /** Read a delegated run's own ledger (its independent event stream). */
  async readRunStreamEvents(runId: string): Promise<AgentEvent[]> {
    await this.ensureStorageLayout();
    if (await this.isRunDeleted(runId)) return [];
    const events = await this.runEventLog.readIfExists(this.runPaths(runId).runEventsPath);
    const conversationId = events[0]?.conversationId;
    return conversationId && await this.isConversationDeleted(conversationId) ? [] : events;
  }

  /**
   * Read ONLY the conversation segment (not the joined run streams). The
   * run-grounded debug view ([[agent-debug-run-grounded]]) reads it once to recover
   * the conversation-stream events a run's own ledger lacks — the triggering user
   * message and conversation-budget `tool_result.replaced` slimming — far cheaper
   * than the full merged `readEvents`.
   */
  async readConversationStreamEvents(conversationId: string): Promise<AgentEvent[]> {
    await this.ensureStorageLayout();
    if (await this.isConversationDeleted(conversationId)) return [];
    return this.agentEventLog.readIfExists(this.paths(conversationId).conversationEventsPath);
  }

  /** Replay a delegated run's ledger into its own independent state. */
  async replayRunStream(runId: string): Promise<AgentEventReplayState> {
    return replayAgentEvents(await this.readRunStreamEvents(runId));
  }

  async replay(conversationId: string): Promise<AgentEventReplayState> {
    await this.ensureStorageLayout();
    if (await this.isConversationDeleted(conversationId)) return replayAgentEvents([]);
    const checkpointed = await this.replayFromCheckpoint(conversationId);
    if (checkpointed) return checkpointed;
    return replayAgentEvents(await this.readEvents(conversationId));
  }

  async writeCheckpoint(conversationId: string, state: AgentEventReplayState): Promise<AgentEventCheckpoint | null> {
    if (!state.conversation || state.conversation.id !== conversationId || state.latestSeq <= 0) return null;
    await this.ensureStorageLayout();
    return this.agentEventLog.enqueue(conversationId, async () => {
      await this.assertConversationWritable(conversationId);
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
    const write = async () => {
      await this.assertConversationWritable(conversationId);
      if (input.runId) await this.assertRunWritable(conversationId, input.runId);
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
      if (input.runId) await this.removeRunWriteIfDeleted(conversationId, input.runId);
      return payload;
    };
    return input.runId
      ? this.runEventLog.enqueue(runStreamLogKey(input.runId), write)
      : this.agentEventLog.enqueue(conversationId, write);
  }

  async readPayload(conversationId: string, payload: AgentPayloadRef): Promise<Buffer> {
    await this.ensureStorageLayout();
    if (await this.isConversationDeleted(conversationId)) {
      throw new Error(`Agent conversation ${conversationId} was deleted`);
    }
    if (payload.scope?.type === 'run' && await this.isRunDeleted(payload.scope.runId)) {
      throw new Error(`Agent run ${payload.scope.runId} was deleted`);
    }
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

  async deleteConversation(conversationId: string, context: AgentDeletionContext): Promise<void> {
    await this.ensureStorageLayout();
    await this.agentEventLog.enqueue(conversationId, async () => {
      const runIds = await this.runIdsForConversationDeletion(conversationId);
      await this.appendDeletionTombstones([
        {
          entity: { type: 'conversation', conversationId },
          lastKnownEvent: await this.lastKnownEvent(this.paths(conversationId).conversationEventsPath),
        },
        ...await Promise.all(runIds.map(async (runId): Promise<PendingAgentDeletion> => ({
          entity: { type: 'run', conversationId, runId },
          lastKnownEvent: await this.lastKnownEvent(this.runPaths(runId).runEventsPath, true),
        }))),
      ], context);
      await this.removeConversationStorage(conversationId, runIds);
    });
  }

  /**
   * Reset preserves the conversation identity, so only the discarded Run
   * entities receive tombstones. The caller recreates the conversation stream
   * after this method returns.
   */
  async resetConversationStorage(conversationId: string, context: AgentDeletionContext): Promise<void> {
    await this.ensureStorageLayout();
    await this.agentEventLog.enqueue(conversationId, async () => {
      await this.assertConversationWritable(conversationId);
      const runIds = await this.runIdsForConversationDeletion(conversationId);
      await this.appendDeletionTombstones(
        await Promise.all(runIds.map(async (runId): Promise<PendingAgentDeletion> => ({
          entity: { type: 'run', conversationId, runId },
          lastKnownEvent: await this.lastKnownEvent(this.runPaths(runId).runEventsPath, true),
        }))),
        context,
      );
      await this.removeConversationStorage(conversationId, runIds);
    });
  }

  async listConversationIds(): Promise<string[]> {
    await this.ensureStorageLayout();
    try {
      const entries = await readdir(this.paths('__placeholder__').conversationsDir, { withFileTypes: true });
      const state = await this.deletionState();
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => decodeAgentConversationDirName(entry.name))
        .filter((conversationId) => !state.conversationIds.has(conversationId))
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async readPortableStream(identity: AgentPortableStreamIdentity): Promise<AgentEvent[]> {
    await this.ensureStorageLayout();
    if (identity.type === 'conversation') {
      if (await this.isConversationDeleted(identity.conversationId)) return [];
      const events = await this.agentEventLog.readIfExists(this.paths(identity.conversationId).conversationEventsPath);
      return events
        .filter((event) => event.conversationId === identity.conversationId)
        .flatMap((event) => {
          const portable = portableAgentEvent(event);
          return portable ? [portable] : [];
        });
    }

    if (await this.isRunDeleted(identity.runId) || await this.isConversationDeleted(identity.conversationId)) return [];
    const events = await this.runEventLog.readIfExists(this.runPaths(identity.runId).runEventsPath);
    return events
      .filter((event) => event.conversationId === identity.conversationId && event.runId === identity.runId)
      .flatMap((event) => {
        const portable = portableAgentEvent(event);
        return portable ? [portable] : [];
      });
  }

  async buildPortableCatalog(): Promise<AgentPortableCatalog> {
    await this.ensureStorageLayout();
    const streamsWithEvents: Array<{
      entry: AgentPortableStreamCatalogEntry;
      events: AgentEvent[];
    }> = [];

    for (const conversationId of await this.listConversationIds()) {
      const identity: AgentPortableStreamIdentity = { type: 'conversation', conversationId };
      const events = await this.readPortableStream(identity);
      const entry = portableStreamCatalogEntry(identity, events);
      if (entry) streamsWithEvents.push({ entry, events });
    }

    for (const runId of await this.listStoredRunIds()) {
      if (await this.isRunDeleted(runId)) continue;
      const rawEvents = await this.runEventLog.readIfExists(this.runPaths(runId).runEventsPath);
      const conversationId = rawEvents.find((event) => event.runId === runId)?.conversationId;
      if (!conversationId || await this.isConversationDeleted(conversationId)) continue;
      const identity: AgentPortableStreamIdentity = { type: 'run', conversationId, runId };
      const events = rawEvents
        .filter((event) => event.conversationId === conversationId && event.runId === runId)
        .flatMap((event) => {
          const portable = portableAgentEvent(event);
          return portable ? [portable] : [];
        });
      const entry = portableStreamCatalogEntry(identity, events);
      if (entry) streamsWithEvents.push({ entry, events });
    }

    const finalDeletionState = await this.deletionState();
    const visibleStreams = streamsWithEvents
      .filter(({ entry }) => !portableStreamIsDeleted(entry.identity, finalDeletionState))
      .sort((left, right) => comparePortableStreamIdentities(left.entry.identity, right.entry.identity));
    const payloads = portablePayloadCatalog(visibleStreams.flatMap(({ events }) => events));

    return {
      v: AGENT_PORTABLE_CATALOG_VERSION,
      streams: visibleStreams.map(({ entry }) => entry),
      payloads,
      tombstones: finalDeletionState.tombstones.map(cloneDeletionTombstone),
    };
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
    const write = async () => {
      const conversationId = conversationIdOfRun(normalized);
      if (conversationId) await this.assertConversationWritable(conversationId);
      await this.assertRunWritable(conversationId, normalized.id);
      const runPaths = this.runPaths(normalized.id);
      await mkdir(runPaths.runDir, { recursive: true });
      await atomicWriteFile(runPaths.runMetaPath, `${JSON.stringify(normalized)}\n`);
      await this.updateRunIndexes(normalized);
    };
    const conversationId = conversationIdOfRun(normalized);
    if (conversationId) {
      await this.agentEventLog.enqueue(conversationId, write);
    } else {
      await this.runEventLog.enqueue(runStreamLogKey(normalized.id), write);
    }
  }

  async readRunMetaProjection(runId: string): Promise<AgentRunMetaProjection | null> {
    await this.ensureStorageLayout();
    if (await this.isRunDeleted(runId)) return null;
    return this.readConsistentRunMeta(runId);
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
      const meta = await this.readConsistentRunMeta(runId);
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
    context: AgentDeletionContext,
  ): Promise<{ prunedRunIds: string[]; retainedRunIds: string[] }> {
    await this.ensureStorageLayout();
    const retainCount = Number.isFinite(retainRunCount) ? Math.max(0, Math.trunc(retainRunCount)) : 0;
    return this.agentEventLog.enqueue(conversationId, async () => {
      await this.assertConversationWritable(conversationId);
      const paths = this.paths(conversationId);
      const deletionState = await this.deletionState();
      const existing = await this.readRawConversationRunIndex(conversationId)
        ?? await this.rebuildConversationRunIndex(conversationId);
      const active = filterConversationRunIndex(existing, deletionState.runIds);
      const storedRunIds = new Set(await this.listStoredRunIds());
      const existingRunIds = new Set(existing.runIds);
      const retentionTombstonedRunIds = uniqueStrings(deletionState.tombstones.flatMap((tombstone) => (
        tombstone.entity.type === 'run'
        && tombstone.entity.conversationId === conversationId
        && tombstone.reason === 'retention_pruned'
          ? [tombstone.entity.runId]
          : []
      )));
      const pendingRetentionRunIds = retentionTombstonedRunIds.filter((runId) => (
        existingRunIds.has(runId) || storedRunIds.has(runId)
      ));
      const retainedRunIds = retainCount === 0 ? [] : active.runIds.slice(-retainCount);
      const retainedRunIdSet = new Set(retainedRunIds);
      const newlyPrunedRunIds = active.runIds.filter((runId) => !retainedRunIdSet.has(runId));
      const cleanupRunIdSet = new Set([...pendingRetentionRunIds, ...newlyPrunedRunIds]);
      const prunedRunIds = [
        ...existing.runIds.filter((runId) => cleanupRunIdSet.has(runId)),
        ...pendingRetentionRunIds.filter((runId) => !existingRunIds.has(runId)),
      ];
      if (prunedRunIds.length === 0) {
        return { prunedRunIds: [], retainedRunIds };
      }

      const prunedRunIdSet = new Set(prunedRunIds);
      const conversationEvents = await this.agentEventLog.readIfExists(paths.conversationEventsPath);
      const retainedRunEvents = await this.readRunEventsByRunId(active, retainedRunIds);
      const prunedRunEvents = await this.readRunEventsByRunId(existing, prunedRunIds);
      const prunedMessageIds = new Set<string>();
      for (const meta of await Promise.all(prunedRunIds.map((runId) => this.readStoredRunMeta(runId)))) {
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
          active.latestSeqByRunId[runId] ?? 0,
        ])),
        delegationRunIds: active.delegationRunIds.filter((runId) => retainedRunIdSet.has(runId)),
      };
      const retainedEvents = [
        ...retainedConversationEvents,
        ...retainedRunIds.flatMap((runId) => retainedRunEvents.get(runId) ?? []),
      ].sort(compareAgentEventsForReplay);
      const replayState = replayAgentEvents(retainedEvents);

      await this.appendDeletionTombstones(
        await Promise.all(prunedRunIds.map(async (runId): Promise<PendingAgentDeletion> => ({
          entity: { type: 'run', conversationId, runId },
          lastKnownEvent: await this.lastKnownEvent(this.runPaths(runId).runEventsPath, true),
        }))),
        context,
      );

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
    if (await this.isConversationDeleted(conversationId)) return null;
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
   * a fresh install — wiping empty event paths is harmless) or a parsed sentinel
   * from ANOTHER generation is positive proof, and event-log owned paths are
   * deleted and recreated lazily. Other agent stores may share the parent root,
   * so this clean-cut must never delete files it does not own. An
   * unreadable/corrupt sentinel is ambiguity, not proof — fail open to
   * operation (#180 invariants: content can never trip a wipe; probe errors
   * never brick the store).
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
      + `current v=${STORAGE_LAYOUT_VERSION}); wiping event-log owned paths`,
      undefined,
      {
        operation: 'cleanCutStorageLayout',
        currentVersion: STORAGE_LAYOUT_VERSION,
        ...(raw === null ? {} : { foundVersion: Number(parseJsonRecord(raw.trim())?.v ?? 0) }),
      },
      'agent-storage-layout-generation-changed',
    );
    await this.cleanCutEventStorePaths();
    this.agentEventLog.clear();
    this.runEventLog.clear();
    this.deletionLog.clear();
    this.deletionStatePromise = null;
    await mkdir(this.rootDir, { recursive: true });
    await atomicWriteFile(sentinelPath, `${JSON.stringify({ v: STORAGE_LAYOUT_VERSION })}\n`);
  }

  private async cleanCutEventStorePaths(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await Promise.all(EVENT_STORE_CLEAN_CUT_PATHS.map((name) => (
      rm(path.join(this.rootDir, name), { recursive: true, force: true })
    )));
  }

  private deletionState(): Promise<AgentDeletionState> {
    this.deletionStatePromise ??= this.deletionLog
      .readIfExists(path.join(this.rootDir, AGENT_DELETION_LOG_FILE))
      .then((tombstones) => {
        const state = emptyDeletionState();
        for (const tombstone of tombstones) applyDeletionTombstone(state, tombstone);
        this.deletionLog.setLatestSeq(AGENT_DELETION_LOG_KEY, tombstones.at(-1)?.seq ?? 0);
        return state;
      });
    return this.deletionStatePromise;
  }

  private async appendDeletionTombstones(
    pending: readonly PendingAgentDeletion[],
    context: AgentDeletionContext,
  ): Promise<AgentDeletionTombstone[]> {
    if (pending.length === 0) return [];
    return this.deletionLog.enqueue(AGENT_DELETION_LOG_KEY, async () => {
      const state = await this.deletionState();
      const unique = new Map<string, PendingAgentDeletion>();
      for (const item of pending) unique.set(deletionEntityKey(item.entity), item);
      const newItems = [...unique.values()].filter(({ entity }) => !deletionEntityIsDeleted(entity, state));
      if (newItems.length === 0) return [];

      const firstSeq = (state.tombstones.at(-1)?.seq ?? 0) + 1;
      const deletedAt = Date.now();
      const tombstones = newItems.map((item, index): AgentDeletionTombstone => ({
        v: AGENT_DELETION_VERSION,
        seq: firstSeq + index,
        deletionId: randomUUID(),
        entity: cloneDeletionEntity(item.entity),
        actor: cloneAgentActor(context.actor),
        reason: context.reason,
        deletedAt,
        lastKnownEvent: item.lastKnownEvent ? { ...item.lastKnownEvent } : null,
      }));
      await this.deletionLog.appendForKey(
        AGENT_DELETION_LOG_KEY,
        path.join(this.rootDir, AGENT_DELETION_LOG_FILE),
        tombstones,
      );
      for (const tombstone of tombstones) applyDeletionTombstone(state, tombstone);
      return tombstones.map(cloneDeletionTombstone);
    });
  }

  private async isConversationDeleted(conversationId: string): Promise<boolean> {
    return (await this.deletionState()).conversationIds.has(conversationId);
  }

  private async isRunDeleted(runId: string, conversationId?: string | null): Promise<boolean> {
    const state = await this.deletionState();
    return state.runIds.has(runId)
      || (typeof conversationId === 'string' && state.conversationIds.has(conversationId));
  }

  private async assertConversationWritable(conversationId: string): Promise<void> {
    if (await this.isConversationDeleted(conversationId)) {
      throw new Error(`Agent conversation ${conversationId} was deleted`);
    }
  }

  private async assertRunWritable(conversationId: string | null, runId: string): Promise<void> {
    if (await this.isRunDeleted(runId, conversationId)) {
      throw new Error(`Agent run ${runId} was deleted`);
    }
  }

  private async removeRunWriteIfDeleted(conversationId: string, runId: string): Promise<void> {
    const state = await this.deletionState();
    if (!state.runIds.has(runId) && !state.conversationIds.has(conversationId)) return;
    if (!state.runIds.has(runId)) {
      const conversationDeletion = [...state.tombstones].reverse().find((tombstone) => (
        tombstone.entity.type === 'conversation'
        && tombstone.entity.conversationId === conversationId
      ));
      if (conversationDeletion) {
        await this.appendDeletionTombstones([{
          entity: { type: 'run', conversationId, runId },
          lastKnownEvent: await this.lastKnownEvent(this.runPaths(runId).runEventsPath, true),
        }], {
          actor: conversationDeletion.actor,
          reason: conversationDeletion.reason,
        });
      }
    }
    try {
      await rm(this.runPaths(runId).runDir, { recursive: true, force: true });
    } finally {
      // This method runs inside the Run's queue. Preserve the queue entry while
      // clearing only its stale physical-tail cache.
      this.runEventLog.setLatestSeq(runStreamLogKey(runId), 0);
    }
    throw new Error(`Agent run ${runId} was deleted`);
  }

  private async lastKnownEvent(filePath: string, tolerantRunTail = false): Promise<AgentEventIdentity | null> {
    const tail = await (tolerantRunTail ? this.runEventLog : this.agentEventLog).latestTailForFiles([filePath]);
    return tail.seq > 0 && tail.eventId ? { seq: tail.seq, eventId: tail.eventId } : null;
  }

  private async runIdsForConversationDeletion(conversationId: string): Promise<string[]> {
    const state = await this.deletionState();
    const indexedRunIds = await this.listRunIdsForConversation(conversationId);
    const storedRunIds: string[] = [];
    for (const runId of await this.listStoredRunIds()) {
      try {
        const meta = normalizeRunMeta(JSON.parse(await readFile(this.runPaths(runId).runMetaPath, 'utf8')));
        if (meta && conversationIdOfRun(meta) === conversationId) storedRunIds.push(runId);
      } catch (error) {
        if (!isNotFoundError(error) && !(error instanceof SyntaxError)) throw error;
      }
    }
    return [...new Set([
      ...indexedRunIds,
      ...storedRunIds,
      ...(state.runIdsByConversationId.get(conversationId) ?? []),
    ])].sort((left, right) => left.localeCompare(right));
  }

  private async removeConversationStorage(conversationId: string, runIds: readonly string[]): Promise<void> {
    await Promise.all([
      rm(this.paths(conversationId).conversationDir, { recursive: true, force: true }),
      ...runIds.map((runId) => rm(this.runPaths(runId).runDir, { recursive: true, force: true })),
    ]);
    // Keep the active per-conversation queue entry intact until this queued
    // deletion/reset operation settles; only its persisted-tail cache resets.
    this.agentEventLog.setLatestSeq(conversationId, 0);
    for (const runId of runIds) {
      this.agentEventLog.deleteKey(runStreamLogKey(runId));
      this.runEventLog.deleteKey(runStreamLogKey(runId));
    }
    await this.removeConversationFromIndex(conversationId);
    await this.removeConversationFromSearchIndex(conversationId);
  }

  private async listStoredRunIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.paths('__placeholder__').runsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => decodeAgentRunDirName(entry.name))
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
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
    if (await this.isConversationDeleted(conversationId)) return emptyConversationRunIndex();
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
    if (await this.isConversationDeleted(conversationId)) return false;
    try {
      await readdir(this.paths(conversationId).conversationDir);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  }

  private async rebuildConversationRunIndex(conversationId: string): Promise<AgentConversationRunIndex> {
    if (await this.isConversationDeleted(conversationId)) return emptyConversationRunIndex();
    const paths = this.paths(conversationId);
    const latestSeqByRunId: Record<string, number> = {};
    const delegationRunIds: string[] = [];
    const deletionState = await this.deletionState();
    try {
      const entries = await readdir(paths.runsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(paths.runsDir, entry.name);
        try {
          const meta = normalizeRunMeta(JSON.parse(await readFile(path.join(runDir, RUN_META_FILE), 'utf8')));
          if (!meta || conversationIdOfRun(meta) !== conversationId) continue;
          if (deletionState.runIds.has(meta.id)) continue;
          latestSeqByRunId[meta.id] = Math.max(latestSeqByRunId[meta.id] ?? 0, meta.latestSeq);
          if (deriveAgentRunKind(meta) === 'delegation') delegationRunIds.push(meta.id);
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
    const deletionState = await this.deletionState();
    try {
      const entries = await readdir(paths.runsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(paths.runsDir, entry.name);
        try {
          const meta = normalizeRunMeta(JSON.parse(await readFile(path.join(runDir, RUN_META_FILE), 'utf8')));
          if (!meta || meta.anchor.type !== 'principal' || !samePrincipal(meta.anchor.principal, principal)) continue;
          if (deletionState.runIds.has(meta.id)) continue;
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
    const principalPaths = this.principalPaths(principal);
    await mkdir(principalPaths.principalDir, { recursive: true });
    await atomicWriteFile(principalPaths.runIndexPath, `${JSON.stringify(index)}\n`);
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
    if (await this.isRunDeleted(runId)) return null;
    const meta = await this.readStoredRunMeta(runId);
    const conversationId = meta ? conversationIdOfRun(meta) : null;
    return meta && !await this.isRunDeleted(runId, conversationId) ? meta : null;
  }

  private async readStoredRunMeta(runId: string): Promise<AgentRunMetaProjection | null> {
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
    if (await this.isConversationDeleted(conversationId)) return emptyConversationRunIndex();
    const index = await this.readRawConversationRunIndex(conversationId);
    return index ? filterConversationRunIndex(index, (await this.deletionState()).runIds) : null;
  }

  private async readRawConversationRunIndex(conversationId: string): Promise<AgentConversationRunIndex | null> {
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
      const raw = await readFile(this.principalPaths(principal).runIndexPath, 'utf8');
      const index = normalizePrincipalRunIndex(JSON.parse(raw), principalKey(principal));
      if (!index) return null;
      return filterPrincipalRunIndex(index, (await this.deletionState()).runIds);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async updateRunIndexes(meta: AgentRunMetaProjection) {
    const conversationId = conversationIdOfRun(meta);
    if (await this.isRunDeleted(meta.id, conversationId)) return;
    if (conversationId) {
      await this.updateConversationRunIndex(conversationId, meta);
    }
    if (meta.anchor.type === 'principal') {
      await this.updatePrincipalRunIndex(meta.anchor.principal, meta.id, meta.updatedAt);
    }
  }

  // Both run indexes are read-modify-write on a shared file reached from TWO
  // serial queues (the per-run ledger queue and the per-conversation event
  // queue), so the merge itself must serialize on `indexQueue` — otherwise a
  // delegated Run append racing a parent conversation append writes back a stale
  // runIds list and permanently drops a finished run from the index (cold
  // replay then silently misses that run's events; the index only self-heals
  // on a missing FILE, not a missing entry).
  private async updateConversationRunIndex(conversationId: string, meta: AgentRunMetaProjection) {
    if (await this.isConversationDeleted(conversationId) || await this.isRunDeleted(meta.id, conversationId)) return;
    await this.enqueueIndexWrite(async () => {
      const paths = this.paths(conversationId);
      const existing = await this.ensureConversationRunIndex(conversationId);
      const runIds = existing.runIds.includes(meta.id) ? existing.runIds : [...existing.runIds, meta.id];
      const delegationRunIds = deriveAgentRunKind(meta) === 'delegation'
        ? (existing.delegationRunIds.includes(meta.id) ? existing.delegationRunIds : [...existing.delegationRunIds, meta.id])
        : existing.delegationRunIds.filter((id) => id !== meta.id);
      const index: AgentConversationRunIndex = {
        v: 2,
        runIds,
        latestSeqByRunId: {
          ...existing.latestSeqByRunId,
          [meta.id]: Math.max(existing.latestSeqByRunId[meta.id] ?? 0, meta.latestSeq),
        },
        delegationRunIds,
      };
      await mkdir(paths.conversationDir, { recursive: true });
      await atomicWriteFile(paths.conversationRunIndexPath, `${JSON.stringify(index)}\n`);
    });
  }

  private async updatePrincipalRunIndex(principal: AgentPrincipal, runId: string, updatedAt: number) {
    if (await this.isRunDeleted(runId)) return;
    await this.enqueueIndexWrite(async () => {
      const principalPaths = this.principalPaths(principal);
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
      await mkdir(principalPaths.principalDir, { recursive: true });
      await atomicWriteFile(principalPaths.runIndexPath, `${JSON.stringify(index)}\n`);
    });
  }

  private async readConsistentRunMeta(runId: string): Promise<AgentRunMetaProjection | null> {
    if (await this.isRunDeleted(runId)) return null;
    const runPaths = this.runPaths(runId);
    return this.runEventLog.enqueue(runStreamLogKey(runId), async () => {
      if (await this.isRunDeleted(runId)) return null;
      const existing = await this.readRunMeta(runId);
      const latestLedgerSeq = await this.runEventLog.latestSeq(
        runStreamLogKey(runId),
        () => [runPaths.runEventsPath],
      );
      if (existing && latestLedgerSeq <= existing.latestSeq) return existing;
      const events = await this.runEventLog.readIfExists(runPaths.runEventsPath);
      const metaEvents = events.filter((event) => !isStreamingDeltaEvent(event));
      const latestMetaEvent = metaEvents.at(-1);
      if (!latestMetaEvent || (existing && latestMetaEvent.seq <= existing.latestSeq)) return existing;
      const conversationId = latestMetaEvent.conversationId;
      if (await this.isRunDeleted(runId, conversationId)) return null;
      const rebuilt = await this.updateRunMeta(conversationId, runId, metaEvents, null);
      if (rebuilt) await this.updateRunIndexes(rebuilt);
      return rebuilt;
    });
  }

  private async updateRunMeta(
    conversationId: string,
    runId: string,
    events: readonly AgentEvent[],
    existingOverride?: AgentRunMetaProjection | null,
  ): Promise<AgentRunMetaProjection | null> {
    if (await this.isRunDeleted(runId, conversationId)) return null;
    const existing = existingOverride === undefined ? await this.readRunMeta(runId) : existingOverride;
    const latest = events.at(-1);
    if (!latest) return null;
    const started = events.find((event) => event.type === 'run.started');
    const agentId = asAgentId(existing?.agentId ?? (started?.type === 'run.started' ? started.agentId ?? (started.anchor ? agentIdOfRunAnchor(started.anchor) : undefined) : undefined) ?? agentIdFromEvents(events) ?? 'built-in:tenon:assistant')!;
    const anchor = existing?.anchor ?? (started?.type === 'run.started' ? normalizeRunAnchor(started.anchor, agentId) : null) ?? conversationRunAnchor(agentId, conversationId);
    const trigger = existing?.trigger ?? (started?.type === 'run.started' ? started.trigger : undefined);
    const parentRunId = existing?.parentRunId ?? (trigger?.type === 'parent-run' ? trigger.parentRunId : undefined);
    const parentToolCallId = existing?.parentToolCallId ?? (started?.type === 'run.started' && typeof started.parentToolCallId === 'string' ? started.parentToolCallId : undefined);
    const context = existing?.context ?? (started?.type === 'run.started' ? normalizeRunContextPolicy(started.context) : undefined) ?? 'full';
    const runProfile = existing?.runProfile ?? (started?.type === 'run.started' ? normalizeRunProfileId(started.runProfile) : undefined) ?? runProfileFromStartedRun(started, anchor);
    let executionStatus = existing?.execution.status;
    let completedAt = existing?.execution.completedAt;
    let usage = existing?.execution.usage;
    let executionError = existing?.execution.error;
    let objectiveText = existing?.objective?.text;
    let criteria = existing?.objective?.criteria?.slice();
    let objectiveRole = existing?.objective?.role;
    let objectiveStatus = existing?.objective?.status;
    let budget = existing?.objective?.budget;
    let blockedReason = existing?.objective?.blockedReason;
    let latestVerifierGap = existing?.objective?.latestVerifierGap;
    let latestSubmissionSeq = existing?.objective?.latestSubmissionSeq;
    const verificationAttemptBase = existing?.objective?.verificationAttemptBase
      ?? (started?.type === 'run.started' ? started.verificationAttemptBase : undefined);
    let verifierGapSignatures = existing?.objective?.verifierGapSignatures?.slice()
      ?? (started?.type === 'run.started' ? started.verifierGapSignatures?.slice() : undefined);
    for (const event of events) {
      if (event.type === 'run.started') {
        assertValidRunExecutionStatusTransition(executionStatus, 'running', runId);
        executionStatus = 'running';
        completedAt = undefined;
        executionError = undefined;
        usage = undefined;
      } else if (isRunTerminalEvent(event)) {
        const nextStatus = runStatusFromTerminalEvent(event);
        assertValidRunExecutionStatusTransition(executionStatus, nextStatus, runId);
        executionStatus = nextStatus;
        completedAt = event.createdAt;
        usage = event.usage ?? usage;
        executionError = event.type === 'run.failed' || event.type === 'run.cancelled'
          ? event.errorMessage
          : undefined;
      } else if (isRunResultSubmittedEvent(event)) {
        latestSubmissionSeq = event.seq;
      }
      if ((event.type === 'run.started' || isRunTerminalEvent(event)) && event.objectiveStatus) {
        assertValidRunObjectiveStatusTransition(objectiveStatus, event.objectiveStatus, runId);
        objectiveStatus = event.objectiveStatus;
      }
      if (event.type === 'run.started' || isRunTerminalEvent(event)) {
        if (event.objective !== undefined) objectiveText = event.objective;
        if (event.criteria !== undefined) criteria = event.criteria.slice();
        if (event.objectiveRole !== undefined) objectiveRole = event.objectiveRole;
        budget = event.budget ?? budget;
        blockedReason = event.objectiveStatus === 'active'
          || event.objectiveStatus === 'verifying'
          || event.objectiveStatus === 'verified'
          ? event.blockedReason
          : event.blockedReason ?? blockedReason;
        latestVerifierGap = event.objectiveStatus === 'active'
          || event.objectiveStatus === 'verifying'
          || event.objectiveStatus === 'verified'
          ? event.latestVerifierGap
          : event.latestVerifierGap ?? latestVerifierGap;
        if (event.verifierGapSignatures !== undefined) {
          verifierGapSignatures = event.verifierGapSignatures.slice();
        } else if (event.objectiveStatus === 'verified') {
          verifierGapSignatures = [];
        }
        latestSubmissionSeq = typeof event.latestSubmissionSeq === 'number'
          ? event.latestSubmissionSeq
          : event.type === 'run.started'
            ? undefined
            : latestSubmissionSeq;
      }
    }
    executionStatus ??= 'running';
    objectiveText ??= started?.type === 'run.started' ? started.objective : undefined;
    criteria ??= started?.type === 'run.started' ? started.criteria?.slice() : undefined;
    objectiveRole ??= started?.type === 'run.started' ? started.objectiveRole : undefined;
    objectiveRole ??= objectiveRoleForRun(started, parentRunId);
    const scope = existing?.objective?.scope ?? (started?.type === 'run.started' ? started.scope : undefined);
    const verificationRequired = existing?.objective?.verificationRequired
      ?? (started?.type === 'run.started' ? started.verificationRequired : undefined);
    const objective = objectiveText || criteria?.length || objectiveStatus || verificationRequired
      || verificationAttemptBase !== undefined || verifierGapSignatures !== undefined
      || scope || budget || blockedReason || latestVerifierGap || typeof latestSubmissionSeq === 'number'
      ? {
          text: objectiveText ?? '',
          criteria: criteria?.slice() ?? [],
          role: objectiveRole,
          status: objectiveStatus ?? 'active',
          ...(verificationRequired ? { verificationRequired } : {}),
          ...(verificationAttemptBase !== undefined ? { verificationAttemptBase } : {}),
          ...(verifierGapSignatures !== undefined ? { verifierGapSignatures } : {}),
          ...(scope ? { scope } : {}),
          ...(budget ? { budget } : {}),
          ...(blockedReason ? { blockedReason } : {}),
          ...(latestVerifierGap ? { latestVerifierGap } : {}),
          ...(typeof latestSubmissionSeq === 'number' ? { latestSubmissionSeq } : {}),
        }
      : undefined;
    const meta: AgentRunMetaProjection = {
      v: 2,
      id: runId,
      agentId,
      anchor,
      // The parent side of the run tree: a delegated run's trigger names the
      // run that spawned it ({type:'parent-run'}), and the meta mirrors it so
      // `runs WHERE parentRunId=X` is answerable from metas alone.
      parentRunId,
      parentToolCallId,
      disposition: existing?.disposition ?? (started?.type === 'run.started' ? normalizeRunDisposition(started.disposition, started) : undefined) ?? 'attended',
      context,
      runProfile,
      trigger: trigger ?? { type: 'manual' },
      fingerprint: existing?.fingerprint ?? (started?.type === 'run.started' ? started.fingerprint : undefined) ?? emptyRunFingerprint(),
      retention: existing?.retention ?? (started?.type === 'run.started' ? started.retention : undefined) ?? 'hot',
      createdAt: existing?.createdAt ?? started?.createdAt ?? events[0]!.createdAt,
      updatedAt: latest.createdAt,
      latestSeq: latest.seq,
      execution: {
        status: executionStatus,
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(usage ? { usage } : {}),
        ...(executionError ? { error: executionError } : {}),
      },
      ...(objective ? { objective } : {}),
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
    if (await this.isConversationDeleted(conversationId)) return null;
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
    if (await this.isConversationDeleted(conversationId)) return;
    await this.enqueueIndexWrite(async () => {
      const index = await this.readConversationIndex() ?? createEmptyConversationIndex();
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
      const index = await this.readConversationIndex() ?? createEmptyConversationIndex();
      delete index.conversations[conversationId];
      await this.writeConversationIndex(index);
    });
  }

  private async rebuildConversationIndex(): Promise<AgentConversationIndexEntry[]> {
    const index = await this.buildConversationIndexFromEventLogs();
    await this.writeConversationIndex(index);
    return Object.values(index.conversations).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async buildConversationIndexFromEventLogs(): Promise<AgentConversationIndex> {
    const ids = await this.listConversationIds();
    const entries: AgentConversationIndexEntry[] = [];
    for (const id of ids) {
      const state = await this.replay(id);
      const entry = conversationIndexEntryFromReplayState(id, state);
      if (entry) entries.push(entry);
    }
    const conversations = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    return createEmptyConversationIndex(conversations);
  }

  private async getSearchIndex(): Promise<AgentEventSearchIndex> {
    return await this.readSearchIndex() ?? await this.rebuildSearchIndex();
  }

  private async updateSearchIndex(_conversationId: string, events: readonly AgentEvent[]) {
    if (await this.isConversationDeleted(_conversationId)) return;
    await this.enqueueIndexWrite(async () => {
      const index = await this.readSearchIndex();
      if (!index) {
        await this.writeSearchIndex(await this.buildSearchIndexFromEventLogs());
        return;
      }
      for (const event of events) applyAgentEventToSearchIndex(index, event);
      await this.writeSearchIndex(index);
    });
  }

  private async removeConversationFromSearchIndex(conversationId: string) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readSearchIndex();
      if (!index) {
        await this.writeSearchIndex(await this.buildSearchIndexFromEventLogs());
        return;
      }
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
      const conversationIndex = await this.readConversationIndex() ?? createEmptyConversationIndex();
      const conversationEntry = conversationIndexEntryFromReplayState(conversationId, state);
      if (conversationEntry) {
        conversationIndex.conversations[conversationId] = conversationEntry;
      } else {
        delete conversationIndex.conversations[conversationId];
      }
      await this.writeConversationIndex(conversationIndex);

      const searchIndex = await this.readSearchIndex();
      if (searchIndex) {
        removeConversationEntriesFromSearchIndex(searchIndex, conversationId);
        for (const event of events) applyAgentEventToSearchIndex(searchIndex, event);
        await this.writeSearchIndex(searchIndex);
      } else {
        await this.writeSearchIndex(await this.buildSearchIndexFromEventLogs());
      }
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
    if (await this.isConversationDeleted(conversationId)) return null;
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

  private async readConversationIndex(): Promise<AgentConversationIndex | null> {
    const indexPath = this.conversationIndexPath();
    try {
      const raw = await readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (
        !isRecord(parsed)
        || parsed.v !== CONVERSATION_INDEX_VERSION
        || typeof parsed.deletionSeq !== 'number'
        || !Number.isSafeInteger(parsed.deletionSeq)
        || parsed.deletionSeq < 0
        || !isRecord(parsed.conversations)
      ) return null;
      const deletionState = await this.deletionState();
      const deletionSeq = deletionLedgerTailSeq(deletionState);
      if (parsed.deletionSeq !== deletionSeq) return null;
      const conversations = {
        ...(parsed.conversations as Record<string, AgentConversationIndexEntry>),
      };
      for (const conversationId of deletionState.conversationIds) delete conversations[conversationId];
      return {
        v: CONVERSATION_INDEX_VERSION,
        deletionSeq,
        conversations,
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw new Error(`Invalid agent conversation index at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async conversationIndexMatchesConversations(index: AgentConversationIndex): Promise<boolean> {
    const indexedIds = new Set(Object.keys(index.conversations));
    const conversationIds = new Set(await this.listConversationIds());
    if (indexedIds.size !== conversationIds.size) return false;
    for (const id of indexedIds) {
      if (!conversationIds.has(id)) return false;
      if (!conversationIndexEntryHasCurrentShape(index.conversations[id])) return false;
    }
    return true;
  }

  private async writeConversationIndex(index: AgentConversationIndex) {
    const indexPath = this.conversationIndexPath();
    const deletionSeq = deletionLedgerTailSeq(await this.deletionState());
    await mkdir(path.dirname(indexPath), { recursive: true });
    await atomicWriteFile(indexPath, `${JSON.stringify({
      ...index,
      v: CONVERSATION_INDEX_VERSION,
      deletionSeq,
    })}\n`);
  }

  private async readSearchIndex(): Promise<AgentEventSearchIndex | null> {
    const indexPath = this.searchIndexPath();
    try {
      const raw = await readFile(indexPath, 'utf8');
      const index = normalizeSearchIndex(JSON.parse(raw));
      if (!index) return null;
      const deletionState = await this.deletionState();
      if (index.deletionSeq !== deletionLedgerTailSeq(deletionState)) return null;
      for (const conversationId of deletionState.conversationIds) {
        removeConversationEntriesFromSearchIndex(index, conversationId);
      }
      return index;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw new Error(`Invalid agent search index at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeSearchIndex(index: AgentEventSearchIndex) {
    const indexPath = this.searchIndexPath();
    const deletionSeq = deletionLedgerTailSeq(await this.deletionState());
    await mkdir(path.dirname(indexPath), { recursive: true });
    await atomicWriteFile(indexPath, `${JSON.stringify({
      ...index,
      v: SEARCH_INDEX_VERSION,
      deletionSeq,
    })}\n`);
  }
}

function createEmptyConversationIndex(
  conversations: Record<string, AgentConversationIndexEntry> = {},
): AgentConversationIndex {
  return {
    v: CONVERSATION_INDEX_VERSION,
    deletionSeq: 0,
    conversations,
  };
}

function deletionLedgerTailSeq(state: AgentDeletionState): number {
  return state.tombstones.at(-1)?.seq ?? 0;
}

function emptyConversationRunIndex(): AgentConversationRunIndex {
  return { v: 2, runIds: [], latestSeqByRunId: {}, delegationRunIds: [] };
}

function filterConversationRunIndex(
  index: AgentConversationRunIndex,
  deletedRunIds: ReadonlySet<string>,
): AgentConversationRunIndex {
  const runIds = index.runIds.filter((runId) => !deletedRunIds.has(runId));
  const runIdSet = new Set(runIds);
  return {
    v: 2,
    runIds,
    latestSeqByRunId: Object.fromEntries(runIds.map((runId) => [runId, index.latestSeqByRunId[runId] ?? 0])),
    delegationRunIds: index.delegationRunIds.filter((runId) => runIdSet.has(runId)),
  };
}

function filterPrincipalRunIndex(
  index: AgentPrincipalRunIndex,
  deletedRunIds: ReadonlySet<string>,
): AgentPrincipalRunIndex {
  const runIds = index.runIds.filter((runId) => !deletedRunIds.has(runId));
  return {
    v: 1,
    principalKey: index.principalKey,
    runIds,
    updatedAtByRunId: Object.fromEntries(runIds.map((runId) => [runId, index.updatedAtByRunId[runId] ?? 0])),
  };
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
    deletionSeq: 0,
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
  if (
    typeof value.deletionSeq !== 'number'
    || !Number.isSafeInteger(value.deletionSeq)
    || value.deletionSeq < 0
  ) return null;
  if (!isRecord(value.messages) || !isRecord(value.userMessages)) return null;
  const latestSeqByConversationId = isRecord(value.latestSeqByConversationId)
    ? value.latestSeqByConversationId as Record<string, number>
    : {};
  return {
    v: SEARCH_INDEX_VERSION,
    deletionSeq: value.deletionSeq,
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

function isDelegationRunId(runId: string): boolean {
  return runId.startsWith('child-');
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

function runIdsReferencedByEvents(events: readonly AgentEvent[]): string[] {
  const runIds = new Set<string>();
  for (const event of events) {
    const eventRunId = agentRunIdForEvent(event);
    if (eventRunId) runIds.add(eventRunId);
    if (
      (event.type === 'payload.created' || event.type === 'payload.derived')
      && event.payload.scope?.type === 'run'
    ) {
      runIds.add(event.payload.scope.runId);
    }
  }
  return [...runIds].sort((left, right) => left.localeCompare(right));
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
  if (event.type === 'context.cleared') {
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
    case 'context.cleared':
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

function isRunResultSubmittedEvent(event: AgentEvent): event is Extract<AgentEvent, { type: 'run.result.submitted' }> {
  return event.type === 'run.result.submitted';
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
  if (!isRecord(value) || value.v !== 2) return null;
  if (typeof value.agentId !== 'string') return null;
  if (typeof value.id !== 'string') return null;
  const anchor = normalizeRunAnchor(value.anchor, value.agentId) ?? (
    typeof value.conversationId === 'string'
      ? conversationRunAnchor(value.agentId, value.conversationId)
      : null
  );
  if (!anchor) return null;
  if (!isAgentRunRetention(value.retention)) return null;
  if (!isRecord(value.trigger) || typeof value.trigger.type !== 'string') return null;
  if (!isRecord(value.fingerprint)) return null;
  const execution = normalizeRunExecution(value.execution);
  if (!execution) return null;
  const context = normalizeRunContextPolicy(value.context) ?? 'full';
  const runProfile = normalizeRunProfileId(value.runProfile) ?? 'default';
  const objective = normalizeRunObjective(value.objective);
  const createdAt = numberOrNull(value.createdAt);
  const updatedAt = numberOrNull(value.updatedAt);
  const latestSeq = numberOrNull(value.latestSeq);
  if (createdAt === null || updatedAt === null || latestSeq === null) return null;
  return {
    v: 2,
    id: value.id,
    agentId: asAgentId(value.agentId)!,
    anchor,
    parentRunId: typeof value.parentRunId === 'string' ? value.parentRunId : undefined,
    parentToolCallId: typeof value.parentToolCallId === 'string' ? value.parentToolCallId : undefined,
    disposition: normalizeRunDisposition(value.disposition, value),
    context,
    runProfile,
    trigger: value.trigger as AgentRunTrigger,
    fingerprint: value.fingerprint as unknown as AgentRunFingerprint,
    retention: value.retention,
    createdAt,
    updatedAt,
    latestSeq,
    execution,
    ...(objective ? { objective } : {}),
  };
}

function normalizeRunExecution(value: unknown): AgentRunMetaProjection['execution'] | null {
  if (!isRecord(value) || !isAgentRunStatus(value.status)) return null;
  const completedAt = numberOrNull(value.completedAt);
  return {
    status: value.status,
    ...(completedAt !== null ? { completedAt } : {}),
    ...(isRecord(value.usage) ? { usage: value.usage as unknown as Usage } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

function normalizeRunObjective(value: unknown): AgentRunMetaProjection['objective'] | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.text !== 'string') return undefined;
  const role = normalizeRunObjectiveRole(value.role);
  if (!role || !isAgentObjectiveStatus(value.status)) return undefined;
  const latestSubmissionSeq = numberOrNull(value.latestSubmissionSeq);
  const verificationAttemptBase = numberOrNull(value.verificationAttemptBase);
  return {
    text: value.text,
    criteria: Array.isArray(value.criteria) ? uniqueStrings(value.criteria.filter((item): item is string => typeof item === 'string')) : [],
    role,
    status: value.status,
    ...(value.verificationRequired === true ? { verificationRequired: true } : {}),
    ...(verificationAttemptBase !== null && verificationAttemptBase >= 0
      ? { verificationAttemptBase: Math.trunc(verificationAttemptBase) }
      : {}),
    ...(Array.isArray(value.verifierGapSignatures)
      ? { verifierGapSignatures: value.verifierGapSignatures.filter((item): item is string => typeof item === 'string') }
      : {}),
    scope: normalizeAgentRunScope(value.scope),
    budget: normalizeAgentRunBudget(value.budget),
    ...(typeof value.blockedReason === 'string' ? { blockedReason: value.blockedReason } : {}),
    ...(typeof value.latestVerifierGap === 'string' ? { latestVerifierGap: value.latestVerifierGap } : {}),
    ...(latestSubmissionSeq !== null ? { latestSubmissionSeq } : {}),
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

function normalizeRunDisposition(value: unknown, legacy?: unknown): AgentRunDisposition {
  if (value === 'attended' || value === 'detached') return value;
  const legacyKind = isRecord(legacy) ? legacy.kind : undefined;
  return legacyKind === 'background' || legacyKind === 'scheduled' || legacyKind === 'reflective'
    ? 'detached'
    : 'attended';
}

function normalizeRunContextPolicy(value: unknown): AgentRunContextPolicy | undefined {
  if (value === 'full' || value === 'brief' || value === 'none') return value;
  return undefined;
}

function normalizeRunProfileId(value: unknown): AgentRunProfileId | undefined {
  return isRunProfileId(value) ? value : undefined;
}

function normalizeRunObjectiveRole(value: unknown): AgentRunObjectiveRole | undefined {
  return value === 'controller' || value === 'worker' || value === 'verifier' ? value : undefined;
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled';
}

function isAgentObjectiveStatus(value: unknown): value is AgentObjectiveStatus {
  return value === 'active'
    || value === 'verifying'
    || value === 'verified'
    || value === 'blocked'
    || value === 'budget_exhausted'
    || value === 'stopped';
}

function isAgentRunPurpose(value: unknown): value is AgentRunPurpose {
  return value === 'work' || value === 'verify';
}

function normalizeAgentRunScope(value: unknown): AgentRunScope | undefined {
  if (!isRecord(value)) return undefined;
  const capabilities = Array.isArray(value.capabilities)
    ? uniqueStrings(value.capabilities.filter((item): item is string => typeof item === 'string'))
    : undefined;
  const rawResources = isRecord(value.resources) ? value.resources : null;
  const docs = normalizeStoredResourceArray(rawResources, 'docs');
  const paths = normalizeStoredResourceArray(rawResources, 'paths');
  const nodes = normalizeStoredResourceArray(rawResources, 'nodes');
  const writableNodes = normalizeStoredResourceArray(rawResources, 'writableNodes');
  const creatableNodeParents = normalizeStoredResourceArray(rawResources, 'creatableNodeParents');
  const compactResources = docs !== undefined
    || paths !== undefined
    || nodes !== undefined
    || writableNodes !== undefined
    || creatableNodeParents !== undefined
    ? {
        ...(docs !== undefined ? { docs } : {}),
        ...(paths !== undefined ? { paths } : {}),
        ...(nodes !== undefined ? { nodes } : {}),
        ...(writableNodes !== undefined ? { writableNodes } : {}),
        ...(creatableNodeParents !== undefined ? { creatableNodeParents } : {}),
      }
    : undefined;
  return capabilities?.length || compactResources
    ? { capabilities, resources: compactResources }
    : undefined;
}

function normalizeStoredResourceArray(
  resources: Record<string, unknown> | null,
  key: string,
): string[] | undefined {
  if (!resources || !Object.prototype.hasOwnProperty.call(resources, key)) return undefined;
  return Array.isArray(resources[key])
    ? uniqueStrings(resources[key].filter((item): item is string => typeof item === 'string'))
    : undefined;
}

function normalizeAgentRunBudget(value: unknown): AgentRunBudget | undefined {
  if (!isRecord(value)) return undefined;
  const budget: AgentRunBudget = {};
  for (const key of ['tokens', 'wallClockMinutes', 'reservedTokens', 'spentTokens', 'startedAt', 'deadlineAt'] as const) {
    const numeric = numberOrNull(value[key]);
    if (numeric !== null) budget[key] = numeric;
  }
  return Object.keys(budget).length ? budget : undefined;
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
 * with a warning instead of failing the read (same policy as other high-write
 * sidecars:
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
  if (!isRecord(state.compactionsByMessageId)) return null;
  if (!isRecord(state.contextClearsByMessageId)) return null;
  if (!isRecord(state.dreamsByMessageId) || !isRecord(state.userQuestions)) return null;
  if (!isRecord(state.folderCapabilityRequests)) return null;
  if (!isRecord(state.notifications) || !isRecord(state.attentionByConversationId)) return null;
  if (state.selectedLeafMessageId !== null && typeof state.selectedLeafMessageId !== 'string') return null;
  if (state.latestMessageId !== null && typeof state.latestMessageId !== 'string') return null;
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
