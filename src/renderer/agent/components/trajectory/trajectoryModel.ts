import type {
  ThreadTrajectoryRecordKind,
  ThreadTrajectoryRecordSummary,
} from '../../../../core/agent/protocol';

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

export function trajectoryRecordsInRange(
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
  rangeMatches,
  records,
  searchMatches,
}: {
  readonly collapsedCalls: ReadonlySet<string>;
  readonly collapsedTurns: ReadonlySet<string>;
  readonly rangeMatches: ReadonlySet<string> | null;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly searchMatches: ReadonlySet<string> | null;
}): readonly TrajectoryLedgerRow[] {
  const rows: TrajectoryLedgerRow[] = [];
  for (const group of groupTrajectoryRecords(records)) {
    const childrenByParent = new Map<string, ThreadTrajectoryRecordSummary[]>();
    for (const record of group.records) {
      if (!record.parentRecordId) continue;
      const children = childrenByParent.get(record.parentRecordId);
      if (children) children.push(record);
      else childrenByParent.set(record.parentRecordId, [record]);
    }
    const directMatches = group.records.filter((record) => (
      (searchMatches === null || searchMatches.has(record.id))
      && (rangeMatches === null || rangeMatches.has(record.id))
    ));
    const matchingIds = new Set(directMatches.map((record) => record.id));
    for (const record of directMatches) {
      if (record.parentRecordId) matchingIds.add(record.parentRecordId);
    }
    if (matchingIds.size === 0) continue;

    if (collapsedTurns.has(group.turnId)) {
      rows.push({
        type: 'turnSummary',
        key: `turn-summary:${group.turnId}`,
        turnId: group.turnId,
        turnIndex: group.index,
        count: directMatches.length,
        preview: trajectoryRecordContent(directMatches.at(-1) ?? group.records.at(-1)!),
      });
      continue;
    }

    const visible = group.records.filter((record) => {
      if (!matchingIds.has(record.id)) return false;
      if (record.parentRecordId && collapsedCalls.has(record.parentRecordId)) return false;
      return true;
    });
    const turnStartId = visible.find((record) => !isStablePromptRecord(record))?.id ?? null;
    for (const record of visible) {
      const callChildren = childrenByParent.get(record.id) ?? [];
      rows.push({
        type: 'record',
        key: record.id,
        record,
        turnIndex: group.index,
        turnStart: record.id === turnStartId,
        depth: record.parentRecordId ? 1 : 0,
        callChildCount: callChildren.length,
        callCollapsed: collapsedCalls.has(record.id),
      });
    }
  }
  return rows;
}

export function trajectoryRecordRole(record: ThreadTrajectoryRecordSummary): string {
  if (isStablePromptRecord(record)) return 'SYSTEM';
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

export function trajectoryRecordKindClass(kind: ThreadTrajectoryRecordKind): string {
  return `is-${kind}`;
}

export function isStablePromptRecord(record: ThreadTrajectoryRecordSummary): boolean {
  return record.kind === 'context' && record.primaryEvidence.type === 'stablePrompt';
}

export function orderedRange(left: number, right: number): TrajectoryTimeRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left };
}
