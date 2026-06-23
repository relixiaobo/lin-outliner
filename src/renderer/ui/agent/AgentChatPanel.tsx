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
} from '../../../core/agentTypes';
import { nodeReferenceMarkersToText } from '../../../core/referenceMarkup';
import { DEFAULT_GENERAL_CHANNEL_ID, agentMentionToken } from '../../../core/agentChannel';
import type {
  AgentRenderMemberView,
} from '../../../core/agentRenderProjection';
import type {
  AgentAuthoringInput,
  AgentDefinitionView,
  AgentApprovalResolutionScope,
  AgentProviderSettingsView,
  AgentConversationListMeta,
  AgentSlashCommandView,
  NodeId,
} from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { builtInDefinitionToAuthoringInput } from './agentProfileInput';
import { linAgentRuntimeStore, useLinAgentRuntime } from '../../agent/runtime';
import { onAgentRevealRequest, type AgentChatSourceRevealTarget } from '../../agent/agentReveal';
import type {
  AgentConversationEntry,
  AgentMessageEntry,
} from '../../agent/runtime';
import {
  AddIcon,
  ChevronDownIcon,
  DebugIcon,
  HashIcon,
  ICON_SIZE,
  LoaderIcon,
  MoreIcon,
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
import {
  buildConversationRenderRows,
  getEntryRole,
  getEntryTimestamp,
  isBoundaryEntry,
  isTurnBoundaryEntry,
} from './agentConversationRows';
import type { AgentConversationRenderRow } from './agentConversationRows';
import { AgentChildRunDetailsPanel } from './AgentChildRunDetailsPanel';
import { AgentTaskPanel } from './AgentTaskPanel';
import { AgentDockFilePreview } from './AgentDockFilePreview';
import { onAgentDockFilePreview, type AgentDockFilePreviewDetail } from './agentDockFilePreviewEvents';
import { composerCurrentNodeId } from './userViewContext';
import { resolveUsableActiveProvider } from './providerCatalog';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { EmptyState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { AnchoredActionMenu } from '../primitives/AnchoredActionMenu';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
import { useI18n, useT } from '../../i18n/I18nProvider';

const TRANSCRIPT_ROW_GAP_PX = 14;
const TRANSCRIPT_ROW_ESTIMATE_PX = 104;
const TRANSCRIPT_VIRTUAL_MIN_ROWS = 40;
const TRANSCRIPT_VIRTUAL_OVERSCAN_PX = 720;
const TRANSCRIPT_JUMP_HIGHLIGHT_MS = 2_200;
const MESSAGE_TIME_SEPARATOR_GAP_MS = 60 * 60 * 1000;

interface AgentChatPanelProps {
  index: DocumentIndex;
  /** Whether the agent dock is open (not the CSS-collapsed seed). */
  dockOpen: boolean;
  userViewContext: AgentUserViewContext;
  onOpenNodeReference: AgentNodeReferenceOpenHandler;
  onOpenDebugPanel?: (conversationId: string | null) => void;
}

interface PendingTranscriptReveal {
  conversationId: string;
  target: AgentChatSourceRevealTarget;
}

function shouldStickToBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 56;
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
        <AnchoredActionMenu
          actions={actions}
          anchorRef={anchorRef}
          ariaLabel={menuLabel}
          className="agent-conversation-row-menu"
          itemClassName="agent-conversation-row-menu-item"
          itemLabelClassName="agent-conversation-row-menu-item-label"
          onClose={() => onOpenChange(false)}
          // The history menu's outside-pointer handler ignores clicks inside this menu.
          surfaceProps={{ 'data-agent-conversation-row-menu': 'true' }}
          width={196}
        />
      ) : null}
    </>
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

function systemLineText(entry: AgentMessageEntry): string | null {
  if (entry.actor?.type !== 'system') return null;
  const text = textFromConversationEntry(entry).trim();
  return text || null;
}

interface VirtualTranscriptItem {
  top: number;
  height: number;
}

interface VirtualTranscriptLayout {
  items: VirtualTranscriptItem[];
  totalHeight: number;
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

function seqInChatSourceRange(seq: number | undefined, target: AgentChatSourceRevealTarget): boolean {
  return typeof seq === 'number'
    && Number.isSafeInteger(seq)
    && seq > target.range.fromSeqExclusive
    && seq <= target.range.throughSeq;
}

function conversationRowMatchesChatSource(row: AgentConversationRenderRow, target: AgentChatSourceRevealTarget): boolean {
  if (target.stream === 'run') return row.entry.kind === 'child-run' && row.entry.childRun.id === target.streamId;
  return row.entry.kind === 'message' && row.sourceSeqs.some((seq) => seqInChatSourceRange(seq, target));
}

function transcriptRowSelector(rowKey: string): string {
  return `[data-agent-transcript-row="${CSS.escape(rowKey)}"]`;
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
  highlighted,
  onMeasure,
  rowKey,
  style,
  virtualized,
}: {
  children: ReactNode;
  highlighted?: boolean;
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
      className={`${virtualized ? 'agent-chat-virtual-row' : 'agent-chat-flow-row'}${highlighted ? ' is-highlighted' : ''}`}
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
    runActive,
    modelApi,
    modelId,
    providerId,
    clearSteer,
    editMessage,
    pendingToolCallIds,
    regenerateMessage,
    reloadConversation,
    revision,
    pendingApproval,
    pendingUserQuestion,
    retryMessage,
    resolveApproval,
    resolveUserQuestion,
    selectConversation,
    sendMessage: sendRuntimeMessage,
    conversationId,
    conversationTitle,
    members,
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
  // A run in flight gates transcript rewrites (edit/regenerate/retry/branch),
  // which stay blocked while the log moves.
  const anyRunActive = runActive;
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
  const [filePreview, setFilePreview] = useState<AgentDockFilePreviewDetail | null>(null);
  const [pendingTranscriptReveal, setPendingTranscriptReveal] = useState<PendingTranscriptReveal | null>(null);
  const [highlightedTranscriptRowKey, setHighlightedTranscriptRowKey] = useState<string | null>(null);
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
  const bottomScrollFrameRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const rowHeightsRef = useRef(new Map<string, number>());
  const copyPayloadTextCacheRef = useRef<PayloadTextPromiseCache>(new Map());
  const copyAssistantTurnSourceRef = useRef({ entries, toolResults, conversationId });
  const copyAssistantTurnCallbacksRef = useRef(new Map<string, {
    endIndex: number;
    handler: () => Promise<void>;
  }>());
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
  useEffect(() => onAgentDockFilePreview((detail) => {
    setHistoryOpen(false);
    setRowActionMenu(null);
    setTaskPanelOpen(false);
    setSelectedChildRunId(null);
    setFilePreview(detail);
  }), []);
  useEffect(() => {
    setFilePreview(null);
  }, [conversationId]);
  const agentMembers = useMemo(
    () => members.filter((member) => member.principal.type === 'agent' && member.mention),
    [members],
  );
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
  const conversationRows = useMemo(
    () => buildConversationRenderRows(entries, turnPhase),
    [entries, turnPhase],
  );
  const runningTaskCount = useMemo(() => tasks.filter((task) => task.status === 'running').length, [tasks]);
  const selectedChildRun = selectedChildRunId ? childRuns[selectedChildRunId] ?? null : null;
  const [agentDefinitions, setAgentDefinitions] = useState<AgentDefinitionView[]>([]);
  const agentDefinitionById = useMemo(() => {
    const map = new Map<string, AgentDefinitionView>();
    for (const definition of agentDefinitions) map.set(definition.agentId, definition);
    return map;
  }, [agentDefinitions]);
  // The single editable agent (Neva). The composer's quick model/effort chip writes
  // to her standing profile. Kept in a ref so two quick edits in a row (model then
  // effort) both build on the latest definition, not a stale render.
  const builtInDefinition = useMemo(
    () => agentDefinitions.find((definition) => definition.source === 'built-in') ?? null,
    [agentDefinitions],
  );
  const builtInDefinitionRef = useRef<AgentDefinitionView | null>(null);
  builtInDefinitionRef.current = builtInDefinition;
  // Serialize writes: a model switch fires an effort reconciliation + a model change
  // back-to-back, so each `build` must run against the result of the previous write,
  // not the same stale ref (two concurrent IPCs would race, last-writer-wins dropping
  // one of the edits). Chaining off a ref-held promise makes each build read the
  // freshly-persisted definition.
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistBuiltInModelEffort = useCallback(
    (build: (input: AgentAuthoringInput) => AgentAuthoringInput): Promise<void> => {
      const run = async () => {
        const definition = builtInDefinitionRef.current;
        if (!definition || !conversationId) return;
        const input = build(builtInDefinitionToAuthoringInput(definition));
        try {
          const views = await api.agentUpdateAgentDefinition(conversationId, definition.agentId, input);
          if (!mountedRef.current) return;
          setAgentDefinitions(views);
          builtInDefinitionRef.current = views.find((view) => view.source === 'built-in') ?? null;
        } catch {
          // The chip is a convenience; a failed write leaves the prior selection in place.
        }
      };
      const next = persistQueueRef.current.then(run, run);
      persistQueueRef.current = next;
      return next;
    },
    [conversationId],
  );
  const handleAgentModelChange = useCallback(
    (model: string) => void persistBuiltInModelEffort((input) => ({ ...input, model: model.trim() || undefined })),
    [persistBuiltInModelEffort],
  );
  const handleAgentEffortChange = useCallback(
    (effort: string) => void persistBuiltInModelEffort((input) => ({ ...input, effort: effort.trim() || undefined })),
    [persistBuiltInModelEffort],
  );
  const dmAgentMember = agentMembers.length === 1 ? agentMembers[0]! : null;
  const dmAgentId = dmAgentMember?.principal.type === 'agent' ? dmAgentMember.principal.agentId : null;
  const dmAgentDefinition = dmAgentId ? agentDefinitionById.get(dmAgentId) : undefined;
  const dmAgentLabel = dmAgentId
    ? agentDefinitionName(dmAgentDefinition) ?? dmAgentMember?.displayName ?? `@${agentMentionToken(dmAgentId)}`
    : null;
  // Single-agent collapse: one conversation primitive (channels), General first.
  const channelRows = useMemo(
    () => [...conversations]
      .sort((left, right) => (
        (left.id === DEFAULT_GENERAL_CHANNEL_ID ? -1 : 0)
        || (right.id === DEFAULT_GENERAL_CHANNEL_ID ? 1 : 0)
        || (right.updatedAt - left.updatedAt)
        || left.id.localeCompare(right.id)
      )),
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
  copyAssistantTurnSourceRef.current = { entries, toolResults, conversationId };
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

  const scheduleScrollToBottom = useCallback(() => {
    if (bottomScrollFrameRef.current !== null) return;
    bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      const element = scrollRef.current;
      if (!element || !stickToBottomRef.current) return;
      element.scrollTop = element.scrollHeight;
      updateScrollMetrics(element);
    });
  }, [updateScrollMetrics]);

  const pauseStickToBottomForDisclosure = useCallback(() => {
    stickToBottomRef.current = false;
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
      bottomScrollFrameRef.current = null;
    }
    const element = scrollRef.current;
    if (element) updateScrollMetrics(element);
  }, [updateScrollMetrics]);

  const measureConversationRow = useCallback((rowKey: string, height: number) => {
    const current = rowHeightsRef.current.get(rowKey);
    if (current !== undefined && Math.abs(current - height) < 1) return;
    rowHeightsRef.current.set(rowKey, height);
    setMeasureVersion((version) => version + 1);
  }, []);

  const copyAssistantTurnForRow = useCallback((rowKey: string, endIndex: number) => {
    const cached = copyAssistantTurnCallbacksRef.current.get(rowKey);
    if (cached?.endIndex === endIndex) return cached.handler;
    const handler = async () => {
      const source = copyAssistantTurnSourceRef.current;
      const text = await buildAssistantTurnCopyText(
        source.entries,
        endIndex,
        source.toolResults,
        source.conversationId,
        copyPayloadTextCacheRef.current,
      );
      if (text) await navigator.clipboard.writeText(text);
    };
    copyAssistantTurnCallbacksRef.current.set(rowKey, { endIndex, handler });
    return handler;
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
    scheduleScrollToBottom();
  }, [conversationRows.length, runActive, scheduleScrollToBottom, virtualLayout.totalHeight]);

  const revealTranscriptRow = useCallback((rowIndex: number, rowKey: string) => {
    stickToBottomRef.current = false;
    const element = scrollRef.current;
    if (element) {
      const item = virtualLayout.items[rowIndex];
      if (shouldVirtualizeTranscript && item) {
        element.scrollTop = Math.max(0, item.top - Math.max(0, (element.clientHeight - item.height) / 2));
        updateScrollMetrics(element);
      } else {
        element.querySelector<HTMLElement>(transcriptRowSelector(rowKey))?.scrollIntoView({ block: 'center' });
      }
    }

    setHighlightedTranscriptRowKey(rowKey);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightedTranscriptRowKey((current) => current === rowKey ? null : current);
    }, TRANSCRIPT_JUMP_HIGHLIGHT_MS);
  }, [shouldVirtualizeTranscript, updateScrollMetrics, virtualLayout.items]);

  useLayoutEffect(() => {
    if (!pendingTranscriptReveal || conversationId !== pendingTranscriptReveal.conversationId) return;
    const target = pendingTranscriptReveal.target;
    const rowIndex = conversationRows.findIndex((row) => conversationRowMatchesChatSource(row, target));
    const blankProjection = revision === `${conversationId}-0-0-0-`;

    if (target.stream === 'run') {
      if (childRuns[target.streamId]) {
        setTaskPanelOpen(false);
        setSelectedChildRunId(target.streamId);
        if (rowIndex >= 0) revealTranscriptRow(rowIndex, conversationRows[rowIndex]!.key);
        setPendingTranscriptReveal(null);
        return;
      }
      if (!blankProjection) setPendingTranscriptReveal(null);
      return;
    }

    if (rowIndex >= 0) {
      setTaskPanelOpen(false);
      setSelectedChildRunId(null);
      revealTranscriptRow(rowIndex, conversationRows[rowIndex]!.key);
      setPendingTranscriptReveal(null);
      return;
    }

    if (!blankProjection) setPendingTranscriptReveal(null);
  }, [
    childRuns,
    conversationId,
    conversationRows,
    pendingTranscriptReveal,
    revealTranscriptRow,
    revision,
  ]);

  useEffect(() => {
    rowHeightsRef.current.clear();
    copyPayloadTextCacheRef.current.clear();
    copyAssistantTurnCallbacksRef.current.clear();
    setMeasureVersion((version) => version + 1);
  }, [conversationId]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
      bottomScrollFrameRef.current = null;
    }
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
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
    // Clear the steering note when the run settles.
    if (!runActive) {
      setSteeringNote(null);
    }
  }, [runActive]);

  useEffect(() => {
    if (selectedChildRunId && !childRuns[selectedChildRunId]) setSelectedChildRunId(null);
  }, [selectedChildRunId, childRuns]);

  // A command Run reveals its delivery conversation and asks for the task panel —
  // the run is a parentless child run, so it surfaces there (the open task panel
  // persists across the conversation switch this same reveal triggers).
  useEffect(() => onAgentRevealRequest((targetConversationId, options) => {
    if (options.transcriptTarget) {
      setPendingTranscriptReveal({
        conversationId: targetConversationId,
        target: options.transcriptTarget,
      });
    }
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
    return await resolveApproval(requestId, approved, scope);
  }, [resolveApproval]);

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

  function handleConfigureAgent(agentId: string) {
    setHistoryOpen(false);
    setRowActionMenu(null);
    void window.lin?.openAgentConfig?.({ agentId });
  }

  function handleConfigureChannel(targetConversationId: string) {
    setHistoryOpen(false);
    setRowActionMenu(null);
    void window.lin?.openChannelConfig?.({ conversationId: targetConversationId, mode: 'configure' });
  }

  async function handleSelectConversation(targetConversationId: string) {
    // Single-agent collapse: navigation is never locked. A run keeps streaming in
    // its conversation and surfaces unread via conversation_attention; the user can
    // switch away freely (Slack-like). The only no-op is re-selecting the current.
    if (targetConversationId === conversationId) return;
    setHistoryOpen(false);
    setRowActionMenu(null);
    await selectConversation(targetConversationId);
  }

  function renderConversationRow(row: AgentConversationRenderRow, highlighted = false): ReactNode {
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

    // Single-agent collapse: no per-row channel attribution badge — the one agent
    // owns every assistant turn, so the row carries no actor label/mention.
    const actor = row.entry.actor;
    const actorLabel: string | null = null;
    const actorMention: string | undefined = undefined;
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
    // Result-first turn: the turn renders its final answer as prose with the
    // working process — thinking, tools, interim narration — folded behind the
    // collapsed "Worked for …" disclosure (renderAssistantBlocks).
    const copyAssistantTurn = row.isLastInTurn && getEntryRole(row.entry) === 'assistant'
      ? copyAssistantTurnForRow(row.key, row.endIndex)
      : undefined;

    return (
      <AgentMessageRow
        actorLabel={actorLabel}
        actorMention={actorMention}
        busy={anyRunActive}
        contentKey={row.contentKey}
        entry={row.entry}
        index={index}
        isLastInTurn={row.isLastInTurn}
        onCopy={copyAssistantTurn}
        onDisclosureToggle={pauseStickToBottomForDisclosure}
        onEdit={editMessage}
        onNodeReferenceOpen={onOpenNodeReference}
        onOpenChildRunTranscript={setSelectedChildRunId}
        onRegenerate={regenerateMessage}
        onRetry={retryMessage}
        onSwitchBranch={switchBranch}
        pendingToolCallIds={pendingToolCallIds}
        conversationId={conversationId}
        highlighted={highlighted}
        streaming={row.streaming}
        childRunsByParentToolCallId={childRunsByParentToolCallId}
        toolResults={toolResults}
        isChannel={false}
        turnPhase={row.turnPhase}
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
  // Heterogeneous popover (lists + actions + rename inputs): focus-trap rather than
  // roving menu-nav, plus the Escape-to-close this menu previously lacked, and
  // focus-restore to the title button on close.
  const { onKeyDown: onHistoryMenuKeyDown } = useMenuKeyboard({
    surfaceRef: historyMenuRef,
    onClose: () => {
      setHistoryOpen(false);
      setRowActionMenu(null);
    },
    kind: 'dialog',
    active: historyOpen,
    getRestoreTarget: () => historyButtonRef.current,
  });
  if (filePreview) {
    return (
      <div className="agent-chat-panel" data-turn-phase={turnPhase}>
        <AgentDockFilePreview
          onClose={() => setFilePreview(null)}
          target={filePreview.target}
        />
      </div>
    );
  }
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
          {/* Single-agent collapse: every conversation is one of Neva's channels.
              The agent is always Neva, so a per-conversation avatar here carried no
              signal — show the channel glyph + title, matching the conversation list
              (agent-conversation-channel-icon). */}
          <span className="agent-dock-title-leading">
            <HashIcon aria-hidden="true" size={ICON_SIZE.menu} />
          </span>
          <span className="agent-dock-title">{displayTitle}</span>
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
            onKeyDown={onHistoryMenuKeyDown}
            style={historyMenuStyle}
          >
            <div className="agent-conversation-menu-header">
              <span>{t.agent.chat.conversations}</span>
              <IconButton
                className="agent-conversation-section-action"
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
                const isDefaultGeneral = conversation.id === DEFAULT_GENERAL_CHANNEL_ID;
                const title = readableConversationTitle(conversation.title, t.common.untitled);
                const unread = isCurrent ? 0 : conversation.unreadCount ?? unreadByConversationId.get(conversation.id) ?? 0;
                const actionMenuKey = `channel:${conversation.id}`;
                const channelActions: ConversationRowMenuAction[] = [
                  ...(isDefaultGeneral ? [] : [{
                    disabled: anyRunActive,
                    id: 'configure-channel',
                    label: t.agent.chat.configureChannel,
                    onSelect: () => handleConfigureChannel(conversation.id),
                  } satisfies ConversationRowMenuAction]),
                ];
                return (
                  <div
                    className={isCurrent ? 'agent-conversation-row agent-conversation-compact-row is-current' : 'agent-conversation-row agent-conversation-compact-row'}
                    key={conversation.id}
                  >
                    <ButtonControl
                      className="agent-conversation-select agent-conversation-compact-select"
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
                    {channelActions.length > 0 ? (
                      <div className="agent-conversation-row-actions">
                        <ConversationRowMoreMenu
                          actions={channelActions}
                          label={t.agent.chat.channelOptions}
                          menuLabel={t.agent.chat.channelOptions}
                          onOpenChange={(open) => setRowActionMenu(open ? actionMenuKey : null)}
                          open={rowActionMenu === actionMenuKey}
                        />
                      </div>
                    ) : null}
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
              const rowHighlighted = highlightedTranscriptRowKey === row.key;
              const renderedRow = renderConversationRow(row, rowHighlighted);
              const showTimeSeparator = previousRow
                ? getEntryTimestamp(row.entry) - getEntryTimestamp(previousRow.entry) > MESSAGE_TIME_SEPARATOR_GAP_MS
                : false;
              return (
                <AgentTranscriptRowShell
                  highlighted={rowHighlighted}
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
                  {renderedRow}
                </AgentTranscriptRowShell>
              );
            })}
          </div>
        )}
      </div>

      <div className="agent-composer-region">
        <AgentComposer
          currentNodeId={composerCurrentNodeId(userViewContext, index)}
          focusToken={composerFocusToken}
          index={index}
          isStreaming={runActive}
          members={[]}
          onNodeReferenceOpen={onOpenNodeReference}
          onCancelSteer={handleCancelSteer}
          onSend={sendMessage}
          onStop={stop}
          onSteer={handleSteerMessage}
          onResolveApproval={handleResolveApproval}
          onResolveUserQuestion={resolveUserQuestion}
          pendingApproval={pendingApproval}
          pendingUserQuestion={pendingUserQuestion}
          settings={providerSettings}
          agentModel={typeof builtInDefinition?.model === 'string' ? builtInDefinition.model : ''}
          agentEffort={typeof builtInDefinition?.effort === 'string' ? builtInDefinition.effort : ''}
          onModelChange={builtInDefinition ? handleAgentModelChange : undefined}
          onEffortChange={builtInDefinition ? handleAgentEffortChange : undefined}
          slashCommands={slashCommands}
          steeringNote={steeringNote}
        />
      </div>
      <AgentChildRunDetailsPanel
        onClose={() => setSelectedChildRunId(null)}
        conversationId={conversationId}
        index={index}
        childRun={selectedChildRun}
        childRunsByParentToolCallId={childRunsByParentToolCallId}
        onNodeReferenceOpen={onOpenNodeReference}
        onOpenChildRunTranscript={setSelectedChildRunId}
      />
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
