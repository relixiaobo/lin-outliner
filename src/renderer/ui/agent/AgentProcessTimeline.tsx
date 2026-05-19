import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import { AgentThinkingBody, AgentThinkingRow } from './AgentThinkingBlock';
import { AgentToolCallBlock } from './AgentToolCallBlock';
import type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';

interface AgentProcessTimelineProps {
  blocks: AgentProcessSegmentBlock[];
  expandState: AgentExpandState;
  id: string;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
  sessionId?: string | null;
  turnActive: boolean;
}

export function AgentProcessTimeline({
  blocks,
  expandState,
  id,
  pendingToolCallIds,
  results,
  sessionId,
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
              key={`tool-${block.toolCall.id}`}
              onToggle={() => {
                const toolId = `tool:${block.toolCall.id}`;
                expandState.toggle(toolId, expandState.isExpanded(toolId, false));
              }}
              pendingToolCallIds={pendingToolCallIds}
              result={results.get(block.toolCall.id)}
              sessionId={sessionId}
              toolCall={block.toolCall}
              turnActive={turnActive}
            />
          );
        })
      )}
    </div>
  );
}
