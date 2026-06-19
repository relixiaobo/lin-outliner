import type { AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { MouseEvent, ReactNode } from 'react';
import {
  ChevronDownIcon,
  ICON_SIZE,
  LoaderIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentProcessTimeline } from './AgentProcessTimeline';
import { childRunToolStatus, getToolCallStatus, summarizeToolCall } from './AgentToolCallBlock';
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
}

interface AgentTurnProcessFoldProps extends Omit<AgentProcessBlockProps, 'conversationId' | 'childRunsByParentToolCallId' | 'index' | 'onNodeReferenceOpen' | 'onOpenChildRunTranscript' | 'results'> {
  children: ReactNode;
  results: Map<string, AgentToolResultWithPayloads>;
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

  // While the turn is live AND the block is collapsed, the header doubles as a
  // live status line: whichever tool is currently running, else the latest
  // streaming thought. Once expanded, control falls through to the static summary
  // below and the running tool row inside the timeline carries the only spinner.
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

  if (turnFailedWithoutProse) {
    if (thinkingCount > 0 && toolCount > 0) return process.interruptedAfterThinking;
    if (thinkingCount > 0) return process.thoughtInterrupted;
    return process.interrupted;
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

  if (thinkingCount === 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = toolStatus(toolCall);
    return summarizeToolCall(toolCall, status, toolCallLabels);
  }

  if (thinkingCount === 0 && toolCount >= 2) return process.usedTools({ count: toolCount });

  if (thinkingCount === 1 && toolCount === 0) {
    return firstThinkingText ? process.thoughtPreview({ preview: previewText(firstThinkingText, 80) }) : process.thought;
  }

  if (thinkingCount > 0 && toolCount === 0) return process.thought;

  if (thinkingCount > 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = toolStatus(toolCall);
    return process.thoughtAndTool({ tool: summarizeToolCall(toolCall, status, toolCallLabels) });
  }

  if (thinkingCount > 0 && toolCount >= 2) return process.thoughtAndUsedTools({ count: toolCount });

  return process.working;
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
}: AgentProcessBlockProps) {
  const t = useT();
  const facts = processSummaryFacts(blocks);
  const liveSegment = turnActive && !sealed;
  // Live process rows now default collapsed; the collapsed header carries the
  // active tool/thinking summary. Resultless/error surfacing still opens by
  // default so context is not buried.
  const defaultExpanded = surfaceResultlessProcess;
  const expanded = expandState.isExpanded(id, defaultExpanded);
  const liveCollapsed = liveSegment && !expanded;
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
        {/* The "Worked for …" header is icon-free (codex-style): the summary text
            carries the state (it already reads "Worked for 13s" / "Thought · used N
            tools" / an interrupted label) at the row's left edge, no leading glyph.
            A single TRAILING slot holds the disclosure chevron, swapped for the live
            spinner while the turn is actively working and collapsed — one slot, so
            the title never shifts across the loading→sealed transition (the
            "labels don't move" rule). Once expanded the spinner moves to the
            running tool row in the timeline. */}
        <span className="agent-process-title">
          {summarizeProcess({
            ...facts,
            pendingToolCallIds,
            results,
            turnActive,
            liveCollapsed,
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

export function AgentTurnProcessFold({
  blocks,
  children,
  expandState,
  id,
  pendingToolCallIds,
  results,
  sealed,
  turnActive,
  turnFailedWithoutProse,
  surfaceResultlessProcess,
  workedForMs,
}: AgentTurnProcessFoldProps) {
  const t = useT();
  const liveSegment = turnActive && !sealed;
  const defaultExpanded = surfaceResultlessProcess;
  const expanded = expandState.isExpanded(id, defaultExpanded);
  const liveCollapsed = liveSegment && !expanded;
  const facts = processSummaryFacts(blocks);
  const title = summarizeProcess({
    ...facts,
    pendingToolCallIds,
    results,
    turnActive,
    liveCollapsed,
    turnFailedWithoutProse,
    surfaceResultlessProcess,
    workedForMs,
    process: t.agent.process,
    toolCallLabels: t.agent.toolCall,
    thinkingLabel: t.agent.thinking.thinking,
  });
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
        <span className="agent-process-title">
          {title}
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
        <div className="agent-process-flat">
          {children}
        </div>
      ) : null}
    </div>
  );
}
