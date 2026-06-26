import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentMessage,
  AgentToolResultWithPayloads,
  ToolResultMessage,
} from '../../../core/agentTypes';
import type { Messages } from '../../../core/i18n';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import {
  AgentIcon,
  BackIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ICON_SIZE,
  LoaderIcon,
  WarningIcon,
} from '../icons';
import { IconButton } from '../primitives/IconButton';
import { Button } from '../primitives/Button';
import { CheckboxMark } from '../primitives/CheckboxMark';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentTranscriptMessageList } from './AgentTranscriptMessageList';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { formatRunDuration } from './agentProcessTypes';
import { useT } from '../../i18n/I18nProvider';

interface AgentChildRunDetailsPanelProps {
  onBack?: () => void;
  onClose: () => void;
  conversationId: string | null;
  index: DocumentIndex;
  childRun: AgentRenderChildRunEntity | null;
  childRuns?: Record<string, AgentRenderChildRunEntity>;
  childRunsByParentToolCallId?: Map<string, AgentRenderChildRunEntity>;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenChildRunTranscript?: (childRunId: string) => void;
}

/** Live-run transcript poll cadence (the fetch is meta-keyed in main, near-free when unchanged). */
const LIVE_TRANSCRIPT_POLL_MS = 1_500;

function formatDuration(startedAt: number, endedAt: number): string {
  return formatRunDuration(endedAt - startedAt);
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

function transcriptHasActiveAssistantTurn(
  messages: readonly AgentMessage[],
  running: boolean,
  pendingToolCallIds: ReadonlySet<string>,
): boolean {
  if (!running) return false;
  if (pendingToolCallIds.size > 0) return true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant') return message.stopReason === null;
    if (message.role === 'user') return false;
  }
  return false;
}

function runTitle(run: AgentRenderChildRunEntity, labels: Messages['agent']): string {
  if (run.agentType === 'verifier') return labels.run.kind.verifier;
  return run.description || run.name || run.id;
}

function runStatusLabel(
  status: AgentRenderChildRunEntity['status'],
  labels: Messages['agent']['run']['status'],
): string {
  switch (status) {
    case 'running':
      return labels.running;
    case 'completed':
      return labels.completed;
    case 'failed':
      return labels.failed;
    case 'stopped':
      return labels.stopped;
  }
}

function compareChildRuns(left: AgentRenderChildRunEntity, right: AgentRenderChildRunEntity): number {
  return left.startedAt - right.startedAt || left.id.localeCompare(right.id);
}

function directChildRunsFor(
  childRuns: Record<string, AgentRenderChildRunEntity> | undefined,
  parentRunId: string | undefined,
): AgentRenderChildRunEntity[] {
  if (!childRuns || !parentRunId) return [];
  return Object.values(childRuns)
    .filter((run) => run.parentRunId === parentRunId)
    .sort(compareChildRuns);
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

function DetailSection({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="agent-child-run-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function ChildRunList({
  runs,
  onOpenChildRunTranscript,
}: {
  runs: AgentRenderChildRunEntity[];
  onOpenChildRunTranscript?: (childRunId: string) => void;
}) {
  const t = useT();
  return (
    <div className="agent-child-run-child-list">
      {runs.map((run) => {
        const completed = run.status === 'completed';
        const title = runTitle(run, t.agent);
        const meta = [
          runStatusLabel(run.status, t.agent.run.status),
          run.contextMode,
          formatDuration(run.startedAt, run.completedAt ?? run.updatedAt),
        ].join(' · ');
        return (
          <button
            className={`agent-child-run-child-row is-${run.status}`}
            disabled={!onOpenChildRunTranscript}
            key={run.id}
            onClick={() => onOpenChildRunTranscript?.(run.id)}
            type="button"
          >
            <span className={`agent-run-marker is-${run.status}`} aria-hidden="true">
              <CheckboxMark checked={completed} />
            </span>
            <span className="agent-child-run-child-main">
              <span className="agent-child-run-child-title">{title}</span>
              <span className="agent-child-run-child-meta">{meta}</span>
            </span>
          </button>
        );
      })}
    </div>
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
  index,
  onNodeReferenceOpen,
  onOpenChildRunTranscript,
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
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenChildRunTranscript?: (childRunId: string) => void;
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

  return (
    <AgentTranscriptMessageList
      active={transcriptHasActiveAssistantTurn(messages, childRun.status === 'running', pendingToolCallIds)}
      childRun={childRun}
      childRunsByParentToolCallId={childRunsByParentToolCallId}
      className="agent-child-run-transcript-list"
      conversationId={conversationId}
      index={index}
      messages={messages}
      onNodeReferenceOpen={onNodeReferenceOpen}
      onOpenChildRunTranscript={onOpenChildRunTranscript}
      pendingToolCallIds={pendingToolCallIds}
      toolResults={toolResults}
    />
  );
}

export function AgentChildRunDetailsPanel({
  onBack,
  onClose,
  conversationId,
  index,
  childRun,
  childRuns,
  childRunsByParentToolCallId,
  onNodeReferenceOpen,
  onOpenChildRunTranscript,
}: AgentChildRunDetailsPanelProps) {
  const t = useT();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<'stop' | null>(null);
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
  const directChildRuns = useMemo(
    () => directChildRunsFor(childRuns, childRun?.id),
    [childRuns, childRun?.id],
  );

  if (!childRun) return null;

  const endedAt = childRun.completedAt ?? childRun.updatedAt;
  const canStop = childRun.status === 'running';
  const duration = formatDuration(childRun.startedAt, endedAt);
  const resultText = childRun.result ?? childRun.error ?? '';

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
    <section className="agent-child-run-details-panel" aria-label={t.agent.childRun.detailsAriaLabel}>
      <header className="agent-child-run-details-header">
        {onBack ? (
          <IconButton
            className="agent-child-run-back"
            icon={BackIcon}
            label={t.agent.run.backToRuns}
            onClick={onBack}
            title={t.agent.run.backToRuns}
            variant="panel"
          />
        ) : null}
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
        <div className="agent-child-run-header-actions">
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
          <IconButton
            className="agent-child-run-close"
            icon={CloseIcon}
            label={t.agent.childRun.closeDetails}
            onClick={onClose}
            title={t.agent.childRun.close}
            variant="panel"
          />
        </div>
      </header>
      {actionError ? (
        <div className="agent-child-run-action-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{actionError}</span>
        </div>
      ) : null}
      <div className="agent-child-run-details-body">
        <DetailSection title={t.agent.childRun.sectionOverview}>
          <dl className="agent-child-run-summary">
            <div>
              <dt>{t.agent.childRun.status}</dt>
              <dd>{runStatusLabel(childRun.status, t.agent.run.status)}</dd>
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
              <dt>{t.agent.childRun.duration}</dt>
              <dd>{duration}</dd>
            </div>
          </dl>
        </DetailSection>
        <DetailSection title={t.agent.childRun.sectionResult}>
          <ResultText text={resultText} />
        </DetailSection>
        {directChildRuns.length > 0 ? (
          <DetailSection title={t.agent.childRun.sectionChildRuns({ count: directChildRuns.length })}>
            <ChildRunList
              runs={directChildRuns}
              onOpenChildRunTranscript={onOpenChildRunTranscript}
            />
          </DetailSection>
        ) : null}
        <DetailSection title={t.agent.childRun.sectionTimeline({ count: messages.length })}>
          <TranscriptTimeline
            error={error}
            loading={loading}
            messages={messages}
            pendingToolCallIds={pendingToolCallIds}
            reload={loadTranscript}
            conversationId={conversationId}
            childRun={childRun}
            childRunsByParentToolCallId={childRunsByParentToolCallId}
            index={index}
            onNodeReferenceOpen={onNodeReferenceOpen}
            onOpenChildRunTranscript={onOpenChildRunTranscript}
            toolResults={toolResults}
          />
        </DetailSection>
        <DetailSection title={t.agent.childRun.sectionMetadata}>
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
        </DetailSection>
      </div>
    </section>
  );
}
