import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import {
  MAX_INLINE_IMAGE_BASE64_CHARS,
  MAX_RAW_INLINE_IMAGE_BYTES,
  MAX_STAGED_ATTACHMENT_BYTES,
} from '../../../core/agentAttachmentLimits';
import type { Messages } from '../../../core/i18n';
import type {
  RequestUserInputAnswer,
  RequestUserInputRequest,
  ThreadAttachmentContent,
  ThreadConfigurationSummary,
  ThreadItem,
  ThreadUserContent,
  Turn,
} from '../../../core/agent/protocol';
import type { ThreadGoal } from '../../../core/agent/goal';
import type { AgentProviderSettingsView, AgentSlashCommandView } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { useT } from '../../i18n/I18nProvider';
import {
  acknowledgeThreadComposerNodeReferenceRequest,
  onThreadComposerNodeReferenceRequest,
} from '../agentReveal';
import {
  AttachmentIcon,
  ChevronRightIcon,
  GitForkIcon,
  ICON_SIZE,
  LoaderIcon,
  RefreshIcon,
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
  ThreadToolActivityGroup,
  type ThreadDisclosureState,
  type ThreadToolItem,
} from './items/ThreadItemView';
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
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onFork: (turn: Turn, kind: 'beforeTurn' | 'afterTurn') => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onConfigurationChange: (configuration: ThreadConfigurationSummary) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onRegenerate: (turn: Turn) => Promise<void>;
  readonly onSend: (content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onSubmitUserInput: (answers: readonly RequestUserInputAnswer[]) => Promise<void>;
}

const MAX_ATTACHMENTS = 6;
const ATTACHMENT_ERROR_TIMEOUT_MS = 5_000;
const INLINE_IMAGE_MAX_DIMENSION = 2_000;
const INLINE_IMAGE_JPEG_QUALITIES = [0.8, 0.7, 0.55, 0.4];
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
  onEditUserMessage,
  onFork,
  onInterrupt,
  onConfigurationChange,
  onOpenNodeReference,
  onOpenThread,
  onRegenerate,
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
  const stickToBottomRef = useRef(true);
  const attachmentsRef = useRef<ThreadAttachmentContent[]>([]);
  const attachmentPreviewUrlsRef = useRef(new Map<string, string>());
  const attachmentSourceKeysRef = useRef(new Map<string, string>());
  const draftRef = useRef<ThreadComposerDraft>(EMPTY_COMPOSER_DRAFT);
  const handledFocusTokenRef = useRef(0);
  const sendingRef = useRef(false);
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

  useLayoutEffect(() => {
    if (!stickToBottomRef.current || bottomScrollFrameRef.current !== null) return undefined;
    bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
      bottomScrollFrameRef.current = null;
      const scroll = scrollRef.current;
      if (!scroll || !stickToBottomRef.current) return;
      scroll.scrollTop = scroll.scrollHeight;
    });
    return undefined;
  }, [itemCount, turns]);

  useLayoutEffect(() => restorePendingAnchor(), [disclosureOverrides, restorePendingAnchor]);

  useEffect(() => () => {
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current);
    }
  }, []);

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
          stickToBottomRef.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 56;
        }}
        ref={scrollRef}
      >
        {goal ? <ThreadGoalView goal={goal} /> : null}
        {turns.length === 0 ? <p className="thread-empty-copy">{t.agent.thread.empty}</p> : null}
        {turns.map((turn) => {
          const renderItem = (item: ThreadItem, showMessageActions: boolean) => (
            <ThreadItemView
              defaultReasoningExpanded={isSoloResultlessReasoning(turn, item)}
              expandState={expandState}
              index={index}
              item={item}
              key={item.id}
              onEditUserMessage={(content) => onEditUserMessage(turn, content)}
              onDisclosureToggle={() => {
                stickToBottomRef.current = false;
              }}
              onOpenNodeReference={onOpenNodeReference}
              onOpenThread={onOpenThread}
              onRegenerate={() => onRegenerate(turn)}
              showMessageActions={showMessageActions}
              streaming={turn.status === 'inProgress' && turn.items.at(-1)?.id === item.id}
            />
          );
          const processItemCount = turn.items.filter(isThreadProcessItem).length;
          return (
          <section className={`thread-turn thread-turn-${turn.status}`} key={turn.id}>
            {groupTurnContent(turn.items).map((block) => {
              if (block.kind === 'process') {
                return (
                  <ThreadProcessBlock
                    expandState={expandState}
                    hasFinalResponse={lastAgentResponseId(turn) !== null}
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
                      />
                    ) : renderItem(group.item, false))}
                  </ThreadProcessBlock>
                );
              }
              const item = block.item;
              return renderItem(item, turn.status !== 'inProgress' && (
                item.type === 'userMessage'
                || (item.type === 'agentMessage' && lastAgentResponseId(turn) === item.id)
              ));
            })}
            {turn.error ? (
              <div className="thread-turn-error" role="alert">
                <WarningIcon size={ICON_SIZE.menu} />
                <span>{turn.error.message}</span>
              </div>
            ) : null}
            <footer className="thread-turn-footer">
              <span>{turnStatusLabel(turn, t.agent.thread, processItemCount === 0)}</span>
              <span className="thread-turn-actions">
                {turn.status !== 'inProgress' ? (
                  <>
                    {turn.status === 'failed' || turn.status === 'interrupted' ? (
                      <IconButton
                        icon={RefreshIcon}
                        iconSize={ICON_SIZE.tiny}
                        label={t.agent.message.retryResponse}
                        onClick={() => void onRegenerate(turn)}
                        variant="message"
                      />
                    ) : null}
                    <IconButton
                      icon={GitForkIcon}
                      iconSize={ICON_SIZE.tiny}
                      label={t.agent.thread.forkBefore}
                      onClick={() => void onFork(turn, 'beforeTurn')}
                      variant="message"
                    />
                    <IconButton
                      icon={GitForkIcon}
                      iconSize={ICON_SIZE.tiny}
                      label={t.agent.thread.forkAfter}
                      onClick={() => void onFork(turn, 'afterTurn')}
                      variant="message"
                    />
                  </>
                ) : null}
              </span>
            </footer>
          </section>
          );
        })}
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

function findActiveTurn(turns: readonly Turn[]): Turn | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.status === 'inProgress') return turn;
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
  const summary = threadProcessSummary(turn, items, hasFinalResponse, liveElapsedMs, t);
  const timelineVisible = !collapsible || expanded;
  return (
    <div className={`thread-process-block${turn.status === 'failed' ? ' is-error' : ''}`}>
      {collapsible ? (
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
  if (turn.status === 'failed') return t.agent.thread.turnFailed;
  if (turn.status === 'interrupted') return t.agent.thread.turnInterrupted;
  if (hasFinalResponse && turn.durationMs !== null) {
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

function groupTurnContent(items: readonly ThreadItem[]): ThreadContentBlock[] {
  const blocks: ThreadContentBlock[] = [];
  for (let index = 0; index < items.length;) {
    const item = items[index];
    if (!item) break;
    if (!isThreadProcessItem(item)) {
      blocks.push({ kind: 'item', item });
      index += 1;
      continue;
    }
    const processItems: ThreadItem[] = [item];
    index += 1;
    while (index < items.length && isThreadProcessItem(items[index]!)) {
      processItems.push(items[index]!);
      index += 1;
    }
    blocks.push({ kind: 'process', items: processItems });
  }
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

function lastAgentResponseId(turn: Turn): string | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item?.type === 'agentMessage' && item.phase !== 'commentary') return item.id;
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

function turnStatusLabel(
  turn: Turn,
  labels: {
    readonly working: string;
    readonly turnFailed: string;
    readonly turnInterrupted: string;
  },
  includeCompletedDuration: boolean,
): string {
  if (turn.status === 'inProgress') return labels.working;
  if (turn.status === 'failed') return labels.turnFailed;
  if (turn.status === 'interrupted') return labels.turnInterrupted;
  if (!includeCompletedDuration || turn.durationMs === null) return '';
  return formatDuration(turn.durationMs);
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1_000)}s`;
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
