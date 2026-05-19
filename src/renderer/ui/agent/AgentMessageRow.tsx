import { useMemo, useState, type ReactNode } from 'react';
import type { AgentConversationEntry, AgentMessageEntry, AgentTurnPhase } from '../../agent/runtime';
import type {
  AssistantMessage,
  AgentToolResultWithPayloads,
  ImageContent,
  TextContent,
  UserMessage,
} from '../../../core/agentTypes';
import {
  isHiddenAgentContextBlock,
  parseAgentAttachmentMarkerBlock,
  parseAgentTextAttachmentBlock,
  type ParsedAgentTextAttachment,
} from '../../../core/agentAttachments';
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  FileTextIcon,
  ICON_SIZE,
  PencilIcon,
  RedoIcon,
} from '../icons';
import {
  AgentProcessBlock,
  type AgentExpandState,
  type AgentProcessSegmentBlock,
} from './AgentProcessBlock';
import { IconButton } from '../primitives/IconButton';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentToolCallBlock } from './AgentToolCallBlock';
import { looksLikeRawAgentErrorPayload, parseAgentErrorMessage } from './agentErrorParse';
import { AgentBranchNavigator } from './AgentBranchNavigator';
import {
  AgentAssistantContent,
  AgentMessageActions,
  AgentMessageError,
  AgentMessageFrame,
  AgentStreamingIndicator,
} from './AgentMessageFrame';

interface AgentMessageRowProps {
  busy?: boolean;
  contentKey?: string;
  entry: AgentConversationEntry;
  isLastInTurn?: boolean;
  onEdit?: (nodeId: string, message: string) => void | Promise<void>;
  onCopy?: () => void | Promise<void>;
  onRegenerate?: (nodeId: string) => void | Promise<void>;
  onRetry?: (nodeId: string) => void | Promise<void>;
  onSwitchBranch?: (nodeId: string) => void | Promise<void>;
  pendingToolCallIds: ReadonlySet<string>;
  sessionId?: string | null;
  streaming?: boolean;
  toolResults: Map<string, AgentToolResultWithPayloads>;
  turnEnded?: boolean;
  turnPhase?: AgentTurnPhase;
}

interface UserDisplayContent {
  text: string;
  textAttachments: ParsedAgentTextAttachment[];
  images: ImageContent[];
}

function displayContentFromUser(content: UserMessage['content']): UserDisplayContent {
  if (typeof content === 'string') {
    return {
      text: content,
      textAttachments: [],
      images: [],
    };
  }

  const textBlocks: string[] = [];
  const textAttachments: ParsedAgentTextAttachment[] = [];
  const images: ImageContent[] = [];

  for (const block of content) {
    if (block.type === 'image') {
      images.push(block);
      continue;
    }

    const parsedAttachment = parseAgentTextAttachmentBlock(block.text);
    if (parsedAttachment) {
      textAttachments.push(parsedAttachment);
    } else if (isHiddenAgentContextBlock(block.text)) {
      const marker = parseAgentAttachmentMarkerBlock(block.text);
      if (marker) {
        for (const item of marker.attachments) {
          if (item.kind === 'file') {
            textAttachments.push({
              name: item.name,
              mimeType: item.mimeType,
              sizeBytes: item.sizeBytes,
              truncated: false,
              text: '',
              path: item.path,
            });
          }
        }
      }
    } else {
      textBlocks.push(block.text);
    }
  }

  return {
    text: textBlocks.join('\n\n'),
    textAttachments,
    images,
  };
}

function textFromContent(content: UserMessage['content']): string {
  return displayContentFromUser(content).text;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function textFromAssistant(message: AssistantMessage): string {
  const isError = !!message.errorMessage && message.stopReason !== 'aborted';
  if (isError) return parseAgentErrorMessage(message.errorMessage ?? '');
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function renderAssistantBlocks(
  message: AssistantMessage,
  contentKey: string,
  expandState: AgentExpandState,
  pendingToolCallIds: ReadonlySet<string>,
  sessionId: string | null | undefined,
  streaming: boolean,
  toolResults: Map<string, AgentToolResultWithPayloads>,
  turnActive: boolean,
  turnEnded: boolean,
) {
  const rendered: ReactNode[] = [];
  const isError = !!message.errorMessage && message.stopReason !== 'aborted';
  const visibleBlocks = message.content.filter((block) => {
    if (block.type === 'thinking') {
      return !block.redacted && (block.thinking.trim().length > 0 || streaming);
    }
    if (block.type === 'text') {
      if (isError && looksLikeRawAgentErrorPayload(block.text)) return false;
      return block.text.trim().length > 0 || streaming;
    }
    return true;
  });
  const turnHasProse = visibleBlocks.some((block) => block.type === 'text' && block.text.trim().length > 0);
  const turnFailedWithoutProse = turnEnded && !turnHasProse;

  let index = 0;
  while (index < visibleBlocks.length) {
    const block = visibleBlocks[index]!;
    if (block.type === 'thinking' || block.type === 'toolCall') {
      const runStart = index;
      const segmentBlocks: AgentProcessSegmentBlock[] = [];
      while (index < visibleBlocks.length) {
        const candidate = visibleBlocks[index]!;
        if (candidate.type === 'thinking') {
          const hasLaterVisibleBlock = visibleBlocks
            .slice(index + 1)
            .some((later) => later.type === 'thinking' || later.type === 'toolCall' || later.type === 'text');
          segmentBlocks.push({
            kind: 'thinking',
            sourceIndex: index,
            streaming: streaming && !hasLaterVisibleBlock,
            text: candidate.thinking,
          });
          index += 1;
          continue;
        }
        if (candidate.type === 'toolCall') {
          segmentBlocks.push({ kind: 'toolCall', toolCall: candidate });
          index += 1;
          continue;
        }
        break;
      }

      const thinkingCount = segmentBlocks.filter((candidate) => candidate.kind === 'thinking').length;
      const toolCount = segmentBlocks.length - thinkingCount;
      const segmentSealed = visibleBlocks
        .slice(index)
        .some((candidate) => candidate.type === 'text' && candidate.text.trim().length > 0);

      if (thinkingCount === 0 && toolCount === 1) {
        const toolCall = (segmentBlocks[0] as Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }>).toolCall;
        const toolId = `tool:${toolCall.id}`;
        rendered.push(
          <AgentToolCallBlock
            expanded={expandState.isExpanded(toolId, false)}
            key={toolId}
            onToggle={() => expandState.toggle(toolId, expandState.isExpanded(toolId, false))}
            pendingToolCallIds={pendingToolCallIds}
            result={toolResults.get(toolCall.id)}
            sessionId={sessionId}
            toolCall={toolCall}
            turnActive={turnActive}
          />,
        );
      } else if (segmentBlocks.length > 0) {
        const segmentId = `process:${contentKey}:${runStart}`;
        rendered.push(
          <AgentProcessBlock
            blocks={segmentBlocks}
            expandState={expandState}
            id={segmentId}
            key={segmentId}
            pendingToolCallIds={pendingToolCallIds}
            results={toolResults}
            sealed={segmentSealed}
            sessionId={sessionId}
            turnActive={turnActive}
            turnFailedWithoutProse={turnFailedWithoutProse}
          />,
        );
      }
      continue;
    }

    const hasLaterText = visibleBlocks
      .slice(index + 1)
      .some((candidate) => candidate.type === 'text' && candidate.text.trim().length > 0);
    rendered.push(
      <AgentMarkdown
        key={`text-${index}`}
        keyPrefix={`${contentKey}-text-${index}`}
        streaming={streaming && !hasLaterText}
        text={block.text}
      />,
    );
    index += 1;
  }

  return rendered;
}

export function AgentMessageRow({
  busy = false,
  contentKey,
  entry,
  isLastInTurn = true,
  onCopy,
  onEdit,
  onRegenerate,
  onRetry,
  onSwitchBranch,
  pendingToolCallIds,
  sessionId,
  streaming: streamingOverride,
  toolResults,
  turnEnded = false,
  turnPhase = 'idle',
}: AgentMessageRowProps) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});
  const expandState = useMemo<AgentExpandState>(() => ({
    isExpanded: (id, defaultExpanded = false) => expandOverrides[id] ?? defaultExpanded,
    toggle: (id, currentlyExpanded) => {
      setExpandOverrides((current) => ({
        ...current,
        [id]: !currentlyExpanded,
      }));
    },
  }), [expandOverrides]);

  async function copyMessage(text: string) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function copyAssistantMessage(text: string) {
    if (onCopy) {
      await onCopy();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
      return;
    }
    await copyMessage(text);
  }

  async function saveEdit(nodeId: string) {
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    await onEdit?.(nodeId, trimmed);
    setEditing(false);
  }

  const { message } = entry;
  const streaming = streamingOverride ?? entry.streaming;
  const turnActive = turnPhase !== 'idle';
  const actionsDisabled = busy || turnActive;
  if (message.role === 'user') {
    const userContent = displayContentFromUser(message.content);
    const text = userContent.text;
    const hasAttachments = userContent.textAttachments.length > 0 || userContent.images.length > 0;
    const CopyStateIcon = copied ? CheckIcon : CopyIcon;
    const nodeId = entry.nodeId;
    if (editing && nodeId) {
      return (
        <AgentMessageFrame role="user">
          <div className="agent-user-edit-card">
            <textarea
              autoFocus
              className="agent-user-edit-input"
              onChange={(event) => setEditDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setEditing(false);
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  void saveEdit(nodeId);
                }
              }}
              value={editDraft}
            />
            <div className="agent-user-edit-actions">
              <IconButton
                className="agent-message-action-button"
                icon={CloseIcon}
                label="Cancel edit"
                onClick={() => setEditing(false)}
                title="Cancel"
                variant="message"
              />
              <IconButton
                className="agent-message-action-button"
                icon={CheckIcon}
                label="Save edit"
                onClick={() => void saveEdit(nodeId)}
                title="Save"
                variant="message"
              />
            </div>
          </div>
        </AgentMessageFrame>
      );
    }
    return (
      <AgentMessageFrame role="user">
        <div className="agent-user-content">
          {userContent.textAttachments.length > 0 ? (
            <div className="agent-user-file-list">
              {userContent.textAttachments.map((attachment, index) => (
                <div className="agent-user-file-chip" key={`${attachment.name}-${index}`}>
                  <FileTextIcon size={ICON_SIZE.menu} />
                  <span title={attachment.name}>{attachment.name}</span>
                  <small>{formatBytes(attachment.sizeBytes)}</small>
                </div>
              ))}
            </div>
          ) : null}
          {userContent.images.length > 0 ? (
            <div className="agent-user-image-list">
              {userContent.images.map((image, index) => (
                <img
                  alt=""
                  key={`${image.mimeType}-${index}`}
                  src={`data:${image.mimeType};base64,${image.data}`}
                />
              ))}
            </div>
          ) : null}
          {text.trim().length > 0 ? <div className="agent-user-bubble">{text}</div> : null}
          {!turnActive ? (
            <AgentMessageActions>
              {nodeId && onEdit && !hasAttachments && text.trim().length > 0 ? (
                <IconButton
                  className="agent-message-action-button"
                  disabled={actionsDisabled}
                  icon={PencilIcon}
                  label="Edit message"
                  onClick={() => {
                    setEditDraft(text);
                    setEditing(true);
                  }}
                  title="Edit"
                  variant="message"
                />
              ) : null}
              <IconButton
                className="agent-message-action-button"
                disabled={!text.trim()}
                icon={CopyStateIcon}
                label="Copy message"
                onClick={() => void copyMessage(text)}
                title="Copy"
                variant="message"
              />
              <AgentBranchNavigator
                branches={entry.branches}
                disabled={actionsDisabled}
                onSwitchBranch={onSwitchBranch}
              />
            </AgentMessageActions>
          ) : null}
        </div>
      </AgentMessageFrame>
    );
  }

  const hasError = !!message.errorMessage && message.stopReason !== 'aborted';
  const displayError = hasError ? parseAgentErrorMessage(message.errorMessage ?? '') : '';
  const copyText = textFromAssistant(message);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;
  const nodeId = entry.nodeId;
  const assistantContentKey = contentKey ?? nodeId ?? entry.id;
  const assistantBlocks = renderAssistantBlocks(
    message,
    assistantContentKey,
    expandState,
    pendingToolCallIds,
    sessionId,
    streaming,
    toolResults,
    turnActive,
    turnEnded,
  );
  const showToolbar = nodeId !== null && !turnActive && isLastInTurn;

  return (
    <AgentMessageFrame role="assistant">
      <AgentAssistantContent>
        {hasError ? <AgentMessageError message={displayError} /> : null}
        {assistantBlocks}
        {turnActive ? <AgentStreamingIndicator /> : null}
        {showToolbar ? (
          <AgentMessageActions assistant>
            {nodeId && (hasError ? onRetry : onRegenerate) ? (
              <IconButton
                className="agent-message-action-button"
                disabled={actionsDisabled}
                icon={RedoIcon}
                label={hasError ? 'Retry response' : 'Regenerate response'}
                onClick={() => void (hasError ? onRetry : onRegenerate)?.(nodeId)}
                title={hasError ? 'Retry' : 'Regenerate'}
                variant="message"
              />
            ) : null}
            <IconButton
              className="agent-message-action-button"
              disabled={!copyText && !onCopy}
              icon={CopyStateIcon}
              label="Copy message"
              onClick={() => void copyAssistantMessage(copyText)}
              title="Copy"
              variant="message"
            />
            <AgentBranchNavigator
              branches={entry.branches}
              disabled={actionsDisabled}
              onSwitchBranch={onSwitchBranch}
            />
          </AgentMessageActions>
        ) : null}
      </AgentAssistantContent>
    </AgentMessageFrame>
  );
}
