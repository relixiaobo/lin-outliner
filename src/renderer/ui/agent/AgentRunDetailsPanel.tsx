import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentMessage,
  AgentRunDetailPayload,
  AgentToolResultWithPayloads,
  ToolResultMessage,
} from '../../../core/agentTypes';
import type { Messages } from '../../../core/i18n';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
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

interface AgentRunDetailsPanelProps {
  onBack?: () => void;
  onClose: () => void;
  conversationId: string | null;
  runId: string | null;
  runUpdatedAt?: number;
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRun?: (runId: string, conversationId: string | null) => void;
  showHeader?: boolean;
}

type AgentRunDetailChild = AgentRunDetailPayload['subRuns'][number];
type DisplayRunStatus = AgentRunDetailPayload['status'] | NonNullable<AgentRunDetailPayload['objectiveStatus']>;

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

function displayStatusFor(detail: Pick<AgentRunDetailPayload, 'objectiveStatus' | 'status'>): DisplayRunStatus {
  if (detail.objectiveStatus && detail.objectiveStatus !== 'active' && detail.objectiveStatus !== 'stopped') {
    return detail.objectiveStatus;
  }
  return detail.status;
}

function runStatusClass(status: DisplayRunStatus): string {
  return status.replace(/_/g, '-');
}

function runStatusLabel(
  status: DisplayRunStatus,
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
    case 'verified':
      return labels.verified;
    case 'blocked':
      return labels.blocked;
    case 'budget_exhausted':
      return labels.budgetExhausted;
    case 'verifying':
      return labels.verifying;
    case 'active':
      return labels.running;
  }
}

function isCompletedStatus(status: DisplayRunStatus): boolean {
  return status === 'completed' || status === 'verified';
}

function isVerifierRun(run: Pick<AgentRunDetailChild, 'objectiveRole' | 'runProfile'>): boolean {
  return run.objectiveRole === 'verifier' || run.runProfile === 'verify';
}

function runTitle(run: AgentRunDetailChild, labels: Messages['agent']): string {
  if (isVerifierRun(run)) return labels.run.kind.verifier;
  return run.title || run.runId;
}

function compareRuns(left: AgentRunDetailChild, right: AgentRunDetailChild): number {
  return left.startedAt - right.startedAt || left.runId.localeCompare(right.runId);
}

function runDetailToTranscriptRun(detail: AgentRunDetailPayload): AgentRenderRunEntity {
  return {
    id: detail.runId,
    agentId: detail.agentId,
    anchor: detail.conversationId
      ? { type: 'conversation', agentId: detail.agentId, conversationId: detail.conversationId }
      : { type: 'principal', principal: { type: 'agent', agentId: detail.agentId } },
    conversationId: detail.conversationId ?? undefined,
    title: detail.title,
    parentRunId: detail.parentRunId,
    parentToolCallId: detail.parentToolCallId,
    runProfile: detail.runProfile,
    runProfileLabel: detail.runProfileLabel,
    status: detail.status,
    objectiveStatus: detail.objectiveStatus,
    objectiveRole: detail.objectiveRole,
    context: detail.context,
    startedAt: detail.startedAt,
    updatedAt: detail.updatedAt,
    completedAt: detail.completedAt,
  };
}

function childToTranscriptRun(child: AgentRunDetailChild, parent: AgentRunDetailPayload): AgentRenderRunEntity {
  return {
    id: child.runId,
    agentId: parent.agentId,
    anchor: parent.conversationId
      ? { type: 'conversation', agentId: parent.agentId, conversationId: parent.conversationId }
      : { type: 'principal', principal: { type: 'agent', agentId: parent.agentId } },
    conversationId: parent.conversationId ?? undefined,
    title: child.title,
    parentRunId: child.parentRunId,
    parentToolCallId: child.parentToolCallId,
    runProfile: child.runProfile,
    runProfileLabel: child.runProfileLabel,
    status: child.status,
    objectiveStatus: child.objectiveStatus,
    objectiveRole: child.objectiveRole,
    context: parent.context,
    startedAt: child.startedAt,
    updatedAt: child.updatedAt,
    completedAt: child.completedAt,
  };
}

function CopyResultButton({ text }: { text: string }) {
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
    <IconButton
      className="agent-message-action-button"
      disabled={!text}
      icon={CopyStateIcon}
      label={t.agent.runDetail.copyResult}
      onClick={() => void copy()}
      title={t.agent.message.copy}
      variant="message"
    />
  );
}

function ResultText({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="agent-child-run-result-box">
      <AgentMarkdown keyPrefix="run-detail-result" text={text || t.agent.runDetail.noResultYet} />
    </div>
  );
}

function DetailSection({
  actions,
  children,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="agent-child-run-section">
      <div className="agent-child-run-section-header">
        <h4>{title}</h4>
        {actions ? <div className="agent-child-run-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function DisclosureSection({
  children,
  defaultOpen,
  title,
}: {
  children: ReactNode;
  defaultOpen: boolean;
  title: string;
}) {
  // Own the open state and seed it once from `defaultOpen`. A bare controlled
  // `open={defaultOpen}` (no onToggle) is re-asserted on every poll re-render, so
  // the user can neither collapse it while the run streams nor keep it open once
  // the derived default flips on completion. Per-run remounting (a key at the call
  // site) re-seeds it for a freshly opened run.
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="agent-child-run-disclosure-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{title}</span>
      </summary>
      <div className="agent-child-run-disclosure-body">
        {children}
      </div>
    </details>
  );
}

function RunChildList({
  conversationId,
  runs,
  onOpenRun,
}: {
  conversationId: string | null;
  runs: AgentRunDetailChild[];
  onOpenRun?: (runId: string, conversationId: string | null) => void;
}) {
  const t = useT();
  return (
    <div className="agent-child-run-child-list">
      {runs.map((run) => {
        const displayStatus = displayStatusFor(run);
        const completed = isCompletedStatus(displayStatus);
        const title = runTitle(run, t.agent);
        const meta = [
          runStatusLabel(displayStatus, t.agent.run.status),
          run.runProfileLabel,
          formatDuration(run.startedAt, run.completedAt ?? run.updatedAt),
        ].join(' · ');
        return (
          <button
            className={`agent-child-run-child-row is-${runStatusClass(displayStatus)}`}
            disabled={!onOpenRun}
            key={run.runId}
            onClick={() => onOpenRun?.(run.runId, conversationId)}
            type="button"
          >
            <span className={`agent-run-marker is-${runStatusClass(displayStatus)}`} aria-hidden="true">
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
  run,
  subRunsByParentToolCallId,
  index,
  onNodeReferenceOpen,
  onOpenRun,
  toolResults,
}: {
  error: string | null;
  loading: boolean;
  messages: AgentMessage[];
  pendingToolCallIds: ReadonlySet<string>;
  reload: () => void;
  conversationId: string | null;
  run: AgentRenderRunEntity;
  subRunsByParentToolCallId?: Map<string, AgentRenderRunEntity>;
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRun?: (runId: string, conversationId: string | null) => void;
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
        title={t.agent.runDetail.loadingTranscript}
      />
    );
  }
  if (error) {
    return (
      <ErrorState
        className="agent-child-run-empty"
        message={error}
        onRetry={reload}
        retryLabel={t.agent.runDetail.retry}
      />
    );
  }
  if (messages.length === 0) {
    return <EmptyState className="agent-child-run-empty" title={t.agent.runDetail.noTranscriptMessages} />;
  }

  return (
    <AgentTranscriptMessageList
      active={transcriptHasActiveAssistantTurn(messages, run.status === 'running', pendingToolCallIds)}
      className="agent-child-run-transcript-list"
      conversationId={conversationId}
      index={index}
      messages={messages}
      onNodeReferenceOpen={onNodeReferenceOpen}
      onOpenChildRunTranscript={(childRunId) => onOpenRun?.(childRunId, conversationId)}
      pendingToolCallIds={pendingToolCallIds}
      run={run}
      subRunsByParentToolCallId={subRunsByParentToolCallId}
      toolResults={toolResults}
    />
  );
}

export function AgentRunDetailsPanel({
  onBack,
  onClose,
  conversationId,
  runId,
  runUpdatedAt,
  index,
  onNodeReferenceOpen,
  onOpenRun,
  showHeader = true,
}: AgentRunDetailsPanelProps) {
  const t = useT();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<'stop' | null>(null);
  const [detail, setDetail] = useState<AgentRunDetailPayload | null>(null);
  const [rawTranscript, setRawTranscript] = useState<unknown[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const loadRun = useCallback(() => {
    if (!conversationId || !runId) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setDetailError(null);
    setTranscriptError(null);
    void Promise.allSettled([
      api.agentRunDetail(conversationId, runId),
      api.agentRunTranscript(conversationId, runId),
    ])
      .then(([detailResult, transcriptResult]) => {
        if (requestId !== requestRef.current) return;
        if (detailResult.status === 'fulfilled' && detailResult.value !== null) {
          setDetail(detailResult.value);
        } else {
          setDetail(null);
          setDetailError(
            detailResult.status === 'rejected'
              ? detailResult.reason instanceof Error ? detailResult.reason.message : String(detailResult.reason)
              : t.agent.runDetail.detailUnavailable,
          );
        }

        if (transcriptResult.status === 'fulfilled' && transcriptResult.value !== null) {
          setRawTranscript(transcriptResult.value.messages);
        } else {
          setRawTranscript(null);
          setTranscriptError(
            transcriptResult.status === 'rejected'
              ? transcriptResult.reason instanceof Error ? transcriptResult.reason.message : String(transcriptResult.reason)
              : t.agent.runDetail.transcriptPayloadUnavailable,
          );
        }
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }, [conversationId, runId, t.agent.runDetail.detailUnavailable, t.agent.runDetail.transcriptPayloadUnavailable]);

  useEffect(() => {
    setActionError(null);
    setActionPending(null);
    setDetail(null);
    setRawTranscript(null);
    setDetailError(null);
    setTranscriptError(null);
    requestRef.current += 1;
  }, [runId]);

  useEffect(() => {
    loadRun();
  }, [loadRun, runUpdatedAt]);

  useEffect(() => {
    if (detail?.status !== 'running') return undefined;
    const interval = window.setInterval(loadRun, LIVE_TRANSCRIPT_POLL_MS);
    return () => {
      window.clearInterval(interval);
      requestRef.current += 1;
    };
  }, [detail?.status, loadRun]);

  const messages = useMemo(() => parseTranscript(rawTranscript), [rawTranscript]);
  const toolResults = useMemo(() => buildToolResultMap(messages), [messages]);
  const pendingToolCallIds = useMemo(
    () => collectPendingToolCallIds(messages, detail?.status === 'running'),
    [messages, detail?.status],
  );
  const transcriptRun = useMemo(() => detail ? runDetailToTranscriptRun(detail) : null, [detail]);
  const subRunsByParentToolCallId = useMemo(() => {
    if (!detail) return undefined;
    const map = new Map<string, AgentRenderRunEntity>();
    for (const child of [...detail.subRuns, ...detail.verificationRuns]) {
      if (child.parentToolCallId) map.set(child.parentToolCallId, childToTranscriptRun(child, detail));
    }
    return map.size > 0 ? map : undefined;
  }, [detail]);

  if (!conversationId || !runId) return null;
  if (loading && !detail) {
    return (
      <EmptyState
        className="agent-child-run-empty"
        icon={LoaderIcon}
        iconClassName="agent-tool-call-spinner"
        loading
        role="status"
        title={t.agent.runDetail.loading}
      />
    );
  }
  if (!detail || !transcriptRun) {
    return (
      <ErrorState
        className="agent-child-run-empty"
        message={detailError ?? t.agent.runDetail.detailUnavailable}
        onRetry={loadRun}
        retryLabel={t.agent.runDetail.retry}
      />
    );
  }

  const endedAt = detail.completedAt ?? detail.updatedAt;
  const displayStatus = displayStatusFor(detail);
  const displayStatusClass = runStatusClass(displayStatus);
  const canStop = detail.status === 'running';
  const duration = formatDuration(detail.startedAt, endedAt);
  const resultText = detail.result?.summary ?? detail.error ?? '';
  const showActivityOpen = detail.status === 'running' || !resultText;
  const metaLine = t.agent.runDetail.metaLine({
    count: messages.length,
    duration,
  });
  const verificationRuns = [...detail.verificationRuns].sort(compareRuns);
  const subRuns = [...detail.subRuns].sort(compareRuns);

  async function stopRun() {
    if (!conversationId || !detail || !canStop || actionPending) return;
    setActionPending('stop');
    setActionError(null);
    try {
      await api.agentRunStop(conversationId, detail.runId);
      loadRun();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionPending(null);
    }
  }

  const stopButton = canStop ? (
    <Button
      disabled={actionPending !== null}
      onClick={() => void stopRun()}
      size="sm"
      variant="danger"
    >
      {actionPending === 'stop' ? t.agent.runDetail.stopping : t.agent.runDetail.stop}
    </Button>
  ) : null;

  return (
    <section className="agent-child-run-details-panel" aria-label={t.agent.runDetail.detailsAriaLabel}>
      {showHeader ? (
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
            <span>{t.agent.runDetail.heading}</span>
            <span className={`agent-child-run-status is-${displayStatusClass}`}>{runStatusLabel(displayStatus, t.agent.run.status)}</span>
          </div>
          <h3>{detail.title}</h3>
          <p>{metaLine}</p>
        </div>
        <div className="agent-child-run-header-actions">
          {stopButton}
          <IconButton
            className="agent-child-run-close"
            icon={CloseIcon}
            label={t.agent.runDetail.closeDetails}
            onClick={onClose}
            title={t.agent.runDetail.close}
            variant="panel"
          />
        </div>
        </header>
      ) : null}
      {actionError ? (
        <div className="agent-child-run-action-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{actionError}</span>
        </div>
      ) : null}
      <div className="agent-child-run-details-body">
        {!showHeader ? (
          <div className="agent-child-run-details-summary">
            <div className="agent-child-run-title-block">
              <h3>{detail.title}</h3>
              <p>{metaLine}</p>
            </div>
            {stopButton ? (
              <div className="agent-child-run-header-actions">
                {stopButton}
              </div>
            ) : null}
          </div>
        ) : null}
        <DetailSection
          actions={<CopyResultButton text={resultText} />}
          title={t.agent.runDetail.sectionResult}
        >
          <ResultText text={resultText} />
        </DetailSection>
        {verificationRuns.length > 0 ? (
          <DetailSection title={t.agent.runDetail.sectionVerification}>
            <RunChildList
              conversationId={detail.conversationId}
              runs={verificationRuns}
              onOpenRun={onOpenRun}
            />
          </DetailSection>
        ) : null}
        {subRuns.length > 0 ? (
          <DetailSection title={t.agent.runDetail.sectionSubRuns({ count: subRuns.length })}>
            <RunChildList
              conversationId={detail.conversationId}
              runs={subRuns}
              onOpenRun={onOpenRun}
            />
          </DetailSection>
        ) : null}
        <DisclosureSection
          key={`activity-${detail.runId}`}
          defaultOpen={showActivityOpen}
          title={t.agent.runDetail.sectionActivityLog({ count: messages.length })}
        >
          <TranscriptTimeline
            error={transcriptError}
            loading={loading}
            messages={messages}
            pendingToolCallIds={pendingToolCallIds}
            reload={loadRun}
            conversationId={conversationId}
            run={transcriptRun}
            subRunsByParentToolCallId={subRunsByParentToolCallId}
            index={index}
            onNodeReferenceOpen={onNodeReferenceOpen}
            onOpenRun={onOpenRun}
            toolResults={toolResults}
          />
        </DisclosureSection>
        <DisclosureSection key={`technical-${detail.runId}`} defaultOpen={false} title={t.agent.runDetail.sectionTechnicalDetails}>
          <dl className="agent-child-run-metadata">
            <div>
              <dt>{t.agent.runDetail.metaRunId}</dt>
              <dd>{detail.runId}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaAgentId}</dt>
              <dd>{detail.agentId}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.status}</dt>
              <dd>{runStatusLabel(displayStatus, t.agent.run.status)}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaProfile}</dt>
              <dd>{detail.runProfileLabel}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaObjectiveRole}</dt>
              <dd>{detail.objectiveRole ?? t.agent.runDetail.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaContext}</dt>
              <dd>{detail.context}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaDisposition}</dt>
              <dd>{detail.disposition}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaParentToolCall}</dt>
              <dd>{detail.parentToolCallId ?? t.agent.runDetail.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaParentRun}</dt>
              <dd>{detail.parentRunId ?? t.agent.runDetail.metaNone}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaStarted}</dt>
              <dd>{new Date(detail.startedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t.agent.runDetail.metaUpdated}</dt>
              <dd>{new Date(detail.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </DisclosureSection>
      </div>
    </section>
  );
}
