import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
import type { AgentRenderMemberView } from '../../../core/agentRenderProjection';
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
  AgentIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  DebugIcon,
  ICON_SIZE,
  NewConversationIcon,
  PencilIcon,
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
  return leftAgentId === null || rightAgentId === null || leftAgentId === rightAgentId;
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
    activeRunAgentId,
    queuedMessages,
    steer: steerRuntime,
    childRuns,
    childRunsByParentToolCallId,
    switchBranch,
    stop,
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
  const [slashCommands, setSlashCommands] = useState<AgentSlashCommandView[]>([]);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<{ id: string; title: string | null } | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [selectedChildRunId, setSelectedChildRunId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const mountedRef = useRef(false);
  const providerSettingsRequestRef = useRef(0);
  const conversationsRequestRef = useRef(0);
  const slashCommandsRequestRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
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
  // ≥2 agent members = a Channel: member strip + `@` typeahead + queue-send
  // composer + the IM delivery model (typing indicator, utterance-only thread).
  const agentMembers = useMemo(
    () => members.filter((member) => member.principal.type === 'agent' && member.mention),
    [members],
  );
  const isChannel = agentMembers.length >= 2;
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
    () => (isChannel
      ? agentMembers.map((member) => ({
          mention: member.mention,
          displayName: member.displayName,
          ...(member.coordinator ? { coordinator: true } : {}),
        }))
      : []),
    [agentMembers, isChannel],
  );
  // Channel thread = utterances only (ratified IM model): in-flight assistant
  // entries never render in the thread — the typing indicator carries the run,
  // and the message appears whole on completion. DMs keep the streaming tail.
  const threadEntries = useMemo(
    () => (isChannel
      ? entries.filter((entry) => !(entry.kind === 'message' && entry.message.role === 'assistant' && entry.streaming))
      : entries),
    [entries, isChannel],
  );
  const conversationRows = useMemo(
    () => buildConversationRenderRows(threadEntries, isChannel ? 'idle' : turnPhase),
    [threadEntries, isChannel, turnPhase],
  );
  const runningTaskCount = useMemo(() => tasks.filter((task) => task.status === 'running').length, [tasks]);
  const selectedChildRun = selectedChildRunId ? childRuns[selectedChildRunId] ?? null : null;
  // Channel typing indicator: who is replying right now, and its live in-flight
  // entry (the one filtered OUT of the thread) for the working-state drill-in.
  const typingAgentId = isChannel && isStreaming ? activeRunAgentId : null;
  const typingMember = typingAgentId ? memberByAgentId.get(typingAgentId) : undefined;
  const typingLabel = typingAgentId
    ? typingMember?.displayName ?? `@${agentMentionToken(typingAgentId)}`
    : null;
  const typingEntry = useMemo(() => {
    if (!isChannel) return null;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.kind === 'message' && entry.message.role === 'assistant' && entry.streaming) return entry;
    }
    return null;
  }, [entries, isChannel]);
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  useEffect(() => {
    if (!typingAgentId) setRunPanelOpen(false);
  }, [typingAgentId]);
  // Member management entry (A8: the user-reachable way to create a Channel —
  // adding an agent to the DM spawns a seeded Channel and switches to it).
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

  async function handleNewConversation() {
    setHistoryOpen(false);
    setEditingConversationId(null);
    await newConversation();
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
      const result = await api.agentAddConversationMember(conversationId, agentId);
      setMemberMenuOpen(false);
      // Adding to the DM spawns a seeded Channel (ratified) — follow the user there.
      if (result.conversationId !== conversationId) {
        await selectConversation(result.conversationId);
      }
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
        actorId={speakerAgentId}
        actorLabel={actorLabel}
        actorMention={actorMention}
        busy={isStreaming}
        contentKey={row.contentKey}
        entry={displayEntry}
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
        speakerId={detailSpeakerAgentId ?? (row.entry.message.role === 'user' ? 'user' : undefined)}
        speakerLabel={detailSpeakerLabel}
        speakerMention={detailSpeakerMention}
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
                id={dmAgentId}
                label={dmAgentLabel}
                mention={dmAgentMention}
                size="md"
              />
              <span className="agent-dock-title-stack">
                <span className="agent-dock-title">{conversationTitle ? displayTitle : dmAgentLabel}</span>
                <span className="agent-dock-subtitle">
                  {[dmAgentMention ? `@${dmAgentMention}` : null, activeProviderModel].filter(Boolean).join(' · ')}
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
          <span
            aria-label={t.agent.chat.channelMembers}
            className="agent-dock-members"
            title={agentMembers.map((member) => member.displayName).join(', ')}
          >
            {agentMembers.map((member) => (
              <span
                className={member.coordinator ? 'agent-dock-member is-coordinator' : 'agent-dock-member'}
                key={member.principal.type === 'agent' ? member.principal.agentId : member.mention}
              >
                {`@${member.mention}`}
              </span>
            ))}
          </span>
        ) : null}
        <ButtonControl
          ref={memberButtonRef}
          aria-expanded={memberMenuOpen}
          aria-label={t.agent.chat.addMember}
          className="agent-member-add-button"
          onClick={() => setMemberMenuOpen((open) => !open)}
          title={t.agent.chat.addMember}
        >
          <AddIcon size={ICON_SIZE.menu} />
        </ButtonControl>
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
                    {agentId && !member.coordinator && isChannel ? (
                      <IconButton
                        className="agent-message-action-button"
                        disabled={isStreaming}
                        icon={CloseIcon}
                        label={t.agent.chat.removeMember}
                        onClick={() => void handleRemoveMember(agentId)}
                        title={t.agent.chat.removeMember}
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
              <span>{t.agent.chat.conversations}</span>
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
              ) : conversations.length === 0 ? (
                <div className="agent-conversation-empty">{t.agent.chat.noConversations}</div>
              ) : conversations.map((conversation) => {
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
                      {(() => {
                        const listAgentMembers = channelAgentMembers(conversation.members);
                        if (listAgentMembers.length < 2) return null;
                        return (
                          <span className="agent-conversation-members">
                            {listAgentMembers.map((member) => `@${agentMentionToken(member.agentId)}`).join(' ')}
                          </span>
                        );
                      })()}
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
        {queuedMessages.map((queuedText, queuedIndex) => (
          // Sent while a round is active: not yet in the event log (the round
          // loop persists it when it routes it) — shown here so the user's
          // message never disappears between send and routing.
          <div className="agent-message-row user agent-channel-queued" key={`queued:${queuedIndex}`}>
            <div className="agent-user-content-shell">
              <div className="agent-user-bubble">{queuedText}</div>
            </div>
          </div>
        ))}
        {typingLabel ? (
          <ButtonControl
            aria-expanded={runPanelOpen}
            className="agent-channel-typing"
            onClick={() => setRunPanelOpen((open) => !open)}
            title={t.agent.chat.openTypingDetails}
          >
            <span className="agent-channel-typing-dots" aria-hidden>
              <span /><span /><span />
            </span>
            <span>{t.agent.chat.memberTyping({ name: typingLabel })}</span>
          </ButtonControl>
        ) : null}
      </div>

      <AgentComposer
        currentNodeId={composerCurrentNodeId(userViewContext, index)}
        focusToken={composerFocusToken}
        index={index}
        isStreaming={isStreaming}
        members={composerMembers}
        queueSends={isChannel}
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
      {runPanelOpen && typingLabel ? (
        <aside className="agent-child-run-details-panel agent-channel-run-panel" aria-label={t.agent.chat.openTypingDetails}>
          <header className="agent-child-run-details-header">
            <div className="agent-child-run-title-block">
              <div className="agent-child-run-title-line">
                <AgentIcon size={ICON_SIZE.menu} />
                <span>{t.agent.chat.memberTyping({ name: typingLabel })}</span>
              </div>
            </div>
            <IconButton
              className="agent-child-run-close"
              icon={CloseIcon}
              label={t.agent.chat.closeTypingDetails}
              onClick={() => setRunPanelOpen(false)}
              variant="panel"
            />
          </header>
          <div className="agent-child-run-details-body">
            {typingEntry ? (
              <AgentMessageRow
                busy={isStreaming}
                entry={typingEntry}
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
              <div className="agent-child-run-empty">{t.agent.chat.typingNoDetailYet}</div>
            )}
          </div>
        </aside>
      ) : null}
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
