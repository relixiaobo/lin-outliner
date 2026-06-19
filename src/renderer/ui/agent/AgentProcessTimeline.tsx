import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentThinkingBody, AgentThinkingRow } from './AgentThinkingBlock';
import { AgentToolCallBlock } from './AgentToolCallBlock';
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
  const fallbackActiveToolCall = turnActive && pendingToolCallIds.size === 0
    ? [...blocks].reverse().find((block): block is Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> => (
      block.kind === 'toolCall'
      && !results.has(block.toolCall.id)
      && !(block.childRun ?? childRunsByParentToolCallId?.get(block.toolCall.id))
    ))
    : undefined;
  const fallbackActiveToolCallId = fallbackActiveToolCall?.toolCall.id ?? null;

  return (
    <div className="agent-process-timeline">
      {soloThinkingBlock ? (
        <AgentThinkingBody streaming={soloThinkingBlock.streaming} text={soloThinkingBlock.text} />
      ) : (
        blocks.map((block) => {
          if (block.kind === 'thinking') {
            return (
              <AgentThinkingRow
                expandState={expandState}
                id={`${id}:thinking:${block.sourceIndex}`}
                key={`thinking-${block.sourceIndex}`}
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
              turnActive={pendingToolCallIds.has(block.toolCall.id) || fallbackActiveToolCallId === block.toolCall.id}
            />
          );
        })
      )}
    </div>
  );
}
