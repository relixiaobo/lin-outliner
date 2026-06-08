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
import type {
  AgentProviderSettingsView,
  AgentReasoningLevel,
  AgentConversationListMeta,
  AgentSlashCommandView,
  NodeId,
} from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { useLinAgentRuntime } from '../../agent/runtime';
import { onAgentRevealRequest } from '../../agent/agentReveal';
import type {
  AgentConversationEntry,
  AgentMessageEntry,
  AgentTurnPhase,
} from '../../agent/runtime';
import {
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
import { AgentSubagentBoundary } from './AgentSubagentBoundary';
import { AgentComposer } from './AgentComposer';
import type { AgentComposerNodeReference } from './AgentComposerEditor';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentMessageRow } from './AgentMessageRow';
import { AgentSubagentDetailsPanel } from './AgentSubagentDetailsPanel';
import { AgentTaskPanel } from './AgentTaskPanel';
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

interface AgentChatPanelProps {
  index: DocumentIndex;
  userViewContext: AgentUserViewContext;
  onOpenNodeReference: AgentNodeReferenceOpenHandler;
  onOpenDebugPanel?: (conversationId: string | null) => void;
}

function shouldStickToBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 56;
}

function getSupportedReasoningLevels(
  settings: AgentProviderSettingsView,
  providerId: string,
  modelId: string,
): AgentReasoningLevel[] {
  const catalog = settings.availableProviders.find((provider) => provider.providerId === providerId);
  const model = catalog?.models.find((candidate) => candidate.id === modelId);
  return model?.supportedThinkingLevels.length ? model.supportedThinkingLevels : ['off'];
}

function coerceReasoningLevel(
  reasoningLevel: AgentReasoningLevel,
  supportedLevels: AgentReasoningLevel[],
): AgentReasoningLevel {
  if (supportedLevels.includes(reasoningLevel)) return reasoningLevel;
  if (supportedLevels.includes('off')) return 'off';
  return supportedLevels[0] ?? 'off';
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
  return entry.kind === 'compaction' || entry.kind === 'dream' || entry.kind === 'subagent';
}

function getEntryRole(entry: AgentConversationEntry): 'user' | 'assistant' | 'system' {
  return isBoundaryEntry(entry) ? 'system' : (entry as AgentMessageEntry).message.role;
}

function getEntryTimestamp(entry: AgentConversationEntry): number {
  if (entry.kind === 'dream') return entry.status === 'active' ? entry.dream.startedAt : entry.dream.createdAt;
  if (entry.kind === 'subagent') return entry.subagent.startedAt;
  if (entry.kind !== 'compaction') return entry.message.timestamp;
  return entry.status === 'active' ? entry.compaction.startedAt : entry.compaction.createdAt;
}

function isAssistantEntry(entry: AgentConversationEntry): entry is AssistantEntry {
  return entry.kind === 'message' && entry.message.role === 'assistant';
}

function isTurnBoundaryEntry(entry: AgentConversationEntry): boolean {
  return isBoundaryEntry(entry) || (entry as AgentMessageEntry).message.role === 'user';
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
    steer: steerRuntime,
    subagents,
    subagentsByParentToolCallId,
    switchBranch,
    stop,
    tasks,
    toolResults,
    turnPhase,
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
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
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
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState({ height: 0, top: 0 });
  const conversationRows = useMemo(
    () => buildConversationRenderRows(entries, turnPhase),
    [entries, turnPhase],
  );
  const runningTaskCount = useMemo(() => tasks.filter((task) => task.status === 'running').length, [tasks]);
  const selectedSubagent = selectedSubagentId ? subagents[selectedSubagentId] ?? null : null;
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
    if (selectedSubagentId && !subagents[selectedSubagentId]) setSelectedSubagentId(null);
  }, [selectedSubagentId, subagents]);

  // A command Run reveals its delivery conversation and asks for the task panel —
  // the run is a parentless subagent, so it surfaces there (the open task panel
  // persists across the conversation switch this same reveal triggers).
  useEffect(() => onAgentRevealRequest((_conversationId, options) => {
    if (!options.openTasks) return;
    setSelectedSubagentId(null);
    setTaskPanelOpen(true);
  }), []);

  useEffect(() => {
    if (historyOpen) void loadConversations();
  }, [historyOpen, loadConversations]);

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

  async function updateProviderConfig(
    providerId: string,
    patch: { modelId?: string; reasoningLevel?: AgentReasoningLevel },
  ) {
    if (!providerSettings) return;
    const provider = providerSettings.providers.find((candidate) => candidate.providerId === providerId);
    const catalog = providerSettings.availableProviders.find((candidate) => candidate.providerId === providerId);
    const modelId = patch.modelId ?? provider?.modelId ?? catalog?.models[0]?.id;
    if (!modelId) return;
    const supportedLevels = getSupportedReasoningLevels(providerSettings, providerId, modelId);
    const reasoningLevel = coerceReasoningLevel(
      patch.reasoningLevel ?? provider?.reasoningLevel ?? 'off',
      supportedLevels,
    );
    const requestId = providerSettingsRequestRef.current + 1;
    providerSettingsRequestRef.current = requestId;
    try {
      setSettingsError(null);
      await api.agentUpsertProviderConfig({
        providerId,
        modelId,
        reasoningLevel,
        baseUrl: provider?.baseUrl ?? null,
        enabled: provider?.enabled ?? true,
      });
      const next = await api.agentSetActiveProvider(providerId);
      if (mountedRef.current && requestId === providerSettingsRequestRef.current) {
        setProviderSettings(next);
      }
      await reloadConversation();
    } catch (caught) {
      if (mountedRef.current && requestId === providerSettingsRequestRef.current) {
        setSettingsError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  async function updateActiveProviderConfig(patch: { modelId?: string; reasoningLevel?: AgentReasoningLevel }) {
    if (!providerSettings) return;
    const activeProvider = resolveUsableActiveProvider(providerSettings);
    const providerId = activeProvider?.providerId ?? providerSettings.availableProviders[0]?.providerId;
    if (!providerId) return;
    await updateProviderConfig(providerId, patch);
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
    if (row.entry.kind === 'subagent') {
      return <AgentSubagentBoundary entry={row.entry} onOpenTranscript={setSelectedSubagentId} />;
    }

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
        busy={isStreaming}
        contentKey={row.contentKey}
        entry={row.entry}
        index={index}
        isLastInTurn={row.isLastInTurn}
        onCopy={copyAssistantTurn}
        onEdit={editMessage}
        onNodeReferenceOpen={onOpenNodeReference}
        onOpenSubagentTranscript={setSelectedSubagentId}
        onRegenerate={regenerateMessage}
        onRetry={retryMessage}
        onSwitchBranch={switchBranch}
        pendingToolCallIds={pendingToolCallIds}
        conversationId={conversationId}
        streaming={row.streaming}
        subagentsByParentToolCallId={subagentsByParentToolCallId}
        toolResults={toolResults}
        turnEnded={row.turnEnded}
        turnPhase={row.turnPhase}
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
          <span className="agent-dock-title">{displayTitle}</span>
          <ChevronDownIcon
            className={historyOpen ? 'agent-title-chevron is-open' : 'agent-title-chevron'}
            size={ICON_SIZE.menu}
          />
        </ButtonControl>
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
            aria-expanded={taskPanelOpen && !selectedSubagent}
            aria-label={runningTaskCount > 0
              ? t.agent.task.openPanelActive({ count: runningTaskCount })
              : t.agent.task.openPanel}
            className="agent-task-panel-button"
            onClick={() => {
              setSelectedSubagentId(null);
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
                      <span className="agent-conversation-meta">
                        {formatConversationTime(conversation.updatedAt, locale)}
                        {conversation.messageCount > 0 ? ` · ${conversation.messageCount}` : ''}
                      </span>
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
                  {renderConversationRow(row)}
                </AgentTranscriptRowShell>
              );
            })}
          </div>
        )}
      </div>

      <AgentComposer
        currentNodeId={composerCurrentNodeId(userViewContext, index)}
        index={index}
        isStreaming={isStreaming}
        onNodeReferenceOpen={onOpenNodeReference}
        onModelChange={(providerId, modelId) => updateProviderConfig(providerId, { modelId })}
        onReasoningChange={(reasoningLevel) => updateActiveProviderConfig({ reasoningLevel })}
        onCancelSteer={handleCancelSteer}
        onSend={sendMessage}
        onStop={stop}
        onSteer={handleSteerMessage}
        onResolveApproval={resolveApproval}
        onResolveUserQuestion={resolveUserQuestion}
        pendingApproval={pendingApproval}
        pendingUserQuestion={pendingUserQuestion}
        settings={providerSettings}
        slashCommands={slashCommands}
        steeringNote={steeringNote}
      />
      <AgentSubagentDetailsPanel
        onClose={() => setSelectedSubagentId(null)}
        conversationId={conversationId}
        subagent={selectedSubagent}
        subagentsByParentToolCallId={subagentsByParentToolCallId}
      />
      {taskPanelOpen && !selectedSubagent ? (
        <AgentTaskPanel
          conversationId={conversationId}
          onClose={() => setTaskPanelOpen(false)}
          onOpenSubagent={(subagentId) => {
            setSelectedSubagentId(subagentId);
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
