import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentMessage,
  AgentToolResultWithPayloads,
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from '../../../core/agentTypes';
import type { AgentRenderSubagentEntity } from '../../../core/agentRenderProjection';
import { isHiddenAgentContextBlock } from '../../../core/agentAttachments';
import { api } from '../../api/client';
import {
  AgentIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  FileTextIcon,
  ICON_SIZE,
  LoaderIcon,
  WarningIcon,
} from '../icons';
import { IconButton } from '../primitives/IconButton';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentThinkingBody } from './AgentThinkingBlock';
import { AgentToolCallBlock } from './AgentToolCallBlock';
import { useT } from '../../i18n/I18nProvider';

interface AgentSubagentDetailsPanelProps {
  onClose: () => void;
  sessionId: string | null;
  subagent: AgentRenderSubagentEntity | null;
  subagentsByParentToolCallId?: Map<string, AgentRenderSubagentEntity>;
}

function formatDuration(startedAt: number, endedAt: number): string {
  const elapsed = Math.max(0, endedAt - startedAt);
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

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function compactText(text: string, maxLength = 280): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized;
}

function stripSystemReminder(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('<system-reminder>')) return text;
  return trimmed
    .replace(/^<system-reminder>\s*/, '')
    .replace(/\s*<\/system-reminder>$/, '')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  return value.role === 'user' || value.role === 'assistant' || value.role === 'toolResult';
}

function parseTranscript(raw: string | null): AgentMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.messages)) return [];
    return parsed.messages.filter(isAgentMessage);
  } catch {
    return [];
  }
}

function toolResultFromMessage(message: ToolResultMessage): AgentToolResultWithPayloads {
  return {
    ...message,
    payloadRefs: [],
  };
}

function buildToolResultMap(messages: readonly AgentMessage[]): Map<string, AgentToolResultWithPayloads> {
  const results = new Map<string, AgentToolResultWithPayloads>();
  for (const message of messages) {
    if (message.role !== 'toolResult') continue;
    results.set(message.toolCallId, toolResultFromMessage(message));
  }
  return results;
}

function collectPendingToolCallIds(messages: readonly AgentMessage[], running: boolean): Set<string> {
  if (!running) return new Set();
  const toolResults = buildToolResultMap(messages);
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && !toolResults.has(block.id)) pending.add(block.id);
    }
  }
  return pending;
}

function textFromUserContent(content: UserMessage['content']): {
  hidden: boolean;
  images: ImageContent[];
  text: string;
} {
  if (typeof content === 'string') {
    return {
      hidden: isHiddenAgentContextBlock(content),
      images: [],
      text: isHiddenAgentContextBlock(content) ? stripSystemReminder(content) : content,
    };
  }
  const textBlocks: string[] = [];
  const images: ImageContent[] = [];
  let hidden = false;
  for (const block of content) {
    if (block.type === 'image') {
      images.push(block);
      continue;
    }
    if (isHiddenAgentContextBlock(block.text)) hidden = true;
    textBlocks.push(isHiddenAgentContextBlock(block.text) ? stripSystemReminder(block.text) : block.text);
  }
  return { hidden, images, text: textBlocks.join('\n\n') };
}

function textFromToolResult(message: ToolResultMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function ResultText({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

  async function copy() {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="agent-subagent-result-box">
      <div className="agent-subagent-result-actions">
        <IconButton
          className="agent-message-action-button"
          disabled={!text}
          icon={CopyStateIcon}
          label={t.agent.subagent.copyResult}
          onClick={() => void copy()}
          title={t.agent.message.copy}
          variant="message"
        />
      </div>
      <AgentMarkdown keyPrefix="subagent-result" text={text || t.agent.subagent.noResultYet} />
    </div>
  );
}

function TranscriptUserMessage({ message }: { message: UserMessage }) {
  const t = useT();
  const content = textFromUserContent(message.content);
  return (
    <article className={content.hidden ? 'agent-subagent-transcript-message is-system' : 'agent-subagent-transcript-message is-user'}>
      <div className="agent-subagent-transcript-head">
        <span>{content.hidden ? t.agent.subagent.roleSystem : t.agent.subagent.roleUser}</span>
        <time>{formatTime(message.timestamp)}</time>
      </div>
      {content.text.trim() ? <AgentMarkdown keyPrefix={`subagent-user-${message.timestamp}`} text={content.text} /> : null}
      {content.images.length > 0 ? (
        <div className="agent-subagent-image-list">
          {content.images.map((image, index) => (
            <img
              alt=""
              key={`${image.mimeType}-${index}`}
              src={`data:${image.mimeType};base64,${image.data}`}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function TranscriptThinking({ block, index }: { block: ThinkingContent; index: number }) {
  const t = useT();
  if (block.redacted || !block.thinking.trim()) return null;
  return (
    <details className="agent-subagent-thinking">
      <summary>{t.agent.subagent.thoughtNumbered({ index: index + 1 })}</summary>
      <AgentThinkingBody streaming={false} text={block.thinking} />
    </details>
  );
}

function TranscriptAssistantMessage({
  message,
  pendingToolCallIds,
  sessionId,
  subagentsByParentToolCallId,
  toolResults,
}: {
  message: AssistantMessage;
  pendingToolCallIds: ReadonlySet<string>;
  sessionId: string | null;
  subagentsByParentToolCallId?: Map<string, AgentRenderSubagentEntity>;
  toolResults: Map<string, AgentToolResultWithPayloads>;
}) {
  const t = useT();
  return (
    <article className="agent-subagent-transcript-message is-assistant">
      <div className="agent-subagent-transcript-head">
        <span>{t.agent.subagent.roleAssistant}</span>
        <time>{formatTime(message.timestamp)}</time>
      </div>
      <div className="agent-subagent-assistant-body">
        {message.content.map((block, index) => {
          if (block.type === 'text') {
            return block.text.trim()
              ? <AgentMarkdown key={`text-${index}`} keyPrefix={`subagent-assistant-${message.timestamp}-${index}`} text={block.text} />
              : null;
          }
          if (block.type === 'thinking') {
            return <TranscriptThinking block={block} index={index} key={`thinking-${index}`} />;
          }
          return (
            <AgentToolCallBlock
              defaultExpanded={false}
              key={`tool-${block.id}`}
              pendingToolCallIds={pendingToolCallIds}
              result={toolResults.get(block.id)}
              sessionId={sessionId}
              subagent={subagentsByParentToolCallId?.get(block.id)}
              toolCall={block as ToolCall}
              turnActive={pendingToolCallIds.has(block.id)}
            />
          );
        })}
      </div>
    </article>
  );
}

function TranscriptOrphanToolResult({ message }: { message: ToolResultMessage }) {
  const t = useT();
  const text = textFromToolResult(message);
  if (!text) return null;
  return (
    <article className="agent-subagent-transcript-message is-tool-result">
      <div className="agent-subagent-transcript-head">
        <span>{t.agent.subagent.roleToolResult}</span>
        <time>{formatTime(message.timestamp)}</time>
      </div>
      <pre>{compactText(text, 1200)}</pre>
    </article>
  );
}

function TranscriptTimeline({
  error,
  loading,
  messages,
  pendingToolCallIds,
  reload,
  sessionId,
  subagent,
  subagentsByParentToolCallId,
  toolResults,
}: {
  error: string | null;
  loading: boolean;
  messages: AgentMessage[];
  pendingToolCallIds: ReadonlySet<string>;
  reload: () => void;
  sessionId: string | null;
  subagent: AgentRenderSubagentEntity;
  subagentsByParentToolCallId?: Map<string, AgentRenderSubagentEntity>;
  toolResults: Map<string, AgentToolResultWithPayloads>;
}) {
  const t = useT();
  if (!subagent.transcriptPayloadId) {
    return <div className="agent-subagent-empty">{t.agent.subagent.transcriptNotAvailable}</div>;
  }
  if (loading && messages.length === 0) {
    return (
      <div className="agent-subagent-empty">
        <LoaderIcon className="agent-tool-call-spinner" size={ICON_SIZE.menu} />
        <span>{t.agent.subagent.loadingTranscript}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className="agent-subagent-empty is-error">
        <WarningIcon size={ICON_SIZE.menu} />
        <span>{error}</span>
        <ButtonControl className="agent-subagent-small-button" onClick={reload}>{t.agent.subagent.retry}</ButtonControl>
      </div>
    );
  }
  if (messages.length === 0) {
    return <div className="agent-subagent-empty">{t.agent.subagent.noTranscriptMessages}</div>;
  }

  const assistantToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall') assistantToolCallIds.add(block.id);
    }
  }

  return (
    <div className="agent-subagent-transcript-list">
      {messages.map((message, index) => {
        if (message.role === 'user') return <TranscriptUserMessage key={`user-${index}`} message={message} />;
        if (message.role === 'assistant') {
          return (
            <TranscriptAssistantMessage
              key={`assistant-${index}`}
              message={message}
              pendingToolCallIds={pendingToolCallIds}
              sessionId={sessionId}
              subagentsByParentToolCallId={subagentsByParentToolCallId}
              toolResults={toolResults}
            />
          );
        }
        if (assistantToolCallIds.has(message.toolCallId)) return null;
        return <TranscriptOrphanToolResult key={`tool-result-${index}`} message={message} />;
      })}
    </div>
  );
}

export function AgentSubagentDetailsPanel({
  onClose,
  sessionId,
  subagent,
  subagentsByParentToolCallId,
}: AgentSubagentDetailsPanelProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<'timeline' | 'result' | 'metadata'>('timeline');
  const [followUpDraft, setFollowUpDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<'send' | 'stop' | null>(null);
  const [rawTranscript, setRawTranscript] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const loadTranscript = useCallback(() => {
    if (!sessionId || !subagent?.transcriptPayloadId) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    void api.agentPayloadText(sessionId, subagent.transcriptPayloadId)
      .then((text) => {
        if (requestId !== requestRef.current) return;
        if (text === null) {
          setRawTranscript(null);
          setError(t.agent.subagent.transcriptPayloadUnavailable);
          return;
        }
        setRawTranscript(text);
      })
      .catch((caught) => {
        if (requestId === requestRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }, [sessionId, subagent?.transcriptPayloadId, t.agent.subagent.transcriptPayloadUnavailable]);

  useEffect(() => {
    setActiveTab('timeline');
    setFollowUpDraft('');
    setActionError(null);
    setActionPending(null);
    setRawTranscript(null);
    setError(null);
    requestRef.current += 1;
  }, [subagent?.id]);

  useEffect(() => {
    if (!subagent) return undefined;
    loadTranscript();
    return () => {
      requestRef.current += 1;
    };
  }, [loadTranscript, subagent?.id]);

  const messages = useMemo(() => parseTranscript(rawTranscript), [rawTranscript]);
  const toolResults = useMemo(() => buildToolResultMap(messages), [messages]);
  const pendingToolCallIds = useMemo(
    () => collectPendingToolCallIds(messages, subagent?.status === 'running'),
    [messages, subagent?.status],
  );

  if (!subagent) return null;

  const endedAt = subagent.completedAt ?? subagent.updatedAt;
  const canSendFollowUp = true;
  const canStop = subagent.status === 'running';
  const tabs = [
    ['timeline', t.agent.subagent.tabTimeline({ count: messages.length || subagent.transcriptMessageCount })],
    ['result', t.agent.subagent.tabResult],
    ['metadata', t.agent.subagent.tabMetadata],
  ] as const;

  async function sendFollowUp() {
    const message = followUpDraft.trim();
    if (!sessionId || !subagent || !message || !canSendFollowUp || actionPending) return;
    setActionPending('send');
    setActionError(null);
    try {
      await api.agentSubagentSend(sessionId, subagent.id, message);
      setFollowUpDraft('');
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionPending(null);
    }
  }

  async function stopSubagent() {
    if (!sessionId || !subagent || !canStop || actionPending) return;
    setActionPending('stop');
    setActionError(null);
    try {
      await api.agentSubagentStop(sessionId, subagent.id);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionPending(null);
    }
  }

  return (
    <aside className="agent-subagent-details-panel" aria-label={t.agent.subagent.detailsAriaLabel}>
      <header className="agent-subagent-details-header">
        <div className="agent-subagent-title-block">
          <div className="agent-subagent-title-line">
            <AgentIcon size={ICON_SIZE.menu} />
            <span>{t.agent.subagent.heading}</span>
            <span className={`agent-subagent-status is-${subagent.status}`}>{subagent.status}</span>
          </div>
          <h3>{subagent.description || subagent.name || subagent.id}</h3>
          <p>
            {t.agent.subagent.metaLine({
              mode: subagent.contextMode,
              type: subagent.subagentType,
              count: subagent.transcriptMessageCount,
              duration: formatDuration(subagent.startedAt, endedAt),
            })}
          </p>
        </div>
        <IconButton
          className="agent-subagent-close"
          icon={CloseIcon}
          label={t.agent.subagent.closeDetails}
          onClick={onClose}
          title={t.agent.subagent.close}
          variant="panel"
        />
      </header>
      <nav className="agent-subagent-tabs" aria-label={t.agent.subagent.detailTabsAriaLabel}>
        {tabs.map(([tab, label]) => (
          <ButtonControl
            aria-pressed={activeTab === tab}
            className={activeTab === tab ? 'agent-subagent-tab is-active' : 'agent-subagent-tab'}
            key={tab}
            onClick={() => setActiveTab(tab)}
          >
            {label}
          </ButtonControl>
        ))}
      </nav>
      <section className="agent-subagent-actions" aria-label={t.agent.subagent.actionsAriaLabel}>
        <div className="agent-subagent-followup">
          <textarea
            aria-label={t.agent.subagent.followUpAriaLabel}
            disabled={!canSendFollowUp || actionPending !== null}
            onChange={(event) => setFollowUpDraft(event.target.value)}
            onInput={(event) => setFollowUpDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void sendFollowUp();
              }
            }}
            placeholder={t.agent.subagent.followUpPlaceholder}
            rows={2}
            value={followUpDraft}
          />
          <div className="agent-subagent-action-buttons">
            {canStop ? (
              <ButtonControl
                className="agent-subagent-stop-button"
                disabled={actionPending !== null}
                onClick={() => void stopSubagent()}
              >
                {actionPending === 'stop' ? t.agent.subagent.stopping : t.agent.subagent.stop}
              </ButtonControl>
            ) : null}
            <ButtonControl
              className="agent-subagent-send-button"
              disabled={!canSendFollowUp || !followUpDraft.trim() || actionPending !== null}
              onClick={() => void sendFollowUp()}
            >
              {actionPending === 'send' ? t.agent.subagent.sending : t.agent.subagent.send}
            </ButtonControl>
          </div>
        </div>
        {actionError ? (
          <div className="agent-subagent-action-error" role="alert">
            <WarningIcon size={ICON_SIZE.menu} />
            <span>{actionError}</span>
          </div>
        ) : null}
      </section>
      <div className="agent-subagent-details-body">
        {activeTab === 'timeline' ? (
          <TranscriptTimeline
            error={error}
            loading={loading}
            messages={messages}
            pendingToolCallIds={pendingToolCallIds}
            reload={loadTranscript}
            sessionId={sessionId}
            subagent={subagent}
            subagentsByParentToolCallId={subagentsByParentToolCallId}
            toolResults={toolResults}
          />
        ) : null}
        {activeTab === 'result' ? (
          <ResultText text={subagent.result ?? subagent.error ?? ''} />
        ) : null}
        {activeTab === 'metadata' ? (
          <dl className="agent-subagent-metadata">
            <div>
              <dt>{t.agent.subagent.metaAgentId}</dt>
              <dd>{subagent.id}</dd>
            </div>
            <div>
              <dt>{t.agent.subagent.name}</dt>
              <dd>{subagent.name ?? t.agent.subagent.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.subagent.status}</dt>
              <dd>{subagent.status}</dd>
            </div>
            <div>
              <dt>{t.agent.subagent.mode}</dt>
              <dd>{subagent.contextMode}</dd>
            </div>
            <div>
              <dt>{t.agent.subagent.metaType}</dt>
              <dd>{subagent.subagentType}</dd>
            </div>
            <div>
              <dt>{t.agent.subagent.metaParentToolCall}</dt>
              <dd>{subagent.parentToolCallId ?? t.agent.subagent.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.subagent.metaTranscriptPayload}</dt>
              <dd>{subagent.transcriptPayloadId ?? t.agent.subagent.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.subagent.metaStarted}</dt>
              <dd>{new Date(subagent.startedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t.agent.subagent.metaUpdated}</dt>
              <dd>{new Date(subagent.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        ) : null}
      </div>
    </aside>
  );
}
