import { memo } from 'react';
import type { ThreadTrajectorySummary } from '../../../../core/agent/protocol';
import { useT } from '../../../i18n/I18nProvider';
import { formatNumber } from '../../../ui/formatting';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  DownloadIcon,
  ICON_SIZE,
  PlayIcon,
  RefreshIcon,
  SearchIcon,
} from '../../../ui/icons';
import type { TrajectoryTimelineMode } from './trajectoryModel';

interface TrajectoryToolbarProps {
  readonly allCallsCollapsed: boolean;
  readonly allTurnsCollapsed: boolean;
  readonly exportBusy: boolean;
  readonly followingTail: boolean;
  readonly mode: TrajectoryTimelineMode;
  readonly onExport: () => void;
  readonly onFollowTail: () => void;
  readonly onModeChange: (mode: TrajectoryTimelineMode) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onRefresh: () => void;
  readonly onToggleAllCalls: () => void;
  readonly onToggleAllTurns: () => void;
  readonly query: string;
  readonly summary: ThreadTrajectorySummary;
}

export const TrajectoryToolbar = memo(function TrajectoryToolbar({
  allCallsCollapsed,
  allTurnsCollapsed,
  exportBusy,
  followingTail,
  mode,
  onExport,
  onFollowTail,
  onModeChange,
  onQueryChange,
  onRefresh,
  onToggleAllCalls,
  onToggleAllTurns,
  query,
  summary,
}: TrajectoryToolbarProps) {
  const t = useT();
  const TurnFoldIcon = allTurnsCollapsed ? ChevronRightIcon : ChevronDownIcon;
  const CallFoldIcon = allCallsCollapsed ? ChevronRightIcon : ChevronDownIcon;
  return (
    <div className="thread-trajectory-toolbar" role="toolbar" aria-label={t.agent.trajectory.toolbar}>
      <div className="thread-trajectory-toolbar-actions">
        <button
          aria-pressed={mode === 'duration'}
          className="thread-trajectory-toolbar-button"
          onClick={() => onModeChange(mode === 'duration' ? 'sequence' : 'duration')}
          title={mode === 'duration' ? t.agent.trajectory.sequenceMode : t.agent.trajectory.durationMode}
          type="button"
        >
          <ClockIcon size={ICON_SIZE.rowGlyph} />
          <span>{t.agent.trajectory.duration}</span>
        </button>
        <button
          aria-pressed={allTurnsCollapsed}
          className="thread-trajectory-toolbar-button"
          onClick={onToggleAllTurns}
          title={allTurnsCollapsed ? t.agent.trajectory.expandTurns : t.agent.trajectory.collapseTurns}
          type="button"
        >
          <TurnFoldIcon size={ICON_SIZE.rowGlyph} />
          <span>{t.agent.trajectory.turns}</span>
          <span className="thread-trajectory-toolbar-count">{formatNumber(summary.turnCount)}</span>
        </button>
        <button
          aria-pressed={allCallsCollapsed}
          className="thread-trajectory-toolbar-button"
          onClick={onToggleAllCalls}
          title={allCallsCollapsed ? t.agent.trajectory.expandCalls : t.agent.trajectory.collapseCalls}
          type="button"
        >
          <CallFoldIcon size={ICON_SIZE.rowGlyph} />
          <span>{t.agent.trajectory.calls}</span>
          <span className="thread-trajectory-toolbar-count">{formatNumber(summary.assistantCount)}</span>
        </button>
      </div>
      <div className="thread-trajectory-toolbar-summary" aria-label={t.agent.trajectory.summary}>
        <span>{t.agent.trajectory.tools} {formatNumber(summary.toolCount + summary.delegationCount)}</span>
        <span>{t.agent.trajectory.tokens} {summary.usage ? formatNumber(summary.usage.totalTokens) : '-'}</span>
        <span>{summary.availability.length === 0 ? t.agent.trajectory.complete : t.agent.trajectory.partial}</span>
      </div>
      <label className="thread-trajectory-search">
        <SearchIcon size={ICON_SIZE.rowGlyph} />
        <input
          aria-label={t.agent.trajectory.search}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder={t.agent.trajectory.searchShort}
          type="search"
          value={query}
        />
      </label>
      {!followingTail ? (
        <button
          aria-label={t.agent.trajectory.followLive}
          className="thread-trajectory-toolbar-icon"
          onClick={onFollowTail}
          title={t.agent.trajectory.followLive}
          type="button"
        >
          <PlayIcon size={ICON_SIZE.menu} />
        </button>
      ) : null}
      <button
        aria-label={t.agent.trajectory.refresh}
        className="thread-trajectory-toolbar-icon"
        onClick={onRefresh}
        title={t.agent.trajectory.refresh}
        type="button"
      >
        <RefreshIcon size={ICON_SIZE.menu} />
      </button>
      <button
        aria-label={t.agent.trajectory.exportThread}
        className="thread-trajectory-toolbar-icon"
        disabled={exportBusy}
        onClick={onExport}
        title={t.agent.trajectory.exportThread}
        type="button"
      >
        <DownloadIcon size={ICON_SIZE.menu} />
      </button>
    </div>
  );
});
