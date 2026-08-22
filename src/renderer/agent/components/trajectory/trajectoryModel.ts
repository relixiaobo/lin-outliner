import type { ThreadTrajectoryRecordSummary } from '../../../../core/agent/protocol';

export type TrajectoryTimelineMode = 'sequence' | 'duration';

export interface TrajectoryTimeRange {
  readonly start: number;
  readonly end: number;
}

export interface TrajectoryTimelineSpan {
  readonly end: number;
  readonly marker: boolean;
  readonly record: ThreadTrajectoryRecordSummary;
  readonly start: number;
}

export interface TrajectoryTimelineModel {
  readonly end: number;
  readonly spans: readonly TrajectoryTimelineSpan[];
  readonly start: number;
  readonly unpositionedCount: number;
}

export interface TrajectoryTurnGroup {
  readonly index: number;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly turnId: string;
}

export type TrajectoryLedgerRow =
  | {
      readonly type: 'record';
      readonly callChildCount: number;
      readonly callCollapsed: boolean;
      readonly depth: number;
      readonly key: string;
      readonly record: ThreadTrajectoryRecordSummary;
      readonly turnIndex: number;
      readonly turnStart: boolean;
    }
  | {
      readonly type: 'turnSummary';
      readonly count: number;
      readonly key: string;
      readonly preview: string;
      readonly turnId: string;
      readonly turnIndex: number;
    };

export const TRAJECTORY_ROW_HEIGHT = 30;
export const TRAJECTORY_VIRTUALIZATION_THRESHOLD = 100;
export const TRAJECTORY_VIRTUAL_OVERSCAN = 12;

export function groupTrajectoryRecords(
  records: readonly ThreadTrajectoryRecordSummary[],
): readonly TrajectoryTurnGroup[] {
  const groups: Array<{
    readonly index: number;
    readonly records: ThreadTrajectoryRecordSummary[];
    readonly turnId: string;
  }> = [];
  const byTurn = new Map<string, ThreadTrajectoryRecordSummary[]>();
  for (const record of records) {
    const existing = byTurn.get(record.turnId);
    if (existing) existing.push(record);
    else byTurn.set(record.turnId, [record]);
  }
  let index = 0;
  for (const [turnId, turnRecords] of byTurn) {
    groups.push({ index, records: turnRecords, turnId });
    index += 1;
  }
  return groups;
}

export function trajectoryRecordSearchText(record: ThreadTrajectoryRecordSummary): string {
  return [
    record.kind,
    trajectoryRecordRole(record),
    record.title,
    record.subtitle ?? '',
    record.preview ?? '',
    record.state,
    record.turnId,
  ].join(' ').toLocaleLowerCase();
}

export function trajectorySearchMatches(
  records: readonly ThreadTrajectoryRecordSummary[],
  query: string,
): ReadonlySet<string> | null {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return null;
  return new Set(records
    .filter((record) => trajectoryRecordSearchText(record).includes(normalized))
    .map((record) => record.id));
}

export function buildTrajectoryTimeline(
  records: readonly ThreadTrajectoryRecordSummary[],
  mode: TrajectoryTimelineMode,
): TrajectoryTimelineModel | null {
  if (records.length === 0) return null;
  if (mode === 'sequence') {
    return {
      start: 0,
      end: Math.max(1, records.length),
      spans: records.map((record, index) => ({
        record,
        start: index,
        end: index + 1,
        marker: false,
      })),
      unpositionedCount: 0,
    };
  }

  const timed = records.filter((record) => record.timing.startedAt !== null);
  if (timed.length === 0) return null;
  const start = Math.min(...timed.map((record) => record.timing.startedAt!));
  const recordedEnd = Math.max(...timed.map((record) => (
    record.timing.completedAt ?? record.timing.startedAt!
  )));
  const end = Math.max(start + 1, recordedEnd);
  return {
    start,
    end,
    spans: timed.map((record) => {
      const spanStart = record.timing.startedAt!;
      const spanEnd = record.timing.completedAt ?? spanStart;
      return {
        record,
        start: spanStart,
        end: Math.max(spanStart, spanEnd),
        marker: record.timing.completedAt === null || spanEnd <= spanStart,
      };
    }),
    unpositionedCount: records.length - timed.length,
  };
}

export function trajectoryTimelineFocusRecords(
  model: TrajectoryTimelineModel | null,
  range: TrajectoryTimeRange | null,
): ReadonlySet<string> | null {
  if (!model || !range) return null;
  const ordered = orderedRange(range.start, range.end);
  return new Set(model.spans
    .filter((span) => span.marker
      ? span.start >= ordered.start && span.start <= ordered.end
      : span.end >= ordered.start && span.start <= ordered.end)
    .map((span) => span.record.id));
}

export function buildTrajectoryLedgerRows({
  collapsedCalls,
  collapsedTurns,
  records,
  searchMatches,
  selectedRecordId = null,
}: {
  readonly collapsedCalls: ReadonlySet<string>;
  readonly collapsedTurns: ReadonlySet<string>;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly searchMatches: ReadonlySet<string> | null;
  readonly selectedRecordId?: string | null;
}): readonly TrajectoryLedgerRow[] {
  const rows: TrajectoryLedgerRow[] = [];
  const pinnedIds = pinnedRecordIds(records, selectedRecordId);
  for (const group of groupTrajectoryRecords(records)) {
    const childrenByParent = new Map<string, ThreadTrajectoryRecordSummary[]>();
    for (const record of group.records) {
      if (!record.parentRecordId) continue;
      const children = childrenByParent.get(record.parentRecordId);
      if (children) children.push(record);
      else childrenByParent.set(record.parentRecordId, [record]);
    }
    const directMatches = group.records.filter((record) => (
      pinnedIds.has(record.id)
      || searchMatches === null
      || searchMatches.has(record.id)
    ));
    const matchingIds = new Set(directMatches.map((record) => record.id));
    for (const record of directMatches) {
      if (record.parentRecordId) matchingIds.add(record.parentRecordId);
    }
    if (matchingIds.size === 0) continue;

    const selectedInCollapsedContent = group.records.some((record) => (
      pinnedIds.has(record.id) && !isSystemLevelRecord(record)
    ));
    if (collapsedTurns.has(group.turnId) && !selectedInCollapsedContent) {
      const visibleSystemRecords = directMatches.filter(isSystemLevelRecord);
      for (const record of visibleSystemRecords) {
        rows.push(recordRow(record, group.index, false, childrenByParent, collapsedCalls));
      }
      const contentRecords = directMatches.filter((record) => !isSystemLevelRecord(record));
      const firstContent = contentRecords[0] ?? null;
      if (firstContent) {
        rows.push(recordRow(firstContent, group.index, true, childrenByParent, collapsedCalls));
        const folded = contentRecords.slice(1);
        if (folded.length > 0) {
          rows.push({
            type: 'turnSummary',
            key: `turn-summary:${group.turnId}`,
            turnId: group.turnId,
            turnIndex: group.index,
            count: folded.length,
            preview: summarizeFoldedRecords(folded),
          });
        }
      }
      continue;
    }

    const visible = group.records.filter((record) => {
      if (!matchingIds.has(record.id)) return false;
      if (
        record.parentRecordId
        && collapsedCalls.has(record.parentRecordId)
        && !pinnedIds.has(record.id)
      ) return false;
      return true;
    });
    const turnStartId = visible.find((record) => !isSystemLevelRecord(record))?.id ?? null;
    for (const record of visible) {
      rows.push(recordRow(record, group.index, record.id === turnStartId, childrenByParent, collapsedCalls));
    }
  }
  return rows;
}

function pinnedRecordIds(
  records: readonly ThreadTrajectoryRecordSummary[],
  selectedRecordId: string | null,
): ReadonlySet<string> {
  if (!selectedRecordId) return new Set();
  const byId = new Map(records.map((record) => [record.id, record]));
  const pinned = new Set<string>();
  let current = byId.get(selectedRecordId) ?? null;
  while (current) {
    pinned.add(current.id);
    current = current.parentRecordId ? byId.get(current.parentRecordId) ?? null : null;
  }
  return pinned;
}

function recordRow(
  record: ThreadTrajectoryRecordSummary,
  turnIndex: number,
  turnStart: boolean,
  childrenByParent: ReadonlyMap<string, readonly ThreadTrajectoryRecordSummary[]>,
  collapsedCalls: ReadonlySet<string>,
): Extract<TrajectoryLedgerRow, { readonly type: 'record' }> {
  const callChildren = childrenByParent.get(record.id) ?? [];
  return {
    type: 'record',
    key: record.id,
    record,
    turnIndex,
    turnStart,
    depth: record.parentRecordId ? 1 : 0,
    callChildCount: callChildren.length,
    callCollapsed: collapsedCalls.has(record.id),
  };
}

function summarizeFoldedRecords(records: readonly ThreadTrajectoryRecordSummary[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    const role = trajectoryRecordRole(record);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return [...counts.entries()].map(([role, count]) => `${role.toLowerCase()}×${count}`).join(' · ');
}

export function trajectoryRecordRole(record: ThreadTrajectoryRecordSummary): string {
  if (isStablePromptRecord(record)) return 'SYSTEM';
  if (isToolCatalogRecord(record)) return 'TOOLS';
  switch (record.kind) {
    case 'input': return 'USER';
    case 'context': return 'CONTEXT';
    case 'assistant': return 'ASSISTANT';
    case 'tool': return 'TOOL';
    case 'retry': return 'RETRY';
    case 'compaction': return 'COMPACTED';
    case 'delegation': return 'AGENT';
  }
}

export function trajectoryRecordContent(record: ThreadTrajectoryRecordSummary): string {
  if (isStablePromptRecord(record)) return record.title;
  if (record.kind === 'input' || record.kind === 'assistant') {
    return record.preview ?? record.title;
  }
  if (record.kind === 'context') {
    return record.preview ? `${record.title} · ${record.preview}` : record.title;
  }
  if (record.kind === 'tool' || record.kind === 'delegation') {
    if (!record.preview || record.preview === record.title) return record.title;
    return `${record.title} · ${record.preview}`;
  }
  return record.preview ?? record.title;
}

export function trajectoryRecordKindClass(record: ThreadTrajectoryRecordSummary): string {
  if (isStablePromptRecord(record)) return 'is-system';
  if (isToolCatalogRecord(record)) return 'is-tool-catalog';
  return `is-${record.kind}`;
}

export function isSystemLevelRecord(record: ThreadTrajectoryRecordSummary): boolean {
  return isStablePromptRecord(record) || isToolCatalogRecord(record);
}

export function isStablePromptRecord(record: ThreadTrajectoryRecordSummary): boolean {
  return record.kind === 'context' && record.primaryEvidence.type === 'stablePrompt';
}

export function isToolCatalogRecord(record: ThreadTrajectoryRecordSummary): boolean {
  return record.kind === 'context' && record.primaryEvidence.type === 'toolCatalog';
}

export function orderedRange(left: number, right: number): TrajectoryTimeRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left };
}
