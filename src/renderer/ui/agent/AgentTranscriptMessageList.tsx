import { useMemo } from 'react';
import type {
  AgentMessage,
  AgentToolResultWithPayloads,
  TextContent,
  ToolResultMessage,
} from '../../../core/agentTypes';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import { AgentMessageRow } from './AgentMessageRow';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { PlainReadOnlyCodeBlock } from '../editor/CodeBlockSurface';
import { useT } from '../../i18n/I18nProvider';
import { buildAgentTranscriptRenderRows } from './agentTranscriptRows';

interface AgentTranscriptMessageListProps {
  active?: boolean;
  run?: AgentRenderRunEntity;
  subRunsByParentToolCallId?: Map<string, AgentRenderRunEntity>;
  className?: string;
  conversationId?: string | null;
  filePreviewPresentation?: 'reader';
  index: DocumentIndex;
  isChannel?: boolean;
  messages: readonly AgentMessage[];
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRunTranscript?: (runId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  showFinalMessages?: boolean;
  showProcessStatus?: boolean;
  toolResults: Map<string, AgentToolResultWithPayloads>;
}

function textFromToolResult(message: ToolResultMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function compactText(text: string, maxLength = 1200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized;
}

function OrphanToolResultRow({
  message,
}: {
  message: ToolResultMessage;
}) {
  const text = textFromToolResult(message);
  const copyLabel = useT().agent.toolCall.copyOutput;
  const preview = compactText(text);
  if (!text) return null;
  return (
    <div className="agent-transcript-tool-result-row">
      <PlainReadOnlyCodeBlock code={preview} copyLabel={copyLabel}>
        {preview}
      </PlainReadOnlyCodeBlock>
    </div>
  );
}

export function AgentTranscriptMessageList({
  active = false,
  run,
  subRunsByParentToolCallId,
  className = 'agent-transcript-message-list',
  conversationId,
  filePreviewPresentation,
  index,
  isChannel = false,
  messages,
  onNodeReferenceOpen,
  onOpenRunTranscript,
  pendingToolCallIds,
  showFinalMessages = true,
  showProcessStatus = true,
  toolResults,
}: AgentTranscriptMessageListProps) {
  const renderRows = useMemo(() => buildAgentTranscriptRenderRows({
    active,
    messages,
    pendingToolCallIds,
    run,
  }), [active, messages, pendingToolCallIds, run]);

  return (
    <div className={className}>
      {renderRows.map((row) => {
        if (row.type === 'orphan-tool-result') {
          return <OrphanToolResultRow key={row.key} message={row.message} />;
        }
        return (
          <AgentMessageRow
            contentKey={row.contentKey}
            conversationId={conversationId}
            entry={row.entry}
            filePreviewPresentation={filePreviewPresentation}
            index={index}
            isLastInTurn={false}
            isChannel={isChannel}
            key={row.key}
            onNodeReferenceOpen={onNodeReferenceOpen}
            onOpenRunTranscript={onOpenRunTranscript}
            pendingToolCallIds={pendingToolCallIds}
            showFinalMessages={showFinalMessages}
            showProcessStatus={showProcessStatus}
            streaming={row.streaming}
            subRunsByParentToolCallId={subRunsByParentToolCallId}
            toolResults={toolResults}
            turnPhase={row.turnPhase}
          />
        );
      })}
    </div>
  );
}
