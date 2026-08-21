import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from 'react';
import { useI18n, useT } from '../../../i18n/I18nProvider';
import { formatNumber } from '../../../ui/formatting';
import { ChevronDownIcon, ChevronRightIcon, ICON_SIZE } from '../../../ui/icons';
import {
  TRAJECTORY_ROW_HEIGHT,
  TRAJECTORY_VIRTUALIZATION_THRESHOLD,
  TRAJECTORY_VIRTUAL_OVERSCAN,
  trajectoryRecordContent,
  trajectoryRecordRole,
  type TrajectoryLedgerRow,
} from './trajectoryModel';

interface TrajectoryLedgerProps {
  readonly following: boolean;
  readonly hasEarlierRecords: boolean;
  readonly loadingEarlier: boolean;
  readonly onFollowingChange: (following: boolean) => void;
  readonly onLoadEarlier: () => Promise<void>;
  readonly onRecordSelect: (recordId: string) => void;
  readonly onToggleCall: (recordId: string) => void;
  readonly onToggleTurn: (turnId: string) => void;
  readonly rangeActive: boolean;
  readonly rows: readonly TrajectoryLedgerRow[];
  readonly searchActive: boolean;
  readonly selectedRecordId: string | null;
}

interface VirtualWindow {
  readonly end: number;
  readonly start: number;
}

interface OlderAnchor {
  readonly scrollHeight: number;
  readonly scrollTop: number;
}

type SpacerStyle = CSSProperties & { '--trajectory-ledger-spacer-height': string };

const INITIAL_VIRTUAL_ROWS = 40;
const TAIL_THRESHOLD_PX = 2;

export const TrajectoryLedger = memo(function TrajectoryLedger({
  following,
  hasEarlierRecords,
  loadingEarlier,
  onFollowingChange,
  onLoadEarlier,
  onRecordSelect,
  onToggleCall,
  onToggleTurn,
  rangeActive,
  rows,
  searchActive,
  selectedRecordId,
}: TrajectoryLedgerProps) {
  const t = useT();
  const { locale } = useI18n();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const olderAnchorRef = useRef<OlderAnchor | null>(null);
  const [virtualWindow, setVirtualWindow] = useState<VirtualWindow>({
    start: 0,
    end: INITIAL_VIRTUAL_ROWS,
  });
  const virtualized = rows.length > TRAJECTORY_VIRTUALIZATION_THRESHOLD;

  const updateVirtualWindow = useCallback((pane: HTMLDivElement) => {
    if (!virtualized) return;
    const historyHeight = hasEarlierRecords ? TRAJECTORY_ROW_HEIGHT : 0;
    const scrollTop = finiteLayoutMetric(pane.scrollTop);
    const clientHeight = finiteLayoutMetric(pane.clientHeight);
    const visibleStart = Math.floor(Math.max(0, scrollTop - historyHeight) / TRAJECTORY_ROW_HEIGHT);
    const visibleCount = Math.ceil(clientHeight / TRAJECTORY_ROW_HEIGHT);
    const next = {
      start: Math.max(0, visibleStart - TRAJECTORY_VIRTUAL_OVERSCAN),
      end: Math.min(rows.length, visibleStart + visibleCount + TRAJECTORY_VIRTUAL_OVERSCAN),
    };
    setVirtualWindow((current) => (
      current.start === next.start && current.end === next.end ? current : next
    ));
  }, [hasEarlierRecords, rows.length, virtualized]);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || rows.length === 0) return;
    const olderAnchor = olderAnchorRef.current;
    if (olderAnchor) {
      pane.scrollTop = olderAnchor.scrollTop
        + Math.max(0, finiteLayoutMetric(pane.scrollHeight) - olderAnchor.scrollHeight);
      olderAnchorRef.current = null;
      updateVirtualWindow(pane);
      return;
    }
    if (following) {
      pane.scrollTop = finiteLayoutMetric(pane.scrollHeight);
      updateVirtualWindow(pane);
    }
  }, [following, rows.length, updateVirtualWindow]);

  useLayoutEffect(() => {
    if (!selectedRecordId) return;
    const pane = paneRef.current;
    if (!pane) return;
    const rowIndex = rows.findIndex((row) => (
      row.type === 'record' && row.record.id === selectedRecordId
    ));
    if (rowIndex < 0) return;
    if (virtualized) {
      const historyHeight = hasEarlierRecords ? TRAJECTORY_ROW_HEIGHT : 0;
      const rowTop = historyHeight + rowIndex * TRAJECTORY_ROW_HEIGHT;
      const rowBottom = rowTop + TRAJECTORY_ROW_HEIGHT;
      const scrollTop = finiteLayoutMetric(pane.scrollTop);
      const clientHeight = finiteLayoutMetric(pane.clientHeight);
      if (rowTop < scrollTop) pane.scrollTop = rowTop;
      else if (rowBottom > scrollTop + clientHeight) {
        pane.scrollTop = Math.max(0, rowBottom - clientHeight);
      }
      updateVirtualWindow(pane);
      return;
    }
    const selected = [...pane.querySelectorAll<HTMLElement>('[data-trajectory-record-id]')]
      .find((candidate) => candidate.dataset.trajectoryRecordId === selectedRecordId);
    selected?.scrollIntoView?.({ block: 'nearest' });
  }, [hasEarlierRecords, rows, selectedRecordId, updateVirtualWindow, virtualized]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const pane = event.currentTarget;
    const distanceToTail = finiteLayoutMetric(pane.scrollHeight)
      - finiteLayoutMetric(pane.clientHeight)
      - finiteLayoutMetric(pane.scrollTop);
    onFollowingChange(distanceToTail <= TAIL_THRESHOLD_PX);
    updateVirtualWindow(pane);
  };

  const loadEarlier = async () => {
    const pane = paneRef.current;
    if (pane) olderAnchorRef.current = {
      scrollHeight: finiteLayoutMetric(pane.scrollHeight),
      scrollTop: finiteLayoutMetric(pane.scrollTop),
    };
    await onLoadEarlier();
  };

  const start = virtualized ? Math.min(virtualWindow.start, rows.length) : 0;
  const end = virtualized ? Math.min(Math.max(start, virtualWindow.end), rows.length) : rows.length;
  const visibleRows = rows.slice(start, end);

  return (
    <section className="thread-trajectory-ledger" aria-label={t.agent.trajectory.ledger}>
      {searchActive || rangeActive ? (
        <div className="thread-trajectory-ledger-scope" role="status">
          {searchActive ? t.agent.trajectory.searchScope : t.agent.trajectory.rangeScope}
        </div>
      ) : null}
      <div className="thread-trajectory-ledger-scroll" onScroll={handleScroll} ref={paneRef}>
        <table className="thread-trajectory-table" aria-rowcount={rows.length + (hasEarlierRecords ? 1 : 0)}>
          <colgroup>
            <col className="thread-trajectory-event-column" />
            <col />
          </colgroup>
          <tbody>
            {hasEarlierRecords ? (
              <tr className="thread-trajectory-history-row">
                <td colSpan={2}>
                  <button
                    aria-label={loadingEarlier ? t.agent.trajectory.loadingOlder : t.agent.trajectory.loadOlder}
                    disabled={loadingEarlier}
                    onClick={() => void loadEarlier()}
                    type="button"
                  >
                    {loadingEarlier ? t.agent.trajectory.loadingOlder : t.agent.trajectory.loadOlder}
                  </button>
                </td>
              </tr>
            ) : null}
            {start > 0 ? <VirtualSpacer count={start} /> : null}
            {visibleRows.map((row) => row.type === 'turnSummary' ? (
              <TurnSummaryRow key={row.key} onToggleTurn={onToggleTurn} row={row} />
            ) : (
              <RecordRow
                key={row.key}
                locale={locale}
                onRecordSelect={onRecordSelect}
                onToggleCall={onToggleCall}
                onToggleTurn={onToggleTurn}
                row={row}
                selected={row.record.id === selectedRecordId}
              />
            ))}
            {end < rows.length ? <VirtualSpacer count={rows.length - end} /> : null}
          </tbody>
        </table>
      </div>
    </section>
  );
});

function RecordRow({
  locale,
  onRecordSelect,
  onToggleCall,
  onToggleTurn,
  row,
  selected,
}: {
  readonly locale: string;
  readonly onRecordSelect: (recordId: string) => void;
  readonly onToggleCall: (recordId: string) => void;
  readonly onToggleTurn: (turnId: string) => void;
  readonly row: Extract<TrajectoryLedgerRow, { readonly type: 'record' }>;
  readonly selected: boolean;
}) {
  const t = useT();
  const record = row.record;
  const FoldIcon = row.callCollapsed ? ChevronRightIcon : ChevronDownIcon;
  const select = () => onRecordSelect(record.id);
  return (
    <tr
      aria-label={`${trajectoryRecordRole(record)}, ${trajectoryRecordContent(record)}`}
      aria-selected={selected}
      data-depth={row.depth || undefined}
      data-kind={record.kind}
      data-state={record.state}
      data-trajectory-record-id={record.id}
      data-turn-start={row.turnStart || undefined}
      onClick={select}
      onDoubleClick={() => {
        if (row.callChildCount > 0) onToggleCall(record.id);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select();
        } else if (row.callChildCount > 0 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          const wantsCollapsed = event.key === 'ArrowLeft';
          if (row.callCollapsed !== wantsCollapsed) onToggleCall(record.id);
          event.preventDefault();
        }
      }}
      tabIndex={0}
    >
      <td className="thread-trajectory-event-cell">
        {selected ? <span className="thread-trajectory-selection-rail" aria-hidden="true" /> : null}
        {row.turnStart ? (
          <button
            aria-label={t.agent.trajectory.collapseTurn({ index: row.turnIndex + 1 })}
            className="thread-trajectory-turn-label"
            onClick={(event) => {
              event.stopPropagation();
              onToggleTurn(record.turnId);
            }}
            title={t.agent.trajectory.collapseTurn({ index: row.turnIndex + 1 })}
            type="button"
          >
            {t.agent.trajectory.turnLabel({ index: row.turnIndex + 1 })}
          </button>
        ) : null}
        <span className={`thread-trajectory-kind is-${record.kind}`}>
          {trajectoryRecordRole(record)}
        </span>
      </td>
      <td className="thread-trajectory-content-cell">
        <span className="thread-trajectory-row-content">
          {row.callChildCount > 0 ? (
            <button
              aria-label={row.callCollapsed ? t.agent.trajectory.expandCall : t.agent.trajectory.collapseCall}
              className="thread-trajectory-call-fold"
              onClick={(event) => {
                event.stopPropagation();
                onToggleCall(record.id);
              }}
              title={row.callCollapsed ? t.agent.trajectory.expandCall : t.agent.trajectory.collapseCall}
              type="button"
            >
              <FoldIcon size={ICON_SIZE.tiny} />
            </button>
          ) : null}
          <span className="thread-trajectory-row-text" title={trajectoryRecordContent(record)}>
            {trajectoryRecordContent(record)}
          </span>
          {row.callCollapsed && row.callChildCount > 0 ? (
            <span className="thread-trajectory-fold-count">
              {t.agent.trajectory.hiddenRecords({ count: row.callChildCount })}
            </span>
          ) : null}
        </span>
        <span className="thread-trajectory-row-trailing">
          {record.usage ? <span>{formatNumber(record.usage.totalTokens)} tok</span> : null}
          {record.timing.durationMs !== null
            ? <span>{formatDuration(record.timing.durationMs)}</span>
            : <span>{stateLabel(record.state)}</span>}
          {record.timing.startedAt !== null ? (
            <time dateTime={new Date(record.timing.startedAt).toISOString()}>
              {formatClock(record.timing.startedAt, locale)}
            </time>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

function TurnSummaryRow({
  onToggleTurn,
  row,
}: {
  readonly onToggleTurn: (turnId: string) => void;
  readonly row: Extract<TrajectoryLedgerRow, { readonly type: 'turnSummary' }>;
}) {
  const t = useT();
  return (
    <tr
      className="thread-trajectory-turn-summary"
      onClick={() => onToggleTurn(row.turnId)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onToggleTurn(row.turnId);
      }}
      tabIndex={0}
    >
      <td className="thread-trajectory-event-cell">
        <button
          aria-label={t.agent.trajectory.expandTurn({ index: row.turnIndex + 1 })}
          className="thread-trajectory-turn-label is-collapsed"
          onClick={(event) => {
            event.stopPropagation();
            onToggleTurn(row.turnId);
          }}
          type="button"
        >
          {t.agent.trajectory.turnLabel({ index: row.turnIndex + 1 })}
        </button>
      </td>
      <td className="thread-trajectory-content-cell">
        <span className="thread-trajectory-row-content">
          <ChevronRightIcon size={ICON_SIZE.tiny} />
          <span className="thread-trajectory-fold-count">
            {t.agent.trajectory.hiddenRecords({ count: row.count })}
          </span>
          <span className="thread-trajectory-row-text">{row.preview}</span>
        </span>
      </td>
    </tr>
  );
}

function VirtualSpacer({ count }: { readonly count: number }) {
  return (
    <tr className="thread-trajectory-virtual-spacer" aria-hidden="true">
      <td
        colSpan={2}
        style={{ '--trajectory-ledger-spacer-height': `${count * TRAJECTORY_ROW_HEIGHT}px` } as SpacerStyle}
      />
    </tr>
  );
}

function formatClock(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

function stateLabel(state: string): string {
  if (state === 'completed') return 'Completed';
  if (state === 'running') return 'Running';
  if (state === 'failed') return 'Failed';
  if (state === 'interrupted') return 'Interrupted';
  if (state === 'partial') return 'Partial';
  return 'Pending';
}

function finiteLayoutMetric(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
