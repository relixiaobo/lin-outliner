import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import type {
  AgentCapabilityRequestView,
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
import { agentMentionToken } from '../../../core/agentChannel';
import {
  acknowledgeAgentComposerNodeReferenceRequest,
  onAgentComposerNodeReferenceRequest,
  type AgentComposerNodeReferenceRequest,
} from '../../agent/agentReveal';
import type {
  AgentProviderSettingsView,
  AgentSlashCommandView,
  NodeId,
} from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import {
  AgentComposerAttachmentButton,
  AgentComposerPrimaryAction,
  AgentComposerToolbar,
  AgentQueuedSteer,
} from './AgentComposerControls';
import { AgentComposerModelControl } from './AgentComposerModelControl';
import { resolveUsableActiveProvider } from './providerCatalog';
import { BackIcon, ICON_SIZE } from '../icons';
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
  onResolveCapability: (
    requestId: string,
    resolution: 'granted' | 'cancelled',
  ) => Promise<boolean>;
  onResolveUserQuestion: (requestId: string, result: AskUserQuestionResult) => Promise<boolean>;
  pendingCapability: AgentCapabilityRequestView | null;
  pendingUserQuestion: AgentUserQuestionPendingView | null;
  settings: AgentProviderSettingsView | null;
  /** Current model selection of the conversation's editable agent (Neva), for the quick chip. */
  agentModel?: string;
  /** Current reasoning effort of the editable agent, for the quick chip. */
  agentEffort?: string;
  /** Persist a model change to the editable agent's profile (applies on the next turn). */
  onModelChange?: (next: string) => void;
  /** Persist an effort change to the editable agent's profile. */
  onEffortChange?: (next: string) => void;
  slashCommands: AgentSlashCommandView[];
  steeringNote: string | null;
}

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
  onNodeReferenceOpen,
  onCancelSteer,
  onResolveCapability,
  onResolveUserQuestion,
  onSend,
  onSteer,
  onStop,
  pendingCapability,
  pendingUserQuestion,
  settings,
  agentModel,
  agentEffort,
  onModelChange,
  onEffortChange,
  slashCommands,
  steeringNote,
}: AgentComposerProps) {
  const t = useT();
  const [draft, setDraft] = useState<AgentComposerDraft>(EMPTY_DRAFT);
  const [sending, setSending] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [recentLocalFiles, setRecentLocalFiles] = useState<AgentComposerLocalFileCandidate[]>([]);
  const editorRef = useRef<AgentComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<AgentComposerDraft>(EMPTY_DRAFT);
  const dragDepthRef = useRef(0);
  const handledFocusTokenRef = useRef(0);
  const sendingRef = useRef(false);
  const [pendingNodeReferenceRequests, setPendingNodeReferenceRequests] = useState<AgentComposerNodeReferenceRequest[]>([]);
  const {
    attachments,
    attachmentsRef,
    attachmentError,
    attachLocalFileCandidate,
    addFilesInline,
    detachAttachments,
    handleAttachmentClick,
    handleFileInputChange,
    previewLocalFile,
    pruneUnreferencedAttachments,
    restoreAttachments,
    searchLocalFiles,
    setAttachmentError,
  } = useAgentComposerAttachmentManager({
    editorRef,
    fileInputRef,
    onLocalFileSelected: (file) => {
      setRecentLocalFiles((current) => [file, ...current.filter((item) => item.id !== file.id)].slice(0, 8));
    },
  });
  const hasDraft = !draft.empty;

  useEffect(() => {
    if (focusToken <= 0 || handledFocusTokenRef.current >= focusToken) return;
    handledFocusTokenRef.current = focusToken;
    if (pendingCapability || pendingUserQuestion) return;
    const frame = window.requestAnimationFrame(() => editorRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusToken, pendingCapability, pendingUserQuestion]);
  useEffect(() => onAgentComposerNodeReferenceRequest((request) => {
    setPendingNodeReferenceRequests((current) => (
      current.includes(request) ? current : [...current, request]
    ));
  }), []);
  useEffect(() => {
    if (pendingCapability || pendingUserQuestion || pendingNodeReferenceRequests.length === 0) return undefined;
    const requests = pendingNodeReferenceRequests;
    const frame = window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      for (const request of requests) {
        if (index.byId.has(request.nodeId)) {
          editor.insertNodeReference({ nodeId: request.nodeId, title: request.title });
        }
        acknowledgeAgentComposerNodeReferenceRequest(request);
      }
      setPendingNodeReferenceRequests((current) => current.filter((request) => !requests.includes(request)));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [index.byId, pendingCapability, pendingNodeReferenceRequests, pendingUserQuestion]);
  const hasAttachments = attachments.length > 0;
  const activeProvider = settings ? resolveUsableActiveProvider(settings) ?? null : null;
  // No usable provider once settings have LOADED → block send and explain why.
  // While settings are still loading (settings === null) stay neutral, so a
  // key-holding user's send button never disables during the load window.
  const providerBlocksSend = settings !== null && !activeProvider;
  // In queue-send (Channel) mode the steer pathway does not exist: a running
  // round never switches the composer into steer submit/placeholder.
  const steering = isStreaming && !queueSends;
  const canSubmit = (pendingCapability || pendingUserQuestion ? false : steering
    ? hasDraft && !hasAttachments
    : !sending && (hasDraft || hasAttachments)) && !providerBlocksSend;

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
        restoredAttachments = true;
        restoreAttachments(sentAttachments);
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

  function handleDraftChange(nextDraft: AgentComposerDraft) {
    if (!sendingRef.current) pruneUnreferencedAttachments(nextDraft);
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }

  function restoreDraftIfUnchanged(snapshot: AgentComposerEditorSnapshot | null) {
    if (!snapshot || !draftRef.current.empty) return;
    editorRef.current?.restore(snapshot);
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
        {pendingCapability ? (
          <AgentCapabilityCard
            capability={pendingCapability}
            key={pendingCapability.requestId}
            onResolve={onResolveCapability}
          />
        ) : pendingUserQuestion ? (
          <AgentUserQuestionCard
            key={pendingUserQuestion.requestId}
            currentNodeId={currentNodeId}
            index={index}
            onNodeReferenceOpen={onNodeReferenceOpen}
            pendingQuestion={pendingUserQuestion}
            onResolve={onResolveUserQuestion}
            recentLocalFiles={recentLocalFiles}
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
              modelControl={onModelChange && onEffortChange ? (
                <AgentComposerModelControl
                  settings={settings}
                  model={agentModel ?? ''}
                  effort={agentEffort ?? ''}
                  disabled={!settings}
                  onModelChange={onModelChange}
                  onEffortChange={onEffortChange}
                />
              ) : undefined}
              onAttachmentClick={() => void handleAttachmentClick()}
              onFileInputChange={handleFileInputChange}
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

function useAgentComposerAttachmentManager({
  allowAttachments = true,
  editorRef,
  fileInputRef,
  initialAttachments = [],
  onLocalFileSelected,
  revokeAttachmentsOnUnmount = true,
}: {
  allowAttachments?: boolean;
  editorRef: { current: AgentComposerEditorHandle | null };
  fileInputRef: { current: HTMLInputElement | null };
  initialAttachments?: readonly ComposerAttachment[];
  onLocalFileSelected?: (file: AgentComposerLocalFileCandidate) => void;
  revokeAttachmentsOnUnmount?: boolean;
}) {
  const t = useT();
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => [...initialAttachments]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    if (!revokeAttachmentsOnUnmount) return;
    for (const attachment of attachmentsRef.current) {
      revokeAttachmentPreview(attachment);
    }
  }, [revokeAttachmentsOnUnmount]);

  // Attachment errors are transient hints; auto-clear them to avoid stale banners.
  useEffect(() => {
    if (!attachmentError) return;
    const timer = window.setTimeout(() => setAttachmentError(null), ATTACHMENT_ERROR_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [attachmentError]);

  async function addFiles(files: FileList | File[]): Promise<ComposerAttachment[]> {
    if (!allowAttachments) {
      setAttachmentError(t.agent.composer.attachmentsNotAllowed);
      return [];
    }
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
    if (!allowAttachments) {
      setAttachmentError(t.agent.composer.attachmentsNotAllowed);
      return [];
    }
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

  function restoreAttachments(nextAttachments: ComposerAttachment[]) {
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);
  }

  function pruneUnreferencedAttachments(nextDraft: AgentComposerDraft): ComposerAttachment[] {
    if (attachmentsRef.current.length === 0) return attachmentsRef.current;
    const referencedAttachmentIds = new Set(nextDraft.fileRefs.map((fileRef) => fileRef.attachmentId));
    const nextAttachments = attachmentsRef.current.filter((attachment) => referencedAttachmentIds.has(attachment.id));
    if (nextAttachments.length === attachmentsRef.current.length) return attachmentsRef.current;
    for (const attachment of attachmentsRef.current) {
      if (!referencedAttachmentIds.has(attachment.id)) revokeAttachmentPreview(attachment);
    }
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);
    return nextAttachments;
  }

  async function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (files.length === 0) return;
    await addFilesInline(files);
  }

  async function handleAttachmentClick() {
    if (!allowAttachments) {
      setAttachmentError(t.agent.composer.attachmentsNotAllowed);
      return;
    }
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
    if (!allowAttachments) {
      setAttachmentError(t.agent.composer.attachmentsNotAllowed);
      return null;
    }
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
    if (refs.length > 0) onLocalFileSelected?.(file);
    return refs[0] ?? null;
  }

  return {
    attachments,
    attachmentsRef,
    attachmentError,
    addFilesInline,
    attachLocalFileCandidate,
    detachAttachments,
    handleAttachmentClick,
    handleFileInputChange,
    previewLocalFile,
    pruneUnreferencedAttachments,
    restoreAttachments,
    searchLocalFiles,
    setAttachmentError,
  };
}

function AgentCapabilityCard({
  capability,
  onResolve,
}: {
  capability: AgentCapabilityRequestView;
  onResolve: (
    requestId: string,
    resolution: 'granted' | 'cancelled',
  ) => Promise<boolean>;
}) {
  const t = useT();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [submitting, setSubmitting] = useState<'grant' | 'cancel' | null>(null);

  async function resolve(resolution: 'granted' | 'cancelled') {
    if (submitting) return;
    setSubmitting(resolution === 'granted' ? 'grant' : 'cancel');
    try {
      await onResolve(capability.requestId, resolution);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="agent-capability-card" role="group" aria-label={capability.title}>
      <div className="agent-capability-copy">
        <div className="agent-capability-title">{capability.title}</div>
        {capability.requestedByAgentId ? (
          <div className="agent-capability-attribution">
            {t.agent.composer.capabilityRequestedBy({
              agent: agentMentionToken(capability.requestedByAgentId),
            })}
          </div>
        ) : null}
        <div className="agent-capability-target" title={capability.target}>{capability.target}</div>
        <button
          aria-expanded={detailsOpen}
          className="agent-capability-details-toggle"
          onClick={() => setDetailsOpen((open) => !open)}
          type="button"
        >
          {detailsOpen ? t.agent.composer.hideDetails : t.agent.composer.showDetails}
        </button>
        {detailsOpen ? (
          <div className="agent-capability-details-panel">
            {capability.details.map((detail) => (
              <div className="agent-capability-detail" key={`${detail.label}:${detail.value}`}>
                <span className="agent-capability-detail-label">{detail.label}</span>
                <span className="agent-capability-detail-value">{detail.value}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="agent-capability-actions">
        <>
          <button
            className="agent-request-button is-primary"
            disabled={!!submitting}
            onClick={() => void resolve('granted')}
            type="button"
          >
            {t.agent.composer.grantFolderAccess}
          </button>
          <button
            className="agent-request-button"
            disabled={!!submitting}
            onClick={() => void resolve('cancelled')}
            type="button"
          >
            {t.agent.composer.cancelFolderAccess}
          </button>
        </>
      </div>
    </div>
  );
}

function AgentUserQuestionCard({
  currentNodeId,
  index,
  onNodeReferenceOpen,
  pendingQuestion,
  onResolve,
  recentLocalFiles,
}: {
  currentNodeId: NodeId | null;
  index: DocumentIndex;
  onNodeReferenceOpen: AgentNodeReferenceOpenHandler;
  pendingQuestion: AgentUserQuestionPendingView;
  onResolve: (requestId: string, result: AskUserQuestionResult) => Promise<boolean>;
  recentLocalFiles: readonly AgentComposerLocalFileCandidate[];
}) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [draft, setDraft] = useState<Record<string, AgentQuestionAnswerDraft>>(() => (
    Object.fromEntries(pendingQuestion.request.questions.map((question) => [question.id, emptyQuestionAnswerDraft()]))
  ));
  const draftRef = useRef(draft);
  const focusStepOnChangeRef = useRef(false);
  const questionStepRef = useRef<HTMLDivElement>(null);
  const questions = pendingQuestion.request.questions;
  const questionCount = questions.length;
  const currentQuestion = questions[Math.min(currentQuestionIndex, questionCount - 1)];
  const currentValue = currentQuestion
    ? draft[currentQuestion.id] ?? emptyQuestionAnswerDraft()
    : emptyQuestionAnswerDraft();
  const currentQuestionIsReady = currentQuestion
    ? isQuestionAnswerComplete(currentQuestion, currentValue)
    : false;
  const isLastStep = currentQuestionIndex >= questionCount - 1;

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => () => {
    const revoked = new Set<string>();
    for (const value of Object.values(draftRef.current)) {
      for (const attachment of value.attachments) {
        const key = attachment.previewUrl ?? attachment.id;
        if (revoked.has(key)) continue;
        revoked.add(key);
        revokeAttachmentPreview(attachment);
      }
    }
  }, []);

  useEffect(() => {
    if (currentQuestionIndex < questionCount) return;
    setCurrentQuestionIndex(Math.max(0, questionCount - 1));
  }, [currentQuestionIndex, questionCount]);

  useEffect(() => {
    if (!focusStepOnChangeRef.current) return;
    focusStepOnChangeRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const step = questionStepRef.current;
      if (!step) return;
      const focusTarget = step.querySelector<HTMLElement>(
        '.agent-question-option input:not(:disabled), .agent-question-editor-shell .ProseMirror',
      );
      (focusTarget ?? step).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentQuestionIndex]);

  function updateSelection(questionId: string, optionId: string, checked: boolean, multi: boolean) {
    setDraft((current) => {
      const value = current[questionId] ?? emptyQuestionAnswerDraft();
      const selectedOptionIds = multi
        ? checked
          ? [...new Set([...value.selectedOptionIds, optionId])]
          : value.selectedOptionIds.filter((id) => id !== optionId)
        : checked ? [optionId] : [];
      return { ...current, [questionId]: { ...value, selectedOptionIds } };
    });
  }

  function updateAnswerDraft(questionId: string, update: Partial<AgentQuestionAnswerDraft>) {
    setDraft((current) => {
      const value = current[questionId] ?? emptyQuestionAnswerDraft();
      return { ...current, [questionId]: { ...value, ...update } };
    });
  }

  function focusAfterStepChange() {
    focusStepOnChangeRef.current = true;
  }

  function goBack() {
    if (currentQuestionIndex === 0 || submitting) return;
    focusAfterStepChange();
    setCurrentQuestionIndex((current) => Math.max(0, current - 1));
  }

  function goNext() {
    if (!currentQuestionIsReady || isLastStep || submitting) return;
    focusAfterStepChange();
    setCurrentQuestionIndex((current) => Math.min(questionCount - 1, current + 1));
  }

  async function submit() {
    if (!currentQuestionIsReady || !isLastStep || submitting) return;
    setSubmitting(true);
    try {
      await onResolve(pendingQuestion.requestId, {
        requestId: pendingQuestion.requestId,
        outcome: 'answered',
        answers: pendingQuestion.request.questions.map((question) => {
          const value = draft[question.id] ?? emptyQuestionAnswerDraft();
          const answer = {
            questionId: question.id,
            selectedOptionIds: question.type === 'free_text' ? undefined : value.selectedOptionIds,
            text: value.text.trim() || undefined,
            nodeRefs: value.nodeRefs.length > 0
              ? value.nodeRefs.map((ref) => ({ nodeId: ref.nodeId, label: ref.title }))
              : undefined,
            fileRefs: value.fileRefs.length > 0 ? value.fileRefs : undefined,
            attachments: value.attachments.length > 0 ? value.attachments.map(toAttachmentPayload) : undefined,
          };
          return answer;
        }),
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function discuss() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onResolve(pendingQuestion.requestId, {
        requestId: pendingQuestion.requestId,
        outcome: 'discussed',
        answers: [],
        discuss: {
          message: t.agent.composer.userQuestionDiscussMessage,
        },
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (!currentQuestion) return null;

  const multi = currentQuestion.type === 'multi_choice';
  const allowReferences = currentQuestion.allowReferences ?? currentQuestion.type === 'free_text';
  const allowAttachments = (currentQuestion.allowAttachments ?? currentQuestion.type === 'free_text') || allowReferences;
  const usesRichAnswer = currentQuestion.type === 'free_text'
    || currentQuestion.allowOther
    || allowReferences
    || allowAttachments;
  const progress = questionCount > 1
    ? t.agent.composer.userQuestionProgress({
        current: currentQuestionIndex + 1,
        total: questionCount,
      })
    : null;

  return (
    <div className="agent-question-card" role="group" aria-label={t.agent.composer.userQuestionTitle}>
      <div className="agent-question-heading">
        <div className="agent-question-title">
          {t.agent.composer.userQuestionTitle}
          {progress ? (
            <>
              <span className="agent-question-title-separator" aria-hidden="true">·</span>
              <span className="agent-question-progress">{progress}</span>
            </>
          ) : null}
        </div>
        {currentQuestionIndex > 0 ? (
          <button
            aria-label={t.agent.composer.userQuestionBack}
            className="agent-question-back-button"
            disabled={submitting}
            onClick={goBack}
            title={t.agent.composer.userQuestionBack}
            type="button"
          >
            <BackIcon aria-hidden="true" size={ICON_SIZE.menu} strokeWidth={2} />
          </button>
        ) : null}
      </div>
      <div
        ref={questionStepRef}
        className="agent-question-item"
        key={currentQuestion.id}
        tabIndex={-1}
      >
        {currentQuestion.header ? <div className="agent-question-header">{currentQuestion.header}</div> : null}
        <div className="agent-question-prompt">{currentQuestion.question}</div>
        {currentQuestion.options?.length ? (
          <div className="agent-question-options">
            {currentQuestion.options.map((option) => (
              <label className="agent-question-option" key={option.id}>
                <input
                  checked={currentValue.selectedOptionIds.includes(option.id)}
                  disabled={submitting}
                  name={`agent-question-${pendingQuestion.requestId}-${currentQuestion.id}`}
                  onChange={(event) => updateSelection(currentQuestion.id, option.id, event.currentTarget.checked, multi)}
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
        {usesRichAnswer ? (
          <AgentQuestionAnswerEditor
            allowAttachments={allowAttachments}
            allowReferences={allowReferences}
            currentNodeId={currentNodeId}
            index={index}
            onChange={(update) => updateAnswerDraft(currentQuestion.id, update)}
            onNodeReferenceOpen={onNodeReferenceOpen}
            placeholder={currentQuestion.type === 'free_text' ? t.agent.composer.userQuestionAnswerPlaceholder : t.agent.composer.userQuestionOtherPlaceholder}
            recentLocalFiles={recentLocalFiles}
            value={currentValue}
          />
        ) : null}
      </div>
      <div className="agent-question-actions">
        <button
          className="agent-question-discuss-button"
          disabled={submitting}
          onClick={() => void discuss()}
          type="button"
        >
          {t.agent.composer.userQuestionDiscuss}
        </button>
        <div className="agent-question-nav-actions">
          {isLastStep ? (
            <button
              className="agent-request-button is-primary"
              disabled={!currentQuestionIsReady || submitting}
              onClick={() => void submit()}
              type="button"
            >
              {pendingQuestion.request.submitLabel ?? t.agent.composer.userQuestionSubmit}
            </button>
          ) : (
            <button
              className="agent-request-button is-primary"
              disabled={!currentQuestionIsReady || submitting}
              onClick={goNext}
              type="button"
            >
              {t.agent.composer.userQuestionNext}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface AgentQuestionAnswerDraft {
  editorSnapshot: AgentComposerEditorSnapshot | null;
  selectedOptionIds: string[];
  text: string;
  nodeRefs: AgentComposerNodeReference[];
  fileRefs: AgentComposerFileReference[];
  attachments: ComposerAttachment[];
}

function emptyQuestionAnswerDraft(): AgentQuestionAnswerDraft {
  return {
    editorSnapshot: null,
    selectedOptionIds: [],
    text: '',
    nodeRefs: [],
    fileRefs: [],
    attachments: [],
  };
}

function hasQuestionAnswerDraftContent(value: AgentQuestionAnswerDraft): boolean {
  return value.text.trim().length > 0
    || value.nodeRefs.length > 0
    || value.fileRefs.length > 0
    || value.attachments.length > 0;
}

type AgentQuestionView = AgentUserQuestionPendingView['request']['questions'][number];

function isQuestionAnswerComplete(
  question: AgentQuestionView,
  value: AgentQuestionAnswerDraft,
): boolean {
  if (question.required === false) return true;
  return (question.type !== 'free_text' && value.selectedOptionIds.length > 0)
    || hasQuestionAnswerDraftContent(value);
}

function AgentQuestionAnswerEditor({
  allowAttachments,
  allowReferences,
  currentNodeId,
  index,
  onChange,
  onNodeReferenceOpen,
  placeholder,
  recentLocalFiles,
  value,
}: {
  allowAttachments: boolean;
  allowReferences: boolean;
  currentNodeId: NodeId | null;
  index: DocumentIndex;
  onChange: (update: Partial<AgentQuestionAnswerDraft>) => void;
  onNodeReferenceOpen: AgentNodeReferenceOpenHandler;
  placeholder: string;
  recentLocalFiles: readonly AgentComposerLocalFileCandidate[];
  value: AgentQuestionAnswerDraft;
}) {
  const editorRef = useRef<AgentComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    attachments,
    attachmentsRef,
    attachmentError,
    addFilesInline,
    attachLocalFileCandidate,
    handleAttachmentClick,
    handleFileInputChange,
    previewLocalFile,
    pruneUnreferencedAttachments,
    searchLocalFiles,
  } = useAgentComposerAttachmentManager({
    allowAttachments,
    editorRef,
    fileInputRef,
    initialAttachments: value.attachments,
    revokeAttachmentsOnUnmount: false,
  });

  function emitDraft(nextDraft: AgentComposerDraft, nextAttachments = attachmentsRef.current) {
    onChange({
      editorSnapshot: editorRef.current?.snapshot() ?? value.editorSnapshot,
      text: nextDraft.text,
      nodeRefs: nextDraft.nodeRefs,
      fileRefs: nextDraft.fileRefs,
      attachments: nextAttachments,
    });
  }

  function handleDraftChange(nextDraft: AgentComposerDraft) {
    const nextAttachments = pruneUnreferencedAttachments(nextDraft);
    emitDraft(nextDraft, nextAttachments);
  }

  return (
    <div className="agent-question-answer">
      {attachmentError ? (
        <div className="agent-composer-error" role="status">
          {attachmentError}
        </div>
      ) : null}
      <div className="agent-question-text agent-question-editor-shell">
        <AgentComposerEditor
          ref={editorRef}
          allowFileReferences={allowReferences}
          allowMemberMentions={false}
          allowNodeReferences={allowReferences}
          allowSlashCommands={false}
          currentNodeId={currentNodeId}
          index={index}
          initialSnapshot={value.editorSnapshot}
          initialText={value.text}
          isStreaming={false}
          members={[]}
          onChange={handleDraftChange}
          onFilesPasted={(files) => void addFilesInline(files)}
          onLocalFilePreview={previewLocalFile}
          onLocalFileSearch={searchLocalFiles}
          onLocalFileSelect={attachLocalFileCandidate}
          onNodeReferenceClick={onNodeReferenceOpen}
          recentLocalFiles={recentLocalFiles}
          onStop={() => undefined}
          onSubmit={() => undefined}
          placeholder={placeholder}
          slashCommands={[]}
          submitOnEnter={false}
        />
        {allowAttachments ? (
          <div className="agent-question-answer-toolbar">
            <input
              ref={fileInputRef}
              className="agent-composer-file-input"
              multiple
              onChange={handleFileInputChange}
              type="file"
            />
            <AgentComposerAttachmentButton
              disabled={attachments.length >= MAX_ATTACHMENTS}
              onClick={() => void handleAttachmentClick()}
            />
          </div>
        ) : null}
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
  if (lowerName.endsWith('.epub')) return 'application/epub+zip';
  if (lowerName.endsWith('.doc')) return 'application/msword';
  if (lowerName.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lowerName.endsWith('.json')) return 'application/json';
  if (lowerName.endsWith('.xml')) return 'application/xml';
  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) return 'application/yaml';
  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) return 'text/html';
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
