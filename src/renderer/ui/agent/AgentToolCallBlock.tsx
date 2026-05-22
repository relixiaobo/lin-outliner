import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentToolResultPayloadPart, AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentRenderSubagentEntity } from '../../../core/agentRenderProjection';
import { api } from '../../api/client';
import {
  AgentIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  ICON_SIZE,
  LoaderIcon,
  NodeCreateToolIcon,
  NodeEditToolIcon,
  RestoreIcon,
  SearchIcon,
  TerminalIcon,
  TrashIcon,
  UrlIcon,
  WarningIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentToolCallDisclosure } from './AgentToolCallDisclosure';

interface AgentToolCallBlockProps {
  defaultExpanded?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onOpenSubagentTranscript?: (subagentId: string) => void;
  pendingToolCallIds?: ReadonlySet<string>;
  result?: AgentToolResultWithPayloads;
  sessionId?: string | null;
  subagent?: AgentRenderSubagentEntity;
  toolCall: ToolCall;
  turnActive?: boolean;
}

export type ToolStatus = 'pending' | 'done' | 'error';

type ResultPart =
  | { type: 'imagePlaceholder' }
  | { type: 'persistedOutput'; payloadRef: AgentToolResultPayloadPart; text: string }
  | { type: 'text'; text: string };

const TOOL_OUTPUT_WINDOW_HEAD_CHARS = 12_000;
const TOOL_OUTPUT_WINDOW_TAIL_CHARS = 4_000;

interface ToolEnvelopeLike {
  ok: boolean;
  tool: string;
  version: number;
  status: string;
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
    recoverable?: boolean;
    details?: unknown;
  };
  nextStep?: string;
  fallback?: string;
  hint?: unknown;
  warnings?: string[];
  metrics?: unknown;
}

export function getToolCallStatus(
  toolCallId: string,
  result: AgentToolResultWithPayloads | undefined,
  pendingToolCallIds: ReadonlySet<string> | undefined,
  turnActive: boolean | undefined,
): ToolStatus {
  if (!result) {
    return pendingToolCallIds?.has(toolCallId) || turnActive ? 'pending' : 'error';
  }
  return result.isError ? 'error' : 'done';
}

function getToolIcon(toolCall: ToolCall) {
  if (
    toolCall.name === 'Agent'
    || toolCall.name === 'AgentStatus'
    || toolCall.name === 'AgentSend'
    || toolCall.name === 'AgentStop'
  ) return AgentIcon;
  if (toolCall.name === 'node_create') return NodeCreateToolIcon;
  if (toolCall.name === 'node_read') return FileTextIcon;
  if (toolCall.name === 'node_edit') return NodeEditToolIcon;
  if (toolCall.name === 'node_search' || toolCall.name === 'web_search') return SearchIcon;
  if (toolCall.name === 'node_delete') {
    return toolCall.arguments.restore === true ? RestoreIcon : TrashIcon;
  }
  if (toolCall.name === 'web_fetch') return UrlIcon;
  if (toolCall.name === 'bash') return TerminalIcon;
  if (toolCall.name === 'file_edit') return NodeEditToolIcon;
  return WarningIcon;
}

function pickSubject(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function quoteSubject(subject: string): string {
  const trimmed = subject.trim();
  const short = trimmed.length > 72 ? `${trimmed.slice(0, 72)}...` : trimmed;
  if (short.startsWith('http://') || short.startsWith('https://')) return short;
  return `"${short}"`;
}

type VerbForms = [base: string, pending: string, done: string];

function verbByStatus(forms: VerbForms, status: ToolStatus): string {
  if (status === 'pending') return forms[1];
  if (status === 'done') return forms[2];
  return `Failed to ${forms[0]}`;
}

export function summarizeToolCall(toolCall: ToolCall, status: ToolStatus): string {
  if (toolCall.name === 'Agent') {
    const subject = pickSubject(toolCall.arguments, 'description', 'subagent_type');
    return `${verbByStatus(['run subagent', 'Running subagent', 'Ran subagent'], status)}${subject ? ` ${quoteSubject(subject)}` : ''}`;
  }
  if (toolCall.name === 'AgentStatus') return verbByStatus(['check subagent', 'Checking subagent', 'Checked subagent'], status);
  if (toolCall.name === 'AgentSend') return verbByStatus(['message subagent', 'Messaging subagent', 'Messaged subagent'], status);
  if (toolCall.name === 'AgentStop') return verbByStatus(['stop subagent', 'Stopping subagent', 'Stopped subagent'], status);
  const args = toolCall.arguments;
  if (toolCall.name === 'node_create') {
    const subject = pickSubject(args, 'parentId', 'afterId');
    const target = subject ? ` under ${quoteSubject(subject)}` : '';
    return `${verbByStatus(['create node', 'Creating node', 'Created node'], status)}${target}`;
  }
  if (toolCall.name === 'node_read') {
    const subject = pickSubject(args, 'nodeId');
    return `${verbByStatus(['read node', 'Reading node', 'Read node'], status)}${subject ? ` ${quoteSubject(subject)}` : ''}`;
  }
  if (toolCall.name === 'node_edit') {
    const subject = pickSubject(args, 'nodeId');
    return `${verbByStatus(['edit node', 'Editing node', 'Edited node'], status)}${subject ? ` ${quoteSubject(subject)}` : ''}`;
  }
  if (toolCall.name === 'node_delete') {
    const subject = pickSubject(args, 'nodeId');
    return `${verbByStatus(['delete node', 'Deleting node', 'Deleted node'], status)}${subject ? ` ${quoteSubject(subject)}` : ''}`;
  }
  if (toolCall.name === 'node_search') {
    const subject = pickSubject(args, 'query', 'rules');
    return `${verbByStatus(['search nodes', 'Searching nodes', 'Searched nodes'], status)}${subject ? ` ${quoteSubject(subject)}` : ''}`;
  }
  if (toolCall.name === 'web_search') {
    const subject = pickSubject(args, 'query');
    return `${verbByStatus(['search web', 'Searching web', 'Searched web'], status)}${subject ? ` ${quoteSubject(subject)}` : ''}`;
  }
  if (toolCall.name === 'web_fetch') {
    const subject = pickSubject(args, 'url');
    return `${verbByStatus(['fetch web', 'Fetching web', 'Fetched web'], status)}${subject ? ` ${quoteSubject(subject)}` : ''}`;
  }
  if (toolCall.name === 'bash') {
    const command = pickSubject(args, 'command', 'cmd');
    const firstLine = command?.split('\n').map((line) => line.trim()).find(Boolean);
    return `${verbByStatus(['run bash', 'Running bash', 'Ran bash'], status)}${firstLine ? ` ${quoteSubject(firstLine)}` : ''}`;
  }
  if (toolCall.name === 'file_edit') {
    const subject = pickSubject(args, 'path', 'file_path');
    return `${verbByStatus(['edit file', 'Editing file', 'Edited file'], status)}${subject ? ` ${quoteSubject(subject)}` : ''}`;
  }
  return verbByStatus([toolCall.name, `${toolCall.name}...`, toolCall.name], status);
}

function subagentToolStatus(subagent: AgentRenderSubagentEntity): ToolStatus {
  if (subagent.status === 'running') return 'pending';
  if (subagent.status === 'failed' || subagent.status === 'stopped') return 'error';
  return 'done';
}

function formatSubagentMode(subagent: AgentRenderSubagentEntity): string {
  return `${subagent.contextMode} · ${subagent.subagentType}`;
}

function formatSubagentDuration(subagent: AgentRenderSubagentEntity): string {
  const end = subagent.completedAt ?? subagent.updatedAt;
  const elapsed = Math.max(0, end - subagent.startedAt);
  if (elapsed < 1000) return '<1s';
  const seconds = Math.round(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest > 0 ? `${hours}h ${minuteRest}m` : `${hours}h`;
}

function subagentSummary(subagent: AgentRenderSubagentEntity): string {
  const description = subagent.description.trim() || subagent.name || subagent.id;
  return `Subagent · ${description}`;
}

function previewText(text: string | undefined, maxLength = 520): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized;
}

function SubagentInlineDetails({
  onOpenTranscript,
  subagent,
}: {
  onOpenTranscript?: (subagentId: string) => void;
  subagent: AgentRenderSubagentEntity;
}) {
  const result = previewText(subagent.result);
  const error = previewText(subagent.error);
  const prompt = previewText(subagent.prompt);
  const canOpenTranscript = !!subagent.transcriptPayloadId && !!onOpenTranscript;

  return (
    <div className="agent-subagent-inline">
      <dl className="agent-subagent-meta-grid">
        <div>
          <dt>Status</dt>
          <dd>{subagent.status}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{formatSubagentMode(subagent)}</dd>
        </div>
        <div>
          <dt>Messages</dt>
          <dd>{subagent.transcriptMessageCount}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatSubagentDuration(subagent)}</dd>
        </div>
      </dl>
      {subagent.name ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">Name</div>
          </div>
          <pre>{subagent.name}</pre>
        </section>
      ) : null}
      {prompt ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">Prompt</div>
            <ToolCopyButton ariaLabel="Copy subagent prompt" text={subagent.prompt} />
          </div>
          <pre>{prompt}</pre>
        </section>
      ) : null}
      {result ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">Result</div>
            <ToolCopyButton ariaLabel="Copy subagent result" text={subagent.result ?? ''} />
          </div>
          <pre>{result}</pre>
        </section>
      ) : null}
      {error ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">
              Error
              <span>error</span>
            </div>
            <ToolCopyButton ariaLabel="Copy subagent error" text={subagent.error ?? ''} />
          </div>
          <pre>{error}</pre>
        </section>
      ) : null}
      <div className="agent-subagent-inline-actions">
        <ButtonControl
          className="agent-subagent-transcript-button"
          disabled={!canOpenTranscript}
          onClick={() => onOpenTranscript?.(subagent.id)}
        >
          <FileTextIcon size={ICON_SIZE.menu} />
          <span>{subagent.transcriptPayloadId ? 'View transcript' : 'Transcript unavailable'}</span>
        </ButtonControl>
        <ToolCopyButton ariaLabel="Copy subagent id" text={subagent.id} />
      </div>
    </div>
  );
}

function resultText(result: AgentToolResultWithPayloads | undefined): string {
  if (!result) return '';
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function getToolResultCopyText(result: AgentToolResultWithPayloads | undefined): string {
  return resultText(result);
}

function isImagePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '[Image removed]' || trimmed.startsWith('[Image removed') || trimmed === '<image>';
}

function resultParts(result: AgentToolResultWithPayloads | undefined, expanded: boolean): ResultPart[] {
  if (!result || !expanded) return [];
  return result.content.flatMap((block, contentIndex): ResultPart[] => {
    if (block.type !== 'text') return [];
    const payloadRef = result.payloadRefs?.find((ref) => ref.contentIndex === contentIndex);
    if (payloadRef) {
      return [{ type: 'persistedOutput', payloadRef, text: block.text }];
    }
    return [
      isImagePlaceholder(block.text)
        ? { type: 'imagePlaceholder' }
        : { type: 'text', text: block.text },
    ];
  });
}

function resultImages(result: AgentToolResultWithPayloads | undefined): Array<{ data: string; mimeType: string }> {
  if (!result) return [];
  return result.content
    .filter((block): block is Extract<AgentToolResultWithPayloads['content'][number], { type: 'image' }> =>
      block.type === 'image')
    .map((block) => ({ data: block.data, mimeType: block.mimeType }));
}

function isToolEnvelope(value: unknown): value is ToolEnvelopeLike {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ToolEnvelopeLike>;
  return candidate.version === 1
    && typeof candidate.ok === 'boolean'
    && typeof candidate.tool === 'string'
    && typeof candidate.status === 'string';
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function outputWindow(text: string): { text: string; windowed: boolean } {
  const limit = TOOL_OUTPUT_WINDOW_HEAD_CHARS + TOOL_OUTPUT_WINDOW_TAIL_CHARS;
  if (text.length <= limit) return { text, windowed: false };
  const omitted = text.length - limit;
  return {
    text: [
      text.slice(0, TOOL_OUTPUT_WINDOW_HEAD_CHARS),
      '',
      `[... ${omitted.toLocaleString()} chars omitted ...]`,
      '',
      text.slice(-TOOL_OUTPUT_WINDOW_TAIL_CHARS),
    ].join('\n'),
    windowed: true,
  };
}

function ToolCopyButton({ ariaLabel, text }: { ariaLabel: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  async function copy() {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 1200);
  }

  return (
    <ButtonControl
      aria-label={ariaLabel}
      className="agent-tool-call-copy"
      disabled={!text}
      onClick={() => void copy()}
    >
      <CopyStateIcon size={ICON_SIZE.menu} />
    </ButtonControl>
  );
}

function ToolEnvelopeOutput({ envelope }: { envelope: ToolEnvelopeLike }) {
  const notes = [
    envelope.error?.message,
    ...(envelope.warnings ?? []),
    envelope.nextStep ? `Next: ${envelope.nextStep}` : null,
    envelope.fallback ? `Fallback: ${envelope.fallback}` : null,
  ].filter((note): note is string => typeof note === 'string' && note.trim().length > 0);

  return (
    <div className="agent-tool-envelope">
      <div className={`agent-tool-status-line ${envelope.ok ? 'is-ok' : 'is-error'}`}>
        <span>{envelope.status}</span>
        <span>{envelope.tool}</span>
      </div>
      {notes.length > 0 ? (
        <div className="agent-tool-notes">
          {notes.map((note, index) => (
            <div key={`note-${index}`}>{note}</div>
          ))}
        </div>
      ) : null}
      {envelope.data !== undefined ? (
        <pre>{jsonText(envelope.data)}</pre>
      ) : null}
      {envelope.hint !== undefined ? (
        <pre>{jsonText(envelope.hint)}</pre>
      ) : null}
    </div>
  );
}

function ToolResultImages({ images }: { images: Array<{ data: string; mimeType: string }> }) {
  if (images.length === 0) return null;
  return (
    <div className="agent-tool-image-list">
      {images.map((image, index) => {
        const src = `data:${image.mimeType};base64,${image.data}`;
        return (
          <a href={src} key={`${image.mimeType}-${index}`} rel="noreferrer" target="_blank">
            <img alt={`Tool result ${index + 1}`} loading="lazy" src={src} />
          </a>
        );
      })}
    </div>
  );
}

function PersistedToolOutput({
  initialText,
  payloadRef,
  sessionId,
}: {
  initialText: string;
  payloadRef: AgentToolResultPayloadPart;
  sessionId?: string | null;
}) {
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const payload = payloadRef.payload;
  const visible = outputWindow(fullText ?? initialText);
  const canLoad = !!sessionId && (payload.mimeType.startsWith('text/') || payload.mimeType === 'application/json');

  useEffect(() => () => {
    requestRef.current += 1;
  }, []);

  async function loadFullOutput() {
    if (!sessionId || loading) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setLoadError(null);
    try {
      const text = await api.agentPayloadText(sessionId, payload.id);
      if (requestId !== requestRef.current) return;
      if (text === null) {
        setLoadError('Payload unavailable');
        return;
      }
      setFullText(text);
    } catch (caught) {
      if (requestId === requestRef.current) {
        setLoadError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }

  return (
    <div className="agent-tool-persisted-output">
      <div className="agent-tool-persisted-meta">
        <FileTextIcon size={ICON_SIZE.menu} />
        <span>{payload.summary || 'Stored tool output'}</span>
        <small>{formatBytes(payload.byteLength)}</small>
      </div>
      <pre>{visible.text}</pre>
      <div className="agent-tool-persisted-actions">
        <ButtonControl
          className="agent-tool-persisted-load"
          disabled={!canLoad || loading}
          onClick={() => void loadFullOutput()}
        >
          <FileTextIcon size={ICON_SIZE.menu} />
          <span>{fullText ? 'Reload full output' : loading ? 'Loading...' : 'Load full output'}</span>
        </ButtonControl>
        {fullText ? (
          <ToolCopyButton ariaLabel="Copy full tool output" text={fullText} />
        ) : null}
        {visible.windowed ? (
          <small>Windowed</small>
        ) : null}
        {loadError ? (
          <small className="is-error">{loadError}</small>
        ) : null}
      </div>
    </div>
  );
}

export function AgentToolCallBlock({
  defaultExpanded = false,
  expanded,
  onToggle,
  onOpenSubagentTranscript,
  pendingToolCallIds,
  result,
  sessionId,
  subagent,
  toolCall,
  turnActive,
}: AgentToolCallBlockProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const status = subagent ? subagentToolStatus(subagent) : getToolCallStatus(toolCall.id, result, pendingToolCallIds, turnActive);
  const Icon = getToolIcon(toolCall);
  const StatusIcon = status === 'pending' ? LoaderIcon : Icon;
  const isExpanded = expanded ?? internalExpanded;
  const inputText = useMemo(() => jsonText(toolCall.arguments), [toolCall.arguments]);
  const outputText = useMemo(() => resultText(result), [result]);
  const images = useMemo(() => resultImages(result), [result]);
  const parts = useMemo(() => resultParts(result, isExpanded), [result, isExpanded]);
  const details = result?.details;
  const envelope = isToolEnvelope(details) ? details : null;
  const hasSubagentDetails = Boolean(subagent);
  const hasDetails = hasSubagentDetails || inputText !== '{}' || outputText.length > 0 || envelope !== null;
  const hasOutputDetails = envelope !== null || parts.length > 0;

  function toggle() {
    if (onToggle) {
      onToggle();
      return;
    }
    setInternalExpanded((current) => !current);
  }

  return (
    <AgentToolCallDisclosure
      expanded={isExpanded}
      hasDetails={hasDetails}
      images={<ToolResultImages images={images} />}
      onToggle={toggle}
      status={status}
      statusIcon={StatusIcon}
      statusIconClassName={status === 'pending' ? 'agent-tool-call-spinner' : undefined}
      summary={subagent ? subagentSummary(subagent) : summarizeToolCall(toolCall, status)}
    >
      {subagent ? (
        <SubagentInlineDetails
          onOpenTranscript={onOpenSubagentTranscript}
          subagent={subagent}
        />
      ) : null}
      {!hasSubagentDetails && inputText !== '{}' ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">Input</div>
            <ToolCopyButton ariaLabel="Copy tool input" text={inputText} />
          </div>
          <pre>{inputText}</pre>
        </section>
      ) : null}
      {!hasSubagentDetails && result && hasOutputDetails ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">
              Output
              {result.isError ? <span>error</span> : null}
            </div>
            <ToolCopyButton ariaLabel="Copy tool output" text={outputText} />
          </div>
          {envelope ? <ToolEnvelopeOutput envelope={envelope} /> : null}
          {!envelope ? parts.map((part, index) =>
            part.type === 'imagePlaceholder' ? (
              <div className="agent-tool-image-placeholder" key={`placeholder-${index}`}>
                <FileTextIcon size={ICON_SIZE.menu} />
                <span>Screenshot captured</span>
              </div>
            ) : part.type === 'persistedOutput' ? (
              <PersistedToolOutput
                initialText={part.text}
                key={`payload-${part.payloadRef.payload.id}`}
                payloadRef={part.payloadRef}
                sessionId={sessionId}
              />
            ) : (
              <pre key={`text-${index}`}>{part.text}</pre>
            ),
          ) : null}
        </section>
      ) : null}
    </AgentToolCallDisclosure>
  );
}
