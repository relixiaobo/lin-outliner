import type { AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import { useEffect, useMemo, useState } from 'react';
import {
  ICON_SIZE,
  LoaderIcon,
} from '../icons';
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
  stopped,
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
  stopped?: boolean;
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

  if (stopped) {
    return workedForMs !== null
      ? process.stoppedAfter({ duration: formatRunDuration(workedForMs) })
      : process.stopped;
  }

  // Live divider: while the turn is active the non-interactive status row is the
  // ticking clock — "Working for {t}" (>=1s) / bare "Working" (<1s, no number so
  // it never flickers a "0s"). Without a run clock, stay on bare "Working"; the
  // timeline below carries the detailed thought/tool activity.
  if (turnActive) {
    if (liveElapsedMs !== null) {
      return liveElapsedMs >= 1000
        ? process.workingFor({ duration: formatRunDuration(liveElapsedMs) })
        : process.working;
    }
    return process.working;
  }

  // Result-first resting state: a sealed turn with a final answer gets a
  // non-interactive "Worked for {duration}" divider. A resultless turn we're
  // deliberately surfacing (a sealed DM turn, per #240) is excluded: "Worked for
  // ..." would read as a clean unit of work and hide that there is no answer, so
  // it falls through to the descriptive summary instead. The descriptive
  // summaries below are also the fallback when the run's wall-clock is unknown
  // (e.g. legacy records with no run timing).
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
  const { answerStarted, id, items, liveStartedAtMs, sealed, showSummaryRow, showWorkDivider, stopped, surfaceResultlessProcess, turnFailedWithoutProse, workedForMs } = process;
  // Memoized: the live "Working for {t}" ticker re-renders this block every
  // second, and streaming re-renders it per token. Without this the fact set
  // (several array scans over every item) is rebuilt on each tick.
  const facts = useMemo(() => processSummaryFacts(items), [items]);
  const liveSegment = turnActive && !sealed;
  const liveElapsedMs = useElapsedTick(liveStartedAtMs, liveSegment);
  const showTimeline = items.length > 0;
  const showStatusRow = showWorkDivider || showSummaryRow || turnFailedWithoutProse || !showTimeline;
  const showDividerRule = showWorkDivider && !turnFailedWithoutProse;

  return (
    <div className={`agent-process-block ${turnFailedWithoutProse ? 'is-error' : ''}`}>
      {showStatusRow ? (
        <div
          className={showWorkDivider ? 'agent-work-divider' : 'agent-process-summary-row'}
          data-agent-process-id={id}
        >
          <span className="agent-process-title">
            {summarizeProcess({
              ...facts,
              pendingToolCallIds,
              results,
              turnActive,
              liveElapsedMs,
              stopped,
              turnFailedWithoutProse,
              surfaceResultlessProcess,
              workedForMs,
              process: t.agent.process,
              toolCallLabels: t.agent.toolCall,
            })}
          </span>
          {liveSegment ? (
            <LoaderIcon className="agent-process-spinner" size={ICON_SIZE.rowGlyph} />
          ) : null}
        </div>
      ) : null}
      {showDividerRule ? (
        <div aria-hidden className="agent-process-rule" />
      ) : null}
      {showTimeline ? (
        <AgentProcessTimeline
          answerStarted={answerStarted}
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
