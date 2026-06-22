import type { AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { MouseEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDownIcon,
  ICON_SIZE,
  LoaderIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentProcessTimeline } from './AgentProcessTimeline';
import { childRunToolStatus, getToolCallStatus, summarizeToolCall } from './AgentToolCallBlock';
import { sentenceFragment, summarizeToolActivity } from './agentRenderGroups';
import type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';
import { firstLine, formatRunDuration, previewText } from './agentProcessTypes';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';

export type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';

// The latest thinking block that has streamed any text — drives the live status
// line during the thinking phase (before/between tool calls).
function lastNonEmptyThinking(
  thinkingBlocks: Extract<AgentProcessSegmentBlock, { kind: 'thinking' }>[],
): string | null {
  for (let i = thinkingBlocks.length - 1; i >= 0; i -= 1) {
    const text = thinkingBlocks[i]!.text.trim();
    if (text) return text;
  }
  return null;
}

function childRunMapFromToolSegments(blocks: AgentProcessSegmentBlock[]): ReadonlyMap<string, AgentRenderChildRunEntity> | undefined {
  let map: Map<string, AgentRenderChildRunEntity> | undefined;
  for (const block of blocks) {
    if (block.kind === 'toolCall' && block.childRun) {
      map ??= new Map<string, AgentRenderChildRunEntity>();
      map.set(block.toolCall.id, block.childRun);
    }
  }
  return map;
}

interface AgentProcessBlockProps {
  blocks: AgentProcessSegmentBlock[];
  expandState: AgentExpandState;
  id: string;
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenChildRunTranscript?: (childRunId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
  sealed: boolean;
  conversationId?: string | null;
  childRunsByParentToolCallId?: Map<string, AgentRenderChildRunEntity>;
  turnActive: boolean;
  /** Run actually failed/cancelled/crashed with no result → RED "Interrupted" label + error styling. */
  turnFailedWithoutProse: boolean;
  /**
   * Show this resultless turn's process expanded (and skip the "Worked for …"
   * resting header) so its interim work isn't buried. True for a genuine
   * interruption in either mode, and — per the #240 result-first design — for a
   * sealed resultless DM turn. A cleanly-completed resultless Channel turn is
   * false here: it folds to "Worked for …" (atomic delivery, no inline process).
   */
  surfaceResultlessProcess: boolean;
  /** Wall-clock the run took; surfaced as "Worked for …" once sealed. Null when unknown. */
  workedForMs: number | null;
  /**
   * The final answer has started streaming. Drives Codex's auto-collapse: the
   * body shows expanded while still WORKING (no answer yet) and folds to the
   * "Worked for {t}" divider the moment the answer begins. A user toggle (sticky
   * via expandState) overrides.
   */
  answerStarted: boolean;
  /** Producing run's start, for the live "Working for {t}" ticker; null unless running. */
  liveStartedAtMs: number | null;
}

interface ProcessSummaryFacts {
  childRunsByToolCallId?: ReadonlyMap<string, AgentRenderChildRunEntity>;
  toolCallOutcomes: ReadonlyMap<string, AgentToolCallOutcome>;
  firstThinkingText: string | null;
  lastThinkingText: string | null;
  thinkingCount: number;
  toolCalls: ToolCall[];
}

function toolCallOutcomeMap(blocks: AgentProcessSegmentBlock[]): ReadonlyMap<string, AgentToolCallOutcome> {
  const map = new Map<string, AgentToolCallOutcome>();
  for (const block of blocks) {
    if (block.kind === 'toolCall' && block.outcome) map.set(block.toolCall.id, block.outcome);
  }
  return map;
}

function processSummaryFacts(blocks: AgentProcessSegmentBlock[]): ProcessSummaryFacts {
  const thinkingBlocks = blocks.filter(
    (block): block is Extract<AgentProcessSegmentBlock, { kind: 'thinking' }> => block.kind === 'thinking',
  );
  const toolCalls = blocks
    .filter((block): block is Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> => block.kind === 'toolCall')
    .map((block) => block.toolCall);
  return {
    childRunsByToolCallId: childRunMapFromToolSegments(blocks),
    toolCallOutcomes: toolCallOutcomeMap(blocks),
    firstThinkingText: firstLine(thinkingBlocks[0]?.text ?? ''),
    lastThinkingText: lastNonEmptyThinking(thinkingBlocks),
    thinkingCount: thinkingBlocks.length,
    toolCalls,
  };
}

export function summarizeProcess({
  firstThinkingText,
  lastThinkingText,
  thinkingCount,
  pendingToolCallIds,
  results,
  childRunsByToolCallId,
  toolCallOutcomes,
  toolCalls,
  turnActive,
  liveCollapsed,
  liveElapsedMs,
  turnFailedWithoutProse,
  surfaceResultlessProcess,
  workedForMs,
  process,
  toolCallLabels,
  thinkingLabel,
}: {
  firstThinkingText: string | null;
  lastThinkingText: string | null;
  thinkingCount: number;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
  childRunsByToolCallId?: ReadonlyMap<string, AgentRenderChildRunEntity>;
  toolCallOutcomes?: ReadonlyMap<string, AgentToolCallOutcome>;
  toolCalls: ToolCall[];
  liveCollapsed: boolean;
  /** Live wall-clock since the run started, for the "Working for {t}" ticker; null when unknown. */
  liveElapsedMs: number | null;
  turnActive: boolean;
  turnFailedWithoutProse: boolean;
  surfaceResultlessProcess: boolean;
  workedForMs: number | null;
  process: Messages['agent']['process'];
  toolCallLabels: Messages['agent']['toolCall'];
  thinkingLabel: string;
}): string {
  const toolCount = toolCalls.length;
  const fallbackActiveToolCallId = turnActive && pendingToolCallIds.size === 0
    ? [...toolCalls].reverse().find((toolCall) => (
      !toolCallOutcomes?.has(toolCall.id)
      && !results.has(toolCall.id)
      && !childRunsByToolCallId?.has(toolCall.id)
    ))?.id ?? null
    : null;
  const toolStatus = (toolCall: ToolCall) => {
    const childRun = childRunsByToolCallId?.get(toolCall.id);
    if (childRun) return childRunToolStatus(childRun);
    return getToolCallStatus(
      toolCall.id,
      results.get(toolCall.id),
      pendingToolCallIds,
      fallbackActiveToolCallId === toolCall.id,
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
  // clock (legacy entries) a collapsed live turn falls back to the running tool /
  // latest thought; an expanded clock-less live turn falls through to the
  // descriptive summary.
  if (turnActive) {
    if (liveElapsedMs !== null) {
      return liveElapsedMs >= 1000
        ? process.workingFor({ duration: formatRunDuration(liveElapsedMs) })
        : process.working;
    }
    if (liveCollapsed) {
      for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
        const toolCall = toolCalls[i]!;
        const status = toolStatus(toolCall);
        if (status === 'pending') return summarizeToolCall(toolCall, status, toolCallLabels);
      }
      if (lastThinkingText) return previewText(lastThinkingText, 80);
      if (thinkingCount > 0) return thinkingLabel;
      return process.working;
    }
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
  useEffect(() => {
    if (!active || startedAtMs === null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active, startedAtMs]);
  if (!active || startedAtMs === null) return null;
  return Math.max(0, now - startedAtMs);
}

export function AgentProcessBlock({
  blocks,
  expandState,
  id,
  index,
  onNodeReferenceOpen,
  onOpenChildRunTranscript,
  pendingToolCallIds,
  results,
  sealed,
  conversationId,
  childRunsByParentToolCallId,
  turnActive,
  turnFailedWithoutProse,
  surfaceResultlessProcess,
  workedForMs,
  answerStarted,
  liveStartedAtMs,
}: AgentProcessBlockProps) {
  const t = useT();
  // Memoized: the live "Working for {t}" ticker re-renders this block every second,
  // and streaming re-renders it per token — without this the fact set (several
  // array scans over every block) is rebuilt on each, just to advance a digit.
  const facts = useMemo(() => processSummaryFacts(blocks), [blocks]);
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
            liveCollapsed,
            liveElapsedMs,
            turnFailedWithoutProse,
            surfaceResultlessProcess,
            workedForMs,
            process: t.agent.process,
            toolCallLabels: t.agent.toolCall,
            thinkingLabel: t.agent.thinking.thinking,
          })}
        </span>
        {liveCollapsed ? (
          <LoaderIcon className="agent-process-spinner" size={ICON_SIZE.rowGlyph} />
        ) : (
          <ChevronDownIcon
            aria-hidden
            className={`agent-process-chevron${expanded ? ' is-expanded' : ''}`}
            size={14}
          />
        )}
      </ButtonControl>
      {expanded ? (
        <AgentProcessTimeline
          blocks={blocks}
          expandState={expandState}
          id={id}
          index={index}
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
