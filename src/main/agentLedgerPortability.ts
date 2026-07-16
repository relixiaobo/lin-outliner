import type {
  AgentActor,
  AgentEvent,
  AgentPayloadRef,
  AgentPayloadRole,
} from '../core/agentEventLog';

export const AGENT_DELETION_LOG_FILE = 'deletions.jsonl';
export const AGENT_DELETION_VERSION = 1;
export const AGENT_PORTABLE_CATALOG_VERSION = 1;

export type AgentDeletionReason =
  | 'conversation_deleted'
  | 'conversation_reset'
  | 'retention_pruned';

export interface AgentDeletionContext {
  actor: AgentActor;
  reason: AgentDeletionReason;
}

export type AgentDeletionEntity =
  | { type: 'conversation'; conversationId: string }
  | { type: 'run'; conversationId: string; runId: string };

export interface AgentEventIdentity {
  seq: number;
  eventId: string;
}

export interface AgentDeletionTombstone {
  v: typeof AGENT_DELETION_VERSION;
  seq: number;
  deletionId: string;
  entity: AgentDeletionEntity;
  actor: AgentActor;
  reason: AgentDeletionReason;
  deletedAt: number;
  lastKnownEvent: AgentEventIdentity | null;
}

export type AgentPortableStreamIdentity =
  | { type: 'conversation'; conversationId: string }
  | { type: 'run'; conversationId: string; runId: string };

export interface AgentPortableStreamCatalogEntry {
  identity: AgentPortableStreamIdentity;
  eventCount: number;
  firstEvent: AgentEventIdentity;
  lastEvent: AgentEventIdentity;
}

export type AgentPortablePayloadRole = Extract<
  AgentPayloadRole,
  'source' | 'preview' | 'text_extract' | 'tool_output'
>;

export interface AgentPortablePayloadCatalogEntry {
  kind: 'payload_ref';
  id: string;
  storage: 'file';
  mimeType: string;
  byteLength: number;
  sha256: string;
  scope: NonNullable<AgentPayloadRef['scope']>;
  role: AgentPortablePayloadRole;
}

export interface AgentPortableCatalog {
  v: typeof AGENT_PORTABLE_CATALOG_VERSION;
  streams: AgentPortableStreamCatalogEntry[];
  payloads: AgentPortablePayloadCatalogEntry[];
  tombstones: AgentDeletionTombstone[];
}

export interface AgentDeletionState {
  tombstones: AgentDeletionTombstone[];
  conversationIds: Set<string>;
  runIds: Set<string>;
  runIdsByConversationId: Map<string, Set<string>>;
}

const OMIT_PORTABLE_VALUE = Symbol('omit-portable-value');

export function emptyDeletionState(): AgentDeletionState {
  return {
    tombstones: [],
    conversationIds: new Set(),
    runIds: new Set(),
    runIdsByConversationId: new Map(),
  };
}

export function applyDeletionTombstone(
  state: AgentDeletionState,
  tombstone: AgentDeletionTombstone,
): void {
  state.tombstones.push(tombstone);
  if (tombstone.entity.type === 'conversation') {
    state.conversationIds.add(tombstone.entity.conversationId);
    return;
  }
  state.runIds.add(tombstone.entity.runId);
  const runIds = state.runIdsByConversationId.get(tombstone.entity.conversationId) ?? new Set<string>();
  runIds.add(tombstone.entity.runId);
  state.runIdsByConversationId.set(tombstone.entity.conversationId, runIds);
}

export function deletionEntityKey(entity: AgentDeletionEntity): string {
  return entity.type === 'conversation'
    ? `conversation:${entity.conversationId}`
    : `run:${entity.runId}`;
}

export function deletionEntityIsDeleted(
  entity: AgentDeletionEntity,
  state: AgentDeletionState,
): boolean {
  return entity.type === 'conversation'
    ? state.conversationIds.has(entity.conversationId)
    : state.runIds.has(entity.runId);
}

export function cloneDeletionEntity(entity: AgentDeletionEntity): AgentDeletionEntity {
  return entity.type === 'conversation'
    ? { type: 'conversation', conversationId: entity.conversationId }
    : { type: 'run', conversationId: entity.conversationId, runId: entity.runId };
}

export function cloneAgentActor(actor: AgentActor): AgentActor {
  if (actor.type === 'user') return { type: 'user', userId: actor.userId };
  if (actor.type === 'agent') return { type: 'agent', agentId: actor.agentId };
  if (actor.type === 'tool') {
    return { type: 'tool', toolName: actor.toolName, toolCallId: actor.toolCallId };
  }
  return { type: 'system' };
}

export function cloneDeletionTombstone(tombstone: AgentDeletionTombstone): AgentDeletionTombstone {
  return {
    ...tombstone,
    entity: cloneDeletionEntity(tombstone.entity),
    actor: cloneAgentActor(tombstone.actor),
    lastKnownEvent: tombstone.lastKnownEvent ? { ...tombstone.lastKnownEvent } : null,
  };
}

export function portableAgentEvent(event: AgentEvent): AgentEvent | null {
  if (
    event.type === 'debug.run_snapshot.created'
    || event.type === 'tool.capability.checked'
    || event.type === 'tool.capability.resolved'
    || (event.type === 'notification.created' && event.folderCapability !== undefined)
    || event.type === 'checkpoint.created'
  ) return null;
  if (
    (event.type === 'payload.created' || event.type === 'payload.derived')
    && !isPortablePayloadRef(event.payload)
  ) return null;
  const sanitized = sanitizePortableValue(event);
  return sanitized === OMIT_PORTABLE_VALUE ? null : sanitized as AgentEvent;
}

export function portableStreamCatalogEntry(
  identity: AgentPortableStreamIdentity,
  events: readonly AgentEvent[],
): AgentPortableStreamCatalogEntry | null {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) return null;
  return {
    identity: { ...identity },
    eventCount: events.length,
    firstEvent: { seq: first.seq, eventId: first.eventId },
    lastEvent: { seq: last.seq, eventId: last.eventId },
  };
}

export function portableStreamIsDeleted(
  identity: AgentPortableStreamIdentity,
  state: AgentDeletionState,
): boolean {
  return state.conversationIds.has(identity.conversationId)
    || (identity.type === 'run' && state.runIds.has(identity.runId));
}

export function comparePortableStreamIdentities(
  left: AgentPortableStreamIdentity,
  right: AgentPortableStreamIdentity,
): number {
  if (left.type !== right.type) return left.type === 'conversation' ? -1 : 1;
  const byConversation = compareCodeUnits(left.conversationId, right.conversationId);
  if (byConversation !== 0 || left.type === 'conversation' || right.type === 'conversation') {
    return byConversation;
  }
  return compareCodeUnits(left.runId, right.runId);
}

export function portablePayloadCatalog(events: readonly AgentEvent[]): AgentPortablePayloadCatalogEntry[] {
  const payloads = new Map<string, AgentPortablePayloadCatalogEntry>();
  const visit = (value: unknown): void => {
    if (isPayloadRef(value)) {
      if (!isPortablePayloadRef(value) || !value.scope) return;
      const entry: AgentPortablePayloadCatalogEntry = {
        kind: 'payload_ref',
        id: value.id,
        storage: 'file',
        mimeType: value.mimeType,
        byteLength: value.byteLength,
        sha256: value.sha256,
        scope: { ...value.scope },
        role: value.role,
      };
      payloads.set(portablePayloadKey(entry), entry);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value)) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  for (const event of events) visit(event);
  return [...payloads.values()].sort((left, right) => (
    compareCodeUnits(portablePayloadKey(left), portablePayloadKey(right))
  ));
}

export function parseDeletionTombstonesJsonl(
  raw: string,
  source: string,
): AgentDeletionTombstone[] {
  const tombstones: AgentDeletionTombstone[] = [];
  const deletionIds = new Set<string>();
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      if (index === lastContentIndex) {
        console.warn(`Dropping torn trailing agent deletion tombstone at ${source}:${index + 1}`);
        break;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid agent deletion tombstone JSON at ${source}:${index + 1}: ${message}`);
    }
    const tombstone = normalizeDeletionTombstone(parsed);
    if (!tombstone) throw new Error(`Invalid agent deletion tombstone at ${source}:${index + 1}`);
    if (tombstone.seq <= (tombstones.at(-1)?.seq ?? 0)) {
      throw new Error(`Agent deletion tombstones are not strictly ordered at ${source}:${index + 1}`);
    }
    if (deletionIds.has(tombstone.deletionId)) {
      throw new Error(`Duplicate agent deletion id at ${source}:${index + 1}`);
    }
    deletionIds.add(tombstone.deletionId);
    tombstones.push(tombstone);
  }
  return tombstones;
}

function sanitizePortableValue(value: unknown): unknown | typeof OMIT_PORTABLE_VALUE {
  if (isPayloadRef(value)) return isPortablePayloadRef(value) ? clonePayloadRef(value) : OMIT_PORTABLE_VALUE;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const sanitized = sanitizePortableValue(item);
      return sanitized === OMIT_PORTABLE_VALUE ? [] : [sanitized];
    });
  }
  if (!isRecord(value)) return value;
  if (
    (value.type === 'image' && isPayloadRef(value.imageRef) && !isPortablePayloadRef(value.imageRef))
    || (value.type === 'payload_ref' && isPayloadRef(value.payload) && !isPortablePayloadRef(value.payload))
  ) return OMIT_PORTABLE_VALUE;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const portable = sanitizePortableValue(item);
    if (portable !== OMIT_PORTABLE_VALUE) sanitized[key] = portable;
  }
  return sanitized;
}

function isPayloadRef(value: unknown): value is AgentPayloadRef {
  return isRecord(value)
    && value.kind === 'payload_ref'
    && value.storage === 'file'
    && typeof value.id === 'string'
    && typeof value.mimeType === 'string'
    && typeof value.byteLength === 'number'
    && typeof value.sha256 === 'string';
}

function isPortablePayloadRef(
  payload: AgentPayloadRef,
): payload is AgentPayloadRef & { role: AgentPortablePayloadRole } {
  return payload.role === 'source'
    || payload.role === 'preview'
    || payload.role === 'text_extract'
    || payload.role === 'tool_output';
}

function clonePayloadRef(payload: AgentPayloadRef): AgentPayloadRef {
  return {
    kind: 'payload_ref',
    id: payload.id,
    storage: 'file',
    mimeType: payload.mimeType,
    byteLength: payload.byteLength,
    sha256: payload.sha256,
    scope: payload.scope ? { ...payload.scope } : undefined,
    role: payload.role,
    truncated: payload.truncated,
    display: payload.display ? { ...payload.display } : undefined,
  };
}

function portablePayloadKey(payload: AgentPortablePayloadCatalogEntry): string {
  const scope = payload.scope.type === 'conversation'
    ? `conversation:${payload.scope.conversationId}`
    : `run:${payload.scope.conversationId}:${payload.scope.runId}`;
  return `${scope}:${payload.id}`;
}

function normalizeDeletionTombstone(value: unknown): AgentDeletionTombstone | null {
  if (!isRecord(value) || value.v !== AGENT_DELETION_VERSION) return null;
  if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq <= 0) return null;
  if (typeof value.deletionId !== 'string' || value.deletionId.length === 0) return null;
  const entity = normalizeDeletionEntity(value.entity);
  const actor = normalizeAgentActor(value.actor);
  if (!entity || !actor || !isAgentDeletionReason(value.reason)) return null;
  if (typeof value.deletedAt !== 'number' || !Number.isFinite(value.deletedAt)) return null;
  const lastKnownEvent = value.lastKnownEvent === null
    ? null
    : normalizeEventIdentity(value.lastKnownEvent);
  if (value.lastKnownEvent !== null && !lastKnownEvent) return null;
  return {
    v: AGENT_DELETION_VERSION,
    seq: value.seq,
    deletionId: value.deletionId,
    entity,
    actor,
    reason: value.reason,
    deletedAt: value.deletedAt,
    lastKnownEvent,
  };
}

function normalizeDeletionEntity(value: unknown): AgentDeletionEntity | null {
  if (!isRecord(value) || typeof value.conversationId !== 'string') return null;
  if (value.type === 'conversation') {
    return { type: 'conversation', conversationId: value.conversationId };
  }
  if (value.type === 'run' && typeof value.runId === 'string') {
    return { type: 'run', conversationId: value.conversationId, runId: value.runId };
  }
  return null;
}

function normalizeAgentActor(value: unknown): AgentActor | null {
  if (!isRecord(value)) return null;
  if (value.type === 'system') return { type: 'system' };
  if (value.type === 'user' && typeof value.userId === 'string') {
    return { type: 'user', userId: value.userId };
  }
  if (value.type === 'agent' && typeof value.agentId === 'string') {
    return { type: 'agent', agentId: value.agentId };
  }
  if (value.type === 'tool' && typeof value.toolName === 'string' && typeof value.toolCallId === 'string') {
    return { type: 'tool', toolName: value.toolName, toolCallId: value.toolCallId };
  }
  return null;
}

function isAgentDeletionReason(value: unknown): value is AgentDeletionReason {
  return value === 'conversation_deleted'
    || value === 'conversation_reset'
    || value === 'retention_pruned';
}

function normalizeEventIdentity(value: unknown): AgentEventIdentity | null {
  if (!isRecord(value) || typeof value.eventId !== 'string') return null;
  if (typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq <= 0) return null;
  return { seq: value.seq, eventId: value.eventId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
