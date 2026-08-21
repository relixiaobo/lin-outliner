import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AgentCoreNotification,
  JsonValue,
  ThreadTrajectoryDetailReadResponse,
  ThreadTrajectoryRecordDetail,
  ThreadTrajectoryRecordKind,
  ThreadTrajectoryRecordSummary,
  ThreadTrajectoryReadResponse,
  ThreadTrajectorySummary,
  ThreadTrajectoryTimingSummary,
  ThreadTrajectoryUsageSummary,
} from '../../../core/agent/protocol';
import { api } from '../../api/client';
import { useI18n, useT } from '../../i18n/I18nProvider';
import { formatDateTime, formatNumber } from '../../ui/formatting';
import {
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  ICON_SIZE,
  LoaderIcon,
  RefreshIcon,
  SearchIcon,
} from '../../ui/icons';
import { PanelStickyBreadcrumb, type PanelDragHandle } from '../../ui/PanelShared';
import { ReadOnlyCodeBlock } from '../../ui/editor/CodeBlockSurface';
import { Button } from '../../ui/primitives/Button';
import { EmptyState, ErrorState } from '../../ui/primitives/FeedbackState';
import { IconButton } from '../../ui/primitives/IconButton';

interface ThreadTrajectoryPanelProps {
  readonly canGoBack: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly panelDragHandle?: PanelDragHandle;
  readonly selectedRecordId?: string;
  readonly showClose: boolean;
  readonly threadId: string;
  readonly turnId?: string;
}

type TimelineMode = 'sequence' | 'duration';
type InspectorTab = 'summary' | 'request' | 'response' | 'arguments' | 'result' | 'schema' | 'audit' | 'timing' | 'export' | 'source';
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
  panelDragHandle,
  selectedRecordId,
  showClose,
  threadId,
  turnId,
}: ThreadTrajectoryPanelProps) {
  const t = useT();
  const stickyBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState<ThreadTrajectoryReadResponse | null>(null);
  const [records, setRecords] = useState<readonly ThreadTrajectoryRecordSummary[]>(EMPTY_RECORDS);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(selectedRecordId ?? null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<TimelineMode>('sequence');
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);
  const selectedIdRef = useRef<string | null>(selectedRecordId ?? null);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const loadTrajectory = useCallback(async (options: {
    readonly cursor?: string | null;
    readonly silent?: boolean;
  } = {}) => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    if (options.cursor) setLoadingOlder(true);
    else if (!options.silent) setLoading(true);
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
      setPage(response);
      setNextCursor(response.nextCursor);
      setRecords((current) => options.cursor
        ? mergeRecords(response.records, current)
        : response.records);
      setSelectedId((current) => current ?? response.selectedRecordId);
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
    selectedIdRef.current = selectedRecordId ?? null;
    setSelectedId(selectedRecordId ?? null);
    setRecords(EMPTY_RECORDS);
    setPage(null);
    setNextCursor(null);
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
  const selectedRecord = selectedId ? recordById.get(selectedId) ?? null : null;
  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return records;
    return records.filter((record) => recordSearchText(record).includes(normalized));
  }, [query, records]);

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
      <div className="panel-inner thread-trajectory-content">
        <TrajectoryToolbar
          canLoadOlder={nextCursor !== null}
          loadingOlder={loadingOlder}
          mode={mode}
          onLoadOlder={() => {
            if (nextCursor) void loadTrajectory({ cursor: nextCursor });
          }}
          onModeChange={setMode}
          onQueryChange={setQuery}
          onRefresh={() => void loadTrajectory()}
          query={query}
        />
        {loading && records.length === 0 ? (
          <EmptyState icon={LoaderIcon} loading role="status" title={t.agent.trajectory.loading} />
        ) : null}
        {error ? (
          <ErrorState
            message={error}
            onRetry={() => void loadTrajectory()}
            retryLabel={t.agent.trajectory.retry}
          />
        ) : null}
        {page && records.length > 0 ? (
          <>
            <TrajectorySummaryView summary={page.summary} />
            <TrajectoryOverview
              mode={mode}
              onSelect={setSelectedId}
              records={filteredRecords}
              selectedRecordId={selectedRecord?.id ?? null}
            />
            <div className="thread-trajectory-workspace">
              <TrajectoryLedger
                onSelect={setSelectedId}
                records={filteredRecords}
                searchActive={query.trim().length > 0}
                selectedRecordId={selectedRecord?.id ?? null}
              />
              <TrajectoryInspector
                onExportThread={async () => await api.agentCoreRequest('thread/trajectory/export', { threadId })}
                record={selectedRecord}
                threadId={threadId}
              />
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

function TrajectoryToolbar({
  canLoadOlder,
  loadingOlder,
  mode,
  onLoadOlder,
  onModeChange,
  onQueryChange,
  onRefresh,
  query,
}: {
  readonly canLoadOlder: boolean;
  readonly loadingOlder: boolean;
  readonly mode: TimelineMode;
  readonly onLoadOlder: () => void;
  readonly onModeChange: (mode: TimelineMode) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly query: string;
}) {
  const t = useT();
  return (
    <section className="thread-trajectory-toolbar" aria-label={t.agent.trajectory.toolbar}>
      <label className="thread-trajectory-search">
        <SearchIcon size={ICON_SIZE.menu} />
        <input
          aria-label={t.agent.trajectory.search}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder={t.agent.trajectory.search}
          type="search"
          value={query}
        />
      </label>
      <div className="thread-trajectory-toolbar-actions">
        <Button
          disabled={!canLoadOlder || loadingOlder}
          onClick={onLoadOlder}
          type="button"
          variant="secondary"
        >
          {loadingOlder ? t.agent.trajectory.loadingOlder : t.agent.trajectory.loadOlder}
        </Button>
        <Button
          onClick={() => onModeChange(mode === 'sequence' ? 'duration' : 'sequence')}
          type="button"
          variant="secondary"
        >
          <ClockIcon size={ICON_SIZE.menu} />
          {mode === 'sequence' ? t.agent.trajectory.sequenceMode : t.agent.trajectory.durationMode}
        </Button>
        <IconButton icon={RefreshIcon} label={t.agent.trajectory.refresh} onClick={onRefresh} variant="chrome" />
      </div>
    </section>
  );
}

function TrajectorySummaryView({ summary }: { readonly summary: ThreadTrajectorySummary }) {
  const t = useT();
  return (
    <section className="thread-trajectory-summary" aria-label={t.agent.trajectory.summary}>
      <SummaryFact label={t.agent.trajectory.turns} value={formatNumber(summary.turnCount)} />
      <SummaryFact label={t.agent.trajectory.records} value={formatNumber(summary.recordCount)} />
      <SummaryFact label={t.agent.trajectory.assistantCalls} value={formatNumber(summary.assistantCount)} />
      <SummaryFact label={t.agent.trajectory.tools} value={formatNumber(summary.toolCount + summary.delegationCount)} />
      <SummaryFact label={t.agent.trajectory.tokens} value={summary.usage ? formatNumber(summary.usage.totalTokens) : '-'} />
      <SummaryFact label={t.agent.trajectory.coverage} value={summary.availability.length === 0 ? t.agent.trajectory.complete : t.agent.trajectory.partial} />
    </section>
  );
}

function SummaryFact({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function TrajectoryOverview({
  mode,
  onSelect,
  records,
  selectedRecordId,
}: {
  readonly mode: TimelineMode;
  readonly onSelect: (recordId: string) => void;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly selectedRecordId: string | null;
}) {
  const t = useT();
  const byLane = useMemo(() => ({
    input: records.filter((record) => record.lane === 'input'),
    assistant: records.filter((record) => record.lane === 'assistant'),
    tools: records.filter((record) => record.lane === 'tools'),
  }), [records]);
  return (
    <section className="thread-trajectory-overview" aria-label={t.agent.trajectory.overview}>
      {(['input', 'assistant', 'tools'] as const).map((lane) => (
        <div className="thread-trajectory-lane" key={lane}>
          <span className="thread-trajectory-lane-label">{t.agent.trajectory.lane[lane]}</span>
          <div className={`thread-trajectory-lane-track is-${mode}`}>
            {byLane[lane].map((record) => (
              <button
                aria-pressed={record.id === selectedRecordId}
                className={`thread-trajectory-span is-${record.kind}${record.id === selectedRecordId ? ' is-selected' : ''}`}
                key={record.id}
                onClick={() => onSelect(record.id)}
                title={`${record.title}${record.preview ? ` · ${record.preview}` : ''}`}
                type="button"
              >
                <span>{kindGlyph(record.kind)}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function TrajectoryLedger({
  onSelect,
  records,
  searchActive,
  selectedRecordId,
}: {
  readonly onSelect: (recordId: string) => void;
  readonly records: readonly ThreadTrajectoryRecordSummary[];
  readonly searchActive: boolean;
  readonly selectedRecordId: string | null;
}) {
  const t = useT();
  const { locale } = useI18n();
  const grouped = useMemo(() => groupByTurn(records), [records]);
  return (
    <section className="thread-trajectory-ledger" aria-label={t.agent.trajectory.ledger}>
      {searchActive ? <p className="thread-trajectory-scope-note">{t.agent.trajectory.searchScope}</p> : null}
      {grouped.map((group) => (
        <section className="thread-trajectory-turn-group" key={group.turnId}>
          <header className="thread-trajectory-turn-header">
            <span>{t.agent.trajectory.turnLabel({ index: group.index + 1 })}</span>
            <code>{shortId(group.turnId)}</code>
          </header>
          {group.records.map((record) => (
            <button
              aria-pressed={record.id === selectedRecordId}
              className={`thread-trajectory-row is-${record.kind}${record.id === selectedRecordId ? ' is-selected' : ''}`}
              key={record.id}
              onClick={() => onSelect(record.id)}
              type="button"
            >
              <span className="thread-trajectory-row-kind">{kindGlyph(record.kind)}</span>
              <span className="thread-trajectory-row-main">
                <strong>{record.title}</strong>
                {record.preview ? <span>{record.preview}</span> : null}
              </span>
              <span className="thread-trajectory-row-meta">
                {stateLabel(record.state)}
                {record.timing.startedAt === null ? null : (
                  <time dateTime={new Date(record.timing.startedAt).toISOString()}>
                    {formatTrajectoryDateTime(record.timing.startedAt, locale)}
                  </time>
                )}
              </span>
            </button>
          ))}
        </section>
      ))}
    </section>
  );
}

function TrajectoryInspector({
  onExportThread,
  record,
  threadId,
}: {
  readonly onExportThread: () => Promise<TrajectoryExportResult>;
  readonly record: ThreadTrajectoryRecordSummary | null;
  readonly threadId: string;
}) {
  const t = useT();
  const [detail, setDetail] = useState<ThreadTrajectoryDetailReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<InspectorTab>('summary');
  const [exportResult, setExportResult] = useState<string | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    setTab('summary');
    setExportResult(null);
  }, [record?.id]);

  useEffect(() => {
    if (!record) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setDetail(null);
    setLoading(true);
    setError(null);
    void api.agentCoreRequest('thread/trajectory/detail/read', { threadId, recordId: record.id })
      .then((response) => {
        if (requestSeqRef.current === seq) setDetail(response);
      })
      .catch((detailError) => {
        if (requestSeqRef.current === seq) setError(errorMessage(detailError));
      })
      .finally(() => {
        if (requestSeqRef.current === seq) setLoading(false);
      });
  }, [record, threadId]);

  if (!record) {
    return (
      <aside className="thread-trajectory-inspector" aria-label={t.agent.trajectory.inspector}>
        <EmptyState title={t.agent.trajectory.selectRecord} />
      </aside>
    );
  }

  const detailBody = detail?.detail ?? null;
  const tabs = tabsForRecord(record.kind);
  const activeTab = tabs.includes(tab) ? tab : 'summary';
  return (
    <aside className="thread-trajectory-inspector" aria-label={t.agent.trajectory.inspector}>
      <header className="thread-trajectory-inspector-header">
        <div>
          <span className="thread-trajectory-inspector-kind">{record.kind}</span>
          <h3>{record.title}</h3>
          {record.preview ? <p>{record.preview}</p> : null}
        </div>
      </header>
      <div className="thread-trajectory-tabs" role="tablist" aria-label={t.agent.trajectory.inspectorTabs}>
        {tabs.map((entry) => (
          <button
            aria-selected={activeTab === entry}
            className={activeTab === entry ? 'is-selected' : ''}
            key={entry}
            onClick={() => setTab(entry)}
            role="tab"
            type="button"
          >
            {t.agent.trajectory.tab[entry]}
          </button>
        ))}
      </div>
      {loading && !detail ? <EmptyState icon={LoaderIcon} loading title={t.agent.trajectory.loadingDetail} /> : null}
      {error ? <ErrorState message={error} /> : null}
      {detailBody ? (
        <InspectorTabBody
          detail={detailBody}
          exportResult={exportResult}
          onCopyRecord={() => void navigator.clipboard.writeText(JSON.stringify(detail, null, 2))}
          onExportThread={async () => {
            const result = await onExportThread();
            setExportResult(exportResultText(result, t));
          }}
          record={record}
          tab={activeTab}
        />
      ) : null}
    </aside>
  );
}

function InspectorTabBody({
  detail,
  exportResult,
  onCopyRecord,
  onExportThread,
  record,
  tab,
}: {
  readonly detail: ThreadTrajectoryRecordDetail;
  readonly exportResult: string | null;
  readonly onCopyRecord: () => void;
  readonly onExportThread: () => Promise<void>;
  readonly record: ThreadTrajectoryRecordSummary;
  readonly tab: InspectorTab;
}) {
  const t = useT();
  if (tab === 'summary') {
    return (
      <div className="thread-trajectory-inspector-body">
        <FactGrid
          entries={[
            [t.agent.trajectory.kind, record.kind],
            [t.agent.trajectory.state, stateLabel(record.state)],
            [t.agent.trajectory.turn, shortId(record.turnId)],
            [t.agent.trajectory.recordId, record.id],
          ]}
        />
        <Availability availability={record.availability} />
        <EvidenceList record={record} />
      </div>
    );
  }
  if (tab === 'timing') {
    return (
      <div className="thread-trajectory-inspector-body">
        <TimingView timing={record.timing} usage={record.usage} />
      </div>
    );
  }
  if (tab === 'export') {
    return (
      <div className="thread-trajectory-inspector-body">
        <p className="thread-trajectory-note">{t.agent.trajectory.exportCopy}</p>
        <div className="thread-trajectory-action-row">
          <Button onClick={onCopyRecord} type="button" variant="secondary">
            <CopyIcon size={ICON_SIZE.menu} />
            {t.agent.trajectory.copyRecord}
          </Button>
          <Button onClick={() => void onExportThread()} type="button" variant="secondary">
            <DownloadIcon size={ICON_SIZE.menu} />
            {t.agent.trajectory.exportThread}
          </Button>
        </div>
        {exportResult ? <p className="thread-trajectory-note">{exportResult}</p> : null}
      </div>
    );
  }
  if (detail.kind === 'assistant') {
    const call = detail.diagnostics?.providerCall ?? null;
    if (tab === 'request') return <JsonPanel title={t.agent.trajectory.providerRequest} value={call?.request ?? null} />;
    if (tab === 'response') return <JsonPanel title={t.agent.trajectory.providerResponse} value={call?.response ?? null} />;
  }
  if (detail.kind === 'input' && tab === 'source') {
    return <JsonPanel title={t.agent.trajectory.source} value={detail.items} />;
  }
  if (detail.kind === 'context' && tab === 'source') {
    return <JsonPanel title={t.agent.trajectory.source} value={detail.payload} />;
  }
  if ((detail.kind === 'tool' || detail.kind === 'delegation') && tab === 'result') {
    return detail.kind === 'tool'
      ? <TextPanel title={t.agent.trajectory.result} text={detail.outputText} />
      : <JsonPanel title={t.agent.trajectory.result} value={detail} />;
  }
  if ((detail.kind === 'tool' || detail.kind === 'delegation') && tab === 'audit') {
    return <JsonPanel title={t.agent.trajectory.audit} value={detail.diagnostics?.activity ?? null} />;
  }
  if (tab === 'arguments' || tab === 'schema') {
    return <JsonPanel title={t.agent.trajectory.tab[tab]} value={null} />;
  }
  return <JsonPanel title={t.agent.trajectory.details} value={detail} />;
}

function TimingView({
  timing,
  usage,
}: {
  readonly timing: ThreadTrajectoryTimingSummary;
  readonly usage: ThreadTrajectoryUsageSummary | null;
}) {
  const t = useT();
  const { locale } = useI18n();
  return (
    <>
      <FactGrid
        entries={[
          [t.agent.trajectory.started, timing.startedAt === null ? '-' : formatTrajectoryDateTime(timing.startedAt, locale)],
          [t.agent.trajectory.firstToken, timing.firstTokenAt === null ? '-' : formatTrajectoryDateTime(timing.firstTokenAt, locale)],
          [t.agent.trajectory.completed, timing.completedAt === null ? '-' : formatTrajectoryDateTime(timing.completedAt, locale)],
          [t.agent.trajectory.duration, timing.durationMs === null ? '-' : `${formatNumber(Math.round(timing.durationMs))} ms`],
        ]}
      />
      {usage ? (
        <FactGrid
          entries={[
            [t.agent.trajectory.inputTokens, formatNumber(usage.input)],
            [t.agent.trajectory.outputTokens, formatNumber(usage.output)],
            [t.agent.trajectory.cacheRead, formatNumber(usage.cacheRead)],
            [t.agent.trajectory.cacheWrite, formatNumber(usage.cacheWrite)],
            [t.agent.trajectory.totalTokens, formatNumber(usage.totalTokens)],
            [t.agent.trajectory.cost, usage.costUsd === null ? '-' : `$${usage.costUsd.toFixed(6)}`],
          ]}
        />
      ) : null}
    </>
  );
}

function JsonPanel({ title, value }: { readonly title: string; readonly value: unknown }) {
  const t = useT();
  return (
    <div className="thread-trajectory-inspector-body">
      <h4>{title}</h4>
      {value === null || value === undefined ? (
        <p className="thread-trajectory-note">{t.agent.trajectory.noRetainedEvidence}</p>
      ) : (
        <ReadOnlyCodeBlock className="thread-trajectory-code" code={JSON.stringify(value, null, 2)} language="json" />
      )}
    </div>
  );
}

function TextPanel({ title, text }: { readonly title: string; readonly text: string | null }) {
  const t = useT();
  return (
    <div className="thread-trajectory-inspector-body">
      <h4>{title}</h4>
      {text ? <ReadOnlyCodeBlock className="thread-trajectory-code" code={text} language="text" /> : <p className="thread-trajectory-note">{t.agent.trajectory.noRetainedOutput}</p>}
    </div>
  );
}

function FactGrid({ entries }: { readonly entries: readonly (readonly [string, string])[] }) {
  return (
    <dl className="thread-trajectory-facts">
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Availability({ availability }: { readonly availability: ThreadTrajectoryRecordSummary['availability'] }) {
  if (availability.length === 0) return null;
  return (
    <div className="thread-trajectory-availability">
      {availability.map((entry) => (
        <p key={`${entry.reason}:${entry.message}`}>
          <strong>{entry.reason}</strong>
          <span>{entry.message}</span>
        </p>
      ))}
    </div>
  );
}

function EvidenceList({ record }: { readonly record: ThreadTrajectoryRecordSummary }) {
  const t = useT();
  return (
    <dl className="thread-trajectory-evidence">
      <div>
        <dt>{t.agent.trajectory.primaryEvidence}</dt>
        <dd><code>{evidenceLabel(record.primaryEvidence)}</code></dd>
      </div>
      {record.relatedEvidence.map((entry, index) => (
        <div key={`${index}:${evidenceLabel(entry)}`}>
          <dt>{t.agent.trajectory.relatedEvidence}</dt>
          <dd><code>{evidenceLabel(entry)}</code></dd>
        </div>
      ))}
    </dl>
  );
}

function tabsForRecord(kind: ThreadTrajectoryRecordKind): readonly InspectorTab[] {
  switch (kind) {
    case 'input':
    case 'context':
      return ['summary', 'source', 'timing'];
    case 'assistant':
      return ['summary', 'request', 'response', 'timing', 'export'];
    case 'tool':
      return ['summary', 'arguments', 'result', 'schema', 'audit', 'timing'];
    case 'retry':
    case 'compaction':
      return ['summary', 'audit', 'timing'];
    case 'delegation':
      return ['summary', 'result', 'audit', 'timing'];
  }
}

function groupByTurn(records: readonly ThreadTrajectoryRecordSummary[]) {
  const groups: Array<{ readonly turnId: string; readonly index: number; readonly records: ThreadTrajectoryRecordSummary[] }> = [];
  const byTurn = new Map<string, ThreadTrajectoryRecordSummary[]>();
  for (const record of records) {
    const group = byTurn.get(record.turnId) ?? [];
    group.push(record);
    byTurn.set(record.turnId, group);
  }
  let index = 0;
  for (const [turnIdValue, groupRecords] of byTurn) {
    groups.push({ turnId: turnIdValue, index, records: groupRecords });
    index += 1;
  }
  return groups;
}

function mergeRecords(
  older: readonly ThreadTrajectoryRecordSummary[],
  current: readonly ThreadTrajectoryRecordSummary[],
): readonly ThreadTrajectoryRecordSummary[] {
  const byId = new Map<string, ThreadTrajectoryRecordSummary>();
  for (const record of [...older, ...current]) byId.set(record.id, record);
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

function recordSearchText(record: ThreadTrajectoryRecordSummary): string {
  return [
    record.kind,
    record.title,
    record.subtitle ?? '',
    record.preview ?? '',
    record.state,
    record.turnId,
  ].join(' ').toLocaleLowerCase();
}

function evidenceLabel(evidence: ThreadTrajectoryRecordSummary['primaryEvidence']): string {
  if (evidence.type === 'providerCall') return `providerCall:${shortId(evidence.turnId)}:${evidence.callIndex}`;
  if (evidence.type === 'threadItem') return `item:${shortId(evidence.itemId)}`;
  if (evidence.type === 'diagnosticActivity') return `activity:${evidence.activityIndex}:${evidence.activityType}`;
  if (evidence.type === 'subagent') return `subagent:${shortId(evidence.agentThreadId)}`;
  return `turn:${shortId(evidence.turnId)}`;
}

function kindGlyph(kind: ThreadTrajectoryRecordKind): string {
  switch (kind) {
    case 'input': return 'I';
    case 'context': return 'C';
    case 'assistant': return 'A';
    case 'tool': return 'T';
    case 'retry': return 'R';
    case 'compaction': return 'K';
    case 'delegation': return 'D';
  }
}

function stateLabel(state: ThreadTrajectoryRecordSummary['state']): string {
  return state;
}

function shortId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

function formatTrajectoryDateTime(value: number, locale: Parameters<typeof formatDateTime>[1]): string {
  return formatDateTime(value, locale, {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
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
