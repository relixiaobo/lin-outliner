import type { ToolCall, ToolResultMessage } from '../../../core/agentTypes';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  LoaderIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentProcessTimeline } from './AgentProcessTimeline';
import { getToolCallStatus, summarizeToolCall } from './AgentToolCallBlock';
import type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';
import { firstLine, previewText } from './agentProcessTypes';

export type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';

interface AgentProcessBlockProps {
  blocks: AgentProcessSegmentBlock[];
  expandState: AgentExpandState;
  id: string;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, ToolResultMessage>;
  sealed: boolean;
  turnActive: boolean;
  turnFailedWithoutProse: boolean;
}

export function summarizeProcess({
  firstThinkingText,
  thinkingCount,
  pendingToolCallIds,
  results,
  toolCalls,
  turnActive,
  sealed,
  turnFailedWithoutProse,
}: {
  firstThinkingText: string | null;
  thinkingCount: number;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, ToolResultMessage>;
  toolCalls: ToolCall[];
  sealed: boolean;
  turnActive: boolean;
  turnFailedWithoutProse: boolean;
}): string {
  const toolCount = toolCalls.length;

  if (turnActive && !sealed) return 'Working...';

  if (turnFailedWithoutProse) {
    if (thinkingCount > 0 && toolCount > 0) return 'Interrupted after thinking';
    if (thinkingCount > 0) return 'Thought (interrupted)';
    return 'Interrupted';
  }

  if (thinkingCount === 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = getToolCallStatus(toolCall.id, results.get(toolCall.id), pendingToolCallIds, turnActive);
    return summarizeToolCall(toolCall, status);
  }

  if (thinkingCount === 0 && toolCount >= 2) return `Used ${toolCount} tools`;

  if (thinkingCount === 1 && toolCount === 0) {
    return firstThinkingText ? `Thought · ${previewText(firstThinkingText, 80)}` : 'Thought';
  }

  if (thinkingCount > 0 && toolCount === 0) return 'Thought';

  if (thinkingCount > 0 && toolCount === 1) {
    const toolCall = toolCalls[0]!;
    const status = getToolCallStatus(toolCall.id, results.get(toolCall.id), pendingToolCallIds, turnActive);
    return `Thought · ${summarizeToolCall(toolCall, status)}`;
  }

  if (thinkingCount > 0 && toolCount >= 2) return `Thought · used ${toolCount} tools`;

  return 'Working...';
}

export function AgentProcessBlock({
  blocks,
  expandState,
  id,
  pendingToolCallIds,
  results,
  sealed,
  turnActive,
  turnFailedWithoutProse,
}: AgentProcessBlockProps) {
  const thinkingBlocks = blocks.filter(
    (block): block is Extract<AgentProcessSegmentBlock, { kind: 'thinking' }> => block.kind === 'thinking',
  );
  const toolCalls = blocks
    .filter((block): block is Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> => block.kind === 'toolCall')
    .map((block) => block.toolCall);
  const firstThinkingText = firstLine(thinkingBlocks[0]?.text ?? '');
  const liveSegment = turnActive && !sealed;
  const defaultExpanded = liveSegment || turnFailedWithoutProse;
  const expanded = expandState.isExpanded(id, defaultExpanded);
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className={`agent-process-block ${turnFailedWithoutProse ? 'is-error' : ''}`}>
      <ButtonControl
        aria-expanded={expanded}
        className="agent-process-toggle"
        onClick={() => expandState.toggle(id, expanded)}
      >
        {liveSegment ? (
          <LoaderIcon className="agent-process-spinner" size={12} />
        ) : null}
        <span className="agent-process-title">
          {summarizeProcess({
            firstThinkingText,
            thinkingCount: thinkingBlocks.length,
            pendingToolCallIds,
            results,
            toolCalls,
            turnActive,
            sealed,
            turnFailedWithoutProse,
          })}
        </span>
        <Chevron size={12} />
      </ButtonControl>
      {expanded ? (
        <AgentProcessTimeline
          blocks={blocks}
          expandState={expandState}
          id={id}
          pendingToolCallIds={pendingToolCallIds}
          results={results}
          turnActive={turnActive}
        />
      ) : null}
    </div>
  );
}
