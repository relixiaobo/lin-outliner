import type { DocumentProjection, DocumentState } from './types';

export type OperationHistoryScope = 'all' | 'agent' | 'user';
export type OperationHistoryOrigin = 'agent' | 'user' | 'system';
export type OperationHistoryAction = 'list' | 'undo' | 'redo';

export interface OperationHistoryEntry {
  operationId: string;
  origin: OperationHistoryOrigin;
  command?: string;
  tool?: string;
  action: string;
  summary: string;
  affectedNodeIds: string[];
  createdAt: string;
}

export interface OperationHistoryItem extends OperationHistoryEntry {
  canUndo: boolean;
  canRedo: boolean;
}

export interface OperationHistoryResult {
  action: OperationHistoryAction;
  historyMode?: 'journal' | 'undo_stack';
  count: number;
  total?: number;
  hasMore?: boolean;
  items?: OperationHistoryItem[];
  undone?: OperationHistoryItem[];
  redone?: OperationHistoryItem[];
  canUndo: boolean;
  canRedo: boolean;
  cursor?: {
    topUndoOperationId?: string;
    topRedoOperationId?: string;
  };
  projection?: DocumentProjection;
}

export interface OperationHistoryQuery {
  action?: OperationHistoryAction;
  origin?: OperationHistoryScope;
  steps?: number;
  limit?: number;
  offset?: number;
  operationId?: string;
}

export interface OperationHistoryMetadata {
  operationId?: string;
  command?: string;
  tool?: string;
  summary?: string;
}

export interface OperationStackState {
  canUndo: boolean;
  canRedo: boolean;
  topUndo?: OperationHistoryEntry;
  topRedo?: OperationHistoryEntry;
}

const DEFAULT_MAX_ENTRIES = 500;

export class OperationJournal {
  private entries: OperationHistoryEntry[] = [];
  private entriesByOrigin: Record<OperationHistoryOrigin, OperationHistoryEntry[]> = {
    agent: [],
    user: [],
    system: [],
  };
  private entryByOperationId = new Map<string, OperationHistoryEntry>();
  private readonly maxEntries: number;

  constructor(entries: unknown[] | undefined, options: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    const restored = Array.isArray(entries) ? entries.filter(isOperationHistoryEntry) : [];
    for (const entry of restored.slice(-this.maxEntries)) this.appendEntry(entry);
  }

  entriesForSerialization(limit: number) {
    if (limit <= 0) return [];
    return this.entries.slice(-limit);
  }

  createEntry(
    commitOrigin: string,
    metadata: OperationHistoryMetadata,
    affectedNodeIds: readonly string[],
  ) {
    const origin = historyOriginFromCommitOrigin(commitOrigin);
    if (origin === 'system') return undefined;
    const affected = [...new Set(affectedNodeIds)].sort();
    if (affected.length === 0) return undefined;

    const action = metadata.tool ?? metadata.command ?? 'document_operation';
    return {
      operationId: metadata.operationId ?? `op:${crypto.randomUUID()}`,
      origin,
      command: metadata.command,
      tool: metadata.tool,
      action,
      summary: metadata.summary ?? summarizeOperation(origin, action),
      affectedNodeIds: affected,
      createdAt: new Date().toISOString(),
    };
  }

  record(entry: OperationHistoryEntry) {
    const existing = this.entryByOperationId.get(entry.operationId);
    if (existing) {
      existing.affectedNodeIds = [...new Set([...existing.affectedNodeIds, ...entry.affectedNodeIds])].sort();
      existing.command ??= entry.command;
      existing.tool ??= entry.tool;
      existing.action = entry.action;
      existing.summary = entry.summary;
      return;
    }
    this.appendEntry(entry);
    this.evictOverflow();
  }

  findByOperationId(operationId: string): OperationHistoryEntry | undefined {
    return this.entryByOperationId.get(operationId);
  }

  list(
    query: Required<Pick<OperationHistoryQuery, 'origin' | 'limit' | 'offset'>>,
    stack: OperationStackState,
  ): OperationHistoryResult {
    const { origin, limit, offset } = query;
    const entries = origin === 'all' ? this.entries : this.entriesByOrigin[origin];
    const items: OperationHistoryItem[] = [];
    for (let index = entries.length - 1 - offset; index >= 0 && items.length < limit; index -= 1) {
      const entry = entries[index];
      if (entry) items.push(decorateHistoryItem(entry, stack));
    }
    return {
      action: 'list',
      historyMode: 'journal',
      count: items.length,
      total: entries.length,
      hasMore: offset + limit < entries.length,
      items,
      ...stackStateResult(stack),
    };
  }

  private appendEntry(entry: OperationHistoryEntry) {
    this.entries.push(entry);
    this.entriesByOrigin[entry.origin].push(entry);
    this.entryByOperationId.set(entry.operationId, entry);
  }

  private evictOverflow() {
    while (this.entries.length > this.maxEntries) {
      const evicted = this.entries.shift();
      if (!evicted) continue;
      const originEntries = this.entriesByOrigin[evicted.origin];
      if (originEntries[0] === evicted) {
        originEntries.shift();
      } else {
        const index = originEntries.indexOf(evicted);
        if (index >= 0) originEntries.splice(index, 1);
      }
      if (this.entryByOperationId.get(evicted.operationId) === evicted) {
        this.entryByOperationId.delete(evicted.operationId);
      }
    }
  }
}

export function isOperationHistoryEntry(value: unknown): value is OperationHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as OperationHistoryEntry;
  return typeof entry.operationId === 'string'
    && (entry.origin === 'agent' || entry.origin === 'user' || entry.origin === 'system')
    && (entry.command == null || typeof entry.command === 'string')
    && (entry.tool == null || typeof entry.tool === 'string')
    && typeof entry.action === 'string'
    && typeof entry.summary === 'string'
    && Array.isArray(entry.affectedNodeIds)
    && entry.affectedNodeIds.every((nodeId) => typeof nodeId === 'string')
    && typeof entry.createdAt === 'string';
}

function historyOriginFromCommitOrigin(origin: string): OperationHistoryOrigin {
  if (origin.startsWith('agent:')) return 'agent';
  if (origin.startsWith('user:')) return 'user';
  return 'system';
}

export function changedNodeIdsBetweenStates(before: DocumentState, after: DocumentState) {
  const ids = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
  return [...ids]
    .filter((id) => !sameJson(before.nodes[id], after.nodes[id]))
    .sort();
}

function summarizeOperation(origin: OperationHistoryOrigin, action: string) {
  if (origin === 'agent') return `Agent ${action.replace(/_/g, ' ')}.`;
  if (origin === 'user') return `User ${action.replace(/_/g, ' ')}.`;
  return `System ${action.replace(/_/g, ' ')}.`;
}

export function synthesizeHistoryEntry(
  action: 'undo' | 'redo',
  origin: OperationHistoryScope,
  before: DocumentState,
  after: DocumentState,
): OperationHistoryEntry {
  const itemOrigin: OperationHistoryOrigin = origin === 'all' ? 'system' : origin;
  return {
    operationId: `synthetic:${crypto.randomUUID()}`,
    origin: itemOrigin,
    action,
    summary: `${action === 'undo' ? 'Undo' : 'Redo'} operation.`,
    affectedNodeIds: changedNodeIdsBetweenStates(before, after),
    createdAt: new Date().toISOString(),
  };
}

export function operationHistoryEntryFromValue(value: unknown): OperationHistoryEntry | undefined {
  return isOperationHistoryEntry(value) ? value : undefined;
}

export function decorateHistoryItem(entry: OperationHistoryEntry, stack: OperationStackState): OperationHistoryItem {
  return {
    ...entry,
    canUndo: stack.topUndo?.operationId === entry.operationId,
    canRedo: stack.topRedo?.operationId === entry.operationId,
  };
}

export function stackStateResult(stack: OperationStackState) {
  return {
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    cursor: {
      topUndoOperationId: stack.topUndo?.operationId,
      topRedoOperationId: stack.topRedo?.operationId,
    },
  };
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
