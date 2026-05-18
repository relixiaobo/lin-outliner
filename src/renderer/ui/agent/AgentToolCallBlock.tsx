import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCall, ToolResultMessage } from '../../../core/agentTypes';
import {
  AddIcon,
  CheckIcon,
  CodeIcon,
  CopyIcon,
  FileTextIcon,
  ICON_SIZE,
  LoaderIcon,
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
  pendingToolCallIds?: ReadonlySet<string>;
  result?: ToolResultMessage;
  toolCall: ToolCall;
  turnActive?: boolean;
}

export type ToolStatus = 'pending' | 'done' | 'error';

type ResultPart =
  | { type: 'imagePlaceholder' }
  | { type: 'text'; text: string };

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
  result: ToolResultMessage | undefined,
  pendingToolCallIds: ReadonlySet<string> | undefined,
  turnActive: boolean | undefined,
): ToolStatus {
  if (!result) {
    return pendingToolCallIds?.has(toolCallId) || turnActive ? 'pending' : 'error';
  }
  return result.isError ? 'error' : 'done';
}

function getToolIcon(toolCall: ToolCall) {
  if (toolCall.name === 'node_create') return AddIcon;
  if (toolCall.name === 'node_read') return FileTextIcon;
  if (toolCall.name === 'node_search' || toolCall.name === 'web_search') return SearchIcon;
  if (toolCall.name === 'node_delete') {
    return toolCall.arguments.restore === true ? RestoreIcon : TrashIcon;
  }
  if (toolCall.name === 'web_fetch') return UrlIcon;
  if (toolCall.name === 'bash') return TerminalIcon;
  if (toolCall.name === 'file_edit') return CodeIcon;
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

function resultText(result: ToolResultMessage | undefined): string {
  if (!result) return '';
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function getToolResultCopyText(result: ToolResultMessage | undefined): string {
  return resultText(result);
}

function isImagePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '[Image removed]' || trimmed.startsWith('[Image removed') || trimmed === '<image>';
}

function resultParts(result: ToolResultMessage | undefined, expanded: boolean): ResultPart[] {
  if (!result || !expanded) return [];
  return result.content
    .filter((block): block is Extract<ToolResultMessage['content'][number], { type: 'text' }> =>
      block.type === 'text')
    .map((block) =>
      isImagePlaceholder(block.text)
        ? { type: 'imagePlaceholder' }
        : { type: 'text', text: block.text },
    );
}

function resultImages(result: ToolResultMessage | undefined): Array<{ data: string; mimeType: string }> {
  if (!result) return [];
  return result.content
    .filter((block): block is Extract<ToolResultMessage['content'][number], { type: 'image' }> =>
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

export function AgentToolCallBlock({
  defaultExpanded = false,
  expanded,
  onToggle,
  pendingToolCallIds,
  result,
  toolCall,
  turnActive,
}: AgentToolCallBlockProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const status = getToolCallStatus(toolCall.id, result, pendingToolCallIds, turnActive);
  const Icon = getToolIcon(toolCall);
  const StatusIcon = status === 'pending' ? LoaderIcon : Icon;
  const isExpanded = expanded ?? internalExpanded;
  const inputText = useMemo(() => jsonText(toolCall.arguments), [toolCall.arguments]);
  const outputText = useMemo(() => resultText(result), [result]);
  const images = useMemo(() => resultImages(result), [result]);
  const parts = useMemo(() => resultParts(result, isExpanded), [result, isExpanded]);
  const details = result?.details;
  const envelope = isToolEnvelope(details) ? details : null;
  const hasDetails = inputText !== '{}' || outputText.length > 0 || envelope !== null;
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
      summary={summarizeToolCall(toolCall, status)}
    >
      {inputText !== '{}' ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">Input</div>
            <ToolCopyButton ariaLabel="Copy tool input" text={inputText} />
          </div>
          <pre>{inputText}</pre>
        </section>
      ) : null}
      {result && hasOutputDetails ? (
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
                <FileTextIcon size={14} />
                <span>Screenshot captured</span>
              </div>
            ) : (
              <pre key={`text-${index}`}>{part.text}</pre>
            ),
          ) : null}
        </section>
      ) : null}
    </AgentToolCallDisclosure>
  );
}
