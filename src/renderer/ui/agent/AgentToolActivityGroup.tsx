import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { DocumentIndex } from '../../state/document';
import { ChevronRightIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { isToolCallRowActive } from './AgentProcessTimeline';
import { AgentToolCallBlock, getToolCallStatus } from './AgentToolCallBlock';
import type { AgentExpandState } from './agentProcessTypes';
import { summarizeToolActivity } from './agentRenderGroups';
import type { AgentTurnToolCallItem } from './agentTurnProjection';

interface AgentToolActivityGroupProps {
  conversationId?: string | null;
  expandState: AgentExpandState;
  turnActive: boolean;
  id: string;
  index: DocumentIndex;
  members: AgentTurnToolCallItem[];
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenChildRunTranscript?: (childRunId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
}

// A run of consecutive tool calls, folded into one counted-summary disclosure
// ("Ran 3 commands · read 2 files"), expandable to the individual tool rows.
// This is Codex's per-tool-activity-group collapse (machine B), nested inside the
// per-turn process fold (machine C).
export function AgentToolActivityGroup({
  conversationId,
  expandState,
  turnActive,
  id,
  index,
  members,
  onNodeReferenceOpen,
  onOpenChildRunTranscript,
  pendingToolCallIds,
  results,
}: AgentToolActivityGroupProps) {
  const t = useT();
  const expanded = expandState.isExpanded(id, false);
  // Group members are non-child-run tools by the timeline's split predicate, so
  // childRun is always undefined here; every un-settled member spins while the turn
  // is live (parallel calls included), matching the standalone-row rule.
  const memberStatuses = members.map((member) => ({
    status: getToolCallStatus(
      member.toolCall.id,
      results.get(member.toolCall.id),
      pendingToolCallIds,
      isToolCallRowActive(member, pendingToolCallIds, results, undefined, turnActive),
      member.outcome,
    ),
    toolCall: member.toolCall,
  }));
  const summary = summarizeToolActivity(memberStatuses, t.agent.process);

  return (
    <div className="agent-tool-activity-group">
      <ButtonControl
        aria-expanded={expanded}
        className="agent-tool-activity-toggle"
        data-agent-disclosure-id={id}
        onClick={(event) => {
          expandState.toggle(id, expanded, event.currentTarget);
        }}
      >
        <span className="agent-tool-activity-summary">{summary}</span>
        <ChevronRightIcon
          aria-hidden
          className={`agent-tool-activity-chevron${expanded ? ' is-expanded' : ''}`}
          size={14}
        />
      </ButtonControl>
      {expanded ? (
        <div className="agent-tool-activity-members">
          {members.map((member) => (
            <AgentToolCallBlock
              expanded={expandState.isExpanded(`tool:${member.toolCall.id}`, false)}
              index={index}
              key={member.id}
              onToggle={(anchorElement) => {
                const toolId = `tool:${member.toolCall.id}`;
                expandState.toggle(toolId, expandState.isExpanded(toolId, false), anchorElement);
              }}
              onNodeReferenceOpen={onNodeReferenceOpen}
              onOpenChildRunTranscript={onOpenChildRunTranscript}
              pendingToolCallIds={pendingToolCallIds}
              result={results.get(member.toolCall.id)}
              conversationId={conversationId}
              toolCall={member.toolCall}
              outcome={member.outcome}
              turnActive={isToolCallRowActive(member, pendingToolCallIds, results, undefined, turnActive)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
