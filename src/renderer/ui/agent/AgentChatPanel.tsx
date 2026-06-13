import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentMessageAttachmentInput,
  AgentToolResultWithPayloads,
  AgentUserViewContext,
  AssistantMessage,
} from '../../../core/agentTypes';
import { nodeReferenceMarkersToText } from '../../../core/referenceMarkup';
import { agentMentionToken } from '../../../core/agentChannel';
import type {
  AgentPovInspectorView,
  AgentRenderActivityEntry,
  AgentRenderMemberView,
} from '../../../core/agentRenderProjection';
import type {
  AgentDefinitionView,
  AgentApprovalResolutionScope,
  AgentProviderSettingsView,
  AgentConversationListMeta,
  AgentSlashCommandView,
  NodeId,
} from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { linAgentRuntimeStore, useLinAgentRuntime } from '../../agent/runtime';
import { onAgentRevealRequest } from '../../agent/agentReveal';
import type {
  AgentConversationEntry,
  AgentMessageEntry,
  AgentTurnPhase,
} from '../../agent/runtime';
import {
  AddIcon,
  ChevronDownIcon,
  CloseIcon,
  DebugIcon,
  HashIcon,
  ICON_SIZE,
  LoaderIcon,
  MoreIcon,
  StopIcon,
  UsedToolsIcon,
  WarningIcon,
} from '../icons';
import { AgentCompactionBoundary } from './AgentCompactionBoundary';
import { AgentDreamBoundary } from './AgentDreamBoundary';
import { AgentChildRunBoundary } from './AgentChildRunBoundary';
import { AgentComposer } from './AgentComposer';
import type { AgentComposerNodeReference } from './AgentComposerEditor';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentMessageRow } from './AgentMessageRow';
import type { AgentReplyAnchor } from './AgentMessageRow';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentChildRunDetailsPanel } from './AgentChildRunDetailsPanel';
import { AgentTaskPanel } from './AgentTaskPanel';
import { AgentIdentityAvatar } from './AgentIdentityAvatar';
import { resolveUsableActiveProvider } from './providerCatalog';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { EmptyState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useI18n, useT } from '../../i18n/I18nProvider';

const TRANSCRIPT_ROW_GAP_PX = 14;
const TRANSCRIPT_ROW_ESTIMATE_PX = 104;
const TRANSCRIPT_VIRTUAL_MIN_ROWS = 40;
const TRANSCRIPT_VIRTUAL_OVERSCAN_PX = 720;
const MESSAGE_TIME_SEPARATOR_GAP_MS = 60 * 60 * 1000;

interface AgentChatPanelProps {
  index: DocumentIndex;
  /** Whether the agent dock is open (not the CSS-collapsed seed). */
  dockOpen: boolean;
  userViewContext: AgentUserViewContext;
  onOpenNodeReference: AgentNodeReferenceOpenHandler;
  onOpenDebugPanel?: (conversationId: string | null) => void;
}

function shouldStickToBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 56;
}

function composerCurrentNodeId(context: AgentUserViewContext, index: DocumentIndex): NodeId | null {
  return context.focusedNode?.nodeId
    ?? context.nodePanels.find((panel) => panel.active)?.rootNodeId
    ?? context.nodePanels[0]?.rootNodeId
    ?? index.projection.todayId
    ?? null;
}

function withReferencedNodes(
  context: AgentUserViewContext,
  refs: readonly AgentComposerNodeReference[],
  index: DocumentIndex,
  untitled: string,
): AgentUserViewContext {
  if (refs.length === 0) return context;
  const seen = new Set<NodeId>();
  const referencedNodes = refs.flatMap((ref) => {
    if (seen.has(ref.nodeId) || !index.byId.has(ref.nodeId)) return [];
    seen.add(ref.nodeId);
    return [{
      nodeId: ref.nodeId,
      title: ref.title.trim() || untitled,
    }];
  });
  return referencedNodes.length > 0 ? { ...context, referencedNodes } : context;
}

// The agent runtime stores this English placeholder as a conversation's title until it
// auto-derives a real one (src/main/agentRuntime.ts). It is a sentinel, not display
// copy — treat it as "unnamed" so the localized fallback shows instead of leaking
// raw English into the header / conversation list.
const RUNTIME_UNTITLED_SENTINEL = 'Untitled';

function readableConversationTitle(title: string | null | undefined, fallback: string): string {
  const readable = nodeReferenceMarkersToText(title ?? '').replace(/\s+/g, ' ').trim();
  if (!readable || readable === RUNTIME_UNTITLED_SENTINEL) return fallback;
  return readable;
}

function formatMessageTimeSeparator(timestamp: number, locale: string, today: (input: { time: string }) => string): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return today({ time });
  return `${date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`;
}

interface ConversationRowMenuAction {
  disabled?: boolean;
  id?: string;
  label: string;
  onSelect: () => void;
}

function ConversationRowMoreMenu({
  actions,
  disabled,
  label,
  menuLabel,
  onOpenChange,
  open,
}: {
  actions: ConversationRowMenuAction[];
  disabled?: boolean;
  label: string;
  menuLabel: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="icon-button icon-button-message agent-message-action-button agent-conversation-more-button"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onOpenChange(!open);
        }}
        ref={anchorRef}
        title={label}
        type="button"
      >
        <MoreIcon size={ICON_SIZE.menu} />
      </button>
      {open ? (
        <FloatingConversationRowMenu
          actions={actions}
          anchorRef={anchorRef}
          menuLabel={menuLabel}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </>
  );
}

function FloatingConversationRowMenu({
  actions,
  anchorRef,
  menuLabel,
  onClose,
}: {
  actions: ConversationRowMenuAction[];
  anchorRef: RefObject<HTMLElement | null>;
  menuLabel: string;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    layoutKey: actions.map((action) => action.label).join('|'),
    maxHeight: 320,
    placement: 'bottom-end',
    width: 196,
  });

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <MenuSurface
      aria-label={menuLabel}
      className="agent-conversation-row-menu"
      data-agent-conversation-row-menu="true"
      ref={menuRef}
      role="menu"
      style={style}
    >
      {actions.map((action) => (
        <MenuItem
          className="agent-conversation-row-menu-item"
          disabled={action.disabled}
          key={action.id ?? action.label}
          label={action.label}
          labelClassName="agent-conversation-row-menu-item-label"
          onClick={() => {
            onClose();
            action.onSelect();
          }}
          role="menuitem"
        />
      ))}
    </MenuSurface>,
    document.body,
  );
}

function agentDefinitionName(definition: AgentDefinitionView | undefined): string | null {
  if (!definition) return null;
  return definition.displayName?.trim() || definition.name.trim() || null;
}

function conversationAgentDisplayName(
  agentId: string,
  agentDefinitionById: Map<string, AgentDefinitionView>,
  fallback?: string | null,
): string {
  return agentDefinitionName(agentDefinitionById.get(agentId)) ?? fallback ?? `@${agentMentionToken(agentId)}`;
}

function isCanonicalDmConversation(
  conversationId: string | null,
  conversation: AgentConversationListMeta | null,
): boolean {
  return Boolean(conversation?.canonicalDmAgentId) || (conversationId?.startsWith('lin-agent-dm-') ?? false);
}

function isRuntimeChannelConversationId(conversationId: string | null): boolean {
  return conversationId?.startsWith('lin-agent-channel-')
    || conversationId?.startsWith('mock-agent-channel')
    || false;
}

function isChannelConversation(
  conversationId: string | null,
  conversation: AgentConversationListMeta | null,
  agentMemberCount: number,
): boolean {
  if (isCanonicalDmConversation(conversationId, conversation)) return false;
  if (isRuntimeChannelConversationId(conversationId)) return true;
  if (conversation && !conversation.canonicalDmAgentId && conversation.goal) return true;
  // Older e2e fixtures predate channel ids/list metadata but still model
  // Channel speaker identity through a multi-agent roster.
  return agentMemberCount >= 2;
}

function systemLineText(entry: AgentMessageEntry): string | null {
  if (entry.actor?.type !== 'system') return null;
  const text = textFromConversationEntry(entry).trim();
  return text || null;
}

type AssistantEntry = AgentMessageEntry & { message: AssistantMessage };

interface AgentConversationRenderRow {
  key: string;
  contentKey?: string;
  entry: AgentConversationEntry;
  endIndex: number;
  isLastInTurn: boolean;
  streaming: boolean;
  turnEnded: boolean;
  turnPhase: AgentTurnPhase;
}

interface VirtualTranscriptItem {
  top: number;
  height: number;
}

interface VirtualTranscriptLayout {
  items: VirtualTranscriptItem[];
  totalHeight: number;
}

function isBoundaryEntry(entry: AgentConversationEntry): boolean {
  return entry.kind === 'compaction' || entry.kind === 'dream' || entry.kind === 'child-run';
}

function getEntryRole(entry: AgentConversationEntry): 'user' | 'assistant' | 'system' {
  return isBoundaryEntry(entry) ? 'system' : (entry as AgentMessageEntry).message.role;
}

function getEntryTimestamp(entry: AgentConversationEntry): number {
  if (entry.kind === 'dream') return entry.status === 'active' ? entry.dream.startedAt : entry.dream.createdAt;
  if (entry.kind === 'child-run') return entry.childRun.startedAt;
  if (entry.kind !== 'compaction') return entry.message.timestamp;
  return entry.status === 'active' ? entry.compaction.startedAt : entry.compaction.createdAt;
}

function textFromConversationEntry(entry: AgentMessageEntry): string {
  const { content } = entry.message;
  if (typeof content === 'string') return content;
  return content
    .flatMap((block) => {
      const part = block as {
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        alt?: string;
        label?: string;
        payload?: { summary?: string };
      };
      if (part.type === 'text') return [part.text ?? ''];
      if (part.type === 'thinking') return [part.thinking ?? ''];
      if (part.type === 'toolCall') return [`[tool:${part.name ?? 'unknown'}]`];
      if (part.type === 'image') return [part.alt ?? ''];
      if (part.type === 'payload_ref') return [part.label || part.payload?.summary || ''];
      return [];
    })
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncateReplyAnchorQuote(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 69).trimEnd()}...`;
}

function buildReplyAnchorMap(rows: readonly AgentConversationRenderRow[]): Map<string, AgentReplyAnchor> {
  const messageById = new Map<string, AgentMessageEntry>();
  for (const row of rows) {
    if (row.entry.kind === 'message' && row.entry.nodeId) messageById.set(row.entry.nodeId, row.entry);
  }

  const anchors = new Map<string, AgentReplyAnchor>();
  let nearestUserMessageId: string | null = null;
  for (const row of rows) {
    if (row.entry.kind !== 'message') continue;
    const messageId = row.entry.nodeId;
    if (!messageId) continue;
    if (row.entry.message.role === 'user') {
      nearestUserMessageId = messageId;
      continue;
    }
    if (row.entry.message.role !== 'assistant') continue;
    const addressedByMessageId = row.entry.addressedByMessageId;
    if (!addressedByMessageId || addressedByMessageId === nearestUserMessageId) continue;
    const source = messageById.get(addressedByMessageId);
    if (!source) continue;
    const quote = truncateReplyAnchorQuote(textFromConversationEntry(source));
    if (!quote) continue;
    anchors.set(messageId, { targetMessageId: addressedByMessageId, quote });
  }
  return anchors;
}

function isAssistantEntry(entry: AgentConversationEntry): entry is AssistantEntry {
  return entry.kind === 'message' && entry.message.role === 'assistant';
}

function isTurnBoundaryEntry(entry: AgentConversationEntry): boolean {
  return isBoundaryEntry(entry) || (entry as AgentMessageEntry).message.role === 'user';
}

// Channel relay puts back-to-back assistant turns from DIFFERENT agents in the
// transcript; merging across that seam would attribute one agent's words to
// another. The streaming placeholder (actor null) merges with anything.
function sameAssistantActor(left: AssistantEntry, right: AssistantEntry): boolean {
  const leftAgentId = left.actor?.type === 'agent' ? left.actor.agentId : null;
  const rightAgentId = right.actor?.type === 'agent' ? right.actor.agentId : null;
  if (leftAgentId === null || rightAgentId === null) return true;
  if (leftAgentId !== rightAgentId) return false;
  return (left.addressedByMessageId ?? null) === (right.addressedByMessageId ?? null);
}

function mergeAssistantEntries(entries: AssistantEntry[]): AgentMessageEntry {
  const lastEntry = entries[entries.length - 1]!;
  return {
    ...lastEntry,
    message: {
      ...lastEntry.message,
      content: entries.flatMap((entry) => entry.message.content),
    },
  };
}

function buildConversationRenderRows(
  entries: AgentConversationEntry[],
  turnPhase: AgentTurnPhase,
): AgentConversationRenderRow[] {
  const rows: AgentConversationRenderRow[] = [];
  const turnEndedByEndIndex = new Map<number, boolean>();
  let hasUserAfter = false;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    turnEndedByEndIndex.set(index, hasUserAfter || turnPhase === 'idle');
    if (entries[index] && isTurnBoundaryEntry(entries[index]!)) hasUserAfter = true;
  }

  let index = 0;
  while (index < entries.length) {
    const entry = entries[index]!;

    if (isAssistantEntry(entry)) {
      const assistantEntries: AssistantEntry[] = [];
      while (index < entries.length) {
        const candidate = entries[index]!;
        if (!isAssistantEntry(candidate)) break;
        if (assistantEntries.length > 0 && !sameAssistantActor(assistantEntries[0]!, candidate)) break;
        assistantEntries.push(candidate);
        index += 1;
      }

      const stableKey = `assistant-turn-${assistantEntries[0]!.id}`;
      const mergedEntry = assistantEntries.length >= 2
        ? mergeAssistantEntries(assistantEntries)
        : assistantEntries[0]!;
      const endIndex = index - 1;
      rows.push(buildConversationRenderRow({
        contentKey: stableKey,
        entry: mergedEntry,
        endIndex,
        key: stableKey,
        turnEnded: turnEndedByEndIndex.get(endIndex) ?? true,
        turnPhase,
        totalEntryCount: entries.length,
        nextEntry: entries[endIndex + 1],
      }));
      continue;
    }

    rows.push(buildConversationRenderRow({
      entry,
      endIndex: index,
      key: isBoundaryEntry(entry)
        ? entry.id
        : (entry as AgentMessageEntry).nodeId ?? `${entry.kind}-${getEntryTimestamp(entry)}-${index}`,
      turnEnded: turnEndedByEndIndex.get(index) ?? true,
      turnPhase,
      totalEntryCount: entries.length,
      nextEntry: entries[index + 1],
    }));
    index += 1;
  }

  return rows;
}

function buildConversationRenderRow({
  contentKey,
  entry,
  endIndex,
  key,
  nextEntry,
  totalEntryCount,
  turnEnded,
  turnPhase,
}: {
  contentKey?: string;
  entry: AgentConversationEntry;
  endIndex: number;
  key: string;
  nextEntry: AgentConversationEntry | undefined;
  totalEntryCount: number;
  turnEnded: boolean;
  turnPhase: AgentTurnPhase;
}): AgentConversationRenderRow {
  const isLastAssistantEntry = endIndex === totalEntryCount - 1 && getEntryRole(entry) === 'assistant';
  return {
    key,
    contentKey,
    entry,
    endIndex,
    isLastInTurn: endIndex === totalEntryCount - 1 || !nextEntry || getEntryRole(nextEntry) !== getEntryRole(entry),
    streaming: isLastAssistantEntry && turnPhase === 'streaming_text',
    turnEnded,
    turnPhase: isLastAssistantEntry ? turnPhase : 'idle',
  };
}

function estimateTranscriptRowHeight(row: AgentConversationRenderRow): number {
  if (isBoundaryEntry(row.entry)) return 72;
  const message = (row.entry as AgentMessageEntry).message;
  const content = message.content;
  if (typeof content === 'string') {
    return Math.max(72, Math.ceil(content.length / 72) * 24 + 32);
  }
  const textLength = content.reduce((total, block) => {
    if (block.type === 'text') return total + block.text.length;
    if (block.type === 'thinking') return total + block.thinking.length;
    return total + 48;
  }, 0);
  const base = message.role === 'user' ? 64 : TRANSCRIPT_ROW_ESTIMATE_PX;
  return Math.max(base, Math.ceil(textLength / 84) * 24 + 44);
}

function buildVirtualTranscriptLayout(
  rows: AgentConversationRenderRow[],
  measuredHeights: Map<string, number>,
): VirtualTranscriptLayout {
  const items: VirtualTranscriptItem[] = [];
  let top = 0;
  for (const row of rows) {
    const height = measuredHeights.get(row.key) ?? estimateTranscriptRowHeight(row);
    items.push({ top, height });
    top += height + TRANSCRIPT_ROW_GAP_PX;
  }
  return {
    items,
    totalHeight: rows.length > 0 ? top - TRANSCRIPT_ROW_GAP_PX : 0,
  };
}

function firstItemEndingAfter(items: VirtualTranscriptItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const item = items[mid]!;
    if (item.top + item.height < y) low = mid + 1;
    else high = mid;
  }
  return low;
}

function firstItemStartingAfter(items: VirtualTranscriptItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (items[mid]!.top <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}

function visibleTranscriptRange(
  layout: VirtualTranscriptLayout,
  scrollTop: number,
  viewportHeight: number,
): { start: number; end: number } {
  const minY = Math.max(0, scrollTop - TRANSCRIPT_VIRTUAL_OVERSCAN_PX);
  const maxY = scrollTop + viewportHeight + TRANSCRIPT_VIRTUAL_OVERSCAN_PX;
  const start = Math.max(0, firstItemEndingAfter(layout.items, minY) - 1);
  const end = Math.min(layout.items.length, firstItemStartingAfter(layout.items, maxY) + 1);
  return { start, end: Math.max(end, start + 1) };
}

type PayloadTextPromiseCache = Map<string, Promise<string | null>>;

function payloadCopyCacheKey(conversationId: string, payloadId: string): string {
  return `${conversationId}:${payloadId}`;
}

function loadPayloadTextForCopy(
  conversationId: string | null,
  payloadId: string,
  cache: PayloadTextPromiseCache,
): Promise<string | null> {
  if (!conversationId) return Promise.resolve(null);
  const key = payloadCopyCacheKey(conversationId, payloadId);
  let pending = cache.get(key);
  if (!pending) {
    pending = api.agentPayloadText(conversationId, payloadId).catch(() => null);
    cache.set(key, pending);
  }
  return pending;
}

async function toolResultCopyText(
  result: AgentToolResultWithPayloads | undefined,
  conversationId: string | null,
  payloadTextCache: PayloadTextPromiseCache,
): Promise<string> {
  if (!result) return '';
  const blocks: string[] = [];
  for (let index = 0; index < result.content.length; index += 1) {
    const block = result.content[index]!;
    if (block.type !== 'text') continue;
    const payloadRef = result.payloadRefs?.find((ref) => ref.contentIndex === index);
    if (payloadRef) {
      const fullText = await loadPayloadTextForCopy(conversationId, payloadRef.payload.id, payloadTextCache);
      blocks.push(fullText ?? block.text);
      continue;
    }
    blocks.push(block.text);
  }
  return blocks.join('\n\n').trim();
}

async function buildAssistantTurnCopyText(
  entries: AgentConversationEntry[],
  lastEntryIndex: number,
  toolResults: Map<string, AgentToolResultWithPayloads>,
  conversationId: string | null,
  payloadTextCache: PayloadTextPromiseCache,
): Promise<string> {
  let turnStart = lastEntryIndex;
  while (turnStart > 0) {
    const previous = entries[turnStart - 1]!;
    if (isTurnBoundaryEntry(previous)) break;
    turnStart -= 1;
  }

  const parts: string[] = [];
  for (let i = turnStart; i <= lastEntryIndex; i += 1) {
    const entry = entries[i]!;
    if (entry.kind !== 'message') continue;
    if (entry.message.role !== 'assistant') continue;

    for (const block of entry.message.content) {
      if (block.type === 'text') {
        const trimmed = block.text.trim();
        if (trimmed) parts.push(trimmed);
        continue;
      }
      if (block.type === 'toolCall') {
        parts.push(`\`\`\`tool ${block.name}\n${JSON.stringify(block.arguments ?? {}, null, 2)}\n\`\`\``);
        const resultText = await toolResultCopyText(toolResults.get(block.id), conversationId, payloadTextCache);
        if (resultText) {
          const tag = toolResults.get(block.id)?.isError ? 'tool-error' : 'tool-result';
          parts.push(`\`\`\`${tag}\n${resultText}\n\`\`\``);
        }
      }
    }
  }

  return parts.join('\n\n');
}

function AgentTranscriptRowShell({
  children,
  onMeasure,
  rowKey,
  style,
  virtualized,
}: {
  children: ReactNode;
  onMeasure: (rowKey: string, height: number) => void;
  rowKey: string;
  style?: CSSProperties;
  virtualized: boolean;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return;
    const measure = () => {
      onMeasure(rowKey, element.getBoundingClientRect().height);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, rowKey]);

  return (
    <div
      className={virtualized ? 'agent-chat-virtual-row' : 'agent-chat-flow-row'}
      data-agent-transcript-row={rowKey}
      ref={rowRef}
      style={style}
    >
      {children}
    </div>
  );
}

function activityStateLabel(entry: AgentRenderActivityEntry, t: ReturnType<typeof useT>): string {
  if (entry.state === 'using_tools') return t.agent.chat.activityStates.usingTools;
  if (entry.state === 'received') return t.agent.chat.activityStates.received;
  return t.agent.chat.activityStates.thinking;
}

function activityAgentLabel(
  entry: AgentRenderActivityEntry,
  memberByAgentId: Map<string, AgentRenderMemberView>,
  agentDefinitionById: Map<string, AgentDefinitionView>,
): { label: string; mention: string } {
  const member = memberByAgentId.get(entry.agentId);
  const definition = agentDefinitionById.get(entry.agentId);
  const mention = member?.mention ?? agentMentionToken(entry.agentId);
  const label = agentDefinitionName(definition) ?? member?.displayName ?? `@${mention}`;
  return { label, mention };
}

function AgentChannelActivityArea({
  agentDefinitionById,
  entries,
  memberByAgentId,
  onOpenEntry,
  onStopEntry,
  selectedEntryId,
}: {
  agentDefinitionById: Map<string, AgentDefinitionView>;
  entries: readonly AgentRenderActivityEntry[];
  memberByAgentId: Map<string, AgentRenderMemberView>;
  onOpenEntry: (entryId: string) => void;
  onStopEntry: (entry: AgentRenderActivityEntry) => void;
  selectedEntryId: string | null;
}) {
  const t = useT();
  const liveItems = useMemo(() => entries.map((entry) => {
    const { label, mention } = activityAgentLabel(entry, memberByAgentId, agentDefinitionById);
    return {
      canStop: entry.runId !== null,
      entry,
      label,
      mention,
      stateLabel: activityStateLabel(entry, t),
    };
  }), [agentDefinitionById, entries, memberByAgentId, t]);
  const [snapshotItems, setSnapshotItems] = useState<readonly typeof liveItems[number][] | null>(null);
  const visibleItems = snapshotItems ?? liveItems;
  if (visibleItems.length === 0) return null;

  const freezeEntries = () => {
    if (liveItems.length === 0) return;
    setSnapshotItems((current) => current ?? liveItems);
  };
  const summaryItems = visibleItems.slice(0, 4);
  const summaryOverflowCount = visibleItems.length - summaryItems.length;

  return (
    <div
      className="agent-channel-activity"
      aria-label={t.agent.chat.channelActivity}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
          setSnapshotItems(null);
        }
      }}
      onFocusCapture={freezeEntries}
      onPointerEnter={freezeEntries}
      onPointerLeave={(event) => {
        if (!event.currentTarget.matches(':focus-within')) {
          setSnapshotItems(null);
        }
      }}
    >
      <div className="agent-channel-activity-summary" aria-hidden="true">
        <span className="agent-channel-activity-avatar-stack">
          {summaryItems.map((item) => (
            <AgentIdentityAvatar key={item.entry.id} label={item.label} mention={item.mention} size="xs" />
          ))}
          {summaryOverflowCount > 0 ? (
            <span className="agent-channel-activity-overflow" title={t.agent.chat.activityOverflow({ count: summaryOverflowCount })}>
              {t.agent.chat.activityOverflow({ count: summaryOverflowCount })}
            </span>
          ) : null}
        </span>
      </div>
      <div className="agent-channel-activity-list">
        <div className="agent-channel-activity-list-header">
          <span>{t.agent.chat.channelActivity}</span>
          <span>{visibleItems.length}</span>
        </div>
        <div className="agent-channel-activity-list-scroll">
          {visibleItems.map((item) => {
            return (
              <div
                className={`agent-channel-activity-item-shell is-${item.entry.state}${item.canStop ? ' has-stop' : ''}${selectedEntryId === item.entry.id ? ' is-selected' : ''}`}
                key={item.entry.id}
              >
                <ButtonControl
                  aria-pressed={selectedEntryId === item.entry.id}
                  className="agent-channel-activity-item"
                  onClick={() => {
                    setSnapshotItems(null);
                    onOpenEntry(item.entry.id);
                  }}
                  title={`${item.label} · ${item.stateLabel}`}
                >
                  <span className="agent-channel-activity-copy">
                    <span className="agent-channel-activity-agent-line">
                      <AgentIdentityAvatar label={item.label} mention={item.mention} size="xs" />
                      <span className="agent-channel-activity-name">{item.label}</span>
                    </span>
                    <small className="agent-channel-activity-state">
                      <span className="agent-channel-activity-state-dot" aria-hidden="true" />
                      <span>{item.stateLabel}</span>
                    </small>
                  </span>
                </ButtonControl>
                {item.canStop ? (
                  <IconButton
                    className="agent-channel-activity-stop"
                    icon={StopIcon}
                    label={t.agent.chat.stopActivityEntry({ name: item.label })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onStopEntry(item.entry);
                    }}
                    variant="message"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function povRoleLabel(role: AgentPovInspectorView['messages'][number]['role']): string {
  if (role === 'toolResult') return 'tool result';
  return role;
}

function AgentPovInspectorPanel({
  member,
  onClose,
  view,
}: {
  member: AgentRenderMemberView;
  onClose: () => void;
  view: AgentPovInspectorView;
}) {
  const t = useT();
  const label = member.displayName;
  return (
    <aside className="agent-child-run-details-panel agent-pov-inspector-panel" aria-label={t.agent.chat.povInspectorAriaLabel({ name: label })}>
      <header className="agent-child-run-details-header">
        <div className="agent-child-run-title-block">
          <div className="agent-child-run-title-line">
            <AgentIdentityAvatar label={label} mention={member.mention} />
            <span>{`@${member.mention}`}</span>
          </div>
          <h3>{t.agent.chat.povInspectorTitle({ name: label })}</h3>
          <p>
            {view.addressedByMessageId
              ? t.agent.chat.povInspectorBoundary({ messageId: view.addressedByMessageId })
              : t.agent.chat.povInspectorNoBoundary}
          </p>
        </div>
        <IconButton
          className="agent-child-run-close"
          icon={CloseIcon}
          label={t.agent.chat.closePovInspector}
          onClick={onClose}
          variant="panel"
        />
      </header>
      <div className="agent-child-run-details-body agent-pov-inspector-body">
        <section className="agent-pov-inspector-section" aria-label={t.agent.chat.povInspectorMemory}>
          <div className="agent-pov-inspector-section-title">{t.agent.chat.povInspectorMemory}</div>
          {view.memoryBriefing?.trim() ? (
            <div className="agent-pov-inspector-memory">
              <AgentMarkdown keyPrefix={`pov-memory-${view.agentId}`} text={view.memoryBriefing} />
            </div>
          ) : (
            <EmptyState className="agent-child-run-empty agent-pov-inspector-empty" title={t.agent.chat.povInspectorNoMemory} />
          )}
        </section>
        <section className="agent-pov-inspector-section" aria-label={t.agent.chat.povInspectorMessages}>
          <div className="agent-pov-inspector-section-title">{t.agent.chat.povInspectorMessages}</div>
          {view.messages.length === 0 ? (
            <EmptyState className="agent-child-run-empty agent-pov-inspector-empty" title={t.agent.chat.povInspectorNoMessages} />
          ) : (
            <div className="agent-pov-inspector-message-list">
              {view.messages.map((message, index) => (
                <article className={`agent-pov-inspector-message is-${message.role}`} key={message.id}>
                  <div className="agent-child-run-transcript-head">
                    <span>{povRoleLabel(message.role)}</span>
                    <code>{message.sourceMessageIds.join(', ')}</code>
                  </div>
                  <div className="agent-pov-inspector-part-list">
                    {message.parts.map((part, partIndex) => (
                      <div className="agent-pov-inspector-part" key={`${part.sourceMessageId}:${partIndex}`}>
                        {part.preamble ? <pre>{part.preamble}</pre> : null}
                        {part.text.trim() ? (
                          <AgentMarkdown
                            keyPrefix={`pov-${view.agentId}-${index}-${partIndex}`}
                            text={part.text}
                          />
                        ) : (
                          <span className="agent-pov-inspector-muted">{t.agent.chat.povInspectorEmptyPart}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}

export function AgentChatPanel({
  index,
  dockOpen,
  onOpenNodeReference,
  onOpenDebugPanel,
  userViewContext,
}: AgentChatPanelProps) {
  const t = useT();
  const { locale } = useI18n();
  const {
    entries,
    error,
    dmRunActive,
    channelRunsActive,
    clearSteer,
    editMessage,
    pendingToolCallIds,
    regenerateMessage,
    reloadConversation,
    pendingApproval,
    pendingUserQuestion,
    revision,
    retryMessage,
    resolveApproval,
    resolveUserQuestion,
    selectConversation,
    sendMessage: sendRuntimeMessage,
    conversationId,
    conversationTitle,
    members,
    channelActivityEntries,
    povInspectors,
    steer: steerRuntime,
    childRuns,
    childRunsByParentToolCallId,
    switchBranch,
    stop,
    stopRun,
    tasks,
    toolResults,
    turnPhase,
    unreadByConversationId,
  } = useLinAgentRuntime();
  // Any run in flight (DM streaming or Channel work): gates transcript rewrites
  // (edit/regenerate/retry/branch), which stay blocked while the shared log moves.
  const anyRunActive = dmRunActive || channelRunsActive;
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [steeringNote, setSteeringNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<AgentConversationListMeta[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [slashCommands, setSlashCommands] = useState<AgentSlashCommandView[]>([]);
  const [rowActionMenu, setRowActionMenu] = useState<string | null>(null);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [selectedChildRunId, setSelectedChildRunId] = useState<string | null>(null);
  const [selectedActivityEntryId, setSelectedActivityEntryId] = useState<string | null>(null);
  const [selectedPovAgentId, setSelectedPovAgentId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const mountedRef = useRef(false);
  const providerSettingsRequestRef = useRef(0);
  const conversationsRequestRef = useRef(0);
  const slashCommandsRequestRef = useRef(0);
  const agentDefinitionsRequestRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const highlightTimeoutRef = useRef<number | null>(null);
  const rowHeightsRef = useRef(new Map<string, number>());
  const copyPayloadTextCacheRef = useRef<PayloadTextPromiseCache>(new Map());
  const dockOpenRef = useRef(dockOpen);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState({ height: 0, top: 0 });
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  useEffect(() => {
    if (dockOpen && !dockOpenRef.current) {
      setComposerFocusToken((token) => token + 1);
    }
    dockOpenRef.current = dockOpen;
  }, [dockOpen]);
  const agentMembers = useMemo(
    () => members.filter((member) => member.principal.type === 'agent' && member.mention),
    [members],
  );
  const activeConversationMeta = useMemo(
    () => conversations.find((conversation) => conversation.id === conversationId) ?? null,
    [conversations, conversationId],
  );
  const isChannel = isChannelConversation(conversationId, activeConversationMeta, agentMembers.length);
  const channelMemberCount = isChannel
    ? Math.max(
        members.length + (members.some((member) => member.principal.type === 'user') ? 0 : 1),
        agentMembers.length + 1,
      )
    : 0;
  const isMultiAgentChannel = isChannel && agentMembers.length >= 2;
  const memberByAgentId = useMemo(() => {
    const map = new Map<string, AgentRenderMemberView>();
    for (const member of agentMembers) {
      if (member.principal.type === 'agent') map.set(member.principal.agentId, member);
    }
    return map;
  }, [agentMembers]);
  // Attribution authority: the coordinator member's agentId. Badges compare a
  // message's recorded actor against THIS — never against the live roster — so
  // a departed member's historical turns keep their name.
  const coordinatorAgentId = useMemo(() => {
    for (const member of members) {
      if (member.coordinator && member.principal.type === 'agent') return member.principal.agentId;
    }
    return null;
  }, [members]);
  const composerMembers = useMemo(
    () => (isMultiAgentChannel
      ? agentMembers.map((member) => ({
          mention: member.mention,
          displayName: member.displayName,
          ...(member.coordinator ? { coordinator: true } : {}),
        }))
      : []),
    [agentMembers, isMultiAgentChannel],
  );
  // Multi-agent Channel thread = utterances only: in-flight assistant entries
  // live in the activity area, and each message appears whole on completion.
  // DMs and single-agent Channels keep the streaming tail.
  const threadEntries = useMemo(
    () => (isMultiAgentChannel
      ? entries.filter((entry) => !(entry.kind === 'message' && entry.message.role === 'assistant' && entry.streaming))
      : entries),
    [entries, isMultiAgentChannel],
  );
  const conversationRows = useMemo(
    () => buildConversationRenderRows(threadEntries, isMultiAgentChannel ? 'idle' : turnPhase),
    [threadEntries, isMultiAgentChannel, turnPhase],
  );
  const replyAnchorByMessageId = useMemo(
    () => buildReplyAnchorMap(conversationRows),
    [conversationRows],
  );
  const runningTaskCount = useMemo(() => tasks.filter((task) => task.status === 'running').length, [tasks]);
  const selectedChildRun = selectedChildRunId ? childRuns[selectedChildRunId] ?? null : null;
  const selectedActivityEntry = selectedActivityEntryId
    ? channelActivityEntries.find((entry) => entry.id === selectedActivityEntryId) ?? null
    : null;
  const selectedPovInspector = selectedPovAgentId ? povInspectors[selectedPovAgentId] ?? null : null;
  const selectedPovMember = selectedPovAgentId ? memberByAgentId.get(selectedPovAgentId) ?? null : null;
  const [agentDefinitions, setAgentDefinitions] = useState<AgentDefinitionView[]>([]);
  const agentDefinitionById = useMemo(() => {
    const map = new Map<string, AgentDefinitionView>();
    for (const definition of agentDefinitions) map.set(definition.agentId, definition);
    return map;
  }, [agentDefinitions]);
  const dmAgentMember = !isChannel && agentMembers.length === 1 ? agentMembers[0]! : null;
  const dmAgentId = dmAgentMember?.principal.type === 'agent' ? dmAgentMember.principal.agentId : null;
  const dmAgentDefinition = dmAgentId ? agentDefinitionById.get(dmAgentId) : undefined;
  const dmAgentLabel = dmAgentId
    ? agentDefinitionName(dmAgentDefinition) ?? dmAgentMember?.displayName ?? `@${agentMentionToken(dmAgentId)}`
    : null;
  const dmAgentMention = dmAgentMember?.mention ?? (dmAgentId ? agentMentionToken(dmAgentId) : null);
  const directMessageRows = useMemo(
    () => conversations.filter((conversation) => conversation.canonicalDmAgentId),
    [conversations],
  );
  const channelRows = useMemo(
    () => conversations.filter((conversation) => !conversation.canonicalDmAgentId),
    [conversations],
  );
  const virtualLayout = useMemo(
    () => buildVirtualTranscriptLayout(conversationRows, rowHeightsRef.current),
    [conversationRows, measureVersion],
  );
  const shouldVirtualizeTranscript = conversationRows.length > TRANSCRIPT_VIRTUAL_MIN_ROWS;
  const virtualRange = shouldVirtualizeTranscript
    ? visibleTranscriptRange(virtualLayout, scrollMetrics.top, scrollMetrics.height)
    : { start: 0, end: conversationRows.length };
  const visibleConversationRows = conversationRows.slice(virtualRange.start, virtualRange.end);
  const sendMessage = useCallback((
    prompt: string,
    attachments?: AgentMessageAttachmentInput[],
    nodeRefs: AgentComposerNodeReference[] = [],
  ) => (
    sendRuntimeMessage(prompt, attachments, withReferencedNodes(userViewContext, nodeRefs, index, t.common.untitled))
  ), [index, sendRuntimeMessage, userViewContext, t.common.untitled]);

  const updateScrollMetrics = useCallback((element: HTMLDivElement) => {
    const next = {
      height: element.clientHeight,
      top: element.scrollTop,
    };
    setScrollMetrics((current) => {
      if (Math.abs(current.height - next.height) < 1 && Math.abs(current.top - next.top) < 1) {
        return current;
      }
      return next;
    });
  }, []);

  const scheduleScrollMetrics = useCallback((element: HTMLDivElement) => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      updateScrollMetrics(element);
    });
  }, [updateScrollMetrics]);

  const measureConversationRow = useCallback((rowKey: string, height: number) => {
    const current = rowHeightsRef.current.get(rowKey);
    if (current !== undefined && Math.abs(current - height) < 1) return;
    rowHeightsRef.current.set(rowKey, height);
    setMeasureVersion((version) => version + 1);
  }, []);

  const revealMessage = useCallback((messageId: string) => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const findTarget = () => Array
      .from(scrollElement.querySelectorAll<HTMLElement>('[data-agent-message-id]'))
      .find((element) => element.dataset.agentMessageId === messageId) ?? null;
    const target = findTarget();
    if (target) {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    } else {
      const rowIndex = conversationRows.findIndex((row) => (
        row.entry.kind === 'message' && row.entry.nodeId === messageId
      ));
      const item = rowIndex >= 0 ? virtualLayout.items[rowIndex] : undefined;
      if (item) {
        scrollElement.scrollTop = Math.max(0, item.top - scrollElement.clientHeight / 3);
        updateScrollMetrics(scrollElement);
      }
    }
    setHighlightedMessageId(messageId);
    if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current);
    highlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === messageId ? null : current));
      highlightTimeoutRef.current = null;
    }, 1400);
  }, [conversationRows, updateScrollMetrics, virtualLayout.items]);

  const loadProviderSettings = useCallback(async () => {
    const requestId = providerSettingsRequestRef.current + 1;
    providerSettingsRequestRef.current = requestId;
    try {
      const next = await api.agentGetProviderSettings();
      if (!mountedRef.current || requestId !== providerSettingsRequestRef.current) return null;
      setProviderSettings(next);
      setSettingsError(null);
      return next;
    } catch (caught) {
      if (mountedRef.current && requestId === providerSettingsRequestRef.current) {
        setSettingsError(caught instanceof Error ? caught.message : String(caught));
      }
      return null;
    }
  }, []);

  const loadConversations = useCallback(async () => {
    const requestId = conversationsRequestRef.current + 1;
    conversationsRequestRef.current = requestId;
    setConversationsLoading(true);
    try {
      const next = await api.agentListConversations();
      if (!mountedRef.current || requestId !== conversationsRequestRef.current) return null;
      setConversations(next);
      return next;
    } catch (caught) {
      if (mountedRef.current && requestId === conversationsRequestRef.current) {
        setSettingsError(caught instanceof Error ? caught.message : String(caught));
      }
      return null;
    } finally {
      if (mountedRef.current && requestId === conversationsRequestRef.current) {
        setConversationsLoading(false);
      }
    }
  }, []);

  const loadSlashCommands = useCallback(async () => {
    const requestId = slashCommandsRequestRef.current + 1;
    slashCommandsRequestRef.current = requestId;
    if (!conversationId) {
      setSlashCommands([]);
      return null;
    }
    try {
      const next = await api.agentListSlashCommands(conversationId);
      if (!mountedRef.current || requestId !== slashCommandsRequestRef.current) return null;
      setSlashCommands(next);
      return next;
    } catch (caught) {
      if (mountedRef.current && requestId === slashCommandsRequestRef.current) {
        setSettingsError(caught instanceof Error ? caught.message : String(caught));
        setSlashCommands([]);
      }
      return null;
    }
  }, [conversationId]);

  const loadAgentDefinitions = useCallback(async () => {
    const requestId = agentDefinitionsRequestRef.current + 1;
    agentDefinitionsRequestRef.current = requestId;
    if (!conversationId) {
      setAgentDefinitions([]);
      return null;
    }
    try {
      const next = await api.agentListAllDefinitions(conversationId);
      if (!mountedRef.current || requestId !== agentDefinitionsRequestRef.current) return null;
      setAgentDefinitions(next);
      return next;
    } catch {
      if (mountedRef.current && requestId === agentDefinitionsRequestRef.current) setAgentDefinitions([]);
      return null;
    }
  }, [conversationId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    updateScrollMetrics(element);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => updateScrollMetrics(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [conversationId, updateScrollMetrics]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
    updateScrollMetrics(element);
  }, [conversationRows.length, dmRunActive, revision, updateScrollMetrics, virtualLayout.totalHeight]);

  useEffect(() => {
    rowHeightsRef.current.clear();
    copyPayloadTextCacheRef.current.clear();
    setMeasureVersion((version) => version + 1);
  }, [conversationId]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (highlightTimeoutRef.current !== null) {
      window.clearTimeout(highlightTimeoutRef.current);
      highlightTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadProviderSettings();
    return () => {
      mountedRef.current = false;
      providerSettingsRequestRef.current += 1;
      conversationsRequestRef.current += 1;
      slashCommandsRequestRef.current += 1;
      agentDefinitionsRequestRef.current += 1;
    };
  }, [loadProviderSettings]);

  useEffect(() => {
    void loadSlashCommands();
  }, [loadSlashCommands]);

  useEffect(() => {
    // Steering is a DM-only affordance; clear the note when the DM run settles.
    if (!dmRunActive) {
      setSteeringNote(null);
    }
  }, [dmRunActive]);

  useEffect(() => {
    if (selectedChildRunId && !childRuns[selectedChildRunId]) setSelectedChildRunId(null);
  }, [selectedChildRunId, childRuns]);

  useEffect(() => {
    if (selectedActivityEntryId && !channelActivityEntries.some((entry) => entry.id === selectedActivityEntryId)) {
      setSelectedActivityEntryId(null);
    }
  }, [channelActivityEntries, selectedActivityEntryId]);

  useEffect(() => {
    if (selectedPovAgentId && !povInspectors[selectedPovAgentId]) {
      setSelectedPovAgentId(null);
    }
  }, [povInspectors, selectedPovAgentId]);

  // A command Run reveals its delivery conversation and asks for the task panel —
  // the run is a parentless child run, so it surfaces there (the open task panel
  // persists across the conversation switch this same reveal triggers).
  useEffect(() => onAgentRevealRequest((_conversationId, options) => {
    if (!options.openTasks) return;
    setSelectedChildRunId(null);
    setTaskPanelOpen(true);
  }), []);

  useEffect(() => {
    if (historyOpen) void loadConversations();
  }, [historyOpen, loadConversations]);

  useEffect(() => {
    if (!historyOpen) setRowActionMenu(null);
  }, [historyOpen]);

  useEffect(() => {
    void loadAgentDefinitions();
  }, [loadAgentDefinitions]);

  useEffect(() => {
    if (!historyOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && headerRef.current?.contains(target)) return;
      if (target instanceof Node && historyMenuRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-agent-conversation-row-menu="true"]')) return;
      setHistoryOpen(false);
      setRowActionMenu(null);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [historyOpen]);

  const handleResolveApproval = useCallback(async (
    requestId: string,
    approved: boolean,
    scope: AgentApprovalResolutionScope = 'once',
  ) => {
    const resolved = await resolveApproval(requestId, approved, scope);
    if (resolved && scope === 'full_access') void loadProviderSettings();
    return resolved;
  }, [loadProviderSettings, resolveApproval]);

  function openComposerModelSettings() {
    if (dmAgentDefinition) {
      void window.lin?.openAgentConfig?.({ agentId: dmAgentDefinition.agentId, mode: 'configure' });
      return;
    }
    const activeProvider = providerSettings ? resolveUsableActiveProvider(providerSettings) : null;
    if (activeProvider?.providerId) {
      void window.lin?.openProviderConfig?.({ providerId: activeProvider.providerId, mode: 'configure' });
      return;
    }
    void window.lin?.openSettings?.({ category: 'providers' });
  }

  async function refreshAfterSettingsChange() {
    await Promise.all([
      loadProviderSettings(),
      loadConversations(),
      loadSlashCommands(),
      loadAgentDefinitions(),
      reloadConversation(),
    ]);
  }

  // Settings now live in a separate window; when it applies changes the main
  // process broadcasts here so the panel re-syncs provider/slash/conversation state
  // instead of showing stale providers. A ref keeps the subscription mounted once
  // while always calling the latest closure.
  const refreshAfterSettingsChangeRef = useRef(refreshAfterSettingsChange);
  refreshAfterSettingsChangeRef.current = refreshAfterSettingsChange;
  useEffect(
    () => window.lin?.onSettingsChanged?.(() => void refreshAfterSettingsChangeRef.current()),
    [],
  );
  // Clicking an OS notification banner routes here — open the originating conversation.
  const selectConversationRef = useRef(selectConversation);
  selectConversationRef.current = selectConversation;
  useEffect(
    () => window.lin?.onNavigateToConversation?.((targetId) => {
      // selectConversation rethrows on failure (e.g. the conversation was deleted);
      // swallow so a stale banner click is not an unhandled rejection.
      void selectConversationRef.current(targetId).catch(() => {});
    }),
    [],
  );
  // The dock collapses CSS-only while keeping this panel mounted, so report the
  // real open state: gate durable mark-read (renderer) and OS-banner suppression
  // (main) on whether the user can actually SEE the conversation, not just on it
  // being loaded. Opening the dock reads the conversation it reveals (setDockVisible);
  // collapsing reports null so a background completion still escalates.
  useEffect(() => {
    linAgentRuntimeStore.setDockVisible(dockOpen);
    void window.lin?.agentSetViewedConversation?.(dockOpen ? conversationId : null);
  }, [dockOpen, conversationId]);

  // Unmount only (reload / window teardown): no panel is showing any conversation,
  // so clear the viewed signal. Without this main keeps suppressing OS banners
  // against the last-viewed conversation until the renderer re-mounts and re-reports.
  // Kept separate from the push effect above so a conversation switch does not churn
  // the signal false→null→back on every dependency change.
  useEffect(() => () => {
    linAgentRuntimeStore.setDockVisible(false);
    void window.lin?.agentSetViewedConversation?.(null);
  }, []);

  async function handleSteerMessage(message: string) {
    const trimmed = message.trim();
    if (!trimmed) return;
    const combined = steeringNote ? `${steeringNote}\n${trimmed}` : trimmed;
    setSteeringNote(combined);
    const queued = await steerRuntime(combined);
    if (!queued) {
      setSteeringNote(null);
    }
  }

  async function handleCancelSteer() {
    setSteeringNote(null);
    await clearSteer();
  }

  function handleNewConversation() {
    setHistoryOpen(false);
    setRowActionMenu(null);
    void window.lin?.openChannelConfig?.({ mode: 'create' });
  }

  function handleNewAgent() {
    setHistoryOpen(false);
    setRowActionMenu(null);
    void window.lin?.openAgentConfig?.({ mode: 'create' });
  }

  function handleConfigureAgent(agentId: string) {
    setHistoryOpen(false);
    setRowActionMenu(null);
    void window.lin?.openAgentConfig?.({ agentId, mode: 'configure' });
  }

  function handleConfigureChannel(targetConversationId: string) {
    setHistoryOpen(false);
    setRowActionMenu(null);
    void window.lin?.openChannelConfig?.({ conversationId: targetConversationId, mode: 'configure' });
  }

  function handleInspectMemberPov(agentId: string) {
    setSelectedPovAgentId(agentId);
    setSelectedActivityEntryId(null);
    setSelectedChildRunId(null);
    setTaskPanelOpen(false);
    setHistoryOpen(false);
    setRowActionMenu(null);
  }

  async function handleSelectConversation(targetConversationId: string) {
    // Switching away from an active Channel is allowed (Slack-like): only a busy
    // DM (serial, steerable) blocks navigation. Channel runs continue in the
    // background and surface unread via conversation_attention.
    if (dmRunActive || targetConversationId === conversationId) return;
    setHistoryOpen(false);
    setRowActionMenu(null);
    await selectConversation(targetConversationId);
  }

  function renderConversationRow(row: AgentConversationRenderRow): ReactNode {
    if (row.entry.kind === 'compaction') {
      return <AgentCompactionBoundary entry={row.entry} />;
    }
    if (row.entry.kind === 'dream') {
      return <AgentDreamBoundary entry={row.entry} />;
    }
    if (row.entry.kind === 'child-run') {
      return <AgentChildRunBoundary entry={row.entry} onOpenTranscript={setSelectedChildRunId} />;
    }

    const systemText = systemLineText(row.entry);
    if (systemText) {
      return (
        <div className="agent-system-line" role="note">
          <span>{systemText}</span>
        </div>
      );
    }

    // Channel attribution: name the speaking agent on assistant rows. Derived
    // from the message's recorded actor — NOT from the live roster — so removing
    // a member never erases who spoke; departed members fall back to their `@`
    // token or saved definition name when still available.
    const actor = row.entry.actor;
    const speakerAgentId = isChannel && actor?.type === 'agent'
      ? actor.agentId
      : null;
    const actorMember = speakerAgentId ? memberByAgentId.get(speakerAgentId) : undefined;
    const actorDefinition = speakerAgentId ? agentDefinitionById.get(speakerAgentId) : undefined;
    const actorMention = actorMember?.mention ?? (speakerAgentId ? agentMentionToken(speakerAgentId) : undefined);
    const actorDisplayName = speakerAgentId
      ? agentDefinitionName(actorDefinition) ?? actorMember?.displayName ?? `@${agentMentionToken(speakerAgentId)}`
      : null;
    const actorLabel = speakerAgentId && row.entry.message.role === 'assistant'
      ? actorDisplayName
      : null;
    const detailSpeakerAgentId = row.entry.message.role === 'assistant'
      ? (actor?.type === 'agent' ? actor.agentId : dmAgentId ?? coordinatorAgentId)
      : null;
    const detailSpeakerDefinition = detailSpeakerAgentId ? agentDefinitionById.get(detailSpeakerAgentId) : undefined;
    const detailSpeakerMember = detailSpeakerAgentId ? memberByAgentId.get(detailSpeakerAgentId) : undefined;
    const detailSpeakerMention = detailSpeakerMember?.mention ?? (detailSpeakerAgentId ? agentMentionToken(detailSpeakerAgentId) : null);
    const detailSpeakerLabel = row.entry.message.role === 'assistant'
      ? agentDefinitionName(detailSpeakerDefinition)
        ?? detailSpeakerMember?.displayName
        ?? (detailSpeakerAgentId ? `@${agentMentionToken(detailSpeakerAgentId)}` : dmAgentLabel)
        ?? t.agent.message.roleAssistant
      : t.agent.message.you;
    // Pure-utterance thread (ratified): a delivered Channel message renders its
    // final text only — process blocks live behind the typing drill-in / M3-C.
    const displayEntry = isChannel && row.entry.message.role === 'assistant'
      ? {
          ...row.entry,
          message: {
            ...row.entry.message,
            content: row.entry.message.content.filter((block) => block.type === 'text'),
          },
        }
      : row.entry;
    const rowMessageId = row.entry.nodeId;
    const replyAnchor = rowMessageId ? replyAnchorByMessageId.get(rowMessageId) ?? null : null;

    const copyAssistantTurn = row.isLastInTurn && getEntryRole(row.entry) === 'assistant'
      ? async () => {
          const text = await buildAssistantTurnCopyText(
            entries,
            row.endIndex,
            toolResults,
            conversationId,
            copyPayloadTextCacheRef.current,
          );
          if (text) await navigator.clipboard.writeText(text);
        }
      : undefined;

    return (
      <AgentMessageRow
        actorLabel={actorLabel}
        actorMention={actorMention}
        busy={anyRunActive}
        contentKey={row.contentKey}
        entry={displayEntry}
        highlighted={rowMessageId !== null && rowMessageId === highlightedMessageId}
        index={index}
        isLastInTurn={row.isLastInTurn}
        onCopy={copyAssistantTurn}
        onEdit={editMessage}
        onNodeReferenceOpen={onOpenNodeReference}
        onOpenChildRunTranscript={setSelectedChildRunId}
        onRegenerate={regenerateMessage}
        onRetry={retryMessage}
        onSwitchBranch={switchBranch}
        pendingToolCallIds={pendingToolCallIds}
        conversationId={conversationId}
        streaming={row.streaming}
        childRunsByParentToolCallId={childRunsByParentToolCallId}
        toolResults={toolResults}
        turnEnded={row.turnEnded}
        turnPhase={row.turnPhase}
        speakerLabel={detailSpeakerLabel}
        speakerMention={detailSpeakerMention}
        replyAnchor={replyAnchor}
        onReplyAnchorClick={revealMessage}
      />
    );
  }

  const visibleError = error ?? settingsError;
  // Provider settings load async (`providerSettings` starts null). Gate the
  // no-provider onboarding on the LOADED state so a key-holding user never sees
  // it flash during the load window; until loaded we stay neutral.
  const settingsLoaded = providerSettings !== null;
  const hasUsableProvider = settingsLoaded && Boolean(resolveUsableActiveProvider(providerSettings));
  // Unnamed conversations read "untitled" in the header too, matching the conversation list
  // and delete-confirm — one fallback everywhere so inside/outside never disagree.
  const displayTitle = readableConversationTitle(conversationTitle, t.common.untitled);
  const dockMenuAnchorRef = useMemo(() => ({
    current: {
      getBoundingClientRect: () => {
        const titleRect = historyButtonRef.current?.getBoundingClientRect();
        const dock = headerRef.current?.closest('.agent-dock');
        if (!(dock instanceof HTMLElement) || !titleRect) {
          return titleRect ?? new DOMRect(0, 0, 220, 28);
        }
        const dockRect = dock.getBoundingClientRect();
        const railPad = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-pad')) || 8;
        const left = dockRect.left + railPad;
        const width = Math.max(220, dockRect.width - railPad * 2);
        return new DOMRect(left, titleRect.top, width, titleRect.height);
      },
    },
  }), []);
  const historyMenuStyle = useAnchoredOverlay(historyMenuRef, {
    anchorRef: dockMenuAnchorRef,
    disabled: !historyOpen,
    layoutKey: `${conversations.length}:${conversationsLoading ? 'loading' : 'ready'}`,
    maxHeight: 420,
    placement: 'bottom-start',
  });
  return (
    <div className="agent-chat-panel" data-turn-phase={turnPhase}>
      <header className="agent-dock-header" ref={headerRef}>
        <ButtonControl
          ref={historyButtonRef}
          aria-expanded={historyOpen}
          aria-label={t.agent.chat.showConversations}
          className={isChannel ? 'agent-dock-title-button is-channel' : 'agent-dock-title-button'}
          onClick={() => setHistoryOpen((open) => !open)}
          title={t.agent.chat.showConversations}
        >
          {isChannel ? (
            <>
              <span className="agent-dock-title-leading">
                <HashIcon
                  aria-hidden="true"
                  className="agent-dock-title-icon"
                  size={ICON_SIZE.menu}
                />
              </span>
              <span className="agent-dock-title">{`${displayTitle} (${channelMemberCount})`}</span>
            </>
          ) : dmAgentId && dmAgentLabel ? (
            <>
              <span className="agent-dock-title-leading">
                <AgentIdentityAvatar
                  label={dmAgentLabel}
                  mention={dmAgentMention}
                  size="xs"
                />
              </span>
              <span className="agent-dock-title">{dmAgentLabel}</span>
            </>
          ) : (
            <span className="agent-dock-title">{displayTitle}</span>
          )}
          <ChevronDownIcon
            className={historyOpen ? 'agent-title-chevron is-open' : 'agent-title-chevron'}
            size={ICON_SIZE.menu}
          />
        </ButtonControl>
        <div className="agent-dock-actions">
          <ButtonControl
            aria-expanded={taskPanelOpen && !selectedChildRun}
            aria-label={runningTaskCount > 0
              ? t.agent.task.openPanelActive({ count: runningTaskCount })
              : t.agent.task.openPanel}
            className="agent-task-panel-button"
            onClick={() => {
              setSelectedChildRunId(null);
              setTaskPanelOpen((open) => !open);
            }}
            title={t.agent.task.openPanel}
          >
            <UsedToolsIcon size={ICON_SIZE.toolbar} />
            {runningTaskCount > 0 ? <span className="agent-task-panel-badge">{runningTaskCount}</span> : null}
          </ButtonControl>
          <IconButton
            className="agent-menu-button"
            icon={DebugIcon}
            label={t.agent.chat.openDebug}
            onClick={() => onOpenDebugPanel?.(conversationId)}
            title={t.agent.chat.openDebug}
            variant="composerTool"
          />
        </div>
        {historyOpen ? createPortal(
          <div
            ref={historyMenuRef}
            className="agent-conversation-menu"
            role="dialog"
            aria-label={t.agent.chat.conversations}
            style={historyMenuStyle}
          >
            <div className="agent-conversation-menu-header">
              <span>{t.agent.chat.directMessages}</span>
              <IconButton
                className="agent-conversation-section-action"
                icon={AddIcon}
                label={t.settings.agents.newAgent}
                onClick={handleNewAgent}
                title={t.settings.agents.newAgent}
                variant="message"
              />
            </div>
            <div className="agent-conversation-list">
              {conversationsLoading ? (
                <EmptyState
                  className="agent-conversation-empty"
                  icon={LoaderIcon}
                  loading
                  role="status"
                  size="inline"
                  title={t.common.loading}
                />
              ) : directMessageRows.length === 0 ? (
                <EmptyState className="agent-conversation-empty" size="inline" title={t.agent.chat.noDirectMessages} />
              ) : directMessageRows.map((conversation) => {
                const agentId = conversation.canonicalDmAgentId!;
                const isCurrent = conversation.id === conversationId;
                const label = conversationAgentDisplayName(
                  agentId,
                  agentDefinitionById,
                  readableConversationTitle(conversation.title, `@${agentMentionToken(agentId)}`),
                );
                const mention = agentMentionToken(agentId);
                const unread = isCurrent ? 0 : conversation.unreadCount ?? unreadByConversationId.get(conversation.id) ?? 0;
                const actionMenuKey = `dm:${conversation.id}`;
                return (
                  <div
                    className={isCurrent ? 'agent-conversation-row agent-conversation-compact-row is-current' : 'agent-conversation-row agent-conversation-compact-row'}
                    key={conversation.id}
                  >
                    <ButtonControl
                      className="agent-conversation-select agent-conversation-compact-select"
                      disabled={dmRunActive}
                      onClick={() => void handleSelectConversation(conversation.id)}
                    >
                      <AgentIdentityAvatar label={label} mention={mention} size="sm" />
                      <span className="agent-conversation-name">{label}</span>
                      {unread > 0 ? (
                        <span
                          className="agent-conversation-unread"
                          aria-label={t.agent.chat.unreadMessages({ count: unread })}
                          title={t.agent.chat.unreadMessages({ count: unread })}
                        >
                          {unread > 99 ? '99+' : unread}
                        </span>
                      ) : null}
                    </ButtonControl>
                    <div className="agent-conversation-row-actions">
                      <ConversationRowMoreMenu
                        actions={[{
                          label: t.agent.chat.configureAgent,
                          onSelect: () => handleConfigureAgent(agentId),
                        }]}
                        label={t.agent.chat.agentOptions}
                        menuLabel={t.agent.chat.agentOptions}
                        onOpenChange={(open) => setRowActionMenu(open ? actionMenuKey : null)}
                        open={rowActionMenu === actionMenuKey}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="agent-conversation-menu-header agent-conversation-section-header">
              <span>{t.agent.chat.conversations}</span>
              <IconButton
                className="agent-conversation-section-action"
                disabled={dmRunActive}
                icon={AddIcon}
                label={t.agent.chat.newConversation}
                onClick={() => void handleNewConversation()}
                title={t.agent.chat.newConversation}
                variant="message"
              />
            </div>
            <div className="agent-conversation-list">
              {conversationsLoading ? (
                <EmptyState
                  className="agent-conversation-empty"
                  icon={LoaderIcon}
                  loading
                  role="status"
                  size="inline"
                  title={t.common.loading}
                />
              ) : channelRows.length === 0 ? (
                <EmptyState className="agent-conversation-empty" size="inline" title={t.agent.chat.noConversations} />
              ) : channelRows.map((conversation) => {
                const isCurrent = conversation.id === conversationId;
                const title = readableConversationTitle(conversation.title, t.common.untitled);
                const unread = isCurrent ? 0 : conversation.unreadCount ?? unreadByConversationId.get(conversation.id) ?? 0;
                const actionMenuKey = `channel:${conversation.id}`;
                const povActions: ConversationRowMenuAction[] = isCurrent ? agentMembers.flatMap((member) => {
                  const principal = member.principal;
                  if (principal.type !== 'agent') return [];
                  const { agentId } = principal;
                  if (!povInspectors[agentId]) return [];
                  return [{
                    id: `inspect-pov:${agentId}`,
                    label: t.agent.chat.inspectMemberPov({ name: member.displayName }),
                    onSelect: () => handleInspectMemberPov(agentId),
                  }];
                }) : [];
                const channelActions: ConversationRowMenuAction[] = [{
                  disabled: anyRunActive,
                  id: 'configure-channel',
                  label: t.agent.chat.configureChannel,
                  onSelect: () => handleConfigureChannel(conversation.id),
                }, ...povActions];
                return (
                  <div
                    className={isCurrent ? 'agent-conversation-row agent-conversation-compact-row is-current' : 'agent-conversation-row agent-conversation-compact-row'}
                    key={conversation.id}
                  >
                    <ButtonControl
                      className="agent-conversation-select agent-conversation-compact-select"
                      disabled={dmRunActive}
                      onClick={() => void handleSelectConversation(conversation.id)}
                    >
                      <HashIcon
                        aria-hidden="true"
                        className="agent-conversation-channel-icon"
                        size={ICON_SIZE.menu}
                      />
                      <span className="agent-conversation-name">{title}</span>
                      {unread > 0 ? (
                        <span
                          className="agent-conversation-unread"
                          // The visible glyph caps at "99+" for width; the accessible
                          // name + tooltip carry the exact count (more useful to AT and
                          // disambiguates "99+" on hover).
                          aria-label={t.agent.chat.unreadMessages({ count: unread })}
                          title={t.agent.chat.unreadMessages({ count: unread })}
                        >
                          {unread > 99 ? '99+' : unread}
                        </span>
                      ) : null}
                    </ButtonControl>
                    <div className="agent-conversation-row-actions">
                      <ConversationRowMoreMenu
                        actions={channelActions}
                        disabled={dmRunActive && povActions.length === 0}
                        label={t.agent.chat.channelOptions}
                        menuLabel={t.agent.chat.channelOptions}
                        onOpenChange={(open) => setRowActionMenu(open ? actionMenuKey : null)}
                        open={rowActionMenu === actionMenuKey}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        ) : null}
      </header>

      <div
        ref={scrollRef}
        className="agent-chat-scroll"
        onScroll={(event) => {
          stickToBottomRef.current = shouldStickToBottom(event.currentTarget);
          scheduleScrollMetrics(event.currentTarget);
        }}
      >
        {visibleError ? (
          <div className="agent-message-error" role="status">
            <WarningIcon size={ICON_SIZE.menu} />
            <span>{visibleError}</span>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="agent-empty-state">
            {!settingsLoaded ? (
              <EmptyState icon={LoaderIcon} loading role="status" title={t.common.loading} />
            ) : hasUsableProvider ? null : (
              <div className="agent-onboarding" role="status">
                <p className="agent-onboarding-text">{t.agent.chat.onboardingText}</p>
                <Button
                  onClick={() => {
                    void window.lin?.openSettings();
                  }}
                  variant="primary"
                >
                  {t.agent.chat.onboardingCta}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div
            className={shouldVirtualizeTranscript ? 'agent-chat-transcript is-virtual' : 'agent-chat-transcript'}
            data-virtualized={shouldVirtualizeTranscript ? 'true' : 'false'}
            style={shouldVirtualizeTranscript ? { height: virtualLayout.totalHeight } : undefined}
          >
            {visibleConversationRows.map((row, offset) => {
              const rowIndex = virtualRange.start + offset;
              const item = virtualLayout.items[rowIndex];
              const previousRow = rowIndex > 0 ? conversationRows[rowIndex - 1] : undefined;
              const showTimeSeparator = previousRow
                ? getEntryTimestamp(row.entry) - getEntryTimestamp(previousRow.entry) > MESSAGE_TIME_SEPARATOR_GAP_MS
                : false;
              return (
                <AgentTranscriptRowShell
                  key={row.key}
                  onMeasure={measureConversationRow}
                  rowKey={row.key}
                  style={shouldVirtualizeTranscript && item
                    ? { transform: `translateY(${item.top}px)` }
                    : undefined}
                  virtualized={shouldVirtualizeTranscript}
                >
                  {showTimeSeparator ? (
                    <div className="agent-message-time-separator">
                      <span>{formatMessageTimeSeparator(getEntryTimestamp(row.entry), locale, t.agent.message.timeSeparatorToday)}</span>
                    </div>
                  ) : null}
                  {renderConversationRow(row)}
                </AgentTranscriptRowShell>
              );
            })}
          </div>
        )}
      </div>

      <div className="agent-composer-region">
        {isMultiAgentChannel ? (
          <AgentChannelActivityArea
            agentDefinitionById={agentDefinitionById}
            entries={channelActivityEntries}
            memberByAgentId={memberByAgentId}
            onOpenEntry={setSelectedActivityEntryId}
            onStopEntry={(entry) => {
              if (entry.runId) stopRun(entry.runId);
            }}
            selectedEntryId={selectedActivityEntryId}
          />
        ) : null}

        <AgentComposer
          currentNodeId={composerCurrentNodeId(userViewContext, index)}
          focusToken={composerFocusToken}
          index={index}
          isStreaming={dmRunActive}
          members={composerMembers}
          queueSends={isMultiAgentChannel}
          onNodeReferenceOpen={onOpenNodeReference}
          onOpenModelSettings={openComposerModelSettings}
          onCancelSteer={handleCancelSteer}
          onSend={sendMessage}
          onStop={stop}
          onSteer={handleSteerMessage}
          onResolveApproval={handleResolveApproval}
          onResolveUserQuestion={resolveUserQuestion}
          pendingApproval={pendingApproval}
          pendingUserQuestion={pendingUserQuestion}
          settings={providerSettings}
          slashCommands={slashCommands}
          steeringNote={steeringNote}
        />
      </div>
      <AgentChildRunDetailsPanel
        onClose={() => setSelectedChildRunId(null)}
        conversationId={conversationId}
        childRun={selectedChildRun}
        childRunsByParentToolCallId={childRunsByParentToolCallId}
      />
      {selectedPovInspector && selectedPovMember ? (
        <AgentPovInspectorPanel
          member={selectedPovMember}
          onClose={() => setSelectedPovAgentId(null)}
          view={selectedPovInspector}
        />
      ) : null}
      {selectedActivityEntry ? (() => {
        const { label, mention } = activityAgentLabel(selectedActivityEntry, memberByAgentId, agentDefinitionById);
        const stateLabel = activityStateLabel(selectedActivityEntry, t);
        return (
          <aside className="agent-child-run-details-panel agent-channel-run-panel" aria-label={t.agent.chat.openTypingDetails}>
            <header className="agent-child-run-details-header">
              <div className="agent-child-run-title-block">
                <div className="agent-child-run-title-line">
                  <AgentIdentityAvatar label={label} mention={mention} />
                  <span>{`${label} · ${stateLabel}`}</span>
                </div>
              </div>
              <IconButton
                className="agent-child-run-close"
                icon={CloseIcon}
                label={t.agent.chat.closeTypingDetails}
                onClick={() => setSelectedActivityEntryId(null)}
                variant="panel"
              />
            </header>
            <div className="agent-child-run-details-body">
              {selectedActivityEntry.streamingText ? (
                // The live token stream of the running Channel agent (PM-ratified
                // 2026-06-13): retained per-run from message_update and surfaced
                // ONLY here — never in the whole-utterance message flow. Tool-call
                // progress shows in the header state label, not a transcript row.
                <div className="agent-channel-run-live">
                  <AgentMarkdown
                    keyPrefix={`channel-run-live-${selectedActivityEntry.id}`}
                    streaming
                    text={selectedActivityEntry.streamingText}
                  />
                </div>
              ) : (
                <EmptyState className="agent-child-run-empty" title={t.agent.chat.typingNoDetailYet} />
              )}
            </div>
          </aside>
        );
      })() : null}
      {taskPanelOpen && !selectedChildRun ? (
        <AgentTaskPanel
          conversationId={conversationId}
          onClose={() => setTaskPanelOpen(false)}
          onOpenChildRun={(childRunId) => {
            setSelectedChildRunId(childRunId);
          }}
          tasks={tasks}
        />
      ) : null}
    </div>
  );
}
