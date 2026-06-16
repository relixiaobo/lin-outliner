import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
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
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
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
import { resolveMenuNavigation } from '../primitives/useMenuKeyboard';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { IconButton } from '../primitives/IconButton';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { Textarea } from '../primitives/Textarea';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentThinkingBody } from './AgentThinkingBlock';
import { AgentToolCallBlock } from './AgentToolCallBlock';
import { formatRunDuration } from './agentProcessTypes';
import { useT } from '../../i18n/I18nProvider';

interface AgentChildRunDetailsPanelProps {
  onClose: () => void;
  conversationId: string | null;
  childRun: AgentRenderChildRunEntity | null;
  childRunsByParentToolCallId?: Map<string, AgentRenderChildRunEntity>;
}

/** Live-run transcript poll cadence (the fetch is meta-keyed in main, near-free when unchanged). */
const LIVE_TRANSCRIPT_POLL_MS = 1_500;

function formatDuration(startedAt: number, endedAt: number): string {
  return formatRunDuration(endedAt - startedAt);
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

function parseTranscript(raw: unknown[] | null): AgentMessage[] {
  if (!raw) return [];
  return raw.filter(isAgentMessage);
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
    <div className="agent-child-run-result-box">
      <div className="agent-child-run-result-actions">
        <IconButton
          className="agent-message-action-button"
          disabled={!text}
          icon={CopyStateIcon}
          label={t.agent.childRun.copyResult}
          onClick={() => void copy()}
          title={t.agent.message.copy}
          variant="message"
        />
      </div>
      <AgentMarkdown keyPrefix="child-run-result" text={text || t.agent.childRun.noResultYet} />
    </div>
  );
}

function TranscriptUserMessage({ message }: { message: UserMessage }) {
  const t = useT();
  const content = textFromUserContent(message.content);
  return (
    <article className={content.hidden ? 'agent-child-run-transcript-message is-system' : 'agent-child-run-transcript-message is-user'}>
      <div className="agent-child-run-transcript-head">
        <span>{content.hidden ? t.agent.childRun.roleSystem : t.agent.childRun.roleUser}</span>
        <time>{formatTime(message.timestamp)}</time>
      </div>
      {content.text.trim() ? <AgentMarkdown keyPrefix={`child-run-user-${message.timestamp}`} text={content.text} /> : null}
      {content.images.length > 0 ? (
        <div className="agent-child-run-image-list">
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
    <details className="agent-child-run-thinking">
      <summary>{t.agent.childRun.thoughtNumbered({ index: index + 1 })}</summary>
      <AgentThinkingBody streaming={false} text={block.thinking} />
    </details>
  );
}

function TranscriptAssistantMessage({
  message,
  pendingToolCallIds,
  conversationId,
  childRunsByParentToolCallId,
  toolResults,
}: {
  message: AssistantMessage;
  pendingToolCallIds: ReadonlySet<string>;
  conversationId: string | null;
  childRunsByParentToolCallId?: Map<string, AgentRenderChildRunEntity>;
  toolResults: Map<string, AgentToolResultWithPayloads>;
}) {
  const t = useT();
  return (
    <article className="agent-child-run-transcript-message is-assistant">
      <div className="agent-child-run-transcript-head">
        <span>{t.agent.childRun.roleAssistant}</span>
        <time>{formatTime(message.timestamp)}</time>
      </div>
      <div className="agent-child-run-assistant-body">
        {message.content.map((block, index) => {
          if (block.type === 'text') {
            return block.text.trim()
              ? <AgentMarkdown key={`text-${index}`} keyPrefix={`child-run-assistant-${message.timestamp}-${index}`} text={block.text} />
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
              conversationId={conversationId}
              childRun={childRunsByParentToolCallId?.get(block.id)}
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
    <article className="agent-child-run-transcript-message is-tool-result">
      <div className="agent-child-run-transcript-head">
        <span>{t.agent.childRun.roleToolResult}</span>
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
  conversationId,
  childRun,
  childRunsByParentToolCallId,
  toolResults,
}: {
  error: string | null;
  loading: boolean;
  messages: AgentMessage[];
  pendingToolCallIds: ReadonlySet<string>;
  reload: () => void;
  conversationId: string | null;
  childRun: AgentRenderChildRunEntity;
  childRunsByParentToolCallId?: Map<string, AgentRenderChildRunEntity>;
  toolResults: Map<string, AgentToolResultWithPayloads>;
}) {
  const t = useT();
  if (loading && messages.length === 0) {
    return (
      <EmptyState
        className="agent-child-run-empty"
        icon={LoaderIcon}
        iconClassName="agent-tool-call-spinner"
        loading
        role="status"
        title={t.agent.childRun.loadingTranscript}
      />
    );
  }
  if (error) {
    return (
      <ErrorState
        className="agent-child-run-empty"
        message={error}
        onRetry={reload}
        retryLabel={t.agent.childRun.retry}
      />
    );
  }
  if (messages.length === 0) {
    return <EmptyState className="agent-child-run-empty" title={t.agent.childRun.noTranscriptMessages} />;
  }

  const assistantToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall') assistantToolCallIds.add(block.id);
    }
  }

  return (
    <div className="agent-child-run-transcript-list">
      {messages.map((message, index) => {
        if (message.role === 'user') return <TranscriptUserMessage key={`user-${index}`} message={message} />;
        if (message.role === 'assistant') {
          return (
            <TranscriptAssistantMessage
              key={`assistant-${index}`}
              message={message}
              pendingToolCallIds={pendingToolCallIds}
              conversationId={conversationId}
              childRunsByParentToolCallId={childRunsByParentToolCallId}
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

export function AgentChildRunDetailsPanel({
  onClose,
  conversationId,
  childRun,
  childRunsByParentToolCallId,
}: AgentChildRunDetailsPanelProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<'timeline' | 'result' | 'metadata'>('timeline');
  const tablistRef = useRef<HTMLElement>(null);
  const TABPANEL_ID = 'agent-child-run-tabpanel';
  const tabButtonId = (tab: string) => `agent-child-run-tab-${tab}`;
  const [followUpDraft, setFollowUpDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<'send' | 'stop' | null>(null);
  const [rawTranscript, setRawTranscript] = useState<unknown[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const loadTranscript = useCallback(() => {
    if (!conversationId || !childRun?.id) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError(null);
    void api.agentChildRunTranscript(conversationId, childRun.id)
      .then((result) => {
        if (requestId !== requestRef.current) return;
        if (result === null) {
          setRawTranscript(null);
          setError(t.agent.childRun.transcriptPayloadUnavailable);
          return;
        }
        setRawTranscript(result.messages);
      })
      .catch((caught) => {
        if (requestId === requestRef.current) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }, [conversationId, childRun?.id, t.agent.childRun.transcriptPayloadUnavailable]);

  useEffect(() => {
    setActiveTab('timeline');
    setFollowUpDraft('');
    setActionError(null);
    setActionPending(null);
    setRawTranscript(null);
    setError(null);
    requestRef.current += 1;
  }, [childRun?.id]);

  // Fetch on open, refetch on every projected entity change (status flips,
  // updatedAt bumps), and POLL while the run is live: the conversation
  // projection carries no per-message child data, so polling the run ledger is
  // the only signal that new messages landed. The main process keys the
  // transcript on the ledger tail seq (one tiny run-meta read), so an
  // unchanged poll is near-free.
  useEffect(() => {
    if (!childRun) return undefined;
    loadTranscript();
    const interval = childRun.status === 'running'
      ? window.setInterval(loadTranscript, LIVE_TRANSCRIPT_POLL_MS)
      : null;
    return () => {
      if (interval !== null) window.clearInterval(interval);
      requestRef.current += 1;
    };
  }, [loadTranscript, childRun?.id, childRun?.status, childRun?.updatedAt]);

  const messages = useMemo(() => parseTranscript(rawTranscript), [rawTranscript]);
  const toolResults = useMemo(() => buildToolResultMap(messages), [messages]);
  const pendingToolCallIds = useMemo(
    () => collectPendingToolCallIds(messages, childRun?.status === 'running'),
    [messages, childRun?.status],
  );

  if (!childRun) return null;

  const endedAt = childRun.completedAt ?? childRun.updatedAt;
  const canSendFollowUp = true;
  const canStop = childRun.status === 'running';
  const tabs = [
    ['timeline', t.agent.childRun.tabTimeline({ count: messages.length })],
    ['result', t.agent.childRun.tabResult],
    ['metadata', t.agent.childRun.tabMetadata],
  ] as const;

  // Roving tab navigation (automatic activation): Arrow/Home/End move + select the
  // active tab, matching the ARIA tabs pattern.
  function onTabsKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (isImeComposingEvent(event)) return;
    const keys = tabs.map(([tab]) => tab);
    const index = keys.indexOf(activeTab);
    // A horizontal tablist also takes Left/Right; map them onto the shared
    // vertical resolver so the wrap math lives in one place.
    const key = event.key === 'ArrowRight' ? 'ArrowDown' : event.key === 'ArrowLeft' ? 'ArrowUp' : event.key;
    const next = resolveMenuNavigation(key, index, keys.length);
    if (next === null) return;
    event.preventDefault();
    setActiveTab(keys[next]!);
    tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  }

  async function sendFollowUp() {
    const message = followUpDraft.trim();
    if (!conversationId || !childRun || !message || !canSendFollowUp || actionPending) return;
    setActionPending('send');
    setActionError(null);
    try {
      await api.agentChildRunSend(conversationId, childRun.id, message);
      setFollowUpDraft('');
      // Refresh eagerly; anything the loop has not drained into the ledger
      // yet is picked up by the live poll on the next tick.
      loadTranscript();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionPending(null);
    }
  }

  async function stopChildRun() {
    if (!conversationId || !childRun || !canStop || actionPending) return;
    setActionPending('stop');
    setActionError(null);
    try {
      await api.agentChildRunStop(conversationId, childRun.id);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionPending(null);
    }
  }

  return (
    <aside className="agent-child-run-details-panel" aria-label={t.agent.childRun.detailsAriaLabel}>
      <header className="agent-child-run-details-header">
        <div className="agent-child-run-title-block">
          <div className="agent-child-run-title-line">
            <AgentIcon size={ICON_SIZE.menu} />
            <span>{t.agent.childRun.heading}</span>
            <span className={`agent-child-run-status is-${childRun.status}`}>{childRun.status}</span>
          </div>
          <h3>{childRun.description || childRun.name || childRun.id}</h3>
          <p>
            {t.agent.childRun.metaLine({
              mode: childRun.contextMode,
              type: childRun.agentType,
              count: messages.length,
              duration: formatDuration(childRun.startedAt, endedAt),
            })}
          </p>
        </div>
        <IconButton
          className="agent-child-run-close"
          icon={CloseIcon}
          label={t.agent.childRun.closeDetails}
          onClick={onClose}
          title={t.agent.childRun.close}
          variant="panel"
        />
      </header>
      <nav
        className="agent-child-run-tabs"
        aria-label={t.agent.childRun.detailTabsAriaLabel}
        onKeyDown={onTabsKeyDown}
        ref={tablistRef}
        role="tablist"
      >
        {tabs.map(([tab, label]) => {
          const active = activeTab === tab;
          return (
            <ButtonControl
              aria-controls={TABPANEL_ID}
              aria-selected={active}
              className={active ? 'agent-child-run-tab is-active' : 'agent-child-run-tab'}
              id={tabButtonId(tab)}
              key={tab}
              onClick={() => setActiveTab(tab)}
              role="tab"
              tabIndex={active ? 0 : -1}
            >
              {label}
            </ButtonControl>
          );
        })}
      </nav>
      <section className="agent-child-run-actions" aria-label={t.agent.childRun.actionsAriaLabel}>
        <div className="agent-child-run-followup">
          <Textarea
            className="agent-child-run-followup-input"
            label={t.agent.childRun.followUpAriaLabel}
            disabled={!canSendFollowUp || actionPending !== null}
            onChange={(event) => setFollowUpDraft(event.target.value)}
            onInput={(event) => setFollowUpDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void sendFollowUp();
              }
            }}
            placeholder={t.agent.childRun.followUpPlaceholder}
            rows={2}
            value={followUpDraft}
          />
          <div className="agent-child-run-action-buttons">
            {canStop ? (
              <Button
                disabled={actionPending !== null}
                onClick={() => void stopChildRun()}
                size="sm"
                variant="danger"
              >
                {actionPending === 'stop' ? t.agent.childRun.stopping : t.agent.childRun.stop}
              </Button>
            ) : null}
            <Button
              disabled={!canSendFollowUp || !followUpDraft.trim() || actionPending !== null}
              onClick={() => void sendFollowUp()}
              size="sm"
              variant="primary"
            >
              {actionPending === 'send' ? t.agent.childRun.sending : t.agent.childRun.send}
            </Button>
          </div>
        </div>
        {actionError ? (
          <div className="agent-child-run-action-error" role="alert">
            <WarningIcon size={ICON_SIZE.menu} />
            <span>{actionError}</span>
          </div>
        ) : null}
      </section>
      <div
        className="agent-child-run-details-body"
        role="tabpanel"
        id={TABPANEL_ID}
        aria-labelledby={tabButtonId(activeTab)}
        tabIndex={0}
      >
        {activeTab === 'timeline' ? (
          <TranscriptTimeline
            error={error}
            loading={loading}
            messages={messages}
            pendingToolCallIds={pendingToolCallIds}
            reload={loadTranscript}
            conversationId={conversationId}
            childRun={childRun}
            childRunsByParentToolCallId={childRunsByParentToolCallId}
            toolResults={toolResults}
          />
        ) : null}
        {activeTab === 'result' ? (
          <ResultText text={childRun.result ?? childRun.error ?? ''} />
        ) : null}
        {activeTab === 'metadata' ? (
          <dl className="agent-child-run-metadata">
            <div>
              <dt>{t.agent.childRun.metaAgentId}</dt>
              <dd>{childRun.id}</dd>
            </div>
            <div>
              <dt>{t.agent.childRun.name}</dt>
              <dd>{childRun.name ?? t.agent.childRun.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.childRun.status}</dt>
              <dd>{childRun.status}</dd>
            </div>
            <div>
              <dt>{t.agent.childRun.mode}</dt>
              <dd>{childRun.contextMode}</dd>
            </div>
            <div>
              <dt>{t.agent.childRun.metaType}</dt>
              <dd>{childRun.agentType}</dd>
            </div>
            <div>
              <dt>{t.agent.childRun.metaParentToolCall}</dt>
              <dd>{childRun.parentToolCallId ?? t.agent.childRun.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.childRun.metaParentRun}</dt>
              <dd>{childRun.parentRunId ?? t.agent.childRun.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.childRun.metaStarted}</dt>
              <dd>{new Date(childRun.startedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t.agent.childRun.metaUpdated}</dt>
              <dd>{new Date(childRun.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        ) : null}
      </div>
    </aside>
  );
}
