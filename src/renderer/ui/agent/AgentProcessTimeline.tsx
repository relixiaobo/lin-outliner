import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentThinkingBody, AgentThinkingRow } from './AgentThinkingBlock';
import { AgentToolCallBlock } from './AgentToolCallBlock';
import type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';

type ToolCallBlock = Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }>;

/**
 * Whether a tool-call row should show as active (spinner) rather than settle.
 *
 * While the turn is live, EVERY un-settled tool call counts as active, not just the
 * most recent one. The runtime `pendingToolCallIds` set lags a freshly-dispatched
 * batch, and when one assistant fans out parallel tool calls there is a frame where
 * none is in-flight yet — narrowing the spinner to a single call flashed the rest red.
 * A call with a settled `outcome` (or a result, or a child run) is NOT un-settled, so
 * a completed step never spins forever even if its result message never arrives; once
 * the turn settles `turnActive` goes false and a genuinely-unanswered call resolves to
 * its real error/incomplete state.
 */
export function isToolCallRowActive(
  block: ToolCallBlock,
  pendingToolCallIds: ReadonlySet<string>,
  results: ReadonlyMap<string, AgentToolResultWithPayloads>,
  childRun: AgentRenderChildRunEntity | undefined,
  turnActive: boolean,
): boolean {
  if (pendingToolCallIds.has(block.toolCall.id)) return true;
  return turnActive && !block.outcome && !results.has(block.toolCall.id) && !childRun;
}

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
              outcome={block.outcome}
              turnActive={isToolCallRowActive(block, pendingToolCallIds, results, childRun, turnActive)}
            />
          );
        })
      )}
    </div>
  );
}
