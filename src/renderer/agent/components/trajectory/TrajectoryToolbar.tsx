import { memo } from 'react';
import { useT } from '../../../i18n/I18nProvider';
import { formatNumber } from '../../../ui/formatting';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DurationIcon,
  ICON_SIZE,
  SearchIcon,
} from '../../../ui/icons';
import type { TrajectoryTimelineMode } from './trajectoryModel';

interface TrajectoryToolbarProps {
  readonly allCallsCollapsed: boolean;
  readonly allTurnsCollapsed: boolean;
  readonly callCount: number;
  readonly mode: TrajectoryTimelineMode;
  readonly onModeChange: (mode: TrajectoryTimelineMode) => void;
  readonly onQueryChange: (query: string) => void;
  readonly onToggleAllCalls: () => void;
  readonly onToggleAllTurns: () => void;
  readonly query: string;
  readonly turnCount: number;
}

export const TrajectoryToolbar = memo(function TrajectoryToolbar({
  allCallsCollapsed,
  allTurnsCollapsed,
  callCount,
  mode,
  onModeChange,
  onQueryChange,
  onToggleAllCalls,
  onToggleAllTurns,
  query,
  turnCount,
}: TrajectoryToolbarProps) {
  const t = useT();
  const TurnFoldIcon = allTurnsCollapsed ? ChevronRightIcon : ChevronDownIcon;
  const CallFoldIcon = allCallsCollapsed ? ChevronRightIcon : ChevronDownIcon;
  const turnFoldLabel = allTurnsCollapsed ? t.agent.trajectory.expandTurns : t.agent.trajectory.collapseTurns;
  const callFoldLabel = allCallsCollapsed ? t.agent.trajectory.expandCalls : t.agent.trajectory.collapseCalls;
  return (
    <div className="thread-trajectory-toolbar" role="toolbar" aria-label={t.agent.trajectory.toolbar}>
      <div className="thread-trajectory-toolbar-actions">
        <button
          aria-label={t.agent.trajectory.duration}
          aria-pressed={mode === 'duration'}
          className="thread-trajectory-toolbar-button"
          onClick={() => onModeChange(mode === 'duration' ? 'sequence' : 'duration')}
          title={mode === 'duration' ? t.agent.trajectory.sequenceMode : t.agent.trajectory.durationMode}
          type="button"
        >
          <DurationIcon size={ICON_SIZE.rowGlyph} />
          <span>{t.agent.trajectory.duration}</span>
        </button>
        <button
          aria-label={turnFoldLabel}
          aria-pressed={allTurnsCollapsed}
          className="thread-trajectory-toolbar-button"
          onClick={onToggleAllTurns}
          title={turnFoldLabel}
          type="button"
        >
          <TurnFoldIcon size={ICON_SIZE.rowGlyph} />
          <span>{t.agent.trajectory.turns}</span>
          <span className="thread-trajectory-toolbar-count">{formatNumber(turnCount)}</span>
        </button>
        <button
          aria-label={callFoldLabel}
          aria-pressed={allCallsCollapsed}
          className="thread-trajectory-toolbar-button"
          onClick={onToggleAllCalls}
          title={callFoldLabel}
          type="button"
        >
          <CallFoldIcon size={ICON_SIZE.rowGlyph} />
          <span>{t.agent.trajectory.calls}</span>
          <span className="thread-trajectory-toolbar-count">{formatNumber(callCount)}</span>
        </button>
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
    </div>
  );
});
