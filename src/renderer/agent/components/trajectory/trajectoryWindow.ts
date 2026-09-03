import type {
  ThreadTrajectoryReadResponse,
  ThreadTrajectoryRecordSummary,
  ThreadTrajectoryReplacementRange,
} from '../../../../core/agent/protocol';

export const TRAJECTORY_PAGE_LIMIT = 120;
export const TRAJECTORY_WINDOW_RECORD_LIMIT = TRAJECTORY_PAGE_LIMIT * 3;

export type TrajectoryWindowReadKind = 'initial' | 'older' | 'newer' | 'refresh';

export interface TrajectoryWorkingWindow {
  readonly coveredRecordIds: ReadonlySet<string>;
  readonly newerCursor: string | null;
  readonly olderCursor: string | null;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
}

export interface TrajectoryWindowReconciliation {
  readonly closeInspector: boolean;
  readonly followingTail: boolean;
  readonly window: TrajectoryWorkingWindow;
}

export const EMPTY_TRAJECTORY_WINDOW: TrajectoryWorkingWindow = Object.freeze({
  coveredRecordIds: new Set<string>(),
  newerCursor: null,
  olderCursor: null,
  records: Object.freeze([]),
});

export function reconcileTrajectoryWindow(
  current: TrajectoryWorkingWindow,
  response: ThreadTrajectoryReadResponse,
  kind: TrajectoryWindowReadKind,
  followingTail: boolean,
  selectedRecordId: string | null,
): TrajectoryWindowReconciliation {
  if (kind === 'initial' || current.records.length === 0) {
    return {
      closeInspector: false,
      followingTail,
      window: {
        coveredRecordIds: responseCoveredRecordIds(response),
        records: response.records,
        olderCursor: response.olderCursor,
        newerCursor: response.newerCursor,
      },
    };
  }
  if (kind === 'older' || kind === 'newer') {
    return reconcilePage(current, response, kind, followingTail, selectedRecordId);
  }
  return reconcileRefresh(current, response, followingTail, selectedRecordId);
}

function reconcilePage(
  current: TrajectoryWorkingWindow,
  response: ThreadTrajectoryReadResponse,
  kind: 'older' | 'newer',
  followingTail: boolean,
  selectedRecordId: string | null,
): TrajectoryWindowReconciliation {
  const merged = mergeRecords(current.records, response.records);
  const mergedCoverage = new Set([
    ...current.coveredRecordIds,
    ...responseCoveredRecordIds(response),
  ]);
  const retained = retainRecordCoverage(merged, mergedCoverage, kind === 'older' ? 'oldest' : 'newest');
  const trimmed = retained.coveredRecords.length < mergedCoverage.size;
  const closeInspector = !selectedPageRetained(current, retained.coveredRecords, selectedRecordId);
  const first = retained.coveredRecords[0] ?? null;
  const last = retained.coveredRecords.at(-1) ?? null;
  return {
    closeInspector,
    followingTail: kind === 'newer' && response.newerCursor === null,
    window: {
      coveredRecordIds: new Set(retained.coveredRecords.map((record) => record.id)),
      records: retained.records,
      olderCursor: kind === 'older'
        ? response.olderCursor
        : trimmed && first ? trajectoryCursor('before', first.id) : current.olderCursor,
      newerCursor: kind === 'newer'
        ? response.newerCursor
        : trimmed && last ? trajectoryCursor('after', last.id) : current.newerCursor,
    },
  };
}

function reconcileRefresh(
  current: TrajectoryWorkingWindow,
  response: ThreadTrajectoryReadResponse,
  followingTail: boolean,
  selectedRecordId: string | null,
): TrajectoryWindowReconciliation {
  const joinsLoadedCoverage = responseJoinsLoadedCoverage(current, response);
  if (!followingTail || !joinsLoadedCoverage) {
    return deferredRefresh(current, response, followingTail);
  }

  const merged = replaceRecordsForIncomingWindow(
    current.records,
    response.records,
    response.replacementRange,
    response.summary.turnCount,
  );
  const incomingCoverage = responseCoveredRecordIds(response);
  const mergedCoverage = new Set([
    ...[...current.coveredRecordIds].filter((id) => merged.some((record) => record.id === id)),
    ...incomingCoverage,
  ]);
  const retained = retainRecordCoverage(merged, mergedCoverage, 'newest');
  const trimmed = retained.coveredRecords.length < mergedCoverage.size;
  if (!selectedPageRetained(current, retained.coveredRecords, selectedRecordId)) {
    return deferredRefresh(current, response, false);
  }
  const first = retained.coveredRecords[0] ?? null;
  return {
    closeInspector: false,
    followingTail: response.newerCursor === null,
    window: {
      coveredRecordIds: new Set(retained.coveredRecords.map((record) => record.id)),
      records: retained.records,
      olderCursor: trimmed && first
        ? trajectoryCursor('before', first.id)
        : current.olderCursor,
      newerCursor: response.newerCursor,
    },
  };
}

function deferredRefresh(
  current: TrajectoryWorkingWindow,
  response: ThreadTrajectoryReadResponse,
  followingTail: boolean,
): TrajectoryWindowReconciliation {
  const currentCoverage = current.records.filter((record) => current.coveredRecordIds.has(record.id));
  const first = currentCoverage[0] ?? null;
  const last = currentCoverage.at(-1) ?? null;
  if (!first || !last) {
    return { closeInspector: false, followingTail, window: current };
  }
  const clippedRange = intersectRange(response.replacementRange, first.orderKey, last.orderKey);
  const inRangeIncoming = clippedRange
    ? structuralClosure(
      response.records.filter((record) => orderKeyInRange(record.orderKey, clippedRange)),
      response.records,
    )
    : [];
  const records = clippedRange
    ? replaceRecordsForIncomingWindow(
      current.records,
      inRangeIncoming,
      clippedRange,
      response.summary.turnCount,
    )
    : current.records.filter((record) => record.turnIndex < response.summary.turnCount);
  const recordIds = new Set(records.map((record) => record.id));
  const coveredRecordIds = new Set(
    [...current.coveredRecordIds].filter((id) => recordIds.has(id)),
  );
  for (const id of responseCoveredRecordIds(response)) {
    if (recordIds.has(id)) coveredRecordIds.add(id);
  }
  const retainedLast = lastCoveredRecord(records, coveredRecordIds);
  const hasDeferredSuffix = response.records.some((record) => record.orderKey > last.orderKey)
    || (response.replacementRange?.endOrderKey ?? last.orderKey) > last.orderKey;
  const newerCursor = hasDeferredSuffix && retainedLast
    ? current.newerCursor ?? trajectoryCursor('after', retainedLast.id)
    : response.newerCursor;
  return {
    closeInspector: false,
    followingTail,
    window: {
      coveredRecordIds,
      records,
      olderCursor: current.olderCursor,
      newerCursor,
    },
  };
}

function responseJoinsLoadedCoverage(
  current: TrajectoryWorkingWindow,
  response: ThreadTrajectoryReadResponse,
): boolean {
  if (response.olderCursor === null) return true;
  if (response.records.some((record) => current.coveredRecordIds.has(record.id))) return true;
  const first = current.records[0];
  const last = current.records.at(-1);
  const range = response.replacementRange;
  return Boolean(first && last && range
    && range.startOrderKey <= last.orderKey
    && range.endOrderKey >= first.orderKey);
}

function lastCoveredRecord(
  records: readonly ThreadTrajectoryRecordSummary[],
  coveredRecordIds: ReadonlySet<string>,
): ThreadTrajectoryRecordSummary | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && coveredRecordIds.has(record.id)) return record;
  }
  return null;
}

function retainRecordCoverage(
  records: readonly ThreadTrajectoryRecordSummary[],
  coveredRecordIds: ReadonlySet<string>,
  edge: 'oldest' | 'newest',
): {
  readonly coveredRecords: readonly ThreadTrajectoryRecordSummary[];
  readonly records: readonly ThreadTrajectoryRecordSummary[];
} {
  const sorted = mergeRecords([], records);
  const allCoveredRecords = sorted.filter((record) => coveredRecordIds.has(record.id));
  const coveredRecords = allCoveredRecords.length <= TRAJECTORY_WINDOW_RECORD_LIMIT
    ? allCoveredRecords
    : edge === 'oldest'
      ? allCoveredRecords.slice(0, TRAJECTORY_WINDOW_RECORD_LIMIT)
      : allCoveredRecords.slice(-TRAJECTORY_WINDOW_RECORD_LIMIT);
  return {
    coveredRecords,
    records: structuralClosure(coveredRecords, sorted),
  };
}

function selectedPageRetained(
  current: TrajectoryWorkingWindow,
  retainedCoverage: readonly ThreadTrajectoryRecordSummary[],
  selectedRecordId: string | null,
): boolean {
  if (!selectedRecordId) return true;
  const covered = current.records.filter((record) => current.coveredRecordIds.has(record.id));
  const selectedIndex = covered.findIndex((record) => record.id === selectedRecordId);
  if (selectedIndex < 0) return true;
  const pageStart = Math.floor(selectedIndex / TRAJECTORY_PAGE_LIMIT) * TRAJECTORY_PAGE_LIMIT;
  const retainedIds = new Set(retainedCoverage.map((record) => record.id));
  return covered.slice(pageStart, pageStart + TRAJECTORY_PAGE_LIMIT)
    .every((record) => retainedIds.has(record.id));
}

function responseCoveredRecordIds(response: ThreadTrajectoryReadResponse): ReadonlySet<string> {
  const range = response.replacementRange;
  return new Set(response.records
    .filter((record) => !range || orderKeyInRange(record.orderKey, range))
    .map((record) => record.id));
}

function structuralClosure(
  coveredRecords: readonly ThreadTrajectoryRecordSummary[],
  availableRecords: readonly ThreadTrajectoryRecordSummary[],
): readonly ThreadTrajectoryRecordSummary[] {
  const included = new Set(coveredRecords.map((record) => record.id));
  const byId = new Map(availableRecords.map((record) => [record.id, record]));
  for (const record of coveredRecords) {
    const visited = new Set<string>();
    let parentId = record.parentRecordId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      included.add(parent.id);
      parentId = parent.parentRecordId;
    }
  }
  return availableRecords.filter((record) => included.has(record.id));
}

function mergeRecords(
  current: readonly ThreadTrajectoryRecordSummary[],
  incoming: readonly ThreadTrajectoryRecordSummary[],
): readonly ThreadTrajectoryRecordSummary[] {
  const byId = new Map<string, ThreadTrajectoryRecordSummary>();
  for (const record of current) byId.set(record.id, record);
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => left.orderKey.localeCompare(right.orderKey));
}

function replaceRecordsForIncomingWindow(
  current: readonly ThreadTrajectoryRecordSummary[],
  incoming: readonly ThreadTrajectoryRecordSummary[],
  replacementRange: ThreadTrajectoryReplacementRange | null,
  canonicalTurnCount: number,
): readonly ThreadTrajectoryRecordSummary[] {
  if (!replacementRange) return incoming;
  const incomingIds = new Set(incoming.map((record) => record.id));
  const canonicalTurnIds = canonicalTurnIdsByIndex(incoming);
  const replacedThreadItems = new Set(incoming.flatMap((record) => (
    [record.primaryEvidence, ...record.relatedEvidence]
      .filter((evidence) => evidence.type === 'threadItem')
      .map((evidence) => `${evidence.turnId}:${evidence.itemId}`)
  )));
  return mergeRecords(
    current.filter((record) => (
      !incomingIds.has(record.id)
      && record.turnIndex < canonicalTurnCount
      && !orderKeyInRange(record.orderKey, replacementRange)
      && !staleTurnPositionRecord(record, canonicalTurnIds)
      && !staleFallbackRecord(record, replacedThreadItems)
    )),
    incoming,
  );
}

function canonicalTurnIdsByIndex(
  records: readonly ThreadTrajectoryRecordSummary[],
): ReadonlyMap<number, string | null> {
  const turnIds = new Map<number, string | null>();
  for (const record of records) {
    const existing = turnIds.get(record.turnIndex);
    if (existing === undefined) turnIds.set(record.turnIndex, record.turnId);
    else if (existing !== record.turnId) turnIds.set(record.turnIndex, null);
  }
  return turnIds;
}

function staleTurnPositionRecord(
  record: ThreadTrajectoryRecordSummary,
  canonicalTurnIds: ReadonlyMap<number, string | null>,
): boolean {
  const canonicalTurnId = canonicalTurnIds.get(record.turnIndex);
  return canonicalTurnId !== undefined
    && canonicalTurnId !== null
    && canonicalTurnId !== record.turnId;
}

function staleFallbackRecord(
  record: ThreadTrajectoryRecordSummary,
  replacedThreadItems: ReadonlySet<string>,
): boolean {
  const evidence = record.primaryEvidence;
  return evidence.type === 'threadItem'
    && record.state !== 'completed'
    && replacedThreadItems.has(`${evidence.turnId}:${evidence.itemId}`);
}

function intersectRange(
  range: ThreadTrajectoryReplacementRange | null,
  startOrderKey: string,
  endOrderKey: string,
): ThreadTrajectoryReplacementRange | null {
  if (!range || range.endOrderKey < startOrderKey || range.startOrderKey > endOrderKey) return null;
  return {
    startOrderKey: range.startOrderKey < startOrderKey ? startOrderKey : range.startOrderKey,
    endOrderKey: range.endOrderKey > endOrderKey ? endOrderKey : range.endOrderKey,
  };
}

function orderKeyInRange(orderKey: string, range: ThreadTrajectoryReplacementRange): boolean {
  return orderKey >= range.startOrderKey && orderKey <= range.endOrderKey;
}

function trajectoryCursor(direction: 'after' | 'before', recordId: string): string {
  return `${direction}:${encodeURIComponent(recordId)}`;
}
