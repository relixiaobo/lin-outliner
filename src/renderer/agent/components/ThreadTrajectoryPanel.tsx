import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  RendererAgentCoreNotification,
  ThreadTrajectoryReadResponse,
  ThreadTrajectoryRecordSummary,
} from '../../../core/agent/protocol';
type AgentCoreNotification = RendererAgentCoreNotification;
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
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
  trajectorySearchMatches,
  trajectoryTimelineFocusRecords,
  type TrajectoryTimelineMode,
  type TrajectoryTimeRange,
} from './trajectory/trajectoryModel';
import {
  EMPTY_TRAJECTORY_WINDOW,
  reconcileTrajectoryWindow,
  TRAJECTORY_PAGE_LIMIT,
  type TrajectoryWindowReadKind,
  type TrajectoryWorkingWindow,
} from './trajectory/trajectoryWindow';

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
  const cursorlessGenerationRef = useRef(0);
  const cursorlessFlightRef = useRef<Promise<void> | null>(null);
  const cursorlessPendingRef = useRef(false);
  const focusConsumedRef = useRef(false);
  const recordsRef = useRef<readonly ThreadTrajectoryRecordSummary[]>(EMPTY_RECORDS);
  const windowRef = useRef<TrajectoryWorkingWindow>(EMPTY_TRAJECTORY_WINDOW);
  const selectedIdRef = useRef<string | null>(selectedRecordId ?? null);
  const followingTailRef = useRef(true);
  const [page, setPage] = useState<ThreadTrajectoryReadResponse | null>(null);
  const [records, setRecords] = useState<readonly ThreadTrajectoryRecordSummary[]>(EMPTY_RECORDS);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [newerCursor, setNewerCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selectedRecordId ?? null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<TrajectoryTimelineMode>('duration');
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  const [timelineRecordFocus, setTimelineRecordFocus] = useState<{ readonly recordId: string } | null>(null);
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const [collapsedCalls, setCollapsedCalls] = useState<ReadonlySet<string>>(() => new Set());
  const [followingTail, setFollowingTail] = useState(true);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { recordsRef.current = records; }, [records]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const loadTrajectory = useCallback(async (options: {
    readonly cursor?: string | null;
    readonly kind?: TrajectoryWindowReadKind;
    readonly silent?: boolean;
  } = {}) => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const loadingNewerPage = options.cursor?.startsWith('after:') ?? false;
    const loadingOlderPage = options.cursor !== undefined
      && options.cursor !== null
      && !loadingNewerPage;
    const kind = options.kind ?? (loadingNewerPage ? 'newer' : loadingOlderPage ? 'older' : 'initial');
    const focus = trajectoryReadFocus({
      cursor: options.cursor ?? null,
      focusConsumed: focusConsumedRef.current,
      selectedRecordId: selectedIdRef.current ?? selectedRecordId ?? null,
      turnId,
    });
    const applyingFocus = focus !== null;
    if (loadingNewerPage) setLoadingNewer(true);
    else if (loadingOlderPage) setLoadingOlder(true);
    else if (!options.silent && recordsRef.current.length === 0) setLoading(true);
    setError(null);
    try {
      const response = await api.agentCoreRequest('thread/trajectory/read', {
        threadId,
        cursor: options.cursor ?? null,
        limit: TRAJECTORY_PAGE_LIMIT,
        focus,
      });
      if (loadSeqRef.current !== seq) return;
      if (applyingFocus) focusConsumedRef.current = true;
      const current = windowRef.current;
      const reconciliation = reconcileTrajectoryWindow(
        current,
        response,
        kind,
        followingTailRef.current,
        selectedIdRef.current,
      );
      const nextWindow = reconciliation.window;
      windowRef.current = nextWindow;
      recordsRef.current = nextWindow.records;
      setPage(response);
      setRecords(nextWindow.records);
      setOlderCursor(nextWindow.olderCursor);
      setNewerCursor(nextWindow.newerCursor);
      followingTailRef.current = reconciliation.followingTail;
      setFollowingTail(reconciliation.followingTail);
      const focusSelection = applyingFocus ? response.selectedRecordId : null;
      setSelectedId((currentSelection) => {
        const nextSelection = reconciliation.closeInspector
          ? null
          : currentSelection ?? focusSelection;
        selectedIdRef.current = nextSelection;
        return nextSelection;
      });
    } catch (loadError) {
      if (loadSeqRef.current === seq) setError(errorMessage(loadError));
    } finally {
      if (loadSeqRef.current === seq) {
        setLoading(false);
        setLoadingOlder(false);
        setLoadingNewer(false);
      }
    }
  }, [selectedRecordId, threadId, turnId]);

  const loadCursorless = useCallback((silent = false): Promise<void> => {
    const generation = cursorlessGenerationRef.current;
    const active = cursorlessFlightRef.current;
    if (active) {
      if (silent) cursorlessPendingRef.current = true;
      return active;
    }
    const run = async () => {
      let nextSilent = silent;
      do {
        if (cursorlessGenerationRef.current !== generation) return;
        cursorlessPendingRef.current = false;
        await loadTrajectory({ kind: nextSilent ? 'refresh' : 'initial', silent: nextSilent });
        if (cursorlessGenerationRef.current !== generation) return;
        nextSilent = true;
      } while (cursorlessPendingRef.current);
    };
    const flight = run().finally(() => {
      if (cursorlessFlightRef.current === flight) cursorlessFlightRef.current = null;
    });
    cursorlessFlightRef.current = flight;
    return flight;
  }, [loadTrajectory]);

  useEffect(() => {
    cursorlessGenerationRef.current += 1;
    focusConsumedRef.current = false;
    loadSeqRef.current += 1;
    cursorlessFlightRef.current = null;
    cursorlessPendingRef.current = false;
    recordsRef.current = EMPTY_RECORDS;
    windowRef.current = EMPTY_TRAJECTORY_WINDOW;
    selectedIdRef.current = selectedRecordId ?? null;
    followingTailRef.current = true;
    setPage(null);
    setRecords(EMPTY_RECORDS);
    setOlderCursor(null);
    setNewerCursor(null);
    setSelectedId(selectedRecordId ?? null);
    setQuery('');
    setRange(null);
    setTimelineRecordFocus(null);
    setCollapsedTurns(new Set());
    setCollapsedCalls(new Set());
    setFollowingTail(true);
    void loadCursorless();
  }, [loadCursorless, selectedRecordId, threadId, turnId]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = api.onAgentCoreNotification((notification) => {
      if (!trajectoryRelevantNotification(notification, threadId)) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void loadCursorless(true);
      }, 120);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [loadCursorless, threadId]);

  const recordById = useMemo(
    () => new Map(records.map((record) => [record.id, record])),
    [records],
  );
  const turnGroups = useMemo(() => groupTrajectoryRecords(records), [records]);
  const collapsibleTurnGroups = useMemo(
    () => turnGroups.filter((group) => group.records.some((record) => !isSystemLevelRecord(record))),
    [turnGroups],
  );
  const callIds = useMemo(() => {
    const result = new Set<string>();
    for (const record of records) {
      if (record.parentRecordId) result.add(record.parentRecordId);
    }
    return result;
  }, [records]);
  const searchMatches = useMemo(
    () => trajectorySearchMatches(records, query, t.agent.trajectory),
    [query, records, t.agent.trajectory],
  );
  const timeline = useMemo(() => buildTrajectoryTimeline(records, mode), [mode, records]);
  const timelineFocusRecords = useMemo(() => (
    trajectoryTimelineFocusRecords(timeline, range)
  ), [range, timeline]);
  const ledgerRows = useMemo(() => buildTrajectoryLedgerRows({
    collapsedCalls,
    collapsedTurns,
    records,
    searchMatches,
    selectedRecordId: selectedId,
    labels: t.agent.trajectory,
  }), [collapsedCalls, collapsedTurns, records, searchMatches, selectedId, t.agent.trajectory]);
  const selectedRecord = selectedId ? recordById.get(selectedId) ?? null : null;
  const toolCallRecordIds = useMemo(() => {
    const result = new Map<string, string>();
    if (!selectedRecord) return result;
    for (const candidate of records) {
      if (candidate.parentRecordId !== selectedRecord.id) continue;
      for (const evidence of [candidate.primaryEvidence, ...candidate.relatedEvidence]) {
        if (evidence.type === 'toolExecution') result.set(evidence.callId, candidate.id);
      }
    }
    return result;
  }, [records, selectedRecord]);
  const allTurnsCollapsed = collapsibleTurnGroups.length > 0
    && collapsibleTurnGroups.every((group) => collapsedTurns.has(group.turnId));
  const allCallsCollapsed = callIds.size > 0
    && [...callIds].every((recordId) => collapsedCalls.has(recordId));

  const selectRecord = useCallback((recordId: string) => {
    selectedIdRef.current = recordId;
    focusConsumedRef.current = true;
    setSelectedId(recordId);
    followingTailRef.current = false;
    setFollowingTail(false);
  }, []);

  const focusRecord = useCallback((recordId: string) => {
    setTimelineRecordFocus({ recordId });
    followingTailRef.current = false;
    setFollowingTail(false);
  }, []);

  const closeInspector = useCallback(() => {
    selectedIdRef.current = null;
    focusConsumedRef.current = true;
    setSelectedId(null);
  }, []);

  const changeRange = useCallback((nextRange: TrajectoryTimeRange | null) => {
    setRange(nextRange);
    if (nextRange) {
      followingTailRef.current = false;
      setFollowingTail(false);
    }
  }, []);

  const changeFollowing = useCallback((nextFollowing: boolean) => {
    followingTailRef.current = nextFollowing;
    setFollowingTail(nextFollowing);
  }, []);

  const changeMode = useCallback((nextMode: TrajectoryTimelineMode) => {
    setMode(nextMode);
    setRange(null);
    setTimelineRecordFocus(null);
  }, []);

  const toggleAllTurns = useCallback(() => {
    setCollapsedTurns(allTurnsCollapsed
      ? new Set()
      : new Set(collapsibleTurnGroups.map((group) => group.turnId)));
  }, [allTurnsCollapsed, collapsibleTurnGroups]);

  const toggleAllCalls = useCallback(() => {
    setCollapsedCalls(allCallsCollapsed ? new Set() : new Set(callIds));
  }, [allCallsCollapsed, callIds]);

  const loadOlder = useCallback(async () => {
    if (!olderCursor || loadingOlder) return;
    await loadTrajectory({ cursor: olderCursor });
  }, [loadTrajectory, loadingOlder, olderCursor]);

  const loadNewer = useCallback(async () => {
    if (!newerCursor || loadingNewer) return;
    await loadTrajectory({ cursor: newerCursor });
  }, [loadTrajectory, loadingNewer, newerCursor]);

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
            onRetry={() => void loadCursorless()}
            retryLabel={t.agent.trajectory.retry}
          />
        ) : null}
        {page && records.length > 0 ? (
          <>
            <TrajectoryToolbar
              allCallsCollapsed={allCallsCollapsed}
              allTurnsCollapsed={allTurnsCollapsed}
              callCount={callIds.size}
              mode={mode}
              onModeChange={changeMode}
              onQueryChange={setQuery}
              onToggleAllCalls={toggleAllCalls}
              onToggleAllTurns={toggleAllTurns}
              query={query}
              turnCount={collapsibleTurnGroups.length}
            />
            <TrajectoryTimeline
              key={threadId}
              hasEarlierRecords={olderCursor !== null}
              loadingEarlier={loadingOlder}
              mode={mode}
              model={timeline}
              onLoadEarlier={() => void loadOlder()}
              onRecordFocus={focusRecord}
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
                hasEarlierRecords={olderCursor !== null}
                hasLaterRecords={newerCursor !== null}
                loadingEarlier={loadingOlder}
                loadingLater={loadingNewer}
                onFollowingChange={changeFollowing}
                onLoadEarlier={loadOlder}
                onLoadLater={loadNewer}
                onRecordSelect={selectRecord}
                onToggleCall={(recordId) => setCollapsedCalls((current) => toggledSet(current, recordId))}
                onToggleTurn={(turnIdValue) => setCollapsedTurns((current) => toggledSet(current, turnIdValue))}
                timelineFocusActive={range !== null}
                timelineFocusRecords={timelineFocusRecords}
                recordFocus={timelineRecordFocus}
                rows={ledgerRows}
                searchActive={query.trim().length > 0}
                selectedRecordId={selectedRecord?.id ?? null}
              />
              {selectedRecord ? (
                <TrajectoryInspector
                  onClose={closeInspector}
                  onOpenChildTrajectory={onOpenThreadTrajectory}
                  onOpenRecord={selectRecord}
                  record={selectedRecord}
                  threadId={threadId}
                  toolCallRecordIds={toolCallRecordIds}
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

function trajectoryReadFocus({
  cursor,
  focusConsumed,
  selectedRecordId,
  turnId,
}: {
  readonly cursor: string | null;
  readonly focusConsumed: boolean;
  readonly selectedRecordId: string | null;
  readonly turnId?: string;
}): { readonly recordId: string | null; readonly turnId: string | null } | null {
  if (cursor !== null || focusConsumed) return null;
  if (selectedRecordId) return { recordId: selectedRecordId, turnId: null };
  return turnId ? { recordId: null, turnId } : null;
}

function toggledSet(current: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
