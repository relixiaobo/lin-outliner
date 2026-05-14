import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { AgentMessageAttachmentInput } from '../../../core/agentTypes';
import type {
  AgentModelOption,
  AgentProviderConfigView,
  AgentProviderSettingsView,
  AgentReasoningLevel,
} from '../../api/types';
import {
  AddIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FileTextIcon,
  ICON_SIZE,
  PencilIcon,
  SendIcon,
  SettingsIcon,
  StopIcon,
  TrashIcon,
} from '../icons';

interface AgentComposerProps {
  isStreaming: boolean;
  onSend: (message: string, attachments?: AgentMessageAttachmentInput[]) => Promise<void>;
  onSteer: (message: string) => Promise<void>;
  onCancelSteer: () => Promise<void>;
  onStop: () => void;
  onModelChange: (providerId: string, modelId: string) => Promise<void>;
  onOpenSettings: () => void;
  onReasoningChange: (reasoningLevel: AgentReasoningLevel) => Promise<void>;
  settings: AgentProviderSettingsView | null;
  steeringNote: string | null;
}

const REASONING_LABELS: Record<AgentReasoningLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
};

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
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_CHARS = 80_000;

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

interface ComposerModelChoice extends AgentModelOption {
  providerId: string;
}

type ComposerAttachment = AgentMessageAttachmentInput & {
  fingerprint?: string;
  previewUrl?: string;
  sha256?: string;
};

export function AgentComposer({
  isStreaming,
  onModelChange,
  onOpenSettings,
  onReasoningChange,
  onCancelSteer,
  onSend,
  onSteer,
  onStop,
  settings,
  steeringNote,
}: AgentComposerProps) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [configSubmitting, setConfigSubmitting] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [moreModelsOpen, setMoreModelsOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const dragDepthRef = useRef(0);
  const sendingRef = useRef(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const hasDraft = value.trim().length > 0;
  const hasAttachments = attachments.length > 0;
  const canSubmit = isStreaming
    ? hasDraft && !hasAttachments
    : !sending && (hasDraft || hasAttachments);
  const activeProvider = getActiveProvider(settings);
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
  const configDisabled = isStreaming || configSubmitting || modelOptions.length === 0;
  const featuredModels = getFeaturedModelChoices(modelOptions, activeProvider);
  const featuredIds = new Set(featuredModels.map((model) => modelKey(model)));
  const moreModels = modelOptions.filter((model) => !featuredIds.has(modelKey(model)));
  const moreModelGroups = groupModelsByProvider(moreModels);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 34), 160)}px`;
  }, [value]);

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

  async function submit() {
    if (!canSubmit) return;
    const message = value.trim();
    const sentAttachments = attachments;
    const outgoingAttachments = sentAttachments.map(toAttachmentPayload);

    if (isStreaming) {
      if (sentAttachments.length > 0) {
        setAttachmentError('Attachments cannot be queued while the agent is running.');
        return;
      }
      setValue('');
      await onSteer(message);
      return;
    }

    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setValue('');
    detachAttachments();
    let restoredAttachments = false;
    try {
      await onSend(message, outgoingAttachments);
    } catch (error) {
      setValue((current) => (current.length === 0 ? message : current));
      if (attachmentsRef.current.length === 0) {
        attachmentsRef.current = sentAttachments;
        restoredAttachments = true;
        setAttachments(sentAttachments);
      }
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!restoredAttachments) {
        for (const attachment of sentAttachments) {
          revokeAttachmentPreview(attachment);
        }
      }
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter((file) => file.size > 0);
    if (incoming.length === 0) return;

    const remainingSlots = MAX_ATTACHMENTS - attachmentsRef.current.length;
    if (remainingSlots <= 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
      return;
    }

    const existingFingerprints = new Set(attachmentsRef.current.map((attachment) => attachment.fingerprint));
    const existingHashes = new Set(attachmentsRef.current.map((attachment) => attachment.sha256));
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
        if (file.size > MAX_ATTACHMENT_BYTES) {
          failures.push(`${file.name || 'Attachment'} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
          continue;
        }
        const fingerprint = fileFingerprint(file);
        if (existingFingerprints.has(fingerprint)) {
          skippedDuplicates += 1;
          continue;
        }
        const sha256 = await sha256File(file);
        if (existingHashes.has(sha256)) {
          skippedDuplicates += 1;
          continue;
        }
        const attachment = await fileToAttachment(file);
        nextAttachments.push({ ...attachment, fingerprint, sha256 });
        existingFingerprints.add(fingerprint);
        existingHashes.add(sha256);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (nextAttachments.length > 0) {
      setAttachments((current) => [...current, ...nextAttachments]);
    }
    setAttachmentError(
      failures[0]
        ?? duplicateMessage(skippedDuplicates)
        ?? overflowMessage(skippedOverflow)
        ?? null,
    );
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed) revokeAttachmentPreview(removed);
      return current.filter((attachment) => attachment.id !== id);
    });
    setAttachmentError(null);
  }

  function detachAttachments() {
    attachmentsRef.current = [];
    setAttachments([]);
    setAttachmentError(null);
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files;
    if (files) void addFiles(files);
    event.currentTarget.value = '';
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = event.clipboardData.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
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
    void addFiles(event.dataTransfer.files);
  }

  async function editSteer() {
    if (!steeringNote) return;
    await onCancelSteer();
    setValue(steeringNote);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    });
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
      : 'Select model';

  return (
    <form
      className="agent-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {steeringNote ? (
        <div className="agent-steer-bubble">
          <div className="agent-steer-actions">
            <button
              aria-label="Edit queued follow-up"
              className="agent-message-action-button"
              onClick={() => void editSteer()}
              title="Edit queued follow-up"
              type="button"
            >
              <PencilIcon size={ICON_SIZE.menu} />
            </button>
            <button
              aria-label="Cancel queued follow-up"
              className="agent-message-action-button"
              onClick={() => void onCancelSteer()}
              title="Cancel queued follow-up"
              type="button"
            >
              <TrashIcon size={ICON_SIZE.menu} />
            </button>
          </div>
          <div className="agent-steer-preview">{steeringNote}</div>
        </div>
      ) : null}
      <div
        className={`agent-composer-surface ${isStreaming ? 'is-streaming' : ''} ${dragActive ? 'is-dragging' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {dragActive ? <div className="agent-composer-drop-overlay">Drop files to attach</div> : null}
        {attachmentError ? <div className="agent-composer-error">{attachmentError}</div> : null}
        {attachments.length > 0 ? (
          <div className="agent-attachment-list">
            {attachments.map((attachment) => (
              <ComposerAttachmentChip
                attachment={attachment}
                key={attachment.id}
                onRemove={() => removeAttachment(attachment.id)}
              />
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          aria-label="Agent message"
          className="agent-composer-input"
          onChange={(event) => setValue(event.target.value)}
          onCompositionEnd={() => setIsComposing(false)}
          onCompositionStart={() => setIsComposing(true)}
          onKeyDown={(event) => {
            if (isStreaming && (event.metaKey || event.ctrlKey) && event.key === '.') {
              event.preventDefault();
              onStop();
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              if (isComposing || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              void submit();
            }
          }}
          onPaste={handlePaste}
          placeholder={
            isStreaming
              ? steeringNote ? 'Append another steer...' : 'Steer the conversation...'
              : 'Ask anything...'
          }
          rows={1}
          value={value}
        />
        <div className="agent-composer-toolbar">
          <input
            ref={fileInputRef}
            className="agent-composer-file-input"
            multiple
            onChange={handleFileInputChange}
            type="file"
          />
          <button
            aria-label="Add attachment"
            className="agent-composer-tool-button"
            disabled={isStreaming || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
            title="Add attachment"
            type="button"
          >
            <AddIcon size={ICON_SIZE.toolbar} />
          </button>

          <div className="agent-composer-spacer" />

          <div className="agent-composer-model" ref={modelMenuRef}>
            <button
              aria-expanded={modelMenuOpen}
              aria-haspopup="menu"
              aria-label="Select model"
              className="agent-composer-model-button"
              disabled={configDisabled || modelOptions.length === 0}
              onClick={() => setModelMenuOpen((open) => !open)}
              title={activeProvider ? `${activeProvider.providerId}/${activeProvider.modelId}` : 'No model configured'}
              type="button"
            >
              <span className="agent-composer-model-name">{modelLabel}</span>
              {supportsReasoning && reasoningEnabled ? (
                <span className="agent-composer-reasoning-chip">{REASONING_LABELS[selectedReasoning]}</span>
              ) : null}
              <ChevronDownIcon size={ICON_SIZE.tiny} />
            </button>

            {modelMenuOpen ? (
              <FloatingComposerMenu
                anchorRef={modelMenuRef}
                layoutKey={`${moreModelsOpen}:${reasoningMenuOpen}:${moreModelGroups.length}:${featuredModels.length}`}
                onClose={() => setModelMenuOpen(false)}
              >
                <div className="agent-composer-model-list">
                  {featuredModels.map((model) => (
                    <ModelMenuItem
                      activeProvider={activeProvider}
                      key={modelKey(model)}
                      model={model}
                      onSelect={() => void changeModel(model)}
                    />
                  ))}
                  {moreModelGroups.length > 0 ? (
                    <>
                      <button
                        aria-expanded={moreModelsOpen}
                        className="agent-composer-more-models"
                        onClick={() => setMoreModelsOpen((open) => !open)}
                        type="button"
                      >
                        <ChevronDownIcon
                          className={moreModelsOpen ? 'is-open' : ''}
                          size={ICON_SIZE.menu}
                        />
                        <span>More models</span>
                      </button>
                      {moreModelsOpen ? (
                        <div className="agent-composer-more-model-list">
                          {moreModelGroups.map(([providerId, models]) => (
                            <div className="agent-composer-more-model-group" key={providerId}>
                              <div className="agent-composer-menu-caption">{formatProviderName(providerId)}</div>
                              {models.map((model) => (
                                <ModelMenuItem
                                  activeProvider={activeProvider}
                                  key={modelKey(model)}
                                  model={model}
                                  onSelect={() => void changeModel(model)}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>

                {supportsReasoning ? (
                  <>
                    <div className="agent-composer-menu-divider" />
                    <div className="agent-composer-thinking-row">
                      <BrainIcon size={ICON_SIZE.menu} />
                      <span>Thinking</span>
                      {reasoningEnabled ? (
                        <div className="agent-composer-thinking-level-wrap">
                          <button
                            aria-expanded={reasoningMenuOpen}
                            className="agent-composer-thinking-level"
                            onClick={() => setReasoningMenuOpen((open) => !open)}
                            type="button"
                          >
                            {REASONING_LABELS[selectedReasoning]}
                            <ChevronDownIcon size={ICON_SIZE.tiny} />
                          </button>
                          {reasoningMenuOpen ? (
                            <div className="agent-composer-thinking-level-menu">
                              {reasoningOptions
                                .filter((level) => level !== 'off')
                                .map((level) => (
                                  <button
                                    className={`agent-composer-thinking-level-item ${
                                      selectedReasoning === level ? 'is-selected' : ''
                                    }`}
                                    key={level}
                                    onClick={() => {
                                      setReasoningMenuOpen(false);
                                      void changeReasoning(level);
                                    }}
                                    type="button"
                                  >
                                    {REASONING_LABELS[level]}
                                  </button>
                                ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      <button
                        aria-checked={reasoningEnabled}
                        className={`agent-composer-thinking-switch ${reasoningEnabled ? 'is-on' : ''}`}
                        disabled={configDisabled || !reasoningOptions.includes('off')}
                        onClick={() => {
                          void changeReasoning(reasoningEnabled ? 'off' : defaultEnabledReasoning());
                        }}
                        role="switch"
                        type="button"
                      >
                        <span />
                      </button>
                    </div>
                  </>
                ) : null}

                <div className="agent-composer-menu-divider" />
                <button
                  className="agent-composer-settings-item"
                  onClick={() => {
                    setModelMenuOpen(false);
                    onOpenSettings();
                  }}
                  role="menuitem"
                  type="button"
                >
                  <SettingsIcon size={ICON_SIZE.menu} />
                  <span>API Settings</span>
                </button>
              </FloatingComposerMenu>
            ) : null}
          </div>

          {isStreaming && !hasDraft ? (
            <button
              aria-label="Stop agent"
              className="agent-composer-action-button"
              onClick={onStop}
              title="Stop"
              type="button"
            >
              <StopIcon size={ICON_SIZE.toolbar} />
            </button>
          ) : (
            <button
              aria-label={isStreaming ? 'Queue follow-up' : 'Send message'}
              className="agent-composer-action-button"
              disabled={!canSubmit}
              title={isStreaming ? 'Queue follow-up' : 'Send'}
              type="submit"
            >
              <SendIcon size={ICON_SIZE.toolbar} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function ComposerAttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="agent-attachment-chip">
      <div className="agent-attachment-preview">
        {attachment.kind === 'image' && attachment.previewUrl ? (
          <img alt="" src={attachment.previewUrl} />
        ) : (
          <FileTextIcon size={ICON_SIZE.menu} />
        )}
      </div>
      <div className="agent-attachment-meta">
        <span title={attachment.name}>{attachment.name}</span>
        <small>{formatBytes(attachment.sizeBytes)}</small>
      </div>
      <button
        aria-label={`Remove ${attachment.name}`}
        className="agent-attachment-remove"
        onClick={onRemove}
        title="Remove attachment"
        type="button"
      >
        <CloseIcon size={ICON_SIZE.tiny} />
      </button>
    </div>
  );
}

async function fileToAttachment(file: File): Promise<ComposerAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name || 'Attachment'} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
  }

  const mimeType = file.type || inferMimeType(file.name);
  const id = createAttachmentId();
  const name = file.name || (mimeType.startsWith('image/') ? 'image' : 'attachment.txt');

  if (mimeType.startsWith('image/')) {
    const dataUrl = await readFileAsDataUrl(file);
    const commaIndex = dataUrl.indexOf(',');
    const dataBase64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
    const previewUrl = URL.createObjectURL(file);
    return {
      id,
      kind: 'image',
      name,
      mimeType,
      sizeBytes: file.size,
      dataBase64,
      previewUrl,
    };
  }

  if (isTextAttachment(file, mimeType)) {
    const rawText = await file.text();
    const truncated = rawText.length > MAX_TEXT_ATTACHMENT_CHARS;
    return {
      id,
      kind: 'text',
      name,
      mimeType,
      sizeBytes: file.size,
      text: truncated ? rawText.slice(0, MAX_TEXT_ATTACHMENT_CHARS) : rawText,
      truncated,
    };
  }

  throw new Error(`${file.name || 'Attachment'} is not a supported image or text file.`);
}

function toAttachmentPayload(attachment: ComposerAttachment): AgentMessageAttachmentInput {
  if (attachment.kind === 'image') {
    const { fingerprint: _fingerprint, previewUrl: _previewUrl, sha256: _sha256, ...payload } = attachment;
    return payload;
  }
  const { fingerprint: _fingerprint, previewUrl: _previewUrl, sha256: _sha256, ...payload } = attachment;
  return payload;
}

function isTextAttachment(file: File, mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  if ([
    'application/json',
    'application/javascript',
    'application/typescript',
    'application/xml',
    'application/yaml',
    'application/x-yaml',
  ].includes(mimeType)) {
    return true;
  }
  const lowerName = file.name.toLowerCase();
  return [...TEXT_ATTACHMENT_EXTENSIONS].some((extension) => lowerName.endsWith(extension));
}

function inferMimeType(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith('.json')) return 'application/json';
  if (lowerName.endsWith('.xml')) return 'application/xml';
  if (lowerName.endsWith('.yaml') || lowerName.endsWith('.yml')) return 'application/yaml';
  if ([...TEXT_ATTACHMENT_EXTENSIONS].some((extension) => lowerName.endsWith(extension))) return 'text/plain';
  return 'application/octet-stream';
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

async function sha256File(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) return fileFingerprint(file);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function fileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
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

function duplicateMessage(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "Skipped 1 file that's already attached."
    : `Skipped ${count} files that are already attached.`;
}

function overflowMessage(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? `Skipped 1 file over the ${MAX_ATTACHMENTS} attachment limit.`
    : `Skipped ${count} files over the ${MAX_ATTACHMENTS} attachment limit.`;
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

function getActiveProvider(settings: AgentProviderSettingsView | null): AgentProviderConfigView | null {
  if (!settings) return null;
  const active = settings.activeProviderId
    ? settings.providers.find((provider) => provider.providerId === settings.activeProviderId)
    : undefined;
  return active ?? settings.providers.find((provider) => provider.enabled) ?? settings.providers[0] ?? null;
}

function getModelChoices(
  settings: AgentProviderSettingsView | null,
  activeProvider: AgentProviderConfigView | null,
): ComposerModelChoice[] {
  if (!settings) return [];
  const choices = settings.availableProviders.flatMap((provider) =>
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

function getFeaturedModelChoices(
  models: ComposerModelChoice[],
  activeProvider: AgentProviderConfigView | null,
): ComposerModelChoice[] {
  const featured = models.slice(0, 5);
  if (!activeProvider) return featured;
  const selected = models.find(
    (model) => model.providerId === activeProvider.providerId && model.id === activeProvider.modelId,
  );
  if (!selected || featured.some((model) => modelKey(model) === modelKey(selected))) return featured;
  return [...featured.slice(0, Math.max(0, featured.length - 1)), selected];
}

function modelKey(model: ComposerModelChoice): string {
  return `${model.providerId}:${model.id}`;
}

function groupModelsByProvider(models: ComposerModelChoice[]): [string, ComposerModelChoice[]][] {
  const groups = new Map<string, ComposerModelChoice[]>();
  for (const model of models) {
    const existing = groups.get(model.providerId);
    if (existing) existing.push(model);
    else groups.set(model.providerId, [model]);
  }
  return [...groups.entries()];
}

function formatProviderName(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

function ModelMenuItem({
  activeProvider,
  model,
  onSelect,
}: {
  activeProvider: AgentProviderConfigView | null;
  model: ComposerModelChoice;
  onSelect: () => void;
}) {
  const selected = model.providerId === activeProvider?.providerId && model.id === activeProvider?.modelId;
  return (
    <button
      className={`agent-composer-model-item ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      role="menuitem"
      type="button"
    >
      <span className="agent-composer-menu-check">
        {selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}
      </span>
      <span className="agent-composer-model-item-name">{model.name || model.id}</span>
    </button>
  );
}

function FloatingComposerMenu({
  anchorRef,
  children,
  layoutKey,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  layoutKey: string;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    top: -9999,
    left: -9999,
  });

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [anchorRef, onClose]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const gap = 6;
      const margin = 8;
      const width = Math.min(300, window.innerWidth - margin * 2);
      const maxHeight = Math.min(440, Math.max(120, window.innerHeight - margin * 2));
      const contentHeight = menuRef.current?.scrollHeight ?? maxHeight;
      const height = Math.min(contentHeight, maxHeight);
      const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
      const top = Math.max(margin, rect.top - gap - height);
      setStyle({
        position: 'fixed',
        top,
        left,
        width,
        maxHeight,
      });
    };

    update();
    const frame = window.requestAnimationFrame(update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorRef, layoutKey]);

  return createPortal(
    <div
      ref={menuRef}
      className="agent-composer-model-menu"
      role="menu"
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}
