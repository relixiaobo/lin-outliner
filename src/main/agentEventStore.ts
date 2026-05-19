import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, appendFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentEvent,
  AgentEventMessageRole,
  AgentEventReplayState,
  AgentPersistedContent,
  AgentPayloadDisplayMetadata,
  AgentPayloadRef,
  AgentPayloadRole,
} from '../core/agentEventLog';
import { appendAgentEventToReplayState, replayAgentEvents } from '../core/agentEventLog';

const EVENT_LOG_FILE = 'events.jsonl';
const SESSION_INDEX_FILE = 'session-index.json';
const SEARCH_INDEX_FILE = 'search-index.json';
const CHECKPOINT_VERSION = 1;
const SEARCH_INDEX_VERSION = 1;
const DEFAULT_CHECKPOINT_EVENT_INTERVAL = 100;
const MAX_CHECKPOINTS_PER_SESSION = 3;
const READ_TAIL_CHUNK_SIZE = 64 * 1024;
const MAX_SEARCH_INDEX_TEXT_CHARS = 20_000;
const SEARCH_INDEX_PREVIEW_CHARS = 240;

export interface AgentPayloadWriteInput {
  id?: string;
  data: Buffer | Uint8Array | string;
  encoding?: BufferEncoding;
  mimeType: string;
  role?: AgentPayloadRole;
  summary?: string;
  truncated?: boolean;
  display?: AgentPayloadDisplayMetadata;
}

export interface AgentEventStorePaths {
  rootDir: string;
  sessionsDir: string;
  indexesDir: string;
  sessionDir: string;
  eventsPath: string;
  payloadsDir: string;
  checkpointsDir: string;
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
  eventFileByteOffset: number;
  createdAt: number;
  state: AgentEventReplayState;
}

interface AgentEventFileTail {
  seq: number;
  eventId: string | null;
  byteOffset: number;
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
    const sessionsDir = path.join(this.rootDir, 'sessions');
    const sessionDir = path.join(sessionsDir, agentSessionDirName(sessionId));
    return {
      rootDir: this.rootDir,
      sessionsDir,
      indexesDir: path.join(this.rootDir, 'indexes'),
      sessionDir,
      eventsPath: path.join(sessionDir, EVENT_LOG_FILE),
      payloadsDir: path.join(sessionDir, 'payloads'),
      checkpointsDir: path.join(sessionDir, 'checkpoints'),
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

      const paths = this.paths(sessionId);
      await mkdir(paths.sessionDir, { recursive: true });
      await appendFile(paths.eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
      this.lastSeqBySessionId.set(sessionId, events.at(-1)!.seq);
      await this.updateSessionIndex(sessionId, events);
      await this.updateSearchIndex(sessionId, events);
    });
  }

  async readEvents(sessionId: string): Promise<AgentEvent[]> {
    const eventsPath = this.paths(sessionId).eventsPath;
    let raw = '';
    try {
      raw = await readFile(eventsPath, 'utf8');
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }

    return parseEventsJsonl(raw, eventsPath);
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
      const paths = this.paths(sessionId);
      const checkpoint: AgentEventCheckpoint = {
        v: CHECKPOINT_VERSION,
        sessionId,
        seq: state.latestSeq,
        latestEventId: state.latestEventId,
        eventFileByteOffset: tail.byteOffset,
        createdAt: Date.now(),
        state: cloneReplayState(state),
      };
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
      role: input.role,
      summary: input.summary,
      truncated: input.truncated,
      display: input.display,
    };

    const paths = this.paths(sessionId);
    await mkdir(paths.payloadsDir, { recursive: true });
    await writeFile(this.payloadPath(sessionId, payload), bytes);
    return payload;
  }

  async readPayload(sessionId: string, payload: AgentPayloadRef): Promise<Buffer> {
    return readFile(this.payloadPath(sessionId, payload));
  }

  payloadPath(sessionId: string, payload: Pick<AgentPayloadRef, 'id' | 'mimeType'>): string {
    return path.join(this.paths(sessionId).payloadsDir, agentPayloadFileName(payload.id, payload.mimeType));
  }

  async deleteSession(sessionId: string): Promise<void> {
    await rm(this.paths(sessionId).sessionDir, { recursive: true, force: true });
    this.lastSeqBySessionId.delete(sessionId);
    this.writeQueues.delete(sessionId);
    await this.removeSessionFromIndex(sessionId);
    await this.removeSessionFromSearchIndex(sessionId);
  }

  async listSessionIds(): Promise<string[]> {
    const sessionsDir = path.join(this.rootDir, 'sessions');
    try {
      const entries = await readdir(sessionsDir, { withFileTypes: true });
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

  async searchMessages(
    query: string,
    options: { sessionId?: string; limit?: number } = {},
  ): Promise<AgentEventSearchIndexEntry[]> {
    const terms = normalizeSearchTerms(query);
    if (terms.length === 0) return [];
    const index = await this.getSearchIndex();
    return Object.values(index.messages)
      .filter((entry) => !options.sessionId || entry.sessionId === options.sessionId)
      .filter((entry) => terms.every((term) => entry.normalizedText.includes(term)))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, clampSearchLimit(options.limit));
  }

  checkpointPath(sessionId: string, seq: number): string {
    return path.join(this.paths(sessionId).checkpointsDir, agentCheckpointFileName(seq));
  }

  private async replayFromCheckpoint(sessionId: string): Promise<AgentEventReplayState | null> {
    const checkpoint = await this.readLatestCheckpoint(sessionId);
    if (!checkpoint) return null;
    try {
      const eventStats = await stat(this.paths(sessionId).eventsPath);
      if (checkpoint.eventFileByteOffset > eventStats.size) return null;
      const tailRaw = await readUtf8FileFromOffset(this.paths(sessionId).eventsPath, checkpoint.eventFileByteOffset);
      const tailEvents = parseEventsJsonl(tailRaw, `${this.paths(sessionId).eventsPath}@${checkpoint.eventFileByteOffset}`);
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
    const eventsPath = this.paths(sessionId).eventsPath;
    try {
      const [eventStats, lastLine] = await Promise.all([
        stat(eventsPath),
        readLastNonEmptyLine(eventsPath),
      ]);
      if (!lastLine) return { seq: 0, eventId: null, byteOffset: eventStats.size };
      const parsed = JSON.parse(lastLine) as Partial<AgentEvent>;
      return {
        seq: typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) ? parsed.seq : 0,
        eventId: typeof parsed.eventId === 'string' ? parsed.eventId : null,
        byteOffset: eventStats.size,
      };
    } catch (error) {
      if (isNotFoundError(error)) return { seq: 0, eventId: null, byteOffset: 0 };
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
    await atomicWriteFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
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
    await atomicWriteFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
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

  if (event.type === 'tool_result.created') {
    const content = indexDetailsFromContent([
      ...event.content,
      { type: 'text', text: event.outputSummary },
    ]);
    const outputPayloadIds = event.outputRef ? [event.outputRef.id] : [];
    index.messages[searchIndexKey(event.sessionId, event.messageId)] = {
      sessionId: event.sessionId,
      messageId: event.messageId,
      role: 'toolResult',
      parentMessageId: event.parentMessageId,
      createdAt: event.createdAt,
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
  return uniqueStrings(normalizeIndexText(query).split(/\s+/).filter(Boolean)).slice(0, 12);
}

function normalizeIndexText(text: string): string {
  return normalizeDisplayText(text).normalize('NFKC').toLocaleLowerCase();
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

export function agentSessionDirName(sessionId: string): string {
  return encodeURIComponent(sessionId).replace(/\./g, '%2E');
}

export function decodeAgentSessionDirName(dirName: string): string {
  return decodeURIComponent(dirName);
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

async function readLastNonEmptyLine(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat();
    let position = stats.size;
    let text = '';
    while (position > 0) {
      const chunkSize = Math.min(READ_TAIL_CHUNK_SIZE, position);
      position -= chunkSize;
      const buffer = Buffer.alloc(chunkSize);
      await handle.read(buffer, 0, chunkSize, position);
      text = `${buffer.toString('utf8')}${text}`;
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      if (lines.length > 0 && (position === 0 || text.startsWith('\n') || text.startsWith('\r'))) {
        return lines.at(-1) ?? null;
      }
      if (lines.length > 1) return lines.at(-1) ?? null;
    }
    return text.trim() ? text.trim() : null;
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readUtf8FileFromOffset(filePath: string, offset: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat();
    if (offset < 0 || offset > stats.size) {
      throw new Error(`Invalid agent event checkpoint byte offset ${offset} for ${filePath}`);
    }
    const length = stats.size - offset;
    if (length === 0) return '';
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString('utf8');
  } finally {
    await handle?.close();
  }
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
  const eventFileByteOffset = typeof value.eventFileByteOffset === 'number'
    && Number.isSafeInteger(value.eventFileByteOffset)
    ? value.eventFileByteOffset
    : null;
  if (eventFileByteOffset === null || eventFileByteOffset < 0) return null;
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
  if (!Array.isArray(state.rootMessageIds)) return null;
  if (!isRecord(state.childrenByParentId) || !isRecord(state.derivedPayloadsBySourceId)) return null;

  return {
    v: CHECKPOINT_VERSION,
    sessionId,
    seq,
    latestEventId,
    eventFileByteOffset,
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
