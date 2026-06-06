import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, appendFile, rename, rm, writeFile } from 'node:fs/promises';
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
  AgentRunFingerprint,
  AgentRunKind,
  AgentRunRetention,
  AgentRunStatus,
  AgentIdentityRecord,
  AgentRunTrigger,
} from '../core/agentEventLog';
import { appendAgentEventToReplayState, replayAgentEvents } from '../core/agentEventLog';
import {
  analyzeTextSearchQuery,
  normalizeSearchText,
  textSearchTextMatchesQuery,
} from '../core/textSearchAnalyzer';

const CONVERSATION_SEGMENT_FILE = '000001.jsonl';
const RUN_EVENT_LOG_FILE = 'events.jsonl';
const RUN_META_FILE = 'meta.json';
const AGENT_IDENTITY_FILE = 'identity.json';
const SESSION_INDEX_FILE = 'session-index.json';
const SEARCH_INDEX_FILE = 'search-index.json';
const CHECKPOINT_VERSION = 2;
const SEARCH_INDEX_VERSION = 1;
const DEFAULT_CHECKPOINT_EVENT_INTERVAL = 100;
const MAX_CHECKPOINTS_PER_SESSION = 3;
const MAX_SEARCH_INDEX_TEXT_CHARS = 20_000;
const SEARCH_INDEX_PREVIEW_CHARS = 240;

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

export interface AgentRunMetaProjection {
  v: 1;
  id: string;
  agentId: string;
  conversationId: string;
  parentRunId?: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  trigger: AgentRunTrigger;
  usage?: Usage;
  fingerprint: AgentRunFingerprint;
  retention: AgentRunRetention;
  createdAt: number;
  updatedAt: number;
  latestSeq: number;
}

export interface AgentConversationMetaProjection extends AgentConversationMeta {
  v: 1;
  title: string | null;
  updatedAt: number;
  latestSeq: number;
}

export interface AgentEventSessionIndexEntry {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  latestSeq: number;
}

export interface AgentEventCheckpoint {
  v: typeof CHECKPOINT_VERSION;
  sessionId: string;
  seq: number;
  latestEventId: string | null;
  createdAt: number;
  state: AgentEventReplayState;
}

interface AgentEventFileTail {
  seq: number;
  eventId: string | null;
}

export interface AgentEventSearchIndexEntry {
  sessionId: string;
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
  latestSeqBySessionId: Record<string, number>;
}

export class AgentEventStore {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private indexQueue = Promise.resolve();
  private readonly lastSeqBySessionId = new Map<string, number>();

  constructor(private readonly rootDir: string) {}

  paths(sessionId: string): AgentEventStorePaths {
    const conversationsDir = path.join(this.rootDir, 'conversations');
    const conversationDir = path.join(conversationsDir, agentSessionDirName(sessionId));
    const conversationSegmentsDir = path.join(conversationDir, 'segments');
    return {
      rootDir: this.rootDir,
      indexesDir: path.join(this.rootDir, 'indexes'),
      agentsDir: path.join(this.rootDir, 'agents'),
      conversationsDir,
      conversationDir,
      conversationMetaPath: path.join(conversationDir, 'meta.json'),
      conversationCursorsPath: path.join(conversationDir, 'cursors.json'),
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

  agentPaths(agentId: string): { agentDir: string; identityPath: string; memoryEventsPath: string } {
    const agentDir = path.join(this.rootDir, 'agents', agentIdentityDirName(agentId));
    return {
      agentDir,
      identityPath: path.join(agentDir, AGENT_IDENTITY_FILE),
      memoryEventsPath: path.join(agentDir, 'memory', RUN_EVENT_LOG_FILE),
    };
  }

  async appendEvents(sessionId: string, events: readonly AgentEvent[]): Promise<void> {
    if (events.length === 0) return;
    this.assertEventBatch(sessionId, events);
    await this.enqueueSessionWrite(sessionId, async () => {
      const latestSeq = await this.getLatestSeq(sessionId);
      const firstSeq = events[0]!.seq;
      if (firstSeq <= latestSeq) {
        throw new Error(`Agent event seq ${firstSeq} is not after existing seq ${latestSeq}`);
      }

      await this.appendSplitEvents(sessionId, events);
      this.lastSeqBySessionId.set(sessionId, events.at(-1)!.seq);
      // Streaming assistant deltas carry no index content: the session/search
      // indexes derive assistant text from assistant_message.completed, and a
      // delta only nudges latestSeq/updatedAt (cosmetic ordering, self-healed by
      // the completed/run events that follow). Skipping the whole-file index
      // rewrite for delta-only batches avoids re-reading + re-serializing both
      // index files on every streamed token. The events.jsonl append above is
      // the source of truth and still happens per delta.
      if (events.some((event) => event.type !== 'assistant_message.delta')) {
        await this.updateSessionIndex(sessionId, events);
        await this.updateSearchIndex(sessionId, events);
      }
    });
  }

  async readEvents(sessionId: string): Promise<AgentEvent[]> {
    const paths = this.paths(sessionId);
    const events = [
      ...await readEventsJsonlIfExists(paths.conversationEventsPath),
      ...await this.readRunEventsForSession(sessionId),
    ];
    return events.sort(compareAgentEventsForReplay);
  }

  async replay(sessionId: string): Promise<AgentEventReplayState> {
    const checkpointed = await this.replayFromCheckpoint(sessionId);
    if (checkpointed) return checkpointed;
    return replayAgentEvents(await this.readEvents(sessionId));
  }

  async writeCheckpoint(sessionId: string, state: AgentEventReplayState): Promise<AgentEventCheckpoint | null> {
    if (!state.session || state.session.id !== sessionId || state.latestSeq <= 0) return null;
    return this.enqueueSessionWrite(sessionId, async () => {
      const tail = await this.readEventFileTail(sessionId);
      if (tail.seq !== state.latestSeq || tail.eventId !== state.latestEventId) return null;
      const checkpoint: AgentEventCheckpoint = {
        v: CHECKPOINT_VERSION,
        sessionId,
        seq: state.latestSeq,
        latestEventId: state.latestEventId,
        createdAt: Date.now(),
        state: cloneReplayState(state),
      };
      const paths = this.paths(sessionId);
      await mkdir(paths.checkpointsDir, { recursive: true });
      await atomicWriteFile(this.checkpointPath(sessionId, checkpoint.seq), `${JSON.stringify(checkpoint)}\n`);
      await this.pruneCheckpoints(sessionId).catch(() => undefined);
      return checkpoint;
    });
  }

  async maybeWriteCheckpoint(
    sessionId: string,
    state: AgentEventReplayState,
    options: { minEventDelta?: number; force?: boolean } = {},
  ): Promise<AgentEventCheckpoint | null> {
    if (!state.session || state.session.id !== sessionId || state.latestSeq <= 0) return null;
    const latest = await this.readLatestCheckpoint(sessionId);
    const minEventDelta = options.minEventDelta ?? DEFAULT_CHECKPOINT_EVENT_INTERVAL;
    if (!options.force && latest && state.latestSeq - latest.seq < minEventDelta) return null;
    return this.writeCheckpoint(sessionId, state);
  }

  async writePayload(sessionId: string, input: AgentPayloadWriteInput): Promise<AgentPayloadRef> {
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
        ? { type: 'run', conversationId: sessionId, runId: input.runId }
        : { type: 'conversation', conversationId: sessionId },
      role: input.role,
      summary: input.summary,
      truncated: input.truncated,
      display: input.display,
    };

    const payloadDir = input.runId ? this.runPaths(input.runId).payloadsDir : this.paths(sessionId).conversationPayloadsDir;
    await mkdir(payloadDir, { recursive: true });
    await writeFile(this.payloadPath(sessionId, payload), bytes);
    return payload;
  }

  async readPayload(sessionId: string, payload: AgentPayloadRef): Promise<Buffer> {
    return readFile(this.payloadPath(sessionId, payload));
  }

  payloadPath(
    sessionId: string,
    payload: Pick<AgentPayloadRef, 'id' | 'mimeType'> & Partial<Pick<AgentPayloadRef, 'scope'>>,
  ): string {
    const scope = payload.scope;
    const payloadDir = scope?.type === 'run'
      ? this.runPaths(scope.runId).payloadsDir
      : this.paths(sessionId).conversationPayloadsDir;
    return path.join(payloadDir, agentPayloadFileName(payload.id, payload.mimeType));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await rm(this.paths(sessionId).conversationDir, { recursive: true, force: true });
    await Promise.all((await this.listRunIdsForSession(sessionId)).map((runId) => (
      rm(this.runPaths(runId).runDir, { recursive: true, force: true })
    )));
    this.lastSeqBySessionId.delete(sessionId);
    this.writeQueues.delete(sessionId);
    await this.removeSessionFromIndex(sessionId);
    await this.removeSessionFromSearchIndex(sessionId);
  }

  async listSessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.paths('__placeholder__').conversationsDir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => decodeAgentSessionDirName(entry.name));
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async listSessionIndexEntries(): Promise<AgentEventSessionIndexEntry[]> {
    const index = await this.readSessionIndex();
    if (index) {
      return Object.values(index.sessions).sort((left, right) => right.updatedAt - left.updatedAt);
    }
    return this.rebuildSessionIndex();
  }

  async listUserMessageIndexEntries(sessionId?: string): Promise<AgentEventUserMessageIndexEntry[]> {
    const index = await this.getSearchIndex();
    return Object.values(index.userMessages)
      .filter((entry) => !sessionId || entry.sessionId === sessionId)
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async listMessageIndexEntries(): Promise<AgentEventSearchIndexEntry[]> {
    const index = await this.getSearchIndex();
    return Object.values(index.messages)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async findMessageIndexEntry(messageId: string): Promise<AgentEventSearchIndexEntry | null> {
    const index = await this.getSearchIndex();
    return Object.values(index.messages)
      .filter((entry) => entry.messageId === messageId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async searchMessages(
    query: string,
    options: { sessionId?: string; limit?: number } = {},
  ): Promise<AgentEventSearchIndexEntry[]> {
    const terms = normalizeSearchTerms(query);
    if (terms.length === 0) return [];
    const analysis = { ...analyzeTextSearchQuery(query), terms };
    const index = await this.getSearchIndex();
    return Object.values(index.messages)
      .filter((entry) => !options.sessionId || entry.sessionId === options.sessionId)
      .filter((entry) => textSearchTextMatchesQuery(entry.normalizedText, analysis))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, clampSearchLimit(options.limit));
  }

  checkpointPath(sessionId: string, seq: number): string {
    return path.join(this.paths(sessionId).checkpointsDir, agentCheckpointFileName(seq));
  }

  async writeAgentIdentity(identity: AgentIdentityRecord): Promise<void> {
    const paths = this.agentPaths(identity.agentId);
    await mkdir(paths.agentDir, { recursive: true });
    await atomicWriteFile(paths.identityPath, `${JSON.stringify({ v: 1, ...identity })}\n`);
  }

  async readAgentIdentity(agentId: string): Promise<AgentIdentityRecord | null> {
    const paths = this.agentPaths(agentId);
    try {
      const raw = await readFile(paths.identityPath, 'utf8');
      return normalizeAgentIdentity(JSON.parse(raw));
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  private async replayFromCheckpoint(sessionId: string): Promise<AgentEventReplayState | null> {
    const checkpoint = await this.readLatestCheckpoint(sessionId);
    if (!checkpoint) return null;
    try {
      const tailEvents = (await this.readEvents(sessionId)).filter((event) => event.seq > checkpoint.seq);
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

  private async getLatestSeq(sessionId: string): Promise<number> {
    const cached = this.lastSeqBySessionId.get(sessionId);
    if (cached !== undefined) return cached;

    const { seq } = await this.readEventFileTail(sessionId);
    this.lastSeqBySessionId.set(sessionId, seq);
    return seq;
  }

  private assertEventBatch(sessionId: string, events: readonly AgentEvent[]) {
    let previousSeq = 0;
    const eventIds = new Set<string>();
    for (const event of events) {
      if (event.sessionId !== sessionId) {
        throw new Error(`Agent event session mismatch: ${event.sessionId}`);
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

  private enqueueSessionWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const current = this.writeQueues.get(sessionId) ?? Promise.resolve();
    const next = current.then(operation, operation);
    this.writeQueues.set(sessionId, next.then(() => undefined, () => undefined));
    return next;
  }

  private async readEventFileTail(sessionId: string): Promise<AgentEventFileTail> {
    const latest = (await this.readEvents(sessionId)).at(-1);
    return {
      seq: latest?.seq ?? 0,
      eventId: latest?.eventId ?? null,
    };
  }

  private async appendSplitEvents(sessionId: string, events: readonly AgentEvent[]): Promise<void> {
    const paths = this.paths(sessionId);
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
      await mkdir(paths.conversationSegmentsDir, { recursive: true });
      await appendFile(paths.conversationEventsPath, serializeEventsJsonl(conversationEvents), 'utf8');
    } else {
      await mkdir(paths.conversationDir, { recursive: true });
    }

    for (const [runId, group] of runEvents) {
      const runPaths = this.runPaths(runId);
      await mkdir(runPaths.runDir, { recursive: true });
      await appendFile(runPaths.runEventsPath, serializeEventsJsonl(group), 'utf8');
      await this.updateRunMeta(sessionId, runId, group);
    }

    await this.updateConversationMeta(sessionId, events);
  }

  private async readRunEventsForSession(sessionId: string): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for (const runId of await this.listRunIdsForSession(sessionId)) {
      events.push(...await readEventsJsonlIfExists(this.runPaths(runId).runEventsPath));
    }
    return events;
  }

  private async listRunIdsForSession(sessionId: string): Promise<string[]> {
    const runsDir = this.paths(sessionId).runsDir;
    let entries: Array<{ name: string; isDirectory(): boolean }> = [];
    try {
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = decodeAgentRunDirName(entry.name);
      const meta = await this.readRunMeta(runId);
      if (meta?.conversationId === sessionId) ids.push(runId);
    }
    return ids;
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

  private async updateRunMeta(sessionId: string, runId: string, events: readonly AgentEvent[]) {
    const existing = await this.readRunMeta(runId);
    const latest = events.at(-1);
    if (!latest) return;
    const terminal = [...events].reverse().find(isRunTerminalEvent);
    const started = events.find((event) => event.type === 'run.started');
    const meta: AgentRunMetaProjection = {
      v: 1,
      id: runId,
      agentId: existing?.agentId ?? (started?.type === 'run.started' ? started.agentId : undefined) ?? agentIdFromEvents(events) ?? 'built-in:tenon:assistant',
      conversationId: sessionId,
      parentRunId: existing?.parentRunId,
      kind: existing?.kind ?? (started?.type === 'run.started' ? started.kind : undefined) ?? 'turn',
      status: terminal ? runStatusFromTerminalEvent(terminal) : existing?.status ?? 'running',
      trigger: existing?.trigger ?? (started?.type === 'run.started' ? started.trigger : undefined) ?? { type: 'manual' },
      usage: terminal?.type === 'run.completed' ? terminal.usage : existing?.usage,
      fingerprint: existing?.fingerprint ?? (started?.type === 'run.started' ? started.fingerprint : undefined) ?? emptyRunFingerprint(),
      retention: existing?.retention ?? (started?.type === 'run.started' ? started.retention : undefined) ?? 'hot',
      createdAt: existing?.createdAt ?? started?.createdAt ?? events[0]!.createdAt,
      updatedAt: latest.createdAt,
      latestSeq: latest.seq,
    };
    const runPaths = this.runPaths(runId);
    await mkdir(runPaths.runDir, { recursive: true });
    await atomicWriteFile(runPaths.runMetaPath, `${JSON.stringify(meta)}\n`);
  }

  private async updateConversationMeta(sessionId: string, events: readonly AgentEvent[]) {
    const paths = this.paths(sessionId);
    const existing = await this.readConversationMeta(sessionId);
    const created = events.find((event) => event.type === 'session.created');
    const renamed = [...events].reverse().find((event) => event.type === 'session.renamed');
    const latest = events.at(-1);
    if (!created && !renamed && !latest) return;
    const members = mergePrincipals(existing?.members ?? [], events.flatMap(principalsFromEvent));
    const meta: AgentConversationMetaProjection = {
      v: 1,
      id: sessionId,
      members,
      createdAt: existing?.createdAt ?? created?.createdAt ?? latest!.createdAt,
      title: renamed?.title ?? created?.title ?? existing?.title ?? null,
      name: renamed?.title ?? created?.title ?? existing?.name,
      updatedAt: Math.max(existing?.updatedAt ?? 0, latest?.createdAt ?? 0),
      latestSeq: Math.max(existing?.latestSeq ?? 0, latest?.seq ?? 0),
    };
    await mkdir(paths.conversationDir, { recursive: true });
    await atomicWriteFile(paths.conversationMetaPath, `${JSON.stringify(meta)}\n`);
  }

  private async readConversationMeta(sessionId: string): Promise<AgentConversationMetaProjection | null> {
    try {
      const raw = await readFile(this.paths(sessionId).conversationMetaPath, 'utf8');
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

  private async updateSessionIndex(sessionId: string, events: readonly AgentEvent[]) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readSessionIndex() ?? { sessions: {} };
      let entry: AgentEventSessionIndexEntry | null = index.sessions[sessionId] ?? null;
      for (const event of events) {
        if (event.type === 'session.created') {
          entry = {
            id: sessionId,
            title: event.title,
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
            messageCount: entry?.messageCount ?? 0,
            latestSeq: event.seq,
          };
        } else if (entry) {
          entry = updateSessionIndexEntry(entry, event);
        }
      }
      if (!entry) entry = sessionIndexEntryFromReplayState(sessionId, await this.replay(sessionId));
      if (entry) index.sessions[sessionId] = entry;
      await this.writeSessionIndex(index);
    });
  }

  private async removeSessionFromIndex(sessionId: string) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readSessionIndex();
      if (!index || !index.sessions[sessionId]) return;
      delete index.sessions[sessionId];
      await this.writeSessionIndex(index);
    });
  }

  private async rebuildSessionIndex(): Promise<AgentEventSessionIndexEntry[]> {
    const ids = await this.listSessionIds();
    const entries: AgentEventSessionIndexEntry[] = [];
    for (const id of ids) {
      const state = await this.replay(id);
      const entry = sessionIndexEntryFromReplayState(id, state);
      if (entry) entries.push(entry);
    }
    const sessions = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    await this.writeSessionIndex({ sessions });
    return entries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private async getSearchIndex(): Promise<AgentEventSearchIndex> {
    return await this.readSearchIndex() ?? await this.rebuildSearchIndex();
  }

  private async updateSearchIndex(_sessionId: string, events: readonly AgentEvent[]) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readSearchIndex() ?? await this.buildSearchIndexFromEventLogs();
      for (const event of events) applyAgentEventToSearchIndex(index, event);
      await this.writeSearchIndex(index);
    });
  }

  private async removeSessionFromSearchIndex(sessionId: string) {
    await this.enqueueIndexWrite(async () => {
      const index = await this.readSearchIndex();
      if (!index) return;
      for (const [key, entry] of Object.entries(index.messages)) {
        if (entry.sessionId === sessionId) delete index.messages[key];
      }
      for (const [key, entry] of Object.entries(index.userMessages)) {
        if (entry.sessionId === sessionId) delete index.userMessages[key];
      }
      delete index.latestSeqBySessionId[sessionId];
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
    const ids = await this.listSessionIds();
    for (const id of ids) {
      for (const event of await this.readEvents(id)) {
        applyAgentEventToSearchIndex(index, event);
      }
    }
    return index;
  }

  private async readLatestCheckpoint(sessionId: string): Promise<AgentEventCheckpoint | null> {
    const paths = this.paths(sessionId);
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
        const checkpoint = normalizeCheckpoint(JSON.parse(raw), sessionId);
        if (!checkpoint) continue;
        return checkpoint;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async pruneCheckpoints(sessionId: string) {
    const paths = this.paths(sessionId);
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
        if (normalizeCheckpoint(JSON.parse(raw), sessionId)) valid.push({ name, seq });
        else stale.push(name);
      } catch {
        stale.push(name);
      }
    }

    valid.sort((left, right) => right.seq - left.seq);
    stale.push(...valid.slice(MAX_CHECKPOINTS_PER_SESSION).map((entry) => entry.name));
    await Promise.all(stale.map(async (name) => {
      try {
        await rm(path.join(paths.checkpointsDir, name), { force: true });
      } catch {
        // Checkpoints are derived caches. A failed cleanup must not block chat restore.
      }
    }));
  }

  private sessionIndexPath(): string {
    return path.join(this.rootDir, 'indexes', SESSION_INDEX_FILE);
  }

  private searchIndexPath(): string {
    return path.join(this.rootDir, 'indexes', SEARCH_INDEX_FILE);
  }

  private async readSessionIndex(): Promise<{ sessions: Record<string, AgentEventSessionIndexEntry> } | null> {
    const indexPath = this.sessionIndexPath();
    try {
      const raw = await readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw) as { sessions?: unknown };
      return {
        sessions: isRecord(parsed.sessions) ? parsed.sessions as Record<string, AgentEventSessionIndexEntry> : {},
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      if (error instanceof SyntaxError) return null;
      throw new Error(`Invalid agent session index at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async writeSessionIndex(index: { sessions: Record<string, AgentEventSessionIndexEntry> }) {
    const indexPath = this.sessionIndexPath();
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

function updateSessionIndexEntry(
  entry: AgentEventSessionIndexEntry,
  event: AgentEvent,
): AgentEventSessionIndexEntry {
  const next: AgentEventSessionIndexEntry = {
    ...entry,
    updatedAt: Math.max(entry.updatedAt, event.createdAt),
    latestSeq: Math.max(entry.latestSeq, event.seq),
  };
  if (event.type === 'session.renamed') {
    next.title = event.title;
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

function sessionIndexEntryFromReplayState(
  sessionId: string,
  state: AgentEventReplayState,
): AgentEventSessionIndexEntry | null {
  if (!state.session) return null;
  return {
    id: sessionId,
    title: state.session.title,
    createdAt: state.session.createdAt,
    updatedAt: state.session.updatedAt,
    messageCount: Object.keys(state.messages).length,
    latestSeq: state.latestSeq,
  };
}

function createEmptySearchIndex(): AgentEventSearchIndex {
  return {
    v: SEARCH_INDEX_VERSION,
    messages: {},
    userMessages: {},
    latestSeqBySessionId: {},
  };
}

function applyAgentEventToSearchIndex(index: AgentEventSearchIndex, event: AgentEvent) {
  index.latestSeqBySessionId[event.sessionId] = Math.max(
    index.latestSeqBySessionId[event.sessionId] ?? 0,
    event.seq,
  );

  if (event.type === 'user_message.created') {
    const content = indexDetailsFromContent(event.content);
    const payloadIds = uniqueStrings([
      ...content.payloadIds,
      ...(event.attachments ?? []).map((payload) => payload.id),
    ]);
    const entry: AgentEventUserMessageIndexEntry = {
      sessionId: event.sessionId,
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
    const key = searchIndexKey(event.sessionId, event.messageId);
    index.messages[key] = entry;
    index.userMessages[key] = entry;
    return;
  }

  if (event.type === 'user_message.edited') {
    const key = searchIndexKey(event.sessionId, event.messageId);
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
    const key = searchIndexKey(event.sessionId, event.messageId);
    index.messages[key] ??= {
      sessionId: event.sessionId,
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
    const key = searchIndexKey(event.sessionId, event.messageId);
    const current = index.messages[key];
    const content = indexDetailsFromContent(event.content);
    index.messages[key] = {
      sessionId: event.sessionId,
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
    const key = searchIndexKey(event.sessionId, event.messageId);
    const current = index.messages[key];
    const content = indexDetailsFromContent([
      ...event.content,
      { type: 'text', text: event.outputSummary },
    ]);
    const outputPayloadIds = event.outputRef ? [event.outputRef.id] : [];
    index.messages[key] = {
      sessionId: event.sessionId,
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
  const latestSeqBySessionId = isRecord(value.latestSeqBySessionId)
    ? value.latestSeqBySessionId as Record<string, number>
    : {};
  return {
    v: SEARCH_INDEX_VERSION,
    messages: value.messages as Record<string, AgentEventSearchIndexEntry>,
    userMessages: value.userMessages as Record<string, AgentEventUserMessageIndexEntry>,
    latestSeqBySessionId,
  };
}

function searchIndexKey(sessionId: string, messageId: string): string {
  return `${encodeURIComponent(sessionId)}:${encodeURIComponent(messageId)}`;
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

function serializeEventsJsonl(events: readonly AgentEvent[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

async function readEventsJsonlIfExists(filePath: string): Promise<AgentEvent[]> {
  try {
    return parseEventsJsonl(await readFile(filePath, 'utf8'), filePath);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
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
    case 'run.started':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
    case 'assistant_message.started':
    case 'assistant_message.delta':
    case 'assistant_message.completed':
    case 'assistant_message.failed':
    case 'thinking.delta':
    case 'tool_call.started':
    case 'tool_call.delta':
    case 'tool_call.completed':
    case 'tool_call.failed':
    case 'tool_result.created':
    case 'tool_result.replaced':
    case 'tool.permission.checked':
    case 'tool.permission.resolved':
    case 'approval.requested':
    case 'approval.resolved':
    case 'user_question.requested':
    case 'user_question.answered':
    case 'user_question.cancelled':
    case 'widget_state.updated':
    case 'debug.snapshot.created':
    case 'subagent_run.started':
    case 'subagent_run.updated':
    case 'metric.recorded':
      return true;
    case 'payload.created':
    case 'payload.derived':
      return agentRunIdForEvent(event) !== null;
    default:
      return false;
  }
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

function principalsFromEvent(event: AgentEvent): AgentPrincipal[] {
  if (event.actor.type === 'user') return [{ type: 'user', userId: event.actor.userId }];
  if (event.actor.type === 'agent') return [{ type: 'agent', agentId: event.actor.agentId }];
  return [];
}

function mergePrincipals(current: readonly AgentPrincipal[], next: readonly AgentPrincipal[]): AgentPrincipal[] {
  const byKey = new Map<string, AgentPrincipal>();
  for (const principal of [...current, ...next]) byKey.set(principalKey(principal), principal);
  return [...byKey.values()].sort((left, right) => principalKey(left).localeCompare(principalKey(right)));
}

function principalKey(principal: AgentPrincipal): string {
  return principal.type === 'user' ? `user:${principal.userId}` : `agent:${principal.agentId}`;
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

function normalizeRunMeta(value: unknown): AgentRunMetaProjection | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (typeof value.id !== 'string' || typeof value.conversationId !== 'string') return null;
  if (typeof value.agentId !== 'string') return null;
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
    agentId: value.agentId,
    conversationId: value.conversationId,
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

function isAgentRunKind(value: unknown): value is AgentRunKind {
  return value === 'turn' || value === 'background' || value === 'subagent' || value === 'scheduled';
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

export function agentSessionDirName(sessionId: string): string {
  return encodeURIComponent(sessionId).replace(/\./g, '%2E');
}

export function decodeAgentSessionDirName(dirName: string): string {
  return decodeURIComponent(dirName);
}

export function agentRunDirName(runId: string): string {
  return encodeURIComponent(runId).replace(/\./g, '%2E');
}

export function decodeAgentRunDirName(dirName: string): string {
  return decodeURIComponent(dirName);
}

export function agentIdentityDirName(agentId: string): string {
  return encodeURIComponent(agentId).replace(/\./g, '%2E');
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

function normalizeCheckpoint(value: unknown, sessionId: string): AgentEventCheckpoint | null {
  if (!isRecord(value)) return null;
  if (value.v !== CHECKPOINT_VERSION) return null;
  if (value.sessionId !== sessionId) return null;
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
  if (!isRecord(state.session) || state.session.id !== sessionId) return null;
  if (!isRecord(state.messages) || !isRecord(state.payloads) || !isRecord(state.runs)) return null;
  if (!isRecord(state.subagents) || !isRecord(state.compactionsByMessageId)) return null;
  if (!Array.isArray(state.rootMessageIds)) return null;
  if (!isRecord(state.childrenByParentId) || !isRecord(state.derivedPayloadsBySourceId)) return null;

  return {
    v: CHECKPOINT_VERSION,
    sessionId,
    seq,
    latestEventId,
    createdAt,
    state: value.state as unknown as AgentEventReplayState,
  };
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
