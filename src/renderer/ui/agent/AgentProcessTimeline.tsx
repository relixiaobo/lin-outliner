import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentThinkingBody, AgentThinkingRow } from './AgentThinkingBlock';
import { AgentToolActivityGroup } from './AgentToolActivityGroup';
import { AgentToolCallBlock, getLoadedSkillDetails } from './AgentToolCallBlock';
import { splitTimelineIntoGroups } from './agentRenderGroups';
import type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';

interface AgentProcessTimelineProps {
  blocks: AgentProcessSegmentBlock[];
  expandState: AgentExpandState;
  id: string;
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenChildRunTranscript?: (childRunId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
  conversationId?: string | null;
  childRunsByParentToolCallId?: Map<string, AgentRenderChildRunEntity>;
  turnActive: boolean;
}

export function AgentProcessTimeline({
  blocks,
  expandState,
  id,
  index,
  onNodeReferenceOpen,
  onOpenChildRunTranscript,
  pendingToolCallIds,
  results,
  conversationId,
  childRunsByParentToolCallId,
  turnActive,
}: AgentProcessTimelineProps) {
  // A lone thought (no tools, no narration) renders as an always-open body; any
  // richer process renders the per-block timeline below. The block union is
  // exactly thinking|toolCall|narration, so "one block and it's a thought"
  // captures the solo case without three throwaway classification passes.
  const onlyBlock = blocks.length === 1 ? blocks[0]! : null;
  const soloThinkingBlock = onlyBlock?.kind === 'thinking' ? onlyBlock : null;
  // The runtime `pendingToolCallIds` set can momentarily lag a freshly-started
  // tool call, so an active turn keeps the most recent un-settled tool call
  // spinning as a bridge. A call with a settled `outcome` (or a result, or a
  // child run) is NOT un-settled — excluding those is what stops a completed
  // step from spinning forever when its result message never arrives.
  const fallbackActiveToolCall = turnActive && pendingToolCallIds.size === 0
    ? [...blocks].reverse().find((block): block is Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> => (
      block.kind === 'toolCall'
      && !block.outcome
      && !results.has(block.toolCall.id)
      && !(block.childRun ?? childRunsByParentToolCallId?.get(block.toolCall.id))
    ))
    : undefined;
  const fallbackActiveToolCallId = fallbackActiveToolCall?.toolCall.id ?? null;

  // Fold runs of consecutive (non-child-run) tool calls into one counted
  // activity group; thinking / narration / child-run tools break the run and
  // render standalone (Codex's render-group split). A loaded-skill chip also
  // breaks the run — it is a compact glanceable affordance, not an expandable
  // tool row, so grouping it would bury it.
  const groups = splitTimelineIntoGroups(blocks, (block) => (
    Boolean(block.childRun ?? childRunsByParentToolCallId?.get(block.toolCall.id))
    || getLoadedSkillDetails(block.toolCall, results.get(block.toolCall.id)) !== null
  ));

  const renderBlock = (block: AgentProcessSegmentBlock) => {
    if (block.kind === 'thinking') {
      return (
        <AgentThinkingRow
          expandState={expandState}
          id={`${id}:thinking:${block.sourceIndex}`}
          index={index}
          keyPrefix={`${id}-thinking-${block.sourceIndex}`}
          key={`thinking-${block.sourceIndex}`}
          onNodeReferenceOpen={onNodeReferenceOpen}
          streaming={block.streaming}
          text={block.text}
        />
      );
    }
    if (block.kind === 'narration') {
      return (
        <div className="agent-process-narration" key={`narration-${block.sourceIndex}`}>
          <AgentMarkdown
            index={index}
            keyPrefix={`${id}-narration-${block.sourceIndex}`}
            onNodeReferenceOpen={onNodeReferenceOpen}
            streaming={block.streaming}
            text={block.text}
          />
        </div>
      );
    }
    const childRun = block.childRun ?? childRunsByParentToolCallId?.get(block.toolCall.id);
    return (
      <AgentToolCallBlock
        expanded={expandState.isExpanded(`tool:${block.toolCall.id}`, false)}
        index={index}
        key={`tool-${block.toolCall.id}`}
        onToggle={(anchorElement) => {
          const toolId = `tool:${block.toolCall.id}`;
          expandState.toggle(toolId, expandState.isExpanded(toolId, false), anchorElement);
        }}
        onNodeReferenceOpen={onNodeReferenceOpen}
        onOpenChildRunTranscript={onOpenChildRunTranscript}
        pendingToolCallIds={pendingToolCallIds}
        result={results.get(block.toolCall.id)}
        conversationId={conversationId}
        childRun={childRun}
        toolCall={block.toolCall}
        outcome={block.outcome}
        turnActive={pendingToolCallIds.has(block.toolCall.id) || fallbackActiveToolCallId === block.toolCall.id}
      />
    );
  };

  return (
    <div className="agent-process-timeline">
      {soloThinkingBlock ? (
        <AgentThinkingBody
          expandState={expandState}
          id={`${id}:thinking:${soloThinkingBlock.sourceIndex}`}
          index={index}
          keyPrefix={`${id}-thinking-${soloThinkingBlock.sourceIndex}`}
          onNodeReferenceOpen={onNodeReferenceOpen}
          streaming={soloThinkingBlock.streaming}
          text={soloThinkingBlock.text}
        />
      ) : (
        groups.map((group) => {
          if (group.kind === 'toolActivity') {
            return (
              <AgentToolActivityGroup
                conversationId={conversationId}
                expandState={expandState}
                fallbackActiveToolCallId={fallbackActiveToolCallId}
                id={`${id}:${group.id}`}
                index={index}
                key={group.id}
                members={group.members}
                onNodeReferenceOpen={onNodeReferenceOpen}
                onOpenChildRunTranscript={onOpenChildRunTranscript}
                pendingToolCallIds={pendingToolCallIds}
                results={results}
              />
            );
          }
          return renderBlock(group.block);
        })
      )}
    </div>
  );
}
