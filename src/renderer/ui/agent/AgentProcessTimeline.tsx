import { useMemo } from 'react';
import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentThinkingBody, AgentThinkingRow } from './AgentThinkingBlock';
import { AgentToolActivityGroup } from './AgentToolActivityGroup';
import { AgentToolCallBlock, getLoadedSkillDetails } from './AgentToolCallBlock';
import { splitTimelineIntoGroups } from './agentRenderGroups';
import type { AgentExpandState } from './agentProcessTypes';
import type { AgentTurnProcessItem, AgentTurnToolCallItem } from './agentTurnProjection';

/**
 * Whether a tool-call row should show as active (spinner) rather than settle.
 *
 * While the turn is live, EVERY un-settled tool call counts as active, not just the
 * most recent one. The runtime `pendingToolCallIds` set lags a freshly-dispatched
 * batch, and when one assistant fans out parallel tool calls there is a frame where
 * none is in-flight yet — narrowing the spinner to a single call flashed the rest red.
 * A call with a settled `outcome` (or a result, or a sub-run) is NOT unsettled, so
 * a completed step never spins forever even if its result message never arrives; once
 * the turn settles `turnActive` goes false and a genuinely-unanswered call resolves to
 * its real error/incomplete state.
 */
export function isToolCallRowActive(
  item: AgentTurnToolCallItem,
  pendingToolCallIds: ReadonlySet<string>,
  results: ReadonlyMap<string, AgentToolResultWithPayloads>,
  subRun: AgentRenderRunEntity | undefined,
  turnActive: boolean,
): boolean {
  if (pendingToolCallIds.has(item.toolCall.id)) return true;
  return turnActive && !item.outcome && !results.has(item.toolCall.id) && !subRun;
}

interface AgentProcessTimelineProps {
  answerStarted: boolean;
  expandState: AgentExpandState;
  id: string;
  index: DocumentIndex;
  items: AgentTurnProcessItem[];
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRunTranscript?: (runId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
  conversationId?: string | null;
  subRunsByParentToolCallId?: Map<string, AgentRenderRunEntity>;
  turnActive: boolean;
}

export function AgentProcessTimeline({
  answerStarted,
  expandState,
  id,
  index,
  items,
  onNodeReferenceOpen,
  onOpenRunTranscript,
  pendingToolCallIds,
  results,
  conversationId,
  subRunsByParentToolCallId,
  turnActive,
}: AgentProcessTimelineProps) {
  // A sealed reasoning item that streamed to empty text carries nothing to show
  // (and would otherwise break a tool-activity run in two and leave a phantom gap
  // where it renders null). Drop it before splitting; an empty LIVE reasoning item
  // stays — it renders the "Thinking" cue.
  const visibleItems = useMemo(
    () => items.filter(
      (item) => !(item.type === 'reasoning' && !item.streaming && item.text.trim() === ''),
    ),
    [items],
  );
  // A lone thought only opens by default when it is the whole resultless process.
  // If the turn has a final answer, reasoning still folds like a tool step so
  // ordinary answered turns do not spill full thinking above the answer.
  const onlyItem = visibleItems.length === 1 ? visibleItems[0]! : null;
  const soloResultlessThinkingItem = !answerStarted && onlyItem?.type === 'reasoning' ? onlyItem : null;

  // Fold runs of consecutive tool calls into one counted activity group; thinking
  // / narration break the run (Codex's render-group split). A loaded-skill chip
  // also breaks the run — it is a compact glanceable affordance, not an
  // expandable tool row, so grouping it would bury it. Memoized: this re-runs the
  // splitter (and getLoadedSkillDetails per tool item) on every render, including
  // each 1s ticker tick and streaming token, unless pinned to its real inputs.
  const groups = useMemo(
    () => splitTimelineIntoGroups(visibleItems, (item) => (
      getLoadedSkillDetails(item.toolCall, results.get(item.toolCall.id)) !== null
    )),
    [visibleItems, results],
  );

  const renderItem = (item: AgentTurnProcessItem) => {
    if (item.type === 'reasoning') {
      return (
        <AgentThinkingRow
          expandState={expandState}
          id={item.id}
          index={index}
          keyPrefix={item.id}
          key={item.id}
          onNodeReferenceOpen={onNodeReferenceOpen}
          streaming={item.streaming}
          text={item.text}
        />
      );
    }
    if (item.type === 'agentMessage') {
      return (
        <div className="agent-process-narration" key={item.id}>
          <AgentMarkdown
            index={index}
            keyPrefix={item.id}
            onNodeReferenceOpen={onNodeReferenceOpen}
            streaming={item.streaming}
            text={item.text}
          />
        </div>
      );
    }
    const subRun = item.subRun ?? subRunsByParentToolCallId?.get(item.toolCall.id);
    return (
      <AgentToolCallBlock
        expanded={expandState.isExpanded(`tool:${item.toolCall.id}`, false)}
        index={index}
        key={item.id}
        onToggle={(anchorElement) => {
          const toolId = `tool:${item.toolCall.id}`;
          expandState.toggle(toolId, expandState.isExpanded(toolId, false), anchorElement);
        }}
        onNodeReferenceOpen={onNodeReferenceOpen}
        onOpenRunTranscript={onOpenRunTranscript}
        pendingToolCallIds={pendingToolCallIds}
        result={results.get(item.toolCall.id)}
        conversationId={conversationId}
        subRun={subRun}
        toolCall={item.toolCall}
        outcome={item.outcome}
        turnActive={isToolCallRowActive(item, pendingToolCallIds, results, subRun, turnActive)}
      />
    );
  };

  return (
    <div className="agent-process-timeline">
      {soloResultlessThinkingItem ? (
        <AgentThinkingBody
          expandState={expandState}
          id={soloResultlessThinkingItem.id}
          index={index}
          keyPrefix={soloResultlessThinkingItem.id}
          onNodeReferenceOpen={onNodeReferenceOpen}
          streaming={soloResultlessThinkingItem.streaming}
          text={soloResultlessThinkingItem.text}
        />
      ) : (
        groups.map((group) => {
          if (group.kind === 'toolActivity') {
            return (
              <AgentToolActivityGroup
                conversationId={conversationId}
                expandState={expandState}
                turnActive={turnActive}
                id={`${id}:${group.id}`}
                index={index}
                key={group.id}
                members={group.members}
                onNodeReferenceOpen={onNodeReferenceOpen}
                onOpenRunTranscript={onOpenRunTranscript}
                pendingToolCallIds={pendingToolCallIds}
                results={results}
                subRunsByParentToolCallId={subRunsByParentToolCallId}
              />
            );
          }
          return renderItem(group.item);
        })
      )}
    </div>
  );
}
