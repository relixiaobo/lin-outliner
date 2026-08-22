import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ThreadTrajectoryRecordSummary } from '../../../../core/agent/protocol';
import { useI18n, useT } from '../../../i18n/I18nProvider';
import { formatNumber } from '../../../ui/formatting';
import {
  orderedRange,
  trajectoryRecordLabel,
  trajectoryRecordKindClass,
  type TrajectoryLabels,
  type TrajectoryTimelineMode,
  type TrajectoryTimelineModel,
  type TrajectoryTimelineSpan,
  type TrajectoryTimeRange,
} from './trajectoryModel';

interface TrajectoryTimelineProps {
  readonly hasEarlierRecords: boolean;
  readonly loadingEarlier: boolean;
  readonly mode: TrajectoryTimelineMode;
  readonly model: TrajectoryTimelineModel | null;
  readonly onLoadEarlier: () => void;
  readonly onRecordFocus: (recordId: string) => void;
  readonly onRangeChange: (range: TrajectoryTimeRange | null) => void;
  readonly onRecordSelect: (recordId: string) => void;
  readonly range: TrajectoryTimeRange | null;
  readonly searchMatches: ReadonlySet<string> | null;
  readonly selectedRecordId: string | null;
}

interface TimelinePointerDrag {
  readonly anchorClientX: number;
  readonly anchorValue: number;
  readonly pointerId: number;
  readonly recordId: string | null;
  moved: boolean;
}

interface TimelinePanDrag {
  readonly anchorClientX: number;
  readonly pointerId: number;
  readonly viewport: TrajectoryTimeRange;
  moved: boolean;
}

type TimelineCssProperties = CSSProperties & Record<`--trajectory-${string}`, string>;

const MINIMUM_SEQUENCE_WINDOW = 4;
const MINIMUM_DURATION_WINDOW_MS = 20;
const MINIMUM_DRAG_PX = 3;

export const TrajectoryTimeline = memo(function TrajectoryTimeline({
  hasEarlierRecords,
  loadingEarlier,
  mode,
  model,
  onLoadEarlier,
  onRecordFocus,
  onRangeChange,
  onRecordSelect,
  range,
  searchMatches,
  selectedRecordId,
}: TrajectoryTimelineProps) {
  const t = useT();
  const { locale } = useI18n();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<TimelinePointerDrag | null>(null);
  const panRef = useRef<TimelinePanDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [viewport, setViewport] = useState<TrajectoryTimeRange | null>(null);

  useEffect(() => {
    setViewport(null);
  }, [mode]);

  const fullRange = useMemo<TrajectoryTimeRange | null>(() => (
    model ? { start: model.start, end: model.end } : null
  ), [model]);
  const domain = viewport ?? fullRange;

  useEffect(() => {
    if (!model || !domain || !selectedRecordId || viewport === null) return;
    const selected = model.spans.find((span) => span.record.id === selectedRecordId);
    if (!selected || (selected.end >= domain.start && selected.start <= domain.end)) return;
    const duration = domain.end - domain.start;
    const nextStart = selected.end < domain.start
      ? selected.start
      : selected.end - duration;
    setViewport(clampRange(
      { start: nextStart, end: nextStart + duration },
      model.start,
      model.end,
    ));
  }, [domain, model, selectedRecordId, viewport]);

  useEffect(() => {
    if (!model || !range) return;
    if (range.end < model.start || range.start > model.end) onRangeChange(null);
  }, [model, onRangeChange, range]);

  const zoom = useCallback((factor: number, anchorFraction = 0.5) => {
    if (!model || !domain) return;
    const fullDuration = model.end - model.start;
    const minimum = mode === 'sequence' ? MINIMUM_SEQUENCE_WINDOW : MINIMUM_DURATION_WINDOW_MS;
    const nextDuration = Math.min(fullDuration, Math.max(minimum, (domain.end - domain.start) * factor));
    if (nextDuration >= fullDuration * 0.999) {
      setViewport(null);
      return;
    }
    const anchor = domain.start + anchorFraction * (domain.end - domain.start);
    const nextStart = anchor - anchorFraction * nextDuration;
    setViewport(clampRange(
      { start: nextStart, end: nextStart + nextDuration },
      model.start,
      model.end,
    ));
  }, [domain, mode, model]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onWheel = (event: WheelEvent) => {
      if (!model || !domain) return;
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      const anchor = clamp01((event.clientX - rect.left) / Math.max(1, rect.width));
      zoom(Math.exp(event.deltaY * 0.0015), anchor);
    };
    track.addEventListener('wheel', onWheel, { passive: false });
    return () => track.removeEventListener('wheel', onWheel);
  }, [domain, model, zoom]);

  const updateDraftSelection = useCallback((left: number, right: number) => {
    if (!domain || !selectionRef.current) return;
    const ordered = orderedRange(left, right);
    const duration = Math.max(1, domain.end - domain.start);
    const start = clamp01((ordered.start - domain.start) / duration);
    const end = clamp01((ordered.end - domain.start) / duration);
    selectionRef.current.style.setProperty('--trajectory-range-left', `${start * 100}%`);
    selectionRef.current.style.setProperty('--trajectory-range-width', `${Math.max(0, end - start) * 100}%`);
    selectionRef.current.dataset.visible = 'true';
  }, [domain]);

  const clearDraftSelection = useCallback(() => {
    if (selectionRef.current) delete selectionRef.current.dataset.visible;
  }, []);

  const valueAtClientX = useCallback((clientX: number): number | null => {
    const track = trackRef.current;
    if (!track || !domain) return null;
    const rect = track.getBoundingClientRect();
    const fraction = clamp01((clientX - rect.left) / Math.max(1, rect.width));
    return domain.start + fraction * (domain.end - domain.start);
  }, [domain]);

  const recordIdAtTarget = (target: EventTarget | null): string | null => {
    const element = target instanceof HTMLElement ? target : null;
    return element
      ?.closest<HTMLElement>('[data-timeline-record-id]')
      ?.dataset.timelineRecordId ?? null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!model || !domain) return;
    if (event.button === 2) {
      panRef.current = {
        pointerId: event.pointerId,
        anchorClientX: event.clientX,
        viewport: domain,
        moved: false,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    const value = valueAtClientX(event.clientX);
    if (value === null) return;
    dragRef.current = {
      pointerId: event.pointerId,
      anchorClientX: event.clientX,
      anchorValue: value,
      recordId: recordIdAtTarget(event.target),
      moved: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const value = valueAtClientX(event.clientX);
      if (value === null) return;
      drag.moved = drag.moved || Math.abs(event.clientX - drag.anchorClientX) >= MINIMUM_DRAG_PX;
      if (drag.moved) updateDraftSelection(drag.anchorValue, value);
      return;
    }
    const pan = panRef.current;
    if (pan?.pointerId !== event.pointerId || !model) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const duration = pan.viewport.end - pan.viewport.start;
    const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width) * duration;
    pan.moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
    setViewport(clampRange({
      start: pan.viewport.start - delta,
      end: pan.viewport.end - delta,
    }, model.start, model.end));
  };

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!model || !domain) return;
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const value = valueAtClientX(event.clientX);
      const clicked = !drag.moved && Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
      dragRef.current = null;
      clearDraftSelection();
      if (clicked && drag.recordId !== null) {
        suppressClickRef.current = true;
        onRangeChange(null);
        onRecordSelect(drag.recordId);
      } else if (value !== null) {
        suppressClickRef.current = true;
        const selected = orderedRange(drag.anchorValue, value);
        const nextRange = minimumFocusRange(selected, minimumSelectionDuration(model, domain));
        onRangeChange(clampRange(nextRange, model.start, model.end));
        if (clicked) {
          const nearest = nearestSpan(model.spans, selected.start);
          if (nearest) onRecordFocus(nearest.record.id);
        }
      }
    }
    const pan = panRef.current;
    if (pan?.pointerId === event.pointerId) {
      if (!pan.moved && Math.abs(event.clientX - pan.anchorClientX) < MINIMUM_DRAG_PX) {
        onRangeChange(null);
      }
      panRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      clearDraftSelection();
    }
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (!model || !domain) {
    return (
      <section className="thread-trajectory-timeline" aria-label={t.agent.trajectory.overview}>
        <LaneLabels />
        <div className="thread-trajectory-timeline-track is-empty">
          <span>{t.agent.trajectory.noTimingData}</span>
        </div>
      </section>
    );
  }

  const committedRange = range ? rangeStyle(range, domain) : null;
  const domainDuration = Math.max(1, domain.end - domain.start);
  return (
    <section
      className="thread-trajectory-timeline"
      aria-label={t.agent.trajectory.overview}
      aria-description={model.unpositionedCount > 0
        ? t.agent.trajectory.unpositionedRecords({ count: model.unpositionedCount })
        : undefined}
    >
      <LaneLabels />
      <div
        className="thread-trajectory-timeline-track"
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onRangeChange(null);
          } else if (event.key === '+' || event.key === '=') {
            zoom(0.67);
            event.preventDefault();
          } else if (event.key === '-') {
            zoom(1.5);
            event.preventDefault();
          }
        }}
        onPointerCancel={cancelPointer}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        ref={trackRef}
        tabIndex={0}
      >
        {hasEarlierRecords ? (
          <button
            aria-label={loadingEarlier ? t.agent.trajectory.loadingOlder : t.agent.trajectory.loadOlder}
            className="thread-trajectory-earlier"
            disabled={loadingEarlier}
            onClick={onLoadEarlier}
            title={loadingEarlier ? t.agent.trajectory.loadingOlder : t.agent.trajectory.loadOlder}
            type="button"
          >
            ...
          </button>
        ) : null}
        <div className="thread-trajectory-timeline-turns" aria-hidden="true">
          {turnBoundaries(model.spans).map((boundary) => (
            <span
              className="thread-trajectory-timeline-turn"
              key={`${boundary.turnId}:${boundary.start}`}
              style={{ '--trajectory-turn-left': `${(boundary.start - domain.start) / domainDuration * 100}%` } as TimelineCssProperties}
            />
          ))}
        </div>
        <div className="thread-trajectory-timeline-spans">
          {model.spans.map((span) => {
            const clippedStart = Math.max(span.start, domain.start);
            const clippedEnd = Math.min(span.end, domain.end);
            if (span.marker ? span.start < domain.start || span.start > domain.end : clippedEnd < clippedStart) return null;
            const left = (clippedStart - domain.start) / domainDuration;
            const width = span.marker ? 0 : (clippedEnd - clippedStart) / domainDuration;
            const firstToken = span.record.timing.firstTokenAt;
            const firstTokenRatio = firstToken !== null && span.end > span.start
              ? clamp01((firstToken - span.start) / (span.end - span.start))
              : null;
            return (
              <button
                aria-label={`${trajectoryTimelineTitle(span.record, mode, locale, t.agent.trajectory)}. ${t.agent.trajectory.selectRecord}`}
                aria-pressed={selectedRecordId === span.record.id}
                className={`thread-trajectory-timeline-span ${trajectoryRecordKindClass(span.record)}${span.marker ? ' is-marker' : ''}`}
                data-assistant-timing={firstTokenRatio !== null || undefined}
                data-search-match={searchMatches === null || searchMatches.has(span.record.id) || undefined}
                data-selected={selectedRecordId === span.record.id || undefined}
                data-state={span.record.state}
                data-timeline-record-id={span.record.id}
                key={span.record.id}
                onClick={() => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false;
                    return;
                  }
                  onRangeChange(null);
                  onRecordSelect(span.record.id);
                }}
                style={{
                  '--trajectory-span-lane': String(laneIndex(span.record)),
                  '--trajectory-span-left': `${left * 100}%`,
                  '--trajectory-span-width': `${width * 100}%`,
                  ...(firstTokenRatio === null
                    ? {}
                    : { '--trajectory-span-ttft': `${firstTokenRatio * 100}%` }),
                } as TimelineCssProperties}
                title={trajectoryTimelineTitle(span.record, mode, locale, t.agent.trajectory)}
                type="button"
              />
            );
          })}
        </div>
        <div
          className="thread-trajectory-timeline-selection"
          data-visible={committedRange ? 'true' : undefined}
          ref={selectionRef}
          style={committedRange ?? undefined}
        />
      </div>
    </section>
  );
});

function LaneLabels() {
  const t = useT();
  return (
    <div className="thread-trajectory-timeline-labels" aria-hidden="true">
      <span>{t.agent.trajectory.lane.input}</span>
      <span>{t.agent.trajectory.lane.assistant}</span>
      <span>{t.agent.trajectory.lane.tools}</span>
    </div>
  );
}

function laneIndex(record: ThreadTrajectoryRecordSummary): number {
  if (record.lane === 'input') return 0;
  if (record.lane === 'assistant') return 1;
  return 2;
}

function turnBoundaries(spans: TrajectoryTimelineModel['spans']) {
  const seen = new Set<string>();
  return spans.flatMap((span) => {
    if (seen.has(span.record.turnId)) return [];
    seen.add(span.record.turnId);
    return [{ turnId: span.record.turnId, start: span.start }];
  });
}

function rangeStyle(
  range: TrajectoryTimeRange,
  domain: TrajectoryTimeRange,
): TimelineCssProperties {
  const ordered = orderedRange(range.start, range.end);
  const duration = Math.max(1, domain.end - domain.start);
  const left = clamp01((ordered.start - domain.start) / duration);
  const right = clamp01((ordered.end - domain.start) / duration);
  return {
    '--trajectory-range-left': `${left * 100}%`,
    '--trajectory-range-width': `${Math.max(0, right - left) * 100}%`,
  };
}

function clampRange(
  range: TrajectoryTimeRange,
  minimum: number,
  maximum: number,
): TrajectoryTimeRange {
  const fullDuration = maximum - minimum;
  const duration = Math.min(fullDuration, Math.max(1, range.end - range.start));
  const start = Math.min(Math.max(range.start, minimum), maximum - duration);
  return { start, end: start + duration };
}

function minimumSelectionDuration(
  model: TrajectoryTimelineModel,
  domain: TrajectoryTimeRange,
): number {
  const domainDuration = Math.max(1, domain.end - domain.start);
  if (model.spans.length === 0) return domainDuration;
  return Math.min(domainDuration, Math.max(1, (model.end - model.start) / model.spans.length));
}

function minimumFocusRange(
  range: TrajectoryTimeRange,
  minimumDuration: number,
): TrajectoryTimeRange {
  const ordered = orderedRange(range.start, range.end);
  if (ordered.end - ordered.start >= minimumDuration) return ordered;
  const center = (ordered.start + ordered.end) / 2;
  return {
    start: center - minimumDuration / 2,
    end: center + minimumDuration / 2,
  };
}

function nearestSpan(
  spans: readonly TrajectoryTimelineSpan[],
  value: number,
): TrajectoryTimelineSpan | null {
  let nearest: TrajectoryTimelineSpan | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const span of spans) {
    const distance = value < span.start
      ? span.start - value
      : value > span.end ? value - span.end : 0;
    if (distance >= nearestDistance) continue;
    nearest = span;
    nearestDistance = distance;
  }
  return nearest;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function trajectoryTimelineTitle(
  record: ThreadTrajectoryRecordSummary,
  mode: TrajectoryTimelineMode,
  locale: string,
  labels: TrajectoryLabels,
): string {
  const started = record.timing.startedAt === null
    ? labels.state.notRecorded
    : new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    }).format(new Date(record.timing.startedAt));
  const duration = mode === 'duration' && record.timing.durationMs !== null
    ? ` · ${formatNumber(Math.round(record.timing.durationMs))} ms`
    : '';
  return `${trajectoryRecordLabel(record, labels)} · ${started}${duration}`;
}
