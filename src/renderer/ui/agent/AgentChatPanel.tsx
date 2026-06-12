import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
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
import { agentMentionToken, channelAgentMembers } from '../../../core/agentChannel';
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
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  DebugIcon,
  ICON_SIZE,
  NewConversationIcon,
  PencilIcon,
  StopIcon,
  TrashIcon,
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
import { ButtonControl } from '../primitives/ButtonControl';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { IconButton } from '../primitives/IconButton';
import { TextInputControl } from '../primitives/TextInputControl';
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

function formatConversationTime(timestamp: number, locale: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function formatMessageTimeSeparator(timestamp: number, locale: string, today: (input: { time: string }) => string): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return today({ time });
  return `${date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`;
}

function agentDefinitionName(definition: AgentDefinitionView | undefined): string | null {
  if (!definition) return null;
  return definition.displayName?.trim() || definition.name.trim() || null;
}

function activeProviderModelSubtitle(settings: AgentProviderSettingsView | null): string | null {
  const activeProvider = settings ? resolveUsableActiveProvider(settings) : null;
  if (!activeProvider) return null;
  return `${activeProvider.providerId}/${activeProvider.modelId}`;
}

function conversationAgentDisplayName(
  agentId: string,
  agentDefinitionById: Map<string, AgentDefinitionView>,
  fallback?: string | null,
): string {
  return agentDefinitionName(agentDefinitionById.get(agentId)) ?? fallback ?? `@${agentMentionToken(agentId)}`;
}

function agentModelSubtitle(
  agentId: string,
  agentDefinitionById: Map<string, AgentDefinitionView>,
  activeProviderModel: string | null,
): string | null {
  const definition = agentDefinitionById.get(agentId);
  if (!definition) return activeProviderModel;
  return definition.model?.trim() || activeProviderModel;
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
  const visibleEntries = entries.slice(0, 2);
  const overflowCount = entries.length - visibleEntries.length;

  return (
    <div className="agent-channel-activity" aria-label={t.agent.chat.channelActivity}>
      <div className="agent-channel-activity-list">
        {visibleEntries.map((entry) => {
          const { label, mention } = activityAgentLabel(entry, memberByAgentId, agentDefinitionById);
          const stateLabel = activityStateLabel(entry, t);
          const canStop = entry.runId !== null;
          return (
            <div
              className={`agent-channel-activity-item-shell is-${entry.state}${selectedEntryId === entry.id ? ' is-selected' : ''}`}
              key={entry.id}
            >
              <ButtonControl
                aria-pressed={selectedEntryId === entry.id}
                className="agent-channel-activity-item"
                onClick={() => onOpenEntry(entry.id)}
                title={`${label} · ${stateLabel}`}
              >
                <AgentIdentityAvatar label={label} mention={mention} />
                <span className="agent-channel-activity-copy">
                  <span>{label}</span>
                  <small>{stateLabel}</small>
                </span>
              </ButtonControl>
              {canStop ? (
                <IconButton
                  className="agent-channel-activity-stop"
                  icon={StopIcon}
                  label={t.agent.chat.stopActivityEntry({ name: label })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onStopEntry(entry);
                  }}
                  variant="message"
                />
              ) : null}
            </div>
          );
        })}
        {overflowCount > 0 ? (
          <span className="agent-channel-activity-overflow" title={t.agent.chat.activityOverflow({ count: overflowCount })}>
            {t.agent.chat.activityOverflow({ count: overflowCount })}
          </span>
        ) : null}
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
            <div className="agent-child-run-empty agent-pov-inspector-empty">
              {t.agent.chat.povInspectorNoMemory}
            </div>
          )}
        </section>
        <section className="agent-pov-inspector-section" aria-label={t.agent.chat.povInspectorMessages}>
          <div className="agent-pov-inspector-section-title">{t.agent.chat.povInspectorMessages}</div>
          {view.messages.length === 0 ? (
            <div className="agent-child-run-empty agent-pov-inspector-empty">
              {t.agent.chat.povInspectorNoMessages}
            </div>
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
    isStreaming,
    clearSteer,
    editMessage,
    openDefaultConversation,
    pendingToolCallIds,
    regenerateMessage,
    reloadConversation,
    newConversation,
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
    activityEntries,
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
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [steeringNote, setSteeringNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<AgentConversationListMeta[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newChannelAgentIds, setNewChannelAgentIds] = useState<string[]>([]);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelSeed, setNewChannelSeed] = useState('');
  const [newChannelEscalationAgentId, setNewChannelEscalationAgentId] = useState<string | null>(null);
  const [newChannelError, setNewChannelError] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<AgentSlashCommandView[]>([]);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<{ id: string; title: string | null } | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [selectedChildRunId, setSelectedChildRunId] = useState<string | null>(null);
  const [selectedActivityEntryId, setSelectedActivityEntryId] = useState<string | null>(null);
  const [selectedPovAgentId, setSelectedPovAgentId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const newChannelMenuRef = useRef<HTMLDivElement>(null);
  const newChannelNameRef = useRef<HTMLInputElement>(null);
  const stickToBottomRef = useRef(true);
  const mountedRef = useRef(false);
  const providerSettingsRequestRef = useRef(0);
  const conversationsRequestRef = useRef(0);
  const slashCommandsRequestRef = useRef(0);
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
    ? activityEntries.find((entry) => entry.id === selectedActivityEntryId) ?? null
    : null;
  const selectedPovInspector = selectedPovAgentId ? povInspectors[selectedPovAgentId] ?? null : null;
  const selectedPovMember = selectedPovAgentId ? memberByAgentId.get(selectedPovAgentId) ?? null : null;
  // Multi-agent Channel activity drill-in: live in-flight entries are filtered
  // out of the thread, but each activity item can still open its own detail.
  const workingEntryByMessageId = useMemo(() => {
    const byId = new Map<string, AgentMessageEntry>();
    if (!isMultiAgentChannel) return byId;
    for (const entry of entries) {
      if (entry.kind !== 'message' || entry.message.role !== 'assistant' || !entry.streaming) continue;
      if (entry.nodeId) byId.set(entry.nodeId, entry);
    }
    return byId;
  }, [entries, isMultiAgentChannel]);
  const workingEntryByRunId = useMemo(() => {
    const byId = new Map<string, AgentMessageEntry>();
    if (!isMultiAgentChannel) return byId;
    for (const entry of entries) {
      if (entry.kind !== 'message' || entry.message.role !== 'assistant' || !entry.streaming || !entry.runId) continue;
      byId.set(entry.runId, entry);
    }
    return byId;
  }, [entries, isMultiAgentChannel]);
  const [memberMenuOpen, setMemberMenuOpen] = useState(false);
  const [memberMenuError, setMemberMenuError] = useState<string | null>(null);
  const [agentDefinitions, setAgentDefinitions] = useState<AgentDefinitionView[]>([]);
  const memberButtonRef = useRef<HTMLButtonElement>(null);
  const memberMenuRef = useRef<HTMLDivElement>(null);
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
  const activeProviderModel = activeProviderModelSubtitle(providerSettings);
  const dmAgentModelSubtitle = dmAgentId ? agentModelSubtitle(dmAgentId, agentDefinitionById, activeProviderModel) : null;
  const isCanonicalDmView = isCanonicalDmConversation(conversationId, activeConversationMeta);
  const directMessageRows = useMemo(
    () => conversations.filter((conversation) => conversation.canonicalDmAgentId),
    [conversations],
  );
  const coordinatorRosterAgentId = directMessageRows[0]?.canonicalDmAgentId ?? null;
  const inviteAgentRows = useMemo(
    () => directMessageRows.filter((conversation) => conversation.canonicalDmAgentId !== coordinatorRosterAgentId),
    [coordinatorRosterAgentId, directMessageRows],
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
  }, [conversationRows.length, isStreaming, revision, updateScrollMetrics, virtualLayout.totalHeight]);

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
    };
  }, [loadProviderSettings]);

  useEffect(() => {
    void loadSlashCommands();
  }, [loadSlashCommands]);

  useEffect(() => {
    if (!isStreaming) {
      setSteeringNote(null);
    }
  }, [isStreaming]);

  useEffect(() => {
    if (selectedChildRunId && !childRuns[selectedChildRunId]) setSelectedChildRunId(null);
  }, [selectedChildRunId, childRuns]);

  useEffect(() => {
    if (selectedActivityEntryId && !activityEntries.some((entry) => entry.id === selectedActivityEntryId)) {
      setSelectedActivityEntryId(null);
    }
  }, [activityEntries, selectedActivityEntryId]);

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
    if (historyOpen || newChannelOpen) void loadConversations();
  }, [historyOpen, loadConversations, newChannelOpen]);

  useEffect(() => {
    if (!newChannelOpen) return;
    window.requestAnimationFrame(() => newChannelNameRef.current?.focus());
  }, [newChannelOpen]);

  useEffect(() => {
    if (!newChannelOpen) return;
    setNewChannelAgentIds((current) => {
      const required = [newChannelEscalationAgentId].filter((id): id is string => !!id);
      const next = [...current];
      for (const agentId of required) {
        if (!next.includes(agentId)) next.unshift(agentId);
      }
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [newChannelEscalationAgentId, newChannelOpen]);

  useEffect(() => {
    if (!conversationId) {
      setAgentDefinitions([]);
      return;
    }
    let cancelled = false;
    void api.agentListAllDefinitions(conversationId)
      .then((definitions) => {
        if (!cancelled) setAgentDefinitions(definitions);
      })
      .catch(() => {
        if (!cancelled) setAgentDefinitions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    if (!historyOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && headerRef.current?.contains(target)) return;
      if (target instanceof Node && historyMenuRef.current?.contains(target)) return;
      setHistoryOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [historyOpen]);

  useEffect(() => {
    if (!newChannelOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && headerRef.current?.contains(target)) return;
      if (target instanceof Node && newChannelMenuRef.current?.contains(target)) return;
      setNewChannelOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [newChannelOpen]);

  useEffect(() => {
    if (!memberMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && headerRef.current?.contains(target)) return;
      if (target instanceof Node && memberMenuRef.current?.contains(target)) return;
      setMemberMenuOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [memberMenuOpen]);

  // The member menu lists addable agents from the shared definition registry;
  // load on open so a freshly authored agent appears without a panel remount.
  useEffect(() => {
    if (!memberMenuOpen || !conversationId) return;
    let cancelled = false;
    setMemberMenuError(null);
    void api.agentListAllDefinitions(conversationId)
      .then((definitions) => {
        if (!cancelled) setAgentDefinitions(definitions);
      })
      .catch((caught) => {
        if (!cancelled) setMemberMenuError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [memberMenuOpen, conversationId]);

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
    if (dmAgentDefinition && dmAgentDefinition.source !== 'built-in') {
      void window.lin?.openSettings?.({ agentId: dmAgentDefinition.agentId });
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
    await loadProviderSettings();
    await loadSlashCommands();
    await reloadConversation();
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

  function openNewChannelForm(options: { agentId?: string } = {}) {
    setHistoryOpen(false);
    setMemberMenuOpen(false);
    setEditingConversationId(null);
    setNewChannelAgentIds(options.agentId ? [options.agentId] : []);
    setNewChannelName('');
    setNewChannelSeed('');
    setNewChannelEscalationAgentId(options.agentId ?? null);
    setNewChannelError(null);
    setNewChannelOpen(true);
  }

  function toggleNewChannelAgent(agentId: string) {
    if (agentId === newChannelEscalationAgentId) return;
    setNewChannelAgentIds((current) => (
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId]
    ));
  }

  async function handleCreateChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newChannelName.trim();
    if (!title) {
      setNewChannelError(t.agent.chat.channelNameRequired);
      newChannelNameRef.current?.focus();
      return;
    }
    const selectedAgentIds = Array.from(new Set(newChannelAgentIds))
      .filter((agentId) => agentId !== coordinatorRosterAgentId);
    const escalationAgentName = newChannelEscalationAgentId
      ? conversationAgentDisplayName(newChannelEscalationAgentId, agentDefinitionById, dmAgentLabel)
      : null;
    try {
      setNewChannelError(null);
      await newConversation({
        ...(selectedAgentIds.length > 0 ? { agentIds: selectedAgentIds } : {}),
        title,
        seedText: newChannelSeed.trim() || undefined,
        systemNotice: escalationAgentName
          ? t.agent.chat.createdFromDmNotice({ name: escalationAgentName })
          : undefined,
      });
      setNewChannelOpen(false);
      setNewChannelEscalationAgentId(null);
      setNewChannelSeed('');
      setNewChannelName('');
      setNewChannelAgentIds([]);
      setHistoryOpen(false);
      setEditingConversationId(null);
      setMemberMenuOpen(false);
      await loadConversations();
    } catch (caught) {
      setNewChannelError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleNewConversation() {
    openNewChannelForm();
    await loadConversations();
  }

  async function handleSelectConversation(targetConversationId: string) {
    if (isStreaming || targetConversationId === conversationId) return;
    setHistoryOpen(false);
    setEditingConversationId(null);
    await selectConversation(targetConversationId);
  }

  async function handleAddMember(agentId: string) {
    if (!conversationId) return;
    try {
      setMemberMenuError(null);
      await api.agentAddConversationMember(conversationId, agentId);
      setMemberMenuOpen(false);
      await loadConversations();
    } catch (caught) {
      setMemberMenuError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function handleRemoveMember(agentId: string) {
    if (!conversationId) return;
    try {
      setMemberMenuError(null);
      await api.agentRemoveConversationMember(conversationId, agentId);
    } catch (caught) {
      setMemberMenuError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function handleInspectMemberPov(agentId: string) {
    setSelectedPovAgentId(agentId);
    setSelectedActivityEntryId(null);
    setSelectedChildRunId(null);
    setTaskPanelOpen(false);
    setMemberMenuOpen(false);
  }

  async function handleRenameConversation(targetConversationId: string) {
    const trimmed = editingTitle.trim();
    if (!trimmed) return;
    await api.agentRenameConversation(targetConversationId, trimmed);
    setEditingConversationId(null);
    await loadConversations();
  }

  function handleDeleteConversation(targetConversationId: string, title: string | null) {
    setPendingDeleteConversation({ id: targetConversationId, title });
  }

  async function confirmDeleteConversation() {
    const target = pendingDeleteConversation;
    if (!target) return;
    setPendingDeleteConversation(null);
    await api.agentDeleteConversation(target.id);
    if (target.id === conversationId) {
      await openDefaultConversation();
      setHistoryOpen(false);
    }
    await loadConversations();
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
        busy={isStreaming}
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
  const historyMenuStyle = useAnchoredOverlay(historyMenuRef, {
    anchorRef: historyButtonRef,
    disabled: !historyOpen,
    layoutKey: `${conversations.length}:${conversationsLoading ? 'loading' : 'ready'}`,
    maxHeight: 420,
    placement: 'bottom-start',
    width: 326,
  });
  const newChannelMenuStyle = useAnchoredOverlay(newChannelMenuRef, {
    anchorRef: historyButtonRef,
    disabled: !newChannelOpen,
    layoutKey: `${directMessageRows.length}:${newChannelAgentIds.join(',')}:${newChannelError ?? ''}`,
    maxHeight: 520,
    placement: 'bottom-start',
    width: 326,
  });
  const memberMenuStyle = useAnchoredOverlay(memberMenuRef, {
    anchorRef: memberButtonRef,
    disabled: !memberMenuOpen,
    layoutKey: `${agentDefinitions.length}:${members.length}:${memberMenuError ?? ''}`,
    maxHeight: 360,
    placement: 'bottom-start',
    width: 280,
  });
  const memberAgentIds = useMemo(
    () => new Set(agentMembers.flatMap((member) => member.principal.type === 'agent' ? [member.principal.agentId] : [])),
    [agentMembers],
  );
  const addableAgents = useMemo(
    () => agentDefinitions.filter((definition) => !memberAgentIds.has(definition.agentId)),
    [agentDefinitions, memberAgentIds],
  );
  const dmHeaderTitle = isCanonicalDmView ? dmAgentLabel : (conversationTitle ? displayTitle : dmAgentLabel);

  return (
    <div className="agent-chat-panel" data-turn-phase={turnPhase}>
      <header className="agent-dock-header" ref={headerRef}>
        <ButtonControl
          ref={historyButtonRef}
          aria-expanded={historyOpen}
          aria-label={t.agent.chat.showConversations}
          className="agent-dock-title-button"
          onClick={() => setHistoryOpen((open) => !open)}
          title={t.agent.chat.showConversations}
        >
          {dmAgentId && dmAgentLabel ? (
            <>
              <AgentIdentityAvatar
                label={dmAgentLabel}
                mention={dmAgentMention}
                size="md"
              />
              <span className="agent-dock-title-stack">
                <span className="agent-dock-title">{dmHeaderTitle}</span>
                <span className="agent-dock-subtitle">
                  {[dmAgentMention ? `@${dmAgentMention}` : null, dmAgentModelSubtitle].filter(Boolean).join(' · ')}
                </span>
              </span>
            </>
          ) : (
            <span className="agent-dock-title">{displayTitle}</span>
          )}
          <ChevronDownIcon
            className={historyOpen ? 'agent-title-chevron is-open' : 'agent-title-chevron'}
            size={ICON_SIZE.menu}
          />
        </ButtonControl>
        {isChannel ? (
          <ButtonControl
            ref={memberButtonRef}
            aria-expanded={memberMenuOpen}
            aria-label={t.agent.chat.members}
            className="agent-members-button"
            onClick={() => setMemberMenuOpen((open) => !open)}
            title={t.agent.chat.members}
          >
            <span className="agent-dock-member-stack">
              {agentMembers.slice(0, 4).map((member) => (
                <AgentIdentityAvatar
                  key={member.principal.type === 'agent' ? member.principal.agentId : member.mention}
                  label={member.displayName}
                  mention={member.mention}
                  size="sm"
                />
              ))}
              {agentMembers.length > 4 ? (
                <span className="agent-dock-member-overflow">{t.agent.chat.activityOverflow({ count: agentMembers.length - 4 })}</span>
              ) : null}
            </span>
            <ChevronDownIcon
              className={memberMenuOpen ? 'agent-title-chevron is-open' : 'agent-title-chevron'}
              size={ICON_SIZE.menu}
            />
          </ButtonControl>
        ) : null}
        {memberMenuOpen ? createPortal(
          <div
            ref={memberMenuRef}
            className="agent-conversation-menu agent-member-menu"
            role="dialog"
            aria-label={t.agent.chat.channelMembers}
            style={memberMenuStyle}
          >
            <div className="agent-conversation-menu-header">
              <span>{t.agent.chat.channelMembers}</span>
            </div>
            <div className="agent-conversation-list">
              {agentMembers.map((member) => {
                const agentId = member.principal.type === 'agent' ? member.principal.agentId : null;
                return (
                  <div className="agent-conversation-row agent-member-row" key={agentId ?? member.mention}>
                    <span className="agent-member-name">
                      <span>{member.displayName}</span>
                      <span className="agent-conversation-meta">{`@${member.mention}`}</span>
                    </span>
                    {agentId ? (
                      <IconButton
                        className="agent-message-action-button"
                        icon={DebugIcon}
                        label={t.agent.chat.inspectMemberPov({ name: member.displayName })}
                        onClick={() => handleInspectMemberPov(agentId)}
                        title={t.agent.chat.inspectMemberPov({ name: member.displayName })}
                        variant="message"
                      />
                    ) : null}
                    {agentId && !member.coordinator && isChannel ? (
                      <IconButton
                        className="agent-message-action-button"
                        disabled={isStreaming}
                        icon={CloseIcon}
                        label={t.agent.chat.removeMember}
                        onClick={() => void handleRemoveMember(agentId)}
                        title={isStreaming ? t.agent.chat.removeMemberWhileActive : t.agent.chat.removeMember}
                        variant="message"
                      />
                    ) : null}
                  </div>
                );
              })}
              <div className="agent-conversation-menu-header">
                <span>{t.agent.chat.addMember}</span>
              </div>
              {addableAgents.length === 0 ? (
                <div className="agent-conversation-empty">{t.agent.chat.noAddableAgents}</div>
              ) : addableAgents.map((definition) => (
                <div className="agent-conversation-row agent-member-row" key={definition.agentId}>
                  <ButtonControl
                    className="agent-conversation-select"
                    disabled={isStreaming}
                    onClick={() => void handleAddMember(definition.agentId)}
                  >
                    <span className="agent-conversation-name">{definition.displayName?.trim() || definition.name}</span>
                    <span className="agent-conversation-meta">{`@${agentMentionToken(definition.agentId)}`}</span>
                  </ButtonControl>
                </div>
              ))}
              {memberMenuError ? (
                <div className="agent-conversation-empty is-error" role="alert">{memberMenuError}</div>
              ) : null}
            </div>
          </div>,
          document.body,
        ) : null}
        <div className="agent-dock-actions">
          {dmAgentId && dmAgentLabel ? (
            <IconButton
              className="agent-menu-button"
              disabled={isStreaming}
              icon={NewConversationIcon}
              label={t.agent.chat.createChannelWithAgent({ name: dmAgentLabel })}
              onClick={() => openNewChannelForm({ agentId: dmAgentId })}
              title={t.agent.chat.createChannelWithAgent({ name: dmAgentLabel })}
              variant="composerTool"
            />
          ) : null}
          <IconButton
            className="agent-menu-button"
            disabled={isStreaming}
            icon={NewConversationIcon}
            label={t.agent.chat.newConversation}
            onClick={() => void handleNewConversation()}
            title={t.agent.chat.newConversation}
            variant="composerTool"
          />
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
                className="agent-message-action-button"
                disabled={isStreaming}
                icon={NewConversationIcon}
                label={t.agent.chat.newConversation}
                onClick={() => void handleNewConversation()}
                title={t.agent.chat.newConversation}
                variant="message"
              />
            </div>
            <div className="agent-conversation-list">
              {conversationsLoading ? (
                <div className="agent-conversation-empty">{t.common.loading}</div>
              ) : directMessageRows.length === 0 ? (
                <div className="agent-conversation-empty">{t.agent.chat.noDirectMessages}</div>
              ) : directMessageRows.map((conversation) => {
                const agentId = conversation.canonicalDmAgentId!;
                const isCurrent = conversation.id === conversationId;
                const label = conversationAgentDisplayName(
                  agentId,
                  agentDefinitionById,
                  readableConversationTitle(conversation.title, `@${agentMentionToken(agentId)}`),
                );
                const mention = agentMentionToken(agentId);
                const modelSubtitle = agentModelSubtitle(agentId, agentDefinitionById, activeProviderModel);
                const unread = isCurrent ? 0 : conversation.unreadCount ?? unreadByConversationId.get(conversation.id) ?? 0;
                return (
                  <div
                    className={isCurrent ? 'agent-conversation-row is-current' : 'agent-conversation-row'}
                    key={conversation.id}
                  >
                    <ButtonControl
                      className="agent-conversation-select agent-conversation-dm-select"
                      disabled={isStreaming}
                      onClick={() => void handleSelectConversation(conversation.id)}
                    >
                      <AgentIdentityAvatar label={label} mention={mention} size="md" />
                      <span className="agent-conversation-row-copy">
                        <span className="agent-conversation-name">{label}</span>
                        {modelSubtitle ? <span className="agent-conversation-members">{modelSubtitle}</span> : null}
                        <span className="agent-conversation-meta">
                          {conversation.lastMessageSnippet
                            ? conversation.lastMessageSnippet
                            : conversation.messageCount > 0 && conversation.lastMessageAt
                              ? formatConversationTime(conversation.lastMessageAt, locale)
                              : t.agent.chat.noMessagesYet}
                        </span>
                      </span>
                      {unread > 0 ? (
                        <span
                          className="agent-conversation-unread"
                          aria-label={t.agent.chat.unreadTasks({ count: unread })}
                          title={t.agent.chat.unreadTasks({ count: unread })}
                        >
                          {unread > 99 ? '99+' : unread}
                        </span>
                      ) : null}
                    </ButtonControl>
                  </div>
                );
              })}
            </div>
            <div className="agent-conversation-menu-header agent-conversation-section-header">
              <span>{t.agent.chat.conversations}</span>
            </div>
            <div className="agent-conversation-list">
              {conversationsLoading ? null : channelRows.length === 0 ? (
                <div className="agent-conversation-empty">{t.agent.chat.noConversations}</div>
              ) : channelRows.map((conversation) => {
                const isCurrent = conversation.id === conversationId;
                const title = readableConversationTitle(conversation.title, t.common.untitled);
                if (editingConversationId === conversation.id) {
                  return (
                    <div className="agent-conversation-row is-editing" key={conversation.id}>
                      <TextInputControl
                        autoFocus
                        className="agent-conversation-title-input"
                        label={t.agent.chat.conversationTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setEditingConversationId(null);
                          if (event.key === 'Enter') void handleRenameConversation(conversation.id);
                        }}
                        value={editingTitle}
                      />
                      <IconButton
                        className="agent-message-action-button"
                        icon={CloseIcon}
                        label={t.agent.chat.cancelRename}
                        onClick={() => setEditingConversationId(null)}
                        variant="message"
                      />
                      <IconButton
                        className="agent-message-action-button"
                        icon={CheckIcon}
                        label={t.agent.chat.saveRename}
                        onClick={() => void handleRenameConversation(conversation.id)}
                        variant="message"
                      />
                    </div>
                  );
                }
                return (
                  <div
                    className={isCurrent ? 'agent-conversation-row is-current' : 'agent-conversation-row'}
                    key={conversation.id}
                  >
                    <ButtonControl
                      className="agent-conversation-select"
                      disabled={isStreaming}
                      onClick={() => void handleSelectConversation(conversation.id)}
                    >
                      <span className="agent-conversation-name">{title}</span>
                      <span className="agent-conversation-members agent-conversation-channel-members">
                        {channelAgentMembers(conversation.members).slice(0, 4).map((member) => {
                          const label = conversationAgentDisplayName(member.agentId, agentDefinitionById);
                          return (
                            <AgentIdentityAvatar
                              key={member.agentId}
                              label={label}
                              mention={agentMentionToken(member.agentId)}
                              size="sm"
                            />
                          );
                        })}
                      </span>
                      <span className="agent-conversation-meta">
                        {formatConversationTime(conversation.updatedAt, locale)}
                        {conversation.messageCount > 0 ? ` · ${conversation.messageCount}` : ''}
                      </span>
                      {(() => {
                        const unread = isCurrent ? 0 : unreadByConversationId.get(conversation.id) ?? 0;
                        if (unread <= 0) return null;
                        return (
                          <span
                            className="agent-conversation-unread"
                            // The visible glyph caps at "99+" for width; the accessible
                            // name + tooltip carry the exact count (more useful to AT and
                            // disambiguates "99+" on hover).
                            aria-label={t.agent.chat.unreadTasks({ count: unread })}
                            title={t.agent.chat.unreadTasks({ count: unread })}
                          >
                            {unread > 99 ? '99+' : unread}
                          </span>
                        );
                      })()}
                    </ButtonControl>
                    <div className="agent-conversation-row-actions">
                      <IconButton
                        className="agent-message-action-button"
                        disabled={isStreaming}
                        icon={PencilIcon}
                        label={t.agent.chat.renameConversation}
                        onClick={() => {
                          setEditingConversationId(conversation.id);
                          setEditingTitle(title);
                        }}
                        title={t.agent.chat.rename}
                        variant="message"
                      />
                      <IconButton
                        className="agent-message-action-button"
                        disabled={isStreaming}
                        icon={TrashIcon}
                        label={t.agent.chat.deleteConversation}
                        onClick={() => void handleDeleteConversation(conversation.id, conversation.title)}
                        title={t.agent.chat.delete}
                        variant="message"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        ) : null}
        {newChannelOpen ? createPortal(
          <div
            ref={newChannelMenuRef}
            className="agent-conversation-menu agent-new-channel-menu"
            role="dialog"
            aria-label={t.agent.chat.newConversation}
            style={newChannelMenuStyle}
          >
            <form className="agent-new-channel-form" onSubmit={(event) => void handleCreateChannel(event)}>
              <div className="agent-conversation-menu-header">
                <span>{t.agent.chat.newConversation}</span>
                <IconButton
                  className="agent-message-action-button"
                  icon={CloseIcon}
                  label={t.agent.chat.cancel}
                  onClick={() => setNewChannelOpen(false)}
                  variant="message"
                />
              </div>
              <div className="agent-new-channel-body">
                <div className="agent-new-channel-field">
                  <label className="agent-new-channel-label" htmlFor="agent-new-channel-name">
                    {t.agent.chat.channelName}
                  </label>
                  <TextInputControl
                    ref={newChannelNameRef}
                    className="agent-new-channel-input"
                    id="agent-new-channel-name"
                    label={t.agent.chat.channelName}
                    onChange={(event) => setNewChannelName(event.target.value)}
                    placeholder={t.agent.chat.channelNamePlaceholder}
                    required
                    value={newChannelName}
                  />
                </div>
                <div className="agent-new-channel-field">
                  <div className="agent-new-channel-label">{t.agent.chat.channelAgents}</div>
                  <div className="agent-new-channel-roster">
                    {inviteAgentRows.length === 0 ? (
                      <div className="agent-conversation-empty">{t.agent.chat.noAddableAgents}</div>
                    ) : inviteAgentRows.map((conversation) => {
                      const agentId = conversation.canonicalDmAgentId!;
                      const label = conversationAgentDisplayName(
                        agentId,
                        agentDefinitionById,
                        readableConversationTitle(conversation.title, `@${agentMentionToken(agentId)}`),
                      );
                      const mention = agentMentionToken(agentId);
                      const checked = newChannelAgentIds.includes(agentId);
                      const locked = agentId === newChannelEscalationAgentId;
                      return (
                        <label className="agent-new-channel-agent" key={agentId}>
                          <input
                            checked={checked}
                            disabled={locked}
                            onChange={() => toggleNewChannelAgent(agentId)}
                            type="checkbox"
                          />
                          <AgentIdentityAvatar label={label} mention={mention} size="sm" />
                          <span className="agent-new-channel-agent-copy">
                            <span>{label}</span>
                            <small>{`@${mention}`}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="agent-new-channel-field">
                  <label className="agent-new-channel-label" htmlFor="agent-new-channel-seed">
                    {t.agent.chat.channelSeed}
                  </label>
                  <textarea
                    className="agent-new-channel-seed"
                    id="agent-new-channel-seed"
                    onChange={(event) => setNewChannelSeed(event.target.value)}
                    placeholder={t.agent.chat.channelSeedPlaceholder}
                    rows={3}
                    value={newChannelSeed}
                  />
                </div>
                {newChannelError ? (
                  <div className="agent-conversation-empty is-error" role="alert">{newChannelError}</div>
                ) : null}
              </div>
              <div className="agent-new-channel-actions">
                <ButtonControl className="agent-new-channel-cancel" onClick={() => setNewChannelOpen(false)}>
                  {t.agent.chat.cancel}
                </ButtonControl>
                <ButtonControl
                  className="agent-new-channel-submit"
                  disabled={!newChannelName.trim() || isStreaming}
                  type="submit"
                >
                  {t.agent.chat.createChannel}
                </ButtonControl>
              </div>
            </form>
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
            {!settingsLoaded || hasUsableProvider ? null : (
              <div className="agent-onboarding" role="status">
                <p className="agent-onboarding-text">{t.agent.chat.onboardingText}</p>
                <ButtonControl
                  className="agent-onboarding-cta"
                  onClick={() => {
                    void window.lin?.openSettings();
                  }}
                >
                  {t.agent.chat.onboardingCta}
                </ButtonControl>
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

      {isMultiAgentChannel ? (
        <AgentChannelActivityArea
          agentDefinitionById={agentDefinitionById}
          entries={activityEntries}
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
        isStreaming={isStreaming}
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
        const selectedWorkingEntry = selectedActivityEntry.messageId
          ? workingEntryByMessageId.get(selectedActivityEntry.messageId) ?? null
          : selectedActivityEntry.runId
            ? workingEntryByRunId.get(selectedActivityEntry.runId) ?? null
            : null;
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
              {selectedWorkingEntry ? (
                <AgentMessageRow
                  busy={isStreaming}
                  entry={selectedWorkingEntry}
                  index={index}
                  onNodeReferenceOpen={onOpenNodeReference}
                  onOpenChildRunTranscript={setSelectedChildRunId}
                  pendingToolCallIds={pendingToolCallIds}
                  conversationId={conversationId}
                  streaming
                  childRunsByParentToolCallId={childRunsByParentToolCallId}
                  toolResults={toolResults}
                  turnPhase={turnPhase}
                />
              ) : (
                <div className="agent-child-run-empty">
                  {t.agent.chat.typingNoDetailYet}
                </div>
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
      {pendingDeleteConversation ? (
        <ConfirmDialog
          title={t.agent.chat.deleteConfirmTitle}
          message={t.agent.chat.deleteConfirmMessage({ title: readableConversationTitle(pendingDeleteConversation.title, t.common.untitled) })}
          confirmLabel={t.agent.chat.delete}
          cancelLabel={t.agent.chat.cancel}
          danger
          onConfirm={() => void confirmDeleteConversation()}
          onCancel={() => setPendingDeleteConversation(null)}
        />
      ) : null}
    </div>
  );
}
