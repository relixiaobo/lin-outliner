import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentMessageAttachmentInput,
  AgentToolResultWithPayloads,
  AgentUserViewContext,
} from '../../../core/agentTypes';
import { nodeReferenceMarkersToText } from '../../../core/referenceMarkup';
import { DEFAULT_DREAM_CHANNEL_ID, DEFAULT_GENERAL_CHANNEL_ID, agentMentionToken } from '../../../core/agentChannel';
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
  IssueSearchRow,
  IssueTargetRef,
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
  BackIcon,
  ChevronDownIcon,
  CloseIcon,
  HashIcon,
  ICON_SIZE,
  LoaderIcon,
  PencilIcon,
  RunsIcon,
  TrashIcon,
  WarningIcon,
} from '../icons';
import { AgentCompactionBoundary } from './AgentCompactionBoundary';
import { AgentContextClearBoundary } from './AgentContextClearBoundary';
import { AgentDreamBoundary } from './AgentDreamBoundary';
import { AgentComposer } from './AgentComposer';
import { DreamLauncher } from './DreamLauncher';
import type { AgentComposerNodeReference } from './AgentComposerEditor';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentIssueNotificationRow } from './AgentIssueNotificationRow';
import { AgentMessageRow } from './AgentMessageRow';
import {
  buildConversationRenderRows,
  getEntryRole,
  isBoundaryEntry,
  isTurnBoundaryEntry,
} from './agentConversationRows';
import type { AgentConversationRenderRow } from './agentConversationRows';
import { systemLineText } from './agentSystemLine';
import {
  AgentIssueDetailsPanel,
  AgentIssuesPanel,
} from './AgentIssuesPanel';
import {
  issueSearchInputsForWorkPreset,
  loadAllIssueSearchRows,
  shouldRefreshIssueWorkForAgentEvent,
  type IssueWorkPreset,
} from './agentIssueViewModel';
import { AgentRunDetailsPanel } from './AgentRunDetailsPanel';
import { composerCurrentNodeId } from './userViewContext';
import { resolveUsableActiveProvider } from './providerCatalog';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { Dialog } from '../primitives/Dialog';
import { EmptyState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
import { useT } from '../../i18n/I18nProvider';

const TRANSCRIPT_ROW_GAP_PX = 14;
const TRANSCRIPT_ROW_ESTIMATE_PX = 104;
const TRANSCRIPT_VIRTUAL_MIN_ROWS = 40;
const TRANSCRIPT_VIRTUAL_OVERSCAN_PX = 720;
const TRANSCRIPT_JUMP_HIGHLIGHT_MS = 2_200;

interface AgentChatPanelProps {
  index: DocumentIndex;
  /** Whether the agent dock is open (not the CSS-collapsed seed). */
  dockOpen: boolean;
  userViewContext: AgentUserViewContext;
  onOpenNodeReference: AgentNodeReferenceOpenHandler;
  onOpenRunDetailsPanel?: (conversationId: string | null, runId: string | null) => boolean | void;
}

interface PendingTranscriptReveal {
  conversationId: string;
  deferUntilDockOpen: boolean;
  reachedTargetConversation: boolean;
  target: AgentChatSourceRevealTarget;
}

interface RunDetailTarget {
  conversationId: string | null;
  runId: string;
}

interface IssueDetailTarget {
  target: IssueTargetRef;
  title?: string;
}

interface ChatScrollSnapshot {
  top: number;
  stickToBottom: boolean;
}

interface PendingUserMessageScroll {
  conversationId: string | null;
  existingUserRowKeys: ReadonlySet<string>;
  targetRowKey: string | null;
}

function parseCssTimeMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith('ms')) {
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (trimmed.endsWith('s')) {
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed * 1000 : null;
  }
  return null;
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

function editableConversationTitle(title: string | null | undefined): string {
  const readable = nodeReferenceMarkersToText(title ?? '').replace(/\s+/g, ' ').trim();
  if (!readable || readable === RUNTIME_UNTITLED_SENTINEL) return '';
  return readable;
}

function isProtectedDefaultChannel(conversationId: string): boolean {
  return conversationId === DEFAULT_GENERAL_CHANNEL_ID || conversationId === DEFAULT_DREAM_CHANNEL_ID;
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

interface VirtualTranscriptItem {
  top: number;
  height: number;
}

interface VirtualTranscriptLayout {
  items: VirtualTranscriptItem[];
  totalHeight: number;
}

function estimateTranscriptRowHeight(row: AgentConversationRenderRow): number {
  if (row.entry.kind === 'hidden-turn-boundary') return 0;
  if (row.entry.kind === 'issue-notification') return 44;
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
  if (target.stream === 'run') return false;
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
  onOpenRunDetailsPanel,
  userViewContext,
}: AgentChatPanelProps) {
  const t = useT();
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
    newConversation,
    sendMessage: sendRuntimeMessage,
    conversationId,
    conversationTitle,
    members,
    steer: steerRuntime,
    subRunsByParentToolCallId,
    switchBranch,
    stop,
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
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingConversationTitle, setEditingConversationTitle] = useState('');
  const [savingRenameConversationId, setSavingRenameConversationId] = useState<string | null>(null);
  const [pendingDeleteConversation, setPendingDeleteConversation] = useState<AgentConversationListMeta | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  const [runDetailStack, setRunDetailStack] = useState<RunDetailTarget[]>([]);
  const [issueDetailStack, setIssueDetailStack] = useState<IssueDetailTarget[]>([]);
  const [issueIndexPreset, setIssueIndexPreset] = useState<IssueWorkPreset>('today');
  const [issueIndex, setIssueIndex] = useState<IssueSearchRow[]>([]);
  const [activeIssueSessionCount, setActiveIssueSessionCount] = useState(0);
  const [issueIndexLoading, setIssueIndexLoading] = useState(false);
  const [issueIndexError, setIssueIndexError] = useState<string | null>(null);
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
  const issueIndexRequestRef = useRef(0);
  const activeIssueSessionCountRequestRef = useRef(0);
  const issueIndexRefreshTimerRef = useRef<number | null>(null);
  const issueIndexPresetRef = useRef(issueIndexPreset);
  const workPanelOpenRef = useRef(workPanelOpen);
  const scrollFrameRef = useRef<number | null>(null);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const chatScrollSnapshotsRef = useRef(new Map<string, ChatScrollSnapshot>());
  const restoredChatScrollConversationRef = useRef<string | null>(null);
  const pendingUserMessageScrollRef = useRef<PendingUserMessageScroll | null>(null);
  const sentMessageScrollLockConversationRef = useRef<string | null>(null);
  const suppressHeaderClickRef = useRef(false);
  const revealAfterDockOpenTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const cancelRenameRef = useRef<string | null>(null);
  const pendingRenameRef = useRef<string | null>(null);
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
  useLayoutEffect(() => {
    if (!editingConversationId) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [editingConversationId]);
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
  const selectedIssueDetail = issueDetailStack.length > 0 ? issueDetailStack[issueDetailStack.length - 1]! : null;
  const selectedIssueTarget = selectedIssueDetail?.target ?? null;
  const selectedRunTarget = runDetailStack.length > 0 ? runDetailStack[runDetailStack.length - 1]! : null;
  const detailDrawerOpen = selectedIssueTarget !== null || selectedRunTarget !== null;
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
  const sendMessage = useCallback(async (
    prompt: string,
    attachments?: AgentMessageAttachmentInput[],
    nodeRefs: AgentComposerNodeReference[] = [],
  ) => {
    const pendingScroll: PendingUserMessageScroll = {
      conversationId,
      existingUserRowKeys: new Set(conversationRows
        .filter((row) => getEntryRole(row.entry) === 'user')
        .map((row) => row.key)),
      targetRowKey: null,
    };
    pendingUserMessageScrollRef.current = pendingScroll;
    try {
      await sendRuntimeMessage(
        prompt,
        attachments,
        withReferencedNodes(userViewContext, nodeRefs, index, t.common.untitled),
      );
    } catch (caught) {
      if (pendingUserMessageScrollRef.current === pendingScroll) {
        pendingUserMessageScrollRef.current = null;
      }
      throw caught;
    }
  }, [conversationId, conversationRows, index, sendRuntimeMessage, userViewContext, t.common.untitled]);
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

  const saveCurrentChatScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!conversationId || !element) return;
    const stickToBottom = shouldStickToBottom(element);
    chatScrollSnapshotsRef.current.set(conversationId, {
      top: element.scrollTop,
      stickToBottom,
    });
    stickToBottomRef.current = stickToBottom;
    pendingUserMessageScrollRef.current = null;
    sentMessageScrollLockConversationRef.current = null;
    restoredChatScrollConversationRef.current = null;
    updateScrollMetrics(element);
  }, [conversationId, updateScrollMetrics]);

  const openWorkPanel = useCallback(() => {
    saveCurrentChatScroll();
    setWorkPanelOpen(true);
  }, [saveCurrentChatScroll]);

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

  issueIndexPresetRef.current = issueIndexPreset;
  workPanelOpenRef.current = workPanelOpen;

  const loadIssueIndex = useCallback(async (preset: IssueWorkPreset) => {
    const requestId = issueIndexRequestRef.current + 1;
    issueIndexRequestRef.current = requestId;
    setIssueIndexLoading(true);
    try {
      const queries = issueSearchInputsForWorkPreset(preset);
      const results = await Promise.all(queries.map((query) => loadAllIssueSearchRows(query, api.agentIssueSearch)));
      if (!mountedRef.current || requestId !== issueIndexRequestRef.current) return null;
      const deduped = new Map<string, IssueSearchRow>();
      for (const resultRows of results) {
        for (const row of resultRows) {
          deduped.set(`${row.target.type}:${row.target.id}`, row);
        }
      }
      const rows = [...deduped.values()];
      setIssueIndex(rows);
      setIssueIndexError(null);
      return rows;
    } catch (caught) {
      if (mountedRef.current && requestId === issueIndexRequestRef.current) {
        setIssueIndexError(caught instanceof Error ? caught.message : String(caught));
      }
      return null;
    } finally {
      if (mountedRef.current && requestId === issueIndexRequestRef.current) {
        setIssueIndexLoading(false);
      }
    }
  }, []);

  const loadActiveIssueSessionCount = useCallback(async () => {
    const requestId = activeIssueSessionCountRequestRef.current + 1;
    activeIssueSessionCountRequestRef.current = requestId;
    try {
      const rows = await loadAllIssueSearchRows({
        targets: ['issue'],
        filter: { hasActiveSession: true, archived: false },
      }, api.agentIssueSearch);
      if (!mountedRef.current || requestId !== activeIssueSessionCountRequestRef.current) return;
      setActiveIssueSessionCount(rows.length);
    } catch {
      // Keep the last known badge count; Work loading reports its own errors.
    }
  }, []);

  const scheduleIssueIndexRefresh = useCallback(() => {
    if (issueIndexRefreshTimerRef.current !== null) return;
    issueIndexRefreshTimerRef.current = window.setTimeout(() => {
      issueIndexRefreshTimerRef.current = null;
      void loadActiveIssueSessionCount();
      if (workPanelOpenRef.current) void loadIssueIndex(issueIndexPresetRef.current);
    }, 250);
  }, [loadActiveIssueSessionCount, loadIssueIndex]);

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
    if (workPanelOpen || restoredChatScrollConversationRef.current === conversationId) return;
    const element = scrollRef.current;
    if (!conversationId || !element) return;

    const snapshot = chatScrollSnapshotsRef.current.get(conversationId);
    if (!snapshot) {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      stickToBottomRef.current = true;
      restoredChatScrollConversationRef.current = conversationId;
      updateScrollMetrics(element);
      return;
    }

    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextTop = snapshot.stickToBottom ? maxTop : Math.min(snapshot.top, maxTop);
    if (Math.abs(element.scrollTop - nextTop) > 1) element.scrollTop = nextTop;
    stickToBottomRef.current = snapshot.stickToBottom;
    restoredChatScrollConversationRef.current = conversationId;
    updateScrollMetrics(element);
  }, [conversationId, updateScrollMetrics, virtualLayout.totalHeight, workPanelOpen]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !stickToBottomRef.current) return;
    scheduleScrollToBottom();
  }, [conversationRows.length, runActive, scheduleScrollToBottom, virtualLayout.totalHeight]);

  useLayoutEffect(() => {
    const pendingScroll = pendingUserMessageScrollRef.current;
    const element = scrollRef.current;
    if (!pendingScroll || !element || workPanelOpen) return;
    if (pendingScroll.conversationId !== null && pendingScroll.conversationId !== conversationId) return;

    let targetRowKey = pendingScroll.targetRowKey;
    if (targetRowKey === null) {
      for (let index = conversationRows.length - 1; index >= 0; index -= 1) {
        const row = conversationRows[index]!;
        if (getEntryRole(row.entry) === 'user' && !pendingScroll.existingUserRowKeys.has(row.key)) {
          targetRowKey = row.key;
          break;
        }
      }
      if (targetRowKey === null) return;
      pendingUserMessageScrollRef.current = { ...pendingScroll, targetRowKey };
    }

    const resolvedTargetRowKey = targetRowKey;
    const rowIndex = conversationRows.findIndex((row) => row.key === resolvedTargetRowKey);
    if (rowIndex < 0) return;

    stickToBottomRef.current = false;
    sentMessageScrollLockConversationRef.current = conversationId;
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
      bottomScrollFrameRef.current = null;
    }

    const rowElement = element.querySelector<HTMLElement>(transcriptRowSelector(resolvedTargetRowKey));
    if (!rowElement) {
      const item = virtualLayout.items[rowIndex];
      if (shouldVirtualizeTranscript && item) {
        element.scrollTop = item.top;
        updateScrollMetrics(element);
      }
      return;
    }

    const elementRect = element.getBoundingClientRect();
    const rowRect = rowElement.getBoundingClientRect();
    const paddingTop = Number.parseFloat(window.getComputedStyle(element).paddingTop) || 0;
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const targetTop = element.scrollTop + rowRect.top - elementRect.top - paddingTop;
    element.scrollTop = Math.min(maxTop, Math.max(0, targetTop));
    pendingUserMessageScrollRef.current = null;
    updateScrollMetrics(element);
  }, [
    conversationId,
    conversationRows,
    scrollMetrics.top,
    shouldVirtualizeTranscript,
    updateScrollMetrics,
    virtualLayout.items,
    workPanelOpen,
  ]);

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

  useEffect(() => {
    if (!pendingTranscriptReveal?.deferUntilDockOpen || !dockOpen || conversationId !== pendingTranscriptReveal.conversationId) {
      return undefined;
    }

    const dock = scrollRef.current?.closest<HTMLElement>('.agent-dock') ?? null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (revealAfterDockOpenTimerRef.current !== null) {
        window.clearTimeout(revealAfterDockOpenTimerRef.current);
        revealAfterDockOpenTimerRef.current = null;
      }
      setPendingTranscriptReveal((current) => (
        current === pendingTranscriptReveal
          ? { ...current, deferUntilDockOpen: false }
          : current
      ));
    };

    const fallbackDelay = dock
      ? (parseCssTimeMs(getComputedStyle(dock).getPropertyValue('--motion-layout-duration')) ?? 160) + 32
      : 0;
    revealAfterDockOpenTimerRef.current = window.setTimeout(finish, fallbackDelay);

    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== dock) return;
      if (event.propertyName !== 'transform' && event.propertyName !== 'opacity') return;
      finish();
    };
    dock?.addEventListener('transitionend', handleTransitionEnd);

    return () => {
      dock?.removeEventListener('transitionend', handleTransitionEnd);
      if (revealAfterDockOpenTimerRef.current !== null) {
        window.clearTimeout(revealAfterDockOpenTimerRef.current);
        revealAfterDockOpenTimerRef.current = null;
      }
    };
  }, [conversationId, dockOpen, pendingTranscriptReveal]);

  useEffect(() => {
    if (!pendingTranscriptReveal) return;
    if (conversationId === pendingTranscriptReveal.conversationId) {
      if (pendingTranscriptReveal.reachedTargetConversation) return;
      setPendingTranscriptReveal((current) => (
        current === pendingTranscriptReveal
          ? { ...current, reachedTargetConversation: true }
          : current
      ));
      return;
    }
    if (!pendingTranscriptReveal.reachedTargetConversation) return;
    setPendingTranscriptReveal((current) => (
      current === pendingTranscriptReveal ? null : current
    ));
  }, [conversationId, pendingTranscriptReveal]);

  useLayoutEffect(() => {
    if (!pendingTranscriptReveal || conversationId !== pendingTranscriptReveal.conversationId) return;
    if (!dockOpen || pendingTranscriptReveal.deferUntilDockOpen) return;
    const target = pendingTranscriptReveal.target;
    const rowIndex = conversationRows.findIndex((row) => conversationRowMatchesChatSource(row, target));
    const blankProjection = revision === `${conversationId}-0-0-0-`;

    if (target.stream === 'run') {
      openWorkPanel();
      setIssueDetailStack([]);
      setRunDetailStack([{ conversationId, runId: target.streamId }]);
      if (rowIndex >= 0) revealTranscriptRow(rowIndex, conversationRows[rowIndex]!.key);
      if (!blankProjection || rowIndex >= 0) setPendingTranscriptReveal(null);
      return;
    }

    if (rowIndex >= 0) {
      setWorkPanelOpen(false);
      setIssueDetailStack([]);
      revealTranscriptRow(rowIndex, conversationRows[rowIndex]!.key);
      setPendingTranscriptReveal(null);
      return;
    }

    if (!blankProjection) setPendingTranscriptReveal(null);
  }, [
    conversationId,
    conversationRows,
    pendingTranscriptReveal,
    dockOpen,
    onOpenRunDetailsPanel,
    openWorkPanel,
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
    if (revealAfterDockOpenTimerRef.current !== null) {
      window.clearTimeout(revealAfterDockOpenTimerRef.current);
      revealAfterDockOpenTimerRef.current = null;
    }
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadProviderSettings();
    void loadActiveIssueSessionCount();
    return () => {
      mountedRef.current = false;
      providerSettingsRequestRef.current += 1;
      conversationsRequestRef.current += 1;
      issueIndexRequestRef.current += 1;
      slashCommandsRequestRef.current += 1;
      agentDefinitionsRequestRef.current += 1;
      activeIssueSessionCountRequestRef.current += 1;
      if (issueIndexRefreshTimerRef.current !== null) {
        window.clearTimeout(issueIndexRefreshTimerRef.current);
        issueIndexRefreshTimerRef.current = null;
      }
    };
  }, [loadActiveIssueSessionCount, loadProviderSettings]);

  useEffect(() => {
    return window.lin?.onAgentEvent((event) => {
      if (!shouldRefreshIssueWorkForAgentEvent(event)) return;
      scheduleIssueIndexRefresh();
    });
  }, [scheduleIssueIndexRefresh]);

  useEffect(() => {
    if (workPanelOpen) void loadIssueIndex(issueIndexPreset);
  }, [issueIndexPreset, loadIssueIndex, workPanelOpen]);

  useEffect(() => {
    void loadSlashCommands();
  }, [loadSlashCommands]);

  useEffect(() => {
    // Clear the steering note when the run settles.
    if (!runActive) {
      setSteeringNote(null);
    }
  }, [runActive]);

  // A command Run reveals its delivery conversation and asks for the Work panel;
  // the open run panel persists across the conversation switch this same reveal
  // triggers.
  useEffect(() => onAgentRevealRequest((targetConversationId, options) => {
    if (options.transcriptTarget) {
      setPendingTranscriptReveal({
        conversationId: targetConversationId,
        deferUntilDockOpen: !dockOpenRef.current,
        reachedTargetConversation: false,
        target: options.transcriptTarget,
      });
    }
    if (!options.openWork) return;
    setIssueDetailStack([]);
    setRunDetailStack([]);
    openWorkPanel();
  }), [openWorkPanel]);

  const openIssueFromWorkPanel = useCallback((target: IssueTargetRef, title?: string) => {
    openWorkPanel();
    setRunDetailStack([]);
    setIssueDetailStack([{ target, title }]);
  }, [openWorkPanel]);

  const openIssueFromTranscript = useCallback((target: IssueTargetRef, title?: string) => {
    setRunDetailStack([]);
    setIssueDetailStack([{ target, title }]);
  }, []);

  const openIssueInDetailDrawer = useCallback((target: IssueTargetRef, title?: string) => {
    setRunDetailStack([]);
    setIssueDetailStack((stack) => [...stack, { target, title }]);
  }, []);

  const goBackInIssueDetailDrawer = useCallback(() => {
    setIssueDetailStack((stack) => stack.length > 1 ? stack.slice(0, -1) : []);
  }, []);

  const selectIssueBreadcrumb = useCallback((index: number) => {
    setIssueDetailStack((stack) => stack.slice(0, index + 1));
  }, []);

  const closeIssueDetailDrawer = useCallback(() => {
    setIssueDetailStack([]);
  }, []);

  const closeRunDetailDrawer = useCallback(() => {
    setRunDetailStack([]);
  }, []);

  const handleDockHeaderMouseDownCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!selectedIssueTarget && !selectedRunTarget) return;
    suppressHeaderClickRef.current = true;
    window.setTimeout(() => {
      suppressHeaderClickRef.current = false;
    }, 500);
    event.preventDefault();
    event.stopPropagation();
    if (selectedRunTarget) closeRunDetailDrawer();
    else closeIssueDetailDrawer();
  }, [closeIssueDetailDrawer, closeRunDetailDrawer, selectedIssueTarget, selectedRunTarget]);

  const handleDockHeaderClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressHeaderClickRef.current && !selectedIssueTarget && !selectedRunTarget) return;
    suppressHeaderClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    if (selectedRunTarget) closeRunDetailDrawer();
    else if (selectedIssueTarget) closeIssueDetailDrawer();
  }, [closeIssueDetailDrawer, closeRunDetailDrawer, selectedIssueTarget, selectedRunTarget]);

  const goBackInRunDetailDrawer = useCallback(() => {
    setRunDetailStack((stack) => stack.length > 1 ? stack.slice(0, -1) : []);
  }, []);

  const openRunInDetailDrawer = useCallback((runId: string, runConversationId: string | null) => {
    const nextConversationId = runConversationId ?? selectedRunTarget?.conversationId ?? conversationId;
    setRunDetailStack((stack) => {
      const existingIndex = stack.findIndex((item) => (
        item.runId === runId && item.conversationId === nextConversationId
      ));
      if (existingIndex >= 0) return stack.slice(0, existingIndex + 1);
      return [...stack, { conversationId: nextConversationId, runId }];
    });
  }, [conversationId, selectedRunTarget?.conversationId]);

  const setIssueWorkPreset = useCallback((preset: IssueWorkPreset) => {
    if (issueIndexRefreshTimerRef.current !== null) {
      window.clearTimeout(issueIndexRefreshTimerRef.current);
      issueIndexRefreshTimerRef.current = null;
    }
    if (issueIndexPresetRef.current === preset) {
      void loadIssueIndex(preset);
      return;
    }
    issueIndexPresetRef.current = preset;
    issueIndexRequestRef.current += 1;
    setIssueIndexPreset(preset);
  }, [loadIssueIndex]);

  useEffect(() => {
    if (historyOpen) void loadConversations();
  }, [historyOpen, loadConversations]);

  useEffect(() => {
    if (!historyOpen) {
      setEditingConversationId(null);
      setEditingConversationTitle('');
    }
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
      setHistoryOpen(false);
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
    const refreshes: Array<Promise<unknown>> = [
      loadProviderSettings(),
      loadConversations(),
      loadSlashCommands(),
      loadAgentDefinitions(),
      reloadConversation(),
    ];
    if (workPanelOpen) refreshes.push(loadIssueIndex(issueIndexPreset));
    await Promise.all(refreshes);
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
  selectConversationRef.current = handleSelectConversation;
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
    if (creatingConversation) return;
    setHistoryOpen(false);
    setEditingConversationId(null);
    setEditingConversationTitle('');
    setCreatingConversation(true);
    try {
      await newConversation({});
      await loadConversations();
      setComposerFocusToken((token) => token + 1);
    } catch (caught) {
      if (mountedRef.current) setSettingsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setCreatingConversation(false);
    }
  }

  function startRenameConversation(target: AgentConversationListMeta) {
    setEditingConversationId(target.id);
    setEditingConversationTitle(editableConversationTitle(target.title));
    cancelRenameRef.current = null;
  }

  function cancelRenameConversation(targetConversationId: string) {
    cancelRenameRef.current = targetConversationId;
    setEditingConversationId(null);
    setEditingConversationTitle('');
  }

  async function commitRenameConversation(targetConversationId: string) {
    if (pendingRenameRef.current === targetConversationId) return;
    pendingRenameRef.current = targetConversationId;
    setSavingRenameConversationId(targetConversationId);
    setSettingsError(null);
    try {
      await api.agentRenameConversation(targetConversationId, editingConversationTitle);
      await loadConversations();
      if (targetConversationId === conversationId) await reloadConversation();
      setEditingConversationId(null);
      setEditingConversationTitle('');
    } catch (caught) {
      if (mountedRef.current) setSettingsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (pendingRenameRef.current === targetConversationId) pendingRenameRef.current = null;
      if (mountedRef.current) setSavingRenameConversationId(null);
    }
  }

  async function confirmDeleteConversation() {
    const target = pendingDeleteConversation;
    if (!target || deletingConversationId) return;
    setPendingDeleteConversation(null);
    if (isProtectedDefaultChannel(target.id)) return;

    setDeletingConversationId(target.id);
    setSettingsError(null);
    try {
      await api.agentDeleteConversation(target.id);
      if (editingConversationId === target.id) {
        setEditingConversationId(null);
        setEditingConversationTitle('');
      }
      chatScrollSnapshotsRef.current.delete(target.id);
      const nextConversations = await loadConversations();
      const activeConversationStillListed = nextConversations?.some((entry) => entry.id === conversationId) ?? true;
      if (target.id === conversationId || !activeConversationStillListed) {
        await selectConversation(DEFAULT_GENERAL_CHANNEL_ID);
      }
    } catch (caught) {
      if (mountedRef.current) setSettingsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setDeletingConversationId(null);
    }
  }

  async function handleSelectConversation(targetConversationId: string) {
    // Single-agent collapse: navigation is never locked. A run keeps streaming in
    // its conversation and surfaces unread via conversation_attention; the user can
    // switch away freely (Slack-like). The only no-op is re-selecting the current.
    if (targetConversationId === conversationId) return;
    saveCurrentChatScroll();
    setHistoryOpen(false);
    setEditingConversationId(null);
    setEditingConversationTitle('');
    await selectConversation(targetConversationId);
  }

  function renderConversationRow(row: AgentConversationRenderRow, highlighted = false): ReactNode {
    if (row.entry.kind === 'compaction') {
      return <AgentCompactionBoundary entry={row.entry} />;
    }
    if (row.entry.kind === 'context-clear') {
      return <AgentContextClearBoundary entry={row.entry} />;
    }
    if (row.entry.kind === 'dream') {
      return <AgentDreamBoundary entry={row.entry} />;
    }
    if (row.entry.kind === 'hidden-turn-boundary') {
      return null;
    }
    if (row.entry.kind === 'issue-notification') {
      return (
        <AgentIssueNotificationRow
          entry={row.entry}
          onOpenIssue={(issueId, title) => openIssueFromTranscript({ type: 'issue', id: issueId }, title)}
        />
      );
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
    // Result-first turn: the turn renders its final answer as prose, with earlier
    // thinking, tools, and interim narration handled by renderAssistantBlocks.
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
        filePreviewPresentation="reader"
        index={index}
        isLastInTurn={row.isLastInTurn}
        onCopy={copyAssistantTurn}
        onDisclosureToggle={pauseStickToBottomForDisclosure}
        onEdit={editMessage}
        onNodeReferenceOpen={onOpenNodeReference}
        onOpenRunTranscript={(runId) => {
          onOpenRunDetailsPanel?.(conversationId, runId);
        }}
        onOpenRunDetails={(runId) => onOpenRunDetailsPanel?.(conversationId, runId)}
        onRegenerate={regenerateMessage}
        onRetry={retryMessage}
        onSwitchBranch={switchBranch}
        pendingToolCallIds={pendingToolCallIds}
        conversationId={conversationId}
        highlighted={highlighted}
        streaming={row.streaming}
        subRunsByParentToolCallId={subRunsByParentToolCallId}
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
      setEditingConversationId(null);
      setEditingConversationTitle('');
    },
    kind: 'dialog',
    active: historyOpen,
    getRestoreTarget: () => historyButtonRef.current,
  });
  return (
    <div
      className="agent-chat-panel"
      data-run-detail-open={detailDrawerOpen ? 'true' : undefined}
      data-turn-phase={turnPhase}
      data-work-panel-open={workPanelOpen ? 'true' : undefined}
    >
      <header
        className="agent-dock-header"
        data-run-detail-open={detailDrawerOpen ? 'true' : undefined}
        onClickCapture={handleDockHeaderClickCapture}
        onMouseDownCapture={handleDockHeaderMouseDownCapture}
        ref={headerRef}
      >
        {workPanelOpen ? (
          <ButtonControl
            aria-label={t.agent.run.backToChat}
            className="agent-dock-run-back"
            onClick={() => {
              setIssueDetailStack([]);
              setWorkPanelOpen(false);
            }}
            title={t.agent.run.backToChat}
          >
            <BackIcon aria-hidden="true" size={ICON_SIZE.menu} />
            <span className="agent-dock-title">{t.agent.issue.heading}</span>
          </ButtonControl>
        ) : (
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
        )}
        <div className="agent-dock-actions">
          {workPanelOpen ? (
            <ButtonControl
              aria-label={t.agent.run.closePanel}
              className="agent-run-panel-button"
              onClick={() => {
                setIssueDetailStack([]);
                setWorkPanelOpen(false);
              }}
              title={t.agent.run.closePanel}
            >
              <CloseIcon size={ICON_SIZE.toolbar} />
            </ButtonControl>
          ) : (
            <ButtonControl
              aria-expanded={workPanelOpen}
              aria-label={activeIssueSessionCount > 0
                ? t.agent.issue.activeSessions({ count: activeIssueSessionCount })
                : t.agent.run.openPanel}
              className="agent-run-panel-button"
              onClick={() => {
                setIssueDetailStack([]);
                if (!workPanelOpen) saveCurrentChatScroll();
                setWorkPanelOpen((open) => !open);
                scheduleIssueIndexRefresh();
              }}
              title={t.agent.run.openPanel}
            >
              <RunsIcon size={ICON_SIZE.toolbar} />
              {activeIssueSessionCount > 0 ? <span className="agent-run-panel-badge">{activeIssueSessionCount}</span> : null}
            </ButtonControl>
          )}
        </div>
        {!workPanelOpen && historyOpen ? createPortal(
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
                disabled={creatingConversation}
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
                const canManage = !isProtectedDefaultChannel(conversation.id);
                const isEditing = editingConversationId === conversation.id;
                const renameSaving = savingRenameConversationId === conversation.id;
                const deleteSaving = deletingConversationId === conversation.id;
                return (
                  <div
                    className={[
                      'agent-conversation-row agent-conversation-compact-row',
                      isCurrent ? 'is-current' : '',
                      isEditing ? 'is-editing' : '',
                    ].filter(Boolean).join(' ')}
                    key={conversation.id}
                  >
                    {isEditing ? (
                      <div className="agent-conversation-select agent-conversation-compact-select agent-conversation-rename-editor">
                        <HashIcon
                          aria-hidden="true"
                          className="agent-conversation-channel-icon"
                          size={ICON_SIZE.menu}
                        />
                        <input
                          aria-label={t.agent.chat.renameChannel}
                          className="agent-conversation-rename-input"
                          disabled={renameSaving}
                          onBlur={() => {
                            if (cancelRenameRef.current === conversation.id) {
                              cancelRenameRef.current = null;
                              return;
                            }
                            void commitRenameConversation(conversation.id);
                          }}
                          onChange={(event) => setEditingConversationTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void commitRenameConversation(conversation.id);
                              return;
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              cancelRenameConversation(conversation.id);
                            }
                          }}
                          placeholder={t.common.untitled}
                          ref={renameInputRef}
                          value={editingConversationTitle}
                        />
                      </div>
                    ) : (
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
                    )}
                    {canManage && !isEditing ? (
                      <div className="agent-conversation-row-actions">
                        <IconButton
                          className="agent-conversation-edit-button"
                          disabled={renameSaving || deleteSaving}
                          icon={PencilIcon}
                          iconSize={ICON_SIZE.menu}
                          label={t.agent.chat.renameChannel}
                          onClick={(event) => {
                            event.stopPropagation();
                            startRenameConversation(conversation);
                          }}
                          title={t.agent.chat.renameChannel}
                          variant="message"
                        />
                        <IconButton
                          className="agent-conversation-delete-button"
                          disabled={deleteSaving}
                          icon={TrashIcon}
                          iconSize={ICON_SIZE.menu}
                          label={t.agent.chat.deleteChannel}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDeleteConversation(conversation);
                          }}
                          title={t.agent.chat.deleteChannel}
                          variant="message"
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
      {pendingDeleteConversation ? (
        <ConfirmDialog
          danger
          confirmLabel={t.agent.chat.deleteChannelConfirm}
          message={t.agent.chat.deleteChannelMessage}
          onCancel={() => setPendingDeleteConversation(null)}
          onConfirm={() => void confirmDeleteConversation()}
          restoreFocus={() => historyButtonRef.current}
          title={t.agent.chat.deleteChannelTitle({
            name: readableConversationTitle(pendingDeleteConversation.title, t.common.untitled),
          })}
        />
      ) : null}

      {workPanelOpen ? (
        <div className="agent-work-page">
          <AgentIssuesPanel
            activeSessionCount={activeIssueSessionCount}
            error={issueIndexError}
            loading={issueIndexLoading}
            onOpenIssue={openIssueFromWorkPanel}
            onPresetChange={setIssueWorkPreset}
            onRefresh={() => void loadIssueIndex(issueIndexPreset)}
            preset={issueIndexPreset}
            rows={issueIndex}
          />
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            className="agent-chat-scroll"
            onScroll={(event) => {
              stickToBottomRef.current = sentMessageScrollLockConversationRef.current === conversationId
                ? false
                : shouldStickToBottom(event.currentTarget);
              scheduleScrollMetrics(event.currentTarget);
            }}
            onPointerDown={() => {
              sentMessageScrollLockConversationRef.current = null;
            }}
            onTouchStart={() => {
              sentMessageScrollLockConversationRef.current = null;
            }}
            onWheel={() => {
              sentMessageScrollLockConversationRef.current = null;
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
                  const rowHighlighted = highlightedTranscriptRowKey === row.key;
                  const renderedRow = renderConversationRow(row, rowHighlighted);
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
                      {renderedRow}
                    </AgentTranscriptRowShell>
                  );
                })}
              </div>
            )}
          </div>

          <div className="agent-composer-region">
            {conversationId === DEFAULT_DREAM_CHANNEL_ID ? (
              <DreamLauncher
                dreamSchedule={providerSettings?.agent.dreamSchedule}
                isStreaming={runActive}
                onSettingsChanged={() => {
                  void loadProviderSettings();
                }}
              />
            ) : (
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
            )}
          </div>
        </>
      )}
      {selectedRunTarget ? (
        <Dialog
          backdropClassName="agent-run-detail-drawer-backdrop"
          label={t.agent.runDetail.detailsAriaLabel}
          onBackdropMouseDown={closeRunDetailDrawer}
          onEscapeKeyDown={closeRunDetailDrawer}
          surfaceClassName="agent-run-detail-drawer"
        >
          <AgentRunDetailsPanel
            breadcrumbRootLabel={selectedIssueDetail?.title ?? displayTitle}
            onBack={runDetailStack.length > 1
              ? goBackInRunDetailDrawer
              : issueDetailStack.length > 0
                ? closeRunDetailDrawer
                : undefined}
            onClose={closeRunDetailDrawer}
            conversationId={selectedRunTarget.conversationId}
            index={index}
            runId={selectedRunTarget.runId}
            onNodeReferenceOpen={onOpenNodeReference}
            onOpenRun={openRunInDetailDrawer}
          />
        </Dialog>
      ) : selectedIssueTarget ? (
        <Dialog
          backdropClassName="agent-run-detail-drawer-backdrop"
          focusKey={`${selectedIssueTarget.type}:${selectedIssueTarget.id}`}
          label={t.agent.issueDetail.detailsAriaLabel}
          onBackdropMouseDown={closeIssueDetailDrawer}
          onEscapeKeyDown={closeIssueDetailDrawer}
          surfaceClassName="agent-run-detail-drawer"
        >
          <AgentIssueDetailsPanel
            breadcrumbs={issueDetailStack}
            index={index}
            key={`${selectedIssueTarget.type}:${selectedIssueTarget.id}`}
            onBack={issueDetailStack.length > 1 ? goBackInIssueDetailDrawer : undefined}
            onClose={closeIssueDetailDrawer}
            onNodeReferenceOpen={onOpenNodeReference}
            onOpenIssue={openIssueInDetailDrawer}
            onOpenRunDetailsPanel={(runConversationId, runId) => {
              if (!runId) return false;
              openRunInDetailDrawer(runId, runConversationId);
              return true;
            }}
            onSelectBreadcrumb={selectIssueBreadcrumb}
            target={selectedIssueTarget}
          />
        </Dialog>
      ) : null}
    </div>
  );
}
