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
  MAX_INLINE_IMAGE_BASE64_CHARS,
  MAX_RAW_INLINE_IMAGE_BYTES,
  MAX_STAGED_ATTACHMENT_BYTES,
} from '../../../core/agentAttachmentLimits';
import type { Messages } from '../../../core/i18n';
import type {
  RequestUserInputAnswer,
  RequestUserInputRequest,
  ProviderRetryStatus,
  ThreadAttachmentContent,
  ThreadConfigurationSummary,
  ThreadItem,
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
  isCompactLoadedSkillItem,
  isThreadToolItem,
  summarizeThreadToolActivity,
  summarizeThreadToolItem,
  ThreadItemView,
  ThreadMessageCopyButton,
  ThreadToolActivityGroup,
  type ThreadDisclosureState,
  type ThreadToolItem,
} from './items/ThreadItemView';
import { threadErrorMessage } from '../threadErrorMessage';
import {
  setThreadDisclosureOverride,
  subscribeThreadDisclosure,
  threadDisclosureSnapshot,
} from '../store/threadDisclosureStore';
import type { ThreadNodeReferenceOpenHandler } from '../threadReferences';
import {
  captureDisclosureScrollAnchor,
  nearestScrollContainer,
  usePendingDisclosureAnchor,
} from '../../ui/interactions/disclosureScrollAnchor';
import { formatDateTime, formatNumber } from '../../ui/formatting';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';

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
  readonly threadId: string;
  readonly turns: readonly Turn[];
  readonly inputRequest: RequestUserInputRequest | null;
  readonly providerRetry: { readonly turnId: string; readonly status: ProviderRetryStatus } | null;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onContinueInNewChat: (turn: Turn) => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onConfigurationChange: (configuration: ThreadConfigurationSummary) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onReadToolOutput: (turnId: string, item: ThreadToolItem) => Promise<string | null>;
  readonly onSend: (content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onSubmitUserInput: (answers: readonly RequestUserInputAnswer[]) => Promise<void>;
}

const MAX_ATTACHMENTS = 6;
const ATTACHMENT_ERROR_TIMEOUT_MS = 5_000;
const INLINE_IMAGE_MAX_DIMENSION = 2_000;
const INLINE_IMAGE_JPEG_QUALITIES = [0.8, 0.7, 0.55, 0.4];
const TRANSCRIPT_ROW_GAP_PX = 12;
const TRANSCRIPT_ROW_ESTIMATE_PX = 104;
const TRANSCRIPT_VIRTUAL_MIN_TURNS = 40;
const TRANSCRIPT_VIRTUAL_OVERSCAN_PX = 720;
const MAX_CACHED_THREAD_UI_STATES = 32;
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const EMPTY_COMPOSER_DRAFT: ThreadComposerDraft = {
  content: [],
  empty: true,
  fileRefs: [],
  text: '',
};

interface ThreadScrollSnapshot {
  readonly stickToBottom: boolean;
  readonly top: number;
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

function shouldStickToTranscriptBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 56;
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
      case 'plan':
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
  slashCommands,
  threadModelProvider,
  threadId,
  turns,
  inputRequest,
  providerRetry,
  onEditUserMessage,
  onContinueInNewChat,
  onInterrupt,
  onConfigurationChange,
  onOpenNodeReference,
  onOpenThread,
  onReadToolOutput,
  onSend,
  onSubmitUserInput,
}: ThreadViewProps) {
  const t = useT();
  const waitingForInput = Boolean(inputRequest);
  const [draft, setDraft] = useState<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ThreadAttachmentContent[]>([]);
  const [recentLocalFiles, setRecentLocalFiles] = useState<ThreadComposerLocalFileCandidate[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ThreadComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const bottomScrollFrameRef = useRef<number | null>(null);
  const scrollMetricsFrameRef = useRef<number | null>(null);
  const stickToBottomRef = useRef(true);
  const attachmentsRef = useRef<ThreadAttachmentContent[]>([]);
  const attachmentPreviewUrlsRef = useRef(new Map<string, string>());
  const attachmentSourceKeysRef = useRef(new Map<string, string>());
  const draftRef = useRef<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const handledFocusTokenRef = useRef(0);
  const sendingRef = useRef(false);
  const restoredThreadIdRef = useRef<string | null>(null);
  const measuredTurnHeights = useMemo(() => cachedTurnHeights(threadId), [threadId]);
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState({ height: 0, top: 0 });
  const subscribeToDisclosures = useCallback(
    (onChange: () => void) => subscribeThreadDisclosure(threadId, onChange),
    [threadId],
  );
  const readDisclosures = useCallback(() => threadDisclosureSnapshot(threadId), [threadId]);
  const disclosureOverrides = useSyncExternalStore(subscribeToDisclosures, readDisclosures);
  const { capturePendingAnchor, restorePendingAnchor } = usePendingDisclosureAnchor();
  const expandState = useMemo<ThreadDisclosureState>(() => ({
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
      stickToBottomRef.current = false;
      setThreadDisclosureOverride(threadId, id, !currentlyExpanded);
    },
  }), [capturePendingAnchor, disclosureOverrides, threadId]);
  const activeTurn = useMemo(() => findActiveTurn(turns), [turns]);
  const editableTurnId = useMemo(() => latestUserMessageTurnId(turns), [turns]);
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

  const updateScrollMetrics = useCallback((element: HTMLDivElement) => {
    const next = { height: element.clientHeight, top: element.scrollTop };
    setScrollMetrics((current) => (
      Math.abs(current.height - next.height) < 1 && Math.abs(current.top - next.top) < 1
        ? current
        : next
    ));
  }, []);

  const scheduleScrollMetrics = useCallback((element: HTMLDivElement) => {
    if (scrollMetricsFrameRef.current !== null) return;
    scrollMetricsFrameRef.current = window.requestAnimationFrame(() => {
      scrollMetricsFrameRef.current = null;
      updateScrollMetrics(element);
    });
  }, [updateScrollMetrics]);

  const handleDisclosureToggle = useCallback(() => {
    stickToBottomRef.current = false;
  }, []);

  const measureTurn = useCallback((turnId: string, height: number) => {
    const current = measuredTurnHeights.get(turnId);
    if (current !== undefined && Math.abs(current - height) < 1) return;
    measuredTurnHeights.set(turnId, height);
    setMeasureVersion((version) => version + 1);
  }, [measuredTurnHeights]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    updateScrollMetrics(element);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => updateScrollMetrics(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateScrollMetrics]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || restoredThreadIdRef.current === threadId) return;
    const snapshot = threadScrollSnapshots.get(threadId);
    const maximumTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextTop = snapshot?.stickToBottom === false
      ? Math.min(snapshot.top, maximumTop)
      : maximumTop;
    element.scrollTop = nextTop;
    stickToBottomRef.current = snapshot?.stickToBottom ?? true;
    restoredThreadIdRef.current = threadId;
    cacheThreadScrollSnapshot(threadId, {
      stickToBottom: stickToBottomRef.current,
      top: nextTop,
    });
    updateScrollMetrics(element);
  }, [threadId, updateScrollMetrics, virtualLayout.totalHeight]);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current || bottomScrollFrameRef.current !== null) return undefined;
    bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      const scroll = scrollRef.current;
      if (!scroll || !stickToBottomRef.current) return;
      scroll.scrollTop = scroll.scrollHeight;
      cacheThreadScrollSnapshot(threadId, { stickToBottom: true, top: scroll.scrollTop });
      updateScrollMetrics(scroll);
    });
    return undefined;
  }, [itemCount, threadId, turns, updateScrollMetrics, virtualLayout.totalHeight]);

  useLayoutEffect(() => restorePendingAnchor(), [disclosureOverrides, restorePendingAnchor]);

  useEffect(() => () => {
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
    }
    if (scrollMetricsFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollMetricsFrameRef.current);
    }
    const scroll = scrollRef.current;
    if (scroll) {
      cacheThreadScrollSnapshot(threadId, {
        stickToBottom: shouldStickToTranscriptBottom(scroll),
        top: scroll.scrollTop,
      });
    }
  }, [threadId]);

  useEffect(() => () => {
    for (const previewUrl of attachmentPreviewUrlsRef.current.values()) URL.revokeObjectURL(previewUrl);
    attachmentPreviewUrlsRef.current.clear();
  }, []);

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
    stickToBottomRef.current = true;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    composerRef.current?.clear();
    updateAttachments((current) => current.filter((attachment) => !submittedAttachmentIds.has(attachment.id)));
    try {
      await onSend(submittedContent);
      for (const attachmentId of submittedAttachmentIds) releaseAttachmentUiState(
        attachmentId,
        attachmentPreviewUrlsRef.current,
        attachmentSourceKeysRef.current,
      );
    } catch (sendError) {
      if (draftRef.current.empty && editorSnapshot) composerRef.current?.restore(editorSnapshot);
      updateAttachments((current) => uniqueAttachments([...submittedAttachments, ...current]));
      setError(errorMessage(sendError));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function addPickedFiles() {
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_ATTACHMENTS }));
      return;
    }
    setError(null);
    if (window.lin?.pickLocalFiles) {
      try {
        const result = await window.lin.pickLocalFiles({ maxFiles: MAX_ATTACHMENTS - attachmentsRef.current.length });
        if (!result.canceled) {
          const next: PreparedComposerAttachment[] = [];
          const existingKeys = currentAttachmentSourceKeys(attachmentsRef.current, attachmentSourceKeysRef.current);
          let skippedDuplicates = 0;
          let skippedOverflow = result.skippedCount ?? 0;
          let failure: string | null = null;
          for (const file of result.files) {
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
              const prepared = await attachmentFromPickedFile(file);
              next.push(prepared);
              existingKeys.add(prepared.sourceKey);
            } catch (attachmentError) {
              failure ??= errorMessage(attachmentError);
            }
          }
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

  async function addBrowserFiles(files: readonly File[]) {
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
      if (file.size <= 0) continue;
      if (next.length >= MAX_ATTACHMENTS - attachmentsRef.current.length) {
        skippedOverflow += 1;
        continue;
      }
      try {
        const prepared = await attachmentFromBrowserFile(file);
        if (existingKeys.has(prepared.sourceKey)) {
          skippedDuplicates += 1;
          continue;
        }
        next.push(prepared);
        existingKeys.add(prepared.sourceKey);
      } catch (attachmentError) {
        failure ??= errorMessage(attachmentError);
      }
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

  async function selectLocalFile(
    file: ThreadComposerLocalFileCandidate,
  ): Promise<ThreadComposerFileReference | null> {
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      setError(t.agent.composer.maxAttachments({ max: MAX_ATTACHMENTS }));
      return null;
    }
    setError(null);
    try {
      const prepared = await window.lin?.prepareLocalFile?.({ id: file.id });
      if (!prepared?.file) throw new Error(`${file.name || 'Attachment'} is no longer available.`);
      const attachment = await attachmentFromPickedFile({
        ...prepared.file,
        iconDataUrl: prepared.file.iconDataUrl ?? file.iconDataUrl,
        thumbnailDataUrl: prepared.file.thumbnailDataUrl ?? file.thumbnailDataUrl,
      });
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
      if (!referencedIds.has(attachment.id)) releaseAttachmentUiState(
        attachment.id,
        attachmentPreviewUrlsRef.current,
        attachmentSourceKeysRef.current,
      );
    }
    updateAttachments(() => retained);
  }

  return (
    <div className="thread-view">
      <div
        className="thread-transcript"
        onScroll={(event) => {
          const scroll = event.currentTarget;
          const stickToBottom = shouldStickToTranscriptBottom(scroll);
          stickToBottomRef.current = stickToBottom;
          cacheThreadScrollSnapshot(threadId, { stickToBottom, top: scroll.scrollTop });
          scheduleScrollMetrics(scroll);
        }}
        ref={scrollRef}
      >
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
                    onDisclosureToggle={handleDisclosureToggle}
                    onEditUserMessage={onEditUserMessage}
                    onContinueInNewChat={onContinueInNewChat}
                    onOpenNodeReference={onOpenNodeReference}
                    onOpenThread={onOpenThread}
                    onReadToolOutput={onReadToolOutput}
                    turn={turn}
                  />
                </ThreadTranscriptTurnShell>
              );
            })}
          </div>
        ) : null}
        {providerRetry ? <ThreadProviderRetryStatus status={providerRetry.status} /> : null}
      </div>
      {composerEnabled ? <div className="thread-composer-region thread-composer">
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
  readonly onMeasure: (turnId: string, height: number) => void;
  readonly style?: CSSProperties;
  readonly turnId: string;
  readonly virtualized: boolean;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return undefined;
    const measure = () => onMeasure(turnId, element.getBoundingClientRect().height);
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
  onReadToolOutput,
  turn,
}: {
  readonly canEditUserMessage: boolean;
  readonly expandState: ThreadDisclosureState;
  readonly index: DocumentIndex;
  readonly onDisclosureToggle: () => void;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onContinueInNewChat: (turn: Turn) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onReadToolOutput: (turnId: string, item: ThreadToolItem) => Promise<string | null>;
  readonly turn: Turn;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const responseItem = lastAgentResponse(turn);
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
    const text = await buildTurnCopyText(turn, readToolOutput);
    if (text) await navigator.clipboard.writeText(text);
  }, [readToolOutput, turn]);
  const handleResponseContextMenu = useCallback(async (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const action = await window.lin?.showThreadMessageContextMenu?.({
      canCopy: hasTurnCopyContent(turn),
      canContinueInNewChat: true,
      canShowDetails: true,
    });
    if (action === 'copy') await copyTurn();
    else if (action === 'continueInNewChat') await continueInNewChat();
    else if (action === 'details') setDetailsOpen(true);
  }, [continueInNewChat, copyTurn, turn]);
  const responseTail = turn.status === 'inProgress' ? null : (
    <ThreadResponseTail
      detailsOpen={detailsOpen}
      onCopy={copyTurn}
      onDetailsOpenChange={setDetailsOpen}
      onContinueInNewChat={continueInNewChat}
      turn={turn}
    />
  );
  const renderItem = (item: ThreadItem, showMessageActions: boolean) => (
    <ThreadItemView
      agentResponseTail={item.id === responseItem?.id ? responseTail : null}
      canEditUserMessage={canEditUserMessage && showMessageActions}
      defaultReasoningExpanded={isSoloResultlessReasoning(turn, item)}
      expandState={expandState}
      index={index}
      item={item}
      key={item.id}
      onAgentMessageContextMenu={item.id === responseItem?.id ? handleResponseContextMenu : undefined}
      onEditUserMessage={editUserMessage}
      onDisclosureToggle={onDisclosureToggle}
      onOpenNodeReference={onOpenNodeReference}
      onOpenThread={onOpenThread}
      onReadToolOutput={readToolOutput}
      showMessageActions={showMessageActions}
      streaming={turn.status === 'inProgress' && turn.items.at(-1)?.id === item.id}
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
              items={block.items}
              key={`process:${block.items[0]?.id ?? turn.id}`}
              turn={turn}
            >
              {groupTurnItems(block.items).map((group) => group.kind === 'tools' ? (
                <ThreadToolActivityGroup
                  expandState={expandState}
                  items={group.items}
                  key={group.items[0]?.id}
                  onOpenThread={onOpenThread}
                  onReadToolOutput={readToolOutput}
                />
              ) : renderItem(group.item, false))}
            </ThreadProcessBlock>
          );
        }
        const item = block.item;
        return renderItem(item, turn.status !== 'inProgress' && item.type === 'userMessage');
      })}
      {turn.status === 'inProgress' ? <ThreadStreamingIndicator /> : null}
      {responseItem === null && responseTail ? (
        <article
          className="thread-item thread-agent-message thread-agent-message-response"
          onContextMenu={handleResponseContextMenu}
        >
          {responseTail}
        </article>
      ) : null}
    </section>
  );
});

function ThreadResponseTail({
  detailsOpen,
  onCopy,
  onDetailsOpenChange,
  onContinueInNewChat,
  turn,
}: {
  readonly detailsOpen: boolean;
  readonly onCopy: () => Promise<void>;
  readonly onDetailsOpenChange: (open: boolean) => void;
  readonly onContinueInNewChat: () => Promise<void>;
  readonly turn: Turn;
}) {
  const t = useT();
  const [usageHoverOpen, setUsageHoverOpen] = useState(false);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const interrupted = turn.status === 'interrupted';
  const errorText = turn.error ? threadErrorMessage(turn.error.message) : '';
  return (
    <>
      {errorText ? (
        <div className="thread-response-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{errorText}</span>
        </div>
      ) : null}
      {interrupted ? (
        <div className="thread-response-stopped">
          <StopIcon aria-hidden size={ICON_SIZE.menu} />
          <span>{t.agent.thread.turnInterrupted}</span>
        </div>
      ) : null}
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
            onClick={() => onDetailsOpenChange(!detailsOpen)}
            onFocus={() => setUsageHoverOpen(true)}
            onMouseEnter={() => setUsageHoverOpen(true)}
            onMouseLeave={() => setUsageHoverOpen(false)}
            ref={detailsButtonRef}
            title=""
            variant="message"
          />
          {usageHoverOpen && !detailsOpen ? (
            <ThreadUsageHoverCard anchorRef={detailsButtonRef} turn={turn} />
          ) : null}
          {detailsOpen ? (
            <ThreadResponseDetails
              anchorRef={detailsButtonRef}
              onClose={() => onDetailsOpenChange(false)}
              turn={turn}
            />
          ) : null}
        </span>
      </div>
    </>
  );
}

function ThreadResponseDetails({
  anchorRef,
  onClose,
  turn,
}: {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly turn: Turn;
}) {
  const t = useT();
  const { locale } = useI18n();
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const usage = turn.execution.usage;
  const cost = usage.cost?.total;
  const style = useAnchoredOverlay(detailsRef, {
    anchorRef,
    gap: 8,
    layoutKey: `${turn.id}:${turn.completedAt ?? turn.startedAt}`,
    maxHeight: 360,
    placement: 'top-end',
    width: 320,
  });
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (detailsRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [anchorRef, onClose]);
  return createPortal(
    <div
      aria-label={t.agent.message.details}
      className="thread-response-details"
      ref={detailsRef}
      role="dialog"
      style={style}
    >
      <dl className="thread-response-details-list">
        <div><dt>{t.agent.message.timestamp}</dt><dd>{formatTimestamp(turn.completedAt ?? turn.startedAt, locale)}</dd></div>
        <div><dt>{t.agent.message.provider}</dt><dd>{turn.execution.modelProvider}</dd></div>
        <div><dt>{t.agent.message.model}</dt><dd>{turn.execution.model}</dd></div>
        <div><dt>{t.agent.message.reasoningEffort}</dt><dd>{turn.execution.reasoningEffort}</dd></div>
        <div><dt>{t.agent.message.tokens}</dt><dd>{usageSummary(turn, t.agent.message.tokenLabels)}</dd></div>
        {cost !== undefined && cost !== null ? (
          <div><dt>{t.agent.message.cost}</dt><dd>{formatCost(cost)}</dd></div>
        ) : null}
      </dl>
    </div>,
    document.body,
  );
}

function ThreadUsageHoverCard({
  anchorRef,
  turn,
}: {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly turn: Turn;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const usage = turn.execution.usage;
  const style = useAnchoredOverlay(cardRef, {
    anchorRef,
    gap: 8,
    layoutKey: `${usage.input}:${usage.output}:${usage.cacheRead}:${usage.cacheWrite}:${usage.totalTokens}:${usage.cost?.total ?? 0}`,
    maxHeight: 280,
    placement: 'top-end',
    width: 248,
  });
  return createPortal(
    <div className="thread-response-usage-card" ref={cardRef} role="tooltip" style={style}>
      <ThreadUsageBreakdown turn={turn} />
    </div>,
    document.body,
  );
}

function ThreadUsageBreakdown({ turn }: { readonly turn: Turn }) {
  const t = useT();
  const usage = turn.execution.usage;
  const cost = usage.cost;
  const rows = [
    { cost: cost?.input, kind: 'input', label: t.agent.message.tokenLabels.input, tokens: usage.input },
    { cost: cost?.output, kind: 'output', label: t.agent.message.tokenLabels.output, tokens: usage.output },
    { cost: cost?.cacheRead, kind: 'cache-read', label: t.agent.message.tokenLabels.cacheRead, tokens: usage.cacheRead },
    { cost: cost?.cacheWrite, kind: 'cache-write', label: t.agent.message.tokenLabels.cacheWrite, tokens: usage.cacheWrite },
  ] as const;
  const cachedShare = formatCachedShare(usage.input, usage.cacheRead, usage.cacheWrite);
  return (
    <>
      <div className="thread-response-usage-title-row">
        <div className="thread-response-usage-title">{t.agent.message.usageDetails}</div>
        {cachedShare ? (
          <div className="thread-response-usage-meta">
            {t.agent.message.cachedShare}: <strong>{cachedShare}</strong>
          </div>
        ) : null}
      </div>
      <div aria-hidden className="thread-response-usage-bar">
        {rows.map((row) => (
          <span
            className={`is-${row.kind}`}
            key={row.kind}
            style={usageSegmentStyle(row.tokens, usage.totalTokens)}
          />
        ))}
      </div>
      <div aria-label={t.agent.message.usageDetails} className="thread-response-usage-breakdown">
        {[...rows, {
          cost: cost?.total,
          kind: 'total' as const,
          label: t.agent.message.tokenLabels.total,
          tokens: usage.totalTokens,
        }].map((row) => (
          <div
            className={`${row.kind === 'total' ? 'is-total' : ''}${row.tokens === 0 && !row.cost ? ' is-zero' : ''}`.trim() || undefined}
            key={row.kind}
          >
            <span><i className={`is-${row.kind}`} />{row.label}</span>
            <strong>{formatNumber(row.tokens)}</strong>
            <strong>{row.cost === undefined ? t.agent.message.usageUnavailable : formatCost(row.cost)}</strong>
          </div>
        ))}
      </div>
    </>
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

function hasTurnCopyContent(turn: Turn): boolean {
  return turn.items.some((item) => (
    item.type === 'agentMessage' && Boolean(item.text.trim())
  ) || item.type === 'plan' || isThreadToolItem(item)) || Boolean(turn.error?.message);
}

async function buildTurnCopyText(
  turn: Turn,
  readToolOutput: (item: ThreadToolItem) => Promise<string | null>,
): Promise<string> {
  const parts: string[] = [];
  for (const item of turn.items) {
    if (item.type === 'agentMessage' || item.type === 'plan') {
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
  if (parts.length === 0 && turn.error?.message) parts.push(threadErrorMessage(turn.error.message));
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

function usageSummary(
  turn: Turn,
  labels: Messages['agent']['message']['tokenLabels'],
): string {
  const usage = turn.execution.usage;
  const rows: ReadonlyArray<readonly [string, number]> = [
    [labels.input, usage.input],
    [labels.output, usage.output],
    [labels.cacheRead, usage.cacheRead],
    [labels.cacheWrite, usage.cacheWrite],
    [labels.total, usage.totalTokens],
  ];
  return rows.map(([label, value]) => `${label} ${formatNumber(value)}`).join(' · ');
}

function formatCachedShare(input: number, cacheRead: number, cacheWrite: number): string | null {
  const cacheActivity = cacheRead + cacheWrite;
  const inputContext = input + cacheActivity;
  if (cacheActivity <= 0 || inputContext <= 0) return null;
  return `${Math.round((cacheRead / inputContext) * 100)}%`;
}

function usageSegmentStyle(value: number, total: number): CSSProperties {
  const share = total > 0 ? value / total : 0;
  return {
    '--segment-size': `${Math.max(share * 100, value > 0 ? 2 : 0)}%`,
  } as CSSProperties;
}

function formatTimestamp(timestamp: number, locale: string): string {
  return formatDateTime(timestamp, locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

function formatCost(value: number): string {
  if (value <= 0) return '$0.0000';
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(4)}`;
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
  items,
  turn,
}: {
  readonly children: ReactNode;
  readonly expandState: ThreadDisclosureState;
  readonly hasFinalResponse: boolean;
  readonly items: readonly ThreadItem[];
  readonly turn: Turn;
}) {
  const t = useT();
  const disclosureId = `process:${turn.id}`;
  const expanded = expandState.isExpanded(disclosureId, false);
  const liveElapsedMs = useTurnElapsedMs(turn);
  const collapsible = turn.status === 'completed'
    && hasFinalResponse
    && turn.durationMs !== null
    && items.length > 0;
  const terminalResponseOwnsStatus = hasFinalResponse
    && (turn.status === 'failed' || turn.status === 'interrupted');
  const summary = threadProcessSummary(turn, items, hasFinalResponse, liveElapsedMs, t);
  const timelineVisible = !collapsible || expanded;
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
          {turn.status === 'inProgress' ? (
            <LoaderIcon className="thread-process-spinner" size={ICON_SIZE.rowGlyph} />
          ) : null}
        </div>
      )}
      {turn.status === 'inProgress' || collapsible ? <div aria-hidden className="thread-process-rule" /> : null}
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

function threadProcessSummary(
  turn: Turn,
  items: readonly ThreadItem[],
  hasFinalResponse: boolean,
  liveElapsedMs: number | null,
  t: Messages,
): string {
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

  const tools = items.filter(isThreadToolItem);
  const reasoning = items.find((item): item is Extract<ThreadItem, { type: 'reasoning' }> => item.type === 'reasoning');
  const activity = tools.length === 1
    ? summarizeThreadToolItem(tools[0]!, t.agent.thread.activity)
    : tools.length > 1
      ? summarizeThreadToolActivity(tools, t.agent.thread.activity)
      : '';
  if (reasoning) {
    if (activity) return `${t.agent.thinking.thought} · ${sentenceFragment(activity)}`;
    const gist = firstProcessLine([...reasoning.summary, ...reasoning.content].join('\n'));
    return gist ? `${t.agent.thinking.thought} · ${gist}` : t.agent.thinking.thought;
  }
  return activity || t.agent.thread.working;
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

type ThreadContentBlock =
  | { readonly kind: 'item'; readonly item: ThreadItem }
  | { readonly kind: 'process'; readonly items: readonly ThreadItem[] };

function groupTurnContent(turn: Turn): ThreadContentBlock[] {
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

function isThreadProcessItem(item: ThreadItem): boolean {
  if (isThreadToolItem(item)) return true;
  if (item.type === 'agentMessage') return item.phase === 'commentary';
  return item.type === 'plan'
    || item.type === 'reasoning'
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
    if (isCompactLoadedSkillItem(item)) {
      groups.push({ kind: 'item', item });
      index += 1;
      continue;
    }
    const tools: ThreadToolItem[] = [item];
    index += 1;
    while (index < items.length
      && isThreadToolItem(items[index]!)
      && !isCompactLoadedSkillItem(items[index] as ThreadToolItem)) {
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

function isSoloResultlessReasoning(turn: Turn, item: ThreadItem): boolean {
  if (item.type !== 'reasoning') return false;
  if (turn.items.some((candidate) => (
    candidate.type === 'agentMessage'
    && candidate.phase !== 'commentary'
    && candidate.text.trim().length > 0
  ))) return false;
  const processItems = turn.items.filter((candidate) => {
    if (candidate.type === 'userMessage' || candidate.type === 'contextCompaction') return false;
    return candidate.type !== 'agentMessage' || candidate.phase === 'commentary';
  });
  return processItems.length === 1 && processItems[0]?.id === item.id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attachmentFromPickedFile(file: {
  readonly entryKind?: 'file' | 'directory';
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly lastModified?: number;
  readonly iconDataUrl?: string;
  readonly imageDataBase64?: string;
  readonly thumbnailDataUrl?: string;
}): Promise<PreparedComposerAttachment> {
  const entryKind = file.entryKind === 'directory' || file.mimeType === 'inode/directory'
    ? 'directory'
    : 'file';
  const mimeType = entryKind === 'directory' ? 'inode/directory' : file.mimeType || 'application/octet-stream';
  validateAttachment(file.name, file.sizeBytes, mimeType);
  const id = crypto.randomUUID();
  const inlineImageMimeType = normalizeInlineImageMimeType(mimeType);
  let previewUrl: string | undefined;
  let thumbnailDataUrl = file.thumbnailDataUrl;
  let content: ThreadAttachmentContent;
  if (inlineImageMimeType) {
    if (!file.imageDataBase64) {
      throw new Error(`${file.name || 'Image'} could not be loaded for inline model vision input.`);
    }
    const imageFile = fileFromBase64(
      file.imageDataBase64,
      file.name || 'image',
      inlineImageMimeType,
      file.lastModified ?? Date.now(),
    );
    const inlineImage = await readInlineImageForModel(imageFile, inlineImageMimeType);
    if (!thumbnailDataUrl) {
      previewUrl = URL.createObjectURL(imageFile);
      thumbnailDataUrl = previewUrl;
    }
    content = {
      type: 'attachment',
      id,
      name: file.name || 'image',
      mimeType: inlineImage.mimeType,
      sizeBytes: file.sizeBytes,
      source: { kind: 'inline', dataBase64: inlineImage.dataBase64 },
    };
  } else {
    content = {
      type: 'attachment',
      id,
      name: file.name || 'attachment',
      mimeType,
      sizeBytes: file.sizeBytes,
      source: { kind: 'localFile', path: file.path },
    };
  }
  return {
    content,
    ...(previewUrl ? { previewUrl } : {}),
    reference: attachmentToComposerReference(content, { ...file, thumbnailDataUrl }),
    sourceKey: `path:${file.path}`,
  };
}

async function attachmentFromBrowserFile(file: File): Promise<PreparedComposerAttachment> {
  const name = file.name || 'attachment';
  const mimeType = file.type || 'application/octet-stream';
  validateAttachment(name, file.size, mimeType);
  const id = crypto.randomUUID();
  const nativePath = window.lin?.getFilePath?.(file) ?? '';
  const inlineImageMimeType = normalizeInlineImageMimeType(mimeType);
  const bytes = nativePath && !inlineImageMimeType ? null : await file.arrayBuffer();
  const hash = nativePath || !bytes ? '' : await sha256ArrayBuffer(bytes);
  let previewUrl: string | undefined;
  let content: ThreadAttachmentContent;
  if (inlineImageMimeType) {
    const inlineImage = await readInlineImageForModel(file, inlineImageMimeType, bytes ?? undefined);
    previewUrl = URL.createObjectURL(file);
    content = {
      type: 'attachment',
      id,
      name,
      mimeType: inlineImage.mimeType,
      sizeBytes: file.size,
      source: { kind: 'inline', dataBase64: inlineImage.dataBase64 },
    };
  } else if (nativePath) {
    content = {
      type: 'attachment',
      id,
      name,
      mimeType,
      sizeBytes: file.size,
      source: { kind: 'localFile', path: nativePath },
    };
  } else {
    if (!window.lin?.stageAttachment || !bytes) throw new Error('Attachment staging is unavailable.');
    const staged = await window.lin.stageAttachment({ name, mimeType, bytes });
    content = {
      type: 'attachment',
      id,
      name: staged.name,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
      source: { kind: 'localFile', path: staged.path },
    };
  }
  return {
    content,
    ...(previewUrl ? { previewUrl } : {}),
    reference: attachmentToComposerReference(content, {
      entryKind: 'file',
      ...(nativePath ? { path: nativePath } : {}),
      ...(previewUrl ? { thumbnailDataUrl: previewUrl } : {}),
    }),
    sourceKey: nativePath ? `path:${nativePath}` : hash ? `hash:${hash}` : `id:${id}`,
  };
}

function normalizeInlineImageMimeType(mimeType: string): string | null {
  const normalized = mimeType.trim().toLowerCase();
  if (!SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(normalized)) return null;
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function fileFromBase64(dataBase64: string, name: string, mimeType: string, lastModified: number): File {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name, { type: mimeType, lastModified });
}

async function sha256ArrayBuffer(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function validateAttachment(
  name: string,
  sizeBytes: number,
  mimeType: string,
) {
  const limit = normalizeInlineImageMimeType(mimeType) ? MAX_RAW_INLINE_IMAGE_BYTES : MAX_STAGED_ATTACHMENT_BYTES;
  if (sizeBytes > limit) {
    throw new Error(`${name || 'Attachment'} is larger than ${formatBytes(limit)} and cannot be attached.`);
  }
}

async function readInlineImageForModel(
  file: File,
  mimeType: string,
  bytes?: ArrayBuffer,
): Promise<{ readonly dataBase64: string; readonly mimeType: string }> {
  const original = {
    dataBase64: arrayBufferToBase64(bytes ?? await file.arrayBuffer()),
    mimeType,
  };
  if (original.dataBase64.length <= MAX_INLINE_IMAGE_BASE64_CHARS) return original;
  if (mimeType.toLowerCase() === 'image/gif') {
    throw new Error(`${file.name || 'Image'} is too large for inline model vision input.`);
  }
  return resizeInlineImageForModel(file);
}

async function resizeInlineImageForModel(
  file: File,
): Promise<{ readonly dataBase64: string; readonly mimeType: string }> {
  const bitmap = await createImageBitmap(file);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    if (width > INLINE_IMAGE_MAX_DIMENSION || height > INLINE_IMAGE_MAX_DIMENSION) {
      const scale = Math.min(INLINE_IMAGE_MAX_DIMENSION / width, INLINE_IMAGE_MAX_DIMENSION / height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
    while (width >= 1 && height >= 1) {
      for (const quality of INLINE_IMAGE_JPEG_QUALITIES) {
        const blob = await renderBitmapToBlob(bitmap, width, height, quality);
        const dataBase64 = arrayBufferToBase64(await blob.arrayBuffer());
        if (dataBase64.length <= MAX_INLINE_IMAGE_BASE64_CHARS) {
          return { dataBase64, mimeType: 'image/jpeg' };
        }
      }
      const nextWidth = Math.max(1, Math.floor(width * 0.75));
      const nextHeight = Math.max(1, Math.floor(height * 0.75));
      if (nextWidth === width && nextHeight === height) break;
      width = nextWidth;
      height = nextHeight;
    }
  } finally {
    bitmap.close();
  }
  throw new Error(`${file.name || 'Image'} could not be resized for inline model vision input.`);
}

function renderBitmapToBlob(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare image for model input.');
  context.fillStyle = 'white';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode image for model input.'));
    }, 'image/jpeg', quality);
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function uniqueAttachments(attachments: readonly ThreadAttachmentContent[]): ThreadAttachmentContent[] {
  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    const key = attachment.source.kind === 'localFile'
      ? `path:${attachment.source.path}`
      : attachment.source.kind === 'asset'
        ? `asset:${attachment.source.assetId}`
        : `id:${attachment.id}`;
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
  if (attachment.source.kind === 'asset') return `asset:${attachment.source.assetId}`;
  return `id:${attachment.id}`;
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
