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
  ProviderRetryStatus,
  ThreadAttachmentContent,
  ThreadConfigurationSummary,
  ThreadItem,
  ThreadResourceReference,
  ThreadUserContent,
  Turn,
} from '../../../core/agent/protocol';
import type { ThreadGoal } from '../../../core/agent/goal';
import type { AgentProviderSettingsView, AgentSlashCommandView } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { useI18n, useT } from '../../i18n/I18nProvider';
import {
  acknowledgeThreadComposerNodeReferenceRequest,
  onThreadComposerNodeReferenceRequest,
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
  SendIcon,
  StopIcon,
  WarningIcon,
} from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { ButtonControl } from '../../ui/primitives/ButtonControl';
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
import { userFacingAgentError } from '../threadErrorMessage';
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
} from '../../ui/interactions/disclosureScrollAnchor';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { formatDateTime } from '../../ui/formatting';
import { ThreadUsageBreakdown } from './ThreadUsageBreakdown';
import {
  hasTranscriptContentBelow,
  isTranscriptFollowing,
  TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX,
} from '../threadScrollFollow';

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
  readonly turns: readonly Turn[];
  readonly inputRequest: RequestUserInputRequest | null;
  /** The run is blocked on the user. The divider stops claiming work is
   *  happening, and the elapsed timer stops counting the wait as work. */
  readonly waitingOnUserInput: boolean;
  readonly providerRetry: { readonly turnId: string; readonly status: ProviderRetryStatus } | null;
  readonly plan: ActiveTurnPlan | null;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onContinueInNewChat: (turn: Turn) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onConfigurationChange: (configuration: ThreadConfigurationSummary) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onOpenTurnDetails: (turn: Turn) => void;
  readonly onReadToolOutput: (turnId: string, item: ThreadToolItem) => Promise<string | null>;
  readonly onSend: (content: readonly ThreadUserContent[]) => Promise<Turn | null>;
  readonly onSubmitUserInput: (answers: readonly RequestUserInputAnswer[]) => Promise<void>;
}

const MAX_ATTACHMENTS = 6;
const ATTACHMENT_ERROR_TIMEOUT_MS = 5_000;
const TRANSCRIPT_ROW_GAP_PX = 12;
const TRANSCRIPT_ROW_ESTIMATE_PX = 104;
const TRANSCRIPT_VIRTUAL_MIN_TURNS = 40;
const TRANSCRIPT_VIRTUAL_OVERSCAN_PX = 720;
const MAX_CACHED_THREAD_UI_STATES = 32;
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

interface ThreadScrollSnapshot {
  readonly follow: boolean;
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
  turns,
  inputRequest,
  waitingOnUserInput,
  providerRetry,
  onEditUserMessage,
  onContinueInNewChat,
  onInterrupt,
  onConfigurationChange,
  onOpenNodeReference,
  onOpenThread,
  onOpenTurnDetails,
  onReadToolOutput,
  onSend,
  onSubmitUserInput,
}: ThreadViewProps) {
  const t = useT();
  const waitingForInput = Boolean(inputRequest);
  const initialScrollSnapshot = threadScrollSnapshots.get(threadId);
  const [draft, setDraft] = useState<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ThreadAttachmentContent[]>([]);
  const [recentLocalFiles, setRecentLocalFiles] = useState<ThreadComposerLocalFileCandidate[]>([]);
  const [follow, setFollow] = useState(initialScrollSnapshot?.follow ?? true);
  const [sendAnchorSpacer, setSendAnchorSpacer] = useState<SendAnchorSpacer | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ThreadComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const pendingSendAnchorFrameRef = useRef<number | null>(null);
  const scrollMetricsFrameRef = useRef<number | null>(null);
  const virtualScrollAdjustmentFrameRef = useRef<number | null>(null);
  const followRef = useRef(follow);
  const expectedProgrammaticScrollTopRef = useRef<number | null>(null);
  const pendingVirtualScrollAdjustmentRef = useRef<PendingVirtualScrollAdjustment | null>(null);
  const pendingSendScrollRef = useRef<PendingSendAnchor | null>(null);
  const sendAnchorSpacerRef = useRef<SendAnchorSpacer | null>(null);
  const scrollRestoreRef = useRef<{ readonly top: number } | null>(
    initialScrollSnapshot?.follow === false ? { top: initialScrollSnapshot.top } : null,
  );
  const attachmentsRef = useRef<ThreadAttachmentContent[]>([]);
  const attachmentOperationTailRef = useRef<Promise<void>>(Promise.resolve());
  const attachmentLifecycleControllerRef = useRef<AbortController | null>(null);
  const attachmentPreviewUrlsRef = useRef(new Map<string, string>());
  const attachmentSourceKeysRef = useRef(new Map<string, string>());
  const draftRef = useRef<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const handledFocusTokenRef = useRef(0);
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
  const activeTurn = useMemo(() => findActiveTurn(turns), [turns]);
  const activePlan = activeTurn && plan?.turnId === activeTurn.id ? plan : null;
  const editableTurnId = useMemo(() => latestUserMessageTurnId(turns), [turns]);
  const turnCountRef = useRef(turns.length);
  turnCountRef.current = turns.length;
  const hasDraft = !draft.empty;
  const itemCount = turns.reduce((count, turn) => count + turn.items.length, 0);
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
      element.scrollHeight - (spacer?.getBoundingClientRect().height ?? 0),
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
    const nextFollow = isTranscriptFollowing(element);
    setFollowValue(nextFollow);
    cacheThreadScrollSnapshot(threadId, { follow: nextFollow, top: element.scrollTop });
    updateScrollMetrics(element);
  }, [setFollowValue, threadId, updateScrollMetrics]);

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

  const handleDisclosureAnchorRestore = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    expectedProgrammaticScrollTopRef.current = scroll.scrollTop;
    synchronizeScrollPosition(scroll);
  }, [synchronizeScrollPosition]);

  const {
    capturePendingAnchor,
    holdUntilSettled,
    restorePendingAnchor,
  } = usePendingDisclosureAnchor(handleDisclosureAnchorRestore);

  const expandState = useMemo<ThreadDisclosureState>(() => ({
    holdAnchorUntilSettled: holdUntilSettled,
    isExpanded: (id, defaultExpanded = false) => disclosureOverrides[id] ?? defaultExpanded,
    toggle: (id, currentlyExpanded, anchorElement) => {
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
  }), [capturePendingAnchor, disclosureOverrides, holdUntilSettled, threadId]);

  const handleUserDisclosureToggle = useCallback((anchorElement: HTMLElement | null) => {
    const scroller = nearestScrollContainer(anchorElement, scrollRef.current);
    capturePendingAnchor(captureDisclosureScrollAnchor(anchorElement, scroller));
    restorePendingAnchor();
  }, [capturePendingAnchor, restorePendingAnchor]);

  const attemptScrollRestore = useCallback(() => {
    const request = scrollRestoreRef.current;
    const scroll = scrollRef.current;
    if (!request || !scroll || turnCountRef.current === 0) return;
    const maximumTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    scrollRestoreRef.current = null;
    setProgrammaticScrollTop(scroll, Math.min(maximumTop, request.top));
  }, [setProgrammaticScrollTop]);

  const scheduleBottomPin = useCallback(() => {
    if (!followRef.current || bottomScrollFrameRef.current !== null) return;
    bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      const scroll = scrollRef.current;
      if (!scroll || !followRef.current) return;
      setProgrammaticScrollTop(scroll, scroll.scrollHeight);
    });
  }, [setProgrammaticScrollTop]);

  const scheduleSendAnchorLayout = useCallback(() => {
    if (pendingSendAnchorFrameRef.current !== null) return;
    pendingSendAnchorFrameRef.current = window.requestAnimationFrame(() => {
      pendingSendAnchorFrameRef.current = null;
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
        scroll.scrollHeight - (renderedSpacer?.getBoundingClientRect().height ?? 0),
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
  }, [measuredTurnHeights, setProgrammaticScrollTop, updateSendAnchorSpacer]);

  const measureTurn = useCallback((turnId: string, height: number, element: HTMLDivElement) => {
    const current = measuredTurnHeights.get(turnId);
    if (current !== undefined && Math.abs(current - height) < 1) return;
    const state = virtualStateRef.current;
    const turnIndex = state.turns.findIndex((turn) => turn.id === turnId);
    const turn = state.turns[turnIndex];
    const previousHeight = current ?? (turn ? estimateTurnHeight(turn) : height);
    const delta = height - previousHeight;
    const scroll = scrollRef.current;
    if (state.virtualized && scroll && !followRef.current && Math.abs(delta) >= 1) {
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
  }, [measuredTurnHeights, scheduleSendAnchorLayout]);

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
      if (!latestAdjustment || !scroll || followRef.current) return;
      setProgrammaticScrollTop(scroll, latestAdjustment.top);
    });
  }, [measureVersion, setProgrammaticScrollTop]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return undefined;
    const synchronizeLayout = () => {
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
    scheduleBottomPin,
    scheduleSendAnchorLayout,
    updateScrollMetrics,
  ]);

  useLayoutEffect(() => {
    attemptScrollRestore();
    scheduleSendAnchorLayout();
    scheduleBottomPin();
  }, [
    attemptScrollRestore,
    itemCount,
    pendingSendVersion,
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
    const scroll = scrollRef.current;
    if (scroll && !scrollRestoreRef.current) {
      cacheThreadScrollSnapshot(threadId, {
        follow: isTranscriptFollowing(scroll),
        top: scroll.scrollTop,
      });
    }
  }, [cancelPendingVirtualScrollAdjustment, threadId]);

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
      || providerBlocksSend
      || currentDraft.empty
      || sending
      || waitingForInput) return;
    const submittedContent = threadContentFromDraft(currentDraft, attachmentsRef.current);
    const submittedAttachments = submittedContent.filter(
      (content): content is ThreadAttachmentContent => content.type === 'attachment',
    );
    const submittedAttachmentIds = new Set(submittedAttachments.map((attachment) => attachment.id));
    const editorSnapshot = composerRef.current?.snapshot() ?? null;
    const scroll = scrollRef.current;
    const previousViewport = scroll ? {
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
    clearSendAnchorSpacer();
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
        setFollowValue(previousViewport.follow);
        cacheThreadScrollSnapshot(threadId, {
          follow: previousViewport.follow,
          top: previousViewport.top,
        });
        if (previousViewport.spacer) {
          scrollRestoreRef.current = { top: previousViewport.top };
        } else {
          scrollRestoreRef.current = null;
          setProgrammaticScrollTop(currentScroll, previousViewport.top);
        }
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
            const nextFollow = isTranscriptFollowing(scroll);
            setFollowValue(nextFollow);
            cacheThreadScrollSnapshot(threadId, { follow: nextFollow, top: scroll.scrollTop });
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
                      onMeasure={measureTurn}
                      style={virtualized && layoutItem ? { transform: `translateY(${layoutItem.top}px)` } : undefined}
                      turnId={turn.id}
                      virtualized={virtualized}
                    >
                      <ThreadTurnView
                        canEditUserMessage={turn.id === editableTurnId && turn.status !== 'inProgress'}
                        expandState={expandState}
                        index={index}
                        onDisclosureToggle={handleUserDisclosureToggle}
                        onEditUserMessage={onEditUserMessage}
                        onContinueInNewChat={onContinueInNewChat}
                        onOpenNodeReference={onOpenNodeReference}
                        onOpenThread={onOpenThread}
                        onOpenTurnDetails={onOpenTurnDetails}
                        onReadToolOutput={onReadToolOutput}
                        threadId={threadId}
                        threadCwd={threadCwd}
                        turn={turn}
                        waitingOnUserInput={waitingOnUserInput}
                      />
                    </ThreadTranscriptTurnShell>
                  );
                })}
              </div>
            ) : null}
            {providerRetry ? <ThreadProviderRetryStatus status={providerRetry.status} /> : null}
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
              clearSendAnchorSpacer();
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
      {composerEnabled ? <div className="thread-composer-region thread-composer" ref={composerRegionRef}>
        {activePlan ? <ThreadPlanProgress plan={activePlan} /> : null}
        <div
          className={`thread-composer-surface${dragActive ? ' is-dragging' : ''}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {inputRequest ? <UserInputRequest onSubmit={onSubmitUserInput} request={inputRequest} /> : null}
          <div className="thread-composer-main" hidden={waitingForInput}>
              {dragActive ? <div className="thread-composer-drop-overlay">{t.agent.thread.dropFilesToAttach}</div> : null}
              {error ? <p className="thread-inline-error" role="status">{error}</p> : null}
              <ThreadComposerEditor
                allowFileReferences={!activeTurn && !providerBlocksSend && !waitingForInput}
                allowNodeReferences={!waitingForInput}
                allowSlashCommands
                currentNodeId={null}
                disabled={waitingForInput}
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
                  disabled={providerBlocksSend || Boolean(activeTurn) || attachments.length >= MAX_ATTACHMENTS || sending}
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
                    disabled={providerBlocksSend || !hasDraft || sending}
                    icon={SendIcon}
                    label={activeTurn ? t.agent.thread.steer : t.agent.thread.send}
                    onClick={() => void submit()}
                    title={providerBlocksSend
                      ? t.agent.thread.providerRequired
                      : activeTurn ? t.agent.thread.steer : t.agent.thread.send}
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
  onMeasure,
  style,
  turnId,
  virtualized,
}: {
  readonly children: ReactNode;
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
      style={style}
    >
      {children}
    </div>
  );
}

const ThreadTurnView = memo(function ThreadTurnView({
  canEditUserMessage,
  expandState,
  index,
  onDisclosureToggle,
  onEditUserMessage,
  onContinueInNewChat,
  onOpenNodeReference,
  onOpenThread,
  onOpenTurnDetails,
  onReadToolOutput,
  threadId,
  threadCwd,
  turn,
  waitingOnUserInput,
}: {
  readonly canEditUserMessage: boolean;
  readonly expandState: ThreadDisclosureState;
  readonly index: DocumentIndex;
  readonly onDisclosureToggle: (anchorElement: HTMLElement | null) => void;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onContinueInNewChat: (turn: Turn) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onOpenTurnDetails: (turn: Turn) => void;
  readonly onReadToolOutput: (turnId: string, item: ThreadToolItem) => Promise<string | null>;
  readonly threadId: string;
  readonly threadCwd: string;
  readonly turn: Turn;
  readonly waitingOnUserInput: boolean;
}) {
  const t = useT();
  const responseItem = lastAgentResponse(turn);
  const standaloneContextBoundary = turn.status !== 'inProgress'
    && isStandaloneContextBoundaryTurn(turn);
  const contentBlocks = groupTurnContent(turn);
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
  const copyTurn = useCallback(async () => {
    const text = await buildTurnCopyText(turn, readToolOutput, t.agent.thread.resourceLimitReached);
    if (text) await navigator.clipboard.writeText(text);
  }, [readToolOutput, t.agent.thread.resourceLimitReached, turn]);
  const handleResponseContextMenu = useCallback(async (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const action = await window.lin?.showThreadMessageContextMenu?.({
      canCopy: hasTurnCopyContent(turn),
      canContinueInNewChat: true,
      canShowDetails: true,
    });
    if (action === 'copy') await copyTurn();
    else if (action === 'continueInNewChat') await continueInNewChat();
    else if (action === 'details') onOpenTurnDetails(turn);
  }, [continueInNewChat, copyTurn, onOpenTurnDetails, turn]);
  const responseTail = standaloneContextBoundary ? null : (
    <ThreadResponseTail
      onCopy={copyTurn}
      onContinueInNewChat={continueInNewChat}
      onOpenDetails={() => onOpenTurnDetails(turn)}
      // With no response Item the process divider already states the terminal
      // status, so the synthetic tail must not repeat it a line below.
      statusOwnedElsewhere={responseItem === null}
      turn={turn}
    />
  );
  const renderItem = (item: ThreadItem, showMessageActions: boolean) => (
    <ThreadItemView
      agentResponseTail={item.id === responseItem?.id ? responseTail : null}
      canEditUserMessage={canEditUserMessage && showMessageActions}
      defaultReasoningExpanded={reasoningDefaultExpanded(turn, item)}
      expandState={expandState}
      index={index}
      item={item}
      key={item.id}
      onAgentMessageContextMenu={item.id === responseItem?.id ? handleResponseContextMenu : undefined}
      onEditUserMessage={editUserMessage}
      onDisclosureToggle={onDisclosureToggle}
      onOpenNodeReference={onOpenNodeReference}
      onOpenTurnDetails={standaloneContextBoundary ? () => onOpenTurnDetails(turn) : undefined}
      onOpenThread={onOpenThread}
      onReadToolOutput={readToolOutput}
      showMessageActions={showMessageActions}
      streaming={turn.status === 'inProgress' && turn.items.at(-1)?.id === item.id}
      threadId={threadId}
      threadCwd={threadCwd}
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
              waitingOnUserInput={waitingOnUserInput}
              key={`process:${block.items[0]?.id ?? turn.id}`}
              turn={turn}
            >
              {groupTurnItems(block.items).map((group) => group.kind === 'tools' ? (
                <ThreadToolActivityGroup
                  expandState={expandState}
                  index={index}
                  items={group.items}
                  key={group.items[0]?.id}
                  onOpenThread={onOpenThread}
                  onReadToolOutput={readToolOutput}
                  threadId={threadId}
                  threadCwd={threadCwd}
                />
              ) : renderItem(group.item, false))}
            </ThreadProcessBlock>
          );
        }
        const item = block.item;
        return renderItem(item, turn.status !== 'inProgress' && item.type === 'userMessage');
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
  onCopy,
  onContinueInNewChat,
  onOpenDetails,
  statusOwnedElsewhere,
  turn,
}: {
  readonly onCopy: () => Promise<void>;
  readonly onContinueInNewChat: () => Promise<void>;
  readonly onOpenDetails: () => void;
  readonly statusOwnedElsewhere: boolean;
  readonly turn: Turn;
}) {
  const t = useT();
  const [usageHoverOpen, setUsageHoverOpen] = useState(false);
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
      {!streaming && interrupted ? (
        <div className="thread-response-stopped">
          <StopIcon aria-hidden size={ICON_SIZE.menu} />
          <span>{t.agent.thread.turnInterrupted}</span>
        </div>
      ) : null}
      <div className="thread-response-footer">
        {streaming ? <ThreadStreamingIndicator /> : (
          <div className="thread-message-actions thread-response-actions">
            <ThreadMessageCopyButton
              iconSize={ICON_SIZE.menu}
              label={t.agent.message.copyMessage}
              onCopy={onCopy}
              text=""
            />
            <IconButton
              icon={GitForkIcon}
              iconSize={ICON_SIZE.menu}
              label={t.agent.thread.continueInNewChat}
              onClick={() => void onContinueInNewChat()}
              variant="message"
            />
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
    <div aria-atomic="true" aria-live="polite" className="thread-provider-retry" role="status">
      <LoaderIcon aria-hidden size={ICON_SIZE.tiny} />
      <span>{t.agent.thread.reconnecting({ attempt: status.attempt, maxRetries: status.maxRetries })}</span>
    </div>
  );
}

function ThreadPlanProgress({ plan }: { readonly plan: ActiveTurnPlan }) {
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
  const current = activeIndex >= 0 ? activeIndex + 1 : pendingIndex >= 0 ? pendingIndex + 1 : total;
  const complete = plan.plan.every((step) => step.status === 'completed');
  return (
    <div
      className={`thread-plan-progress${open ? ' is-open' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        aria-controls={popoverId}
        aria-expanded={open}
        aria-live="polite"
        className="thread-plan-progress-summary"
        id={summaryId}
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) {
            window.requestAnimationFrame(() => popoverRef.current?.focus());
          }
        }}
        ref={summaryRef}
        type="button"
      >
        {complete
          ? <CheckIcon aria-hidden size={ICON_SIZE.tiny} />
          : <LoaderIcon aria-hidden className="thread-plan-progress-spinner" size={ICON_SIZE.tiny} />}
        <span>{t.agent.thread.planProgress({ current, total })}</span>
      </button>
      <div
        aria-labelledby={summaryId}
        className="thread-plan-progress-popover"
        id={popoverId}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setOpen(false);
          summaryRef.current?.focus();
        }}
        ref={popoverRef}
        role="region"
        tabIndex={0}
      >
        {plan.explanation ? <p>{plan.explanation}</p> : null}
        <ol>
          {plan.plan.map((step, index) => (
            <li className={`is-${step.status}`} key={`${index}:${step.step}`}>
              <span aria-hidden className="thread-plan-step-status">
                {step.status === 'completed' ? <CheckIcon size={ICON_SIZE.tiny} /> : null}
                {step.status === 'in_progress' ? <LoaderIcon size={ICON_SIZE.tiny} /> : null}
              </span>
              <span>{step.step}</span>
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

async function buildTurnCopyText(
  turn: Turn,
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
    parts.push(`\`\`\`tool ${toolCopyName(item)}\n${toolCopyArguments(item)}\n\`\`\``);
    const output = await readToolOutput(item) ?? projectedToolOutput(item);
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
  switch (item.type) {
    case 'commandExecution': return 'bash';
    case 'fileChange': return 'file_change';
    case 'mcpToolCall': return `${item.server}.${item.tool}`;
    case 'dynamicToolCall': return [item.namespace, item.tool].filter(Boolean).join('.');
    case 'collabAgentToolCall': return `collaboration.${item.tool}`;
    case 'webSearch': return 'web_search';
    default: return assertNever(item);
  }
}

function toolCopyArguments(item: ThreadToolItem): string {
  switch (item.type) {
    case 'commandExecution': return jsonText({ command: item.command, cwd: item.cwd });
    case 'fileChange': return jsonText({ changes: item.changes });
    case 'mcpToolCall':
    case 'dynamicToolCall': return jsonText(item.arguments);
    case 'collabAgentToolCall': return jsonText({
      tool: item.tool,
      prompt: item.prompt,
      model: item.model,
      reasoningEffort: item.reasoningEffort,
      receiverThreadIds: item.receiverThreadIds,
    });
    case 'webSearch': return jsonText({ query: item.query });
    default: return assertNever(item);
  }
}

function projectedToolOutput(item: ThreadToolItem): string {
  switch (item.type) {
    case 'commandExecution': return item.aggregatedOutput ?? '';
    case 'fileChange': return '';
    case 'mcpToolCall': return item.error ?? (item.result === null ? '' : jsonText(item.result));
    case 'dynamicToolCall': return (item.contentItems ?? []).flatMap((content) => (
      content.type === 'text' ? [content.text] : content.type === 'json' ? [jsonText(content.value)] : []
    )).join('\n');
    case 'collabAgentToolCall': return jsonText(item.agentsStates);
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
    if (turn?.items.some((item) => item.type === 'userMessage')) return turn.id;
  }
  return null;
}

function ThreadProcessBlock({
  children,
  expandState,
  hasFinalResponse,
  index,
  items,
  turn,
  waitingOnUserInput,
}: {
  readonly children: ReactNode;
  readonly expandState: ThreadDisclosureState;
  readonly hasFinalResponse: boolean;
  readonly index: DocumentIndex;
  readonly items: readonly ThreadItem[];
  readonly turn: Turn;
  readonly waitingOnUserInput: boolean;
}) {
  const t = useT();
  const disclosureId = `process:${turn.id}`;
  const expanded = expandState.isExpanded(disclosureId, false);
  // While the run is blocked on the user, the clock stops: the wait is not work,
  // and a timer that keeps counting says the agent is still busy.
  const blockedOnUser = turn.status === 'inProgress' && waitingOnUserInput;
  const liveElapsedMs = useTurnElapsedMs(turn, blockedOnUser);
  const collapsible = turn.status === 'completed'
    && hasFinalResponse
    && turn.durationMs !== null
    && items.length > 0;
  const terminalResponseOwnsStatus = hasFinalResponse
    && (turn.status === 'failed' || turn.status === 'interrupted');
  const summary = threadProcessSummary(
    turn, items, hasFinalResponse, liveElapsedMs, t, index, blockedOnUser,
  );
  const timelineVisible = items.length > 0 && (!collapsible || expanded);
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
          <span className="thread-process-title">{summary}</span>
          {turn.status === 'inProgress' && !blockedOnUser ? (
            <LoaderIcon className="thread-process-spinner" size={ICON_SIZE.rowGlyph} />
          ) : null}
        </div>
      )}
      {terminalResponseOwnsStatus ? null : <div aria-hidden className="thread-process-rule" />}
      {terminalResponseOwnsStatus && timelineVisible ? (
        // The response tail owns the terminal status, but the timeline still
        // needs a name — otherwise it is an unlabelled list of rows.
        <div className="thread-work-divider">
          <span className="thread-process-title">
            {threadProcessNeutralHeader(turn, items, t, index)}
          </span>
        </div>
      ) : null}
      {timelineVisible ? <div className="thread-process-timeline">{children}</div> : null}
    </div>
  );
}

function ThreadStreamingIndicator() {
  const t = useT();
  const gradientId = `thread-shape-${useId().replaceAll(':', '')}`;
  return (
    <div className="thread-streaming-indicator" aria-label={t.agent.message.assistantResponding}>
      <svg aria-hidden className="thread-streaming-shape" viewBox="0 0 48 48">
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

function useTurnElapsedMs(turn: Turn, frozen = false): number | null {
  const [now, setNow] = useState(() => Date.now());
  const active = turn.status === 'inProgress';
  const knownStart = active && turn.startedAt > 1_000_000_000_000 ? turn.startedAt : null;
  useEffect(() => {
    if (knownStart === null || frozen) return undefined;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [frozen, knownStart]);
  return knownStart === null ? null : Math.max(0, now - knownStart);
}

function threadProcessSummary(
  turn: Turn,
  items: readonly ThreadItem[],
  hasFinalResponse: boolean,
  liveElapsedMs: number | null,
  t: Messages,
  index: DocumentIndex,
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
  return threadProcessNeutralHeader(turn, items, t, index);
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
): string {
  const tools = items.filter(isThreadToolItem);
  const reasoning = items.find((item): item is Extract<ThreadItem, { type: 'reasoning' }> => item.type === 'reasoning');
  const activity = tools.length === 1
    ? summarizeThreadToolItem(tools[0]!, t.agent.thread.activity, index)
    : tools.length > 1
      ? summarizeThreadToolActivity(tools, t.agent.thread.activity, index)
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
    .filter((item) => !isThreadProcessItem(item))
    .map((item) => ({ kind: 'item' as const, item }));
  const hasFinalResponse = itemBlocks.some((block) => (
    block.item.type === 'agentMessage' && block.item.phase !== 'commentary'
  ));
  const needsProcessBlock = processItems.length > 0
    || turn.status === 'inProgress'
    || (turn.status === 'completed' && hasFinalResponse && turn.durationMs !== null);
  if (!needsProcessBlock) return itemBlocks;

  const firstResponseIndex = itemBlocks.findIndex((block) => (
    block.item.type === 'agentMessage' && block.item.phase !== 'commentary'
  ));
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
  if (item.type === 'agentMessage') return item.phase === 'commentary';
  return item.type === 'reasoning'
    || item.type === 'subAgentActivity'
    || item.type === 'imageView';
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
    if (item?.type === 'agentMessage' && item.phase !== 'commentary') return item;
  }
  return null;
}

/**
 * A live reasoning Item stays open while it is the tail of a running Turn.
 * `isSoloResultlessReasoning` flips to false the instant any newer Item lands,
 * which snapped an open disclosure shut mid-run and shifted the layout under
 * the reader.
 */
function reasoningDefaultExpanded(turn: Turn, item: ThreadItem): boolean {
  if (turn.status === 'inProgress' && turn.items.at(-1)?.id === item.id) return true;
  return isSoloResultlessReasoning(turn, item);
}

function isSoloResultlessReasoning(turn: Turn, item: ThreadItem): boolean {
  if (item.type !== 'reasoning') return false;
  if (turn.items.some((candidate) => (
    candidate.type === 'agentMessage'
    && candidate.phase !== 'commentary'
    && candidate.text.trim().length > 0
  ))) return false;
  const processItems = turn.items.filter((candidate) => {
    if (
      candidate.type === 'userMessage'
      || candidate.type === 'contextEvidence'
      || candidate.type === 'contextReset'
      || candidate.type === 'contextCompaction'
    ) return false;
    return candidate.type !== 'agentMessage' || candidate.phase === 'commentary';
  });
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
