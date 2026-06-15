import type { AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import {
  ChevronDownIcon,
  ICON_SIZE,
  LoaderIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentProcessTimeline } from './AgentProcessTimeline';
import { getToolCallStatus, summarizeToolCall } from './AgentToolCallBlock';
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

export function summarizeProcess({
  firstThinkingText,
  lastThinkingText,
  thinkingCount,
  pendingToolCallIds,
  results,
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

  // While the turn is live AND the block is collapsed, the header doubles as a
  // live status line: whichever tool is currently running, else the latest
  // streaming thought. Once expanded, control falls through to the static summary
  // below and the running tool row inside the timeline carries the only spinner.
  if (liveCollapsed) {
    for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
      const toolCall = toolCalls[i]!;
      const status = getToolCallStatus(toolCall.id, results.get(toolCall.id), pendingToolCallIds, turnActive);
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
    const status = getToolCallStatus(toolCall.id, results.get(toolCall.id), pendingToolCallIds, turnActive);
    return summarizeToolCall(toolCall, status, toolCallLabels);
  }

  if (thinkingCount === 0 && toolCount >= 2) return process.usedTools({ count: toolCount });

  if (thinkingCount === 1 && toolCount === 0) {
    return firstThinkingText ? process.thoughtPreview({ preview: previewText(firstThinkingText, 80) }) : process.thought;
  }

  if (thinkingCount > 0 && toolCount === 0) return process.thought;

  if (thinkingCount > 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = getToolCallStatus(toolCall.id, results.get(toolCall.id), pendingToolCallIds, turnActive);
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
  const thinkingBlocks = blocks.filter(
    (block): block is Extract<AgentProcessSegmentBlock, { kind: 'thinking' }> => block.kind === 'thinking',
  );
  const toolCalls = blocks
    .filter((block): block is Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> => block.kind === 'toolCall')
    .map((block) => block.toolCall);
  const firstThinkingText = firstLine(thinkingBlocks[0]?.text ?? '');
  const lastThinkingText = lastNonEmptyThinking(thinkingBlocks);
  const liveSegment = turnActive && !sealed;
  // Codex-style live disclosure: a DM turn auto-expands **while it is working**
  // (`liveSegment` — thinking/tools streaming) so the process is visible, then
  // auto-collapses to "Worked for …" the moment it seals (final text begins) or
  // the turn ends. A resultless turn we're surfacing (`surfaceResultlessProcess` —
  // a genuine interruption in either mode, or a sealed resultless DM turn per #240)
  // also auto-expands so its interim work / error context stays visible. Everything
  // else defaults collapsed — including a cleanly-completed resultless Channel turn,
  // which folds to "Worked for …" (atomic delivery, process in the activity detail
  // view, not inline). The sticky override wins over the default: once a user
  // toggles the block it keeps their choice and never auto-collapses on seal.
  const defaultExpanded = surfaceResultlessProcess || liveSegment;
  const expanded = expandState.isExpanded(id, defaultExpanded);
  const liveCollapsed = liveSegment && !expanded;

  return (
    <div className={`agent-process-block ${turnFailedWithoutProse ? 'is-error' : ''}`}>
      <ButtonControl
        aria-expanded={expanded}
        className="agent-process-toggle"
        onClick={() => expandState.toggle(id, expanded)}
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
            firstThinkingText,
            lastThinkingText,
            thinkingCount: thinkingBlocks.length,
            pendingToolCallIds,
            results,
            toolCalls,
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
