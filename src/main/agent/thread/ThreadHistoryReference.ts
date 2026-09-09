import type {
  Thread,
  ThreadId,
  ThreadItem,
  ThreadReferenceResolveRequest,
  ThreadReferenceResolveResponse,
  ThreadReferenceSearchRequest,
  ThreadReferenceSearchResponse,
} from '../../../core/agent/protocol';
import {
  basenameForPath,
  formatThreadReferenceMarker,
  parseReferenceMarkers,
  parseThreadReferenceMarkers,
  referenceDisplayFallback,
} from '../../../core/referenceMarkup';
import { redactSecretLikeContent } from '../capabilities/agentSecretRedaction';
import type { ThreadHistoryVisibleEntry } from '../persistence/ThreadHistoryProjectionStore';
import type { ThreadCatalogRecord } from '../persistence/ThreadMetadataStore';
import type { ThreadCore } from './ThreadCore';
import { recordEligible } from './ThreadRecordFiles';
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const MAX_SEARCH_SCAN_ITEMS = 5000;
const MAX_SNIPPET_CHARS = 320;

export class ThreadHistoryReferenceService {
  constructor(
    private readonly core: ThreadCore,
    private readonly historyReadable: (id: ThreadId) => boolean,
    private readonly isRecorded: (id: ThreadId) => boolean,
  ) {}
  searchReferences(request: ThreadReferenceSearchRequest): ThreadReferenceSearchResponse {
    const current = this.requireCurrentRecord(request.currentThreadId);
    const query = normalizeQuery(request.query ?? '');
    const limit = clamp(request.limit ?? DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const roots = this.rootCandidates();
    const historyMatches = query ? this.historyMatches(current, roots, query) : new Map();
    const candidates = roots
      .map(({ record, archived }) => {
        const metadata = redactHistoricalText([record.thread.name ?? '', record.thread.preview].join('\n'));
        const metadataMatch = matchText(metadata, query);
        const historyMatch = historyMatches.get(record.thread.id) ?? null;
        if (query && !metadataMatch && !historyMatch) return null;
        return {
          threadId: record.thread.id,
          title: threadTitle(record.thread),
          updatedAt: record.thread.updatedAt,
          availability: this.historyReadable(record.thread.id)
            ? ('available' as const)
            : ('corrupt' as const),
          snippet: boundedSnippet(historyMatch?.text ?? redactHistoricalText(record.thread.preview)),
          archived,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.threadId.localeCompare(left.threadId))
      .slice(0, limit);
    return { data: candidates };
  }
  resolveReferences(request: ThreadReferenceResolveRequest): ThreadReferenceResolveResponse {
    const current = this.requireCurrentRecord(request.currentThreadId);
    return {
      data: request.threadIds.map((threadId) => {
        const target = this.core.metadata.read(threadId);
        if (!target) return { threadId, title: null, updatedAt: null, availability: 'missing' as const };
        if (!isReferenceEligible(target) || !this.isRecorded(threadId))
          return { threadId, title: null, updatedAt: null, availability: 'denied' as const };
        if (threadId === current.thread.id) {
          return {
            threadId,
            title: threadTitle(current.thread),
            updatedAt: current.thread.updatedAt,
            availability: 'current' as const,
          };
        }
        return {
          threadId,
          title: threadTitle(target.thread),
          updatedAt: target.thread.updatedAt,
          availability: this.historyReadable(threadId) ? ('available' as const) : ('corrupt' as const),
        };
      }),
    };
  }
  private rootCandidates(): Array<{
    readonly record: ThreadCatalogRecord;
    readonly archived: boolean;
  }> {
    const candidates: Array<{ record: ThreadCatalogRecord; archived: boolean }> = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const page = this.core.metadata.list({ archived, cursor, limit: 100, rootsOnly: true });
        for (const thread of page.data) {
          if (!recordEligible(thread) || !this.isRecorded(thread.id)) continue;
          const record = this.core.metadata.read(thread.id);
          if (record) candidates.push({ record, archived });
        }
        cursor = page.nextCursor;
      } while (cursor);
    }
    return candidates;
  }
  private historyMatches(
    current: ThreadCatalogRecord,
    roots: readonly { readonly record: ThreadCatalogRecord }[],
    query: string,
  ): ReadonlyMap<ThreadId, { readonly text: string; readonly turnPosition: number }> {
    const matches = new Map<ThreadId, { text: string; turnPosition: number }>();
    const entries = this.core.history.visibleHistoryEntries(
      roots
        .filter(({ record }) => this.historyReadable(record.thread.id))
        .map(({ record }) => record.thread.id),
      {
        maximum: MAX_SEARCH_SCAN_ITEMS,
        newestFirst: true,
      },
    );
    for (const entry of entries) {
      if (matches.has(entry.threadId)) continue;
      const text = searchableEntryText(entry, (id) => this.resolvedThreadLabel(current, id));
      if (text && matchText(text, query)) {
        matches.set(entry.threadId, { text, turnPosition: entry.turnPosition });
      }
    }
    return matches;
  }
  private requireCurrentRecord(threadId: ThreadId): ThreadCatalogRecord {
    const record = this.core.metadata.read(threadId);
    if (!record) throw new Error('Current Thread is unavailable');
    return record;
  }
  private resolvedThreadLabel(current: ThreadCatalogRecord, threadId: ThreadId): string {
    const target = this.core.metadata.read(threadId);
    if (!target || !isReferenceEligible(target) || !this.isRecorded(threadId)) return shortThreadId(threadId);
    return threadTitle(target.thread);
  }
}
function normalizeQuery(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}
function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Bounded history value must be an integer');
  return Math.max(minimum, Math.min(maximum, value));
}
function redactHistoricalText(value: string): string {
  return redactSearchPaths(redactSecretLikeContent(value));
}
function redactSearchPaths(value: string): string {
  const markers = parseReferenceMarkers(value).sort((left, right) => left.start - right.start);
  let cursor = 0;
  let output = '';
  for (const marker of markers) {
    if (marker.target.kind !== 'local-file') continue;
    if (marker.start < cursor) continue;
    output += value.slice(cursor, marker.start);
    output += `[historical file: ${basenameForPath(marker.target.path) || 'file'}]`;
    cursor = marker.end;
  }
  output += value.slice(cursor);
  return output.replace(
    /(^|[\s"'=([{,])\/(?:[^\s/"'<>\[\]{},()]+\/)*[^\s"'<>\[\]{},()]*/gu,
    '$1[local path]',
  );
}
function matchText(value: string, query: string): boolean {
  if (!query) return true;
  const haystack = value.toLocaleLowerCase();
  return query.split(' ').every((term) => haystack.includes(term));
}
function threadTitle(thread: Thread): string {
  return thread.name?.trim() || thread.preview.trim() || `Thread ${shortThreadId(thread.id)}`;
}
function shortThreadId(threadId: string): string {
  return `${threadId.slice(0, 8)}...${threadId.slice(-4)}`;
}
function boundedSnippet(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length <= MAX_SNIPPET_CHARS ? compact : `${compact.slice(0, MAX_SNIPPET_CHARS - 3)}...`;
}
function isReferenceEligible(record: ThreadCatalogRecord): boolean {
  return recordEligible(record.thread);
}
function searchableEntryText(
  entry: ThreadHistoryVisibleEntry,
  resolveThreadTitle: (threadId: ThreadId) => string,
): string {
  return redactSearchPaths(redactSecretLikeContent(readableItemText(entry.item, resolveThreadTitle)));
}
function readableItemText(item: ThreadItem, resolveThreadTitle: (threadId: ThreadId) => string): string {
  switch (item.type) {
    case 'userMessage':
      return item.content
        .map((part) => {
          if (part.type === 'text') return projectAuthoredMarkers(part.text, resolveThreadTitle);
          if (part.type === 'attachment') return `[File: ${part.name}]`;
          if (part.type === 'nodeReference') return `[Node: ${part.note?.trim() || part.nodeId}]`;
          return `[Thread: ${resolveThreadTitle(part.threadId)} ${formatThreadReferenceMarker(part.threadId)}]`;
        })
        .join('\n')
        .trim();
    case 'agentMessage':
      return projectAuthoredMarkers(item.text, resolveThreadTitle).trim();
    case 'commandExecution':
      return `[Activity: command ${item.status}]`;
    case 'fileChange':
      return `[Activity: file change ${item.status}]`;
    case 'mcpToolCall':
      return `[Activity: ${item.server}.${item.tool} ${item.status}]`;
    case 'dynamicToolCall':
      return `[Activity: ${[item.namespace, item.tool].filter(Boolean).join('.')} ${item.status}]`;
    case 'webSearch':
      return `[Activity: web search ${item.status}]`;
    default:
      return '';
  }
}
function projectAuthoredMarkers(text: string, resolveThreadTitle: (threadId: ThreadId) => string): string {
  const markers = [
    ...parseReferenceMarkers(text).map((marker) => ({
      start: marker.start,
      end: marker.end,
      replacement:
        marker.target.kind === 'local-file'
          ? basenameForPath(marker.target.path) || 'Referenced file'
          : referenceDisplayFallback(marker.target),
    })),
    ...parseThreadReferenceMarkers(text).map((marker) => ({
      start: marker.start,
      end: marker.end,
      replacement: `${resolveThreadTitle(marker.threadId)} ${marker.raw}`,
    })),
  ].sort((left, right) => left.start - right.start);
  if (markers.length === 0) return text;
  let cursor = 0;
  let output = '';
  for (const marker of markers) {
    if (marker.start < cursor) continue;
    output += text.slice(cursor, marker.start);
    output += marker.replacement;
    cursor = marker.end;
  }
  return output + text.slice(cursor);
}
