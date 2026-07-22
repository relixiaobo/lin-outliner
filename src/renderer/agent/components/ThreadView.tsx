import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { MAX_RAW_INLINE_IMAGE_BYTES } from '../../../core/agentAttachmentLimits';
import type {
  Thread,
  ThreadAttachmentContent,
  ThreadNodeReferenceContent,
  ThreadUserContent,
  Turn,
} from '../../../core/agent/protocol';
import type { ThreadGoal } from '../../../core/agent/goal';
import { useT } from '../../i18n/I18nProvider';
import {
  acknowledgeThreadComposerNodeReferenceRequest,
  onThreadComposerNodeReferenceRequest,
} from '../agentReveal';
import {
  AttachmentIcon,
  CloseIcon,
  FileImageIcon,
  GitForkIcon,
  ICON_SIZE,
  RefreshIcon,
  SendIcon,
  StopIcon,
  ReferenceIcon,
  WarningIcon,
} from '../../ui/icons';
import { IconButton } from '../../ui/primitives/IconButton';
import { ThreadGoalView } from './ThreadGoalView';
import { ThreadItemView } from './items/ThreadItemView';

interface ThreadViewProps {
  readonly goal: ThreadGoal | null;
  readonly thread: Thread;
  readonly turns: readonly Turn[];
  readonly waitingForInput: boolean;
  readonly onEditUserMessage: (turn: Turn, content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onFork: (turn: Turn, kind: 'beforeTurn' | 'afterTurn') => Promise<void>;
  readonly onInterrupt: () => Promise<void>;
  readonly onOpenNodeReference: (nodeId: string) => void;
  readonly onRegenerate: (turn: Turn) => Promise<void>;
  readonly onSend: (content: readonly ThreadUserContent[]) => Promise<void>;
}

const MAX_ATTACHMENTS = 6;

export function ThreadView({
  goal,
  thread,
  turns,
  waitingForInput,
  onEditUserMessage,
  onFork,
  onInterrupt,
  onOpenNodeReference,
  onRegenerate,
  onSend,
}: ThreadViewProps) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ThreadAttachmentContent[]>([]);
  const [nodeReferences, setNodeReferences] = useState<ThreadNodeReferenceContent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeTurn = useMemo(() => findActiveTurn(turns), [turns]);
  const itemCount = turns.reduce((count, turn) => count + turn.items.length, 0);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
    if (nearBottom || activeTurn) scroll.scrollTop = scroll.scrollHeight;
  }, [activeTurn, itemCount]);

  useEffect(() => onThreadComposerNodeReferenceRequest((request) => {
    setNodeReferences((current) => current.some((reference) => reference.nodeId === request.nodeId)
      ? current
      : [...current, { type: 'nodeReference', nodeId: request.nodeId, note: request.title }]);
    acknowledgeThreadComposerNodeReferenceRequest(request);
    requestAnimationFrame(() => composerRef.current?.focus());
  }), []);

  async function submit() {
    const text = draft.trim();
    if ((!text && attachments.length === 0 && nodeReferences.length === 0) || sending || waitingForInput) return;
    const submittedAttachments = attachments;
    const submittedNodeReferences = nodeReferences;
    setSending(true);
    setError(null);
    setDraft('');
    setAttachments([]);
    setNodeReferences([]);
    try {
      await onSend([
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...submittedNodeReferences,
        ...submittedAttachments,
      ]);
    } catch (sendError) {
      setDraft(text);
      setAttachments(submittedAttachments);
      setNodeReferences(submittedNodeReferences);
      setError(errorMessage(sendError));
    } finally {
      setSending(false);
    }
  }

  async function addPickedFiles() {
    if (attachments.length >= MAX_ATTACHMENTS) return;
    setError(null);
    if (window.lin?.pickLocalFiles) {
      try {
        const result = await window.lin.pickLocalFiles({ maxFiles: MAX_ATTACHMENTS - attachments.length });
        if (!result.canceled) {
          const next = result.files.flatMap((file) => {
            try {
              return [attachmentFromPickedFile(file)];
            } catch (attachmentError) {
              setError(errorMessage(attachmentError));
              return [];
            }
          });
          setAttachments((current) => uniqueAttachments([...current, ...next]).slice(0, MAX_ATTACHMENTS));
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
    setError(null);
    const next: ThreadAttachmentContent[] = [];
    for (const file of files.slice(0, MAX_ATTACHMENTS - attachments.length)) {
      try {
        next.push(await attachmentFromBrowserFile(file));
      } catch (attachmentError) {
        setError(errorMessage(attachmentError));
      }
    }
    setAttachments((current) => uniqueAttachments([...current, ...next]).slice(0, MAX_ATTACHMENTS));
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  return (
    <div className="thread-view">
      <div className="thread-transcript" ref={scrollRef}>
        {goal ? <ThreadGoalView goal={goal} /> : null}
        {turns.length === 0 ? <p className="thread-empty-copy">{t.agent.thread.empty}</p> : null}
        {turns.map((turn) => (
          <section className={`thread-turn thread-turn-${turn.status}`} key={turn.id}>
            {turn.items.map((item) => (
              <ThreadItemView
                item={item}
                key={item.id}
                onEditUserMessage={(content) => onEditUserMessage(turn, content)}
                onOpenNodeReference={onOpenNodeReference}
                onRegenerate={() => onRegenerate(turn)}
                streaming={turn.status === 'inProgress'}
              />
            ))}
            {turn.error ? (
              <div className="thread-turn-error" role="alert">
                <WarningIcon size={ICON_SIZE.menu} />
                <span>{turn.error.message}</span>
              </div>
            ) : null}
            <footer className="thread-turn-footer">
              <span>{turnStatusLabel(turn, t.agent.thread)}</span>
              <span className="thread-turn-actions">
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
              </span>
            </footer>
          </section>
        ))}
      </div>
      <div className="thread-composer">
        {error ? <p className="thread-inline-error" role="status">{error}</p> : null}
        {nodeReferences.length > 0 || attachments.length > 0 ? (
          <div className="thread-composer-attachments">
            {nodeReferences.map((reference) => (
              <div className="thread-composer-attachment" key={reference.nodeId}>
                <span className="thread-composer-attachment-icon"><ReferenceIcon size={ICON_SIZE.menu} /></span>
                <span className="thread-composer-attachment-meta">
                  <span>{reference.note || reference.nodeId}</span>
                  <small>{reference.nodeId}</small>
                </span>
                <IconButton
                  icon={CloseIcon}
                  iconSize={ICON_SIZE.tiny}
                  label={t.agent.thread.removeReference({ name: reference.note || reference.nodeId })}
                  onClick={() => setNodeReferences((current) => current.filter((item) => item.nodeId !== reference.nodeId))}
                  variant="message"
                />
              </div>
            ))}
            {attachments.map((attachment) => (
              <div className="thread-composer-attachment" key={attachment.id}>
                <span className="thread-composer-attachment-icon"><FileImageIcon size={ICON_SIZE.menu} /></span>
                <span className="thread-composer-attachment-meta">
                  <span>{attachment.name}</span>
                  <small>{formatBytes(attachment.sizeBytes)}</small>
                </span>
                <IconButton
                  icon={CloseIcon}
                  iconSize={ICON_SIZE.tiny}
                  label={t.agent.thread.removeAttachment({ name: attachment.name })}
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  variant="message"
                />
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          aria-label={t.agent.thread.composerLabel}
          disabled={waitingForInput}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={activeTurn ? t.agent.composer.steerPlaceholder : t.agent.thread.composerPlaceholder}
          ref={composerRef}
          rows={2}
          value={draft}
        />
        <div className="thread-composer-footer">
          <input
            className="thread-composer-file-input"
            multiple
            onChange={(event) => void handleFileInputChange(event)}
            ref={fileInputRef}
            type="file"
          />
          <IconButton
            disabled={attachments.length >= MAX_ATTACHMENTS || sending || waitingForInput}
            icon={AttachmentIcon}
            label={t.agent.thread.addAttachment}
            onClick={() => void addPickedFiles()}
            variant="composerTool"
          />
          <span>{thread.modelProvider}</span>
          {activeTurn ? (
            <IconButton
              icon={StopIcon}
              label={t.agent.thread.interrupt}
              onClick={() => void onInterrupt()}
              variant="composerAction"
            />
          ) : null}
          <IconButton
            disabled={(!draft.trim() && attachments.length === 0 && nodeReferences.length === 0) || sending || waitingForInput}
            icon={SendIcon}
            label={activeTurn ? t.agent.thread.steer : t.agent.thread.send}
            onClick={() => void submit()}
            variant="composerAction"
          />
        </div>
      </div>
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

function turnStatusLabel(
  turn: Turn,
  labels: {
    readonly working: string;
    readonly turnFailed: string;
    readonly turnInterrupted: string;
  },
): string {
  if (turn.status === 'inProgress') return labels.working;
  if (turn.status === 'failed') return labels.turnFailed;
  if (turn.status === 'interrupted') return labels.turnInterrupted;
  if (turn.durationMs === null) return '';
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

function attachmentFromPickedFile(file: {
  readonly entryKind?: 'file' | 'directory';
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly imageDataBase64?: string;
}): ThreadAttachmentContent {
  validateAttachment(file.name, file.sizeBytes, file.entryKind);
  const mimeType = file.mimeType || 'application/octet-stream';
  return {
    type: 'attachment',
    id: crypto.randomUUID(),
    name: file.name || 'attachment',
    mimeType,
    sizeBytes: file.sizeBytes,
    source: mimeType.startsWith('image/') && file.imageDataBase64
      ? { kind: 'inline', dataBase64: file.imageDataBase64 }
      : { kind: 'localFile', path: file.path },
  };
}

async function attachmentFromBrowserFile(file: File): Promise<ThreadAttachmentContent> {
  validateAttachment(file.name, file.size);
  const name = file.name || 'attachment';
  const mimeType = file.type || 'application/octet-stream';
  if (mimeType.startsWith('image/')) {
    return {
      type: 'attachment',
      id: crypto.randomUUID(),
      name,
      mimeType,
      sizeBytes: file.size,
      source: { kind: 'inline', dataBase64: arrayBufferToBase64(await file.arrayBuffer()) },
    };
  }
  if (!window.lin?.stageAttachment) throw new Error('Attachment staging is unavailable.');
  const staged = await window.lin.stageAttachment({ name, mimeType, bytes: await file.arrayBuffer() });
  return {
    type: 'attachment',
    id: crypto.randomUUID(),
    name: staged.name,
    mimeType: staged.mimeType,
    sizeBytes: staged.sizeBytes,
    source: { kind: 'localFile', path: staged.path },
  };
}

function validateAttachment(name: string, sizeBytes: number, entryKind?: 'file' | 'directory') {
  if (entryKind === 'directory') throw new Error(`${name || 'Attachment'} is a directory and cannot be attached.`);
  if (sizeBytes > MAX_RAW_INLINE_IMAGE_BYTES) {
    throw new Error(`${name || 'Attachment'} is larger than ${formatBytes(MAX_RAW_INLINE_IMAGE_BYTES)} and cannot be attached.`);
  }
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
    const key = `${attachment.name}\u0000${attachment.sizeBytes}\u0000${attachment.mimeType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
