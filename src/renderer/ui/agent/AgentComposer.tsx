import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import type {
  AgentApprovalRequestView,
  AgentApprovalResolutionScope,
  AgentMessageAttachmentInput,
  AgentUserQuestionPendingView,
  AskUserQuestionResult,
} from '../../../core/agentTypes';
import {
  MAX_INLINE_IMAGE_BASE64_CHARS,
  MAX_RAW_INLINE_IMAGE_BYTES,
  MAX_STAGED_ATTACHMENT_BYTES,
} from '../../../core/agentAttachmentLimits';
import { sanitizeFileReferenceRef } from '../../../core/referenceMarkup';
import type {
  AgentModelOption,
  AgentProviderConfigView,
  AgentProviderSettingsView,
  AgentReasoningLevel,
  AgentSlashCommandView,
  NodeId,
} from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import {
  AgentComposerModelButton,
  AgentComposerPrimaryAction,
  AgentComposerToolbar,
  AgentQueuedSteer,
} from './AgentComposerControls';
import {
  AgentComposerModelMenu,
  type ComposerModelChoice,
} from './AgentComposerModelMenu';
import { isProviderUsable, resolveUsableActiveProvider } from './providerCatalog';
import {
  AgentComposerEditor,
  type AgentComposerDraft,
  type AgentComposerEditorHandle,
  type AgentComposerEditorSnapshot,
  type AgentComposerFileReference,
  type AgentComposerLocalFileCandidate,
  type AgentComposerMemberCandidate,
  type AgentComposerNodeReference,
} from './AgentComposerEditor';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';

interface AgentComposerProps {
  currentNodeId: NodeId | null;
  index: DocumentIndex;
  isStreaming: boolean;
  /** Channel agent members for the `@` typeahead; empty in a DM. */
  members: readonly AgentComposerMemberCandidate[];
  /**
   * Channel mode (ratified: no steer in Channels): while a round is running,
   * submits stay ordinary sends — the runtime queues them as the next round.
   * Stop stays available; only the steer pathway disappears.
   */
  queueSends?: boolean;
  focusToken?: number;
  onNodeReferenceOpen: AgentNodeReferenceOpenHandler;
  onSend: (
    message: string,
    attachments?: AgentMessageAttachmentInput[],
    nodeRefs?: AgentComposerNodeReference[],
  ) => Promise<void>;
  onSteer: (message: string) => Promise<void>;
  onCancelSteer: () => Promise<void>;
  onStop: () => void;
  onResolveApproval: (
    requestId: string,
    approved: boolean,
    scope?: AgentApprovalResolutionScope,
  ) => Promise<boolean>;
  onResolveUserQuestion: (requestId: string, result: AskUserQuestionResult) => Promise<boolean>;
  onModelChange: (providerId: string, modelId: string) => Promise<void>;
  onReasoningChange: (reasoningLevel: AgentReasoningLevel) => Promise<void>;
  pendingApproval: AgentApprovalRequestView | null;
  pendingUserQuestion: AgentUserQuestionPendingView | null;
  settings: AgentProviderSettingsView | null;
  slashCommands: AgentSlashCommandView[];
  steeringNote: string | null;
}

const VENDOR_PREFIXES = [
  'Anthropic: ',
  'OpenAI: ',
  'Claude ',
  'Google ',
  'DeepSeek ',
  'MiniMax ',
  'Mistral ',
  'xAI ',
  'Kimi ',
  'Grok ',
];

const MAX_ATTACHMENTS = 6;
// Attachment errors are a transient hint, not a persistent banner — they fade
// after this delay so the composer never carries a stale error (see the effect).
const ATTACHMENT_ERROR_TIMEOUT_MS = 5000;
const INLINE_IMAGE_MAX_DIMENSION = 2000;
const INLINE_IMAGE_JPEG_QUALITIES = [0.8, 0.7, 0.55, 0.4];
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.c',
  '.cpp',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.h',
  '.hpp',
  '.html',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.log',
  '.md',
  '.py',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

type ComposerAttachment = AgentMessageAttachmentInput & {
  fingerprint?: string;
  iconDataUrl?: string;
  previewUrl?: string;
  sha256?: string;
  thumbnailDataUrl?: string;
};

interface PreparedPathlessAttachmentBytes {
  bytes: ArrayBuffer;
  sha256: string;
}

interface PickedLocalFileAttachment {
  entryKind?: 'file' | 'directory';
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  lastModified: number;
  iconDataUrl?: string;
  imageDataBase64?: string;
  thumbnailDataUrl?: string;
}

const EMPTY_DRAFT: AgentComposerDraft = {
  empty: true,
  fileRefs: [],
  nodeRefs: [],
  text: '',
};

export function AgentComposer({
  currentNodeId,
  focusToken = 0,
  index,
  isStreaming,
  members,
  queueSends = false,
  onModelChange,
  onNodeReferenceOpen,
  onReasoningChange,
  onCancelSteer,
  onResolveApproval,
  onResolveUserQuestion,
  onSend,
  onSteer,
  onStop,
  pendingApproval,
  pendingUserQuestion,
  settings,
  slashCommands,
  steeringNote,
}: AgentComposerProps) {
  const t = useT();
  const [draft, setDraft] = useState<AgentComposerDraft>(EMPTY_DRAFT);
  const [sending, setSending] = useState(false);
  const [configSubmitting, setConfigSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [moreModelsOpen, setMoreModelsOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const [recentLocalFiles, setRecentLocalFiles] = useState<AgentComposerLocalFileCandidate[]>([]);
  const editorRef = useRef<AgentComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const draftRef = useRef<AgentComposerDraft>(EMPTY_DRAFT);
  const dragDepthRef = useRef(0);
  const handledFocusTokenRef = useRef(0);
  const sendingRef = useRef(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const hasDraft = !draft.empty;

  // Auto-dismiss the attachment error: it announces the problem, then fades so the
  // composer doesn't keep a stale banner. Each new message restarts the timer (the
  // dependency changes); a success path that clears it to null cancels the timer via
  // cleanup before it fires.
  useEffect(() => {
    if (!attachmentError) return;
    const timer = window.setTimeout(() => setAttachmentError(null), ATTACHMENT_ERROR_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [attachmentError]);

  useEffect(() => {
    if (focusToken <= 0 || handledFocusTokenRef.current >= focusToken) return;
    handledFocusTokenRef.current = focusToken;
    if (pendingApproval || pendingUserQuestion) return;
    const frame = window.requestAnimationFrame(() => editorRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusToken, pendingApproval, pendingUserQuestion]);
  const hasAttachments = attachments.length > 0;
  const activeProvider = settings ? resolveUsableActiveProvider(settings) ?? null : null;
  // No usable provider once settings have LOADED → block send and explain why.
  // While settings are still loading (settings === null) stay neutral, so a
  // key-holding user's send button never disables during the load window.
  const providerBlocksSend = settings !== null && !activeProvider;
  // In queue-send (Channel) mode the steer pathway does not exist: a running
  // round never switches the composer into steer submit/placeholder.
  const steering = isStreaming && !queueSends;
  const canSubmit = (pendingApproval || pendingUserQuestion ? false : steering
    ? hasDraft && !hasAttachments
    : !sending && (hasDraft || hasAttachments)) && !providerBlocksSend;
  const modelOptions = getModelChoices(settings, activeProvider);
  const selectedModel = modelOptions.find(
    (model) => model.providerId === activeProvider?.providerId && model.id === activeProvider?.modelId,
  );
  const reasoningOptions: AgentReasoningLevel[] = selectedModel?.supportedThinkingLevels.length
    ? selectedModel.supportedThinkingLevels
    : activeProvider ? [activeProvider.reasoningLevel] : ['off'];
  const selectedReasoning = activeProvider && reasoningOptions.includes(activeProvider.reasoningLevel)
    ? activeProvider.reasoningLevel
    : reasoningOptions[0] ?? 'off';
  const supportsReasoning = !!selectedModel?.reasoning || reasoningOptions.some((level) => level !== 'off');
  const reasoningEnabled = selectedReasoning !== 'off';
  const configDisabled = isStreaming || !!pendingApproval || !!pendingUserQuestion || configSubmitting || modelOptions.length === 0;

  useEffect(() => {
    if (!modelMenuOpen) {
      setReasoningMenuOpen(false);
    }
  }, [modelMenuOpen]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      revokeAttachmentPreview(attachment);
    }
  }, []);

  useEffect(() => {
    let canceled = false;
    window.lin?.recentLocalFiles?.({ limit: 6 })
      .then((result) => {
        if (!canceled) setRecentLocalFiles(result.files);
      })
      .catch(() => {
        // Recent local files are an optional convenience; search still works.
      });
    return () => {
      canceled = true;
    };
  }, []);

  async function submit() {
    if (!canSubmit) return;
    const currentDraft = draftRef.current;
    const message = currentDraft.text.trim();
    const sentAttachments = attachmentsRef.current;
    const outgoingAttachments = sentAttachments.map(toAttachmentPayload);
    const editorSnapshot = editorRef.current?.snapshot() ?? null;

    if (steering) {
      if (sentAttachments.length > 0) {
        setAttachmentError(t.agent.composer.attachmentsCannotQueue);
        return;
      }
      editorRef.current?.clear();
      try {
        await onSteer(message);
      } catch (error) {
        restoreDraftIfUnchanged(editorSnapshot);
        setAttachmentError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    editorRef.current?.clear();
    detachAttachments();
    let restoredAttachments = false;
    let succeeded = false;
    try {
      await onSend(message, outgoingAttachments, currentDraft.nodeRefs);
      succeeded = true;
    } catch (error) {
      restoreDraftIfUnchanged(editorSnapshot);
      if (attachmentsRef.current.length === 0) {
        attachmentsRef.current = sentAttachments;
        restoredAttachments = true;
        setAttachments(sentAttachments);
      }
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      if (succeeded || !restoredAttachments) {
        for (const attachment of sentAttachments) {
          revokeAttachmentPreview(attachment);
        }
      }
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function addFiles(files: FileList | File[]): Promise<ComposerAttachment[]> {
    const incoming = Array.from(files).filter((file) => file.size > 0);
    if (incoming.length === 0) return [];

    const remainingSlots = MAX_ATTACHMENTS - attachmentsRef.current.length;
    if (remainingSlots <= 0) {
      setAttachmentError(t.agent.composer.maxAttachments({ max: MAX_ATTACHMENTS }));
      return [];
    }

    const existingFingerprints = new Set(attachmentsRef.current.map((attachment) => attachment.fingerprint));
    const existingHashes = new Set(attachmentsRef.current.map((attachment) => attachment.sha256).filter((hash): hash is string => Boolean(hash)));
    const failures: string[] = [];
    const nextAttachments: ComposerAttachment[] = [];
    let skippedDuplicates = 0;
    let skippedOverflow = 0;

    for (const file of incoming) {
      if (nextAttachments.length >= remainingSlots) {
        skippedOverflow += 1;
        continue;
      }
      try {
        const nativePath = window.lin?.getFilePath?.(file) ?? '';
        const fingerprint = fileFingerprint(file, nativePath);
        if (nativePath && existingFingerprints.has(fingerprint)) {
          skippedDuplicates += 1;
          continue;
        }
        const prepared = nativePath ? null : await preparePathlessAttachmentBytes(file);
        if (prepared?.sha256 && existingHashes.has(prepared.sha256)) {
          skippedDuplicates += 1;
          continue;
        }
        const attachment = await fileToAttachment(file, nativePath, prepared);
        nextAttachments.push({ ...attachment, fingerprint });
        existingFingerprints.add(fingerprint);
        if (attachment.sha256) existingHashes.add(attachment.sha256);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    const referencedAttachments = withAttachmentRefs(nextAttachments, attachmentsRef.current);
    if (referencedAttachments.length > 0) {
      const merged = [...attachmentsRef.current, ...referencedAttachments];
      attachmentsRef.current = merged;
      setAttachments(merged);
    }
    setAttachmentError(
      failures[0]
        ?? duplicateMessage(skippedDuplicates, t.agent.composer)
        ?? overflowMessage(skippedOverflow, t.agent.composer)
        ?? null,
    );
    return referencedAttachments;
  }

  async function addFilesInline(files: FileList | File[]) {
    const added = await addFiles(files);
    if (added.length > 0) {
      editorRef.current?.insertFileReferences(added.map(attachmentToFileReference));
    }
  }

  async function addPickedLocalFilesInline(
    files: PickedLocalFileAttachment[],
    options: { insertReferences?: boolean } = {},
  ): Promise<AgentComposerFileReference[]> {
    const insertReferences = options.insertReferences ?? true;
    if (files.length === 0) return [];
    const remainingSlots = MAX_ATTACHMENTS - attachmentsRef.current.length;
    if (remainingSlots <= 0) {
      setAttachmentError(t.agent.composer.maxAttachments({ max: MAX_ATTACHMENTS }));
      return [];
    }

    const existingFingerprints = new Set(attachmentsRef.current.map((attachment) => attachment.fingerprint));
    const failures: string[] = [];
    const nextAttachments: ComposerAttachment[] = [];
    let skippedDuplicates = 0;
    let skippedOverflow = 0;

    for (const file of files) {
      if (nextAttachments.length >= remainingSlots) {
        skippedOverflow += 1;
        continue;
      }
      try {
        const fingerprint = pickedLocalFileFingerprint(file);
        if (existingFingerprints.has(fingerprint)) {
          skippedDuplicates += 1;
          continue;
        }
        const attachment = await pickedLocalFileToAttachment(file);
        nextAttachments.push({ ...attachment, fingerprint });
        existingFingerprints.add(fingerprint);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (nextAttachments.length > 0) {
      const referencedAttachments = withAttachmentRefs(nextAttachments, attachmentsRef.current);
      const merged = [...attachmentsRef.current, ...referencedAttachments];
      attachmentsRef.current = merged;
      setAttachments(merged);
      const refs = referencedAttachments.map(attachmentToFileReference);
      if (insertReferences) editorRef.current?.insertFileReferences(refs);
      setAttachmentError(
        failures[0]
          ?? duplicateMessage(skippedDuplicates, t.agent.composer)
          ?? overflowMessage(skippedOverflow, t.agent.composer)
          ?? null,
      );
      return refs;
    }
    setAttachmentError(
      failures[0]
        ?? duplicateMessage(skippedDuplicates, t.agent.composer)
        ?? overflowMessage(skippedOverflow, t.agent.composer)
        ?? null,
    );
    return [];
  }

  function detachAttachments() {
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachmentError(null);
  }

  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (files.length === 0) return;
    await addFilesInline(files);
  }

  async function handleAttachmentClick() {
    if (window.lin?.pickLocalFiles) {
      try {
        const result = await window.lin.pickLocalFiles({
          maxFiles: Math.max(1, MAX_ATTACHMENTS - attachmentsRef.current.length),
        });
        if (!result.canceled) {
          await addPickedLocalFilesInline(result.files);
          if (result.skippedCount) {
            setAttachmentError((current) => current ?? overflowMessage(result.skippedCount ?? 0, t.agent.composer));
          }
        }
        return;
      } catch {
        // Fall through to the web file input when the native picker is unavailable.
      }
    }

    fileInputRef.current?.click();
  }

  async function searchLocalFiles(query: string): Promise<AgentComposerLocalFileCandidate[]> {
    if (!window.lin?.searchLocalFiles) return [];
    const result = await window.lin.searchLocalFiles({ query, limit: 8 });
    return result.files;
  }

  async function previewLocalFile(
    file: AgentComposerLocalFileCandidate,
  ): Promise<AgentComposerLocalFileCandidate | null> {
    if (file.thumbnailDataUrl || !window.lin?.previewLocalFile) return file.thumbnailDataUrl ? file : null;
    const result = await window.lin.previewLocalFile({ id: file.id });
    return result.thumbnailDataUrl
      ? { ...file, thumbnailDataUrl: result.thumbnailDataUrl }
      : null;
  }

  async function attachLocalFileCandidate(
    file: AgentComposerLocalFileCandidate,
  ): Promise<AgentComposerFileReference | null> {
    if (!window.lin?.prepareLocalFile) {
      setAttachmentError(t.agent.composer.localFileSearchUnavailable);
      return null;
    }
    const result = await window.lin.prepareLocalFile({ id: file.id });
    if (!result.file) {
      setAttachmentError(t.agent.composer.localFileNoLongerAvailable);
      return null;
    }
    const refs = await addPickedLocalFilesInline([{
      ...result.file,
      iconDataUrl: result.file.iconDataUrl ?? file.iconDataUrl,
      thumbnailDataUrl: result.file.thumbnailDataUrl ?? file.thumbnailDataUrl,
    }], { insertReferences: false });
    if (refs.length > 0) {
      setRecentLocalFiles((current) => [file, ...current.filter((item) => item.id !== file.id)].slice(0, 8));
    }
    return refs[0] ?? null;
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    void addFilesInline(event.dataTransfer.files);
  }

  async function editSteer() {
    if (!steeringNote) return;
    await onCancelSteer();
    editorRef.current?.setPlainText(steeringNote);
  }

  async function changeModel(model: ComposerModelChoice) {
    if (
      configDisabled
      || (model.providerId === activeProvider?.providerId && model.id === activeProvider?.modelId)
    ) {
      setModelMenuOpen(false);
      return;
    }
    setConfigSubmitting(true);
    try {
      await onModelChange(model.providerId, model.id);
      setModelMenuOpen(false);
    } finally {
      setConfigSubmitting(false);
    }
  }

  async function changeReasoning(reasoningLevel: AgentReasoningLevel) {
    if (configDisabled || reasoningLevel === selectedReasoning) return;
    setConfigSubmitting(true);
    try {
      await onReasoningChange(reasoningLevel);
    } finally {
      setConfigSubmitting(false);
    }
  }

  function defaultEnabledReasoning(): AgentReasoningLevel {
    if (reasoningOptions.includes('medium')) return 'medium';
    return reasoningOptions.find((level) => level !== 'off') ?? selectedReasoning;
  }

  const modelLabel = selectedModel
    ? shortenModelName(selectedModel.name || selectedModel.id)
    : activeProvider?.modelId
      ? shortenModelName(activeProvider.modelId)
      : t.agent.composer.selectModel;

  function handleDraftChange(nextDraft: AgentComposerDraft) {
    if (!sendingRef.current) pruneUnreferencedAttachments(nextDraft);
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }

  function restoreDraftIfUnchanged(snapshot: AgentComposerEditorSnapshot | null) {
    if (!snapshot || !draftRef.current.empty) return;
    editorRef.current?.restore(snapshot);
  }

  function pruneUnreferencedAttachments(nextDraft: AgentComposerDraft) {
    if (attachmentsRef.current.length === 0) return;
    const referencedAttachmentIds = new Set(nextDraft.fileRefs.map((fileRef) => fileRef.attachmentId));
    const nextAttachments = attachmentsRef.current.filter((attachment) => referencedAttachmentIds.has(attachment.id));
    if (nextAttachments.length === attachmentsRef.current.length) return;
    for (const attachment of attachmentsRef.current) {
      if (!referencedAttachmentIds.has(attachment.id)) revokeAttachmentPreview(attachment);
    }
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);
  }

  return (
    <form
      className="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {steeringNote ? (
        <AgentQueuedSteer
          note={steeringNote}
          onCancel={() => void onCancelSteer()}
          onEdit={() => void editSteer()}
        />
      ) : null}
      <div
        className={`agent-composer-surface ${isStreaming ? 'is-streaming' : ''} ${dragActive ? 'is-dragging' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {dragActive ? <div className="agent-composer-drop-overlay">{t.agent.composer.dropFilesToAttach}</div> : null}
        {attachmentError ? (
          <div className="agent-composer-error" role="status">
            {attachmentError}
          </div>
        ) : null}
        {pendingApproval ? (
          <AgentApprovalCard
            approval={pendingApproval}
            onResolve={onResolveApproval}
          />
        ) : pendingUserQuestion ? (
          <AgentUserQuestionCard
            key={pendingUserQuestion.requestId}
            pendingQuestion={pendingUserQuestion}
            onResolve={onResolveUserQuestion}
          />
        ) : (
          <>
            <AgentComposerEditor
              ref={editorRef}
              currentNodeId={currentNodeId}
              index={index}
              isStreaming={isStreaming}
              members={members}
              onChange={handleDraftChange}
              onFilesPasted={(files) => void addFilesInline(files)}
              onLocalFilePreview={previewLocalFile}
              onLocalFileSearch={searchLocalFiles}
              onLocalFileSelect={attachLocalFileCandidate}
              onNodeReferenceClick={onNodeReferenceOpen}
              recentLocalFiles={recentLocalFiles}
              onStop={onStop}
              onSubmit={() => void submit()}
              placeholder={
                steering
                  ? steeringNote ? t.agent.composer.appendSteerPlaceholder : t.agent.composer.steerPlaceholder
                  : t.agent.composer.askPlaceholder
              }
              slashCommands={slashCommands}
            />
            <AgentComposerToolbar
              attachmentDisabled={steering || attachments.length >= MAX_ATTACHMENTS}
              fileInputRef={fileInputRef}
              onAttachmentClick={() => void handleAttachmentClick()}
              onFileInputChange={handleFileInputChange}
              modelControl={(
                <div className="agent-composer-model" ref={modelMenuRef}>
                  <AgentComposerModelButton
                    disabled={configDisabled || modelOptions.length === 0}
                    modelLabel={modelLabel}
                    modelTitle={activeProvider ? `${activeProvider.providerId}/${activeProvider.modelId}` : t.agent.composer.noModelConfigured}
                    onToggle={() => setModelMenuOpen((open) => !open)}
                    open={modelMenuOpen}
                    reasoningEnabled={reasoningEnabled}
                    selectedReasoning={selectedReasoning}
                    supportsReasoning={supportsReasoning}
                  />

                  {modelMenuOpen ? (
                    <AgentComposerModelMenu
                      activeProvider={activeProvider}
                      anchorRef={modelMenuRef}
                      configDisabled={configDisabled}
                      models={modelOptions}
                      moreModelsOpen={moreModelsOpen}
                      onClose={() => setModelMenuOpen(false)}
                      onModelSelect={(model) => void changeModel(model)}
                      onMoreModelsOpenChange={setMoreModelsOpen}
                      onReasoningLevelSelect={(reasoningLevel) => {
                        setReasoningMenuOpen(false);
                        void changeReasoning(reasoningLevel);
                      }}
                      onReasoningMenuOpenChange={setReasoningMenuOpen}
                      onReasoningToggle={() => void changeReasoning(reasoningEnabled ? 'off' : defaultEnabledReasoning())}
                      reasoningEnabled={reasoningEnabled}
                      reasoningMenuOpen={reasoningMenuOpen}
                      reasoningOptions={reasoningOptions}
                      selectedReasoning={selectedReasoning}
                      supportsReasoning={supportsReasoning}
                    />
                  ) : null}
                </div>
              )}
              primaryAction={(
                <AgentComposerPrimaryAction
                  canSubmit={canSubmit}
                  disabledTitle={providerBlocksSend ? 'Add a provider in Settings' : undefined}
                  hasDraft={hasDraft}
                  isStreaming={isStreaming}
                  onStop={onStop}
                />
              )}
            />
          </>
        )}
      </div>
    </form>
  );
}

function AgentApprovalCard({
  approval,
  onResolve,
}: {
  approval: AgentApprovalRequestView;
  onResolve: (
    requestId: string,
    approved: boolean,
    scope?: AgentApprovalResolutionScope,
  ) => Promise<boolean>;
}) {
  const t = useT();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [submitting, setSubmitting] = useState<AgentApprovalResolutionScope | 'deny' | 'full_access' | null>(null);

  async function resolve(approved: boolean, scope: AgentApprovalResolutionScope = 'once') {
    if (submitting) return;
    setSubmitting(approved ? scope : 'deny');
    try {
      await onResolve(approval.requestId, approved, scope);
    } finally {
      setSubmitting(null);
    }
  }

  async function stopAsking() {
    if (submitting) return;
    if (!window.confirm(t.agent.composer.fullAccessConfirm)) return;
    setSubmitting('full_access');
    try {
      await onResolve(approval.requestId, true, 'full_access');
    } finally {
      setSubmitting(null);
    }
  }

  async function dismissNotice() {
    if (submitting) return;
    setSubmitting('deny');
    try {
      await onResolve(approval.requestId, false, 'once');
    } finally {
      setSubmitting(null);
    }
  }

  const isSkillTrust = approval.kind === 'skill_trust';
  const isNotice = approval.kind === 'permission_notice';

  return (
    <div className="agent-approval-card" role="group" aria-label={approval.title}>
      <div className="agent-approval-copy">
        <div className="agent-approval-title">{approval.title}</div>
        <div className="agent-approval-target" title={approval.target}>{approval.target}</div>
        <button
          aria-expanded={detailsOpen}
          className="agent-approval-details-toggle"
          onClick={() => setDetailsOpen((open) => !open)}
          type="button"
        >
          {detailsOpen ? t.agent.composer.hideDetails : t.agent.composer.showDetails}
        </button>
        {detailsOpen ? (
          <div className="agent-approval-details-panel">
            {approval.details.map((detail) => (
              <div className="agent-approval-detail" key={`${detail.label}:${detail.value}`}>
                <span className="agent-approval-detail-label">{detail.label}</span>
                <span className="agent-approval-detail-value">{detail.value}</span>
              </div>
            ))}
            {approval.alwaysAllowRule ? (
              <div className="agent-approval-detail">
                <span className="agent-approval-detail-label">{t.agent.composer.alwaysAllowRule}</span>
                <span className="agent-approval-detail-value">{approval.alwaysAllowRule}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="agent-approval-actions">
        {isNotice ? (
          <button
            className="agent-approval-button is-primary"
            disabled={!!submitting}
            onClick={() => void dismissNotice()}
            type="button"
          >
            {t.agent.composer.dismiss}
          </button>
        ) : isSkillTrust ? (
          <>
            <button
              className="agent-approval-button is-primary"
              disabled={!!submitting}
              onClick={() => void resolve(true, 'once')}
              type="button"
            >
              {t.agent.composer.acceptSkill}
            </button>
            <button
              className="agent-approval-button"
              disabled={!!submitting}
              onClick={() => void resolve(false, 'once')}
              type="button"
            >
              {t.agent.composer.notNow}
            </button>
          </>
        ) : (
          <>
            <button
              className="agent-approval-button is-primary"
              disabled={!!submitting}
              onClick={() => void resolve(true, 'once')}
              type="button"
            >
              {t.agent.composer.approveOnce}
            </button>
            {approval.alwaysAllowRule ? (
              <button
                className="agent-approval-button"
                disabled={!!submitting}
                onClick={() => void resolve(true, 'always')}
                type="button"
              >
                {t.agent.composer.alwaysAllow}
              </button>
            ) : null}
            <button
              className="agent-approval-button"
              disabled={!!submitting}
              onClick={() => void stopAsking()}
              type="button"
            >
              {t.agent.composer.stopAsking}
            </button>
            <button
              className="agent-approval-button"
              disabled={!!submitting}
              onClick={() => void resolve(false, 'once')}
              type="button"
            >
              {t.agent.composer.denyOnce}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AgentUserQuestionCard({
  pendingQuestion,
  onResolve,
}: {
  pendingQuestion: AgentUserQuestionPendingView;
  onResolve: (requestId: string, result: AskUserQuestionResult) => Promise<boolean>;
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<Record<string, { selectedOptionIds: string[]; text: string }>>(() => (
    Object.fromEntries(pendingQuestion.request.questions.map((question) => [question.id, {
      selectedOptionIds: [],
      text: '',
    }]))
  ));

  function updateSelection(questionId: string, optionId: string, checked: boolean, multi: boolean) {
    setDraft((current) => {
      const value = current[questionId] ?? { selectedOptionIds: [], text: '' };
      const selectedOptionIds = multi
        ? checked
          ? [...new Set([...value.selectedOptionIds, optionId])]
          : value.selectedOptionIds.filter((id) => id !== optionId)
        : checked ? [optionId] : [];
      return { ...current, [questionId]: { ...value, selectedOptionIds } };
    });
  }

  function updateText(questionId: string, text: string) {
    setDraft((current) => {
      const value = current[questionId] ?? { selectedOptionIds: [], text: '' };
      return { ...current, [questionId]: { ...value, text } };
    });
  }

  const canSubmit = pendingQuestion.request.questions.every((question) => {
    if (question.required === false) return true;
    const value = draft[question.id];
    if (!value) return false;
    if (question.type === 'free_text') return value.text.trim().length > 0;
    return value.selectedOptionIds.length > 0 || (question.allowOther && value.text.trim().length > 0);
  });

  async function submit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await onResolve(pendingQuestion.requestId, {
        requestId: pendingQuestion.requestId,
        answers: pendingQuestion.request.questions.map((question) => {
          const value = draft[question.id] ?? { selectedOptionIds: [], text: '' };
          return {
            questionId: question.id,
            selectedOptionIds: question.type === 'free_text' ? undefined : value.selectedOptionIds,
            text: value.text.trim() || undefined,
          };
        }),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="agent-question-card" role="group" aria-label={t.agent.composer.userQuestionTitle}>
      <div className="agent-question-title">{t.agent.composer.userQuestionTitle}</div>
      {pendingQuestion.request.questions.map((question) => {
        const value = draft[question.id] ?? { selectedOptionIds: [], text: '' };
        const multi = question.type === 'multi_choice';
        return (
          <div className="agent-question-item" key={question.id}>
            {question.header ? <div className="agent-question-header">{question.header}</div> : null}
            <div className="agent-question-prompt">{question.question}</div>
            {question.options?.length ? (
              <div className="agent-question-options">
                {question.options.map((option) => (
                  <label className="agent-question-option" key={option.id}>
                    <input
                      checked={value.selectedOptionIds.includes(option.id)}
                      name={`agent-question-${pendingQuestion.requestId}-${question.id}`}
                      onChange={(event) => updateSelection(question.id, option.id, event.currentTarget.checked, multi)}
                      type={multi ? 'checkbox' : 'radio'}
                    />
                    <span>
                      <span className="agent-question-option-label">{option.label}</span>
                      {option.description ? <span className="agent-question-option-description">{option.description}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            {question.type === 'free_text' || question.allowOther ? (
              <textarea
                className="agent-question-text"
                onChange={(event) => updateText(question.id, event.currentTarget.value)}
                placeholder={question.type === 'free_text' ? t.agent.composer.userQuestionAnswerPlaceholder : t.agent.composer.userQuestionOtherPlaceholder}
                rows={question.type === 'free_text' ? 3 : 2}
                value={value.text}
              />
            ) : null}
          </div>
        );
      })}
      <div className="agent-question-actions">
        <button
          className="agent-approval-button is-primary"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
          type="button"
        >
          {pendingQuestion.request.submitLabel ?? t.agent.composer.userQuestionSubmit}
        </button>
      </div>
    </div>
  );
}

async function fileToAttachment(
  file: File,
  nativePath: string,
  prepared?: PreparedPathlessAttachmentBytes | null,
): Promise<ComposerAttachment> {
  const mimeType = file.type || inferMimeType(file.name);
  const inlineImageMimeType = normalizeInlineImageMimeType(mimeType);
  const id = createAttachmentId();
  const name = file.name || (mimeType.startsWith('image/') ? 'image' : 'attachment.txt');

  if (inlineImageMimeType) {
    if (file.size > MAX_RAW_INLINE_IMAGE_BYTES) {
      throw new Error(`${name} is larger than ${formatBytes(MAX_RAW_INLINE_IMAGE_BYTES)} and cannot be attached as inline image input.`);
    }
    const staged = nativePath
      ? null
      : await stageAttachmentFile(file, { mimeType, name }, prepared ?? undefined);
    const inlineImage = await readInlineImageForModel(file, inlineImageMimeType);
    const previewUrl = URL.createObjectURL(file);
    return {
      id,
      kind: 'image',
      name,
      mimeType: inlineImage.mimeType,
      sizeBytes: file.size,
      dataBase64: inlineImage.dataBase64,
      path: nativePath || staged?.path,
      previewUrl,
      ...(staged?.sha256 ? { sha256: staged.sha256 } : {}),
      thumbnailDataUrl: previewUrl,
    };
  }

  if (nativePath) {
    return {
      id,
      kind: 'file',
      name,
      mimeType,
      sizeBytes: file.size,
      path: nativePath,
    };
  }

  const staged = await stageAttachmentFile(file, { mimeType, name }, prepared ?? undefined);
  return {
    id,
    kind: 'file',
    name: staged.name || name,
    mimeType: staged.mimeType || mimeType,
    sizeBytes: staged.sizeBytes,
    path: staged.path,
    sha256: staged.sha256,
  };
}

async function pickedLocalFileToAttachment(file: PickedLocalFileAttachment): Promise<ComposerAttachment> {
  const mimeType = file.mimeType || inferMimeType(file.name);
  const inlineImageMimeType = normalizeInlineImageMimeType(mimeType);
  const id = createAttachmentId();
  const name = file.name || 'attachment';

  if (inlineImageMimeType) {
    if (file.sizeBytes > MAX_RAW_INLINE_IMAGE_BYTES) {
      throw new Error(`${name} is larger than ${formatBytes(MAX_RAW_INLINE_IMAGE_BYTES)} and cannot be attached as inline image input.`);
    }
    if (!file.imageDataBase64) {
      throw new Error(`${name} could not be loaded for inline image input.`);
    }
    const imageFile = fileFromBase64(file.imageDataBase64, name, inlineImageMimeType, file.lastModified);
    const inlineImage = await readInlineImageForModel(imageFile, inlineImageMimeType);
    const previewUrl = URL.createObjectURL(imageFile);
    return {
      id,
      kind: 'image',
      name,
      mimeType: inlineImage.mimeType,
      sizeBytes: file.sizeBytes,
      dataBase64: inlineImage.dataBase64,
      path: file.path,
      previewUrl,
      thumbnailDataUrl: file.thumbnailDataUrl ?? previewUrl,
    };
  }

  return {
    id,
    kind: 'file',
    name,
    mimeType,
    sizeBytes: file.sizeBytes,
    iconDataUrl: file.iconDataUrl,
    path: file.path,
    thumbnailDataUrl: file.thumbnailDataUrl,
  };
}

async function stageAttachmentFile(
  file: File,
  metadata: { mimeType: string; name: string },
  prepared?: PreparedPathlessAttachmentBytes,
): Promise<{ path: string; name: string; mimeType: string; sizeBytes: number; sha256: string }> {
  const name = metadata.name || file.name || 'attachment';
  if (file.size > MAX_STAGED_ATTACHMENT_BYTES) {
    throw new Error(`${name} is larger than ${formatBytes(MAX_STAGED_ATTACHMENT_BYTES)} and cannot be staged for agent access.`);
  }
  if (!window.lin?.stageAttachment) {
    throw new Error('Attachment staging is not available in this window.');
  }
  const bytes = prepared ?? await preparePathlessAttachmentBytes(file);
  const staged = await window.lin.stageAttachment({
    bytes: bytes.bytes,
    mimeType: metadata.mimeType || file.type || 'application/octet-stream',
    name,
  });
  return {
    ...staged,
    sha256: bytes.sha256,
  };
}

async function preparePathlessAttachmentBytes(file: File): Promise<PreparedPathlessAttachmentBytes> {
  const mimeType = file.type || inferMimeType(file.name);
  const name = file.name || (mimeType.startsWith('image/') ? 'image' : 'attachment.txt');
  if (normalizeInlineImageMimeType(mimeType) && file.size > MAX_RAW_INLINE_IMAGE_BYTES) {
    throw new Error(`${name} is larger than ${formatBytes(MAX_RAW_INLINE_IMAGE_BYTES)} and cannot be attached as inline image input.`);
  }
  if (file.size > MAX_STAGED_ATTACHMENT_BYTES) {
    throw new Error(`${name} is larger than ${formatBytes(MAX_STAGED_ATTACHMENT_BYTES)} and cannot be staged for agent access.`);
  }
  const bytes = await file.arrayBuffer();
  return {
    bytes,
    sha256: await sha256ArrayBuffer(bytes),
  };
}

async function sha256ArrayBuffer(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return '';
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function toAttachmentPayload(attachment: ComposerAttachment): AgentMessageAttachmentInput {
  if (attachment.kind === 'image') {
    const {
      fingerprint: _fingerprint,
      iconDataUrl: _iconDataUrl,
      previewUrl: _previewUrl,
      sha256: _sha256,
      thumbnailDataUrl: _thumbnailDataUrl,
      ...payload
    } = attachment;
    return payload;
  }
  const {
    fingerprint: _fingerprint,
    iconDataUrl: _iconDataUrl,
    previewUrl: _previewUrl,
    sha256: _sha256,
    thumbnailDataUrl: _thumbnailDataUrl,
    ...payload
  } = attachment;
  return payload;
}

function attachmentToFileReference(attachment: ComposerAttachment): AgentComposerFileReference {
  return {
    attachmentId: attachment.id,
    entryKind: attachment.mimeType === 'inode/directory' ? 'directory' : 'file',
    iconDataUrl: attachment.iconDataUrl,
    name: attachment.name,
    ...('path' in attachment && attachment.path ? { path: attachment.path } : {}),
    ref: attachment.ref ?? sanitizeFileReferenceRef(attachment.name),
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    thumbnailDataUrl: attachment.thumbnailDataUrl,
  };
}

function withAttachmentRefs(
  attachments: readonly ComposerAttachment[],
  existingAttachments: readonly ComposerAttachment[],
): ComposerAttachment[] {
  const usedRefs = new Set<string>();
  for (const attachment of existingAttachments) {
    if (attachment.ref) usedRefs.add(attachment.ref);
  }
  return attachments.map((attachment) => {
    const base = sanitizeFileReferenceRef(attachment.ref ?? attachment.name);
    const ref = uniqueAttachmentRef(base, usedRefs);
    usedRefs.add(ref);
    return { ...attachment, ref };
  });
}

function uniqueAttachmentRef(base: string, usedRefs: Set<string>): string {
  if (!usedRefs.has(base)) return base;
  const extensionMatch = base.match(/^(.*?)(\.[^./\\]+)?$/u);
  const stem = extensionMatch?.[1] || base;
  const extension = extensionMatch?.[2] || '';
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!usedRefs.has(candidate)) return candidate;
  }
}

function inferMimeType(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.gif')) return 'image/gif';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';
  if (lowerName.endsWith('.avif')) return 'image/avif';
  if (lowerName.endsWith('.bmp')) return 'image/bmp';
  if (lowerName.endsWith('.heic')) return 'image/heic';
  if (lowerName.endsWith('.tif') || lowerName.endsWith('.tiff')) return 'image/tiff';
  if (lowerName.endsWith('.pdf')) return 'application/pdf';
  if (lowerName.endsWith('.doc')) return 'application/msword';
  if (lowerName.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lowerName.endsWith('.json')) return 'application/json';
  if (lowerName.endsWith('.xml')) return 'application/xml';
  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) return 'application/yaml';
  if (lowerName.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (lowerName.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lowerName.endsWith('.key') || lowerName.endsWith('.keynote')) return 'application/vnd.apple.keynote';
  if (lowerName.endsWith('.pages')) return 'application/vnd.apple.pages';
  if (lowerName.endsWith('.odp')) return 'application/vnd.oasis.opendocument.presentation';
  if (lowerName.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lowerName.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lowerName.endsWith('.numbers')) return 'application/vnd.apple.numbers';
  if ([...TEXT_ATTACHMENT_EXTENSIONS].some((extension) => lowerName.endsWith(extension))) return 'text/plain';
  return 'application/octet-stream';
}

function normalizeInlineImageMimeType(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(normalized)) return normalized;
  return null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name || 'attachment'}.`));
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error(`Could not read ${file.name || 'attachment'} as an image.`));
    };
    reader.readAsDataURL(file);
  });
}

async function readInlineImageForModel(file: File, mimeType: string): Promise<{ dataBase64: string; mimeType: string }> {
  const dataUrl = await readFileAsDataUrl(file);
  const original = dataUrlToInlineImage(dataUrl, mimeType);
  if (original.dataBase64.length <= MAX_INLINE_IMAGE_BASE64_CHARS) return original;
  if (mimeType === 'image/gif') {
    throw new Error(`${file.name || 'Image'} is too large for inline model vision input.`);
  }
  return resizeInlineImageForModel(file);
}

async function resizeInlineImageForModel(file: File): Promise<{ dataBase64: string; mimeType: string }> {
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
        const dataUrl = await renderBitmapToDataUrl(bitmap, width, height, 'image/jpeg', quality);
        const candidate = dataUrlToInlineImage(dataUrl, 'image/jpeg');
        if (candidate.dataBase64.length <= MAX_INLINE_IMAGE_BASE64_CHARS) return candidate;
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

function renderBitmapToDataUrl(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  mimeType: string,
  quality: number,
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not prepare image for model input.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not encode image for model input.'));
        return;
      }
      readFileAsDataUrl(new File([blob], 'image.jpg', { type: mimeType })).then(resolve, reject);
    }, mimeType, quality);
  });
}

function dataUrlToInlineImage(dataUrl: string, fallbackMimeType: string): { dataBase64: string; mimeType: string } {
  const commaIndex = dataUrl.indexOf(',');
  const header = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : '';
  const dataBase64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  const mimeType = /^data:([^;]+);/i.exec(header)?.[1] ?? fallbackMimeType;
  return { dataBase64, mimeType };
}

function fileFingerprint(file: File, nativePath: string): string {
  return nativePath
    ? `path:${nativePath}:${file.size}:${file.lastModified}`
    : `blob:${file.name}:${file.size}:${file.lastModified}`;
}

function pickedLocalFileFingerprint(file: PickedLocalFileAttachment): string {
  return `${file.path}:${file.sizeBytes}:${file.lastModified}`;
}

function fileFromBase64(dataBase64: string, name: string, mimeType: string, lastModified: number): File {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], name, { type: mimeType, lastModified });
}

function hasFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function revokeAttachmentPreview(attachment: ComposerAttachment) {
  if (!attachment.previewUrl?.startsWith('blob:')) return;
  URL.revokeObjectURL(attachment.previewUrl);
}

function createAttachmentId(): string {
  return globalThis.crypto && 'randomUUID' in globalThis.crypto
    ? globalThis.crypto.randomUUID()
    : `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function duplicateMessage(count: number, labels: Messages['agent']['composer']): string | null {
  if (count <= 0) return null;
  return labels.skippedDuplicates({ count });
}

function overflowMessage(count: number, labels: Messages['agent']['composer']): string | null {
  if (count <= 0) return null;
  return labels.skippedOverflow({ count, max: MAX_ATTACHMENTS });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function getModelChoices(
  settings: AgentProviderSettingsView | null,
  activeProvider: AgentProviderConfigView | null,
): ComposerModelChoice[] {
  if (!settings) return [];
  const usableProviderIds = new Set(
    settings.providers
      .filter((provider) => isProviderUsable(settings, provider))
      .map((provider) => provider.providerId),
  );
  const choices = settings.availableProviders
    .filter((provider) => usableProviderIds.has(provider.providerId))
    .flatMap((provider) =>
      provider.models.map((model) => ({ ...model, providerId: provider.providerId })),
    );
  if (!activeProvider) return choices;
  if (choices.some((model) => model.providerId === activeProvider.providerId && model.id === activeProvider.modelId)) {
    return choices;
  }
  return [{
    id: activeProvider.modelId,
    name: activeProvider.modelId,
    providerId: activeProvider.providerId,
    reasoning: activeProvider.reasoningLevel !== 'off',
    supportedThinkingLevels: [activeProvider.reasoningLevel],
    contextWindow: 0,
    maxTokens: 0,
  }, ...choices];
}

function shortenModelName(name: string): string {
  let result = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of VENDOR_PREFIXES) {
      if (result.startsWith(prefix)) {
        result = result.slice(prefix.length);
        changed = true;
        break;
      }
    }
  }
  return result;
}
