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
import { createPortal, flushSync } from 'react-dom';
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  MAX_COMPOSER_ATTACHMENTS,
  MAX_COMPOSER_IMAGE_ATTACHMENTS,
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
  ThreadId,
  ThreadResourceReference,
  ThreadReferenceSearchResult,
  ThreadReferenceView,
  TurnRecoveryReadResponse,
  ThreadUserContent,
} from '../../../core/agent/protocol';
import { api } from '../../api/client';
import type { Thread, ThreadItem, Turn, TurnSubmitResponse } from '../projectionTypes';
import { isReaderAuthoredUserMessage } from '../../../core/agent/protocol';
import type { ThreadGoal } from '../../../core/agent/goal';
import {
  boundedToolArgumentsForDisplay,
  modelCallDisplayArguments,
  modelCallDisplayName,
} from '../../../core/agent/modelCallHistory';
import type { AgentProviderSettingsView, AgentSlashCommandView, NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import {
  useDocumentIndexSnapshot,
  type DocumentIndexStore,
} from '../../state/documentIndexStore';
import { useT } from '../../i18n/I18nProvider';
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
  CloseIcon,
  GitForkIcon,
  ICON_SIZE,
  InfoIcon,
  LoaderIcon,
  PlanToolIcon,
  PlayIcon,
  RefreshIcon,
  SendIcon,
  StopIcon,
  WarningIcon,
} from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { ButtonControl } from '../../ui/primitives/ButtonControl';
import { ConfirmDialog } from '../../ui/primitives/ConfirmDialog';
import { WorkingText } from '../../ui/primitives/WorkingText';
import { ThreadGoalView } from './ThreadGoalView';
import { ThreadComposerModelControl } from './ThreadComposerModelControl';
import { ThreadComposerAttachmentTray } from './ThreadComposerAttachmentTray';
import { UserInputRequest } from './UserInputRequest';
import {
  ThreadComposerEditor,
  type ThreadComposerDraft,
  type ThreadComposerDraftContent,
  type ThreadComposerEditorHandle,
  type ThreadComposerEditorSnapshot,
  type ThreadComposerFileReference,
  type ThreadComposerHistoryActionRequest,
  type ThreadComposerHistoryActionResult,
  type ThreadComposerLocalFileCandidate,
  type ThreadComposerPendingFileReference,
} from './ThreadComposerEditor';
import { isProviderUsable } from '../../ui/agent/providerUsability';
import {
  isThreadToolItem,
  summarizeThreadToolActivity,
  summarizeThreadToolItem,
  threadItemRendersNothing,
  ThreadItemView,
  ThreadMessageCopyButton,
  ThreadToolActivityGroup,
  type ThreadDisclosureState,
  type ThreadToolItem,
} from './items/ThreadItemView';
import { userFacingAgentError } from '../threadErrorMessage';
import {
  clickInstalledFocusTarget,
  composerFocusRequestIsCurrent,
  composerRefocusDecision,
} from '../composerRefocus';
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
import { formatNumber } from '../../ui/formatting';
import {
  hasTranscriptContentBelow,
  isTranscriptFollowing,
  transcriptNeedsSendAnchor,
  TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX,
} from '../threadScrollFollow';
import {
  buildTranscriptVirtualLayout,
  clampTranscriptScrollTop,
  decideTranscriptCoverage,
  mergeTranscriptTurnViewports,
  nextTranscriptScrollTransaction,
  sameTranscriptTurnViewport,
  transcriptScrollTransactionIsCurrent,
  transcriptTurnItemViewport,
  transcriptTurnViewport,
  transcriptUsesVirtualWindow,
  visibleTranscriptTurnRange,
  TRANSCRIPT_ROW_ESTIMATE_PX,
  type TranscriptScrollTransaction,
  type TranscriptTurnViewport,
} from '../transcriptVirtualWindow';
import {
  collaborationResultSnapshot,
  emptyTurnAnchors,
  subagentSpeakerName,
  type SubagentConversationProjection,
  type SubagentDelivery,
  type SubagentRegistryEntry,
  type SubagentTurnAnchors,
} from '../subagentPresentation';
import { SubagentReport } from './SubagentReport';
import { ThreadSpeakerGroup, type ThreadSpeaker } from './ThreadSpeaker';
import type { MarkMood } from '../agentMarkGeometry';
import { MAIN_IDENTITY_KEY } from '../agentIdentity';
import { textOf } from '../../ui/shared';
import {
  IDLE_THREAD_COMPOSER_HISTORY_STATE,
  navigateThreadComposerHistory,
  selectReaderComposerHistoryEntries,
  type ThreadComposerHistoryState,
} from '../threadComposerHistory';
import {
  ComposerHistoryResourceRegistry,
  currentThreadResourceAdapter,
} from '../composerHistoryResourceRegistry';
import {
  ComposerAttachmentUiStateRegistry,
  type ComposerAttachmentUiState,
} from '../composerAttachmentUiStateRegistry';

/**
 * The speaker id for a host notice the renderer could not attribute. Distinct
 * from `main` so consecutive-speaker merging never folds an unnamed event into
 * the conversation's own agent.
 */
const UNATTRIBUTED_PARTICIPANT_ID = 'unattributed';
import { useSubagentEntry, useWorkingAgentIds } from './SubagentRegistryContext';
import { classifyNewThreadCommand } from '../threadComposerCommands';
import { parseNodeReferenceMarkers, parseThreadReferenceMarkers } from '../../../core/referenceMarkup';

interface ThreadViewProps {
  readonly active: boolean;
  readonly composerEnabled: boolean;
  readonly composerFocusExpectedActiveElement: Element | null;
  readonly composerFocusToken: number;
  readonly getUserView: () => RendererUserViewHints;
  readonly goal: ThreadGoal | null;
  readonly indexStore: DocumentIndexStore;
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
  /**
   * The conversation's Agent anchors and continuations, projected once by the
   * deck. A transcript rendered inside an Agent's detail view shares the same
   * projection: one registry spans the whole conversation, at every depth.
   */
  readonly subagentProjection: SubagentConversationProjection;
  /** Overrides the composer's resting prompt — an Agent's own says what a
   *  message to it will do, including that it clears the user's stop. */
  readonly composerPlaceholder?: string;
  /** This transcript belongs to one Agent, so its Turns are generations. */
  readonly agentTranscript?: boolean;
  /**
   * The participant whose transcript this is: the conversation's own `main`, or
   * the Agent whose pushed view this is. Every response here is it speaking.
   */
  readonly selfSpeaker: ThreadSpeaker;
  readonly inputRequest: RequestUserInputRequest | null;
  /** The run is blocked on the user. Working phrases become static and the
   *  divider names the wait; elapsed time remains the Turn's wall-clock span. */
  readonly waitingOnUserInput: boolean;
  readonly providerRetry: { readonly turnId: string; readonly status: ProviderRetryStatus } | null;
  readonly plan: ActiveTurnPlan | null;
  readonly threadCreationBlocked: boolean;
  readonly threadCreationPending: boolean;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onReadTurnRecovery: (turn: Turn) => Promise<TurnRecoveryReadResponse>;
  readonly onContinueTurn: (turn: Turn) => Promise<void>;
  readonly onRerunTurn: (turn: Turn, confirmToolReplay: boolean) => Promise<void>;
  readonly onContinueInNewChat: (turn: Turn) => Promise<void>;
  readonly onCreateThread: () => Promise<boolean>;
  readonly onInterrupt: () => Promise<void>;
  /** Stop one delegated child from the card, or the child Thread view header. */
  readonly onInterruptThread: (threadId: string) => Promise<void>;
  readonly onConfigurationChange: (configuration: ThreadConfigurationSummary) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onOpenThreadReference: (threadId: string) => Promise<void>;
  readonly onOpenTurnDetails: (turn: Turn) => void;
  /** Turn Details for a delegated child, read inside its own run detail. */
  readonly onOpenSubagentTurnDetails?: (threadId: string, turnId: string) => void;
  readonly onReadToolOutput: (turnId: string, item: ThreadToolItem) => Promise<string | null>;
  readonly onReadToolArguments: (turnId: string, item: ThreadToolItem) => Promise<JsonValue | null>;
  /**
   * `clientMessageId` is the transcript's, not the store's: the view has to
   * recognize the Turn its own send becomes as soon as it renders, and it
   * cannot do that with an id minted after the round trip it is waiting on.
   */
  readonly onSend: (
    content: readonly ThreadUserContent[],
    clientMessageId: string,
  ) => Promise<TurnSubmitResponse | null>;
  readonly onSubmitUserInput: (answers: readonly RequestUserInputAnswer[]) => Promise<void>;
}

const ATTACHMENT_ERROR_TIMEOUT_MS = 5_000;
const MAX_CACHED_THREAD_UI_STATES = 32;
const SENT_TURN_SEARCH_DEPTH = 16;
/** Past this, the anchor's travel reads as a blur and the cut is more honest. */
const ANCHOR_TRAVEL_MAX_VIEWPORTS = 2;
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
function isInteractiveTranscriptPointerTarget(
  target: EventTarget | null,
  transcript: HTMLElement,
): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest([
    'a[href]',
    'button',
    'input',
    'select',
    'summary',
    'textarea',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="textbox"]',
  ].join(','));
  return interactive !== null && transcript.contains(interactive);
}
const EMPTY_COMPOSER_DRAFT: ThreadComposerDraft = {
  content: [],
  empty: true,
  fileRefs: [],
  pendingFileRefs: [],
  text: '',
};

type ComposerHistoryBundle =
  | {
      readonly attachments: readonly ThreadAttachmentContent[];
      readonly content: null;
      readonly snapshot: ThreadComposerEditorSnapshot;
      readonly uiState: readonly ComposerAttachmentUiState[];
    }
  | {
      readonly attachments: readonly ThreadAttachmentContent[];
      readonly content: readonly ThreadComposerDraftContent[];
      readonly snapshot: null;
      readonly uiState: readonly ComposerAttachmentUiState[];
    };

type ComposerHistoryResources = ComposerHistoryResourceRegistry<
  string,
  ComposerHistoryBundle,
  ThreadAttachmentContent,
  ThreadResourceReference
>;

interface ComposerHistorySession {
  readonly resources: ComposerHistoryResources;
  state: ThreadComposerHistoryState;
}

const COMPOSER_HISTORY_SCRATCH_SLOT = 'scratch';

type NewThreadValidation = 'providerRequired' | 'structuredContent' | null;

/**
 * The Turn the reader is looking at, and where it sits in the viewport. A raw
 * `scrollTop` does not survive a remount whose measured row geometry is still
 * settling. The Turn is what the reader remembers, so the Turn is what we
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
  readonly stableFrames: number;
  readonly top: number;
  readonly verified: boolean;
}

interface PendingSendAnchor {
  /** A cut has reached the target and now owns it while virtual geometry settles. */
  anchored: boolean;
  /**
   * The id this send carries into the host, and the only exact way back to the
   * row it becomes. The Turn arrives on the `turn/started` notification a whole
   * round trip before `turn/submit` answers, and the reader is looking at it
   * that entire time — anchoring off the response instead left the message
   * sitting wherever it landed and then moved the viewport a full screen under
   * a reader who had already started reading. Matching the id is what lets the
   * anchor run on the frame the message first exists, so a send costs exactly
   * one movement. A Turn appended by anything else — a delegated Agent's result
   * delivery, most of all — arrives in the same window and is not this send.
   */
  readonly clientMessageId: string;
  /**
   * The tail Turn at click time, which is how a steer is told from a start.
   * A steer appends into the Turn already running — always the tail — and
   * anchoring that Turn would drag the viewport to the top of a reply the
   * reader is in the middle of. A start appends a Turn that did not exist here
   * yet. Reading it from the transcript rather than from the `turn/submit`
   * answer keeps the distinction available a round trip earlier.
   */
  readonly previousTailTurnId: string | null;
  readonly releaseFollowOnAnchor: boolean;
  readonly threadId: string;
  /**
   * The Turn the host reported accepting, once it has answered. It is the only
   * handle on a submission that never becomes a message of the reader's — a
   * context command — and it is what keeps such a send from stranding this
   * anchor on a row that will never exist.
   */
  acceptedTurnId: string | null;
  /**
   * Identifying a target schedules one explicit row measurement. The request is
   * monotonic so an optimistic-to-canonical replacement cannot satisfy the new
   * row with the old row's layout pass.
   */
  targetMeasureCompleted: number;
  targetMeasureRequest: number;
  /** The first ThreadView render whose layout may consume the target measurement. */
  targetReadyAtVersion: number | null;
  settleScrollHeight: number;
  settleStableFrames: number;
  settleTargetTop: number;
  settleTurnMeasureGeneration: number;
  /** Whether a viewport-tall first layout has yielded to inline disclosure setup. */
  targetSettlementStaged: boolean;
  targetTurnId: string | null;
}

interface PendingSendEcho {
  readonly clientMessageId: string;
  /** Set when the host answers; see `PendingSendAnchor.acceptedTurnId`. */
  readonly acceptedTurnId: string | null;
  readonly turn: Turn;
}

interface SendAnchorSpacer {
  readonly height: number;
  readonly releaseFollowOnAnchor: boolean;
  readonly targetTop: number;
  readonly turnId: string;
}

interface PendingVirtualScrollAdjustment {
  applyAtMeasureVersion: number;
  readonly anchor: TranscriptAnchor | null;
  top: number;
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
 * the precondition the anchor search below depends on. No filter is needed for
 * that any more: a child transcript is a pushed level that COVERS this one, so
 * it is never inside this scroll container to begin with.
 */
function ownTranscriptRows(scroll: HTMLElement): HTMLElement[] {
  return [...scroll.querySelectorAll<HTMLElement>('[data-thread-turn-row]')];
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * The system's layout-motion duration, in milliseconds, read from the token.
 *
 * Derived rather than restated: `--motion-layout-duration` is what every other
 * layout movement in the app is spent over, and a number typed here again would
 * be the one that stops matching.
 */
function readMotionDuration(): number {
  const declared = window.getComputedStyle(document.documentElement)
    .getPropertyValue('--motion-layout-duration')
    .trim();
  const value = Number.parseFloat(declared);
  if (!Number.isFinite(value)) return 0;
  return declared.endsWith('ms') ? value : value * 1000;
}

/**
 * The message the reader just sent, drawn from the composer instead of waited
 * for from the host.
 *
 * Every chat surface the reader has ever used puts their message on screen on
 * the keystroke; this one cleared the composer and showed nothing until
 * `turn/submit` answered, so what they typed spent a round trip existing
 * nowhere. This Turn is view-only and never reaches the store, so nothing
 * downstream of the transcript can mistake it for canonical state. It is
 * dropped in the same render that first sees the real Turn carrying this
 * `clientId` — a swap of one row for an identical one, never two of the
 * message and never a gap between them.
 *
 * `inProgress` is the truth about it: the send is in flight, and it makes the
 * row render exactly as the canonical Turn will a moment later, working
 * indicator included. Turn-level actions are already suppressed while a Turn is
 * in progress, so none of them can address an id the host has never heard of.
 */
function optimisticTurnId(clientMessageId: string): string {
  return `pending:${clientMessageId}`;
}

function optimisticSendTurn(
  clientMessageId: string,
  content: readonly ThreadUserContent[],
  threadId: string,
  modelProvider: string,
  startedAt: number,
): Turn {
  const id = optimisticTurnId(clientMessageId);
  const itemId = `pending-item:${clientMessageId}`;
  return {
    id,
    items: [{
      id: itemId,
      type: 'userMessage',
      provenance: { originThreadId: threadId, originTurnId: id, originItemId: itemId },
      author: { kind: 'reader' },
      clientId: clientMessageId,
      content,
      acceptedAt: startedAt,
    }],
    itemsView: 'full',
    provenance: { originThreadId: threadId, originTurnId: id, trigger: { kind: 'user' } },
    status: 'inProgress',
    error: null,
    execution: {
      modelProvider,
      model: '',
      reasoningEffort: 'medium',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
      diagnosticsRef: null,
    },
    startedAt,
    completedAt: null,
    durationMs: null,
  };
}

/**
 * The Turn this send became, once the transcript has it.
 *
 * Two ways in, because a send does not always become a message. The first is the
 * client id the view minted: it identifies the reader's own `userMessage` among
 * Turns that arrive in the same window — a delegated Agent's result delivery
 * also appends a user-role Item, and anchoring onto one of those would scroll
 * the reader to somebody else's arrival. The second is the Turn the host said it
 * accepted, which is the only way home for a submission that produces no message
 * of the reader's at all: `/clear` and `/compact` are ordinary composer text on
 * the way out and come back as a `contextReset` / `contextCompaction` Item under
 * a Turn of their own. Waiting on the client id alone left those sends with a
 * stand-in row that nothing could ever retire.
 *
 * Searched from the end and bounded: the Item is in the Turn the send opened,
 * or — when it steered a Turn already running — appended to that one, and both
 * are at the tail. This runs per layout pass while a send is in flight.
 */
function resolveSentTurn(
  turns: readonly Turn[],
  clientMessageId: string,
  acceptedTurnId: string | null,
): string | null {
  const oldest = Math.max(0, turns.length - SENT_TURN_SEARCH_DEPTH);
  let accepted: string | null = null;
  for (let index = turns.length - 1; index >= oldest; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    for (const item of turn.items) {
      if (item.type === 'userMessage' && item.clientId === clientMessageId) return turn.id;
    }
    if (turn.id === acceptedTurnId) accepted = turn.id;
  }
  return accepted;
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

interface PreparedComposerAttachment {
  readonly content: ThreadAttachmentContent;
  readonly previewUrl?: string;
  readonly reference: ThreadComposerFileReference;
  readonly sourceKey: string;
}

interface PendingComposerPaste extends ThreadComposerPendingFileReference {
  readonly excerpt: string;
}

interface PendingComposerPasteRequest extends PendingComposerPaste {
  readonly controller: AbortController;
  readonly detachLifecycleAbort: () => void;
  // The pending atom owns attachment state removed with its replaced slice.
  replacedAttachments: ThreadAttachmentContent[];
  // Programmatic settle/restore also removes the atom; it is not user cancellation.
  settling: boolean;
}

export function ThreadView({
  active,
  composerEnabled,
  composerFocusExpectedActiveElement,
  composerFocusToken,
  configuration,
  getUserView,
  goal,
  indexStore,
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
  subagentProjection,
  composerPlaceholder,
  agentTranscript = false,
  selfSpeaker,
  inputRequest,
  waitingOnUserInput,
  providerRetry,
  threadCreationBlocked,
  threadCreationPending,
  onEditUserMessage,
  onReadTurnRecovery,
  onContinueTurn,
  onRerunTurn,
  onContinueInNewChat,
  onCreateThread,
  onInterrupt,
  onInterruptThread,
  onConfigurationChange,
  onOpenNodeReference,
  onOpenThread,
  onOpenThreadReference,
  onOpenSubagentTurnDetails,
  onOpenTurnDetails,
  onReadToolArguments,
  onReadToolOutput,
  onSend,
  onSubmitUserInput,
}: ThreadViewProps) {
  const t = useT();
  const waitingForInput = Boolean(inputRequest);
  const rootThreadId = useMemo(
    () => conversationRootThreadId(threadId, threadsById, subagentProjection.byAgentId),
    [subagentProjection.byAgentId, threadId, threadsById],
  );
  const rootSpeaker = useMemo<ThreadSpeaker>(() => ({
    participantId: MAIN_IDENTITY_KEY,
    avatarKey: MAIN_IDENTITY_KEY,
    name: t.agent.thread.agent.main,
  }), [t]);
  const initialScrollSnapshot = threadScrollSnapshots.get(threadId);
  const [draft, setDraft] = useState<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newThreadValidation, setNewThreadValidation] = useState<NewThreadValidation>(null);
  const [failedThreadCreationFocusToken, setFailedThreadCreationFocusToken] = useState(0);
  const [attachments, setAttachments] = useState<ThreadAttachmentContent[]>([]);
  const [pendingPastes, setPendingPastes] = useState<PendingComposerPaste[]>([]);
  const [recentLocalFiles, setRecentLocalFiles] = useState<ThreadComposerLocalFileCandidate[]>([]);
  const transcriptThreadReferenceKey = useMemo(
    () => threadReferenceIdsFromTurns(turns).join('\0'),
    [turns],
  );
  const transcriptThreadReferenceIds = useMemo(
    () => transcriptThreadReferenceKey ? transcriptThreadReferenceKey.split('\0') : [],
    [transcriptThreadReferenceKey],
  );
  const loadedThreadReferences = useMemo(() => {
    const references = new Map<string, ThreadReferenceView>();
    for (const referencedThreadId of transcriptThreadReferenceIds) {
      const referenced = threadsById.get(referencedThreadId);
      if (!referenced) continue;
      references.set(referencedThreadId, {
        threadId: referencedThreadId,
        title: referenced.name?.trim() || referenced.preview.trim() || null,
        updatedAt: referenced.updatedAt,
        availability: referencedThreadId === threadId ? 'current' : 'available',
      });
    }
    return references;
  }, [threadId, threadsById, transcriptThreadReferenceIds]);
  const [resolvedThreadReferences, setResolvedThreadReferences] = useState<ReadonlyMap<string, ThreadReferenceView>>(
    () => new Map(),
  );
  const threadReferences = useMemo(() => new Map([
    ...resolvedThreadReferences,
    ...loadedThreadReferences,
  ]), [loadedThreadReferences, resolvedThreadReferences]);
  const [follow, setFollow] = useState(initialScrollSnapshot?.follow ?? true);
  const [sendAnchorSpacer, setSendAnchorSpacer] = useState<SendAnchorSpacer | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptContentRef = useRef<HTMLDivElement>(null);
  const transcriptTurnsRef = useRef<HTMLDivElement>(null);
  const composerRegionRef = useRef<HTMLDivElement>(null);
  const disclosureAnchorRunwayRef = useRef(0);
  const composerRef = useRef<ThreadComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const scrollRestoreVerificationFrameRef = useRef<number | null>(null);
  const bottomScrollFrameReplayRef = useRef(false);
  const bottomPinDeferredRef = useRef(false);
  const sendAnchorLayoutDeferredRef = useRef(false);
  const sendAnchorSettlementFrameRef = useRef<number | null>(null);
  const anchorTravelFrameRef = useRef<number | null>(null);
  const anchorTravelRef = useRef<{ wrote: number } | null>(null);
  const scheduleBottomPinRef = useRef<(replayAfterAnchor?: boolean) => void>(() => undefined);
  const applySendAnchorLayoutRef = useRef<() => void>(() => undefined);
  const scrollMetricsFrameRef = useRef<number | null>(null);
  const virtualScrollAdjustmentFrameRef = useRef<number | null>(null);
  const followRef = useRef(follow);
  const synchronizedScrollTopRef = useRef(initialScrollSnapshot?.top ?? 0);
  const expectedProgrammaticScrollTopRef = useRef<number | null>(null);
  const pointerScrollIntentRef = useRef(false);
  const transientScrollIntentRef = useRef(false);
  const pendingVirtualScrollAdjustmentRef = useRef<PendingVirtualScrollAdjustment | null>(null);
  const pendingLayoutScrollRef = useRef<TranscriptScrollTransaction | null>(null);
  const layoutScrollGenerationRef = useRef(0);
  const pendingSendScrollRef = useRef<PendingSendAnchor | null>(null);
  const sendAnchorSpacerRef = useRef<SendAnchorSpacer | null>(null);
  const scrollRestoreRef = useRef<PendingScrollRestore | null>(
    initialScrollSnapshot?.follow === false
      ? {
        anchor: initialScrollSnapshot.anchor,
        attempts: 0,
        scrollHeight: 0,
        stableFrames: 0,
        top: initialScrollSnapshot.top,
        verified: false,
      }
      : null,
  );
  const attachmentsRef = useRef<ThreadAttachmentContent[]>([]);
  const attachmentOperationTailRef = useRef<Promise<void>>(Promise.resolve());
  const attachmentOperationActivityRef = useRef(0);
  const attachmentLifecycleControllerRef = useRef<AbortController | null>(null);
  const attachmentUiStateRef = useRef<ComposerAttachmentUiStateRegistry | null>(null);
  if (attachmentUiStateRef.current === null) {
    attachmentUiStateRef.current = new ComposerAttachmentUiStateRegistry((previewUrl) => {
      URL.revokeObjectURL(previewUrl);
    });
  }
  const attachmentUiState = attachmentUiStateRef.current;
  const pendingPasteRequestsRef = useRef(new Map<string, PendingComposerPasteRequest>());
  const pastedTextOrdinalRef = useRef(0);
  const attachmentAdmissionEnabledRef = useRef(false);
  const draftRef = useRef<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const composerHistorySessionRef = useRef<ComposerHistorySession | null>(null);
  const composerHistorySwapRef = useRef(false);
  const handledFocusTokenRef = useRef(0);
  const handledFailedThreadCreationFocusTokenRef = useRef(0);
  const sendingRef = useRef(false);
  const measuredTurnHeights = useMemo(() => cachedTurnHeights(threadId), [threadId]);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [pendingSendVersion, setPendingSendVersion] = useState(0);
  const pendingSendVersionRef = useRef(pendingSendVersion);
  const turnMeasureGenerationRef = useRef(0);
  const [scrollRestoreVersion, setScrollRestoreVersion] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState({
    hasContentBelow: false,
    height: 0,
    top: 0,
  });
  const [virtualViewport, setVirtualViewport] = useState<TranscriptTurnViewport>({
    bottom: 0,
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
  // The optimistic row lives here and nowhere else: `turns` stays the canonical
  // list every derivation below reads, and only what is drawn gets the echo
  // appended. Suppressing it during render rather than clearing it in an effect
  // is what makes the handover seamless — an effect would have to run after a
  // commit that already held both rows.
  const [pendingEcho, setPendingEcho] = useState<PendingSendEcho | null>(null);
  const echoTurn = pendingEcho !== null && resolveSentTurn(
    turns,
    pendingEcho.clientMessageId,
    pendingEcho.acceptedTurnId,
  ) === null
    ? pendingEcho.turn
    : null;
  const renderedTurns = useMemo(
    () => (echoTurn === null ? turns : [...turns, echoTurn]),
    [echoTurn, turns],
  );
  const clearPendingEcho = useCallback((clientMessageId: string) => {
    // The height goes with the row here too, not only on the settled path: the
    // id is single-use either way, and a refused send is the one that repeats.
    measuredTurnHeights.delete(optimisticTurnId(clientMessageId));
    setPendingEcho((current) => (current?.clientMessageId === clientMessageId ? null : current));
  }, [measuredTurnHeights]);
  const recordAcceptedTurn = useCallback((clientMessageId: string, acceptedTurnId: string) => {
    setPendingEcho((current) => (
      current?.clientMessageId === clientMessageId && current.acceptedTurnId !== acceptedTurnId
        ? { ...current, acceptedTurnId }
        : current
    ));
  }, []);
  // Releasing what the render is already ignoring. Never the other way round:
  // an effect that decided whether to draw the echo would decide it one commit
  // late, and that commit is the one holding both rows.
  useEffect(() => {
    if (pendingEcho === null || echoTurn !== null) return;
    // Its measured height goes with it; the id is single-use, so left behind it
    // is one dead entry per send in a per-Thread cache that never sheds them.
    measuredTurnHeights.delete(pendingEcho.turn.id);
    setPendingEcho(null);
  }, [echoTurn, measuredTurnHeights, pendingEcho]);
  useEffect(() => () => setPendingEcho(null), [threadId]);
  useEffect(() => {
    const unresolved = transcriptThreadReferenceIds.filter((referencedThreadId) => (
      !loadedThreadReferences.has(referencedThreadId)
      && !resolvedThreadReferences.has(referencedThreadId)
    ));
    if (unresolved.length === 0) return;
    let canceled = false;
    const requests = chunked(unresolved, 50).map((threadIds) => api.agentCoreRequest(
      'thread/references/resolve',
      { currentThreadId: threadId, threadIds },
    ));
    void Promise.all(requests).then((responses) => {
      if (canceled) return;
      setResolvedThreadReferences((current) => {
        const next = new Map(current);
        for (const response of responses) {
          for (const reference of response.data) next.set(reference.threadId, reference);
        }
        return next;
      });
    }).catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [loadedThreadReferences, resolvedThreadReferences, threadId, transcriptThreadReferenceIds]);
  const searchThreadReferences = useCallback(async (query: string): Promise<ThreadReferenceSearchResult[]> => {
    const response = await api.agentCoreRequest('thread/references/search', {
      currentThreadId: threadId,
      query,
      limit: 8,
    });
    return [...response.data];
  }, [threadId]);
  const activePlan = activeTurn && plan?.turnId === activeTurn.id ? plan : null;
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
  attachmentAdmissionEnabledRef.current = !activeTurn
    && !providerBlocksSend
    && !sending
    && !threadCreationPending
    && !waitingForInput;
  const newThreadCommandState = classifyNewThreadCommand(draft);
  const newThreadAction = newThreadCommandState !== 'ordinary';
  const composerActionDisabled = !hasDraft
    || draft.pendingFileRefs.length > 0
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
    () => buildTranscriptVirtualLayout(renderedTurns, measuredTurnHeights, estimateTurnHeight),
    [measureVersion, measuredTurnHeights, renderedTurns],
  );
  const virtualized = transcriptUsesVirtualWindow(renderedTurns.length);
  const virtualRange = virtualized
    ? visibleTranscriptTurnRange(virtualLayout, virtualViewport)
    : { end: renderedTurns.length, start: 0 };
  const visibleTurns = renderedTurns.slice(virtualRange.start, virtualRange.end);
  const virtualStateRef = useRef({
    layout: virtualLayout,
    range: virtualRange,
    turns: renderedTurns,
    virtualized,
  });
  virtualStateRef.current = {
    layout: virtualLayout,
    range: virtualRange,
    turns: renderedTurns,
    virtualized,
  };

  const setFollowValue = useCallback((nextFollow: boolean) => {
    followRef.current = nextFollow;
    setFollow((current) => current === nextFollow ? current : nextFollow);
  }, []);

  const cancelPendingLayoutScroll = useCallback(() => {
    layoutScrollGenerationRef.current += 1;
    pendingLayoutScrollRef.current = null;
  }, []);

  const cancelPendingVirtualScrollAdjustment = useCallback(() => {
    if (virtualScrollAdjustmentFrameRef.current !== null) {
      window.cancelAnimationFrame(virtualScrollAdjustmentFrameRef.current);
      virtualScrollAdjustmentFrameRef.current = null;
    }
    pendingVirtualScrollAdjustmentRef.current = null;
  }, []);

  const cancelSendAnchorSettlement = useCallback(() => {
    if (sendAnchorSettlementFrameRef.current === null) return;
    window.cancelAnimationFrame(sendAnchorSettlementFrameRef.current);
    sendAnchorSettlementFrameRef.current = null;
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

  const cancelReaderOverriddenScrollWork = useCallback(() => {
    cancelPendingLayoutScroll();
    cancelPendingVirtualScrollAdjustment();
    cancelSendAnchorSettlement();
    pendingSendScrollRef.current = null;
    clearSendAnchorSpacer();
  }, [
    cancelPendingLayoutScroll,
    cancelPendingVirtualScrollAdjustment,
    cancelSendAnchorSettlement,
    clearSendAnchorSpacer,
  ]);

  const markTransientScrollIntent = useCallback(() => {
    transientScrollIntentRef.current = true;
    cancelReaderOverriddenScrollWork();
  }, [cancelReaderOverriddenScrollWork]);

  const beginPointerScrollIntent = useCallback(() => {
    pointerScrollIntentRef.current = true;
    cancelReaderOverriddenScrollWork();
  }, [cancelReaderOverriddenScrollWork]);

  const endPointerScrollIntent = useCallback(() => {
    pointerScrollIntentRef.current = false;
  }, []);

  const readTurnViewport = useCallback((
    element: HTMLDivElement,
    targetTop = element.scrollTop,
  ): TranscriptTurnViewport => {
    const turnsElement = transcriptTurnsRef.current;
    const state = virtualStateRef.current;
    if (!turnsElement || state.layout.totalHeight <= 0) return { bottom: 0, top: 0 };
    const scrollBounds = element.getBoundingClientRect();
    return transcriptTurnViewport({
      currentScrollTop: element.scrollTop,
      scrollerTop: scrollBounds.top + element.clientTop,
      targetScrollTop: targetTop,
      totalHeight: state.layout.totalHeight,
      turnsTop: turnsElement.getBoundingClientRect().top,
      viewportHeight: element.clientHeight,
    });
  }, []);

  const updateVirtualViewport = useCallback((next: TranscriptTurnViewport) => {
    setVirtualViewport((current) => (
      sameTranscriptTurnViewport(current, next) ? current : next
    ));
  }, []);

  const advancePendingSendLayout = useCallback((
    pending: PendingSendAnchor,
    targetMeasured: boolean,
  ) => {
    if (pendingSendScrollRef.current !== pending) return;
    const nextVersion = pendingSendVersionRef.current + 1;
    pendingSendVersionRef.current = nextVersion;
    if (targetMeasured) pending.targetReadyAtVersion = nextVersion;
    setPendingSendVersion(nextVersion);
  }, []);

  const scheduleSendAnchorSettlement = useCallback((pending: PendingSendAnchor) => {
    if (sendAnchorSettlementFrameRef.current !== null) return;
    const observe = () => {
      sendAnchorSettlementFrameRef.current = null;
      if (pendingSendScrollRef.current !== pending || !pending.anchored) return;
      const scroll = scrollRef.current;
      const targetTurnId = pending.targetTurnId;
      const row = targetTurnId
        ? scroll?.querySelector<HTMLDivElement>(
          `[data-thread-turn-row="${CSS.escape(targetTurnId)}"]`,
        ) ?? null
        : null;
      const target = row?.querySelector<HTMLElement>('.thread-user-message') ?? row;
      if (!scroll || !target) {
        pending.settleStableFrames = 0;
        advancePendingSendLayout(pending, false);
        return;
      }
      const scrollRect = scroll.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const topInset = Number.parseFloat(window.getComputedStyle(scroll).paddingTop) || 0;
      const targetTop = Math.max(
        0,
        scroll.scrollTop + targetRect.top - scrollRect.top - topInset,
      );
      const stable = Math.abs(targetRect.top - scrollRect.top - topInset) <= 1
        && Math.abs(scroll.scrollHeight - pending.settleScrollHeight) < 1
        && Math.abs(targetTop - pending.settleTargetTop) < 1
        && turnMeasureGenerationRef.current === pending.settleTurnMeasureGeneration;
      pending.settleScrollHeight = scroll.scrollHeight;
      pending.settleTargetTop = targetTop;
      pending.settleTurnMeasureGeneration = turnMeasureGenerationRef.current;
      pending.settleStableFrames = stable ? pending.settleStableFrames + 1 : 0;
      if (pending.settleStableFrames >= 2) {
        pendingSendScrollRef.current = null;
        if (pending.releaseFollowOnAnchor) setFollowValue(false);
        scheduleBottomPinRef.current();
        return;
      }
      if (stable) {
        sendAnchorSettlementFrameRef.current = window.requestAnimationFrame(observe);
      } else {
        advancePendingSendLayout(pending, false);
      }
    };
    sendAnchorSettlementFrameRef.current = window.requestAnimationFrame(observe);
  }, [advancePendingSendLayout, setFollowValue]);

  const stagePendingSendMeasurement = useCallback((pending: PendingSendAnchor) => {
    if (
      pendingSendScrollRef.current !== pending
      || pending.targetMeasureCompleted < pending.targetMeasureRequest
    ) return;
    pending.targetMeasureRequest += 1;
    pending.targetReadyAtVersion = null;
    advancePendingSendLayout(pending, false);
  }, [advancePendingSendLayout]);

  const prepareSendTargetCoverage = useCallback((turnId: string) => {
    const state = virtualStateRef.current;
    if (!state.virtualized) return true;
    const turnIndex = state.turns.findIndex((turn) => turn.id === turnId);
    const viewport = transcriptTurnItemViewport(state.layout, turnIndex);
    if (!viewport) return false;
    if (decideTranscriptCoverage(
      true,
      state.layout,
      state.range,
      viewport,
      'layout',
    ) === 'covered') return true;
    updateVirtualViewport(viewport);
    return false;
  }, [updateVirtualViewport]);

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
    // A prepared lifecycle scroll or send target owns the next rendered range.
    // Re-reading the old DOM position while that range is staging would replace
    // it before its writer can move the viewport, so neither operation could
    // ever reach a covered commit.
    if (
      virtualStateRef.current.virtualized
      && pendingLayoutScrollRef.current === null
      && !pendingSendScrollRef.current?.targetTurnId
    ) {
      updateVirtualViewport(readTurnViewport(element));
    }
    setScrollMetrics((current) => (
      current.hasContentBelow === next.hasContentBelow
        && Math.abs(current.height - next.height) < 1
        && Math.abs(current.top - next.top) < 1
        ? current
        : next
    ));
  }, [readTurnViewport, updateVirtualViewport]);

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
    const nextFollow = (
      pendingSendScrollRef.current?.releaseFollowOnAnchor
      || sendAnchorSpacerRef.current?.releaseFollowOnAnchor
    )
      ? false
      : isTranscriptFollowing(element);
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

  const writeProgrammaticScrollTop = useCallback((element: HTMLDivElement, top: number) => {
    element.scrollTop = top;
    expectedProgrammaticScrollTopRef.current = element.scrollTop;
  }, []);

  const requestedTurnViewport = useCallback((
    element: HTMLDivElement,
    targetTop: number,
    includeCurrent: boolean,
  ) => {
    const targetViewport = readTurnViewport(element, targetTop);
    return includeCurrent
      ? mergeTranscriptTurnViewports(readTurnViewport(element), targetViewport)
      : targetViewport;
  }, [readTurnViewport]);

  const prepareLayoutScrollCoverage = useCallback((
    element: HTMLDivElement,
    targetTop: number,
    includeCurrent = false,
  ) => {
    const state = virtualStateRef.current;
    const viewport = requestedTurnViewport(element, targetTop, includeCurrent);
    if (decideTranscriptCoverage(
      state.virtualized,
      state.layout,
      state.range,
      viewport,
      'layout',
    ) === 'covered') return true;
    updateVirtualViewport(viewport);
    return false;
  }, [requestedTurnViewport, updateVirtualViewport]);

  const ensureImperativeScrollCoverage = useCallback((element: HTMLDivElement) => {
    const state = virtualStateRef.current;
    const viewport = readTurnViewport(element);
    if (decideTranscriptCoverage(
      state.virtualized,
      state.layout,
      state.range,
      viewport,
      'imperative',
    ) === 'covered') return false;
    flushSync(() => updateVirtualViewport(viewport));
    return true;
  }, [readTurnViewport, updateVirtualViewport]);

  const setImperativeScrollTop = useCallback((element: HTMLDivElement, top: number) => {
    cancelPendingLayoutScroll();
    writeProgrammaticScrollTop(element, top);
    ensureImperativeScrollCoverage(element);
    synchronizeScrollPosition(element);
  }, [
    cancelPendingLayoutScroll,
    ensureImperativeScrollCoverage,
    synchronizeScrollPosition,
    writeProgrammaticScrollTop,
  ]);

  const commitPendingLayoutScroll = useCallback(() => {
    const transaction = pendingLayoutScrollRef.current;
    const element = scrollRef.current;
    if (
      !transaction
      || !element
      || !transcriptScrollTransactionIsCurrent(transaction, layoutScrollGenerationRef.current)
    ) return false;
    const targetTop = clampTranscriptScrollTop(
      transaction.targetTop,
      element.scrollHeight,
      element.clientHeight,
    );
    if (!prepareLayoutScrollCoverage(element, targetTop)) return false;
    writeProgrammaticScrollTop(element, targetTop);
    const actualViewport = readTurnViewport(element);
    const state = virtualStateRef.current;
    if (decideTranscriptCoverage(
      state.virtualized,
      state.layout,
      state.range,
      actualViewport,
      'layout',
    ) !== 'covered') {
      updateVirtualViewport(actualViewport);
      return false;
    }
    pendingLayoutScrollRef.current = null;
    synchronizeScrollPosition(element);
    return true;
  }, [
    prepareLayoutScrollCoverage,
    readTurnViewport,
    synchronizeScrollPosition,
    updateVirtualViewport,
    writeProgrammaticScrollTop,
  ]);

  const requestLayoutScrollTop = useCallback((element: HTMLDivElement, top: number) => {
    const transaction = nextTranscriptScrollTransaction(
      layoutScrollGenerationRef.current,
      top,
    );
    layoutScrollGenerationRef.current = transaction.generation;
    pendingLayoutScrollRef.current = transaction;
    return commitPendingLayoutScroll();
  }, [commitPendingLayoutScroll]);

  const cancelAnchorTravel = useCallback(() => {
    if (anchorTravelFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorTravelFrameRef.current);
      anchorTravelFrameRef.current = null;
    }
    anchorTravelRef.current = null;
  }, []);

  /**
   * Move the transcript to the anchor over time instead of between two frames.
   *
   * The travel is the scroll itself, tweened — NOT a transform over a settled
   * scroll. A transformed descendant contributes its transformed geometry to
   * the scroll container's overflow, so translating the content inflates
   * `scrollHeight` while it plays; the runway spacer is computed from exactly
   * that number, so the FLIP version of this quietly deleted its own runway and
   * the scroll clamped back up — the anchor undid itself over about a dozen
   * frames. Tweening the scroll keeps every measurement true at every instant,
   * at the cost of the machinery seeing intermediate positions, which is why
   * each frame goes through `setImperativeScrollTop` and why the reader's own
   * scroll cancels the rest.
   *
   * Reduced motion, a distance too short to read, and a distance too long to
   * follow all take the cut instead.
   */
  const playAnchorTravel = useCallback((
    scroll: HTMLDivElement,
    from: number,
    to: number,
    releaseFollowOnArrival: boolean,
  ) => {
    cancelAnchorTravel();
    const distance = to - from;
    const duration = readMotionDuration();
    if (
      duration <= 0
      || Math.abs(distance) < 1
      || Math.abs(distance) > scroll.clientHeight * ANCHOR_TRAVEL_MAX_VIEWPORTS
      || prefersReducedMotion()
    ) {
      setImperativeScrollTop(scroll, to);
      if (releaseFollowOnArrival) setFollowValue(false);
      return;
    }
    setImperativeScrollTop(scroll, from);
    const startedAt = performance.now();
    anchorTravelRef.current = { wrote: scroll.scrollTop };
    const step = () => {
      anchorTravelFrameRef.current = null;
      const state = anchorTravelRef.current;
      const element = scrollRef.current;
      if (!state || element !== scroll) return;
      // The reader moved during the travel. Their scroll outranks it.
      if (Math.abs(scroll.scrollTop - state.wrote) > 1) {
        cancelAnchorTravel();
        return;
      }
      const progress = Math.min(1, (performance.now() - startedAt) / duration);
      // Ease-out: the movement is an arrival, and arrivals decelerate.
      const eased = 1 - (1 - progress) ** 3;
      setImperativeScrollTop(scroll, from + distance * eased);
      if (progress >= 1) {
        if (releaseFollowOnArrival) setFollowValue(false);
        cancelAnchorTravel();
        return;
      }
      state.wrote = scroll.scrollTop;
      anchorTravelFrameRef.current = window.requestAnimationFrame(step);
    };
    anchorTravelFrameRef.current = window.requestAnimationFrame(step);
  }, [cancelAnchorTravel, setFollowValue, setImperativeScrollTop]);

  const scheduleScrollMetrics = useCallback((element: HTMLDivElement) => {
    if (scrollMetricsFrameRef.current !== null) return;
    scrollMetricsFrameRef.current = window.requestAnimationFrame(() => {
      scrollMetricsFrameRef.current = null;
      synchronizeScrollPosition(element);
    });
  }, [synchronizeScrollPosition]);

  useLayoutEffect(() => {
    commitPendingLayoutScroll();
  }, [
    commitPendingLayoutScroll,
    measureVersion,
    virtualRange.end,
    virtualRange.start,
    virtualViewport.bottom,
    virtualViewport.top,
  ]);

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
      if (!requestLayoutScrollTop(scroll, scroll.scrollTop + result.remainingDelta)) return;
    }
    shrinkDisclosureAnchorRunwayToRequired(scroll);
    expectedProgrammaticScrollTopRef.current = scroll.scrollTop;
    synchronizeScrollPosition(scroll);
  }, [
    requestLayoutScrollTop,
    setDisclosureAnchorRunway,
    shrinkDisclosureAnchorRunwayToRequired,
    synchronizeScrollPosition,
  ]);

  const resumeDeferredDisclosureScrollWork = useCallback(() => {
    if (sendAnchorLayoutDeferredRef.current) {
      sendAnchorLayoutDeferredRef.current = false;
      applySendAnchorLayoutRef.current();
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

  const cancelDisclosureOverriddenScrollWork = useCallback(() => {
    cancelPendingLayoutScroll();
    cancelPendingVirtualScrollAdjustment();
    cancelSendAnchorSettlement();
    cancelAnchorTravel();
  }, [
    cancelAnchorTravel,
    cancelPendingLayoutScroll,
    cancelPendingVirtualScrollAdjustment,
    cancelSendAnchorSettlement,
  ]);

  const captureLocalDisclosureAnchor = useCallback((anchorElement: HTMLElement | null) => {
    cancelDisclosureOverriddenScrollWork();
    const scroller = nearestScrollContainer(anchorElement, scrollRef.current);
    capturePendingAnchor(captureDisclosureScrollAnchor(anchorElement, scroller));
  }, [cancelDisclosureOverriddenScrollWork, capturePendingAnchor]);

  /**
   * Riding a tail the reader could actually scroll away from.
   *
   * `follow` alone is not that. `isTranscriptFollowing` measures distance to the
   * bottom, which a transcript shorter than its viewport satisfies at rest, and
   * `follow` starts true besides — so every short Thread reports itself as
   * riding a tail it does not have. A disclosure asking this question is asking
   * whether holding its control means "stay at the bottom"; in a view that shows
   * all of itself there is no bottom to stay at, and the answer has to be no or
   * the commonest Subagent transcript there is — one brief, one short result —
   * keeps the very behavior this predicate exists to end.
   *
   * A mounted send spacer owns the rendered bottom, so `follow` describes that
   * synthetic range rather than a real-content tail. It is a stronger answer
   * than subtracting the spacer's height: the content flex gap is synthetic too,
   * and the disclosure control can still sit near the top while the scroller is
   * at that rendered bottom. The anchor runway is likewise renderer-only range.
   * `follow` still gates the remaining case, because it is the pin's own state
   * and the two must not disagree about one layout transaction.
   */
  const isFollowingBottom = useCallback(() => {
    if (!followRef.current || sendAnchorSpacerRef.current) return false;
    const scroll = scrollRef.current;
    if (!scroll) return false;
    const contentHeight = scroll.scrollHeight
      - disclosureAnchorRunwayRef.current;
    return contentHeight - scroll.clientHeight > 1;
  }, []);

  const expandState = useMemo<ThreadDisclosureState>(() => ({
    captureAnchor: captureLocalDisclosureAnchor,
    holdAnchorUntilSettled: holdUntilSettled,
    isExpanded: (id, defaultExpanded = false) => disclosureOverrides[id] ?? defaultExpanded,
    isFollowingBottom,
    restoreAnchor: restorePendingAnchor,
    toggle: (id, currentlyExpanded, anchorElement) => {
      cancelDisclosureOverriddenScrollWork();
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
    cancelDisclosureOverriddenScrollWork,
    captureLocalDisclosureAnchor,
    capturePendingAnchor,
    disclosureOverrides,
    holdUntilSettled,
    isFollowingBottom,
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
    const attempts = request.attempts + (request.verified ? 1 : 0);
    // Holding the anchor until the transcript stops growing covers the Turns
    // above that have no measured height to place them by: they arrive at their
    // real height only once rendering reaches them, and releasing on the first
    // agreement would leave the reader wherever that growth pushed them.
    const stableGeometry = anchorRow !== null
      && Math.abs(nextTop - scroll.scrollTop) < 1
      && scroll.scrollHeight === request.scrollHeight;
    const stableFrames = request.verified
      ? stableGeometry ? request.stableFrames + 1 : 0
      : request.stableFrames;
    const settled = !anchor
      || stableFrames >= 2
      || attempts >= TRANSCRIPT_SCROLL_RESTORE_ATTEMPTS;
    const pendingRequest: PendingScrollRestore | null = settled
      ? null
      : {
        ...request,
        attempts,
        scrollHeight: scroll.scrollHeight,
        stableFrames,
        verified: false,
      };
    scrollRestoreRef.current = pendingRequest;
    requestLayoutScrollTop(scroll, nextTop);
    if (pendingRequest && scrollRestoreVerificationFrameRef.current === null) {
      scrollRestoreVerificationFrameRef.current = window.requestAnimationFrame(() => {
        scrollRestoreVerificationFrameRef.current = null;
        const current = scrollRestoreRef.current;
        if (!current) return;
        scrollRestoreRef.current = { ...current, verified: true };
        setScrollRestoreVersion((version) => version + 1);
      });
    }
  }, [hasPendingAnchor, requestLayoutScrollTop]);

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
    // A send owns the viewport from the click until its message is anchored,
    // and its travel owns it until the movement finishes. The message renders
    // before the anchor can measure it, and a pin in that gap parks it at the
    // bottom edge for as long as the round trip lasts — which is precisely the
    // position the anchor then has to undo.
    if (pendingSendScrollRef.current || anchorTravelRef.current) return;
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
      if (pendingSendScrollRef.current || anchorTravelRef.current) return;
      if (releaseUnsynchronizedUpwardScroll(scroll)) return;
      setImperativeScrollTop(scroll, scroll.scrollHeight);
    });
  }, [hasPendingAnchor, releaseUnsynchronizedUpwardScroll, setImperativeScrollTop]);

  const pinStructuralBottomBeforePaint = useCallback(() => {
    const scroll = scrollRef.current;
    if (
      !scroll
      || !followRef.current
      || hasPendingAnchor()
      || pendingSendScrollRef.current
      || anchorTravelRef.current
      || sendAnchorSpacerRef.current
      || releaseUnsynchronizedUpwardScroll(scroll)
    ) return;
    requestLayoutScrollTop(scroll, scroll.scrollHeight);
  }, [hasPendingAnchor, releaseUnsynchronizedUpwardScroll, requestLayoutScrollTop]);

  const measureTurn = useCallback((
    turnId: string,
    height: number,
    element: HTMLDivElement,
    targetMeasureRequest: number | null,
  ) => {
    const current = measuredTurnHeights.get(turnId);
    const heightChanged = current === undefined || Math.abs(current - height) >= 1;
    const pending = pendingSendScrollRef.current;
    const completesTargetMeasurement = pending !== null
      && pending.targetTurnId === turnId
      && targetMeasureRequest !== null
      && pending.targetMeasureRequest === targetMeasureRequest
      && pending.targetMeasureCompleted < targetMeasureRequest;
    if (!heightChanged && !completesTargetMeasurement) return;

    if (heightChanged) {
      turnMeasureGenerationRef.current += 1;
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
        && !pendingSendScrollRef.current
        && !sendAnchorSpacerRef.current
        && Math.abs(delta) >= 1
      ) {
        const rowTop = element.getBoundingClientRect().top;
        const viewportTop = scroll.getBoundingClientRect().top;
        if (rowTop + height <= viewportTop + 1) {
          const pendingAdjustment = pendingVirtualScrollAdjustmentRef.current;
          pendingVirtualScrollAdjustmentRef.current = {
            applyAtMeasureVersion: pendingAdjustment?.applyAtMeasureVersion ?? 0,
            anchor: pendingAdjustment?.anchor ?? readTranscriptAnchor(scroll),
            top: (pendingAdjustment?.top ?? scroll.scrollTop) + delta,
          };
        }
      }
      measuredTurnHeights.set(turnId, height);
      if (state.virtualized) {
        setMeasureVersion((version) => {
          const pendingAdjustment = pendingVirtualScrollAdjustmentRef.current;
          if (pendingAdjustment) pendingAdjustment.applyAtMeasureVersion = version + 1;
          return version + 1;
        });
      }
    }

    if (completesTargetMeasurement) pending.targetMeasureCompleted = targetMeasureRequest;
    if (pending?.targetTurnId === turnId) advancePendingSendLayout(pending, true);
  }, [advancePendingSendLayout, hasPendingAnchor, measuredTurnHeights]);

  /**
   * Put the message this reader just sent at the top of the viewport.
   *
   * Synchronous layout passes stage the target row, its settled measurement,
   * the runway spacer, and finally the scroll. React flushes layout-effect state
   * updates before painting, so those commits still belong to one frame. Run
   * them a frame apart instead — as a `requestAnimationFrame` chain — and each
   * pass measures a DOM the previous one has already moved, which is how the
   * anchor came to paint one frame ~40px past the top before settling back.
   *
   * The pass writes the scroll only on its OWN numbers: when the spacer it
   * computes is already the rendered one, `naturalTargetTop` is reachable by
   * construction and the clamp below cannot bite. A pass that had to change the
   * spacer returns instead and lets the re-render bring it back.
   */
  const applySendAnchorLayout = useCallback(() => {
    if (!pendingSendScrollRef.current && !sendAnchorSpacerRef.current) {
      sendAnchorLayoutDeferredRef.current = false;
      return;
    }
    if (hasPendingAnchor()) {
      sendAnchorLayoutDeferredRef.current = true;
      return;
    }
    sendAnchorLayoutDeferredRef.current = false;
    const pending = pendingSendScrollRef.current;
    const currentSpacer = sendAnchorSpacerRef.current;
    const scroll = scrollRef.current;
    // The Turn this send became, the moment it is in the transcript — which is
    // one notification, not one round trip, after the click.
    //
    // Re-resolved every pass, never latched: the first answer is usually the
    // echo's own synthetic id, and that row leaves the DOM the instant the
    // canonical Turn lands. Held from an earlier pass it would name a row that
    // no longer exists, and this function would then return at the missing-row
    // guard below forever — with `pendingSendScrollRef` still set, which is
    // what suspends the bottom pin, so the transcript would never follow a
    // streaming reply again for the life of the mount.
    if (pending) {
      const sent = resolveSentTurn(
        virtualStateRef.current.turns,
        pending.clientMessageId,
        pending.acceptedTurnId,
      );
      if (sent !== null && sent === pending.previousTailTurnId) {
        // A steer. It has no anchor of its own, and the reply it joined goes on
        // streaming under a reader who asked to stay with it.
        cancelSendAnchorSettlement();
        pendingSendScrollRef.current = null;
        clearSendAnchorSpacer();
        scheduleBottomPin();
        return;
      }
      if (sent !== null && sent !== pending.targetTurnId) {
        cancelSendAnchorSettlement();
        pending.anchored = false;
        pending.settleScrollHeight = 0;
        pending.settleStableFrames = 0;
        pending.settleTargetTop = 0;
        pending.settleTurnMeasureGeneration = turnMeasureGenerationRef.current;
        pending.targetTurnId = sent;
        pending.targetReadyAtVersion = pendingSendVersion;
        pending.targetSettlementStaged = false;
      }
    }
    const targetTurnId = pending?.targetTurnId ?? currentSpacer?.turnId;
    if (!targetTurnId || !scroll) return;
    if (pending && !prepareSendTargetCoverage(targetTurnId)) {
      stagePendingSendMeasurement(pending);
      return;
    }
    const row = scroll.querySelector<HTMLDivElement>(
      `[data-thread-turn-row="${CSS.escape(targetTurnId)}"]`,
    );
    if (pending && !row) {
      stagePendingSendMeasurement(pending);
      return;
    }
    if (pending && pending.targetMeasureCompleted < pending.targetMeasureRequest) {
      return;
    }
    if (pending && row) {
      const rowHeight = row.getBoundingClientRect().height;
      if (
        !pending.targetSettlementStaged
        && rowHeight > scroll.clientHeight
        && !row.querySelector('.thread-user-expand-button')
      ) {
        pending.targetSettlementStaged = true;
        stagePendingSendMeasurement(pending);
        return;
      }
      const measuredHeight = measuredTurnHeights.get(targetTurnId);
      if (measuredHeight === undefined || Math.abs(measuredHeight - rowHeight) >= 1) {
        measureTurn(targetTurnId, rowHeight, row, null);
        return;
      }
      if (
        pending.targetReadyAtVersion === null
        || pendingSendVersion < pending.targetReadyAtVersion
      ) {
        return;
      }
    }
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
    } else if (pending) {
      // The row is the whole measurement. Anchoring off a cached top while the
      // Turn is out of the DOM would scroll to where it used to be.
      return;
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
      }
    } else if (currentSpacer?.turnId === targetTurnId) {
      updateSendAnchorSpacer(null);
    }
    if (!pending) return;
    const maximumTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    // Unreachable means this pass is reading a layout that is still moving —
    // a row above still growing, an image still arriving. Writing the clamped
    // top would paint the message past the top of the viewport and then walk it
    // back; the next pass has the settled numbers.
    if (naturalTargetTop > maximumTop + 1) return;
    const targetTop = Math.max(0, Math.min(maximumTop, naturalTargetTop));
    const distance = targetTop - scroll.scrollTop;
    const includeCurrent = !pending.anchored
      && readMotionDuration() > 0
      && Math.abs(distance) >= 1
      && Math.abs(distance) <= scroll.clientHeight * ANCHOR_TRAVEL_MAX_VIEWPORTS
      && !prefersReducedMotion();
    if (!prepareLayoutScrollCoverage(scroll, targetTop, includeCurrent)) return;
    if (includeCurrent) {
      pendingSendScrollRef.current = null;
      playAnchorTravel(scroll, scroll.scrollTop, targetTop, releaseFollowOnAnchor);
      return;
    }
    if (pending.anchored) {
      if (Math.abs(scroll.scrollTop - targetTop) >= 1) {
        requestLayoutScrollTop(scroll, targetTop);
      }
    } else {
      pending.anchored = true;
      pending.settleScrollHeight = 0;
      pending.settleStableFrames = 0;
      pending.settleTargetTop = targetTop;
      pending.settleTurnMeasureGeneration = turnMeasureGenerationRef.current;
      playAnchorTravel(scroll, scroll.scrollTop, targetTop, false);
    }
    scheduleSendAnchorSettlement(pending);
  }, [
    cancelSendAnchorSettlement,
    clearSendAnchorSpacer,
    hasPendingAnchor,
    measureTurn,
    measuredTurnHeights,
    pendingSendVersion,
    playAnchorTravel,
    prepareLayoutScrollCoverage,
    prepareSendTargetCoverage,
    requestLayoutScrollTop,
    scheduleBottomPin,
    scheduleSendAnchorSettlement,
    stagePendingSendMeasurement,
    updateSendAnchorSpacer,
  ]);

  useLayoutEffect(() => {
    scheduleBottomPinRef.current = scheduleBottomPin;
    applySendAnchorLayoutRef.current = applySendAnchorLayout;
  }, [scheduleBottomPin, applySendAnchorLayout]);

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
      const anchorRow = latestAdjustment.anchor
        ? ownTranscriptRows(scroll).find(
          (row) => row.dataset.threadTurnRow === latestAdjustment.anchor?.turnId,
        ) ?? null
        : null;
      const targetTop = latestAdjustment.anchor && anchorRow
        ? scroll.scrollTop
          + (anchorRow.getBoundingClientRect().top - scroll.getBoundingClientRect().top)
          - latestAdjustment.anchor.offset
        : latestAdjustment.top;
      setImperativeScrollTop(scroll, targetTop);
    });
  }, [hasPendingAnchor, measureVersion, setImperativeScrollTop]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return undefined;
    const synchronizeLayout = (imperative = false) => {
      reconcileDisclosureAnchorRunway(scroll);
      const preparedScrollOwnsCoverage = pendingLayoutScrollRef.current !== null
        || Boolean(pendingSendScrollRef.current?.targetTurnId);
      if (!preparedScrollOwnsCoverage) {
        if (imperative) ensureImperativeScrollCoverage(scroll);
        else prepareLayoutScrollCoverage(scroll, scroll.scrollTop);
      }
      updateScrollMetrics(scroll);
      attemptScrollRestore();
      applySendAnchorLayout();
      scheduleBottomPin();
    };
    synchronizeLayout();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => synchronizeLayout(true));
    observer.observe(scroll);
    const content = transcriptContentRef.current;
    const turnsElement = transcriptTurnsRef.current;
    const composer = composerRegionRef.current;
    if (content) observer.observe(content);
    if (turnsElement) observer.observe(turnsElement);
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [
    attemptScrollRestore,
    ensureImperativeScrollCoverage,
    prepareLayoutScrollCoverage,
    reconcileDisclosureAnchorRunway,
    scheduleBottomPin,
    applySendAnchorLayout,
    updateScrollMetrics,
  ]);

  useLayoutEffect(() => {
    const previousContent = bottomPinContentRef.current;
    const structuralItemAdded = itemCount > previousContent.itemCount;
    const replayBottomPin = previousContent.itemCount !== itemCount
      || previousContent.turns !== turns;
    bottomPinContentRef.current = { itemCount, turns };
    attemptScrollRestore();
    applySendAnchorLayout();
    if (structuralItemAdded) pinStructuralBottomBeforePaint();
    scheduleBottomPin(replayBottomPin);
  }, [
    attemptScrollRestore,
    // The echo is content this effect has to see: it changes what is drawn
    // without changing the Item count or the canonical Turn list, and it is the
    // row the anchor below is waiting for.
    echoTurn,
    itemCount,
    pendingSendVersion,
    pinStructuralBottomBeforePaint,
    scheduleBottomPin,
    applySendAnchorLayout,
    sendAnchorSpacer,
    scrollRestoreVersion,
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
    applySendAnchorLayoutRef.current = () => undefined;
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
      bottomScrollFrameRef.current = null;
    }
    if (scrollMetricsFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollMetricsFrameRef.current);
      scrollMetricsFrameRef.current = null;
    }
    if (scrollRestoreVerificationFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollRestoreVerificationFrameRef.current);
      scrollRestoreVerificationFrameRef.current = null;
    }
    cancelAnchorTravel();
    cancelPendingLayoutScroll();
    cancelPendingVirtualScrollAdjustment();
    cancelSendAnchorSettlement();
    pendingSendScrollRef.current = null;
    sendAnchorSpacerRef.current = null;
    setDisclosureAnchorRunway(0);
  }, [
    cancelAnchorTravel,
    cancelPendingLayoutScroll,
    cancelPendingVirtualScrollAdjustment,
    cancelSendAnchorSettlement,
    setDisclosureAnchorRunway,
  ]);

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
      const historySession = composerHistorySessionRef.current;
      if (historySession) {
        composerHistorySessionRef.current = null;
        releaseComposerHistoryUiState(historySession.resources.releaseAll(attachmentsRef.current));
      }
      for (const attachment of attachmentsRef.current) discardManagedAttachment(threadId, attachment);
      for (const request of pendingPasteRequestsRef.current.values()) {
        request.controller.abort();
        request.detachLifecycleAbort();
        releaseReplacedPasteAttachments(request);
      }
      pendingPasteRequestsRef.current.clear();
      attachmentUiState.clear();
      pastedTextOrdinalRef.current = 0;
    };
  }, [attachmentUiState, threadId]);

  useEffect(() => {
    attachmentUiState.reconcileCanonical(canonicalThreadAttachmentIds(turns));
  }, [attachmentUiState, turns]);

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
    const frame = window.requestAnimationFrame(() => {
      if (composerFocusRequestIsCurrent(
        composerFocusExpectedActiveElement,
        document.activeElement,
        document.body,
      )) composerRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [composerFocusExpectedActiveElement, composerFocusToken, waitingForInput]);

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

  function captureVisibleComposerBundle(): ComposerHistoryBundle | null {
    const snapshot = composerRef.current?.snapshot() ?? null;
    return snapshot === null ? null : {
      attachments: [...attachmentsRef.current],
      content: null,
      snapshot,
      uiState: attachmentUiState.capture(attachmentsRef.current.map((attachment) => attachment.id)),
    };
  }

  function mountComposerBundle(bundle: ComposerHistoryBundle): ComposerHistoryBundle | null {
    const editor = composerRef.current;
    if (!editor) return null;
    composerHistorySwapRef.current = true;
    editor.setFileRemovalPreview(null);
    try {
      flushSync(() => {
        const nextAttachments = [...bundle.attachments];
        attachmentUiState.mount(bundle.uiState);
        attachmentsRef.current = nextAttachments;
        setAttachments(nextAttachments);
        if (bundle.snapshot) editor.restore(bundle.snapshot);
        else editor.setContent(bundle.content, { selection: 'end' });
      });
      return captureVisibleComposerBundle();
    } finally {
      composerHistorySwapRef.current = false;
    }
  }

  function releaseComposerHistoryUiState(released: readonly ThreadAttachmentContent[]): void {
    const releasedIds = new Set<string>();
    for (const attachment of released) {
      if (releasedIds.has(attachment.id)) continue;
      releasedIds.add(attachment.id);
      attachmentUiState.releaseDraft(attachment.id);
    }
  }

  function createComposerHistoryResources(): ComposerHistoryResources {
    return new ComposerHistoryResourceRegistry<string, ComposerHistoryBundle, ThreadAttachmentContent, ThreadResourceReference>(
      currentThreadResourceAdapter({
        requestDiscardIfUnlinked: (handle) => discardManagedResourceHandle(threadId, handle),
      }),
      (bundle: ComposerHistoryBundle) => bundle.attachments,
    );
  }

  function hiddenComposerHistoryAttachments(): ThreadAttachmentContent[] {
    return composerHistorySessionRef.current?.resources.attachments() ?? [];
  }

  function endComposerHistorySession(): void {
    const session = composerHistorySessionRef.current;
    if (!session) return;
    composerHistorySessionRef.current = null;
    releaseComposerHistoryUiState(session.resources.releaseAll(attachmentsRef.current));
  }

  function handleComposerHistoryAction(
    request: ThreadComposerHistoryActionRequest,
  ): ThreadComposerHistoryActionResult {
    if (
      !request.editorFocused
      || !request.plainArrow
      || !request.textSelection
      || !request.atVisualBoundary
      || attachmentOperationActivityRef.current > 0
      || draftRef.current.pendingFileRefs.length > 0
    ) return 'declined';

    const entries = selectReaderComposerHistoryEntries(turns);
    const existingSession = composerHistorySessionRef.current;
    const transition = navigateThreadComposerHistory(
      existingSession?.state ?? IDLE_THREAD_COMPOSER_HISTORY_STATE,
      entries,
      request.direction,
    );
    if (transition.kind === 'declined') return 'declined';
    if (transition.kind === 'boundary') return 'performed';

    let session = existingSession;
    if (!session) {
      const scratch = captureVisibleComposerBundle();
      if (!scratch || transition.kind !== 'select') return 'declined';
      const resources = createComposerHistoryResources();
      resources.set(COMPOSER_HISTORY_SCRATCH_SLOT, scratch);
      session = {
        resources,
        state: IDLE_THREAD_COMPOSER_HISTORY_STATE,
      };
      composerHistorySessionRef.current = session;
    } else if (session.state.kind === 'browsing' || session.state.kind === 'scratch') {
      const current = captureVisibleComposerBundle();
      if (!current) return 'declined';
      const currentSlot = session.state.kind === 'browsing'
        ? composerHistoryItemSlot(session.state.selectedItemId)
        : COMPOSER_HISTORY_SCRATCH_SLOT;
      session.resources.set(currentSlot, current);
    }
    if (!session) return 'declined';

    if (transition.kind === 'restoreScratch') {
      const scratch = session.resources.take(COMPOSER_HISTORY_SCRATCH_SLOT);
      if (!scratch) return 'declined';
      const mountedScratch = mountComposerBundle(scratch);
      if (!mountedScratch) {
        session.resources.set(COMPOSER_HISTORY_SCRATCH_SLOT, scratch);
        return 'declined';
      }
      session.state = transition.state;
      if (transition.state.kind === 'idle') {
        composerHistorySessionRef.current = null;
        releaseComposerHistoryUiState(session.resources.releaseAll(mountedScratch.attachments));
      }
      return 'performed';
    }

    const departedItemId = session.state.kind === 'browsing'
      ? session.state.selectedItemId
      : null;
    const targetSlot = composerHistoryItemSlot(transition.entry.id);
    const retainedTarget = session.resources.take(targetSlot);
    const target = retainedTarget
      ?? composerHistoryBundleFromContent(
        transition.entry.content,
        indexStore.getCurrent(),
        (attachmentId) => attachmentUiState.canonicalPreviewFor(attachmentId),
        threadReferences,
      );
    const mounted = mountComposerBundle(target);
    if (!mounted) {
      if (retainedTarget) session.resources.set(targetSlot, retainedTarget);
      return 'declined';
    }
    session.state = transition.state;

    if (transition.reanchored && departedItemId !== null && departedItemId !== transition.entry.id) {
      releaseComposerHistoryUiState(session.resources.release(
        composerHistoryItemSlot(departedItemId),
        attachmentsRef.current,
      ));
    }
    return 'performed';
  }

  async function submit() {
    const currentDraft = draftRef.current;
    if (!composerEnabled
      || currentDraft.empty
      || currentDraft.pendingFileRefs.length > 0
      || sending
      || threadCreationPending
      || waitingForInput) return;
    endComposerHistorySession();
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
    const disclosureAnchorPending = hasPendingAnchor();
    const renderedSendSpacer = scroll?.querySelector<HTMLElement>('.thread-send-anchor-spacer') ?? null;
    const preSendContentScrollHeight = scroll
      ? Math.max(
          0,
          scroll.scrollHeight
            - (renderedSendSpacer?.getBoundingClientRect().height ?? 0)
            - disclosureAnchorRunwayRef.current,
        )
      : 0;
    const shouldAnchorSend = Boolean(scroll && (
      disclosureAnchorPending
      || transcriptNeedsSendAnchor({
        clientHeight: scroll.clientHeight,
        scrollHeight: preSendContentScrollHeight,
      })
    ));
    const previousViewport = scroll ? {
      anchor: followRef.current ? null : readTranscriptAnchor(scroll),
      disclosureRunway: disclosureAnchorRunwayRef.current,
      follow: followRef.current,
      spacer: sendAnchorSpacerRef.current,
      top: scroll.scrollTop,
    } : null;
    const pendingSend: PendingSendAnchor = {
      acceptedTurnId: null,
      anchored: false,
      clientMessageId: crypto.randomUUID(),
      previousTailTurnId: turns.at(-1)?.id ?? null,
      releaseFollowOnAnchor: Boolean(
        scroll
        && preSendContentScrollHeight - scroll.clientHeight > TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX,
      ),
      targetMeasureCompleted: 0,
      targetMeasureRequest: 0,
      targetReadyAtVersion: null,
      settleScrollHeight: 0,
      settleStableFrames: 0,
      settleTargetTop: 0,
      settleTurnMeasureGeneration: turnMeasureGenerationRef.current,
      targetSettlementStaged: false,
      threadId,
      targetTurnId: null,
    };
    bottomPinDeferredRef.current = false;
    sendAnchorLayoutDeferredRef.current = false;
    cancelAnchorTravel();
    cancelReaderOverriddenScrollWork();
    cancelPendingAnchor();
    clearSendAnchorSpacer();
    setDisclosureAnchorRunway(0);
    // Sending is the reader asking to be at the end of the conversation. A
    // restore that never settled — its anchored Turn rolled back, or simply
    // outside a virtual window when the layout passes stopped — would otherwise
    // fire on the layout pass this send causes and pull them back up, releasing
    // follow on the way so the reply streams away below the fold.
    scrollRestoreRef.current = null;
    pendingSendScrollRef.current = shouldAnchorSend ? pendingSend : null;
    if (scroll && shouldAnchorSend) {
      updateSendAnchorSpacer({
        height: scroll.clientHeight + (pendingSend.releaseFollowOnAnchor
          ? TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX + 2
          : 0),
        releaseFollowOnAnchor: pendingSend.releaseFollowOnAnchor,
        targetTop: scroll.scrollHeight,
        turnId: optimisticTurnId(pendingSend.clientMessageId),
      });
    }
    // Only a send that opens a Turn draws itself. A steer joins the Turn already
    // running, where this row does not belong — it would read as a Turn of its
    // own and then vanish into somebody else's when the Item landed.
    if (activeTurn === null) {
      setPendingEcho({
        acceptedTurnId: null,
        clientMessageId: pendingSend.clientMessageId,
        turn: optimisticSendTurn(
          pendingSend.clientMessageId,
          submittedContent,
          threadId,
          configuration?.modelProvider ?? threadModelProvider,
          Date.now(),
        ),
      });
    }
    setFollowValue(true);
    // No jump to the end here. The message is about to be anchored to the top of
    // the viewport, and a send that first slams to the bottom spends a movement
    // arriving somewhere it does not stay. The end is still where an unanchorable
    // send lands — see the bottom pin below, on the branch that gives up.
    sendingRef.current = true;
    setSending(true);
    setError(null);
    composerRef.current?.clear();
    updateAttachments((current) => current.filter((attachment) => !submittedAttachmentIds.has(attachment.id)));
    try {
      const submission = await onSend(submittedContent, pendingSend.clientMessageId);
      const acceptedTurn = submission?.turn ?? null;
      // A steer is accepted into the active Turn and therefore has no new Turn
      // in the response. Admission disposition, not nullable layout data, owns
      // the preview lease transfer for the exact submitted attachment IDs.
      const attachmentsAccepted = submission !== null && !submission.deduplicated;
      const ourThread = pendingSend.threadId === threadId;
      if (acceptedTurn && ourThread) {
        // Which Turn the host made of this send. Usually the anchor has already
        // run against the row that arrived by notification, and this only
        // confirms it — but a submission that becomes no message of the
        // reader's at all (`/clear`, `/compact`) has no other way to be
        // recognized, and its stand-in row has no other way to be retired.
        pendingSend.acceptedTurnId = acceptedTurn.id;
        recordAcceptedTurn(pendingSend.clientMessageId, acceptedTurn.id);
        advancePendingSendLayout(pendingSend, false);
      } else {
        // Nothing to anchor: a deduplicated resend, a steer, a Thread the
        // reader has since left. The row goes with it — there is no Turn coming
        // that could ever replace it — and the send falls back to its older
        // meaning, that the reader asked to be at the end of the conversation.
        clearPendingEcho(pendingSend.clientMessageId);
        if (pendingSendScrollRef.current === pendingSend) {
          cancelSendAnchorSettlement();
          pendingSendScrollRef.current = null;
          clearSendAnchorSpacer();
          scheduleBottomPin();
        }
      }
      for (const attachmentId of submittedAttachmentIds) {
        if (attachmentsAccepted) {
          attachmentUiState.rememberCanonicalPreview(attachmentId);
        } else {
          attachmentUiState.releaseDraft(attachmentId);
        }
      }
      pastedTextOrdinalRef.current = 0;
    } catch (sendError) {
      if (pendingSendScrollRef.current === pendingSend) {
        cancelSendAnchorSettlement();
        pendingSendScrollRef.current = null;
      }
      // The message is going back into the composer, so it must leave the
      // transcript: a refused send that kept its row would read as sent.
      clearPendingEcho(pendingSend.clientMessageId);
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
            stableFrames: 0,
            top: previousViewport.top,
            verified: false,
          };
        } else {
          scrollRestoreRef.current = null;
          setImperativeScrollTop(currentScroll, previousViewport.top);
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
    attachmentOperationActivityRef.current += 1;
    const result = attachmentOperationTailRef.current
      .catch(() => undefined)
      .then(operation);
    const settled = result.then(
      (value) => {
        attachmentOperationActivityRef.current -= 1;
        return value;
      },
      (error) => {
        attachmentOperationActivityRef.current -= 1;
        throw error;
      },
    );
    attachmentOperationTailRef.current = settled.then(() => undefined, () => undefined);
    return settled;
  }

  function admitLargeTextPaste(
    requestId: string,
    text: string,
    replacedAttachmentIds: readonly string[],
  ): string | null {
    const lifecycle = attachmentLifecycleControllerRef.current;
    if (!lifecycle || lifecycle.signal.aborted || !attachmentAdmissionEnabledRef.current) {
      setError(t.agent.composer.largePasteUnavailable);
      return null;
    }
    const replacedIds = fullyReplacedAttachmentIds(draftRef.current, replacedAttachmentIds);
    const replacedAttachments = attachmentsRef.current.filter((attachment) => replacedIds.has(attachment.id));
    const projectedAttachmentCount = composerAttachmentCount(
      attachmentsRef.current,
      pendingPasteRequestsRef.current,
    ) - replacedAttachments.length + 1;
    if (projectedAttachmentCount > MAX_COMPOSER_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_COMPOSER_ATTACHMENTS }));
      return null;
    }
    const ordinal = pastedTextOrdinalRef.current + 1;
    pastedTextOrdinalRef.current = ordinal;
    const name = pastedTextFileName(ordinal);
    const excerpt = pastedTextExcerpt(text);
    const controller = new AbortController();
    const abortFromLifecycle = () => controller.abort();
    lifecycle.signal.addEventListener('abort', abortFromLifecycle, { once: true });
    const request: PendingComposerPasteRequest = {
      controller,
      detachLifecycleAbort: () => lifecycle.signal.removeEventListener('abort', abortFromLifecycle),
      excerpt,
      name,
      replacedAttachments,
      requestId,
      settling: false,
    };
    pendingPasteRequestsRef.current.set(requestId, request);
    setPendingPastes((current) => [...current, { excerpt, name, requestId }]);
    setError(null);
    void enqueueAttachmentOperation(() => processLargeTextPaste(request, text));
    return name;
  }

  async function processLargeTextPaste(request: PendingComposerPasteRequest, text: string): Promise<void> {
    const { controller, requestId } = request;
    try {
      throwIfAttachmentUploadAborted(controller.signal);
      if (!composerRef.current?.hasPendingFileReference(requestId)) return;
      if (
        !attachmentAdmissionEnabledRef.current
        || composerAttachmentCount(attachmentsRef.current, pendingPasteRequestsRef.current) > MAX_COMPOSER_ATTACHMENTS
      ) throw new Error('Pasted text is no longer eligible for attachment admission.');
      const file = new File([text], request.name, { type: 'text/plain' });
      const prepared = await attachmentFromBrowserFile(file, threadId, controller.signal, requestId);
      throwIfAttachmentUploadAborted(controller.signal);
      if (!composerRef.current?.hasPendingFileReference(requestId)) {
        discardPreparedAttachment(threadId, prepared);
        return;
      }
      attachmentUiState.patch(prepared.content.id, { textExcerpt: request.excerpt });
      commitPreparedAttachments([prepared], { insertReferences: false });
      request.settling = true;
      if (!composerRef.current.settlePendingFileReference(requestId, prepared.reference)) {
        request.settling = false;
        updateAttachments((current) => current.filter((attachment) => attachment.id !== prepared.content.id));
        attachmentUiState.releaseDraft(prepared.content.id);
        discardManagedAttachment(threadId, prepared.content);
      }
    } catch {
      if (!controller.signal.aborted && composerRef.current?.hasPendingFileReference(requestId)) {
        const replacedAttachments = request.replacedAttachments;
        if (replacedAttachments.length > 0) {
          updateAttachments((current) => uniqueAttachments([...current, ...replacedAttachments]));
        }
        request.replacedAttachments = [];
        request.settling = true;
        if (composerRef.current.restorePendingFileReference(requestId)) {
          setError(t.agent.composer.largePasteNotInserted({ name: request.name }));
        } else {
          request.settling = false;
          request.replacedAttachments = replacedAttachments;
          const replacedIds = new Set(replacedAttachments.map((attachment) => attachment.id));
          updateAttachments((current) => current.filter((attachment) => !replacedIds.has(attachment.id)));
        }
      }
    } finally {
      finishPendingPaste(requestId);
    }
  }

  function finishPendingPaste(requestId: string): void {
    const request = pendingPasteRequestsRef.current.get(requestId);
    if (!request) return;
    request.detachLifecycleAbort();
    releaseReplacedPasteAttachments(request);
    pendingPasteRequestsRef.current.delete(requestId);
    setPendingPastes((current) => current.filter((candidate) => candidate.requestId !== requestId));
  }

  function cancelPendingPaste(requestId: string): void {
    pendingPasteRequestsRef.current.get(requestId)?.controller.abort();
    finishPendingPaste(requestId);
  }

  function releaseReplacedPasteAttachments(request: PendingComposerPasteRequest): void {
    if (request.replacedAttachments.length === 0) return;
    const retained = [
      ...attachmentsRef.current,
      ...Array.from(pendingPasteRequestsRef.current.values())
        .filter((candidate) => candidate !== request)
        .flatMap((candidate) => candidate.replacedAttachments),
    ];
    const historyResources = composerHistorySessionRef.current?.resources;
    const releasedResources: ThreadAttachmentContent[] = [];
    for (const attachment of request.replacedAttachments) {
      if (retained.some((candidate) => candidate.id === attachment.id)) continue;
      if (historyResources) {
        historyResources.releaseUnlinked([attachment], retained);
      } else if (
        !retained.some((candidate) => sameManagedResource(candidate, attachment))
        && !releasedResources.some((candidate) => sameManagedResource(candidate, attachment))
      ) {
        discardManagedAttachment(threadId, attachment);
        releasedResources.push(attachment);
      }
      attachmentUiState.releaseDraft(attachment.id);
    }
    request.replacedAttachments = [];
  }

  function rejectTextPaste(reason: 'ceiling' | 'draft-budget' | 'pending-replacement'): void {
    setError(reason === 'ceiling'
      ? t.agent.composer.largePasteCeiling
      : reason === 'draft-budget'
        ? t.agent.composer.largePasteDraftBudget
        : t.agent.composer.largePasteUnavailable);
  }

  function addPickedFiles(): Promise<void> {
    return enqueueAttachmentOperation(processPickedFiles);
  }

  async function processPickedFiles() {
    const signal = attachmentLifecycleControllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    if (composerAttachmentCount(attachmentsRef.current, pendingPasteRequestsRef.current) >= MAX_COMPOSER_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_COMPOSER_ATTACHMENTS }));
      return;
    }
    setError(null);
    if (window.lin?.pickLocalFiles) {
      try {
        const result = await window.lin.pickLocalFiles({
          maxFiles: MAX_COMPOSER_ATTACHMENTS
            - composerAttachmentCount(attachmentsRef.current, pendingPasteRequestsRef.current),
        });
        if (signal.aborted) return;
        if (!result.canceled) {
          const next: PreparedComposerAttachment[] = [];
          const existingKeys = currentAttachmentSourceKeys(attachmentsRef.current, attachmentUiState.sourceKeys);
          let skippedDuplicates = 0;
          let skippedOverflow = result.skippedCount ?? 0;
          let skippedImageOverflow = 0;
          const rejectedOwnershipFile = result.rejectedFiles?.find((file) => file.reason === 'officeOwnershipFile');
          let failure: string | null = rejectedOwnershipFile
            ? t.agent.composer.officeOwnershipFile({
                name: rejectedOwnershipFile.name,
                suggestedName: rejectedOwnershipFile.suggestedName ?? null,
              })
            : null;
          for (const file of result.files) {
            if (signal.aborted) return;
            if (next.length >= MAX_COMPOSER_ATTACHMENTS
              - composerAttachmentCount(attachmentsRef.current, pendingPasteRequestsRef.current)) {
              skippedOverflow += 1;
              continue;
            }
            const sourceKey = `path:${file.path}`;
            if (existingKeys.has(sourceKey)) {
              skippedDuplicates += 1;
              continue;
            }
            if (
              isImageMimeType(file.mimeType)
              && countImageAttachments(attachmentsRef.current) + countImagePreparedAttachments(next)
                >= MAX_COMPOSER_IMAGE_ATTACHMENTS
            ) {
              skippedImageOverflow += 1;
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
            ?? overflowAttachmentMessage(skippedOverflow, t.agent.composer)
            ?? imageOverflowAttachmentMessage(skippedImageOverflow, t.agent.composer));
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
    if (composerAttachmentCount(attachmentsRef.current, pendingPasteRequestsRef.current) >= MAX_COMPOSER_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_COMPOSER_ATTACHMENTS }));
      return;
    }
    setError(null);
    const next: PreparedComposerAttachment[] = [];
    const existingKeys = currentAttachmentSourceKeys(attachmentsRef.current, attachmentUiState.sourceKeys);
    let skippedDuplicates = 0;
    let skippedOverflow = 0;
    let skippedImageOverflow = 0;
    let failure: string | null = null;
    for (const file of files) {
      if (next.length >= MAX_COMPOSER_ATTACHMENTS
        - composerAttachmentCount(attachmentsRef.current, pendingPasteRequestsRef.current)) {
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
      if (
        isImageMimeType(file.type)
        && countImageAttachments(attachmentsRef.current) + countImagePreparedAttachments(next)
          >= MAX_COMPOSER_IMAGE_ATTACHMENTS
      ) {
        skippedImageOverflow += 1;
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
      ?? overflowAttachmentMessage(skippedOverflow, t.agent.composer)
      ?? imageOverflowAttachmentMessage(skippedImageOverflow, t.agent.composer));
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
      attachmentUiState.patch(attachment.content.id, {
        ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
        sourceKey: attachment.sourceKey,
      });
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
    if (composerAttachmentCount(attachmentsRef.current, pendingPasteRequestsRef.current) >= MAX_COMPOSER_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_COMPOSER_ATTACHMENTS }));
      return null;
    }
    setError(null);
    if (
      isImageMimeType(file.mimeType)
      && countImageAttachments(attachmentsRef.current) >= MAX_COMPOSER_IMAGE_ATTACHMENTS
    ) {
      setError(t.agent.composer.maxImages({ max: MAX_COMPOSER_IMAGE_ATTACHMENTS }));
      return null;
    }
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
      const existingKeys = currentAttachmentSourceKeys(attachmentsRef.current, attachmentUiState.sourceKeys);
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
    if (composerHistorySwapRef.current) return;
    const retainedPendingRequests = new Set(next.pendingFileRefs.map((reference) => reference.requestId));
    for (const requestId of pendingPasteRequestsRef.current.keys()) {
      if (retainedPendingRequests.has(requestId)) continue;
      const request = pendingPasteRequestsRef.current.get(requestId);
      if (request?.settling) finishPendingPaste(requestId);
      else cancelPendingPaste(requestId);
    }
    if (sendingRef.current) return;
    const referencedIds = new Set(next.fileRefs.map((ref) => ref.attachmentId));
    const heldAttachmentIds = new Set(Array.from(pendingPasteRequestsRef.current.values())
      .flatMap((request) => request.replacedAttachments.map((attachment) => attachment.id)));
    const hiddenHistoryAttachments = hiddenComposerHistoryAttachments();
    const historyResources = composerHistorySessionRef.current?.resources;
    const current = attachmentsRef.current;
    const retained = current.filter((attachment) => referencedIds.has(attachment.id));
    if (retained.length === current.length) return;
    for (const attachment of current) {
      if (!referencedIds.has(attachment.id)) {
        if (heldAttachmentIds.has(attachment.id)) continue;
        if (hiddenHistoryAttachments.some((candidate) => candidate.id === attachment.id)) continue;
        if (historyResources) {
          historyResources.releaseUnlinked([attachment], retained);
        } else if (
          !retained.some((candidate) => sameManagedResource(candidate, attachment))
        ) {
          discardManagedAttachment(threadId, attachment);
        }
        attachmentUiState.releaseDraft(attachment.id);
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
    <div
      className="thread-view"
      onClick={refocusComposerFromClick}
      onMouseDown={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        // Keep an active composer focused across pointer-only disclosures.
        // Keyboard activation and selection gestures retain native focus.
        if (composerEnabled && !waitingForInput
          && event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
          && target?.closest('[data-thread-disclosure-id]')
          && target.closest('.thread-view') === event.currentTarget
          && composerRegionRef.current?.contains(document.activeElement)
          && window.getSelection()?.isCollapsed !== false) event.preventDefault();
      }}
    >
      <div className="thread-transcript-shell">
        <div
          className="thread-transcript"
          onKeyDownCapture={(event) => {
            if (TRANSCRIPT_SCROLL_INTENT_KEYS.has(event.key)) markTransientScrollIntent();
          }}
          onPointerCancel={endPointerScrollIntent}
          onPointerDown={(event) => {
            if (isInteractiveTranscriptPointerTarget(event.target, event.currentTarget)) return;
            beginPointerScrollIntent();
          }}
          onPointerUp={endPointerScrollIntent}
          onScroll={(event) => {
            const scroll = event.currentTarget;
            const expectedTop = expectedProgrammaticScrollTopRef.current;
            const programmatic = expectedTop !== null && Math.abs(scroll.scrollTop - expectedTop) < 1;
            const readerDriven = !programmatic && (
              pointerScrollIntentRef.current
              || transientScrollIntentRef.current
              || !event.nativeEvent.isTrusted
            );
            transientScrollIntentRef.current = false;
            expectedProgrammaticScrollTopRef.current = null;
            if (readerDriven) {
              cancelReaderOverriddenScrollWork();
            }
            ensureImperativeScrollCoverage(scroll);
            if (readerDriven) cancelPendingVirtualScrollAdjustment();
            else if (!programmatic && pendingVirtualScrollAdjustmentRef.current) return;
            if (!programmatic) {
              scrollRestoreRef.current = null;
            }
            reconcileDisclosureAnchorRunway(scroll);
            synchronizedScrollTopRef.current = scroll.scrollTop;
            if (!scrollRestoreRef.current) {
              const nextFollow = (
                pendingSendScrollRef.current?.releaseFollowOnAnchor
                || sendAnchorSpacerRef.current?.releaseFollowOnAnchor
              )
                ? false
                : isTranscriptFollowing(scroll);
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
          onTouchMove={markTransientScrollIntent}
          onWheel={markTransientScrollIntent}
          ref={scrollRef}
        >
          <div className="thread-transcript-content" ref={transcriptContentRef}>
            {goal ? <ThreadGoalView goal={goal} /> : null}
            {renderedTurns.length > 0 ? (
              <div
                className={`thread-transcript-turns${virtualized ? ' is-virtual' : ''}`}
                data-virtualized={virtualized ? 'true' : 'false'}
                ref={transcriptTurnsRef}
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
                      targetMeasureRequest={
                        pendingSendScrollRef.current?.targetTurnId === turn.id
                          ? pendingSendScrollRef.current.targetMeasureRequest
                          : null
                      }
                      turnId={turn.id}
                      virtualized={virtualized}
                    >
                      <ThreadTurnView
                        active={active}
                        onInterruptThread={onInterruptThread}
                        canEditUserMessage={!agentTranscript
                          && composerEnabled
                          && turn.id === editableTurnId
                          && turn.status !== 'inProgress'}
                        composerEnabled={composerEnabled}
                        isLastTurn={turnIndex === renderedTurns.length - 1}
                        expandState={expandState}
                        getUserView={getUserView}
                        indexStore={indexStore}
                        onEditUserMessage={onEditUserMessage}
                        onReadTurnRecovery={onReadTurnRecovery}
                        onContinueTurn={onContinueTurn}
                        onRerunTurn={onRerunTurn}
                        onContinueInNewChat={onContinueInNewChat}
                        onOpenSubagentTurnDetails={onOpenSubagentTurnDetails}
                        agentTranscript={agentTranscript}
                        agentEntries={subagentProjection.byAgentId}
                        rootSpeaker={rootSpeaker}
                        rootThreadId={rootThreadId}
                        selfSpeaker={selfSpeaker}
                        onOpenNodeReference={onOpenNodeReference}
                        onOpenThread={onOpenThread}
                        onOpenThreadReference={onOpenThreadReference}
                        onOpenTurnDetails={onOpenTurnDetails}
                        onReadToolArguments={onReadToolArguments}
                        onReadToolOutput={onReadToolOutput}
                        latchedReasoning={latchedReasoning}
                        liveReasoningSeen={liveReasoningSeen}
                        providerRetry={providerRetry?.turnId === turn.id ? providerRetry.status : null}
                        threadId={threadId}
                        threadReferences={threadReferences}
                        threadCwd={threadCwd}
                        threadsById={threadsById}
                        latestTurnByThread={latestTurnByThread}
                        turn={turn}
                        anchors={subagentProjection.anchorsByTurnId.get(turn.id) ?? emptyTurnAnchors(turn)}
                        delivery={subagentProjection.deliveryByTurnId.get(turn.id) ?? null}
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
              cancelReaderOverriddenScrollWork();
              cancelPendingAnchor();
              clearSendAnchorSpacer();
              setDisclosureAnchorRunway(0);
              setFollowValue(true);
              const scroll = scrollRef.current;
              if (scroll) setImperativeScrollTop(scroll, scroll.scrollHeight);
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
          <ThreadPlanProgress plan={activePlan} />
        </div>
      ) : null}
      {composerEnabled ? <div className="thread-composer-region thread-composer" ref={composerRegionRef}>
        {activePlan ? (
          <ThreadPlanProgress
            onClosed={() => composerRef.current?.focus()}
            plan={activePlan}
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
                        <CloseIcon size={ICON_SIZE.rowGlyph} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <ThreadComposerAttachmentTray
                attachments={attachments}
                draft={draft}
                onRemovalPreviewChange={(identity) => composerRef.current?.setFileRemovalPreview(identity)}
                onRemoveAttachment={(attachmentId) => composerRef.current?.removeFileReferences([attachmentId])}
                onRemovePending={(requestId) => composerRef.current?.removePendingFileReferences([requestId])}
                pending={pendingPastes}
                previewUrls={attachmentUiState.previewUrls}
                textExcerpts={attachmentUiState.textExcerpts}
                threadId={threadId}
              />
              <ThreadComposerEditor
                allowFileReferences={!activeTurn && !providerBlocksSend && !waitingForInput && !threadCreationPending}
                allowNodeReferences={!waitingForInput && !threadCreationPending}
                allowSlashCommands={slashCommands.length > 0}
                currentNodeId={null}
                disabled={waitingForInput || threadCreationPending}
                indexStore={indexStore}
                isStreaming={Boolean(activeTurn)}
                onChange={handleDraftChange}
                onFilesPasted={(files) => void addBrowserFiles(files)}
                onLargeTextPaste={admitLargeTextPaste}
                onHistoryAction={handleComposerHistoryAction}
                onLocalFilePreview={previewLocalFile}
                onLocalFileSearch={searchLocalFiles}
                onLocalFileSelect={selectLocalFile}
                onNodeReferenceClick={onOpenNodeReference}
                onThreadReferenceClick={(referencedThreadId) => void onOpenThreadReference(referencedThreadId)}
                onThreadReferenceSearch={searchThreadReferences}
                onTextPasteRejected={rejectTextPaste}
                onStop={() => void onInterrupt()}
                onSubmit={() => void submit()}
                placeholder={activeTurn
                  ? t.agent.composer.steerPlaceholder
                  : composerPlaceholder ?? t.agent.thread.composerPlaceholder}
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
                    || attachments.length + pendingPastes.length >= MAX_COMPOSER_ATTACHMENTS
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
                    iconSize={ICON_SIZE.rowGlyph}
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
  onMeasure,
  style,
  targetMeasureRequest,
  turnId,
  virtualized,
}: {
  readonly children: ReactNode;
  readonly onMeasure: (
    turnId: string,
    height: number,
    element: HTMLDivElement,
    targetMeasureRequest: number | null,
  ) => void;
  readonly style?: CSSProperties;
  readonly targetMeasureRequest: number | null;
  readonly turnId: string;
  readonly virtualized: boolean;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return undefined;
    const measure = (request: number | null) => {
      onMeasure(turnId, element.getBoundingClientRect().height, element, request);
    };
    measure(targetMeasureRequest);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure(null));
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, targetMeasureRequest, turnId]);
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

export const ThreadTurnView = memo(function ThreadTurnView({
  active,
  agentEntries,
  canEditUserMessage,
  composerEnabled,
  isLastTurn,
  expandState,
  getUserView,
  indexStore,
  latchedReasoning,
  liveReasoningSeen,
  onEditUserMessage,
  onReadTurnRecovery,
  onContinueTurn,
  onRerunTurn,
  onContinueInNewChat,
  onInterruptThread,
  onOpenNodeReference,
  onOpenThread,
  onOpenThreadReference,
  onOpenSubagentTurnDetails,
  agentTranscript,
  selfSpeaker,
  onOpenTurnDetails,
  onReadToolArguments,
  onReadToolOutput,
  providerRetry,
  rootSpeaker,
  rootThreadId,
  threadId,
  threadReferences,
  threadCwd,
  threadsById,
  latestTurnByThread,
  turn,
  anchors,
  delivery,
  waitingOnUserInput,
}: {
  readonly active: boolean;
  readonly agentEntries: ReadonlyMap<ThreadId, SubagentRegistryEntry>;
  readonly canEditUserMessage: boolean;
  readonly composerEnabled: boolean;
  readonly expandState: ThreadDisclosureState;
  readonly getUserView: () => RendererUserViewHints;
  readonly indexStore: DocumentIndexStore;
  readonly isLastTurn: boolean;
  /** Reasoning Item ids that have been open by default this session. */
  readonly latchedReasoning: Set<string>;
  /** Reasoning Item ids first observed while their Turn was live. */
  readonly liveReasoningSeen: Set<string>;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onReadTurnRecovery: (turn: Turn) => Promise<TurnRecoveryReadResponse>;
  readonly onContinueTurn: (turn: Turn) => Promise<void>;
  readonly onRerunTurn: (turn: Turn, confirmToolReplay: boolean) => Promise<void>;
  readonly onContinueInNewChat: (turn: Turn) => Promise<void>;
  readonly onInterruptThread: (threadId: string) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onOpenThreadReference: (threadId: string) => Promise<void>;
  readonly onOpenSubagentTurnDetails?: (threadId: string, turnId: string) => void;
  /**
   * This transcript belongs to one Agent, read inside its pushed view. It is
   * what makes the view EMBEDDED: a control that cannot act on a child Thread
   * is hidden, which is narrower than "has no composer" — an Automation
   * transcript has no composer and can still be forked.
   */
  readonly agentTranscript: boolean;
  /** The participant whose transcript this is — it speaks every response here. */
  readonly selfSpeaker: ThreadSpeaker;
  readonly onOpenTurnDetails: (turn: Turn) => void;
  readonly onReadToolArguments: (turnId: string, item: ThreadToolItem) => Promise<JsonValue | null>;
  readonly onReadToolOutput: (turnId: string, item: ThreadToolItem) => Promise<string | null>;
  readonly providerRetry: ProviderRetryStatus | null;
  /** The conversation Agent, addressed canonically by its root Thread id. */
  readonly rootSpeaker: ThreadSpeaker;
  readonly rootThreadId: ThreadId;
  readonly threadId: string;
  readonly threadReferences: ReadonlyMap<string, ThreadReferenceView>;
  readonly threadCwd: string;
  readonly threadsById: ReadonlyMap<ThreadId, Thread>;
  readonly latestTurnByThread: ReadonlyMap<ThreadId, Turn>;
  readonly turn: Turn;
  /** This Turn's delegation anchors, projected once for the conversation. */
  readonly anchors: SubagentTurnAnchors;
  /** Set when the host started this Turn to deliver an Agent's result. */
  readonly delivery: SubagentDelivery | null;
  readonly waitingOnUserInput: boolean;
}) {
  const t = useT();
  const documentNodeIds = useMemo(() => threadDocumentNodeIds(turn), [turn]);
  const index = useDocumentIndexSnapshot(indexStore, documentNodeIds, active);
  const turnRef = useRef(turn);
  turnRef.current = turn;
  const responseTailTurnRef = useRef(turn);
  if (!sameResponseTailTurn(responseTailTurnRef.current, turn)) responseTailTurnRef.current = turn;
  const responseTailTurn = responseTailTurnRef.current;
  const responseItem = lastAgentResponse(turn);
  const hasResponse = responseItem !== null;
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
  // The child that delivered into this Turn, if any: it speaks its own report.
  const reportEntry = useSubagentEntry(delivery?.agentId ?? null);
  const reportReceipt = delivery === null
    ? null
    : reportEntry?.generationReceipts.get(delivery.generation) ?? null;
  const deliveryNoticeItemId = delivery === null
    ? null
    : turn.items.find((item) => (
      item.type === 'userMessage'
      && item.author.kind === 'agent'
      && item.author.threadId === delivery.agentId
    ))?.id ?? null;
  const reportSpeaker: ThreadSpeaker | null = delivery !== null && reportEntry !== null
    ? {
      participantId: delivery.agentId,
      avatarKey: subagentSpeakerName(reportEntry),
      name: subagentSpeakerName(reportEntry),
      // The delegate signs its report with how the run ended: a smile for a
      // result, drooped eyes for an error, closed ones when the reader stopped
      // it. The card states the same facts in words; the face only restates.
      mood: reportReceipt?.terminalStatus === 'failed' ? 'failed'
        : reportReceipt?.terminalStatus === 'interrupted' || reportReceipt?.terminalStatus === 'killed' ? 'stopped'
          : 'done',
    }
    : null;
  // A delivering child's header states ITS OWN span, not this conversation's:
  // the Turn around it is the parent reading the result, which took no time at
  // all next to the work being reported.
  const reportMeta: ReactNode = reportReceipt?.durationMs == null ? null : (
    <span className="thread-speaker-meta">
      {t.agent.thread.workedFor({ duration: formatProcessDuration(reportReceipt.durationMs) })}
    </span>
  );
  const contentGrouperRef = useRef<TurnContentGrouper | null>(null);
  if (contentGrouperRef.current === null) contentGrouperRef.current = createTurnContentGrouper();
  const contentBlocks = contentGrouperRef.current.group({ ...turn, items: anchors.items });
  const processBlock = contentBlocks.find((block) => block.kind === 'process');
  const processItems = processBlock?.kind === 'process' ? processBlock.items : EMPTY_THREAD_ITEMS;
  const processItemGroups = useMemo(() => groupTurnItems(processItems), [processItems]);
  const workingTextEnabled = !waitingOnUserInput && providerRetry === null;
  const activeTool = processItems.reduce<ThreadItem | null>((latest, item) => (
    isThreadToolItem(item) && item.status === 'inProgress' ? item : latest
  ), null);
  const processView = useThreadProcessView({
    anchors,
    expandState,
    hasFinalResponse: responseItem !== null,
    index,
    items: processItems,
    turn,
    waitingOnUserInput,
    workingTextEnabled,
  });
  const leafWorkingEnabled = workingTextEnabled && processView.motionOwner === 'leaf';
  // `groupTurnContent` omits the process block entirely for a Turn with no
  // process Items, so "no response Item" alone does not mean a divider exists
  // to own the terminal status.
  const hasProcessBlock = contentBlocks.some((block) => block.kind === 'process');
  const statusOwnedElsewhere = responseItem === null && hasProcessBlock;
  const editUserMessage = useCallback(
    (content: readonly ThreadUserContent[]) => onEditUserMessage(turnRef.current, content),
    [onEditUserMessage, turn.id],
  );
  const continueInNewChat = useCallback(
    () => onContinueInNewChat(turnRef.current),
    [onContinueInNewChat, turn.id],
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
      turnRef.current,
      readToolArguments,
      readToolOutput,
      t.agent.thread.resourceLimitReached,
    );
    if (text) await navigator.clipboard.writeText(text);
  }, [readToolArguments, readToolOutput, t.agent.thread.resourceLimitReached, turn.id]);
  const openTurnDetails = useCallback(
    () => onOpenTurnDetails(turnRef.current),
    [onOpenTurnDetails, turn.id],
  );
  const handleResponseContextMenu = useCallback(async (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const canContinueInNewChat = !agentTranscript;
    const currentTurn = turnRef.current;
    const action = await window.lin?.showThreadMessageContextMenu?.({
      canCopy: hasTurnCopyContent(currentTurn),
      canContinueInNewChat,
      canShowDetails: true,
    });
    if (action === 'copy') await copyTurn();
    else if (action === 'continueInNewChat') await continueInNewChat();
    else if (action === 'details') openTurnDetails();
  }, [agentTranscript, continueInNewChat, copyTurn, openTurnDetails, turn.id]);
  const recoveryCandidate = !agentTranscript
    && composerEnabled
    && isLastTurn
    && (turn.status === 'failed' || turn.status === 'interrupted');
  const [recovery, setRecovery] = useState<TurnRecoveryReadResponse | null>(null);
  const readTurnRecoveryRef = useRef(onReadTurnRecovery);
  readTurnRecoveryRef.current = onReadTurnRecovery;
  useEffect(() => {
    if (!recoveryCandidate) {
      setRecovery(null);
      return;
    }
    let current = true;
    setRecovery(null);
    void readTurnRecoveryRef.current(turnRef.current)
      .then((value) => { if (current) setRecovery(value); })
      .catch(() => { if (current) setRecovery({ canContinue: false, canRerun: false, rerunRequiresConfirmation: false }); });
    return () => { current = false; };
  }, [recoveryCandidate, turn.id, turn.status]);
  const continueTurn = useCallback(
    () => onContinueTurn(turnRef.current),
    [onContinueTurn, turn.id],
  );
  const rerunTurn = useCallback(
    (confirmToolReplay: boolean) => onRerunTurn(turnRef.current, confirmToolReplay),
    [onRerunTurn, turn.id],
  );
  const responseTail = useMemo(
    () => standaloneContextBoundary || (responseTailTurn.status === 'inProgress' && !providerRetry && !hasResponse) ? null : (
      <ThreadResponseTail
        canContinueInNewChat={!agentTranscript}
        onCopy={copyTurn}
        onContinueInNewChat={continueInNewChat}
        onContinue={recovery?.canContinue ? continueTurn : null}
        onOpenDetails={openTurnDetails}
        onRerun={recovery?.canRerun ? rerunTurn : null}
        rerunRequiresConfirmation={recovery?.rerunRequiresConfirmation ?? false}
        providerRetry={providerRetry}
        // The process divider states the terminal status when there is no
        // response Item — but only if a process block renders at all. Without
        // one, suppressing it here would erase the status from the Turn.
        statusOwnedElsewhere={statusOwnedElsewhere}
        turn={responseTailTurn}
      />
    ),
    [
      continueInNewChat,
      continueTurn,
      copyTurn,
      hasResponse,
      openTurnDetails,
      providerRetry,
      responseTailTurn,
      recovery,
      rerunTurn,
      standaloneContextBoundary,
      statusOwnedElsewhere,
    ],
  );
  const visibleItemReplacement = delivery !== null
    && reportEntry !== null
    && deliveryNoticeItemId !== null
    ? { delivery, itemId: deliveryNoticeItemId }
    : null;
  const itemHasVisibleReplacement = (item: ThreadItem): boolean => (
    item.id === visibleItemReplacement?.itemId
  );
  const renderItem = (item: ThreadItem, showMessageActions: boolean) => (
    // The host's own notification text is not a message to the reader. Where
    // this Turn exists because an Agent's result arrived, the Agent's own
    // report replaces it — folded, as a message from that Agent — instead of
    // the wall of task-notification framing addressed to the model.
    visibleItemReplacement !== null && item.id === visibleItemReplacement.itemId ? (
      <SubagentReport
        delivery={visibleItemReplacement.delivery}
        index={index}
        key={item.id}
        onOpenNodeReference={onOpenNodeReference}
      />
    ) : (
      <ThreadItemView
        agentResponseTail={item.id === responseItem?.id ? responseTail : null}
        canEditUserMessage={canEditUserMessage && showMessageActions}
        defaultReasoningExpanded={reasoningExpandedByDefault(turn, item)}
        expandState={expandState}
        getUserView={getUserView}
        index={index}
        indexStore={indexStore}
        item={item}
        key={item.id}
        onAgentMessageContextMenu={item.id === responseItem?.id ? handleResponseContextMenu : undefined}
        onEditUserMessage={editUserMessage}
        onInterruptThread={onInterruptThread}
        onOpenNodeReference={onOpenNodeReference}
        onOpenTurnDetails={standaloneContextBoundary ? openTurnDetails : undefined}
        onOpenThread={onOpenThread}
        onOpenThreadReference={onOpenThreadReference}
        onReadToolArguments={readToolArguments}
        onReadToolOutput={readToolOutput}
        showMessageActions={showMessageActions}
        streaming={turn.status === 'inProgress' && turn.items.at(-1)?.id === item.id}
        {...(anchors.anchorByItemId.has(item.id)
          ? { anchor: anchors.anchorByItemId.get(item.id)! }
          : {})}
        threadId={threadId}
        threadReferences={threadReferences}
        threadCwd={threadCwd}
        active={active}
        workingTextEnabled={anchors.anchorByItemId.has(item.id)
          ? workingTextEnabled && processView.timelineVisible && !activeTool
          : leafWorkingEnabled && (!activeTool || activeTool.id === item.id)}
      />
    )
  );
  // Who says each block, so consecutive blocks from one participant sit under
  // one header. Three speakers can appear in a single Turn: the reader (their
  // own message), a child delivering a result, and this transcript's own agent
  // reading that result and answering.
  //
  // A delivery whose Agent is no longer in the registry falls back to its
  // canonical Item under the neutral event speaker. The report cannot resolve,
  // but the accepted provider input remains durable transcript history.
  // The Turn's own state, on the face that owns the Turn. Live work reads as
  // working (or needs-you while an input request blocks it); a failure stays a
  // failure — the header is the honest record of how that Turn went, the same
  // truth the status text beside it tells. A user interrupt sleeps: the reader
  // ended it, and it will not stir until they do.
  const selfMood: MarkMood = turn.status === 'inProgress'
    ? (waitingOnUserInput ? 'needsYou' : 'working')
    : turn.status === 'failed' ? 'failed'
      : turn.status === 'interrupted' ? 'stopped'
        : 'idle';
  const moodedSelf: ThreadSpeaker = { ...selfSpeaker, mood: selfMood };
  const neutralEventSpeaker: ThreadSpeaker = {
    participantId: UNATTRIBUTED_PARTICIPANT_ID,
    avatarKey: '',
    name: t.agent.thread.agentEvent,
  };
  const speakerOf = (block: ThreadContentBlock): ThreadSpeaker | null => {
    if (block.kind === 'process') return moodedSelf;
    if (block.item.type !== 'userMessage') return moodedSelf;
    if (block.item.id === deliveryNoticeItemId && reportSpeaker !== null) return reportSpeaker;
    if (isReaderAuthoredUserMessage(block.item)) return null;
    if (block.item.author.kind !== 'agent') return neutralEventSpeaker;
    if (block.item.author.threadId === rootThreadId) return rootSpeaker;
    const entry = agentEntries.get(block.item.author.threadId);
    if (!entry) return neutralEventSpeaker;
    const name = subagentSpeakerName(entry);
    return { participantId: entry.agentId, avatarKey: name, name };
  };
  const runs: Array<{
    readonly speaker: ThreadSpeaker | null;
    readonly nodes: ReactNode[];
    meta?: ReactNode;
  }> = [];
  const emit = (speaker: ThreadSpeaker | null, node: ReactNode): void => {
    const open = runs.at(-1);
    if (open && open.speaker?.participantId === speaker?.participantId) open.nodes.push(node);
    else runs.push({ speaker, nodes: [node] });
  };
  for (const block of contentBlocks) {
    // A block that draws nothing must not open a speaker run either: a delivery
    // Turn starts with a settled activity Item and three `contextEvidence`
    // rows, which put a named `main` over an empty box before the child that
    // actually spoke.
    if (
      block.kind === 'item'
      && !itemHasVisibleReplacement(block.item)
      && threadItemRendersNothing(
        block.item,
        anchors.anchorByItemId.has(block.item.id),
      )
    ) continue;
    const speaker = speakerOf(block);
    if (block.kind === 'process') {
      // The summary goes on this speaker's own line; only the rows stay here.
      emit(speaker, processView.timelineVisible ? (
        <div
          className={`thread-process-block${processView.isError ? ' is-error' : ''}`}
          key={`process:${block.items[0]?.id ?? turn.id}`}
        >
          <div className="thread-process-timeline">
            {processItemGroups.map((group) => group.kind === 'tools' ? (
              <ThreadToolActivityGroup
                expandState={expandState}
                index={index}
                items={group.items}
                key={group.items[0]?.id}
                onOpenThread={onOpenThread}
                onReadToolArguments={readToolArguments}
                onReadToolOutput={readToolOutput}
                threadId={threadId}
                threadCwd={threadCwd}
                workingTextEnabled={leafWorkingEnabled && group.items.some((item) => item.id === activeTool?.id)}
              />
            ) : renderItem(group.item, false))}
          </div>
        </div>
      ) : null);
      const open = runs.at(-1);
      if (open) open.meta = processView.header;
      continue;
    }
    emit(speaker, renderItem(
      block.item,
      turn.status !== 'inProgress' && block.item.type === 'userMessage',
    ));
    if (speaker !== null && speaker === reportSpeaker) {
      const open = runs.at(-1);
      if (open) open.meta = reportMeta;
    }
  }
  if (responseItem === null && responseTail) {
    emit(moodedSelf, (
      <article
        className="thread-item thread-agent-message thread-agent-message-response"
        key={`tail:${turn.id}`}
        onContextMenu={turn.status === 'inProgress' ? undefined : handleResponseContextMenu}
      >
        {responseTail}
      </article>
    ));
  }
  return (
    <section className={`thread-turn thread-turn-${turn.status}`}>
      {runs.map((run, runIndex) => run.speaker === null ? run.nodes : (
        <ThreadSpeakerGroup
          key={`speaker:${turn.id}:${runIndex}`}
          {...(run.meta === undefined ? {} : { meta: run.meta })}
          speaker={run.speaker}
          threadId={threadId}
        >
          {run.nodes}
        </ThreadSpeakerGroup>
      ))}
    </section>
  );
});

const threadItemDocumentNodeIdsCache = new WeakMap<ThreadItem, readonly NodeId[]>();

export function threadDocumentNodeIds(turn: Turn): readonly NodeId[] {
  const nodeIds = new Set<NodeId>();
  for (const item of turn.items) {
    for (const nodeId of threadItemDocumentNodeIds(item)) nodeIds.add(nodeId);
  }
  return [...nodeIds];
}

function threadItemDocumentNodeIds(item: ThreadItem): readonly NodeId[] {
  const cached = threadItemDocumentNodeIdsCache.get(item);
  if (cached) return cached;
  const nodeIds = new Set<NodeId>();
  const addMarkdownReferences = (text: string) => {
    for (const reference of parseNodeReferenceMarkers(text)) nodeIds.add(reference.nodeId);
  };
  if (item.type === 'userMessage') {
    for (const content of item.content) {
      if (content.type === 'nodeReference') nodeIds.add(content.nodeId);
    }
  } else if (item.type === 'agentMessage') {
    addMarkdownReferences(item.text);
  } else if (item.type === 'reasoning') {
    for (const part of item.summary) addMarkdownReferences(part);
    for (const part of item.content) addMarkdownReferences(part);
  }
  const result = [...nodeIds];
  threadItemDocumentNodeIdsCache.set(item, result);
  return result;
}

function sameResponseTailTurn(left: Turn, right: Turn): boolean {
  return left.id === right.id
    && left.status === right.status
    && left.error === right.error
    && left.execution === right.execution
    && left.startedAt === right.startedAt
    && left.completedAt === right.completedAt
    && left.durationMs === right.durationMs;
}

function isStandaloneContextBoundaryTurn(turn: Turn): boolean {
  if (turn.items.length !== 1 || turn.provenance.trigger.kind !== 'feature') return false;
  const item = turn.items[0];
  return (turn.provenance.trigger.feature === 'context.clear' && item?.type === 'contextReset')
    || (turn.provenance.trigger.feature === 'context.compact' && item?.type === 'contextCompaction');
}

function ThreadResponseTail({
  canContinueInNewChat,
  onCopy,
  onContinue,
  onContinueInNewChat,
  onOpenDetails,
  onRerun,
  providerRetry,
  rerunRequiresConfirmation,
  statusOwnedElsewhere,
  turn,
}: {
  /**
   * Forking a Thread starts a conversation, which a read-only embedded view
   * cannot do. Hidden rather than disabled: a control that never works is not a
   * control, and the row keeps its height from the actions that remain.
   */
  readonly canContinueInNewChat: boolean;
  readonly onCopy: () => Promise<void>;
  readonly onContinue: (() => Promise<void>) | null;
  readonly onContinueInNewChat: () => Promise<void>;
  readonly onOpenDetails: () => void;
  readonly onRerun: ((confirmToolReplay: boolean) => Promise<void>) | null;
  readonly providerRetry: ProviderRetryStatus | null;
  readonly rerunRequiresConfirmation: boolean;
  readonly statusOwnedElsewhere: boolean;
  readonly turn: Turn;
}) {
  const t = useT();
  const [trajectoryHoverOpen, setTrajectoryHoverOpen] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [confirmingRerun, setConfirmingRerun] = useState(false);
  const trajectoryButtonRef = useRef<HTMLButtonElement | null>(null);
  const streaming = turn.status === 'inProgress';
  const interrupted = turn.status === 'interrupted' && !statusOwnedElsewhere;
  const errorText = turn.error
    ? userFacingAgentError(turn.error, t.agent.thread.resourceLimitReached)
    : '';
  const runRecovery = (action: () => Promise<void>) => {
    if (recoveryPending) return;
    setRecoveryPending(true);
    setRecoveryError(null);
    void action()
      .catch((error: unknown) => setRecoveryError(errorMessage(error)))
      .finally(() => setRecoveryPending(false));
  };
  return (
    <>
      {!streaming && errorText ? (
        <div className="thread-response-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{errorText}</span>
        </div>
      ) : null}
      {recoveryError ? (
        <div className="thread-response-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{recoveryError}</span>
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
          providerRetry ? <ThreadProviderRetryStatus status={providerRetry} /> : null
        ) : (
          <div className="thread-message-actions thread-response-actions">
            {onContinue ? (
              <IconButton
                disabled={recoveryPending}
                icon={PlayIcon}
                iconSize={ICON_SIZE.menu}
                label={t.agent.thread.continueFromFailure}
                onClick={() => runRecovery(onContinue)}
                variant="message"
              />
            ) : null}
            {onRerun ? (
              <IconButton
                disabled={recoveryPending}
                icon={RefreshIcon}
                iconSize={ICON_SIZE.menu}
                label={t.agent.thread.rerunTurn}
                // Latched while main admits and atomically replaces this latest
                // Turn. A second request in that window can only race the same
                // identity and return a stale-target failure.
                onClick={() => {
                  if (rerunRequiresConfirmation) setConfirmingRerun(true);
                  else runRecovery(() => onRerun(false));
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
                label={t.agent.message.openTrajectory}
                onBlur={() => setTrajectoryHoverOpen(false)}
                onClick={(event) => {
                  setTrajectoryHoverOpen(false);
                  event.currentTarget.blur();
                  onOpenDetails();
                }}
                onFocus={() => setTrajectoryHoverOpen(true)}
                onMouseEnter={() => setTrajectoryHoverOpen(true)}
                onMouseLeave={() => setTrajectoryHoverOpen(false)}
                ref={trajectoryButtonRef}
                title=""
                variant="message"
              />
              {trajectoryHoverOpen ? (
                <ThreadTrajectoryHoverCard anchorRef={trajectoryButtonRef} turn={turn} />
              ) : null}
            </span>
          </div>
        )}
      </div>
      {confirmingRerun && onRerun ? (
        <ConfirmDialog
          confirmLabel={t.agent.thread.rerunTurn}
          message={t.agent.thread.rerunConfirmMessage}
          onCancel={() => setConfirmingRerun(false)}
          onConfirm={() => {
            setConfirmingRerun(false);
            runRecovery(() => onRerun(true));
          }}
          title={t.agent.thread.rerunConfirmTitle}
        />
      ) : null}
    </>
  );
}

function ThreadTrajectoryHoverCard({
  anchorRef,
  turn,
}: {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly turn: Turn;
}) {
  const t = useT();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const facts = trajectoryHoverFacts(turn, t);
  const style = useAnchoredOverlay(cardRef, {
    anchorRef,
    gap: 8,
    layoutKey: `${turn.completedAt ?? turn.startedAt}:${turn.id}`,
    maxHeight: 160,
    placement: 'top-end',
    width: 'content',
  });
  return createPortal(
    <div className="thread-response-trajectory-card" ref={cardRef} role="tooltip" style={style}>
      <div className="thread-response-trajectory-title">{t.agent.message.openTrajectory}</div>
      {facts.length > 0 ? (
        <div className="thread-response-trajectory-facts">
          {facts.map((fact) => <span className="thread-response-trajectory-fact" key={fact}>{fact}</span>)}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

export function trajectoryHoverFacts(turn: Turn, t: Messages): readonly string[] {
  const facts: string[] = [];
  const totalTokens = turn.execution.usage.totalTokens;
  if (totalTokens > 0) {
    facts.push(t.agent.message.openTrajectoryTokenCount({ tokens: formatHoverInteger(totalTokens) }));
  }
  const cost = turn.execution.usage.cost;
  if (cost && cost.total > 0) {
    facts.push(t.agent.message.openTrajectoryCost({ cost: formatHoverUsd(cost.total) }));
  }
  return facts;
}

function formatHoverInteger(value: number): string {
  return formatNumber(Math.max(0, Math.round(value)), 'en-US');
}

function formatHoverUsd(value: number): string {
  const bounded = Math.max(0, value);
  if (bounded > 0 && bounded < 0.000001) return '<$0.000001';
  if (bounded >= 1) return `$${bounded.toFixed(2)}`;
  const [, fraction = ''] = bounded.toFixed(6).split('.');
  const trimmed = fraction.replace(/0+$/u, '').padEnd(2, '0');
  return `$0.${trimmed}`;
}

function ThreadProviderRetryStatus({ status }: { readonly status: ProviderRetryStatus }) {
  const t = useT();
  const label = providerRetryLabel(status, t.agent.thread);
  return (
    <div aria-hidden className="thread-provider-retry">
      <LoaderIcon aria-hidden size={ICON_SIZE.tiny} />
      <span>{label}</span>
    </div>
  );
}

function ThreadProviderRetryAnnouncement({ status }: { readonly status: ProviderRetryStatus }) {
  const t = useT();
  const label = providerRetryLabel(status, t.agent.thread);
  return (
    <span
      aria-atomic="true"
      aria-live="polite"
      className="thread-provider-retry-announcer thread-visually-hidden"
      role="status"
    >
      {label}
    </span>
  );
}

function providerRetryLabel(
  status: ProviderRetryStatus,
  messages: ReturnType<typeof useT>['agent']['thread'],
): string {
  const input = { attempt: status.attempt, maxRetries: status.maxRetries };
  return status.kind === 'request' ? messages.retrying(input) : messages.reconnecting(input);
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
}: {
  /** Where focus goes when the checklist closes. Absent on a Thread with no
   *  composer, where it returns to the pill instead. */
  readonly onClosed?: () => void;
  readonly plan: ActiveTurnPlan;
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
        <span className="thread-plan-progress-label">{label}</span>
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
      if (source.storage === 'itemBound') {
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
    if (turn?.items.some(isReaderAuthoredUserMessage)) return turn.id;
  }
  return null;
}

function conversationRootThreadId(
  threadId: ThreadId,
  threadsById: ReadonlyMap<ThreadId, Thread>,
  agentEntries: ReadonlyMap<ThreadId, SubagentRegistryEntry>,
): ThreadId {
  const visited = new Set<ThreadId>();
  let current = threadId;
  while (!visited.has(current)) {
    visited.add(current);
    const parentThreadId = threadsById.get(current)?.parentThreadId
      ?? agentEntries.get(current)?.parentThreadId
      ?? null;
    if (parentThreadId === null) return current;
    current = parentThreadId;
  }
  return threadId;
}

/**
 * A Turn's work, split into the two places it is shown.
 *
 * `header` rides the speaker's own line — who spoke and what they did is one
 * sentence, so it is one line, and clicking it is the single way to open the
 * timeline. It used to be a summary line, a rule, and sometimes a second
 * summary line, all under a separate name row; four elements saying one thing.
 * `timeline` is the rows themselves, below.
 */
function useThreadProcessView({
  expandState,
  hasFinalResponse,
  index,
  items,
  anchors,
  turn,
  waitingOnUserInput,
  workingTextEnabled,
}: {
  readonly expandState: ThreadDisclosureState;
  readonly hasFinalResponse: boolean;
  readonly index: DocumentIndex;
  readonly items: readonly ThreadItem[];
  readonly anchors: SubagentTurnAnchors;
  readonly turn: Turn;
  readonly waitingOnUserInput: boolean;
  readonly workingTextEnabled: boolean;
}): {
  readonly header: ReactNode;
  readonly timelineVisible: boolean;
  readonly isError: boolean;
  readonly motionOwner: TurnMotionOwner;
} {
  const expanded = expandState.isExpanded(`process:${turn.id}`, turn.status === 'inProgress');
  const workingAgentIds = useWorkingAgentIds();
  // A Turn can settle while a child it spawned keeps running — the
  // fire-and-forget shape the protocol supports, where terminal activity lands
  // in a LATER Turn. The fold defaults to closed, so folding here would hide a
  // live delegation's status, its elapsed time, and the only Stop that reaches
  // it. Work that is still happening and still stoppable is not history yet.
  const completedCollapsible = turn.status === 'completed'
    && hasFinalResponse
    && turn.durationMs !== null
    && !anchors.agentIds.some((agentId) => workingAgentIds.has(agentId));
  const collapsible = items.length > 0 && (turn.status === 'inProgress' || completedCollapsible);
  const terminalResponseOwnsStatus = hasFinalResponse
    && (turn.status === 'failed' || turn.status === 'interrupted');
  const timelineVisible = items.length > 0 && (!collapsible || expanded);
  const motionOwner = turnMotionOwner(turn, items, anchors, workingAgentIds, timelineVisible);
  // The clock lives in the SUMMARY, not here. Read at this level it ticked the
  // whole Turn once a second — regrouping its content blocks, rebuilding every
  // speaker run, re-rendering every Item and every report card — to repaint one
  // line of text. This is the same reason `subagentElapsed.ts` pushes a child's
  // clock down to the row that displays it.
  return {
    header: terminalResponseOwnsStatus && !timelineVisible ? null : (
      <ThreadProcessSummary
        collapsible={collapsible}
        expandState={expandState}
        expanded={expanded}
        hasFinalResponse={hasFinalResponse}
        index={index}
        items={items}
        motionOwner={motionOwner}
        terminalResponseOwnsStatus={terminalResponseOwnsStatus}
        turn={turn}
        waitingOnUserInput={waitingOnUserInput}
        workingTextEnabled={workingTextEnabled}
      />
    ),
    timelineVisible,
    motionOwner,
    isError: turn.status === 'failed' && !hasFinalResponse,
  };
}

/**
 * What a participant did, on their own header line — and the only thing in the
 * Turn that a live clock re-renders.
 */
function ThreadProcessSummary({
  collapsible,
  expandState,
  expanded,
  hasFinalResponse,
  index,
  items,
  motionOwner,
  terminalResponseOwnsStatus,
  turn,
  waitingOnUserInput,
  workingTextEnabled,
}: {
  readonly collapsible: boolean;
  readonly expandState: ThreadDisclosureState;
  readonly expanded: boolean;
  readonly hasFinalResponse: boolean;
  readonly index: DocumentIndex;
  readonly items: readonly ThreadItem[];
  readonly motionOwner: TurnMotionOwner;
  readonly terminalResponseOwnsStatus: boolean;
  readonly turn: Turn;
  readonly waitingOnUserInput: boolean;
  readonly workingTextEnabled: boolean;
}) {
  const t = useT();
  const disclosureId = `process:${turn.id}`;
  const blockedOnUser = turn.status === 'inProgress' && waitingOnUserInput;
  const liveElapsedMs = useTurnElapsedMs(turn);
  // The response tail owns the terminal status, but the timeline below still
  // needs a name — otherwise it is an unlabelled list of rows.
  if (terminalResponseOwnsStatus) {
    return (
      <div className="thread-speaker-meta">
        <span className="thread-process-title">
          {turn.durationMs !== null
            ? t.agent.thread.workedFor({ duration: formatProcessDuration(turn.durationMs) })
            : threadProcessNeutralHeader(turn, items, t, index)}
        </span>
      </div>
    );
  }
  const summary = threadProcessSummary(
    turn, items, hasFinalResponse, liveElapsedMs, t, index, blockedOnUser,
  );
  const processTitleClassName = `thread-process-title${turn.status === 'inProgress'
    ? ' thread-process-title-live'
    : ''}`;
  const title = motionOwner === 'summary' && !blockedOnUser && workingTextEnabled
    ? <WorkingText className={processTitleClassName} text={summary} truncate />
    : <span className={processTitleClassName}>{summary}</span>;
  if (collapsible) {
    return (
      <ButtonControl
        aria-expanded={expanded}
        className={`thread-speaker-meta thread-process-toggle${turn.status === 'inProgress' ? ' is-live' : ''}`}
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => expandState.toggle(disclosureId, expanded, event.currentTarget)}
      >
        {title}
        <ChevronRightIcon
          aria-hidden
          className={`thread-process-chevron${expanded ? ' is-expanded' : ''}`}
          size={ICON_SIZE.menu}
 />
      </ButtonControl>
    );
  }
  return (
    <div className="thread-speaker-meta">
      {title}
    </div>
  );
}

export type TurnMotionOwner = 'none' | 'summary' | 'leaf';

export function turnMotionOwner(
  turn: Turn,
  items: readonly ThreadItem[],
  anchors: SubagentTurnAnchors,
  workingAgentIds: ReadonlySet<ThreadId>,
  timelineVisible = true,
): TurnMotionOwner {
  if (turn.status !== 'inProgress') return 'none';
  const tail = turn.items.at(-1);
  if (tail?.type === 'agentMessage' && tail.phase === 'final_answer' && tail.text.trim()) return 'none';
  if (!timelineVisible) return 'summary';
  if (items.some((item) => isThreadToolItem(item) && item.status === 'inProgress')) return 'leaf';
  // A live chip in this Turn is the more specific representation, so the Turn
  // summary stays static while the chip carries the cue.
  if (anchors.agentIds.some((agentId) => workingAgentIds.has(agentId))) return 'leaf';
  if (tail?.type === 'reasoning') {
    return [...tail.summary, ...tail.content].every((part) => !part.trim()) ? 'leaf' : 'none';
  }
  return 'none';
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

const EMPTY_THREAD_ITEMS: readonly ThreadItem[] = [];

export interface TurnContentGrouper {
  group(turn: Turn): readonly ThreadContentBlock[];
  reset(): void;
}

export function createTurnContentGrouper(): TurnContentGrouper {
  let previous: { readonly blocks: readonly ThreadContentBlock[]; readonly turn: Turn } | null = null;
  return {
    group(turn) {
      const blocks = previous
        ? updateGroupedTurnContent(previous.turn, previous.blocks, turn)
        : groupTurnContent(turn);
      previous = { blocks, turn };
      return blocks;
    },
    reset() {
      previous = null;
    },
  };
}

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

type ThreadContentRole = 'final' | 'hidden' | 'item' | 'process';

function updateGroupedTurnContent(
  previousTurn: Turn,
  previousBlocks: readonly ThreadContentBlock[],
  turn: Turn,
): readonly ThreadContentBlock[] {
  if (previousTurn.id !== turn.id || previousTurn.items.length !== turn.items.length) {
    return reuseGroupedBlocks(previousBlocks, groupTurnContent(turn));
  }

  const previousRoles = previousTurn.items.map(threadContentRole);
  const nextRoles = turn.items.map(threadContentRole);
  const structureChanged = previousRoles.some((role, index) => role !== nextRoles[index])
    || needsProcessBlock(previousTurn, previousRoles) !== needsProcessBlock(turn, nextRoles);
  if (structureChanged) return reuseGroupedBlocks(previousBlocks, groupTurnContent(turn));

  const replacements = new Map<ThreadItem, ThreadItem>();
  let processChanged = false;
  for (let index = 0; index < turn.items.length; index += 1) {
    const previousItem = previousTurn.items[index]!;
    const nextItem = turn.items[index]!;
    if (previousItem === nextItem) continue;
    replacements.set(previousItem, nextItem);
    if (nextRoles[index] === 'process') processChanged = true;
  }
  if (replacements.size === 0) return previousBlocks;

  let blockChanged = false;
  const nextProcessItems = processChanged ? turn.items.filter(isThreadProcessItem) : null;
  const blocks = previousBlocks.map((block): ThreadContentBlock => {
    if (block.kind === 'process') {
      if (!nextProcessItems) return block;
      blockChanged = true;
      return { kind: 'process', items: nextProcessItems };
    }
    const replacement = replacements.get(block.item);
    if (!replacement) return block;
    blockChanged = true;
    return { kind: 'item', item: replacement };
  });
  return blockChanged ? blocks : previousBlocks;
}

function reuseGroupedBlocks(
  previous: readonly ThreadContentBlock[],
  next: readonly ThreadContentBlock[],
): readonly ThreadContentBlock[] {
  const previousProcess = previous.find((block) => block.kind === 'process');
  const reused = next.map((block): ThreadContentBlock => {
    if (block.kind === 'item') {
      return previous.find((candidate) => candidate.kind === 'item' && candidate.item === block.item) ?? block;
    }
    return previousProcess?.kind === 'process'
      && equalItemSequence(previousProcess.items, block.items)
      ? previousProcess
      : block;
  });
  return equalItemSequence(previous, reused) ? previous : reused;
}

function equalItemSequence<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function threadContentRole(item: ThreadItem): ThreadContentRole {
  if (isThreadProcessItem(item)) return 'process';
  if (isEmptyCommentaryItem(item)) return 'hidden';
  return isFinalResponseItem(item) ? 'final' : 'item';
}

function needsProcessBlock(turn: Turn, roles: readonly ThreadContentRole[]): boolean {
  return roles.includes('process')
    || turn.status === 'inProgress'
    || (turn.status === 'completed' && roles.includes('final') && turn.durationMs !== null);
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
    ...(file.thumbnailDataUrl ? { previewUrl: file.thumbnailDataUrl } : {}),
    reference: attachmentToComposerReference(content, file),
    sourceKey: `path:${file.path}`,
  };
}

async function attachmentFromBrowserFile(
  file: File,
  threadId: string,
  signal: AbortSignal,
  attachmentId?: string,
): Promise<PreparedComposerAttachment> {
  throwIfAttachmentUploadAborted(signal);
  const name = file.name || 'attachment';
  const mimeType = file.type || 'application/octet-stream';
  const id = attachmentId ?? crypto.randomUUID();
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
      source: { kind: 'resource', ref },
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
    sourceKey: nativePath ? `path:${nativePath}` : `payload:${content.source.kind === 'resource' ? content.source.ref.id : id}`,
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
    if (seen.has(attachment.id)) return false;
    seen.add(attachment.id);
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
  return left.source.kind === 'resource'
    && right.source.kind === 'resource'
    && left.source.ref.id === right.source.ref.id
    && left.source.ref.fileName === right.source.ref.fileName;
}

function discardManagedAttachment(threadId: string, attachment: ThreadAttachmentContent): void {
  if (attachment.source.kind !== 'resource') return;
  discardManagedResourceHandle(threadId, attachment.source.ref);
}

function discardManagedResourceHandle(threadId: string, handle: ThreadResourceReference): void {
  if (!window.lin?.discardAttachmentResource) return;
  void window.lin.discardAttachmentResource({ threadId, ref: handle }).catch(() => undefined);
}

function discardPreparedAttachment(threadId: string, attachment: PreparedComposerAttachment): void {
  discardManagedAttachment(threadId, attachment.content);
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

function duplicateAttachmentMessage(count: number, labels: Messages['agent']['composer']): string | null {
  return count > 0 ? labels.skippedDuplicates({ count }) : null;
}

function overflowAttachmentMessage(count: number, labels: Messages['agent']['composer']): string | null {
  return count > 0 ? labels.skippedOverflow({ count, max: MAX_COMPOSER_ATTACHMENTS }) : null;
}

function imageOverflowAttachmentMessage(count: number, labels: Messages['agent']['composer']): string | null {
  return count > 0 ? labels.skippedImageOverflow({ count, max: MAX_COMPOSER_IMAGE_ATTACHMENTS }) : null;
}

function composerAttachmentCount(
  attachments: readonly ThreadAttachmentContent[],
  pending: ReadonlyMap<string, PendingComposerPasteRequest>,
): number {
  return attachments.length + pending.size;
}

function fullyReplacedAttachmentIds(
  draft: ThreadComposerDraft,
  selectedAttachmentIds: readonly string[],
): Set<string> {
  const draftCounts = new Map<string, number>();
  const selectedCounts = new Map<string, number>();
  for (const reference of draft.fileRefs) {
    draftCounts.set(reference.attachmentId, (draftCounts.get(reference.attachmentId) ?? 0) + 1);
  }
  for (const attachmentId of selectedAttachmentIds) {
    selectedCounts.set(attachmentId, (selectedCounts.get(attachmentId) ?? 0) + 1);
  }
  return new Set(Array.from(selectedCounts).flatMap(([attachmentId, selectedCount]) => (
    selectedCount >= (draftCounts.get(attachmentId) ?? Number.POSITIVE_INFINITY)
      ? [attachmentId]
      : []
  )));
}

function countImageAttachments(attachments: readonly ThreadAttachmentContent[]): number {
  return attachments.reduce((count, attachment) => count + Number(isImageMimeType(attachment.mimeType)), 0);
}

function countImagePreparedAttachments(attachments: readonly PreparedComposerAttachment[]): number {
  return attachments.reduce((count, attachment) => (
    count + Number(isImageMimeType(attachment.content.mimeType))
  ), 0);
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('image/');
}

function pastedTextFileName(ordinal: number): string {
  return ordinal <= 1 ? 'Pasted.txt' : `Pasted-${ordinal}.txt`;
}

function pastedTextExcerpt(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 256);
}

function composerHistoryBundleFromContent(
  content: readonly ThreadUserContent[],
  index: DocumentIndex,
  canonicalPreviewFor: (attachmentId: string) => string | undefined,
  threadReferences: ReadonlyMap<string, ThreadReferenceView>,
): ComposerHistoryBundle {
  const attachments: ThreadAttachmentContent[] = [];
  const uiState: ComposerAttachmentUiState[] = [];
  const draftContent = content.map((part): ThreadComposerDraftContent => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'nodeReference') {
      const currentLabel = textOf(index.byId.get(part.nodeId)).trim();
      return {
        type: 'nodeReference',
        reference: {
          nodeId: part.nodeId,
          title: currentLabel || part.note || 'Referenced node',
        },
      };
    }
    if (part.type === 'threadReference') {
      return {
        type: 'threadReference',
        reference: {
          threadId: part.threadId,
          title: threadReferences.get(part.threadId)?.title ?? '',
        },
      };
    }
    const canonicalAttachmentId = part.id;
    const attachment: ThreadAttachmentContent = { ...part, id: crypto.randomUUID() };
    const previewUrl = canonicalPreviewFor(canonicalAttachmentId);
    attachments.push(attachment);
    if (previewUrl) uiState.push({ attachmentId: attachment.id, previewUrl });
    return {
      type: 'fileReference',
      reference: attachmentToComposerReference(
        attachment,
        previewUrl ? { thumbnailDataUrl: previewUrl } : undefined,
      ),
    };
  });
  return { attachments, content: draftContent, snapshot: null, uiState };
}

function threadReferenceIdsFromTurns(turns: readonly Turn[]): string[] {
  const threadIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === 'userMessage') {
        for (const content of item.content) {
          if (content.type === 'threadReference') threadIds.add(content.threadId);
          if (content.type === 'text' && content.text.includes('[[thread://')) {
            for (const marker of parseThreadReferenceMarkers(content.text)) threadIds.add(marker.threadId);
          }
        }
      }
      if (item.type === 'agentMessage' && item.text.includes('[[thread://')) {
        for (const marker of parseThreadReferenceMarkers(item.text)) threadIds.add(marker.threadId);
      }
    }
  }
  return [...threadIds];
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

function canonicalThreadAttachmentIds(turns: readonly Turn[]): Set<string> {
  const attachmentIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') continue;
      for (const content of item.content) {
        if (content.type === 'attachment') attachmentIds.add(content.id);
      }
    }
  }
  return attachmentIds;
}

function composerHistoryItemSlot(itemId: string): string {
  return `item:${itemId}`;
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
    if (part.type === 'threadReference') {
      return [{ type: 'threadReference', threadId: part.reference.threadId }];
    }
    if (part.type === 'pendingFileReference') return [];
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
