import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  MAX_MANAGED_ATTACHMENT_BYTES,
} from '../../../core/agentAttachmentLimits';
import type { Messages } from '../../../core/i18n';
import { officeOwnershipFileInfo } from '../../../core/officeFiles';
import type {
  RequestUserInputAnswer,
  RequestUserInputRequest,
  JsonValue,
  ProviderRetryStatus,
  RendererUserViewHints,
  ThreadAttachmentContent,
  ThreadConfigurationSummary,
  Thread,
  ThreadId,
  ThreadItem,
  ThreadResourceReference,
  ThreadUserContent,
  Turn,
} from '../../../core/agent/protocol';
import type { ThreadGoal } from '../../../core/agent/goal';
import {
  boundedToolArgumentsForDisplay,
  modelCallDisplayArguments,
  modelCallDisplayName,
} from '../../../core/agent/modelCallHistory';
import type { AgentProviderSettingsView, AgentSlashCommandView } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { useI18n, useT } from '../../i18n/I18nProvider';
import {
  acknowledgeThreadComposerContext,
  acknowledgeThreadComposerNodeReferenceRequest,
  onThreadComposerContextRequest,
  onThreadComposerNodeReferenceRequest,
  pendingComposerContexts,
  type PendingComposerContext,
} from '../agentReveal';
import {
  AttachmentIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GitForkIcon,
  ICON_SIZE,
  InfoIcon,
  LoaderIcon,
  PlanToolIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  WarningIcon,
} from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { ButtonControl } from '../../ui/primitives/ButtonControl';
import { WorkingText } from '../../ui/primitives/WorkingText';
import { ThreadGoalView } from './ThreadGoalView';
import { ThreadComposerModelControl } from './ThreadComposerModelControl';
import { UserInputRequest } from './UserInputRequest';
import {
  ThreadComposerEditor,
  type ThreadComposerDraft,
  type ThreadComposerEditorHandle,
  type ThreadComposerFileReference,
  type ThreadComposerLocalFileCandidate,
} from './ThreadComposerEditor';
import { isProviderUsable } from '../../ui/agent/providerUsability';
import {
  isThreadToolItem,
  summarizeThreadToolActivity,
  summarizeThreadToolItem,
  ThreadItemView,
  ThreadMessageCopyButton,
  ThreadToolActivityGroup,
  type ThreadDisclosureState,
  type ThreadToolItem,
} from './items/ThreadItemView';
import { isRetryableTurn, userFacingAgentError } from '../threadErrorMessage';
import { clickInstalledFocusTarget, composerRefocusDecision } from '../composerRefocus';
import {
  setThreadDisclosureOverride,
  subscribeThreadDisclosure,
  threadDisclosureSnapshot,
} from '../store/threadDisclosureStore';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import type { ActiveTurnPlan } from '../store/threadStore';
import {
  captureDisclosureScrollAnchor,
  nearestScrollContainer,
  usePendingDisclosureAnchor,
  type DisclosureScrollAnchorRestoreResult,
} from '../../ui/interactions/disclosureScrollAnchor';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { formatDateTime } from '../../ui/formatting';
import { ThreadUsageBreakdown } from './ThreadUsageBreakdown';
import {
  hasTranscriptContentBelow,
  isTranscriptFollowing,
  TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX,
} from '../threadScrollFollow';
import {
  collaborationResultSnapshot,
  projectSubagentsForTurn,
  type SubagentTurnProjection,
} from '../subagentPresentation';
import { classifyNewThreadCommand } from '../threadComposerCommands';

interface ThreadViewProps {
  readonly composerEnabled: boolean;
  readonly composerFocusToken: number;
  readonly goal: ThreadGoal | null;
  readonly index: DocumentIndex;
  readonly configuration: ThreadConfigurationSummary | null;
  readonly providerSettings: AgentProviderSettingsView | null;
  readonly providerSettingsLoaded: boolean;
  readonly slashCommands: readonly AgentSlashCommandView[];
  readonly threadModelProvider: string;
  readonly threadCwd: string;
  readonly threadId: string;
  readonly threadsById: ReadonlyMap<ThreadId, Thread>;
  readonly latestTurnByThread: ReadonlyMap<ThreadId, Turn>;
  readonly turns: readonly Turn[];
  readonly inputRequest: RequestUserInputRequest | null;
  /** The run is blocked on the user. Working phrases become static and the
   *  divider names the wait; elapsed time remains the Turn's wall-clock span. */
  readonly waitingOnUserInput: boolean;
  readonly providerRetry: { readonly turnId: string; readonly status: ProviderRetryStatus } | null;
  readonly plan: ActiveTurnPlan | null;
  readonly threadCreationBlocked: boolean;
  readonly threadCreationPending: boolean;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onContinueInNewChat: (turn: Turn) => Promise<void>;
  readonly onCreateThread: () => Promise<boolean>;
  readonly onInterrupt: () => Promise<void>;
  /** Stop one delegated child from the card, or the child Thread view header. */
  readonly onInterruptThread: (threadId: string) => Promise<void>;
  readonly onConfigurationChange: (configuration: ThreadConfigurationSummary) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onOpenTurnDetails: (turn: Turn) => void;
  /** Turn Details for a delegated child, read inside its own run detail. */
  readonly onOpenSubagentTurnDetails?: (threadId: string, turnId: string) => void;
  /**
   * Present only INSIDE a Subagent run detail. A delegation row there swaps
   * that container's contents instead of opening a second one inside it —
   * nesting would put a scroll region inside a scroll region. Its presence is
   * also what makes this view EMBEDDED: a control that cannot act on a child
   * Thread is hidden, which is a narrower thing than "has no composer" — an
   * Automation transcript has no composer and can still be forked.
   */
  readonly onSubagentDrill?: (threadId: string) => void;
  readonly onReadToolOutput: (turnId: string, item: ThreadToolItem) => Promise<string | null>;
  readonly onReadToolArguments: (turnId: string, item: ThreadToolItem) => Promise<JsonValue | null>;
  readonly onSend: (content: readonly ThreadUserContent[]) => Promise<Turn | null>;
  readonly onSubmitUserInput: (answers: readonly RequestUserInputAnswer[]) => Promise<void>;
  readonly userView: RendererUserViewHints;
}

const MAX_ATTACHMENTS = 6;
const ATTACHMENT_ERROR_TIMEOUT_MS = 5_000;
const TRANSCRIPT_ROW_GAP_PX = 12;
const TRANSCRIPT_ROW_ESTIMATE_PX = 104;
const TRANSCRIPT_VIRTUAL_MIN_TURNS = 40;
const TRANSCRIPT_VIRTUAL_OVERSCAN_PX = 720;
const MAX_CACHED_THREAD_UI_STATES = 32;
/**
 * A restore corrects itself against the anchored row, and each correction can
 * change what is rendered and therefore where that row sits. The cap releases a
 * Thread whose geometry cannot satisfy the anchor at all — content removed, a
 * resized viewport — at the nearest reachable offset, rather than letting it
 * rewrite `scrollTop` on every layout pass for the life of the view.
 */
const TRANSCRIPT_SCROLL_RESTORE_ATTEMPTS = 8;
const TRANSCRIPT_SCROLL_INTENT_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
]);
const EMPTY_COMPOSER_DRAFT: ThreadComposerDraft = {
  content: [],
  empty: true,
  fileRefs: [],
  text: '',
};

type NewThreadValidation = 'providerRequired' | 'structuredContent' | null;

/**
 * The Turn the reader is looking at, and where it sits in the viewport. A raw
 * `scrollTop` does not survive a remount: `content-visibility: auto` gives every
 * Turn above the viewport its intrinsic placeholder height until it renders, so
 * the same offset lands further along the conversation by the accumulated
 * difference. The Turn is what the reader remembers, so the Turn is what we
 * restore.
 */
interface TranscriptAnchor {
  readonly offset: number;
  readonly turnId: string;
}

interface ThreadScrollSnapshot {
  readonly anchor: TranscriptAnchor | null;
  readonly follow: boolean;
  readonly top: number;
}

interface PendingScrollRestore {
  readonly anchor: TranscriptAnchor | null;
  readonly attempts: number;
  /** Transcript height at the previous attempt; growth means it is still settling. */
  readonly scrollHeight: number;
  readonly top: number;
}

interface PendingSendAnchor {
  readonly releaseFollowOnAnchor: boolean;
  readonly threadId: string;
  targetTurnId: string | null;
}

interface SendAnchorSpacer {
  readonly height: number;
  readonly releaseFollowOnAnchor: boolean;
  readonly targetTop: number;
  readonly turnId: string;
}

interface PendingVirtualScrollAdjustment {
  applyAtMeasureVersion: number;
  top: number;
}

interface VirtualTurnItem {
  readonly height: number;
  readonly top: number;
}

interface VirtualTurnLayout {
  readonly items: readonly VirtualTurnItem[];
  readonly totalHeight: number;
}

const threadScrollSnapshots = new Map<string, ThreadScrollSnapshot>();
const threadTurnHeights = new Map<string, Map<string, number>>();

function setBoundedThreadValue<Value>(map: Map<string, Value>, threadId: string, value: Value): void {
  map.delete(threadId);
  map.set(threadId, value);
  while (map.size > MAX_CACHED_THREAD_UI_STATES) {
    const oldestThreadId = map.keys().next().value;
    if (oldestThreadId === undefined) return;
    map.delete(oldestThreadId);
  }
}

function cachedTurnHeights(threadId: string): Map<string, number> {
  const existing = threadTurnHeights.get(threadId);
  if (existing) {
    setBoundedThreadValue(threadTurnHeights, threadId, existing);
    return existing;
  }
  const created = new Map<string, number>();
  setBoundedThreadValue(threadTurnHeights, threadId, created);
  return created;
}

function cacheThreadScrollSnapshot(threadId: string, snapshot: ThreadScrollSnapshot): void {
  setBoundedThreadValue(threadScrollSnapshots, threadId, snapshot);
}

/**
 * This transcript's OWN Turn rows.
 *
 * A Subagent run detail renders a full ThreadView inside one of these rows, and
 * that inner view emits Turn rows of its own — scrolled independently, so their
 * tops are neither this transcript's nor monotonic in document order, which is
 * the precondition the anchor search below depends on. Left in, a child's row
 * could be cached as the parent's reading anchor and restored against a row
 * clipped inside a fixed-height box.
 */
function ownTranscriptRows(scroll: HTMLElement): HTMLElement[] {
  return [...scroll.querySelectorAll<HTMLElement>('[data-thread-turn-row]')]
    .filter((row) => !row.closest('.thread-subagent-detail'));
}

/**
 * The first Turn row whose bottom is still below the viewport top — the one the
 * reader sees at the top of the transcript. Rows are laid out in document order,
 * so their edges are monotonic and a binary search costs about six rect reads
 * instead of one per row on a path that runs per scroll event.
 */
function readTranscriptAnchor(scroll: HTMLElement): TranscriptAnchor | null {
  const rows = ownTranscriptRows(scroll);
  if (rows.length === 0) return null;
  const viewportTop = scroll.getBoundingClientRect().top;
  let low = 0;
  let high = rows.length - 1;
  let anchor: TranscriptAnchor | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle]!;
    const bounds = row.getBoundingClientRect();
    // Row *tops* are what the search may rely on. A virtualized row is placed at
    // its layout slot, so tops stay ordered even on the frame a Turn renders
    // taller than the estimate it was given — its bottom overlaps the next row's
    // and bottoms are momentarily unsorted.
    if (bounds.top <= viewportTop) {
      const turnId = row.dataset.threadTurnRow;
      if (turnId) anchor = { offset: bounds.top - viewportTop, turnId };
      low = middle + 1;
    } else high = middle - 1;
  }
  if (anchor) return anchor;
  // Every row starts below the viewport top: the reader is above the transcript,
  // on the goal header or the leading gap. The first row still fixes the view.
  const first = rows[0]!;
  const firstTurnId = first.dataset.threadTurnRow;
  return firstTurnId
    ? { offset: first.getBoundingClientRect().top - viewportTop, turnId: firstTurnId }
    : null;
}

function estimateTurnHeight(turn: Turn): number {
  let textLength = 0;
  let blockCount = 0;
  for (const item of turn.items) {
    blockCount += 1;
    switch (item.type) {
      case 'userMessage':
        textLength += item.content.reduce((total, content) => (
          total + (content.type === 'text' ? content.text.length : 48)
        ), 0);
        break;
      case 'agentMessage':
        textLength += item.text.length;
        break;
      case 'reasoning':
        textLength += [...item.summary, ...item.content].join('\n').length;
        break;
      default:
        textLength += 48;
        break;
    }
  }
  return Math.max(
    TRANSCRIPT_ROW_ESTIMATE_PX,
    Math.ceil(textLength / 84) * 24 + Math.max(1, blockCount) * 24 + 40,
  );
}

function buildVirtualTurnLayout(
  turns: readonly Turn[],
  measuredHeights: ReadonlyMap<string, number>,
): VirtualTurnLayout {
  const items: VirtualTurnItem[] = [];
  let top = 0;
  for (const turn of turns) {
    const height = measuredHeights.get(turn.id) ?? estimateTurnHeight(turn);
    items.push({ height, top });
    top += height + TRANSCRIPT_ROW_GAP_PX;
  }
  return {
    items,
    totalHeight: turns.length > 0 ? top - TRANSCRIPT_ROW_GAP_PX : 0,
  };
}

function firstTurnEndingAfter(items: readonly VirtualTurnItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const item = items[middle]!;
    if (item.top + item.height < y) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstTurnStartingAfter(items: readonly VirtualTurnItem[], y: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (items[middle]!.top <= y) low = middle + 1;
    else high = middle;
  }
  return low;
}

function visibleTurnRange(
  layout: VirtualTurnLayout,
  scrollTop: number,
  viewportHeight: number,
): { readonly end: number; readonly start: number } {
  const minimumY = Math.max(0, scrollTop - TRANSCRIPT_VIRTUAL_OVERSCAN_PX);
  const maximumY = scrollTop + viewportHeight + TRANSCRIPT_VIRTUAL_OVERSCAN_PX;
  const start = Math.max(0, firstTurnEndingAfter(layout.items, minimumY) - 1);
  const end = Math.min(layout.items.length, firstTurnStartingAfter(layout.items, maximumY) + 1);
  return { end: Math.max(end, start + 1), start };
}
interface PreparedComposerAttachment {
  readonly content: ThreadAttachmentContent;
  readonly previewUrl?: string;
  readonly reference: ThreadComposerFileReference;
  readonly sourceKey: string;
}

export function ThreadView({
  composerEnabled,
  composerFocusToken,
  configuration,
  goal,
  index,
  providerSettings,
  providerSettingsLoaded,
  plan,
  slashCommands,
  threadCwd,
  threadModelProvider,
  threadId,
  threadsById,
  latestTurnByThread,
  turns,
  inputRequest,
  waitingOnUserInput,
  providerRetry,
  threadCreationBlocked,
  threadCreationPending,
  onEditUserMessage,
  onContinueInNewChat,
  onCreateThread,
  onInterrupt,
  onInterruptThread,
  onConfigurationChange,
  onOpenNodeReference,
  onOpenThread,
  onOpenSubagentTurnDetails,
  onSubagentDrill,
  onOpenTurnDetails,
  onReadToolArguments,
  onReadToolOutput,
  onSend,
  onSubmitUserInput,
  userView,
}: ThreadViewProps) {
  const t = useT();
  const waitingForInput = Boolean(inputRequest);
  const initialScrollSnapshot = threadScrollSnapshots.get(threadId);
  const [draft, setDraft] = useState<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newThreadValidation, setNewThreadValidation] = useState<NewThreadValidation>(null);
  const [failedThreadCreationFocusToken, setFailedThreadCreationFocusToken] = useState(0);
  const [attachments, setAttachments] = useState<ThreadAttachmentContent[]>([]);
  const [recentLocalFiles, setRecentLocalFiles] = useState<ThreadComposerLocalFileCandidate[]>([]);
  const [follow, setFollow] = useState(initialScrollSnapshot?.follow ?? true);
  const [sendAnchorSpacer, setSendAnchorSpacer] = useState<SendAnchorSpacer | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const disclosureAnchorRunwayRef = useRef(0);
  const composerRef = useRef<ThreadComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const bottomScrollFrameReplayRef = useRef(false);
  const bottomPinDeferredRef = useRef(false);
  const pendingSendAnchorFrameRef = useRef<number | null>(null);
  const sendAnchorLayoutDeferredRef = useRef(false);
  const scheduleBottomPinRef = useRef<(replayAfterAnchor?: boolean) => void>(() => undefined);
  const scheduleSendAnchorLayoutRef = useRef<() => void>(() => undefined);
  const scrollMetricsFrameRef = useRef<number | null>(null);
  const virtualScrollAdjustmentFrameRef = useRef<number | null>(null);
  const followRef = useRef(follow);
  const synchronizedScrollTopRef = useRef(initialScrollSnapshot?.top ?? 0);
  const expectedProgrammaticScrollTopRef = useRef<number | null>(null);
  const pendingVirtualScrollAdjustmentRef = useRef<PendingVirtualScrollAdjustment | null>(null);
  const pendingSendScrollRef = useRef<PendingSendAnchor | null>(null);
  const sendAnchorSpacerRef = useRef<SendAnchorSpacer | null>(null);
  const scrollRestoreRef = useRef<PendingScrollRestore | null>(
    initialScrollSnapshot?.follow === false
      ? {
        anchor: initialScrollSnapshot.anchor,
        attempts: 0,
        scrollHeight: 0,
        top: initialScrollSnapshot.top,
      }
      : null,
  );
  const attachmentsRef = useRef<ThreadAttachmentContent[]>([]);
  const attachmentOperationTailRef = useRef<Promise<void>>(Promise.resolve());
  const attachmentLifecycleControllerRef = useRef<AbortController | null>(null);
  const attachmentPreviewUrlsRef = useRef(new Map<string, string>());
  const attachmentSourceKeysRef = useRef(new Map<string, string>());
  const draftRef = useRef<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const handledFocusTokenRef = useRef(0);
  const handledFailedThreadCreationFocusTokenRef = useRef(0);
  const sendingRef = useRef(false);
  const measuredTurnHeights = useMemo(() => cachedTurnHeights(threadId), [threadId]);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [pendingSendVersion, setPendingSendVersion] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState({
    hasContentBelow: false,
    height: 0,
    top: 0,
  });
  const subscribeToDisclosures = useCallback(
    (onChange: () => void) => subscribeThreadDisclosure(threadId, onChange),
    [threadId],
  );
  const readDisclosures = useCallback(() => threadDisclosureSnapshot(threadId), [threadId]);
  const disclosureOverrides = useSyncExternalStore(subscribeToDisclosures, readDisclosures);
  // Session-scoped, per Thread (ThreadView is keyed by Thread): reasoning Items
  // that have been open by default stay open even after their row unmounts to
  // virtualization. Deliberately not persisted — see the latch comment below.
  const latchedReasoning = useRef(new Set<string>()).current;
  const liveReasoningSeen = useRef(new Set<string>()).current;
  const activeTurn = useMemo(() => findActiveTurn(turns), [turns]);
  const activePlan = activeTurn && plan?.turnId === activeTurn.id ? plan : null;
  const activeWorkingTextEnabled = !waitingOnUserInput && providerRetry === null;
  const editableTurnId = useMemo(() => latestUserMessageTurnId(turns), [turns]);
  const turnCountRef = useRef(turns.length);
  turnCountRef.current = turns.length;
  const hasDraft = !draft.empty;
  const itemCount = turns.reduce((count, turn) => count + turn.items.length, 0);
  const bottomPinContentRef = useRef({ itemCount, turns });
  const selectedProviderId = configuration?.modelProvider ?? threadModelProvider;
  const selectedProvider = providerSettings?.providers.find(
    (provider) => provider.providerId === selectedProviderId,
  );
  const providerBlocksSend = providerSettingsLoaded && (!providerSettings
    || !selectedProvider
    || !isProviderUsable(providerSettings, selectedProvider));
  const hasUsableProvider = Boolean(providerSettings?.providers.some(
    (provider) => isProviderUsable(providerSettings, provider),
  ));
  const newThreadCommandState = classifyNewThreadCommand(draft);
  const newThreadAction = newThreadCommandState !== 'ordinary';
  const composerActionDisabled = !hasDraft
    || sending
    || threadCreationPending
    || (newThreadCommandState === 'ready' ? threadCreationBlocked : false)
    || (newThreadCommandState === 'ordinary' ? providerBlocksSend : false);
  const composerActionLabel = newThreadAction
    ? t.agent.thread.new
    : activeTurn ? t.agent.thread.steer : t.agent.thread.send;
  const composerActionTitle = (
    (newThreadCommandState === 'ready' && threadCreationBlocked)
    || (newThreadCommandState === 'ordinary' && providerBlocksSend)
  ) ? t.agent.thread.providerRequired : composerActionLabel;
  const newThreadValidationMessage = newThreadValidation === 'structuredContent'
    ? t.agent.composer.newThreadStructuredContentError
    : newThreadValidation === 'providerRequired'
      ? t.agent.thread.providerRequired
      : null;
  const virtualLayout = useMemo(
    () => buildVirtualTurnLayout(turns, measuredTurnHeights),
    [measureVersion, measuredTurnHeights, turns],
  );
  const virtualized = turns.length > TRANSCRIPT_VIRTUAL_MIN_TURNS;
  const virtualRange = virtualized
    ? visibleTurnRange(virtualLayout, scrollMetrics.top, scrollMetrics.height)
    : { end: turns.length, start: 0 };
  const visibleTurns = turns.slice(virtualRange.start, virtualRange.end);
  const virtualStateRef = useRef({ layout: virtualLayout, turns, virtualized });
  virtualStateRef.current = { layout: virtualLayout, turns, virtualized };

  const setFollowValue = useCallback((nextFollow: boolean) => {
    followRef.current = nextFollow;
    setFollow((current) => current === nextFollow ? current : nextFollow);
  }, []);

  const cancelPendingVirtualScrollAdjustment = useCallback(() => {
    if (virtualScrollAdjustmentFrameRef.current !== null) {
      window.cancelAnimationFrame(virtualScrollAdjustmentFrameRef.current);
      virtualScrollAdjustmentFrameRef.current = null;
    }
    pendingVirtualScrollAdjustmentRef.current = null;
  }, []);

  const updateSendAnchorSpacer = useCallback((next: SendAnchorSpacer | null) => {
    sendAnchorSpacerRef.current = next;
    setSendAnchorSpacer((current) => (
      current?.height === next?.height
        && current?.releaseFollowOnAnchor === next?.releaseFollowOnAnchor
        && current?.targetTop === next?.targetTop
        && current?.turnId === next?.turnId
        ? current
        : next
    ));
  }, []);

  const clearSendAnchorSpacer = useCallback(() => {
    if (!sendAnchorSpacerRef.current) return;
    updateSendAnchorSpacer(null);
  }, [updateSendAnchorSpacer]);

  const updateScrollMetrics = useCallback((element: HTMLDivElement) => {
    const spacer = element.querySelector<HTMLElement>('.thread-send-anchor-spacer');
    const transcriptScrollHeight = Math.max(
      0,
      element.scrollHeight
        - (spacer?.getBoundingClientRect().height ?? 0)
        - disclosureAnchorRunwayRef.current,
    );
    const next = {
      hasContentBelow: hasTranscriptContentBelow({
        clientHeight: element.clientHeight,
        scrollHeight: transcriptScrollHeight,
        scrollTop: element.scrollTop,
      }),
      height: element.clientHeight,
      top: element.scrollTop,
    };
    setScrollMetrics((current) => (
      current.hasContentBelow === next.hasContentBelow
        && Math.abs(current.height - next.height) < 1
        && Math.abs(current.top - next.top) < 1
        ? current
        : next
    ));
  }, []);

  const synchronizeScrollPosition = useCallback((element: HTMLDivElement) => {
    synchronizedScrollTopRef.current = element.scrollTop;
    // A pending restore is still travelling toward the saved position, and the
    // geometry it passes through is not the reader's. Deriving follow from it
    // hands the transcript to the bottom pin the moment an unsettled maximum
    // clamps the write near the end; re-caching from it overwrites the very
    // snapshot the restore is aiming at. The settling attempt clears the request
    // before its write, so the final position still lands in both.
    if (scrollRestoreRef.current) {
      updateScrollMetrics(element);
      return;
    }
    const nextFollow = isTranscriptFollowing(element);
    setFollowValue(nextFollow);
    cacheThreadScrollSnapshot(threadId, {
      // A followed Thread resumes at the bottom, so it needs no anchor and does
      // not pay for reading one on the streaming path.
      anchor: nextFollow ? null : readTranscriptAnchor(element),
      follow: nextFollow,
      top: element.scrollTop,
    });
    updateScrollMetrics(element);
  }, [setFollowValue, threadId, updateScrollMetrics]);

  const releaseUnsynchronizedUpwardScroll = useCallback((element: HTMLDivElement) => {
    const synchronizedTop = synchronizedScrollTopRef.current;
    const maximumTop = Math.max(0, element.scrollHeight - element.clientHeight);
    if (
      element.scrollTop >= synchronizedTop - 1
      || maximumTop < synchronizedTop - 1
    ) return false;
    expectedProgrammaticScrollTopRef.current = null;
    scrollRestoreRef.current = null;
    synchronizeScrollPosition(element);
    return true;
  }, [synchronizeScrollPosition]);

  const setProgrammaticScrollTop = useCallback((element: HTMLDivElement, top: number) => {
    element.scrollTop = top;
    expectedProgrammaticScrollTopRef.current = element.scrollTop;
    synchronizeScrollPosition(element);
  }, [synchronizeScrollPosition]);

  const scheduleScrollMetrics = useCallback((element: HTMLDivElement) => {
    if (scrollMetricsFrameRef.current !== null) return;
    scrollMetricsFrameRef.current = window.requestAnimationFrame(() => {
      scrollMetricsFrameRef.current = null;
      synchronizeScrollPosition(element);
    });
  }, [synchronizeScrollPosition]);

  // Supply only the tail space needed when the natural scroll range cannot preserve the activated control.
  const setDisclosureAnchorRunway = useCallback((height: number) => {
    const nextHeight = Math.max(0, height);
    if (Math.abs(disclosureAnchorRunwayRef.current - nextHeight) < 0.01) return;
    disclosureAnchorRunwayRef.current = nextHeight;
    const content = transcriptContentRef.current;
    if (!content) return;
    if (nextHeight > 0) content.style.paddingBottom = `${nextHeight}px`;
    else content.style.removeProperty('padding-bottom');
  }, []);

  const shrinkDisclosureAnchorRunwayToRequired = useCallback((scroll: HTMLDivElement) => {
    const currentRunway = disclosureAnchorRunwayRef.current;
    if (currentRunway <= 0) return;
    const naturalMaximumTop = Math.max(
      0,
      scroll.scrollHeight - currentRunway - scroll.clientHeight,
    );
    const requiredRunway = Math.max(0, scroll.scrollTop - naturalMaximumTop);
    if (requiredRunway < currentRunway) setDisclosureAnchorRunway(requiredRunway);
  }, [setDisclosureAnchorRunway]);

  const handleDisclosureAnchorRestore = useCallback((result: DisclosureScrollAnchorRestoreResult) => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (result.remainingDelta > 0) {
      setDisclosureAnchorRunway(disclosureAnchorRunwayRef.current + result.remainingDelta);
      scroll.scrollTop += result.remainingDelta;
    }
    shrinkDisclosureAnchorRunwayToRequired(scroll);
    expectedProgrammaticScrollTopRef.current = scroll.scrollTop;
    synchronizeScrollPosition(scroll);
  }, [setDisclosureAnchorRunway, shrinkDisclosureAnchorRunwayToRequired, synchronizeScrollPosition]);

  const resumeDeferredDisclosureScrollWork = useCallback(() => {
    if (sendAnchorLayoutDeferredRef.current) {
      sendAnchorLayoutDeferredRef.current = false;
      scheduleSendAnchorLayoutRef.current();
    }
    if (bottomPinDeferredRef.current) {
      bottomPinDeferredRef.current = false;
      scheduleBottomPinRef.current();
    }
  }, []);

  const {
    cancelPendingAnchor,
    capturePendingAnchor,
    hasPendingAnchor,
    holdUntilSettled,
    restorePendingAnchor,
  } = usePendingDisclosureAnchor(
    handleDisclosureAnchorRestore,
    resumeDeferredDisclosureScrollWork,
  );

  const reconcileDisclosureAnchorRunway = useCallback((scroll: HTMLDivElement) => {
    const currentRunway = disclosureAnchorRunwayRef.current;
    if (currentRunway <= 0 || hasPendingAnchor()) return;
    shrinkDisclosureAnchorRunwayToRequired(scroll);
  }, [hasPendingAnchor, shrinkDisclosureAnchorRunwayToRequired]);

  const captureLocalDisclosureAnchor = useCallback((anchorElement: HTMLElement | null) => {
    cancelPendingVirtualScrollAdjustment();
    const scroller = nearestScrollContainer(anchorElement, scrollRef.current);
    capturePendingAnchor(captureDisclosureScrollAnchor(anchorElement, scroller));
  }, [cancelPendingVirtualScrollAdjustment, capturePendingAnchor]);

  const expandState = useMemo<ThreadDisclosureState>(() => ({
    captureAnchor: captureLocalDisclosureAnchor,
    holdAnchorUntilSettled: holdUntilSettled,
    isExpanded: (id, defaultExpanded = false) => disclosureOverrides[id] ?? defaultExpanded,
    restoreAnchor: restorePendingAnchor,
    toggle: (id, currentlyExpanded, anchorElement) => {
      cancelPendingVirtualScrollAdjustment();
      const scroller = nearestScrollContainer(anchorElement ?? null, scrollRef.current);
      const resolveElement = scroller
        ? () => scroller.querySelector<HTMLElement>(
          `[data-thread-disclosure-id="${CSS.escape(id)}"]`,
        )
        : undefined;
      capturePendingAnchor(captureDisclosureScrollAnchor(
        anchorElement ?? null,
        scroller,
        resolveElement,
      ));
      setThreadDisclosureOverride(threadId, id, !currentlyExpanded);
    },
  }), [
    cancelPendingVirtualScrollAdjustment,
    captureLocalDisclosureAnchor,
    capturePendingAnchor,
    disclosureOverrides,
    holdUntilSettled,
    restorePendingAnchor,
    threadId,
  ]);

  const attemptScrollRestore = useCallback(() => {
    const request = scrollRestoreRef.current;
    const scroll = scrollRef.current;
    if (!request || !scroll || turnCountRef.current === 0) return;
    // An activated disclosure holds the position the reader just asked for. The
    // restore now outlives its first application, so it has to yield here like
    // every other writer of scrollTop — and without spending an attempt, since
    // nothing about the restore was tried.
    if (hasPendingAnchor()) return;
    const maximumTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const anchor = request.anchor;
    const anchorRow = anchor
      ? ownTranscriptRows(scroll).find((row) => row.dataset.threadTurnRow === anchor.turnId) ?? null
      : null;
    // The anchored row carries the reading position; the saved offset is only
    // how we get near enough for a virtualized Thread to render that row.
    const requestedTop = anchor && anchorRow
      ? scroll.scrollTop
        + (anchorRow.getBoundingClientRect().top - scroll.getBoundingClientRect().top)
        - anchor.offset
      : request.top;
    const nextTop = Math.max(0, Math.min(maximumTop, requestedTop));
    const attempts = request.attempts + 1;
    // Holding the anchor until the transcript stops growing covers the Turns
    // above that have no measured height to place them by: they arrive at their
    // real height only once rendering reaches them, and releasing on the first
    // agreement would leave the reader wherever that growth pushed them.
    const settled = !anchor
      || (anchorRow !== null
        && Math.abs(nextTop - scroll.scrollTop) < 1
        && scroll.scrollHeight === request.scrollHeight)
      || attempts >= TRANSCRIPT_SCROLL_RESTORE_ATTEMPTS;
    scrollRestoreRef.current = settled
      ? null
      : { ...request, attempts, scrollHeight: scroll.scrollHeight };
    setProgrammaticScrollTop(scroll, nextTop);
  }, [hasPendingAnchor, setProgrammaticScrollTop]);

  const scheduleBottomPin = useCallback((replayAfterAnchor = false) => {
    if (!followRef.current) {
      bottomPinDeferredRef.current = false;
      bottomScrollFrameReplayRef.current = false;
      return;
    }
    if (hasPendingAnchor()) {
      if (replayAfterAnchor) bottomPinDeferredRef.current = true;
      return;
    }
    const currentScroll = scrollRef.current;
    if (currentScroll && releaseUnsynchronizedUpwardScroll(currentScroll)) {
      bottomPinDeferredRef.current = false;
      bottomScrollFrameReplayRef.current = false;
      return;
    }
    if (bottomScrollFrameRef.current !== null) {
      if (replayAfterAnchor) bottomScrollFrameReplayRef.current = true;
      return;
    }
    bottomPinDeferredRef.current = false;
    bottomScrollFrameReplayRef.current = replayAfterAnchor;
    bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      const replayPendingPin = bottomScrollFrameReplayRef.current;
      bottomScrollFrameReplayRef.current = false;
      const scroll = scrollRef.current;
      if (!scroll || !followRef.current) return;
      if (hasPendingAnchor()) {
        if (replayPendingPin) bottomPinDeferredRef.current = true;
        return;
      }
      if (releaseUnsynchronizedUpwardScroll(scroll)) return;
      setProgrammaticScrollTop(scroll, scroll.scrollHeight);
    });
  }, [hasPendingAnchor, releaseUnsynchronizedUpwardScroll, setProgrammaticScrollTop]);

  const pinStructuralBottomBeforePaint = useCallback(() => {
    const scroll = scrollRef.current;
    if (
      !scroll
      || !followRef.current
      || hasPendingAnchor()
      || pendingSendScrollRef.current
      || sendAnchorSpacerRef.current
      || releaseUnsynchronizedUpwardScroll(scroll)
    ) return;
    setProgrammaticScrollTop(scroll, scroll.scrollHeight);
  }, [hasPendingAnchor, releaseUnsynchronizedUpwardScroll, setProgrammaticScrollTop]);

  const scheduleSendAnchorLayout = useCallback(() => {
    if (!pendingSendScrollRef.current && !sendAnchorSpacerRef.current) {
      sendAnchorLayoutDeferredRef.current = false;
      return;
    }
    if (hasPendingAnchor()) {
      sendAnchorLayoutDeferredRef.current = true;
      return;
    }
    if (pendingSendAnchorFrameRef.current !== null) return;
    sendAnchorLayoutDeferredRef.current = false;
    pendingSendAnchorFrameRef.current = window.requestAnimationFrame(() => {
      pendingSendAnchorFrameRef.current = null;
      if (hasPendingAnchor()) {
        sendAnchorLayoutDeferredRef.current = true;
        return;
      }
      const pending = pendingSendScrollRef.current;
      const currentSpacer = sendAnchorSpacerRef.current;
      const scroll = scrollRef.current;
      const targetTurnId = pending?.targetTurnId ?? currentSpacer?.turnId;
      if (!targetTurnId || !scroll) return;
      if (
        pending
        && virtualStateRef.current.virtualized
        && !measuredTurnHeights.has(targetTurnId)
      ) return;
      const row = scroll.querySelector<HTMLElement>(
        `[data-thread-turn-row="${CSS.escape(targetTurnId)}"]`,
      );
      const target = row?.querySelector<HTMLElement>('.thread-user-message') ?? row;
      let naturalTargetTop = currentSpacer?.turnId === targetTurnId
        ? currentSpacer.targetTop
        : null;
      if (target) {
        const scrollRect = scroll.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const topInset = Number.parseFloat(window.getComputedStyle(scroll).paddingTop) || 0;
        naturalTargetTop = Math.max(
          0,
          scroll.scrollTop + targetRect.top - scrollRect.top - topInset,
        );
      }
      if (naturalTargetTop === null) return;
      const releaseFollowOnAnchor = pending?.releaseFollowOnAnchor
        ?? currentSpacer?.releaseFollowOnAnchor
        ?? false;
      const renderedSpacer = scroll.querySelector<HTMLElement>('.thread-send-anchor-spacer');
      const contentScrollHeight = Math.max(
        0,
        scroll.scrollHeight
          - (renderedSpacer?.getBoundingClientRect().height ?? 0)
          - disclosureAnchorRunwayRef.current,
      );
      const requiredScrollHeight = naturalTargetTop
        + scroll.clientHeight
        + (releaseFollowOnAnchor
          ? TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX + 2
          : 0);
      const nextSpacerHeight = Math.max(
        0,
        Math.ceil(requiredScrollHeight - contentScrollHeight),
      );
      if (nextSpacerHeight > 0) {
        const nextSpacer = {
          height: nextSpacerHeight,
          releaseFollowOnAnchor,
          targetTop: naturalTargetTop,
          turnId: targetTurnId,
        };
        if (
          currentSpacer?.height !== nextSpacer.height
          || currentSpacer.releaseFollowOnAnchor !== nextSpacer.releaseFollowOnAnchor
          || currentSpacer.targetTop !== nextSpacer.targetTop
          || currentSpacer.turnId !== nextSpacer.turnId
        ) {
          updateSendAnchorSpacer(nextSpacer);
          return;
        }
      } else if (currentSpacer?.turnId === targetTurnId) {
        updateSendAnchorSpacer(null);
        if (pending) return;
      }
      if (!pending) return;
      const maximumTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const targetTop = Math.max(0, Math.min(
        maximumTop,
        naturalTargetTop,
      ));
      pendingSendScrollRef.current = null;
      setProgrammaticScrollTop(scroll, targetTop);
    });
  }, [hasPendingAnchor, measuredTurnHeights, setProgrammaticScrollTop, updateSendAnchorSpacer]);

  useLayoutEffect(() => {
    scheduleBottomPinRef.current = scheduleBottomPin;
    scheduleSendAnchorLayoutRef.current = scheduleSendAnchorLayout;
  }, [scheduleBottomPin, scheduleSendAnchorLayout]);

  const measureTurn = useCallback((turnId: string, height: number, element: HTMLDivElement) => {
    const current = measuredTurnHeights.get(turnId);
    if (current !== undefined && Math.abs(current - height) < 1) return;
    const state = virtualStateRef.current;
    const turnIndex = state.turns.findIndex((turn) => turn.id === turnId);
    const turn = state.turns[turnIndex];
    const previousHeight = current ?? (turn ? estimateTurnHeight(turn) : height);
    const delta = height - previousHeight;
    const scroll = scrollRef.current;
    if (
      state.virtualized
      && scroll
      && !followRef.current
      && !hasPendingAnchor()
      && Math.abs(delta) >= 1
    ) {
      const rowTop = element.getBoundingClientRect().top;
      const viewportTop = scroll.getBoundingClientRect().top;
      if (rowTop + height <= viewportTop + 1) {
        const pendingAdjustment = pendingVirtualScrollAdjustmentRef.current;
        pendingVirtualScrollAdjustmentRef.current = {
          applyAtMeasureVersion: pendingAdjustment?.applyAtMeasureVersion ?? 0,
          top: (pendingAdjustment?.top ?? scroll.scrollTop) + delta,
        };
      }
    }
    measuredTurnHeights.set(turnId, height);
    setMeasureVersion((version) => {
      const pendingAdjustment = pendingVirtualScrollAdjustmentRef.current;
      if (pendingAdjustment) pendingAdjustment.applyAtMeasureVersion = version + 1;
      return version + 1;
    });
    if (pendingSendScrollRef.current?.targetTurnId === turnId) scheduleSendAnchorLayout();
  }, [hasPendingAnchor, measuredTurnHeights, scheduleSendAnchorLayout]);

  useLayoutEffect(() => {
    const pendingAdjustment = pendingVirtualScrollAdjustmentRef.current;
    if (
      !pendingAdjustment
      || measureVersion < pendingAdjustment.applyAtMeasureVersion
    ) return;
    if (virtualScrollAdjustmentFrameRef.current !== null) {
      window.cancelAnimationFrame(virtualScrollAdjustmentFrameRef.current);
    }
    virtualScrollAdjustmentFrameRef.current = window.requestAnimationFrame(() => {
      virtualScrollAdjustmentFrameRef.current = null;
      const latestAdjustment = pendingVirtualScrollAdjustmentRef.current;
      pendingVirtualScrollAdjustmentRef.current = null;
      const scroll = scrollRef.current;
      if (!latestAdjustment || !scroll || followRef.current || hasPendingAnchor()) return;
      setProgrammaticScrollTop(scroll, latestAdjustment.top);
    });
  }, [hasPendingAnchor, measureVersion, setProgrammaticScrollTop]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return undefined;
    const synchronizeLayout = () => {
      reconcileDisclosureAnchorRunway(scroll);
      updateScrollMetrics(scroll);
      attemptScrollRestore();
      scheduleSendAnchorLayout();
      scheduleBottomPin();
    };
    synchronizeLayout();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(synchronizeLayout);
    observer.observe(scroll);
    const content = transcriptContentRef.current;
    const composer = composerRegionRef.current;
    if (content) observer.observe(content);
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [
    attemptScrollRestore,
    reconcileDisclosureAnchorRunway,
    scheduleBottomPin,
    scheduleSendAnchorLayout,
    updateScrollMetrics,
  ]);

  useLayoutEffect(() => {
    const previousContent = bottomPinContentRef.current;
    const structuralItemAdded = itemCount > previousContent.itemCount;
    const replayBottomPin = previousContent.itemCount !== itemCount
      || previousContent.turns !== turns;
    bottomPinContentRef.current = { itemCount, turns };
    attemptScrollRestore();
    scheduleSendAnchorLayout();
    if (structuralItemAdded) pinStructuralBottomBeforePaint();
    scheduleBottomPin(replayBottomPin);
  }, [
    attemptScrollRestore,
    itemCount,
    pendingSendVersion,
    pinStructuralBottomBeforePaint,
    scheduleBottomPin,
    scheduleSendAnchorLayout,
    sendAnchorSpacer,
    turns,
    virtualLayout.totalHeight,
    virtualRange.end,
    virtualRange.start,
  ]);

  useLayoutEffect(() => restorePendingAnchor(), [disclosureOverrides, restorePendingAnchor]);

  useEffect(() => () => {
    bottomPinDeferredRef.current = false;
    bottomScrollFrameReplayRef.current = false;
    sendAnchorLayoutDeferredRef.current = false;
    scheduleBottomPinRef.current = () => undefined;
    scheduleSendAnchorLayoutRef.current = () => undefined;
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
      bottomScrollFrameRef.current = null;
    }
    if (pendingSendAnchorFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingSendAnchorFrameRef.current);
      pendingSendAnchorFrameRef.current = null;
    }
    if (scrollMetricsFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollMetricsFrameRef.current);
      scrollMetricsFrameRef.current = null;
    }
    cancelPendingVirtualScrollAdjustment();
    setDisclosureAnchorRunway(0);
  }, [cancelPendingVirtualScrollAdjustment, setDisclosureAnchorRunway]);

  /**
   * The reader's last position, taken while the transcript is still mounted.
   * React detaches host refs and the DOM node before passive cleanups run for a
   * deleted subtree, so this has to be a layout cleanup: from a passive one the
   * ref is already null and nothing is ever recorded. Everything the reader did
   * with the scrollbar is already cached by then; what this adds is the position
   * after changes that moved the transcript without a scroll event of their own.
   */
  useLayoutEffect(() => () => {
    const scroll = scrollRef.current;
    if (!scroll?.isConnected || scrollRestoreRef.current) return;
    const follow = isTranscriptFollowing(scroll);
    cacheThreadScrollSnapshot(threadId, {
      anchor: follow ? null : readTranscriptAnchor(scroll),
      follow,
      top: scroll.scrollTop,
    });
  }, [threadId]);

  useEffect(() => {
    const controller = new AbortController();
    attachmentLifecycleControllerRef.current = controller;
    return () => {
      controller.abort();
      if (attachmentLifecycleControllerRef.current === controller) {
        attachmentLifecycleControllerRef.current = null;
      }
      for (const attachment of attachmentsRef.current) discardManagedAttachment(threadId, attachment);
      for (const previewUrl of attachmentPreviewUrlsRef.current.values()) URL.revokeObjectURL(previewUrl);
      attachmentPreviewUrlsRef.current.clear();
    };
  }, [threadId]);

  useEffect(() => {
    if (!error) return undefined;
    const timeout = window.setTimeout(() => setError(null), ATTACHMENT_ERROR_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [error]);

  useEffect(() => {
    if (!waitingForInput) return;
    dragDepthRef.current = 0;
    setDragActive(false);
  }, [waitingForInput]);

  useEffect(() => {
    if (composerFocusToken <= 0
      || handledFocusTokenRef.current >= composerFocusToken
      || waitingForInput) return undefined;
    handledFocusTokenRef.current = composerFocusToken;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [composerFocusToken, waitingForInput]);

  useEffect(() => {
    if (failedThreadCreationFocusToken <= 0
      || handledFailedThreadCreationFocusTokenRef.current >= failedThreadCreationFocusToken
      || threadCreationPending
      || waitingForInput) return undefined;
    handledFailedThreadCreationFocusTokenRef.current = failedThreadCreationFocusToken;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [failedThreadCreationFocusToken, threadCreationPending, waitingForInput]);

  useEffect(() => {
    if (threadCreationBlocked) return;
    setNewThreadValidation((current) => current === 'providerRequired' ? null : current);
  }, [threadCreationBlocked]);

  // A staged page must be VISIBLE and removable. Without this it rode whatever
  // message the user sent next, in any thread, with nothing on screen to say so
  // and no way to take it back short of sending something.
  const [stagedContexts, setStagedContexts] = useState<PendingComposerContext[]>(
    () => pendingComposerContexts(),
  );
  useEffect(() => onThreadComposerContextRequest(() => {
    setStagedContexts(pendingComposerContexts());
  }), []);
  // Staging belongs to the thread it was staged into. Switching threads drops
  // it rather than silently carrying an unrelated page into the next turn.
  useEffect(() => {
    for (const context of pendingComposerContexts()) acknowledgeThreadComposerContext(context.key);
    setStagedContexts([]);
  }, [threadId]);

  useEffect(() => onThreadComposerNodeReferenceRequest((request) => {
    if (!composerEnabled) return;
    composerRef.current?.insertNodeReference({ nodeId: request.nodeId, title: request.title });
    acknowledgeThreadComposerNodeReferenceRequest(request);
    requestAnimationFrame(() => composerRef.current?.focus());
  }), [composerEnabled]);

  useEffect(() => {
    let cancelled = false;
    void window.lin?.recentLocalFiles?.({ limit: 6 })
      .then((result) => {
        if (!cancelled) setRecentLocalFiles(result.files);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    const currentDraft = draftRef.current;
    if (!composerEnabled
      || currentDraft.empty
      || sending
      || threadCreationPending
      || waitingForInput) return;
    const commandState = classifyNewThreadCommand(currentDraft);
    if (commandState === 'blockedByStructuredContent') {
      setNewThreadValidation('structuredContent');
      return;
    }
    if (commandState === 'ready') {
      if (threadCreationBlocked) {
        setNewThreadValidation('providerRequired');
        return;
      }
      setNewThreadValidation(null);
      const created = await onCreateThread();
      if (!created) setFailedThreadCreationFocusToken((token) => token + 1);
      return;
    }
    setNewThreadValidation(null);
    if (providerBlocksSend) return;
    const submittedContent = threadContentFromDraft(currentDraft, attachmentsRef.current);
    const submittedAttachments = submittedContent.filter(
      (content): content is ThreadAttachmentContent => content.type === 'attachment',
    );
    const submittedAttachmentIds = new Set(submittedAttachments.map((attachment) => attachment.id));
    const editorSnapshot = composerRef.current?.snapshot() ?? null;
    const scroll = scrollRef.current;
    const previousViewport = scroll ? {
      anchor: followRef.current ? null : readTranscriptAnchor(scroll),
      disclosureRunway: disclosureAnchorRunwayRef.current,
      follow: followRef.current,
      spacer: sendAnchorSpacerRef.current,
      top: scroll.scrollTop,
    } : null;
    const pendingSend: PendingSendAnchor | null = activeTurn ? null : {
      releaseFollowOnAnchor: Boolean(
        scroll
        && scroll.scrollHeight - scroll.clientHeight > TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX,
      ),
      threadId,
      targetTurnId: null,
    };
    bottomPinDeferredRef.current = false;
    sendAnchorLayoutDeferredRef.current = false;
    cancelPendingVirtualScrollAdjustment();
    cancelPendingAnchor();
    clearSendAnchorSpacer();
    setDisclosureAnchorRunway(0);
    // Sending is the reader asking to be at the end of the conversation. A
    // restore that never settled — its anchored Turn rolled back, or simply
    // outside a virtual window when the layout passes stopped — would otherwise
    // fire on the layout pass this send causes and pull them back up, releasing
    // follow on the way so the reply streams away below the fold.
    scrollRestoreRef.current = null;
    pendingSendScrollRef.current = pendingSend;
    setFollowValue(true);
    if (scroll) setProgrammaticScrollTop(scroll, scroll.scrollHeight);
    sendingRef.current = true;
    setSending(true);
    setError(null);
    composerRef.current?.clear();
    updateAttachments((current) => current.filter((attachment) => !submittedAttachmentIds.has(attachment.id)));
    try {
      const acceptedTurn = await onSend(submittedContent);
      if (pendingSendScrollRef.current === pendingSend) {
        if (pendingSend && acceptedTurn && pendingSend.threadId === threadId) {
          pendingSend.targetTurnId = acceptedTurn.id;
          setPendingSendVersion((version) => version + 1);
        } else {
          pendingSendScrollRef.current = null;
        }
      }
      for (const attachmentId of submittedAttachmentIds) releaseAttachmentUiState(
        attachmentId,
        attachmentPreviewUrlsRef.current,
        attachmentSourceKeysRef.current,
      );
    } catch (sendError) {
      if (pendingSendScrollRef.current === pendingSend) pendingSendScrollRef.current = null;
      const currentScroll = scrollRef.current;
      if (currentScroll && currentScroll === scroll && previousViewport) {
        updateSendAnchorSpacer(previousViewport.spacer);
        setDisclosureAnchorRunway(previousViewport.disclosureRunway);
        setFollowValue(previousViewport.follow);
        if (previousViewport.spacer) {
          scrollRestoreRef.current = {
            anchor: previousViewport.anchor,
            attempts: 0,
            scrollHeight: 0,
            top: previousViewport.top,
          };
        } else {
          scrollRestoreRef.current = null;
          setProgrammaticScrollTop(currentScroll, previousViewport.top);
        }
        // Last, so it wins: the write above re-reads the anchor from a transcript
        // that has not finished shedding the failed send, and what the reader had
        // before the send is what the next return should aim at.
        cacheThreadScrollSnapshot(threadId, {
          anchor: previousViewport.anchor,
          follow: previousViewport.follow,
          top: previousViewport.top,
        });
      }
      if (draftRef.current.empty && editorSnapshot) composerRef.current?.restore(editorSnapshot);
      updateAttachments((current) => uniqueAttachments([...submittedAttachments, ...current]));
      setError(errorMessage(sendError));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function enqueueAttachmentOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = attachmentOperationTailRef.current
      .catch(() => undefined)
      .then(operation);
    attachmentOperationTailRef.current = result.then(() => undefined, () => undefined);
    return result;
  }

  function addPickedFiles(): Promise<void> {
    return enqueueAttachmentOperation(processPickedFiles);
  }

  async function processPickedFiles() {
    const signal = attachmentLifecycleControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_ATTACHMENTS }));
      return;
    }
    setError(null);
    if (window.lin?.pickLocalFiles) {
      try {
        const result = await window.lin.pickLocalFiles({ maxFiles: MAX_ATTACHMENTS - attachmentsRef.current.length });
        if (signal.aborted) return;
        if (!result.canceled) {
          const next: PreparedComposerAttachment[] = [];
          const existingKeys = currentAttachmentSourceKeys(attachmentsRef.current, attachmentSourceKeysRef.current);
          let skippedDuplicates = 0;
          let skippedOverflow = result.skippedCount ?? 0;
          const rejectedOwnershipFile = result.rejectedFiles?.find((file) => file.reason === 'officeOwnershipFile');
          let failure: string | null = rejectedOwnershipFile
            ? t.agent.composer.officeOwnershipFile({
                name: rejectedOwnershipFile.name,
                suggestedName: rejectedOwnershipFile.suggestedName ?? null,
              })
            : null;
          for (const file of result.files) {
            if (signal.aborted) return;
            if (next.length >= MAX_ATTACHMENTS - attachmentsRef.current.length) {
              skippedOverflow += 1;
              continue;
            }
            const sourceKey = `path:${file.path}`;
            if (existingKeys.has(sourceKey)) {
              skippedDuplicates += 1;
              continue;
            }
            try {
              const prepared = attachmentFromPickedFile(file);
              next.push(prepared);
              existingKeys.add(prepared.sourceKey);
            } catch (attachmentError) {
              failure ??= errorMessage(attachmentError);
            }
          }
          if (signal.aborted) return;
          commitPreparedAttachments(next);
          setError(failure
            ?? duplicateAttachmentMessage(skippedDuplicates, t.agent.composer)
            ?? overflowAttachmentMessage(skippedOverflow, t.agent.composer));
        }
        return;
      } catch {
        // The web picker remains available when the native bridge cannot open.
      }
    }
    fileInputRef.current?.click();
  }

  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (files.length === 0) return;
    await addBrowserFiles(files);
  }

  function addBrowserFiles(files: readonly File[]): Promise<void> {
    return enqueueAttachmentOperation(() => processBrowserFiles(files));
  }

  async function processBrowserFiles(files: readonly File[]) {
    const signal = attachmentLifecycleControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    if (waitingForInput || files.length === 0) return;
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_ATTACHMENTS }));
      return;
    }
    setError(null);
    const next: PreparedComposerAttachment[] = [];
    const existingKeys = currentAttachmentSourceKeys(attachmentsRef.current, attachmentSourceKeysRef.current);
    let skippedDuplicates = 0;
    let skippedOverflow = 0;
    let failure: string | null = null;
    for (const file of files) {
      if (next.length >= MAX_ATTACHMENTS - attachmentsRef.current.length) {
        skippedOverflow += 1;
        continue;
      }
      const ownershipFile = officeOwnershipFileInfo(file.name);
      if (ownershipFile) {
        failure ??= t.agent.composer.officeOwnershipFile({
          name: ownershipFile.name,
          suggestedName: null,
        });
        continue;
      }
      try {
        const prepared = await attachmentFromBrowserFile(file, threadId, signal);
        if (existingKeys.has(prepared.sourceKey)) {
          const retained = [...attachmentsRef.current, ...next.map((candidate) => candidate.content)];
          if (!retained.some((attachment) => sameManagedResource(attachment, prepared.content))) {
            discardManagedAttachment(threadId, prepared.content);
          }
          skippedDuplicates += 1;
          continue;
        }
        next.push(prepared);
        existingKeys.add(prepared.sourceKey);
      } catch (attachmentError) {
        if (signal.aborted) break;
        failure ??= errorMessage(attachmentError);
      }
    }
    if (signal.aborted) {
      for (const prepared of next) discardPreparedAttachment(threadId, prepared);
      return;
    }
    commitPreparedAttachments(next);
    setError(failure
      ?? duplicateAttachmentMessage(skippedDuplicates, t.agent.composer)
      ?? overflowAttachmentMessage(skippedOverflow, t.agent.composer));
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (waitingForInput || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (waitingForInput || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (waitingForInput || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (waitingForInput || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    void addBrowserFiles(Array.from(event.dataTransfer.files));
  }

  function updateAttachments(update: (current: ThreadAttachmentContent[]) => ThreadAttachmentContent[]) {
    const next = update(attachmentsRef.current);
    attachmentsRef.current = next;
    setAttachments(next);
  }

  function commitPreparedAttachments(
    incoming: readonly PreparedComposerAttachment[],
    options: { readonly insertReferences?: boolean } = {},
  ) {
    if (incoming.length === 0) return;
    for (const attachment of incoming) {
      attachmentSourceKeysRef.current.set(attachment.content.id, attachment.sourceKey);
      if (attachment.previewUrl) attachmentPreviewUrlsRef.current.set(attachment.content.id, attachment.previewUrl);
    }
    updateAttachments((current) => [...current, ...incoming.map((attachment) => attachment.content)]);
    if (options.insertReferences !== false) {
      composerRef.current?.insertFileReferences(incoming.map((attachment) => attachment.reference));
    }
  }

  async function searchLocalFiles(query: string): Promise<ThreadComposerLocalFileCandidate[]> {
    const result = await window.lin?.searchLocalFiles?.({ query, limit: 12 });
    return result?.files ?? [];
  }

  async function previewLocalFile(
    file: ThreadComposerLocalFileCandidate,
  ): Promise<ThreadComposerLocalFileCandidate | null> {
    const result = await window.lin?.previewLocalFile?.({ id: file.id });
    return result?.thumbnailDataUrl ? { ...file, thumbnailDataUrl: result.thumbnailDataUrl } : file;
  }

  function selectLocalFile(
    file: ThreadComposerLocalFileCandidate,
  ): Promise<ThreadComposerFileReference | null> {
    return enqueueAttachmentOperation(() => processSelectedLocalFile(file));
  }

  async function processSelectedLocalFile(
    file: ThreadComposerLocalFileCandidate,
  ): Promise<ThreadComposerFileReference | null> {
    const signal = attachmentLifecycleControllerRef.current?.signal;
    if (!signal || signal.aborted) return null;
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_ATTACHMENTS }));
      return null;
    }
    setError(null);
    try {
      const prepared = await window.lin?.prepareLocalFile?.({ id: file.id });
      if (signal.aborted) return null;
      if (!prepared?.file) throw new Error(`${file.name || 'Attachment'} is no longer available.`);
      const attachment = attachmentFromPickedFile({
        ...prepared.file,
        iconDataUrl: prepared.file.iconDataUrl ?? file.iconDataUrl,
        thumbnailDataUrl: prepared.file.thumbnailDataUrl ?? file.thumbnailDataUrl,
      });
      if (signal.aborted) return null;
      const existingKeys = currentAttachmentSourceKeys(attachmentsRef.current, attachmentSourceKeysRef.current);
      if (existingKeys.has(attachment.sourceKey)) {
        setError(t.agent.composer.skippedDuplicates({ count: 1 }));
        return null;
      }
      commitPreparedAttachments([attachment], { insertReferences: false });
      setRecentLocalFiles((current) => [file, ...current.filter((candidate) => candidate.id !== file.id)].slice(0, 8));
      return attachment.reference;
    } catch (attachmentError) {
      setError(errorMessage(attachmentError));
      return null;
    }
  }

  function handleDraftChange(next: ThreadComposerDraft) {
    draftRef.current = next;
    setDraft(next);
    const nextCommandState = classifyNewThreadCommand(next);
    setNewThreadValidation((current) => {
      if (current === 'structuredContent' && nextCommandState === 'blockedByStructuredContent') return current;
      if (current === 'providerRequired' && nextCommandState === 'ready' && threadCreationBlocked) return current;
      return null;
    });
    if (sendingRef.current) return;
    const referencedIds = new Set(next.fileRefs.map((ref) => ref.attachmentId));
    const current = attachmentsRef.current;
    const retained = current.filter((attachment) => referencedIds.has(attachment.id));
    if (retained.length === current.length) return;
    for (const attachment of current) {
      if (!referencedIds.has(attachment.id)) {
        if (!retained.some((candidate) => sameManagedResource(candidate, attachment))) {
          discardManagedAttachment(threadId, attachment);
        }
        releaseAttachmentUiState(
          attachment.id,
          attachmentPreviewUrlsRef.current,
          attachmentSourceKeysRef.current,
        );
      }
    }
    updateAttachments(() => retained);
  }

  function refocusComposerFromClick(event: MouseEvent<HTMLDivElement>) {
    if (!composerEnabled || waitingForInput) return;
    const decision = composerRefocusDecision({
      altKey: event.altKey,
      button: event.button,
      ctrlKey: event.ctrlKey,
      detail: event.detail,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      target: event.target instanceof Element ? event.target : null,
    }, window.getSelection());
    if (!decision.refocus) return;
    window.requestAnimationFrame(() => {
      if (clickInstalledFocusTarget(document.activeElement, decision.control, document.body)) return;
      composerRef.current?.focus();
    });
  }

  const showJumpToLatest = !follow && scrollMetrics.hasContentBelow;

  return (
    <div className="thread-view" onClick={refocusComposerFromClick}>
      <div className="thread-transcript-shell">
        <div
          className="thread-transcript"
          onKeyDownCapture={(event) => {
            if (TRANSCRIPT_SCROLL_INTENT_KEYS.has(event.key)) cancelPendingVirtualScrollAdjustment();
          }}
          onPointerDown={cancelPendingVirtualScrollAdjustment}
          onScroll={(event) => {
            const scroll = event.currentTarget;
            const expectedTop = expectedProgrammaticScrollTopRef.current;
            const programmatic = expectedTop !== null && Math.abs(scroll.scrollTop - expectedTop) < 1;
            expectedProgrammaticScrollTopRef.current = null;
            if (!programmatic && pendingVirtualScrollAdjustmentRef.current) return;
            if (!programmatic) {
              scrollRestoreRef.current = null;
            }
            reconcileDisclosureAnchorRunway(scroll);
            synchronizedScrollTopRef.current = scroll.scrollTop;
            if (!scrollRestoreRef.current) {
              const nextFollow = isTranscriptFollowing(scroll);
              setFollowValue(nextFollow);
              cacheThreadScrollSnapshot(threadId, {
                // Per scroll event this path stays within the layout reads the
                // follow check already makes: the anchor from the last frame is
                // carried forward, and the frame-level path re-reads it (A9).
                anchor: nextFollow ? null : threadScrollSnapshots.get(threadId)?.anchor ?? null,
                follow: nextFollow,
                top: scroll.scrollTop,
              });
            }
            scheduleScrollMetrics(scroll);
          }}
          onTouchMove={cancelPendingVirtualScrollAdjustment}
          onWheel={cancelPendingVirtualScrollAdjustment}
          ref={scrollRef}
        >
          <div className="thread-transcript-content" ref={transcriptContentRef}>
            {goal ? <ThreadGoalView goal={goal} /> : null}
            {turns.length > 0 ? (
              <div
                className={`thread-transcript-turns${virtualized ? ' is-virtual' : ''}`}
                data-virtualized={virtualized ? 'true' : 'false'}
                style={virtualized ? { height: virtualLayout.totalHeight } : undefined}
              >
                {visibleTurns.map((turn, offset) => {
                  const turnIndex = virtualRange.start + offset;
                  const layoutItem = virtualLayout.items[turnIndex];
                  return (
                    <ThreadTranscriptTurnShell
                      key={turn.id}
                      measuredHeight={measuredTurnHeights.get(turn.id)}
                      onMeasure={measureTurn}
                      style={virtualized && layoutItem ? { transform: `translateY(${layoutItem.top}px)` } : undefined}
                      turnId={turn.id}
                      virtualized={virtualized}
                    >
                      <ThreadTurnView
                        onInterruptThread={onInterruptThread}
                        canEditUserMessage={onSubagentDrill === undefined
                          && composerEnabled
                          && turn.id === editableTurnId
                          && turn.status !== 'inProgress'}
                        composerEnabled={composerEnabled}
                        isLastTurn={turnIndex === turns.length - 1}
                        expandState={expandState}
                        index={index}
                        onEditUserMessage={onEditUserMessage}
                        onContinueInNewChat={onContinueInNewChat}
                        onOpenSubagentTurnDetails={onOpenSubagentTurnDetails}
                        onSubagentDrill={onSubagentDrill}
                        onOpenNodeReference={onOpenNodeReference}
                        onOpenThread={onOpenThread}
                        onOpenTurnDetails={onOpenTurnDetails}
                        onReadToolArguments={onReadToolArguments}
                        onReadToolOutput={onReadToolOutput}
                        latchedReasoning={latchedReasoning}
                        liveReasoningSeen={liveReasoningSeen}
                        providerRetry={providerRetry?.turnId === turn.id ? providerRetry.status : null}
                        threadId={threadId}
                        threadCwd={threadCwd}
                        threadsById={threadsById}
                        latestTurnByThread={latestTurnByThread}
                        turn={turn}
                        userView={userView}
                        waitingOnUserInput={waitingOnUserInput}
                      />
                    </ThreadTranscriptTurnShell>
                  );
                })}
              </div>
            ) : null}
            {sendAnchorSpacer ? (
              <div
                aria-hidden
                className="thread-send-anchor-spacer"
                style={{ height: sendAnchorSpacer.height }}
              />
            ) : null}
          </div>
        </div>
        {showJumpToLatest ? (
          <ButtonControl
            className="thread-jump-latest"
            onClick={() => {
              scrollRestoreRef.current = null;
              bottomPinDeferredRef.current = false;
              sendAnchorLayoutDeferredRef.current = false;
              cancelPendingVirtualScrollAdjustment();
              cancelPendingAnchor();
              clearSendAnchorSpacer();
              setDisclosureAnchorRunway(0);
              setFollowValue(true);
              const scroll = scrollRef.current;
              if (scroll) setProgrammaticScrollTop(scroll, scroll.scrollHeight);
              window.requestAnimationFrame(() => composerRef.current?.focus());
            }}
          >
            <ChevronDownIcon aria-hidden size={ICON_SIZE.menu} />
            <span>{t.agent.thread.jumpToLatest}</span>
          </ButtonControl>
        ) : null}
      </div>
      {providerRetry ? <ThreadProviderRetryAnnouncement status={providerRetry.status} /> : null}
      {/* A watched child or automation Thread has no composer, but `update_plan`
          is `anyThread`-scoped — so it has a Plan, and used to have nowhere to
          show it. Read-only there: no composer to hand focus back to. */}
      {!composerEnabled && activePlan ? (
        <div className="thread-composer-region thread-plan-progress-region">
          <ThreadPlanProgress plan={activePlan} working={activeWorkingTextEnabled} />
        </div>
      ) : null}
      {composerEnabled ? <div className="thread-composer-region thread-composer" ref={composerRegionRef}>
        {activePlan ? (
          <ThreadPlanProgress
            onClosed={() => composerRef.current?.focus()}
            plan={activePlan}
            working={activeWorkingTextEnabled}
          />
        ) : null}
        <div
          className={`thread-composer-surface${dragActive ? ' is-dragging' : ''}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {inputRequest ? (
            <UserInputRequest
              onSubmit={onSubmitUserInput}
              request={inputRequest}
            />
          ) : null}
          <div className="thread-composer-main" hidden={waitingForInput}>
              {dragActive ? <div className="thread-composer-drop-overlay">{t.agent.thread.dropFilesToAttach}</div> : null}
              {error ? <p className="thread-inline-error" role="status">{error}</p> : null}
              {newThreadValidationMessage ? (
                <p className="thread-inline-error" role="status">
                  {newThreadValidationMessage}
                </p>
              ) : null}
              {stagedContexts.length > 0 ? (
                <ul className="thread-composer-contexts" aria-label={t.agent.composer.stagedContextsLabel}>
                  {stagedContexts.map((context) => (
                    <li key={context.key} className="thread-composer-context">
                      <span className="thread-composer-context-label">{context.label}</span>
                      <button
                        type="button"
                        className="thread-composer-context-remove"
                        aria-label={t.agent.composer.removeStagedContext({ label: context.label })}
                        onClick={() => {
                          acknowledgeThreadComposerContext(context.key);
                          setStagedContexts(pendingComposerContexts());
                        }}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ThreadComposerEditor
                allowFileReferences={!activeTurn && !providerBlocksSend && !waitingForInput && !threadCreationPending}
                allowNodeReferences={!waitingForInput && !threadCreationPending}
                allowSlashCommands={slashCommands.length > 0}
                currentNodeId={null}
                disabled={waitingForInput || threadCreationPending}
                index={index}
                isStreaming={Boolean(activeTurn)}
                onChange={handleDraftChange}
                onFilesPasted={(files) => void addBrowserFiles(files)}
                onLocalFilePreview={previewLocalFile}
                onLocalFileSearch={searchLocalFiles}
                onLocalFileSelect={selectLocalFile}
                onNodeReferenceClick={onOpenNodeReference}
                onStop={() => void onInterrupt()}
                onSubmit={() => void submit()}
                placeholder={activeTurn ? t.agent.composer.steerPlaceholder : t.agent.thread.composerPlaceholder}
                recentLocalFiles={recentLocalFiles}
                ref={composerRef}
                slashCommands={slashCommands}
              />
              <div className="thread-composer-toolbar">
                <input
                  className="thread-composer-file-input"
                  multiple
                  onChange={(event) => void handleFileInputChange(event)}
                  ref={fileInputRef}
                  type="file"
                />
                <IconButton
                  disabled={providerBlocksSend
                    || Boolean(activeTurn)
                    || attachments.length >= MAX_ATTACHMENTS
                    || sending
                    || threadCreationPending}
                  icon={AttachmentIcon}
                  label={t.agent.thread.addAttachment}
                  onClick={() => void addPickedFiles()}
                  title={providerBlocksSend ? t.agent.thread.providerRequired : t.agent.thread.addAttachment}
                  variant="composerTool"
                />
                <span className="thread-composer-spacer" />
                <span className="thread-composer-control-group">
                {configuration ? (
                  <ThreadComposerModelControl
                    configuration={configuration}
                    disabled={Boolean(activeTurn)
                      || sending
                      || threadCreationPending
                      || (providerSettingsLoaded && !hasUsableProvider)}
                    onChange={async (next) => {
                      setError(null);
                      try {
                        await onConfigurationChange(next);
                      } catch (configurationError) {
                        setError(errorMessage(configurationError));
                        throw configurationError;
                      }
                    }}
                    settings={providerSettings}
                  />
                ) : null}
                {activeTurn && !hasDraft ? (
                  <IconButton
                    className="is-stop"
                    icon={StopIcon}
                    label={t.agent.thread.interrupt}
                    onClick={() => void onInterrupt()}
                    variant="composerAction"
                  />
                ) : (
                  <IconButton
                    disabled={composerActionDisabled}
                    icon={SendIcon}
                    label={composerActionLabel}
                    onClick={() => void submit()}
                    title={composerActionTitle}
                    variant="composerAction"
                  />
                )}
                </span>
              </div>
          </div>
        </div>
      </div> : null}
    </div>
  );
}

function ThreadTranscriptTurnShell({
  children,
  measuredHeight,
  onMeasure,
  style,
  turnId,
  virtualized,
}: {
  readonly children: ReactNode;
  readonly measuredHeight: number | undefined;
  readonly onMeasure: (turnId: string, height: number, element: HTMLDivElement) => void;
  readonly style?: CSSProperties;
  readonly turnId: string;
  readonly virtualized: boolean;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return undefined;
    const measure = () => {
      const turn = element.querySelector<HTMLElement>('.thread-turn');
      const turnContent = turn?.firstElementChild;
      if (
        turnContent instanceof HTMLElement
        && !turnContent.checkVisibility({ contentVisibilityAuto: true })
      ) return;
      onMeasure(turnId, element.getBoundingClientRect().height, element);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, turnId]);
  return (
    <div
      className={virtualized ? 'thread-transcript-virtual-turn' : 'thread-transcript-flow-turn'}
      data-thread-turn-row={turnId}
      ref={rowRef}
      style={{
        ...style,
        // The placeholder a skipped Turn occupies. Feeding the measured height
        // back keeps a remounted transcript the same height it was, so a
        // restored position still points at the content it was taken from.
        ...(measuredHeight === undefined
          ? {}
          : { '--thread-turn-intrinsic-size': `${measuredHeight}px` }),
      } as CSSProperties}
    >
      {children}
    </div>
  );
}

const ThreadTurnView = memo(function ThreadTurnView({
  canEditUserMessage,
  composerEnabled,
  isLastTurn,
  expandState,
  index,
  latchedReasoning,
  liveReasoningSeen,
  onEditUserMessage,
  onContinueInNewChat,
  onInterruptThread,
  onOpenNodeReference,
  onOpenThread,
  onOpenSubagentTurnDetails,
  onSubagentDrill,
  onOpenTurnDetails,
  onReadToolArguments,
  onReadToolOutput,
  providerRetry,
  threadId,
  threadCwd,
  threadsById,
  latestTurnByThread,
  turn,
  userView,
  waitingOnUserInput,
}: {
  readonly canEditUserMessage: boolean;
  readonly composerEnabled: boolean;
  readonly expandState: ThreadDisclosureState;
  readonly index: DocumentIndex;
  readonly isLastTurn: boolean;
  /** Reasoning Item ids that have been open by default this session. */
  readonly latchedReasoning: Set<string>;
  /** Reasoning Item ids first observed while their Turn was live. */
  readonly liveReasoningSeen: Set<string>;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onContinueInNewChat: (turn: Turn) => Promise<void>;
  readonly onInterruptThread: (threadId: string) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onOpenSubagentTurnDetails?: (threadId: string, turnId: string) => void;
  /**
   * Present only INSIDE a Subagent run detail. A delegation row there swaps
   * that container's contents instead of opening a second one inside it —
   * nesting would put a scroll region inside a scroll region.
   */
  readonly onSubagentDrill?: (threadId: string) => void;
  readonly onOpenTurnDetails: (turn: Turn) => void;
  readonly onReadToolArguments: (turnId: string, item: ThreadToolItem) => Promise<JsonValue | null>;
  readonly onReadToolOutput: (turnId: string, item: ThreadToolItem) => Promise<string | null>;
  readonly providerRetry: ProviderRetryStatus | null;
  readonly threadId: string;
  readonly threadCwd: string;
  readonly threadsById: ReadonlyMap<ThreadId, Thread>;
  readonly latestTurnByThread: ReadonlyMap<ThreadId, Turn>;
  readonly turn: Turn;
  readonly userView: RendererUserViewHints;
  readonly waitingOnUserInput: boolean;
}) {
  const t = useT();
  const responseItem = lastAgentResponse(turn);
  // A resultless reasoning Item first observed after settlement opens for the
  // session. An Item observed live stays folded when completion arrives, so the
  // terminal update cannot insert a body under the reader.
  const reasoningExpandedByDefault = (candidateTurn: Turn, item: ThreadItem): boolean => {
    if (item.type === 'reasoning' && candidateTurn.status === 'inProgress') {
      liveReasoningSeen.add(item.id);
      return false;
    }
    if (!liveReasoningSeen.has(item.id) && isSoloResultlessReasoning(candidateTurn, item)) {
      latchedReasoning.add(item.id);
    }
    return latchedReasoning.has(item.id);
  };
  const standaloneContextBoundary = turn.status !== 'inProgress'
    && isStandaloneContextBoundaryTurn(turn);
  const hostAuthoredEvent = turn.provenance.trigger.kind === 'subagent'
    && turn.provenance.originThreadId === threadId;
  const subagents = useMemo(
    () => projectSubagentsForTurn(turn, threadsById, latestTurnByThread),
    [latestTurnByThread, threadsById, turn],
  );
  const contentBlocks = groupTurnContent({ ...turn, items: subagents.items });
  const processItems = contentBlocks.flatMap((block) => block.kind === 'process' ? block.items : []);
  const workingTextEnabled = !waitingOnUserInput && providerRetry === null;
  const motionOwner = turnMotionOwner(turn, processItems, subagents);
  const workingTextOwnsMotion = workingTextEnabled && motionOwner !== 'none';
  // A blocked Turn cannot use a progressive cue. Keep the fallback response
  // shape static as well, otherwise it becomes the only moving element while
  // the agent waits for the user.
  const shapeMotionSuppressed = !workingTextEnabled;
  // `groupTurnContent` omits the process block entirely for a Turn with no
  // process Items, so "no response Item" alone does not mean a divider exists
  // to own the terminal status.
  const hasProcessBlock = contentBlocks.some((block) => block.kind === 'process');
  const editUserMessage = useCallback(
    (content: readonly ThreadUserContent[]) => onEditUserMessage(turn, content),
    [onEditUserMessage, turn],
  );
  const continueInNewChat = useCallback(
    () => onContinueInNewChat(turn),
    [onContinueInNewChat, turn],
  );
  const readToolOutput = useCallback(
    (item: ThreadToolItem) => onReadToolOutput(turn.id, item),
    [onReadToolOutput, turn.id],
  );
  const readToolArguments = useCallback(
    (item: ThreadToolItem) => onReadToolArguments(turn.id, item),
    [onReadToolArguments, turn.id],
  );
  const copyTurn = useCallback(async () => {
    const text = await buildTurnCopyText(
      turn,
      readToolArguments,
      readToolOutput,
      t.agent.thread.resourceLimitReached,
    );
    if (text) await navigator.clipboard.writeText(text);
  }, [readToolArguments, readToolOutput, t.agent.thread.resourceLimitReached, turn]);
  const handleResponseContextMenu = useCallback(async (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const canContinueInNewChat = onSubagentDrill === undefined;
    const action = await window.lin?.showThreadMessageContextMenu?.({
      canCopy: hasTurnCopyContent(turn),
      canContinueInNewChat,
      canShowDetails: true,
    });
    if (action === 'copy') await copyTurn();
    else if (action === 'continueInNewChat') await continueInNewChat();
    else if (action === 'details') onOpenTurnDetails(turn);
  }, [continueInNewChat, copyTurn, onOpenTurnDetails, onSubagentDrill, turn]);
  /**
   * Running the same request again, for a Turn where that could go differently.
   *
   * A failure the user did not cause has no exit today: the only way forward is
   * to hover their OWN message and edit it, which frames a crash as something
   * they mistyped — and is unavailable outright for a message with more than one
   * text part. Retry re-sends this Turn's request unchanged, through the same
   * rollback-and-send path Edit uses, so the failed Turn does not linger as a
   * dead branch and the question is not asked twice.
   *
   * Only the last Turn: that path rolls back exactly one Turn, so offering it
   * further up would roll back somebody else's.
   */
  const retryContent = useMemo(() => {
    // The same condition the composer uses: rollback is available only on a
    // persistent root user Thread, so anywhere the user cannot type they must
    // not be offered a button that can only fail.
    if (hostAuthoredEvent
      || onSubagentDrill !== undefined
      || !composerEnabled
      || !isLastTurn
      || !isRetryableTurn(turn)) return null;
    const request = turn.items.find((item) => item.type === 'userMessage');
    return request?.content ?? null;
  }, [composerEnabled, hostAuthoredEvent, isLastTurn, onSubagentDrill, turn]);
  const responseTail = standaloneContextBoundary ? null : (
    <ThreadResponseTail
      canContinueInNewChat={onSubagentDrill === undefined}
      onCopy={copyTurn}
      onContinueInNewChat={continueInNewChat}
      onOpenDetails={() => onOpenTurnDetails(turn)}
      onRetry={retryContent ? () => onEditUserMessage(turn, retryContent) : null}
      providerRetry={providerRetry}
      shapeMotionSuppressed={shapeMotionSuppressed}
      workingTextOwnsMotion={workingTextOwnsMotion}
      // The process divider states the terminal status when there is no
      // response Item — but only if a process block renders at all. Without
      // one, suppressing it here would erase the status from the Turn.
      statusOwnedElsewhere={responseItem === null && hasProcessBlock}
      turn={turn}
    />
  );
  const renderItem = (item: ThreadItem, showMessageActions: boolean) => (
    <ThreadItemView
      agentResponseTail={item.id === responseItem?.id ? responseTail : null}
      canEditUserMessage={canEditUserMessage && showMessageActions}
      defaultReasoningExpanded={reasoningExpandedByDefault(turn, item)}
      expandState={expandState}
      index={index}
      item={item}
      hostAuthoredEvent={hostAuthoredEvent}
      key={item.id}
      onAgentMessageContextMenu={item.id === responseItem?.id ? handleResponseContextMenu : undefined}
      onEditUserMessage={editUserMessage}
      onInterruptThread={onInterruptThread}
      onOpenNodeReference={onOpenNodeReference}
      onOpenSubagentTurnDetails={onOpenSubagentTurnDetails}
      onSubagentDrill={onSubagentDrill}
      onOpenTurnDetails={standaloneContextBoundary ? () => onOpenTurnDetails(turn) : undefined}
      onOpenThread={onOpenThread}
      onReadToolArguments={readToolArguments}
      onReadToolOutput={readToolOutput}
      showMessageActions={showMessageActions}
      streaming={turn.status === 'inProgress' && turn.items.at(-1)?.id === item.id}
      subagents={subagents.byThreadId}
      threadId={threadId}
      threadCwd={threadCwd}
      userView={userView}
      workingTextEnabled={workingTextEnabled}
    />
  );
  return (
    <section className={`thread-turn thread-turn-${turn.status}`}>
      {contentBlocks.map((block) => {
        if (block.kind === 'process') {
          return (
            <ThreadProcessBlock
              expandState={expandState}
              hasFinalResponse={responseItem !== null}
              index={index}
              items={block.items}
              onOpenThread={onOpenThread}
              motionOwner={motionOwner}
              waitingOnUserInput={waitingOnUserInput}
              workingTextEnabled={workingTextEnabled}
              key={`process:${block.items[0]?.id ?? turn.id}`}
              subagents={subagents}
              turn={turn}
            >
              {groupTurnItems(block.items).map((group) => group.kind === 'tools' ? (
                <ThreadToolActivityGroup
                  expandState={expandState}
                  index={index}
                  items={group.items}
                  key={group.items[0]?.id}
                  onOpenThread={onOpenThread}
                  onReadToolArguments={readToolArguments}
                  onReadToolOutput={readToolOutput}
                  subagents={subagents.byThreadId}
                  threadId={threadId}
                  threadCwd={threadCwd}
                  workingTextEnabled={workingTextEnabled}
                />
              ) : renderItem(group.item, false))}
            </ThreadProcessBlock>
          );
        }
        const item = block.item;
        return renderItem(
          item,
          turn.status !== 'inProgress' && item.type === 'userMessage',
        );
      })}
      {responseItem === null && responseTail ? (
        <article
          className="thread-item thread-agent-message thread-agent-message-response"
          onContextMenu={turn.status === 'inProgress' ? undefined : handleResponseContextMenu}
        >
          {responseTail}
        </article>
      ) : null}
    </section>
  );
});

function isStandaloneContextBoundaryTurn(turn: Turn): boolean {
  if (turn.items.length !== 1 || turn.provenance.trigger.kind !== 'feature') return false;
  const item = turn.items[0];
  return (turn.provenance.trigger.feature === 'context.clear' && item?.type === 'contextReset')
    || (turn.provenance.trigger.feature === 'context.compact' && item?.type === 'contextCompaction');
}

function ThreadResponseTail({
  canContinueInNewChat,
  onCopy,
  onContinueInNewChat,
  onOpenDetails,
  onRetry,
  providerRetry,
  shapeMotionSuppressed,
  statusOwnedElsewhere,
  turn,
  workingTextOwnsMotion,
}: {
  /**
   * Forking a Thread starts a conversation, which a read-only embedded view
   * cannot do. Hidden rather than disabled: a control that never works is not a
   * control, and the row keeps its height from the actions that remain.
   */
  readonly canContinueInNewChat: boolean;
  readonly onCopy: () => Promise<void>;
  readonly onContinueInNewChat: () => Promise<void>;
  readonly onOpenDetails: () => void;
  /** Present only where running the same request again could go differently. */
  readonly onRetry: (() => Promise<void>) | null;
  readonly providerRetry: ProviderRetryStatus | null;
  readonly shapeMotionSuppressed: boolean;
  readonly statusOwnedElsewhere: boolean;
  readonly turn: Turn;
  readonly workingTextOwnsMotion: boolean;
}) {
  const t = useT();
  const [usageHoverOpen, setUsageHoverOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const streaming = turn.status === 'inProgress';
  const interrupted = turn.status === 'interrupted' && !statusOwnedElsewhere;
  const errorText = turn.error
    ? userFacingAgentError(turn.error, t.agent.thread.resourceLimitReached)
    : '';
  return (
    <>
      {!streaming && errorText ? (
        <div className="thread-response-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{errorText}</span>
        </div>
      ) : null}
      {retryError ? (
        <div className="thread-response-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{retryError}</span>
        </div>
      ) : null}
      {!streaming && interrupted ? (
        <div className="thread-response-stopped">
          <StopIcon aria-hidden size={ICON_SIZE.menu} />
          <span>{t.agent.thread.turnInterrupted}</span>
        </div>
      ) : null}
      <div className="thread-response-footer">
        {streaming ? (
          providerRetry
            ? <ThreadProviderRetryStatus status={providerRetry} />
            : (
              <ThreadStreamingIndicator
                shapeMotionSuppressed={shapeMotionSuppressed}
                workingTextOwnsMotion={workingTextOwnsMotion}
              />
            )
        ) : (
          <div className="thread-message-actions thread-response-actions">
            {onRetry ? (
              <IconButton
                disabled={retrying}
                icon={RefreshIcon}
                iconSize={ICON_SIZE.menu}
                label={t.agent.thread.retryTurn}
                // Latched, because the rollback that precedes the re-send is a
                // round trip during which this Turn and this button stay
                // mounted. A second click inside that window rolls back the
                // Turn BEFORE this one — a successful one, permanently — and
                // then sends the same request twice.
                onClick={() => {
                  if (retrying) return;
                  setRetrying(true);
                  setRetryError(null);
                  void onRetry()
                    // Reported, never swallowed: a Thread the host left in an
                    // error state refuses the rollback, and a Retry that
                    // silently does nothing is worse than one that says why.
                    .catch((error: unknown) => setRetryError(errorMessage(error)))
                    .finally(() => setRetrying(false));
                }}
                variant="message"
              />
            ) : null}
            <ThreadMessageCopyButton
              iconSize={ICON_SIZE.menu}
              label={t.agent.message.copyMessage}
              onCopy={onCopy}
              text=""
            />
            {canContinueInNewChat ? (
              <IconButton
                icon={GitForkIcon}
                iconSize={ICON_SIZE.menu}
                label={t.agent.thread.continueInNewChat}
                onClick={() => void onContinueInNewChat()}
                variant="message"
              />
            ) : null}
            <span className="thread-response-details-anchor">
              <IconButton
                icon={InfoIcon}
                iconSize={ICON_SIZE.menu}
                label={t.agent.message.details}
                onBlur={() => setUsageHoverOpen(false)}
                onClick={(event) => {
                  setUsageHoverOpen(false);
                  event.currentTarget.blur();
                  onOpenDetails();
                }}
                onFocus={() => setUsageHoverOpen(true)}
                onMouseEnter={() => setUsageHoverOpen(true)}
                onMouseLeave={() => setUsageHoverOpen(false)}
                ref={detailsButtonRef}
                title=""
                variant="message"
              />
              {usageHoverOpen ? (
                <ThreadUsageHoverCard anchorRef={detailsButtonRef} turn={turn} />
              ) : null}
            </span>
          </div>
        )}
      </div>
    </>
  );
}

function ThreadUsageHoverCard({
  anchorRef,
  turn,
}: {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly turn: Turn;
}) {
  const t = useT();
  const { locale } = useI18n();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const usage = turn.execution.usage;
  const style = useAnchoredOverlay(cardRef, {
    anchorRef,
    gap: 8,
    layoutKey: `${turn.completedAt ?? turn.startedAt}:${turn.execution.modelProvider}:${turn.execution.model}:${turn.execution.reasoningEffort}:${usage.input}:${usage.output}:${usage.cacheRead}:${usage.cacheWrite}:${usage.totalTokens}:${usage.cost?.total ?? 0}`,
    maxHeight: 420,
    placement: 'top-end',
    width: 320,
  });
  return createPortal(
    <div className="thread-response-usage-card" ref={cardRef} role="tooltip" style={style}>
      <dl className="thread-response-usage-context">
        <div>
          <dt>{t.agent.message.timestamp}</dt>
          <dd>{formatDateTime(turn.completedAt ?? turn.startedAt, locale, {
            dateStyle: 'medium',
            timeStyle: 'medium',
          })}</dd>
        </div>
        <div><dt>{t.agent.message.provider}</dt><dd>{turn.execution.modelProvider}</dd></div>
        <div><dt>{t.agent.message.model}</dt><dd>{turn.execution.model}</dd></div>
        <div><dt>{t.agent.message.reasoningEffort}</dt><dd>{turn.execution.reasoningEffort}</dd></div>
      </dl>
      <ThreadUsageBreakdown usage={usage} />
    </div>,
    document.body,
  );
}

function ThreadProviderRetryStatus({ status }: { readonly status: ProviderRetryStatus }) {
  const t = useT();
  return (
    <div aria-hidden className="thread-provider-retry">
      <LoaderIcon aria-hidden size={ICON_SIZE.tiny} />
      <span>{t.agent.thread.reconnecting({ attempt: status.attempt, maxRetries: status.maxRetries })}</span>
    </div>
  );
}

function ThreadProviderRetryAnnouncement({ status }: { readonly status: ProviderRetryStatus }) {
  const t = useT();
  return (
    <span
      aria-atomic="true"
      aria-live="polite"
      className="thread-provider-retry-announcer thread-visually-hidden"
      role="status"
    >
      {t.agent.thread.reconnecting({ attempt: status.attempt, maxRetries: status.maxRetries })}
    </span>
  );
}

/**
 * The transient Plan, as a pill above the composer. The persistent affordance is
 * the **current step's text**, not a bare counter: `2/5 · Draft the summary`
 * tells the reader what is happening, where `Step 2 / 5` told them only that
 * something was.
 */
function ThreadPlanProgress({
  onClosed,
  plan,
  working,
}: {
  /** Where focus goes when the checklist closes. Absent on a Thread with no
   *  composer, where it returns to the pill instead. */
  readonly onClosed?: () => void;
  readonly plan: ActiveTurnPlan;
  readonly working: boolean;
}) {
  const t = useT();
  const summaryId = useId();
  const popoverId = useId();
  const summaryRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const total = plan.plan.length;
  if (total === 0) return null;
  const activeIndex = plan.plan.findIndex((step) => step.status === 'in_progress');
  const pendingIndex = plan.plan.findIndex((step) => step.status === 'pending');
  const complete = plan.plan.every((step) => step.status === 'completed');
  // A finished plan is not "on" its last step; saying `5/5` alongside a check
  // was distinguishable from step five only by the icon.
  const currentIndex = activeIndex >= 0 ? activeIndex : pendingIndex >= 0 ? pendingIndex : total - 1;
  const progress = t.agent.thread.planProgress({ current: currentIndex + 1, total });
  const currentStep = plan.plan[currentIndex]?.step ?? '';
  const label = complete
    ? t.agent.thread.planComplete
    : t.agent.thread.planCurrentStep({ progress, step: currentStep });
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (!restoreFocus) return;
    // Deliberate close hands focus back to the composer, per the terminal model
    // — the pill is a status affordance, not a destination. With no composer,
    // focus lands on the pill: the popover it was on is about to become
    // `visibility: hidden`, which would drop focus to <body>.
    if (onClosed) onClosed();
    else summaryRef.current?.focus();
  };
  return (
    <div
      className={`thread-plan-progress${open ? ' is-open' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close(false);
      }}
    >
      <button
        aria-controls={popoverId}
        aria-expanded={open}
        className="thread-plan-progress-summary"
        id={summaryId}
        onClick={() => {
          const nextOpen = !open;
          if (!nextOpen) {
            close(true);
            return;
          }
          setOpen(true);
          window.requestAnimationFrame(() => popoverRef.current?.focus());
        }}
        ref={summaryRef}
        type="button"
      >
        {complete
          ? <CheckIcon aria-hidden size={ICON_SIZE.tiny} />
          : <PlanToolIcon aria-hidden size={ICON_SIZE.tiny} />}
        {!complete && !open && working
          ? <WorkingText className="thread-plan-progress-label" text={label} truncate />
          : <span className="thread-plan-progress-label">{label}</span>}
      </button>
      {/* The announcement carries the step text, not just the counter — a
          counter alone tells a screen-reader user nothing changed but a number. */}
      <span aria-live="polite" className="thread-visually-hidden">
        {complete
          ? t.agent.thread.planComplete
          : t.agent.thread.planProgressAnnouncement({ progress, step: currentStep })}
      </span>
      <div
        aria-labelledby={summaryId}
        className="thread-plan-progress-popover"
        id={popoverId}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          close(true);
        }}
        ref={popoverRef}
        role="region"
        tabIndex={0}
      >
        {plan.explanation ? <p>{plan.explanation}</p> : null}
        <ol>
          {plan.plan.map((step, index) => (
            <li
              aria-current={step.status === 'in_progress' ? 'step' : undefined}
              className={`is-${step.status}`}
              key={`${index}:${step.step}`}
            >
              <span aria-hidden className="thread-plan-step-status">
                {step.status === 'completed' ? <CheckIcon size={ICON_SIZE.tiny} /> : null}
              </span>
              <span>
                <span className="thread-visually-hidden">
                  {`${t.agent.thread.planStepStatus[step.status]}: `}
                </span>
                {step.step}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function hasTurnCopyContent(turn: Turn): boolean {
  return turn.items.some((item) => (
    item.type === 'agentMessage' && Boolean(item.text.trim())
  ) || isThreadToolItem(item)) || Boolean(turn.error?.message);
}

export async function buildTurnCopyText(
  turn: Turn,
  readToolArguments: (item: ThreadToolItem) => Promise<JsonValue | null>,
  readToolOutput: (item: ThreadToolItem) => Promise<string | null>,
  resourceLimitMessage: string,
): Promise<string> {
  const parts: string[] = [];
  for (const item of turn.items) {
    if (item.type === 'agentMessage') {
      const text = item.text.trim();
      if (text) parts.push(text);
      continue;
    }
    if (!isThreadToolItem(item)) continue;
    const argumentsValue = await readToolArguments(item);
    parts.push(`\`\`\`tool ${toolCopyName(item)}\n${toolCopyArguments(item, argumentsValue)}\n\`\`\``);
    const output = item.type === 'collabAgentToolCall'
      ? projectedToolOutput(item)
      : await readToolOutput(item) ?? projectedToolOutput(item);
    if (output.trim()) {
      const tag = item.status === 'failed' ? 'tool-error' : 'tool-result';
      parts.push(`\`\`\`${tag}\n${output.trim()}\n\`\`\``);
    }
  }
  if (parts.length === 0 && turn.error?.message) {
    parts.push(userFacingAgentError(turn.error, resourceLimitMessage));
  }
  return parts.join('\n\n');
}

function toolCopyName(item: ThreadToolItem): string {
  return modelCallDisplayName(item.modelCall);
}

function toolCopyArguments(item: ThreadToolItem, argumentsValue: JsonValue | null): string {
  if (argumentsValue !== null) {
    if (item.modelCall.disposition !== 'evidenceOnly') {
      const source = item.modelCall.disposition === 'replayable'
        ? item.modelCall.arguments
        : item.modelCall.redactedArguments;
      if (source.storage === 'payload') {
        return jsonText(boundedToolArgumentsForDisplay(argumentsValue));
      }
    }
    return jsonText(argumentsValue);
  }
  return jsonText(modelCallDisplayArguments(item.modelCall));
}

function projectedToolOutput(item: ThreadToolItem): string {
  switch (item.type) {
    case 'commandExecution': return item.aggregatedOutput ?? '';
    case 'fileChange': return '';
    case 'mcpToolCall': return item.error ?? (item.result === null ? '' : jsonText(item.result));
    case 'dynamicToolCall': return (item.contentItems ?? []).flatMap((content) => (
      content.type === 'text' ? [content.text] : content.type === 'json' ? [jsonText(content.value)] : []
    )).join('\n');
    case 'collabAgentToolCall': return jsonText(collaborationResultSnapshot(item));
    case 'webSearch': return item.error ?? jsonText(item.results);
    default: return assertNever(item);
  }
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Thread Item: ${JSON.stringify(value)}`);
}

function findActiveTurn(turns: readonly Turn[]): Turn | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.status === 'inProgress') return turn;
  }
  return null;
}

function latestUserMessageTurnId(turns: readonly Turn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.provenance.trigger.kind === 'user'
      && turn.items.some((item) => item.type === 'userMessage')) return turn.id;
  }
  return null;
}

function ThreadProcessBlock({
  onOpenThread,
  children,
  expandState,
  hasFinalResponse,
  index,
  items,
  motionOwner,
  subagents,
  turn,
  waitingOnUserInput,
  workingTextEnabled,
}: {
  readonly children: ReactNode;
  readonly expandState: ThreadDisclosureState;
  readonly hasFinalResponse: boolean;
  readonly index: DocumentIndex;
  readonly items: readonly ThreadItem[];
  readonly motionOwner: TurnMotionOwner;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly subagents: SubagentTurnProjection;
  readonly turn: Turn;
  readonly waitingOnUserInput: boolean;
  readonly workingTextEnabled: boolean;
}) {
  const t = useT();
  const disclosureId = `process:${turn.id}`;
  const expanded = expandState.isExpanded(disclosureId, false);
  const blockedOnUser = turn.status === 'inProgress' && waitingOnUserInput;
  const liveElapsedMs = useTurnElapsedMs(turn);
  // A Turn can settle while a child it spawned keeps running — the
  // fire-and-forget shape the protocol supports, where terminal activity lands
  // in a LATER Turn. The fold defaults to closed, so folding here would hide a
  // live delegation's status, its elapsed time, and the only Stop that reaches
  // it. Work that is still happening and still stoppable is not history yet.
  const collapsible = turn.status === 'completed'
    && hasFinalResponse
    && turn.durationMs !== null
    && items.length > 0
    && subagents.activeThreadIds.length === 0;
  const terminalResponseOwnsStatus = hasFinalResponse
    && (turn.status === 'failed' || turn.status === 'interrupted');
  const summary = threadProcessSummary(
    turn, items, hasFinalResponse, liveElapsedMs, t, index, subagents, blockedOnUser,
  );
  const timelineVisible = items.length > 0 && (!collapsible || expanded);
  const summaryWorking = motionOwner === 'summary'
    && !blockedOnUser
    && workingTextEnabled;
  const processTitleClassName = `thread-process-title${turn.status === 'inProgress'
    ? ' thread-process-title-live'
    : ''}`;
  return (
    <div className={`thread-process-block${turn.status === 'failed' && !hasFinalResponse ? ' is-error' : ''}`}>
      {terminalResponseOwnsStatus ? null : collapsible ? (
        <ButtonControl
          aria-expanded={expanded}
          className="thread-work-divider thread-process-toggle"
          data-thread-disclosure-id={disclosureId}
          onClick={(event) => expandState.toggle(disclosureId, expanded, event.currentTarget)}
        >
          <span className="thread-process-title">{summary}</span>
          <ChevronRightIcon
            aria-hidden
            className={`thread-process-chevron${expanded ? ' is-expanded' : ''}`}
            size={ICON_SIZE.menu}
          />
        </ButtonControl>
      ) : (
        <div className="thread-work-divider">
          {summaryWorking
            ? <WorkingText className={processTitleClassName} text={summary} truncate />
            : <span className={processTitleClassName}>{summary}</span>}
        </div>
      )}
      {terminalResponseOwnsStatus ? null : <div aria-hidden className="thread-process-rule" />}
      {terminalResponseOwnsStatus && timelineVisible ? (
        // The response tail owns the terminal status, but the timeline still
        // needs a name — otherwise it is an unlabelled list of rows.
        <div className="thread-work-divider">
          <span className="thread-process-title">
            {turn.durationMs !== null
              ? t.agent.thread.workedFor({ duration: formatProcessDuration(turn.durationMs) })
              : threadProcessNeutralHeader(turn, items, t, index, subagents)}
          </span>
        </div>
      ) : null}
      {timelineVisible ? <div className="thread-process-timeline">{children}</div> : null}
    </div>
  );
}

export type TurnMotionOwner = 'none' | 'summary' | 'leaf';

export function turnMotionOwner(
  turn: Turn,
  items: readonly ThreadItem[],
  subagents: SubagentTurnProjection,
): TurnMotionOwner {
  if (turn.status !== 'inProgress') return 'none';
  if (items.some((item) => isThreadToolItem(item) && item.status === 'inProgress')) return 'leaf';
  if (items.some((item) => (
    item.type === 'subAgentActivity'
    && isSubagentWorkingStatus(subagents.byThreadId.get(item.agentThreadId)?.status)
  ))) return 'leaf';
  const tail = turn.items.at(-1);
  if (tail?.type === 'reasoning') {
    return [...tail.summary, ...tail.content].every((part) => !part.trim()) ? 'leaf' : 'none';
  }
  if (tail?.type === 'agentMessage' && tail.phase === 'commentary' && tail.text.trim()) return 'none';
  return 'summary';
}

function isSubagentWorkingStatus(status: string | undefined): boolean {
  return status === 'pendingInit' || status === 'running';
}

function ThreadStreamingIndicator({
  shapeMotionSuppressed,
  workingTextOwnsMotion,
}: {
  readonly shapeMotionSuppressed: boolean;
  readonly workingTextOwnsMotion: boolean;
}) {
  const t = useT();
  const gradientId = `thread-shape-${useId().replaceAll(':', '')}`;
  return (
    <div className="thread-streaming-indicator" aria-label={t.agent.message.assistantResponding}>
      <svg
        aria-hidden
        className={`thread-streaming-shape${workingTextOwnsMotion ? ' is-working-text-owned' : ''}${shapeMotionSuppressed ? ' is-motion-suppressed' : ''}`}
        viewBox="0 0 48 48"
      >
        <defs>
          <linearGradient className="thread-shape-gradient" id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop className="thread-shape-stop-0" offset="0%" />
            <stop className="thread-shape-stop-1" offset="55%" />
            <stop className="thread-shape-stop-2" offset="100%" />
          </linearGradient>
        </defs>
        <path fill={`url(#${gradientId})`} />
      </svg>
    </div>
  );
}

/**
 * Wall-clock elapsed since the Turn started — the same span the server records
 * as `durationMs`, so the live label and the settled one cannot disagree. Time
 * spent blocked on the user is part of that span; the divider says so by
 * naming the wait instead of pretending the clock stopped.
 */
function useTurnElapsedMs(turn: Turn): number | null {
  const [now, setNow] = useState(() => Date.now());
  const active = turn.status === 'inProgress';
  const knownStart = active && turn.startedAt > 1_000_000_000_000 ? turn.startedAt : null;
  useEffect(() => {
    if (knownStart === null) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [knownStart]);
  return knownStart === null ? null : Math.max(0, now - knownStart);
}

export function threadProcessSummary(
  turn: Turn,
  items: readonly ThreadItem[],
  hasFinalResponse: boolean,
  liveElapsedMs: number | null,
  t: Messages,
  index: DocumentIndex,
  subagents: SubagentTurnProjection,
  blockedOnUser = false,
): string {
  // Blocked on the user is not work in progress, and it outranks the elapsed
  // label: "Working for 4m" while the run waits on an answer is a lie.
  if (blockedOnUser) return t.agent.thread.waitingOnUserInput;
  if (turn.status === 'inProgress') {
    return liveElapsedMs !== null && liveElapsedMs >= 1_000
      ? t.agent.thread.workingFor({ duration: formatProcessDuration(liveElapsedMs) })
      : t.agent.thread.working;
  }
  if (turn.status === 'failed' && !hasFinalResponse) return t.agent.thread.turnFailed;
  if (turn.status === 'interrupted' && !hasFinalResponse) return t.agent.thread.turnInterrupted;
  if (turn.status === 'completed' && hasFinalResponse && turn.durationMs !== null) {
    return t.agent.thread.workedFor({ duration: formatProcessDuration(turn.durationMs) });
  }
  return threadProcessNeutralHeader(turn, items, t, index, subagents);
}

/**
 * What the Turn did, with no status claim attached. Used where the status is
 * owned elsewhere (the response tail) and as the settled fallback — a finished
 * Turn must never fall through to the live "Working" label.
 */
function threadProcessNeutralHeader(
  turn: Turn,
  items: readonly ThreadItem[],
  t: Messages,
  index: DocumentIndex,
  subagents: SubagentTurnProjection,
): string {
  const tools = items.filter(isThreadToolItem);
  const reasoning = items.find((item): item is Extract<ThreadItem, { type: 'reasoning' }> => item.type === 'reasoning');
  const activity = tools.length === 1
    ? summarizeThreadToolItem(tools[0]!, t.agent.thread.activity, index)
    : tools.length > 1
      ? summarizeThreadToolActivity(tools, t.agent.thread.activity, index, {
          collaborationThreadIds: subagents.collaborationThreadIds,
        })
      : '';
  if (reasoning) {
    if (activity) return `${t.agent.thinking.thought} · ${sentenceFragment(activity)}`;
    const gist = firstProcessLine([...reasoning.summary, ...reasoning.content].join('\n'));
    return gist ? `${t.agent.thinking.thought} · ${gist}` : t.agent.thinking.thought;
  }
  if (activity) return activity;
  // A settled Turn with nothing to describe says what it did, in the past — the
  // old fallback here claimed "Working" on a Turn that had already finished.
  if (turn.status !== 'inProgress') {
    return turn.durationMs !== null
      ? t.agent.thread.workedFor({ duration: formatProcessDuration(turn.durationMs) })
      : t.agent.thread.worked;
  }
  return t.agent.thread.working;
}

function firstProcessLine(value: string): string {
  const first = value.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return first.length > 80 ? `${first.slice(0, 80)}...` : first;
}

function sentenceFragment(value: string): string {
  if (!value) return value;
  return `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function formatProcessDuration(durationMs: number): string {
  const elapsed = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (elapsed < 1_000) return '<1s';
  const totalSeconds = Math.round(elapsed / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    days > 0 ? `${days}d` : '',
    hours > 0 ? `${hours}h` : '',
    minutes > 0 ? `${minutes}m` : '',
    seconds > 0 ? `${seconds}s` : '',
  ].filter(Boolean).join(' ');
}

export type ThreadContentBlock =
  | { readonly kind: 'item'; readonly item: ThreadItem }
  | { readonly kind: 'process'; readonly items: readonly ThreadItem[] };

export function groupTurnContent(turn: Turn): ThreadContentBlock[] {
  const processItems = turn.items.filter(isThreadProcessItem);
  const itemBlocks = turn.items
    .filter((item) => !isThreadProcessItem(item) && !isEmptyCommentaryItem(item))
    .map((item) => ({ kind: 'item' as const, item }));
  const hasFinalResponse = itemBlocks.some((block) => isFinalResponseItem(block.item));
  const needsProcessBlock = processItems.length > 0
    || turn.status === 'inProgress'
    || (turn.status === 'completed' && hasFinalResponse && turn.durationMs !== null);
  if (!needsProcessBlock) return itemBlocks;

  const firstResponseIndex = itemBlocks.findIndex((block) => isFinalResponseItem(block.item));
  const blocks: ThreadContentBlock[] = [...itemBlocks];
  blocks.splice(
    firstResponseIndex < 0 ? blocks.length : firstResponseIndex,
    0,
    { kind: 'process', items: processItems },
  );
  return blocks;
}

export function isThreadProcessItem(item: ThreadItem): boolean {
  if (isThreadToolItem(item)) return true;
  if (item.type === 'agentMessage') {
    return item.phase === 'commentary' && item.text.trim().length > 0;
  }
  return item.type === 'reasoning'
    || item.type === 'subAgentActivity'
    || item.type === 'imageView';
}

function isEmptyCommentaryItem(item: ThreadItem): boolean {
  return item.type === 'agentMessage'
    && item.phase === 'commentary'
    && item.text.trim().length === 0;
}

type ThreadItemGroup =
  | { readonly kind: 'item'; readonly item: ThreadItem }
  | { readonly kind: 'tools'; readonly items: readonly ThreadToolItem[] };

function groupTurnItems(items: readonly ThreadItem[]): ThreadItemGroup[] {
  const groups: ThreadItemGroup[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (!item) break;
    if (!isThreadToolItem(item)) {
      groups.push({ kind: 'item', item });
      index += 1;
      continue;
    }
    const tools: ThreadToolItem[] = [item];
    index += 1;
    while (index < items.length && isThreadToolItem(items[index]!)) {
      tools.push(items[index] as ThreadToolItem);
      index += 1;
    }
    if (tools.length === 1) groups.push({ kind: 'item', item: tools[0]! });
    else groups.push({ kind: 'tools', items: tools });
  }
  return groups;
}

function lastAgentResponse(turn: Turn): Extract<ThreadItem, { type: 'agentMessage' }> | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item && isFinalResponseItem(item)) return item;
  }
  return null;
}

function isFinalResponseItem(
  item: ThreadItem,
): item is Extract<ThreadItem, { type: 'agentMessage' }> {
  return item.type === 'agentMessage'
    && (item.phase === 'final_answer' || item.phase === null);
}

function isSoloResultlessReasoning(turn: Turn, item: ThreadItem): boolean {
  if (item.type !== 'reasoning') return false;
  if (turn.items.some((candidate) => (
    isFinalResponseItem(candidate) && candidate.text.trim().length > 0
  ))) return false;
  const processItems = turn.items.filter(isThreadProcessItem);
  return processItems.length === 1 && processItems[0]?.id === item.id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attachmentFromPickedFile(file: {
  readonly entryKind?: 'file' | 'directory';
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly lastModified?: number;
  readonly iconDataUrl?: string;
  readonly thumbnailDataUrl?: string;
}): PreparedComposerAttachment {
  const entryKind = file.entryKind === 'directory' || file.mimeType === 'inode/directory'
    ? 'directory'
    : 'file';
  const mimeType = entryKind === 'directory' ? 'inode/directory' : file.mimeType || 'application/octet-stream';
  const id = crypto.randomUUID();
  const content: ThreadAttachmentContent = {
    type: 'attachment',
    id,
    name: file.name || 'attachment',
    mimeType,
    sizeBytes: file.sizeBytes,
    source: { kind: 'localFile', path: file.path },
  };
  return {
    content,
    reference: attachmentToComposerReference(content, file),
    sourceKey: `path:${file.path}`,
  };
}

async function attachmentFromBrowserFile(
  file: File,
  threadId: string,
  signal: AbortSignal,
): Promise<PreparedComposerAttachment> {
  throwIfAttachmentUploadAborted(signal);
  const name = file.name || 'attachment';
  const mimeType = file.type || 'application/octet-stream';
  const id = crypto.randomUUID();
  const nativePath = window.lin?.getFilePath?.(file) ?? '';
  let content: ThreadAttachmentContent;
  if (nativePath) {
    content = {
      type: 'attachment',
      id,
      name,
      mimeType,
      sizeBytes: file.size,
      source: { kind: 'localFile', path: nativePath },
    };
  } else {
    if (file.size > MAX_MANAGED_ATTACHMENT_BYTES) {
      throw new Error(`${name} exceeds the pathless attachment storage budget.`);
    }
    const ref = await uploadPathlessAttachment(file, threadId, id, name, mimeType, signal);
    content = {
      type: 'attachment',
      id,
      name,
      mimeType,
      sizeBytes: file.size,
      source: { kind: 'threadPayload', ref },
    };
  }
  throwIfAttachmentUploadAborted(signal);
  const previewUrl = mimeType.startsWith('image/') ? URL.createObjectURL(file) : undefined;
  return {
    content,
    ...(previewUrl ? { previewUrl } : {}),
    reference: attachmentToComposerReference(content, {
      entryKind: 'file',
      ...(nativePath ? { path: nativePath } : {}),
      ...(previewUrl ? { thumbnailDataUrl: previewUrl } : {}),
    }),
    sourceKey: nativePath ? `path:${nativePath}` : `payload:${content.source.kind === 'threadPayload' ? content.source.ref.id : id}`,
  };
}

async function uploadPathlessAttachment(
  file: File,
  threadId: string,
  attachmentId: string,
  name: string,
  mimeType: string,
  signal: AbortSignal,
) {
  const bridge = window.lin;
  if (
    !bridge?.beginAttachmentUpload
    || !bridge.appendAttachmentUpload
    || !bridge.finishAttachmentUpload
    || !bridge.abortAttachmentUpload
    || !bridge.discardAttachmentResource
  ) throw new Error('Attachment streaming is unavailable.');
  throwIfAttachmentUploadAborted(signal);
  const { uploadId } = await bridge.beginAttachmentUpload({
    threadId,
    attachmentId,
    name,
    mimeType,
    sizeBytes: file.size,
  });
  const identity = { threadId, attachmentId, uploadId };
  let completedRef: ThreadResourceReference | null = null;
  try {
    const reader = file.stream().getReader();
    const abortReader = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abortReader, { once: true });
    try {
      for (;;) {
        throwIfAttachmentUploadAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength; offset += ATTACHMENT_UPLOAD_CHUNK_BYTES) {
          throwIfAttachmentUploadAborted(signal);
          const source = value.subarray(offset, offset + ATTACHMENT_UPLOAD_CHUNK_BYTES);
          const chunk = new Uint8Array(source.byteLength);
          chunk.set(source);
          await bridge.appendAttachmentUpload({ ...identity, bytes: chunk.buffer });
        }
      }
    } finally {
      signal.removeEventListener('abort', abortReader);
      reader.releaseLock();
    }
    throwIfAttachmentUploadAborted(signal);
    completedRef = await bridge.finishAttachmentUpload(identity);
    throwIfAttachmentUploadAborted(signal);
    return completedRef;
  } catch (error) {
    if (completedRef) {
      await bridge.discardAttachmentResource({ threadId, ref: completedRef }).catch(() => undefined);
    } else {
      await bridge.abortAttachmentUpload(identity).catch(() => undefined);
    }
    throw error;
  }
}

function throwIfAttachmentUploadAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Attachment upload was canceled.', 'AbortError');
}

function uniqueAttachments(attachments: readonly ThreadAttachmentContent[]): ThreadAttachmentContent[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = attachment.source.kind === 'localFile'
      ? `path:${attachment.source.path}`
      : `payload:${attachment.source.ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Renderer-only source keys preserve duplicate handling without extending the
// canonical ThreadAttachmentContent protocol.
function currentAttachmentSourceKeys(
  attachments: readonly ThreadAttachmentContent[],
  sourceKeys: ReadonlyMap<string, string>,
): Set<string> {
  return new Set(attachments.map((attachment) => (
    sourceKeys.get(attachment.id) ?? canonicalAttachmentSourceKey(attachment)
  )));
}

function canonicalAttachmentSourceKey(attachment: ThreadAttachmentContent): string {
  if (attachment.source.kind === 'localFile') return `path:${attachment.source.path}`;
  return `payload:${attachment.source.ref.id}`;
}

function sameManagedResource(
  left: ThreadAttachmentContent,
  right: ThreadAttachmentContent,
): boolean {
  return left.source.kind === 'threadPayload'
    && right.source.kind === 'threadPayload'
    && left.source.ref.id === right.source.ref.id
    && left.source.ref.fileName === right.source.ref.fileName;
}

function discardManagedAttachment(threadId: string, attachment: ThreadAttachmentContent): void {
  if (attachment.source.kind !== 'threadPayload' || !window.lin?.discardAttachmentResource) return;
  void window.lin.discardAttachmentResource({ threadId, ref: attachment.source.ref }).catch(() => undefined);
}

function discardPreparedAttachment(threadId: string, attachment: PreparedComposerAttachment): void {
  discardManagedAttachment(threadId, attachment.content);
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

function releaseAttachmentUiState(
  attachmentId: string,
  previewUrls: Map<string, string>,
  sourceKeys: Map<string, string>,
): void {
  const previewUrl = previewUrls.get(attachmentId);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrls.delete(attachmentId);
  sourceKeys.delete(attachmentId);
}

function duplicateAttachmentMessage(count: number, labels: Messages['agent']['composer']): string | null {
  return count > 0 ? labels.skippedDuplicates({ count }) : null;
}

function overflowAttachmentMessage(count: number, labels: Messages['agent']['composer']): string | null {
  return count > 0 ? labels.skippedOverflow({ count, max: MAX_ATTACHMENTS }) : null;
}

function threadContentFromDraft(
  draft: ThreadComposerDraft,
  attachments: readonly ThreadAttachmentContent[],
): ThreadUserContent[] {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const content = draft.content.flatMap((part): ThreadUserContent[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    if (part.type === 'nodeReference') {
      return [{
        type: 'nodeReference',
        nodeId: part.reference.nodeId,
        note: part.reference.title,
      }];
    }
    const attachment = byId.get(part.reference.attachmentId);
    return attachment ? [attachment] : [];
  });
  const firstTextIndex = content.findIndex((part) => part.type === 'text');
  let lastTextIndex = -1;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (content[index]?.type === 'text') {
      lastTextIndex = index;
      break;
    }
  }
  return content.flatMap((part, index): ThreadUserContent[] => {
    if (part.type !== 'text') return [part];
    const text = index === firstTextIndex && index === lastTextIndex
      ? part.text.trim()
      : index === firstTextIndex
        ? part.text.trimStart()
        : index === lastTextIndex
          ? part.text.trimEnd()
          : part.text;
    return text ? [{ type: 'text', text }] : [];
  });
}

function attachmentToComposerReference(
  attachment: ThreadAttachmentContent,
  candidate?: {
    readonly entryKind?: 'file' | 'directory';
    readonly iconDataUrl?: string;
    readonly path?: string;
    readonly thumbnailDataUrl?: string;
  },
): ThreadComposerFileReference {
  const entryKind = candidate?.entryKind === 'directory' || attachment.mimeType === 'inode/directory'
    ? 'directory'
    : 'file';
  return {
    attachmentId: attachment.id,
    entryKind,
    ...(candidate?.iconDataUrl ? { iconDataUrl: candidate.iconDataUrl } : {}),
    name: attachment.name,
    ...(candidate?.path
      ? { path: candidate.path }
      : attachment.source.kind === 'localFile' ? { path: attachment.source.path } : {}),
    ref: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(candidate?.thumbnailDataUrl ? { thumbnailDataUrl: candidate.thumbnailDataUrl } : {}),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}
