import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentRenderSubagentEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentThinkingBody, AgentThinkingRow } from './AgentThinkingBlock';
import { AgentToolCallBlock } from './AgentToolCallBlock';
import type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';

interface AgentProcessTimelineProps {
  blocks: AgentProcessSegmentBlock[];
  expandState: AgentExpandState;
  id: string;
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenSubagentTranscript?: (subagentId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
  conversationId?: string | null;
  subagentsByParentToolCallId?: Map<string, AgentRenderSubagentEntity>;
  turnActive: boolean;
}

export function AgentProcessTimeline({
  blocks,
  expandState,
  id,
  index,
  onNodeReferenceOpen,
  onOpenSubagentTranscript,
  pendingToolCallIds,
  results,
  conversationId,
  subagentsByParentToolCallId,
  turnActive,
}: AgentProcessTimelineProps) {
  const thinkingBlocks = blocks.filter(
    (block): block is Extract<AgentProcessSegmentBlock, { kind: 'thinking' }> => block.kind === 'thinking',
  );
  const toolCallBlocks = blocks.filter(
    (block): block is Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }> => block.kind === 'toolCall',
  );
  const soloThinking = thinkingBlocks.length === 1 && toolCallBlocks.length === 0;

  return (
    <div className="agent-process-timeline">
      {soloThinking ? (
        <AgentThinkingBody streaming={thinkingBlocks[0]!.streaming} text={thinkingBlocks[0]!.text} />
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
          return (
            <AgentToolCallBlock
              expanded={expandState.isExpanded(`tool:${block.toolCall.id}`, false)}
              index={index}
              key={`tool-${block.toolCall.id}`}
              onToggle={() => {
                const toolId = `tool:${block.toolCall.id}`;
                expandState.toggle(toolId, expandState.isExpanded(toolId, false));
              }}
              onNodeReferenceOpen={onNodeReferenceOpen}
              onOpenSubagentTranscript={onOpenSubagentTranscript}
              pendingToolCallIds={pendingToolCallIds}
              result={results.get(block.toolCall.id)}
              conversationId={conversationId}
              subagent={subagentsByParentToolCallId?.get(block.toolCall.id)}
              toolCall={block.toolCall}
              turnActive={turnActive}
            />
          );
        })
      )}
    </div>
  );
}
