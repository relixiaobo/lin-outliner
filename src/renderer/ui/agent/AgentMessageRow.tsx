import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentMessageEntry, AgentTurnPhase } from '../../agent/runtime';
import type {
  AssistantMessage,
  AgentToolResultWithPayloads,
  ImageContent,
  TextContent,
  UserMessage,
} from '../../../core/agentTypes';
import type { AgentRenderSubagentEntity } from '../../../core/agentRenderProjection';
import { splitFileReferenceMarkers } from '../../../core/referenceMarkup';
import {
  isHiddenAgentContextBlock,
  parseAgentAttachmentMarkerBlock,
  parseAgentTextAttachmentBlock,
} from '../../../core/agentAttachments';
import type { DocumentIndex } from '../../state/document';
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  CopyIcon,
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
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
import {
  AgentInlineReferenceText,
  type AgentInlineFileReference,
  type AgentNodeReferenceOpenHandler,
} from './AgentInlineReferenceText';
import { useT } from '../../i18n/I18nProvider';
import {
  inlineFilePreviewAttrs,
  localFileReferenceHref,
} from '../editor/inlineFilePreviewData';
import { ButtonControl } from '../primitives/ButtonControl';

const USER_MESSAGE_COLLAPSED_LINES = 5;
const USER_MESSAGE_COLLAPSED_EXTRA_PX = 16;

interface AgentMessageRowProps {
  busy?: boolean;
  contentKey?: string;
  entry: AgentMessageEntry;
  index: DocumentIndex;
  isLastInTurn?: boolean;
  onEdit?: (nodeId: string, message: string) => void | Promise<void>;
  onCopy?: () => void | Promise<void>;
  onRegenerate?: (nodeId: string) => void | Promise<void>;
  onRetry?: (nodeId: string) => void | Promise<void>;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenSubagentTranscript?: (subagentId: string) => void;
  onSwitchBranch?: (nodeId: string) => void | Promise<void>;
  pendingToolCallIds: ReadonlySet<string>;
  sessionId?: string | null;
  streaming?: boolean;
  subagentsByParentToolCallId?: Map<string, AgentRenderSubagentEntity>;
  toolResults: Map<string, AgentToolResultWithPayloads>;
  turnEnded?: boolean;
  turnPhase?: AgentTurnPhase;
}

interface UserDisplayContent {
  text: string;
  attachments: UserAttachmentDisplayItem[];
  images: ImageContent[];
}

interface UserAttachmentDisplayItem extends AgentInlineFileReference {
  kind: 'file' | 'image' | 'inline_text';
  name: string;
  mimeType: string;
  sizeBytes: number;
  path?: string;
  truncated?: boolean;
}

function displayContentFromUser(content: UserMessage['content']): UserDisplayContent {
  if (typeof content === 'string') {
    return {
      text: content,
      attachments: [],
      images: [],
    };
  }

  const textBlocks: string[] = [];
  const attachments: UserAttachmentDisplayItem[] = [];
  const images: ImageContent[] = [];
  let pendingImageSummaryBlocks = 0;

  for (const block of content) {
    if (block.type === 'image') {
      images.push(block);
      continue;
    }

    const parsedAttachment = parseAgentTextAttachmentBlock(block.text);
    if (parsedAttachment) {
      attachments.push({
        kind: 'inline_text',
        name: parsedAttachment.name,
        ref: parsedAttachment.ref,
        mimeType: parsedAttachment.mimeType,
        sizeBytes: parsedAttachment.sizeBytes,
        truncated: parsedAttachment.truncated,
      });
    } else if (isHiddenAgentContextBlock(block.text)) {
      const marker = parseAgentAttachmentMarkerBlock(block.text);
      if (marker) {
        for (const item of marker.attachments) {
          if (item.kind === 'file') {
            attachments.push({
              entryKind: item.mimeType === 'inode/directory' ? 'directory' : 'file',
              kind: 'file',
              name: item.name,
              ref: item.ref,
              mimeType: item.mimeType,
              sizeBytes: item.sizeBytes,
              path: item.path,
            });
          } else if (item.kind === 'image') {
            attachments.push({
              entryKind: 'file',
              kind: 'image',
              name: item.name,
              ref: item.ref,
              mimeType: item.mimeType,
              sizeBytes: item.sizeBytes,
            });
            pendingImageSummaryBlocks += 1;
          }
        }
      }
    } else if (pendingImageSummaryBlocks > 0 && block.text.trim() === 'Image attachment') {
      pendingImageSummaryBlocks -= 1;
    } else {
      textBlocks.push(block.text);
    }
  }

  return {
    text: normalizeUserMessageText(textBlocks.join('\n\n')),
    attachments,
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

function normalizeUserMessageText(text: string): string {
  return text
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function iconForUserAttachment(attachment: UserAttachmentDisplayItem) {
  if (attachment.mimeType === 'inode/directory') return <FolderIcon size={ICON_SIZE.menu} />;
  if (attachment.kind === 'image' || attachment.mimeType.startsWith('image/')) return <FileImageIcon size={ICON_SIZE.menu} />;
  return <FileTextIcon size={ICON_SIZE.menu} />;
}

function userAttachmentPreviewAttrs(attachment: UserAttachmentDisplayItem): Record<string, string> {
  return inlineFilePreviewAttrs({
    entryKind: attachment.entryKind ?? (attachment.mimeType === 'inode/directory' ? 'directory' : 'file'),
    mimeType: attachment.mimeType,
    name: attachment.name,
    path: attachment.path,
    ref: attachment.ref,
    sizeBytes: attachment.sizeBytes,
  });
}

function AgentUserFileChip({ attachment }: { attachment: UserAttachmentDisplayItem }) {
  const content = (
    <>
      {iconForUserAttachment(attachment)}
      <span title={attachment.name}>{attachment.name}</span>
      <small>{formatBytes(attachment.sizeBytes)}</small>
    </>
  );
  const attrs = userAttachmentPreviewAttrs(attachment);
  const entryKind = attachment.entryKind ?? (attachment.mimeType === 'inode/directory' ? 'directory' : 'file');
  if (attachment.path) {
    return (
      <a
        {...attrs}
        className="agent-user-file-chip"
        href={localFileReferenceHref(attachment.path, entryKind)}
      >
        {content}
      </a>
    );
  }
  return (
    <div {...attrs} className="agent-user-file-chip">
      {content}
    </div>
  );
}

function referencedAttachmentRefs(
  text: string,
  attachments: readonly UserAttachmentDisplayItem[],
): Set<string> {
  const refs = new Set<string>();
  for (const segment of splitFileReferenceMarkers(text)) {
    if (segment.type === 'file') refs.add(segment.ref);
  }
  for (const attachment of attachments) {
    if (textContainsAttachmentMention(text, attachment.name)) refs.add(attachment.ref);
  }
  return refs;
}

function textContainsAttachmentMention(text: string, name: string): boolean {
  const mention = `@${name}`;
  let offset = text.indexOf(mention);
  while (offset >= 0) {
    const next = text[offset + mention.length];
    if (!next || !/[A-Za-z0-9._-]/u.test(next)) return true;
    offset = text.indexOf(mention, offset + 1);
  }
  return false;
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

function AgentUserCollapsibleContent({
  children,
  measureKey,
}: {
  children: ReactNode;
  measureKey: string;
}) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [measureKey]);

  const measure = useCallback(() => {
    const element = contentRef.current;
    if (!element) return;
    const style = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight) || 26;
    const collapsedHeight = lineHeight * USER_MESSAGE_COLLAPSED_LINES + USER_MESSAGE_COLLAPSED_EXTRA_PX;
    const nextCanCollapse = element.scrollHeight > collapsedHeight + 1;
    setCanCollapse((current) => (current === nextCanCollapse ? current : nextCanCollapse));
  }, []);

  useLayoutEffect(() => {
    measure();
    const element = contentRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, measureKey]);

  const collapsed = canCollapse && !expanded;

  return (
    <div className="agent-user-content-shell">
      <div
        ref={contentRef}
        className={collapsed ? 'agent-user-content-body is-collapsed' : 'agent-user-content-body'}
      >
        {children}
      </div>
      {canCollapse ? (
        <ButtonControl
          aria-expanded={expanded}
          className="agent-user-expand-button"
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{expanded ? t.agent.message.showLess : t.agent.message.showMore}</span>
          <ChevronDownIcon
            aria-hidden
            className={expanded ? 'agent-user-expand-chevron is-expanded' : 'agent-user-expand-chevron'}
            size={ICON_SIZE.tiny}
          />
        </ButtonControl>
      ) : null}
    </div>
  );
}

function renderAssistantBlocks(
  message: AssistantMessage,
  contentKey: string,
  documentIndex: DocumentIndex,
  expandState: AgentExpandState,
  onNodeReferenceOpen: AgentNodeReferenceOpenHandler | undefined,
  onOpenSubagentTranscript: ((subagentId: string) => void) | undefined,
  pendingToolCallIds: ReadonlySet<string>,
  sessionId: string | null | undefined,
  streaming: boolean,
  subagentsByParentToolCallId: Map<string, AgentRenderSubagentEntity> | undefined,
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

  let blockIndex = 0;
  while (blockIndex < visibleBlocks.length) {
    const block = visibleBlocks[blockIndex]!;
    if (block.type === 'thinking' || block.type === 'toolCall') {
      const runStart = blockIndex;
      const segmentBlocks: AgentProcessSegmentBlock[] = [];
      while (blockIndex < visibleBlocks.length) {
        const candidate = visibleBlocks[blockIndex]!;
        if (candidate.type === 'thinking') {
          const hasLaterVisibleBlock = visibleBlocks
            .slice(blockIndex + 1)
            .some((later) => later.type === 'thinking' || later.type === 'toolCall' || later.type === 'text');
          segmentBlocks.push({
            kind: 'thinking',
            sourceIndex: blockIndex,
            streaming: streaming && !hasLaterVisibleBlock,
            text: candidate.thinking,
          });
          blockIndex += 1;
          continue;
        }
        if (candidate.type === 'toolCall') {
          segmentBlocks.push({ kind: 'toolCall', toolCall: candidate });
          blockIndex += 1;
          continue;
        }
        break;
      }

      const thinkingCount = segmentBlocks.filter((candidate) => candidate.kind === 'thinking').length;
      const toolCount = segmentBlocks.length - thinkingCount;
      const segmentSealed = visibleBlocks
        .slice(blockIndex)
        .some((candidate) => candidate.type === 'text' && candidate.text.trim().length > 0);

      if (thinkingCount === 0 && toolCount === 1) {
        const toolCall = (segmentBlocks[0] as Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }>).toolCall;
        const toolId = `tool:${toolCall.id}`;
        rendered.push(
          <AgentToolCallBlock
            expanded={expandState.isExpanded(toolId, false)}
            index={documentIndex}
            key={toolId}
            onToggle={() => expandState.toggle(toolId, expandState.isExpanded(toolId, false))}
            onNodeReferenceOpen={onNodeReferenceOpen}
            onOpenSubagentTranscript={onOpenSubagentTranscript}
            pendingToolCallIds={pendingToolCallIds}
            result={toolResults.get(toolCall.id)}
            sessionId={sessionId}
            subagent={subagentsByParentToolCallId?.get(toolCall.id)}
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
            index={documentIndex}
            key={segmentId}
            onNodeReferenceOpen={onNodeReferenceOpen}
            onOpenSubagentTranscript={onOpenSubagentTranscript}
            pendingToolCallIds={pendingToolCallIds}
            results={toolResults}
            sealed={segmentSealed}
            sessionId={sessionId}
            subagentsByParentToolCallId={subagentsByParentToolCallId}
            turnActive={turnActive}
            turnFailedWithoutProse={turnFailedWithoutProse}
          />,
        );
      }
      continue;
    }

    const hasLaterText = visibleBlocks
      .slice(blockIndex + 1)
      .some((candidate) => candidate.type === 'text' && candidate.text.trim().length > 0);
    rendered.push(
      <AgentMarkdown
        index={documentIndex}
        key={`text-${blockIndex}`}
        keyPrefix={`${contentKey}-text-${blockIndex}`}
        onNodeReferenceOpen={onNodeReferenceOpen}
        streaming={streaming && !hasLaterText}
        text={block.text}
      />,
    );
    blockIndex += 1;
  }

  return rendered;
}

export function AgentMessageRow({
  busy = false,
  contentKey,
  entry,
  index,
  isLastInTurn = true,
  onCopy,
  onEdit,
  onRegenerate,
  onRetry,
  onNodeReferenceOpen,
  onOpenSubagentTranscript,
  onSwitchBranch,
  pendingToolCallIds,
  sessionId,
  streaming: streamingOverride,
  subagentsByParentToolCallId,
  toolResults,
  turnEnded = false,
  turnPhase = 'idle',
}: AgentMessageRowProps) {
  const t = useT();
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
    const inlineAttachmentRefs = referencedAttachmentRefs(text, userContent.attachments);
    const listedAttachments = userContent.attachments.filter((attachment) => !inlineAttachmentRefs.has(attachment.ref));
    const hasAttachments = userContent.attachments.length > 0 || userContent.images.length > 0;
    const hasVisibleContent = listedAttachments.length > 0 || userContent.images.length > 0 || text.trim().length > 0;
    const contentMeasureKey = `${entry.id}:${message.timestamp}:${text}:${listedAttachments.length}:${userContent.images.length}`;
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
                label={t.agent.message.cancelEdit}
                onClick={() => setEditing(false)}
                title={t.agent.message.cancel}
                variant="message"
              />
              <IconButton
                className="agent-message-action-button"
                icon={CheckIcon}
                label={t.agent.message.saveEdit}
                onClick={() => void saveEdit(nodeId)}
                title={t.agent.message.save}
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
          {hasVisibleContent ? (
            <AgentUserCollapsibleContent measureKey={contentMeasureKey}>
              {listedAttachments.length > 0 ? (
                <div className="agent-user-file-list">
                  {listedAttachments.map((attachment, index) => (
                    <AgentUserFileChip attachment={attachment} key={`${attachment.ref}-${index}`} />
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
              {text.trim().length > 0 ? (
                <div className="agent-user-bubble">
                  <AgentInlineReferenceText
                    fileAttachments={userContent.attachments}
                    index={index}
                    onNodeReferenceOpen={onNodeReferenceOpen}
                    text={text}
                  />
                </div>
              ) : null}
            </AgentUserCollapsibleContent>
          ) : null}
          {!turnActive ? (
            <AgentMessageActions>
              {nodeId && onEdit && !hasAttachments && text.trim().length > 0 ? (
                <IconButton
                  className="agent-message-action-button"
                  disabled={actionsDisabled}
                  icon={PencilIcon}
                  label={t.agent.message.editMessage}
                  onClick={() => {
                    setEditDraft(text);
                    setEditing(true);
                  }}
                  title={t.agent.message.edit}
                  variant="message"
                />
              ) : null}
              <IconButton
                className="agent-message-action-button"
                disabled={!text.trim()}
                icon={CopyStateIcon}
                label={t.agent.message.copyMessage}
                onClick={() => void copyMessage(text)}
                title={t.agent.message.copy}
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
    index,
    expandState,
    onNodeReferenceOpen,
    onOpenSubagentTranscript,
    pendingToolCallIds,
    sessionId,
    streaming,
    subagentsByParentToolCallId,
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
                label={hasError ? t.agent.message.retryResponse : t.agent.message.regenerateResponse}
                onClick={() => void (hasError ? onRetry : onRegenerate)?.(nodeId)}
                title={hasError ? t.agent.message.retry : t.agent.message.regenerate}
                variant="message"
              />
            ) : null}
            <IconButton
              className="agent-message-action-button"
              disabled={!copyText && !onCopy}
              icon={CopyStateIcon}
              label={t.agent.message.copyMessage}
              onClick={() => void copyAssistantMessage(copyText)}
              title={t.agent.message.copy}
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
