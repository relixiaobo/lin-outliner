import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AgentCoreNotification,
  ThreadTrajectoryReadResponse,
  ThreadTrajectoryRecordSummary,
} from '../../../core/agent/protocol';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { formatNumber } from '../../ui/formatting';
import { LoaderIcon } from '../../ui/icons';
import { PanelStickyBreadcrumb, type PanelDragHandle } from '../../ui/PanelShared';
import { EmptyState, ErrorState } from '../../ui/primitives/FeedbackState';
import { TrajectoryInspector } from './trajectory/TrajectoryInspector';
import { TrajectoryLedger } from './trajectory/TrajectoryLedger';
import { TrajectoryTimeline } from './trajectory/TrajectoryTimeline';
import { TrajectoryToolbar } from './trajectory/TrajectoryToolbar';
import {
  buildTrajectoryLedgerRows,
  buildTrajectoryTimeline,
  groupTrajectoryRecords,
  isSystemLevelRecord,
  trajectoryRecordsInRange,
  trajectorySearchMatches,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from './trajectory/trajectoryModel';

interface ThreadTrajectoryPanelProps {
  readonly canGoBack: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly onOpenThreadTrajectory: (threadId: string) => void;
  readonly panelDragHandle?: PanelDragHandle;
  readonly selectedRecordId?: string;
  readonly showClose: boolean;
  readonly threadId: string;
  readonly turnId?: string;
}

type TrajectoryExportResult =
  | { readonly status: 'written'; readonly fileName: string; readonly byteLength: number }
  | { readonly status: 'canceled' }
  | { readonly status: 'failed'; readonly error: string };

const PAGE_LIMIT = 120;
const EMPTY_RECORDS: readonly ThreadTrajectoryRecordSummary[] = Object.freeze([]);

export function ThreadTrajectoryPanel({
  canGoBack,
  onBack,
  onClose,
  onOpenThreadTrajectory,
  panelDragHandle,
  selectedRecordId,
  showClose,
  threadId,
  turnId,
}: ThreadTrajectoryPanelProps) {
  const t = useT();
  const stickyBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const loadSeqRef = useRef(0);
  const recordsRef = useRef<readonly ThreadTrajectoryRecordSummary[]>(EMPTY_RECORDS);
  const selectedIdRef = useRef<string | null>(selectedRecordId ?? null);
  const [page, setPage] = useState<ThreadTrajectoryReadResponse | null>(null);
  const [records, setRecords] = useState<readonly ThreadTrajectoryRecordSummary[]>(EMPTY_RECORDS);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selectedRecordId ?? null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<TrajectoryTimelineMode>('duration');
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<string>>(() => new Set());
  const [followingTail, setFollowingTail] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { recordsRef.current = records; }, [records]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const loadTrajectory = useCallback(async (options: {
    readonly cursor?: string | null;
    readonly silent?: boolean;
  } = {}) => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const loadingOlderPage = Boolean(options.cursor);
    if (loadingOlderPage) setLoadingOlder(true);
    else if (!options.silent && recordsRef.current.length === 0) setLoading(true);
    setError(null);
    try {
      const response = await api.agentCoreRequest('thread/trajectory/read', {
        threadId,
        cursor: options.cursor ?? null,
        limit: PAGE_LIMIT,
        focus: options.cursor ? null : {
          recordId: selectedIdRef.current ?? selectedRecordId ?? null,
          turnId: selectedIdRef.current ? null : turnId ?? null,
        },
      });
      if (loadSeqRef.current !== seq) return;
      const current = recordsRef.current;
      const nextRecords = current.length === 0
        ? response.records
        : mergeRecords(current, response.records);
      recordsRef.current = nextRecords;
      setPage(response);
      setRecords(nextRecords);
      if (current.length === 0 || loadingOlderPage) setNextCursor(response.nextCursor);
      setSelectedId((currentSelection) => currentSelection ?? response.selectedRecordId);
    } catch (loadError) {
      if (loadSeqRef.current === seq) setError(errorMessage(loadError));
    } finally {
      if (loadSeqRef.current === seq) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, [selectedRecordId, threadId, turnId]);

  useEffect(() => {
    recordsRef.current = EMPTY_RECORDS;
    selectedIdRef.current = selectedRecordId ?? null;
    setPage(null);
    setRecords(EMPTY_RECORDS);
    setNextCursor(null);
    setSelectedId(selectedRecordId ?? null);
    setQuery('');
    setRange(null);
    setCollapsedTurns(new Set());
    setCollapsedCalls(new Set());
    setFollowingTail(true);
    void loadTrajectory();
  }, [loadTrajectory, selectedRecordId, threadId, turnId]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = api.onAgentCoreNotification((notification) => {
      if (!trajectoryRelevantNotification(notification, threadId)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void loadTrajectory({ silent: true });
      }, 120);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [loadTrajectory, threadId]);

  const recordById = useMemo(
    () => new Map(records.map((record) => [record.id, record])),
    [records],
  );
  const turnGroups = useMemo(() => groupTrajectoryRecords(records), [records]);
  const collapsibleTurnGroups = useMemo(
    () => turnGroups.filter((group) => group.records.some((record) => !isSystemLevelRecord(record))),
    [turnGroups],
  );
  const turnIndexById = useMemo(
    () => new Map(turnGroups.map((group) => [group.turnId, group.index])),
    [turnGroups],
  );
  const callIds = useMemo(() => {
    const result = new Set<string>();
    for (const record of records) {
      if (record.parentRecordId) result.add(record.parentRecordId);
    }
    return result;
  }, [records]);
  const searchMatches = useMemo(() => trajectorySearchMatches(records, query), [query, records]);
  const timeline = useMemo(() => buildTrajectoryTimeline(records, mode), [mode, records]);
  const rangeMatches = useMemo(() => trajectoryRecordsInRange(timeline, range), [range, timeline]);
  const ledgerRows = useMemo(() => buildTrajectoryLedgerRows({
    collapsedCalls,
    collapsedTurns,
    rangeMatches,
    records,
    searchMatches,
  }), [collapsedCalls, collapsedTurns, rangeMatches, records, searchMatches]);
  const selectedRecord = selectedId ? recordById.get(selectedId) ?? null : null;
  const allTurnsCollapsed = collapsibleTurnGroups.length > 0
    && collapsibleTurnGroups.every((group) => collapsedTurns.has(group.turnId));
  const allCallsCollapsed = callIds.size > 0
    && [...callIds].every((recordId) => collapsedCalls.has(recordId));

  const selectRecord = useCallback((recordId: string) => {
    setSelectedId(recordId);
    setFollowingTail(false);
  }, []);

  const changeRange = useCallback((nextRange: TrajectoryTimeRange | null) => {
    setRange(nextRange);
    if (nextRange) setFollowingTail(false);
  }, []);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingOlder) return;
    await loadTrajectory({ cursor: nextCursor });
  }, [loadTrajectory, loadingOlder, nextCursor]);

  const exportTrajectory = useCallback(async () => {
    if (exportBusy) return;
    setExportBusy(true);
    setExportStatus(null);
    try {
      const result = await api.agentCoreRequest('thread/trajectory/export', { threadId });
      setExportStatus(exportResultText(result, t));
    } catch (exportError) {
      setExportStatus(errorMessage(exportError));
    } finally {
      setExportBusy(false);
    }
  }, [exportBusy, t, threadId]);

  return (
    <main className="main-panel thread-trajectory-panel">
      <PanelStickyBreadcrumb
        breadcrumbAriaLabel={t.nodePanel.breadcrumbAriaLabel}
        canGoBack={canGoBack}
        closeLabel={t.nodePanel.closePanel}
        currentTitle={t.agent.trajectory.title}
        dragHandle={panelDragHandle}
        origin={null}
        onBack={onBack}
        onClose={onClose}
        previousPageLabel={t.nodePanel.previousPage}
        showClose={showClose}
        stickyRef={stickyBreadcrumbRef}
        titleDocked={false}
      >
        <span className="panel-breadcrumb-segment panel-breadcrumb-current">
          <span className="panel-breadcrumb-current-label" data-current-page-title>
            {t.agent.trajectory.title}
          </span>
        </span>
      </PanelStickyBreadcrumb>
      <div className="thread-trajectory-content">
        {loading && records.length === 0 ? (
          <EmptyState icon={LoaderIcon} loading role="status" title={t.agent.trajectory.loading} />
        ) : null}
        {error && records.length === 0 ? (
          <ErrorState
            message={error}
            onRetry={() => void loadTrajectory()}
            retryLabel={t.agent.trajectory.retry}
          />
        ) : null}
        {page && records.length > 0 ? (
          <>
            <TrajectoryToolbar
              allCallsCollapsed={allCallsCollapsed}
              allTurnsCollapsed={allTurnsCollapsed}
              exportBusy={exportBusy}
              followingTail={followingTail}
              mode={mode}
              onExport={() => void exportTrajectory()}
              onFollowTail={() => setFollowingTail(true)}
              onModeChange={(nextMode) => {
                setMode(nextMode);
                setRange(null);
              }}
              onQueryChange={setQuery}
              onRefresh={() => void loadTrajectory()}
              onToggleAllCalls={() => setCollapsedCalls(
                allCallsCollapsed ? new Set() : new Set(callIds),
              )}
              onToggleAllTurns={() => setCollapsedTurns(
                allTurnsCollapsed ? new Set() : new Set(collapsibleTurnGroups.map((group) => group.turnId)),
              )}
              query={query}
              summary={page.summary}
            />
            {exportStatus ? (
              <div className="thread-trajectory-export-status" role="status">{exportStatus}</div>
            ) : null}
            <TrajectoryTimeline
              key={threadId}
              hasEarlierRecords={nextCursor !== null}
              loadingEarlier={loadingOlder}
              mode={mode}
              model={timeline}
              onLoadEarlier={() => void loadOlder()}
              onRangeChange={changeRange}
              onRecordSelect={selectRecord}
              range={range}
              searchMatches={searchMatches}
              selectedRecordId={selectedRecord?.id ?? null}
            />
            <div className={`thread-trajectory-workspace${selectedRecord ? ' has-selection' : ''}`}>
              <TrajectoryLedger
                key={threadId}
                following={followingTail}
                hasEarlierRecords={nextCursor !== null}
                loadingEarlier={loadingOlder}
                onFollowingChange={setFollowingTail}
                onLoadEarlier={loadOlder}
                onRecordSelect={selectRecord}
                onToggleCall={(recordId) => setCollapsedCalls((current) => toggledSet(current, recordId))}
                onToggleTurn={(turnIdValue) => setCollapsedTurns((current) => toggledSet(current, turnIdValue))}
                rangeActive={range !== null}
                rows={ledgerRows}
                searchActive={query.trim().length > 0}
                selectedRecordId={selectedRecord?.id ?? null}
              />
              {selectedRecord ? (
                <TrajectoryInspector
                  onClose={() => setSelectedId(null)}
                  onOpenChildTrajectory={onOpenThreadTrajectory}
                  record={selectedRecord}
                  threadId={threadId}
                  turnIndex={turnIndexById.get(selectedRecord.turnId) ?? 0}
                />
              ) : null}
            </div>
          </>
        ) : null}
        {!loading && !error && page && records.length === 0 ? (
          <EmptyState title={t.agent.trajectory.empty} />
        ) : null}
      </div>
    </main>
  );
}

function toggledSet(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function mergeRecords(
  current: readonly ThreadTrajectoryRecordSummary[],
  incoming: readonly ThreadTrajectoryRecordSummary[],
): readonly ThreadTrajectoryRecordSummary[] {
  const byId = new Map<string, ThreadTrajectoryRecordSummary>();
  for (const record of current) byId.set(record.id, record);
  for (const record of incoming) byId.set(record.id, record);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function trajectoryRelevantNotification(notification: AgentCoreNotification, threadId: string): boolean {
  if (!('threadId' in notification) || notification.threadId !== threadId) return false;
  return notification.type === 'turn/started'
    || notification.type === 'item/started'
    || notification.type === 'item/delta'
    || notification.type === 'item/completed'
    || notification.type === 'items/completed'
    || notification.type === 'turn/completed'
    || notification.type === 'turn/providerRetry/changed'
    || notification.type === 'turn/plan/updated'
    || notification.type === 'subagent/execution/changed';
}

function exportResultText(result: TrajectoryExportResult, t: ReturnType<typeof useT>): string {
  if (result.status === 'written') {
    return t.agent.trajectory.exportWritten({
      fileName: result.fileName,
      byteLength: formatNumber(result.byteLength),
    });
  }
  if (result.status === 'canceled') return t.agent.trajectory.exportCanceled;
  return result.error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
