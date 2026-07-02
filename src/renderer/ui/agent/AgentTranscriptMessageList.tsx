import { useMemo } from 'react';
import type {
  AgentConversationMessage,
  AgentMessage,
  AgentToolResultWithPayloads,
  AssistantMessage,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from '../../../core/agentTypes';
import { isSystemReminderBlock } from '../../../core/agentAttachments';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import type { AgentMessageEntry, AgentTurnPhase } from '../../agent/runtime';
import { AgentMessageRow } from './AgentMessageRow';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { PlainReadOnlyCodeBlock } from '../editor/CodeBlockSurface';
import { useT } from '../../i18n/I18nProvider';

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
  onOpenChildRunTranscript?: (childRunId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  toolResults: Map<string, AgentToolResultWithPayloads>;
}

function messageKey(message: AgentConversationMessage, index: number): string {
  if (message.role === 'assistant') {
    const firstToolCall = message.content.find((block) => block.type === 'toolCall');
    if (firstToolCall?.type === 'toolCall') return `assistant:${message.timestamp}:${firstToolCall.id}:${index}`;
  }
  return `${message.role}:${message.timestamp}:${index}`;
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

function isHiddenOnlyUserMessage(message: UserMessage): boolean {
  if (typeof message.content === 'string') return isSystemReminderBlock(message.content);
  const textBlocks = message.content.filter((block): block is TextContent => block.type === 'text');
  const hasImages = message.content.some((block) => block.type === 'image');
  return !hasImages && textBlocks.length > 0 && textBlocks.every((block) => isSystemReminderBlock(block.text));
}

function isLastAssistantAt(messages: readonly AgentMessage[], index: number): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'assistant') return i === index;
  }
  return false;
}

function turnPhaseForMessage(
  message: AgentConversationMessage,
  active: boolean,
  pendingToolCallIds: ReadonlySet<string>,
): AgentTurnPhase {
  if (!active || message.role !== 'assistant') return 'idle';
  return pendingToolCallIds.size > 0 ? 'waiting_for_tool' : 'streaming_text';
}

function runDurationMsForMessage(run: AgentRenderRunEntity | undefined, lastAssistant: boolean): number | null {
  if (!run || !lastAssistant || run.completedAt === undefined) return null;
  return Math.max(0, run.completedAt - run.startedAt);
}

// Run start for the live "Working for {t}" ticker — only while it is the
// active last turn AND has not completed, so a sealed/failed run never keeps
// ticking.
function runStartedAtMsForMessage(run: AgentRenderRunEntity | undefined, lastAssistant: boolean): number | null {
  if (!run || !lastAssistant || run.completedAt !== undefined) return null;
  return run.startedAt;
}

function turnInterruptedForMessage(run: AgentRenderRunEntity | undefined, lastAssistant: boolean): boolean {
  return !!run && lastAssistant && (run.status === 'failed' || run.status === 'stopped');
}

function entryFromMessage(
  message: AgentConversationMessage,
  index: number,
  active: boolean,
  pendingToolCallIds: ReadonlySet<string>,
  run: AgentRenderRunEntity | undefined,
  lastAssistant: boolean,
): {
  entry: AgentMessageEntry;
  turnPhase: AgentTurnPhase;
} {
  const id = messageKey(message, index);
  return {
    entry: {
      id,
      kind: 'message',
      nodeId: null,
      message,
      branches: null,
      streaming: active,
      actor: null,
      runId: null,
      runDurationMs: runDurationMsForMessage(run, lastAssistant),
      runStartedAtMs: runStartedAtMsForMessage(run, lastAssistant),
      turnInterrupted: turnInterruptedForMessage(run, lastAssistant),
    },
    turnPhase: turnPhaseForMessage(message, active, pendingToolCallIds),
  };
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
  onOpenChildRunTranscript,
  pendingToolCallIds,
  toolResults,
}: AgentTranscriptMessageListProps) {
  const assistantToolCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const block of message.content) {
        if (block.type === 'toolCall') ids.add(block.id);
      }
    }
    return ids;
  }, [messages]);

  return (
    <div className={className}>
      {messages.map((message, rowIndex) => {
        if (message.role === 'toolResult') {
          if (assistantToolCallIds.has(message.toolCallId)) return null;
          return <OrphanToolResultRow key={`tool-result:${message.toolCallId}:${rowIndex}`} message={message} />;
        }
        const messageActive = active && isLastAssistantAt(messages, rowIndex);
        const lastAssistant = isLastAssistantAt(messages, rowIndex);
        if (message.role === 'user' && isHiddenOnlyUserMessage(message)) return null;
        const { entry, turnPhase } = entryFromMessage(message, rowIndex, messageActive, pendingToolCallIds, run, lastAssistant);
        return (
          <AgentMessageRow
            contentKey={entry.id}
            conversationId={conversationId}
            entry={entry}
            filePreviewPresentation={filePreviewPresentation}
            index={index}
            isLastInTurn={false}
            isChannel={isChannel}
            key={entry.id}
            onNodeReferenceOpen={onNodeReferenceOpen}
            onOpenChildRunTranscript={onOpenChildRunTranscript}
            pendingToolCallIds={pendingToolCallIds}
            streaming={messageActive}
            subRunsByParentToolCallId={subRunsByParentToolCallId}
            toolResults={toolResults}
            turnPhase={turnPhase}
          />
        );
      })}
    </div>
  );
}
