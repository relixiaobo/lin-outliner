import type { AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { MouseEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRightIcon,
  ICON_SIZE,
  LoaderIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentProcessTimeline, isToolCallRowActive } from './AgentProcessTimeline';
import { childRunToolStatus, getToolCallStatus, summarizeToolCall } from './AgentToolCallBlock';
import { sentenceFragment, summarizeToolActivity } from './agentRenderGroups';
import type { AgentExpandState } from './agentProcessTypes';
import { firstLine, formatRunDuration, previewText } from './agentProcessTypes';
import type { AgentTurnProcessItem, AgentTurnProcessProjection, AgentTurnToolCallItem } from './agentTurnProjection';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';

export type { AgentExpandState } from './agentProcessTypes';

function childRunMapFromToolItems(items: AgentTurnProcessItem[]): ReadonlyMap<string, AgentRenderChildRunEntity> | undefined {
  let map: Map<string, AgentRenderChildRunEntity> | undefined;
  for (const item of items) {
    if (item.type === 'toolCall' && item.childRun) {
      map ??= new Map<string, AgentRenderChildRunEntity>();
      map.set(item.toolCall.id, item.childRun);
    }
  }
  return map;
}

interface AgentProcessBlockProps {
  expandState: AgentExpandState;
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenChildRunTranscript?: (childRunId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  process: AgentTurnProcessProjection;
  results: Map<string, AgentToolResultWithPayloads>;
  conversationId?: string | null;
  childRunsByParentToolCallId?: Map<string, AgentRenderChildRunEntity>;
  turnActive: boolean;
}

interface ProcessSummaryFacts {
  childRunsByToolCallId?: ReadonlyMap<string, AgentRenderChildRunEntity>;
  toolCallOutcomes: ReadonlyMap<string, AgentToolCallOutcome>;
  firstThinkingText: string | null;
  thinkingCount: number;
  toolCalls: ToolCall[];
}

function toolCallOutcomeMap(items: AgentTurnProcessItem[]): ReadonlyMap<string, AgentToolCallOutcome> {
  const map = new Map<string, AgentToolCallOutcome>();
  for (const item of items) {
    if (item.type === 'toolCall' && item.outcome) map.set(item.toolCall.id, item.outcome);
  }
  return map;
}

function processSummaryFacts(items: AgentTurnProcessItem[]): ProcessSummaryFacts {
  const thinkingBlocks = items.filter(
    (item): item is Extract<AgentTurnProcessItem, { type: 'reasoning' }> => item.type === 'reasoning',
  );
  const toolCalls = items
    .filter((item): item is AgentTurnToolCallItem => item.type === 'toolCall')
    .map((item) => item.toolCall);
  return {
    childRunsByToolCallId: childRunMapFromToolItems(items),
    toolCallOutcomes: toolCallOutcomeMap(items),
    firstThinkingText: firstLine(thinkingBlocks[0]?.text ?? ''),
    thinkingCount: thinkingBlocks.length,
    toolCalls,
  };
}

export function summarizeProcess({
  firstThinkingText,
  thinkingCount,
  pendingToolCallIds,
  results,
  childRunsByToolCallId,
  toolCallOutcomes,
  toolCalls,
  turnActive,
  liveElapsedMs,
  turnFailedWithoutProse,
  surfaceResultlessProcess,
  workedForMs,
  process,
  toolCallLabels,
}: {
  firstThinkingText: string | null;
  thinkingCount: number;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
  childRunsByToolCallId?: ReadonlyMap<string, AgentRenderChildRunEntity>;
  toolCallOutcomes?: ReadonlyMap<string, AgentToolCallOutcome>;
  toolCalls: ToolCall[];
  /** Live wall-clock since the run started, for the "Working for {t}" ticker; null when unknown. */
  liveElapsedMs: number | null;
  turnActive: boolean;
  turnFailedWithoutProse: boolean;
  surfaceResultlessProcess: boolean;
  workedForMs: number | null;
  process: Messages['agent']['process'];
  toolCallLabels: Messages['agent']['toolCall'];
}): string {
  const toolCount = toolCalls.length;
  const toolStatus = (toolCall: ToolCall) => {
    const childRun = childRunsByToolCallId?.get(toolCall.id);
    if (childRun) return childRunToolStatus(childRun);
    // Same rule as the per-row spinner (isToolCallRowActive): while the turn is
    // live every un-settled call is active, not just the most recent — else a
    // parallel batch's other calls would count as 'error' in the summary during
    // the frame before the runtime marks them in-flight.
    const active = isToolCallRowActive(
      { id: `tool:${toolCall.id}`, type: 'toolCall', toolCall, outcome: toolCallOutcomes?.get(toolCall.id) },
      pendingToolCallIds,
      results,
      undefined,
      turnActive,
    );
    return getToolCallStatus(
      toolCall.id,
      results.get(toolCall.id),
      pendingToolCallIds,
      active,
      toolCallOutcomes?.get(toolCall.id),
    );
  };

  // Interrupted (RED) wins over any clock — a failed/cancelled/crashed turn is
  // never a "Working"/"Worked" divider.
  if (turnFailedWithoutProse) {
    if (thinkingCount > 0 && toolCount > 0) return process.interruptedAfterThinking;
    if (thinkingCount > 0) return process.thoughtInterrupted;
    return process.interrupted;
  }

  // Live divider — PERSISTENT (expanded OR collapsed), Codex-style and the
  // always-on header the user asked for: while the turn is active the header is
  // the ticking clock — "Working for {t}" (≥1s) / bare "Working" (<1s, no number so it never
  // flickers a "0s"). It stays put when the body is expanded (the work shows in
  // the timeline below) and when it auto-collapses on answer start. Without a run
  // clock, stay on bare "Working"; the expanded body already carries the detailed
  // thought/tool timeline.
  if (turnActive) {
    if (liveElapsedMs !== null) {
      return liveElapsedMs >= 1000
        ? process.workingFor({ duration: formatRunDuration(liveElapsedMs) })
        : process.working;
    }
    return process.working;
  }

  // Result-first resting state: a SEALED turn (not active) collapses to
  // "Worked for {duration}" (codex-style). While the turn is still active the
  // duration is partial, so the live/descriptive header stands — this is the
  // single gate for that (the caller passes the raw run wall-clock). A resultless
  // turn we're deliberately surfacing (a sealed DM turn, per #240) is excluded:
  // "Worked for …" would read as a clean unit of work and hide that there is no
  // answer, so it falls through to the descriptive summary instead. The
  // descriptive summaries below are also the fallback when the run's wall-clock is
  // unknown (e.g. legacy records with no run timing).
  if (!turnActive && workedForMs !== null && !surfaceResultlessProcess) {
    return process.workedFor({ duration: formatRunDuration(workedForMs) });
  }

  // Counted, kind-named tool-activity summary for a multi-tool turn (Codex's
  // "Ran 3 commands · read 2 files"), replacing the generic "Used N tools".
  const toolActivitySummary = () => summarizeToolActivity(
    toolCalls.map((toolCall) => ({ status: toolStatus(toolCall), toolCall })),
    process,
  );

  if (thinkingCount === 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = toolStatus(toolCall);
    return summarizeToolCall(toolCall, status, toolCallLabels);
  }

  if (thinkingCount === 0 && toolCount >= 2) return toolActivitySummary();

  if (thinkingCount === 1 && toolCount === 0) {
    return firstThinkingText ? process.thoughtPreview({ preview: previewText(firstThinkingText, 80) }) : process.thought;
  }

  if (thinkingCount > 0 && toolCount === 0) return process.thought;

  if (thinkingCount > 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = toolStatus(toolCall);
    return process.thoughtAndTool({ tool: summarizeToolCall(toolCall, status, toolCallLabels) });
  }

  if (thinkingCount > 0 && toolCount >= 2) {
    return process.thoughtAndActivity({ activity: sentenceFragment(toolActivitySummary()) });
  }

  return process.working;
}

// Tick a live elapsed clock (ms since `startedAtMs`) while `active`, re-rendering
// once a second so the "Working for {t}" header advances. Returns null when the
// segment isn't live or has no start (the header then falls back to a static
// label) — and the interval is gated on `active`, so a crashed/sealed run never
// keeps ticking (the "2d" runaway-clock bug). At most one live turn is on screen,
// so this is one interval at a time.
function useElapsedTick(startedAtMs: number | null, active: boolean): number | null {
  // Seed from the wall clock, not `startedAtMs`, so a run that began before this
  // mounted (e.g. reopening a conversation with an in-flight turn) shows its true
  // elapsed on the first paint instead of a one-frame bare "Working" (now -
  // startedAtMs === 0).
  const [now, setNow] = useState(() => Date.now());
  // A non-positive anchor is "turn-start unknown", not the Unix epoch: the live
  // anchor falls back to 0 when no user message is found, and `now - 0` would
  // render the entire epoch as "Working for 20000d+". Treat `<= 0` like null.
  const knownStart = startedAtMs !== null && startedAtMs > 0 ? startedAtMs : null;
  useEffect(() => {
    if (!active || knownStart === null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active, knownStart]);
  if (!active || knownStart === null) return null;
  return Math.max(0, now - knownStart);
}

export function AgentProcessBlock({
  expandState,
  index,
  onNodeReferenceOpen,
  onOpenChildRunTranscript,
  pendingToolCallIds,
  process,
  results,
  conversationId,
  childRunsByParentToolCallId,
  turnActive,
}: AgentProcessBlockProps) {
  const t = useT();
  const {
    answerStarted,
    id,
    items,
    liveStartedAtMs,
    sealed,
    surfaceResultlessProcess,
    turnFailedWithoutProse,
    workedForMs,
  } = process;
  // Memoized: the live "Working for {t}" ticker re-renders this block every second,
  // and streaming re-renders it per token — without this the fact set (several
  // array scans over every item) is rebuilt on each, just to advance a digit.
  const facts = useMemo(() => processSummaryFacts(items), [items]);
  const liveSegment = turnActive && !sealed;
  // Codex auto-collapse (machine C): the body shows EXPANDED while still working
  // (no answer yet) so the user watches the reasoning + tool activity 1:1, then
  // folds to the "Worked for {t}" divider the moment the final answer begins
  // (`answerStarted`). A surfaced resultless/interrupted turn always opens. A user
  // toggle (sticky via expandState) overrides either default.
  const defaultExpanded = surfaceResultlessProcess || (liveSegment && !answerStarted);
  const expanded = expandState.isExpanded(id, defaultExpanded);
  const liveCollapsed = liveSegment && !expanded;
  const liveElapsedMs = useElapsedTick(liveStartedAtMs, liveSegment);
  const toggle = (event: MouseEvent<HTMLElement>) => {
    expandState.toggle(id, expanded, event.currentTarget);
  };

  return (
    <div className={`agent-process-block ${turnFailedWithoutProse ? 'is-error' : ''}`}>
      <ButtonControl
        aria-expanded={expanded}
        className="agent-process-toggle"
        data-agent-disclosure-id={id}
        data-agent-process-id={id}
        onClick={toggle}
      >
        {/* The header is icon-free (codex-style): the summary text carries the
            state — the persistent "Working for {t}" / "Worked for {t}" divider, or
            an interrupted label — at the row's left edge, no leading glyph. A single
            TRAILING slot holds the disclosure chevron, swapped for the live spinner
            only while working AND collapsed — one slot, so the title never shifts
            across the loading→sealed transition (the "labels don't move" rule).
            While expanded the spinner moves to the running tool row in the
            timeline. */}
        <span className="agent-process-title">
          {summarizeProcess({
            ...facts,
            pendingToolCallIds,
            results,
            turnActive,
            liveElapsedMs,
            turnFailedWithoutProse,
            surfaceResultlessProcess,
            workedForMs,
            process: t.agent.process,
            toolCallLabels: t.agent.toolCall,
          })}
        </span>
        {liveCollapsed ? (
          <LoaderIcon className="agent-process-spinner" size={ICON_SIZE.rowGlyph} />
        ) : (
          <ChevronRightIcon
            aria-hidden
            className={`agent-process-chevron${expanded ? ' is-expanded' : ''}`}
            size={14}
          />
        )}
      </ButtonControl>
      {/* The full-width hairline of Codex's "Worked for" divider: a faint rule
          under the resting fold line, just above the answer. Only in the resting
          (collapsed) Working/Worked state — an interrupted turn is a RED label, not
          a divider, and an expanded body provides its own structure. */}
      {!expanded && !turnFailedWithoutProse ? (
        <div aria-hidden className="agent-process-rule" />
      ) : null}
      {expanded ? (
        <AgentProcessTimeline
          expandState={expandState}
          id={id}
          index={index}
          items={items}
          onNodeReferenceOpen={onNodeReferenceOpen}
          onOpenChildRunTranscript={onOpenChildRunTranscript}
          pendingToolCallIds={pendingToolCallIds}
          results={results}
          conversationId={conversationId}
          childRunsByParentToolCallId={childRunsByParentToolCallId}
          turnActive={turnActive}
        />
      ) : null}
    </div>
  );
}
