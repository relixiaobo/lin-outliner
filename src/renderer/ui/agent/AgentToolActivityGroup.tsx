import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import { ChevronRightIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { isToolCallRowActive } from './AgentProcessTimeline';
import { AgentToolCallBlock, runToolStatus, getToolCallStatus } from './AgentToolCallBlock';
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
  subRunsByParentToolCallId?: ReadonlyMap<string, AgentRenderRunEntity>;
}

// A run of consecutive tool calls, folded into one counted-summary disclosure
// ("Ran 3 commands · read 2 files"), expandable to the individual tool rows.
// This is the transcript's interactive activity disclosure; the top-level
// "Working/Worked for" work divider remains non-interactive.
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
  subRunsByParentToolCallId,
}: AgentToolActivityGroupProps) {
  const t = useT();
  const expanded = expandState.isExpanded(id, false);
  const subRunForMember = (member: AgentTurnToolCallItem) =>
    member.subRun ?? subRunsByParentToolCallId?.get(member.toolCall.id);
  const memberStatuses = members.map((member) => {
    const subRun = subRunForMember(member);
    return {
      status: subRun
        ? runToolStatus(subRun)
        : getToolCallStatus(
            member.toolCall.id,
            results.get(member.toolCall.id),
            pendingToolCallIds,
            isToolCallRowActive(member, pendingToolCallIds, results, subRun, turnActive),
            member.outcome,
          ),
      toolCall: member.toolCall,
    };
  });
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
              subRun={subRunForMember(member)}
              toolCall={member.toolCall}
              outcome={member.outcome}
              turnActive={isToolCallRowActive(member, pendingToolCallIds, results, subRunForMember(member), turnActive)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
