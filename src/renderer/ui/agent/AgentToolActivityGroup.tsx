import type { AgentToolResultWithPayloads } from '../../../core/agentTypes';
import type { DocumentIndex } from '../../state/document';
import { ChevronDownIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentTextShimmer } from './AgentTextShimmer';
import { AgentToolCallBlock, getToolCallStatus } from './AgentToolCallBlock';
import type { AgentExpandState, AgentProcessSegmentBlock } from './agentProcessTypes';
import { summarizeToolActivity } from './agentProcessSummary';

type ToolCallBlock = Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }>;

interface AgentToolActivityGroupProps {
  conversationId?: string | null;
  expandState: AgentExpandState;
  fallbackActiveToolCallId: string | null;
  id: string;
  index: DocumentIndex;
  members: ToolCallBlock[];
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenChildRunTranscript?: (childRunId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  results: Map<string, AgentToolResultWithPayloads>;
}

export function AgentToolActivityGroup({
  conversationId,
  expandState,
  fallbackActiveToolCallId,
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
  const memberStatuses = members.map((member) => ({
    status: getToolCallStatus(
      member.toolCall.id,
      results.get(member.toolCall.id),
      pendingToolCallIds,
      fallbackActiveToolCallId === member.toolCall.id,
      member.outcome,
    ),
    toolCall: member.toolCall,
  }));
  const active = memberStatuses.some((member) => member.status === 'pending');
  const summary = summarizeToolActivity(memberStatuses, t.agent.process);

  return (
    <div className="agent-tool-activity-group">
      <ButtonControl
        aria-expanded={expanded}
        className="agent-tool-activity-toggle"
        onClick={(event) => {
          expandState.toggle(id, expanded, event.currentTarget);
        }}
      >
        <span className="agent-tool-activity-summary">
          <AgentTextShimmer active={active}>{summary}</AgentTextShimmer>
        </span>
        <ChevronDownIcon
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
              key={`tool-${member.toolCall.id}`}
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
              turnActive={pendingToolCallIds.has(member.toolCall.id) || fallbackActiveToolCallId === member.toolCall.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
