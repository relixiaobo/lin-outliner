import type { AgentConversationEntry, AgentMessageEntry } from '../../agent/runtime';
import type { AssistantMessage, TextContent, ToolResultMessage, UserMessage } from '../../agent/types';
import { WarningIcon } from '../icons';
import { AgentToolCallBlock } from './AgentToolCallBlock';

interface AgentMessageRowProps {
  entry: AgentConversationEntry;
  toolResults: Map<string, ToolResultMessage>;
}

function textFromContent(content: UserMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
}

function renderAssistantBlocks(
  message: AssistantMessage,
  streaming: boolean,
  toolResults: Map<string, ToolResultMessage>,
) {
  const rendered = message.content.flatMap((block, index) => {
    if (block.type === 'thinking') {
      if (!block.thinking.trim() && !streaming) return [];
      return (
        <details className="agent-thinking-block" key={`thinking-${index}`}>
          <summary>Thought</summary>
          <pre>{block.thinking}</pre>
        </details>
      );
    }

    if (block.type === 'toolCall') {
      return (
        <AgentToolCallBlock
          key={`${block.id}-${index}`}
          toolCall={block}
          result={toolResults.get(block.id)}
        />
      );
    }

    if (!block.text && !streaming) return [];
    return (
      <div className="agent-assistant-text" key={`text-${index}`}>
        {block.text}
        {streaming ? <span className="agent-stream-caret" aria-hidden="true" /> : null}
      </div>
    );
  });

  if (rendered.length > 0) return rendered;
  if (streaming) return <span className="agent-streaming-capsule" aria-label="Assistant is responding" />;
  return null;
}

function isMessageEntry(entry: AgentConversationEntry): entry is AgentMessageEntry {
  return entry.kind === 'message';
}

export function AgentMessageRow({ entry, toolResults }: AgentMessageRowProps) {
  if (!isMessageEntry(entry)) {
    return (
      <div className="agent-message-row assistant">
        <span className="agent-streaming-capsule" aria-label="Assistant is responding" />
      </div>
    );
  }

  const { message, streaming } = entry;
  if (message.role === 'user') {
    return (
      <div className="agent-message-row user">
        <div className="agent-user-bubble">{textFromContent(message.content)}</div>
      </div>
    );
  }

  const hasError = !!message.errorMessage && message.stopReason !== 'aborted';

  return (
    <div className="agent-message-row assistant">
      <div className="agent-assistant-content">
        {hasError ? (
          <div className="agent-message-error">
            <WarningIcon size={14} />
            <span>{message.errorMessage}</span>
          </div>
        ) : null}
        {renderAssistantBlocks(message, streaming, toolResults)}
      </div>
    </div>
  );
}
