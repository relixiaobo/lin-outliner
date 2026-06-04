import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentToolResultPayloadPart, AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentRenderSubagentEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
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
  RecentsIcon,
  RestoreIcon,
  SearchIcon,
  TerminalIcon,
  TrashIcon,
  UrlIcon,
  WarningIcon,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';
import { highlightCode, plainCodeHtml } from '../editor/shikiHighlighter';
import {
  AgentInlineReferenceText,
  type AgentNodeReferenceOpenHandler,
} from './AgentInlineReferenceText';
import { AgentToolCallDisclosure } from './AgentToolCallDisclosure';

interface AgentToolCallBlockProps {
  defaultExpanded?: boolean;
  expanded?: boolean;
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
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

export function getToolIcon(toolCall: ToolCall) {
  if (
    toolCall.name === 'Agent'
    || toolCall.name === 'AgentStatus'
    || toolCall.name === 'AgentSend'
    || toolCall.name === 'AgentStop'
  ) return AgentIcon;
  if (toolCall.name === 'node_create') return NodeCreateToolIcon;
  if (toolCall.name === 'node_read') return FileTextIcon;
  if (toolCall.name === 'node_edit') return NodeEditToolIcon;
  if (toolCall.name === 'past_chats') {
    const mode = pastChatsMode(toolCall.arguments);
    if (mode === 'read') return FileTextIcon;
    if (mode === 'search') return SearchIcon;
    return RecentsIcon;
  }
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

type PastChatsMode = 'recent' | 'search' | 'read';

function pastChatsMode(args: Record<string, unknown>): PastChatsMode {
  if (pickSubject(args, 'message_id')) return 'read';
  if (pickSubject(args, 'query')) return 'search';
  return 'recent';
}

type ToolCallLabels = Messages['agent']['toolCall'];
type ToolVerbForms = { base: string; pending: string; done: string };

function quoteSubject(subject: string, labels: ToolCallLabels): string {
  const trimmed = subject.trim();
  const short = trimmed.length > 72 ? `${trimmed.slice(0, 72)}...` : trimmed;
  if (short.startsWith('http://') || short.startsWith('https://')) return short;
  return labels.quote({ text: short });
}

function verbByStatus(forms: ToolVerbForms, status: ToolStatus, labels: ToolCallLabels): string {
  if (status === 'pending') return forms.pending;
  if (status === 'done') return forms.done;
  return labels.failed({ verb: forms.base });
}

function withSubject(verb: string, subject: string | null, labels: ToolCallLabels): string {
  return subject ? labels.withSubject({ verb, subject: quoteSubject(subject, labels) }) : verb;
}

export function summarizeToolCall(toolCall: ToolCall, status: ToolStatus, labels: ToolCallLabels): string {
  const verbs = labels.verbs;
  if (toolCall.name === 'Agent') {
    const subject = pickSubject(toolCall.arguments, 'description', 'subagent_type');
    return withSubject(verbByStatus(verbs.runSubagent, status, labels), subject, labels);
  }
  if (toolCall.name === 'AgentStatus') return verbByStatus(verbs.checkSubagent, status, labels);
  if (toolCall.name === 'AgentSend') return verbByStatus(verbs.messageSubagent, status, labels);
  if (toolCall.name === 'AgentStop') return verbByStatus(verbs.stopSubagent, status, labels);
  const args = toolCall.arguments;
  if (toolCall.name === 'past_chats') {
    const mode = pastChatsMode(args);
    if (mode === 'read') {
      const subject = pickSubject(args, 'message_id');
      return withSubject(verbByStatus(verbs.readPastChat, status, labels), subject, labels);
    }
    if (mode === 'search') {
      const subject = pickSubject(args, 'query');
      return withSubject(verbByStatus(verbs.searchPastChats, status, labels), subject, labels);
    }
    return verbByStatus(verbs.listRecentPastChats, status, labels);
  }
  if (toolCall.name === 'node_create') {
    const subject = pickSubject(args, 'parentId', 'afterId');
    const verb = verbByStatus(verbs.createNode, status, labels);
    return subject ? labels.under({ verb, subject: quoteSubject(subject, labels) }) : verb;
  }
  if (toolCall.name === 'node_read') {
    const subject = pickSubject(args, 'nodeId');
    return withSubject(verbByStatus(verbs.readNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_edit') {
    const subject = pickSubject(args, 'nodeId');
    return withSubject(verbByStatus(verbs.editNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_delete') {
    const subject = pickSubject(args, 'nodeId');
    return withSubject(verbByStatus(verbs.deleteNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_search') {
    const subject = pickSubject(args, 'query', 'rules');
    return withSubject(verbByStatus(verbs.searchNodes, status, labels), subject, labels);
  }
  if (toolCall.name === 'web_search') {
    const subject = pickSubject(args, 'query');
    return withSubject(verbByStatus(verbs.searchWeb, status, labels), subject, labels);
  }
  if (toolCall.name === 'web_fetch') {
    const subject = pickSubject(args, 'url');
    return withSubject(verbByStatus(verbs.fetchWeb, status, labels), subject, labels);
  }
  if (toolCall.name === 'bash') {
    const command = pickSubject(args, 'command', 'cmd');
    const firstLine = command?.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
    return withSubject(verbByStatus(verbs.runBash, status, labels), firstLine, labels);
  }
  if (toolCall.name === 'file_edit') {
    const subject = pickSubject(args, 'path', 'file_path');
    return withSubject(verbByStatus(verbs.editFile, status, labels), subject, labels);
  }
  // Unknown tools fall back to the raw tool name (an identifier, not translatable);
  // only the trailing pending ellipsis is localized.
  return verbByStatus(
    { base: toolCall.name, pending: labels.unknownPending({ name: toolCall.name }), done: toolCall.name },
    status,
    labels,
  );
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

function subagentSummary(subagent: AgentRenderSubagentEntity, labels: Messages['agent']['subagent']): string {
  const description = subagent.description.trim() || subagent.name || subagent.id;
  return labels.summary({ description });
}

function previewText(text: string | undefined, maxLength = 520): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized;
}

function SubagentInlineDetails({
  index,
  onNodeReferenceOpen,
  onOpenTranscript,
  subagent,
}: {
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenTranscript?: (subagentId: string) => void;
  subagent: AgentRenderSubagentEntity;
}) {
  const t = useT();
  const result = previewText(subagent.result);
  const error = previewText(subagent.error);
  const prompt = previewText(subagent.prompt);
  const canOpenTranscript = !!subagent.transcriptPayloadId && !!onOpenTranscript;

  return (
    <div className="agent-subagent-inline">
      <dl className="agent-subagent-meta-grid">
        <div>
          <dt>{t.agent.subagent.status}</dt>
          <dd>{subagent.status}</dd>
        </div>
        <div>
          <dt>{t.agent.subagent.mode}</dt>
          <dd>{formatSubagentMode(subagent)}</dd>
        </div>
        <div>
          <dt>{t.agent.subagent.messages}</dt>
          <dd>{subagent.transcriptMessageCount}</dd>
        </div>
        <div>
          <dt>{t.agent.subagent.duration}</dt>
          <dd>{formatSubagentDuration(subagent)}</dd>
        </div>
      </dl>
      {subagent.name ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.subagent.name}</div>
          </div>
          <pre>
            <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={subagent.name} />
          </pre>
        </section>
      ) : null}
      {prompt ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.subagent.prompt}</div>
            <ToolCopyButton ariaLabel={t.agent.subagent.copyPrompt} text={subagent.prompt} />
          </div>
          <pre>
            <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={prompt} />
          </pre>
        </section>
      ) : null}
      {result ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.subagent.result}</div>
            <ToolCopyButton ariaLabel={t.agent.subagent.copyResult} text={subagent.result ?? ''} />
          </div>
          <pre>
            <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={result} />
          </pre>
        </section>
      ) : null}
      {error ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">
              {t.agent.subagent.error}
              <span>{t.agent.toolCall.errorBadge}</span>
            </div>
            <ToolCopyButton ariaLabel={t.agent.subagent.copyError} text={subagent.error ?? ''} />
          </div>
          <pre>
            <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={error} />
          </pre>
        </section>
      ) : null}
      <div className="agent-subagent-inline-actions">
        <ButtonControl
          className="agent-subagent-transcript-button"
          disabled={!canOpenTranscript}
          onClick={() => onOpenTranscript?.(subagent.id)}
        >
          <FileTextIcon size={ICON_SIZE.menu} />
          <span>{subagent.transcriptPayloadId ? t.agent.subagent.viewTranscript : t.agent.subagent.transcriptUnavailable}</span>
        </ButtonControl>
        <ToolCopyButton ariaLabel={t.agent.subagent.copyId} text={subagent.id} />
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

function isJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

// Read-only JSON surface for tool input/output. Renders plain text first, then
// upgrades to the shared Shiki highlight once it resolves (json is preloaded).
function HighlightedJson({ code }: { code: string }) {
  const [html, setHtml] = useState(() => plainCodeHtml(code));
  useEffect(() => {
    let cancelled = false;
    void highlightCode(code, 'json').then((next) => {
      if (!cancelled) setHtml(next);
    });
    return () => {
      cancelled = true;
    };
  }, [code]);
  return <div className="agent-tool-code" dangerouslySetInnerHTML={{ __html: html }} />;
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

function outputWindow(
  text: string,
  formatOmitted: (params: { count: string }) => string,
): { text: string; windowed: boolean } {
  const limit = TOOL_OUTPUT_WINDOW_HEAD_CHARS + TOOL_OUTPUT_WINDOW_TAIL_CHARS;
  if (text.length <= limit) return { text, windowed: false };
  const omitted = text.length - limit;
  return {
    text: [
      text.slice(0, TOOL_OUTPUT_WINDOW_HEAD_CHARS),
      '',
      formatOmitted({ count: omitted.toLocaleString() }),
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

function ToolResultImages({ images }: { images: Array<{ data: string; mimeType: string }> }) {
  const t = useT();
  if (images.length === 0) return null;
  return (
    <div className="agent-tool-image-list">
      {images.map((image, index) => {
        const src = `data:${image.mimeType};base64,${image.data}`;
        return (
          <a href={src} key={`${image.mimeType}-${index}`} rel="noreferrer" target="_blank">
            <img alt={t.agent.toolCall.resultImageAlt({ index: index + 1 })} loading="lazy" src={src} />
          </a>
        );
      })}
    </div>
  );
}

function PersistedToolOutput({
  initialText,
  index,
  onNodeReferenceOpen,
  payloadRef,
  sessionId,
}: {
  initialText: string;
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  payloadRef: AgentToolResultPayloadPart;
  sessionId?: string | null;
}) {
  const t = useT();
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const payload = payloadRef.payload;
  const visible = outputWindow(fullText ?? initialText, t.agent.toolCall.charsOmitted);
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
        setLoadError(t.agent.toolCall.payloadUnavailable);
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
        <span>{payload.summary || t.agent.toolCall.storedOutput}</span>
        <small>{formatBytes(payload.byteLength)}</small>
      </div>
      <pre>
        <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={visible.text} />
      </pre>
      <div className="agent-tool-persisted-actions">
        <ButtonControl
          className="agent-tool-persisted-load"
          disabled={!canLoad || loading}
          onClick={() => void loadFullOutput()}
        >
          <FileTextIcon size={ICON_SIZE.menu} />
          <span>{fullText ? t.agent.toolCall.reloadFullOutput : loading ? t.common.loading : t.agent.toolCall.loadFullOutput}</span>
        </ButtonControl>
        {fullText ? (
          <ToolCopyButton ariaLabel={t.agent.toolCall.copyFullOutput} text={fullText} />
        ) : null}
        {visible.windowed ? (
          <small>{t.agent.toolCall.windowed}</small>
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
  index,
  onNodeReferenceOpen,
  onToggle,
  onOpenSubagentTranscript,
  pendingToolCallIds,
  result,
  sessionId,
  subagent,
  toolCall,
  turnActive,
}: AgentToolCallBlockProps) {
  const t = useT();
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const status = subagent ? subagentToolStatus(subagent) : getToolCallStatus(toolCall.id, result, pendingToolCallIds, turnActive);
  const Icon = getToolIcon(toolCall);
  const StatusIcon = status === 'pending' ? LoaderIcon : Icon;
  const isExpanded = expanded ?? internalExpanded;
  const inputText = useMemo(() => jsonText(toolCall.arguments), [toolCall.arguments]);
  const outputText = useMemo(() => resultText(result), [result]);
  const images = useMemo(() => resultImages(result), [result]);
  const parts = useMemo(() => resultParts(result, isExpanded), [result, isExpanded]);
  const hasSubagentDetails = Boolean(subagent);
  const hasDetails = hasSubagentDetails || inputText !== '{}' || outputText.length > 0;
  const hasOutputDetails = outputText.length > 0;

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
      summary={subagent ? subagentSummary(subagent, t.agent.subagent) : summarizeToolCall(toolCall, status, t.agent.toolCall)}
    >
      {subagent ? (
        <SubagentInlineDetails
          index={index}
          onNodeReferenceOpen={onNodeReferenceOpen}
          onOpenTranscript={onOpenSubagentTranscript}
          subagent={subagent}
        />
      ) : null}
      {!hasSubagentDetails && inputText !== '{}' ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.toolCall.input}</div>
            <ToolCopyButton ariaLabel={t.agent.toolCall.copyInput} text={inputText} />
          </div>
          <HighlightedJson code={inputText} />
        </section>
      ) : null}
      {!hasSubagentDetails && result && hasOutputDetails ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">
              {t.agent.toolCall.output}
              {result.isError ? <span>{t.agent.toolCall.errorBadge}</span> : null}
            </div>
            <ToolCopyButton ariaLabel={t.agent.toolCall.copyOutput} text={outputText} />
          </div>
          {parts.map((part, partIndex) =>
            part.type === 'imagePlaceholder' ? (
              <div className="agent-tool-image-placeholder" key={`placeholder-${partIndex}`}>
                <FileTextIcon size={ICON_SIZE.menu} />
                <span>{t.agent.toolCall.screenshotCaptured}</span>
              </div>
            ) : part.type === 'persistedOutput' ? (
              <PersistedToolOutput
                initialText={part.text}
                index={index}
                key={`payload-${part.payloadRef.payload.id}`}
                onNodeReferenceOpen={onNodeReferenceOpen}
                payloadRef={part.payloadRef}
                sessionId={sessionId}
              />
            ) : isJsonText(part.text) ? (
              <HighlightedJson code={part.text} key={`text-${partIndex}`} />
            ) : (
              <pre key={`text-${partIndex}`}>
                <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={part.text} />
              </pre>
            ),
          )}
        </section>
      ) : null}
    </AgentToolCallDisclosure>
  );
}
