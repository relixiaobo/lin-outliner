import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AgentMessageEntry, AgentTurnPhase } from '../../agent/runtime';
import type {
  AssistantMessage,
  AgentToolResultWithPayloads,
  ImageContent,
  TextContent,
  UserMessage,
} from '../../../core/agentTypes';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
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
  InfoIcon,
  PencilIcon,
  RedoIcon,
  StopIcon,
} from '../icons';
import {
  type AgentExpandState,
} from './AgentProcessBlock';
import { IconButton } from '../primitives/IconButton';
import { parseAgentErrorMessage } from './agentErrorParse';
import { renderAssistantBlocks } from './AgentAssistantTurnContent';
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
import { useI18n, useT } from '../../i18n/I18nProvider';
import {
  inlineFilePreviewAttrs,
  localFileReferenceHref,
} from '../editor/inlineFilePreviewData';
import { ButtonControl } from '../primitives/ButtonControl';
import { disclosureSnapshot, setDisclosureOverride, subscribeDisclosure } from './agentDisclosureStore';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';
import {
  captureDisclosureScrollAnchor,
  nearestScrollContainer,
  usePendingDisclosureAnchor,
} from '../interactions/disclosureScrollAnchor';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';

const USER_MESSAGE_COLLAPSED_LINES = 5;
const USER_MESSAGE_COLLAPSED_EXTRA_PX = 16;
const EMPTY_CHILD_RUN_MAP: ReadonlyMap<string, AgentRenderChildRunEntity> = new Map();
const EMPTY_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({});
const NOOP_UNSUBSCRIBE = () => {};

interface AgentMessageRowProps {
  /** Speaker name for Channel attribution; null/undefined renders no badge (DM, user, coordinator). */
  actorLabel?: string | null;
  /** The speaker's `@` token, shown as the badge tooltip. */
  actorMention?: string;
  busy?: boolean;
  contentKey?: string;
  entry: AgentMessageEntry;
  highlighted?: boolean;
  index: DocumentIndex;
  isLastInTurn?: boolean;
  onEdit?: (nodeId: string, message: string) => void | Promise<void>;
  onCopy?: () => void | Promise<void>;
  onRegenerate?: (nodeId: string) => void | Promise<void>;
  onRetry?: (nodeId: string) => void | Promise<void>;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenChildRunTranscript?: (childRunId: string) => void;
  onOpenRunDetails?: (runId: string) => void;
  onDisclosureToggle?: () => void;
  onSwitchBranch?: (nodeId: string) => void | Promise<void>;
  pendingToolCallIds: ReadonlySet<string>;
  conversationId?: string | null;
  streaming?: boolean;
  childRunsByParentToolCallId?: Map<string, AgentRenderChildRunEntity>;
  toolResults: Map<string, AgentToolResultWithPayloads>;
  /** True in a Channel: turns deliver atomically and fold result-first rather than surfacing resultless process inline. */
  isChannel?: boolean;
  turnPhase?: AgentTurnPhase;
  speakerLabel?: string | null;
  speakerMention?: string | null;
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

function hasAssistantError(message: UserMessage | AssistantMessage): message is AssistantMessage {
  return message.role === 'assistant' && !!message.errorMessage && message.stopReason !== 'aborted';
}

function formatAbsoluteTimestamp(timestamp: number, locale: string): string {
  return new Date(timestamp).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTokenCount(value: number | undefined): string | null {
  if (!Number.isFinite(value) || !value || value <= 0) return null;
  return new Intl.NumberFormat().format(value);
}

function formatTokenValue(value: number | undefined): string {
  return Number.isFinite(value) && value !== undefined ? new Intl.NumberFormat().format(value) : '0';
}

function formatUsageCost(value: number | undefined): string | null {
  if (!Number.isFinite(value) || value === undefined) return null;
  if (value <= 0) return '$0.0000';
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(4)}`;
}

function segmentStyle(value: number, total: number): CSSProperties {
  const share = total > 0 ? value / total : 0;
  return {
    '--segment-size': `${Math.max(share * 100, value > 0 ? 2 : 0)}%`,
  } as CSSProperties;
}

function usageSummary(message: AssistantMessage, labels: {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  total: string;
}): string | null {
  const usage = message.usage;
  const parts = [
    [labels.input, formatTokenCount(usage.input)],
    [labels.output, formatTokenCount(usage.output)],
    [labels.cacheRead, formatTokenCount(usage.cacheRead)],
    [labels.cacheWrite, formatTokenCount(usage.cacheWrite)],
    [labels.total, formatTokenCount(usage.totalTokens)],
  ].flatMap(([label, value]) => (value ? [`${label} ${value}`] : []));
  return parts.length > 0 ? parts.join(' · ') : null;
}

function providerModelSummary(message: AssistantMessage): string | null {
  const provider = message.provider?.trim();
  const model = message.model?.trim();
  if (provider && model) return `${provider}/${model}`;
  return model || provider || null;
}

function AgentMessageUsageHoverCard({
  anchorRef,
  message,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  message: AssistantMessage;
}) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const usage = message.usage;
  const cost = usage.cost;
  const usageRows = [
    { kind: 'input', label: t.agent.message.tokenLabels.input, tokens: usage.input, cost: cost?.input },
    { kind: 'output', label: t.agent.message.tokenLabels.output, tokens: usage.output, cost: cost?.output },
    { kind: 'cache-read', label: t.agent.message.tokenLabels.cacheRead, tokens: usage.cacheRead, cost: cost?.cacheRead },
    { kind: 'cache-write', label: t.agent.message.tokenLabels.cacheWrite, tokens: usage.cacheWrite, cost: cost?.cacheWrite },
  ];
  const breakdownRows = [
    ...usageRows,
    { kind: 'total', label: t.agent.message.tokenLabels.total, tokens: usage.totalTokens, cost: cost?.total },
  ];
  const style = useAnchoredOverlay(cardRef, {
    anchorRef,
    gap: 8,
    layoutKey: `${usage.input}:${usage.output}:${usage.cacheRead}:${usage.cacheWrite}:${usage.totalTokens}:${cost?.total ?? 0}`,
    maxHeight: 280,
    placement: 'top-end',
    width: 248,
  });

  return createPortal(
    <div
      className="agent-message-usage-hover-card"
      ref={cardRef}
      role="tooltip"
      style={style}
    >
      <div className="agent-message-usage-hover-title">{t.agent.message.usageDetails}</div>
      <div className="agent-message-usage-hover-bar" aria-hidden>
        {usageRows.map((row) => (
          <span
            className={`is-${row.kind}`}
            key={row.kind}
            style={segmentStyle(row.tokens, usage.totalTokens)}
          />
        ))}
      </div>
      <div className="agent-message-usage-hover-breakdown" aria-label={t.agent.message.usageDetails}>
        {breakdownRows.map((row) => {
          const rowClassName = [
            row.kind === 'total' ? 'is-total' : null,
            row.tokens === 0 && !row.cost ? 'is-zero' : null,
          ].filter(Boolean).join(' ') || undefined;
          return (
            <div className={rowClassName} key={row.kind}>
              <span>
                <i className={`is-${row.kind}`} />
                {row.label}
              </span>
              <strong>{formatTokenValue(row.tokens)}</strong>
              <strong>{formatUsageCost(row.cost) ?? t.agent.message.usageUnavailable}</strong>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

function AgentMessageDetailsPopover({
  message,
  locale,
  onClose,
  speakerLabel,
  speakerMention,
}: {
  message: UserMessage | AssistantMessage;
  locale: string;
  onClose: () => void;
  speakerLabel: string;
  speakerMention?: string | null;
}) {
  const t = useT();
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const providerModel = message.role === 'assistant' ? providerModelSummary(message) : null;
  const tokens = message.role === 'assistant' ? usageSummary(message, t.agent.message.tokenLabels) : null;
  const cost = message.role === 'assistant' ? formatUsageCost(message.usage.cost?.total) : null;

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && detailsRef.current?.contains(target)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  return (
    <div className="agent-message-details-popover" ref={detailsRef} role="dialog" aria-label={t.agent.message.details}>
      <div className="agent-message-details-speaker">
        <AgentIdentityAvatar label={speakerLabel} mention={speakerMention} />
        <span>{speakerLabel}</span>
        {speakerMention ? <small>{`@${speakerMention}`}</small> : null}
      </div>
      <dl className="agent-message-details-list">
        <div>
          <dt>{t.agent.message.timestamp}</dt>
          <dd>{formatAbsoluteTimestamp(message.timestamp, locale)}</dd>
        </div>
        {providerModel ? (
          <div>
            <dt>{t.agent.message.model}</dt>
            <dd>{providerModel}</dd>
          </div>
        ) : null}
        {tokens ? (
          <div>
            <dt>{t.agent.message.tokens}</dt>
            <dd>{tokens}</dd>
          </div>
        ) : null}
        {cost ? (
          <div>
            <dt>{t.agent.message.cost}</dt>
            <dd>{cost}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

function AgentUserCollapsibleContent({
  children,
  highlighted = false,
  measureKey,
}: {
  children: ReactNode;
  highlighted?: boolean;
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
    <div className={`agent-user-content-shell${highlighted ? ' is-highlighted' : ''}`}>
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

function AgentMessageRowComponent({
  actorLabel = null,
  actorMention,
  busy = false,
  contentKey,
  entry,
  highlighted = false,
  index,
  isLastInTurn = true,
  onCopy,
  onEdit,
  onRegenerate,
  onRetry,
  onNodeReferenceOpen,
  onOpenChildRunTranscript,
  onOpenRunDetails,
  onDisclosureToggle,
  onSwitchBranch,
  pendingToolCallIds,
  conversationId,
  streaming: streamingOverride,
  childRunsByParentToolCallId,
  toolResults,
  isChannel = false,
  turnPhase = 'idle',
  speakerLabel = null,
  speakerMention = null,
}: AgentMessageRowProps) {
  const t = useT();
  const { locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [usageHoverOpen, setUsageHoverOpen] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  // Disclosure (process fold + inner tool/reasoning) expand state. A row in a
  // conversation reads from the persisted per-conversation store so a user's
  // expand/collapse survives reload, conversation switch, and the streaming→sealed
  // remount; a detached preview row (no conversationId) keeps ephemeral local state.
  const [localOverrides, setLocalOverrides] = useState<Record<string, boolean>>({});
  const subscribe = useCallback(
    (onChange: () => void) => (conversationId ? subscribeDisclosure(conversationId, onChange) : NOOP_UNSUBSCRIBE),
    [conversationId],
  );
  const getSnapshot = useCallback(
    () => (conversationId ? disclosureSnapshot(conversationId) : EMPTY_OVERRIDES),
    [conversationId],
  );
  const persistedOverrides = useSyncExternalStore(subscribe, getSnapshot);
  const expandOverrides = conversationId ? persistedOverrides : localOverrides;
  const { capturePendingAnchor, restorePendingAnchor } = usePendingDisclosureAnchor();
  const expandState = useMemo<AgentExpandState>(() => ({
    isExpanded: (id, defaultExpanded = false) => expandOverrides[id] ?? defaultExpanded,
    toggle: (id, currentlyExpanded, anchorElement) => {
      const scroller = nearestScrollContainer(anchorElement ?? null);
      const resolveElement = scroller
        ? () => scroller.querySelector<HTMLElement>(`[data-agent-disclosure-id="${CSS.escape(id)}"]`)
          ?? scroller.querySelector<HTMLElement>(`[data-agent-process-id="${CSS.escape(id)}"]`)
        : undefined;
      capturePendingAnchor(captureDisclosureScrollAnchor(anchorElement ?? null, scroller, resolveElement));
      onDisclosureToggle?.();
      const next = !currentlyExpanded;
      if (conversationId) setDisclosureOverride(conversationId, id, next);
      else setLocalOverrides((current) => ({ ...current, [id]: next }));
    },
  }), [capturePendingAnchor, conversationId, expandOverrides, onDisclosureToggle]);

  useLayoutEffect(() => {
    return restorePendingAnchor();
  }, [expandOverrides, restorePendingAnchor]);

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
  const nodeId = entry.nodeId;
  const resolvedSpeakerLabel = speakerLabel
    ?? (message.role === 'user' ? t.agent.message.you : t.agent.message.roleAssistant);

  async function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const isUserMessage = message.role === 'user';
    const text = isUserMessage ? textFromContent(message.content) : textFromAssistant(message);
    const action = await window.lin?.showAgentMessageContextMenu?.({
      canCopy: Boolean(text.trim()) || (!isUserMessage && Boolean(onCopy)),
      canRetry: Boolean(!isUserMessage && nodeId && hasAssistantError(message) && onRetry && !actionsDisabled),
      canRegenerate: Boolean(!isUserMessage && nodeId && !hasAssistantError(message) && onRegenerate && !actionsDisabled && isLastInTurn),
      canShowDetails: true,
    });
    if (action === 'copy') {
      if (isUserMessage) await copyMessage(text);
      else await copyAssistantMessage(text);
    } else if (action === 'retry' && !isUserMessage && nodeId) {
      await onRetry?.(nodeId);
    } else if (action === 'regenerate' && !isUserMessage && nodeId) {
      await onRegenerate?.(nodeId);
    } else if (action === 'details') {
      setDetailsOpen(true);
    }
  }
  if (message.role === 'user') {
    const userContent = displayContentFromUser(message.content);
    const text = userContent.text;
    const inlineAttachmentRefs = referencedAttachmentRefs(text, userContent.attachments);
    const listedAttachments = userContent.attachments.filter((attachment) => !inlineAttachmentRefs.has(attachment.ref));
    const hasAttachments = userContent.attachments.length > 0 || userContent.images.length > 0;
    const hasVisibleContent = listedAttachments.length > 0 || userContent.images.length > 0 || text.trim().length > 0;
    const contentMeasureKey = `${entry.id}:${message.timestamp}:${text}:${listedAttachments.length}:${userContent.images.length}`;
    const CopyStateIcon = copied ? CheckIcon : CopyIcon;
    if (editing && nodeId) {
      return (
        <AgentMessageFrame messageId={nodeId} role="user">
          <div className={`agent-user-edit-card${highlighted ? ' is-highlighted' : ''}`}>
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
      <AgentMessageFrame messageId={nodeId} role="user" onContextMenu={handleContextMenu}>
        <div className="agent-user-content">
          {hasVisibleContent ? (
            <AgentUserCollapsibleContent highlighted={highlighted} measureKey={contentMeasureKey}>
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
          {detailsOpen ? (
            <AgentMessageDetailsPopover
              locale={locale}
              message={message}
              onClose={() => setDetailsOpen(false)}
              speakerLabel={resolvedSpeakerLabel}
              speakerMention={speakerMention}
            />
          ) : null}
        </div>
      </AgentMessageFrame>
    );
  }

  const hasError = !!message.errorMessage && message.stopReason !== 'aborted';
  const stopped = message.stopReason === 'aborted';
  const displayError = hasError ? parseAgentErrorMessage(message.errorMessage ?? '') : '';
  const copyText = textFromAssistant(message);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;
  const assistantContentKey = contentKey ?? nodeId ?? entry.id;
  const assistantBlocks = renderAssistantBlocks(
    message,
    assistantContentKey,
    index,
    expandState,
    onNodeReferenceOpen,
    onOpenChildRunTranscript,
    pendingToolCallIds,
    conversationId,
    streaming,
    childRunsByParentToolCallId,
    toolResults,
    turnActive,
    entry.turnInterrupted,
    isChannel,
    entry.runDurationMs,
    entry.runStartedAtMs,
    entry.toolCallOutcomes,
  );
  const showToolbar = nodeId !== null && !turnActive && isLastInTurn;
  const openAssistantDetails = () => {
    setUsageHoverOpen(false);
    if (entry.runId && onOpenRunDetails) {
      onOpenRunDetails(entry.runId);
      return;
    }
    setDetailsOpen(true);
  };
  // A sealed assistant turn whose only content was a child run spawn renders no
  // blocks (the run is shown as the boundary that follows) — skip the empty bubble
  // entirely rather than leave a blank frame.
  if (assistantBlocks.length === 0 && !hasError && !turnActive && !stopped) return null;

  return (
    <AgentMessageFrame messageId={nodeId} role="assistant" onContextMenu={handleContextMenu}>
      {actorLabel ? (
        // Channel attribution header: avatar + speaker name on ONE line. The body
        // below spans the full row width (aligned to the avatar's left edge) rather
        // than being indented into an avatar gutter, so a Channel reply reclaims the
        // horizontal space a per-message avatar column would cost. (A DM renders no
        // actorLabel, so it has no header and its content is full-width already.)
        <div
          className="agent-message-actor-header"
          title={actorMention ? `@${actorMention}` : undefined}
        >
          <AgentIdentityAvatar
            label={actorLabel}
            mention={actorMention}
          />
          <div className="agent-message-actor">
            <span>{actorLabel}</span>
            {actorMention ? <small>{`@${actorMention}`}</small> : null}
          </div>
        </div>
      ) : null}
      <AgentAssistantContent highlighted={highlighted}>
        {hasError ? <AgentMessageError message={displayError} /> : null}
        {assistantBlocks}
        {stopped && !turnActive ? (
          <div className="agent-message-stopped">
            <StopIcon size={ICON_SIZE.menu} aria-hidden />
            <span>{t.agent.message.stopped}</span>
          </div>
        ) : null}
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
            <IconButton
              className="agent-message-action-button"
              icon={InfoIcon}
              label={t.agent.message.details}
              onBlur={() => setUsageHoverOpen(false)}
              onClick={openAssistantDetails}
              onFocus={() => setUsageHoverOpen(true)}
              onMouseEnter={() => setUsageHoverOpen(true)}
              onMouseLeave={() => setUsageHoverOpen(false)}
              ref={detailsButtonRef}
              title=""
              variant="message"
            />
            {usageHoverOpen ? (
              <AgentMessageUsageHoverCard anchorRef={detailsButtonRef} message={message} />
            ) : null}
          </AgentMessageActions>
        ) : null}
        {detailsOpen ? (
          <AgentMessageDetailsPopover
            locale={locale}
            message={message}
            onClose={() => setDetailsOpen(false)}
            speakerLabel={resolvedSpeakerLabel}
            speakerMention={speakerMention}
          />
        ) : null}
      </AgentAssistantContent>
    </AgentMessageFrame>
  );
}

function sameReadonlySet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function sameReadonlyMap<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function sameMessageEntry(left: AgentMessageEntry, right: AgentMessageEntry): boolean {
  return left === right || (
    left.id === right.id
    && left.nodeId === right.nodeId
    && left.message === right.message
    && left.branches === right.branches
    && left.streaming === right.streaming
    && left.actor === right.actor
    && left.runId === right.runId
    && left.runDurationMs === right.runDurationMs
    && left.runStartedAtMs === right.runStartedAtMs
    && left.turnInterrupted === right.turnInterrupted
  );
}

function sameAgentMessageRowProps(prev: AgentMessageRowProps, next: AgentMessageRowProps): boolean {
  return prev.actorLabel === next.actorLabel
    && prev.actorMention === next.actorMention
    && prev.busy === next.busy
    && prev.contentKey === next.contentKey
    && sameMessageEntry(prev.entry, next.entry)
    && prev.highlighted === next.highlighted
    && prev.index === next.index
    && prev.isLastInTurn === next.isLastInTurn
    && prev.onCopy === next.onCopy
    && prev.onEdit === next.onEdit
    && prev.onRegenerate === next.onRegenerate
    && prev.onRetry === next.onRetry
    && prev.onNodeReferenceOpen === next.onNodeReferenceOpen
    && prev.onOpenChildRunTranscript === next.onOpenChildRunTranscript
    && prev.onSwitchBranch === next.onSwitchBranch
    && sameReadonlySet(prev.pendingToolCallIds, next.pendingToolCallIds)
    && prev.conversationId === next.conversationId
    && prev.streaming === next.streaming
    && sameReadonlyMap(prev.childRunsByParentToolCallId ?? EMPTY_CHILD_RUN_MAP, next.childRunsByParentToolCallId ?? EMPTY_CHILD_RUN_MAP)
    && sameReadonlyMap(prev.toolResults, next.toolResults)
    && prev.isChannel === next.isChannel
    && prev.turnPhase === next.turnPhase
    && prev.speakerLabel === next.speakerLabel
    && prev.speakerMention === next.speakerMention;
}

export const AgentMessageRow = memo(AgentMessageRowComponent, sameAgentMessageRowProps);
