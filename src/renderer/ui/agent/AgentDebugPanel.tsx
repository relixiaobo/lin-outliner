import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { agentToolActionKindProfile } from '../../../core/agentPermissionModel';
import type {
  AgentDebugMessagePart,
  AgentDebugMessageRow,
  AgentDebugRound,
  AgentDebugRun,
  AgentDebugToolExchange,
  AgentDebugTurnStatus,
  AgentDebugUsage,
  AgentRuntimeEvent,
} from '../../../core/agentTypes';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { BlockIcon, ChevronDownIcon, CopyIcon, InfoIcon, RefreshIcon, ICON_SIZE, LoaderIcon } from '../icons';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { formatBytes } from '../preview/fileNode';

// Run Details is a read-only window onto one run. Model Input shows what seeded
// the run; Execution shows the provider calls and tools that happened inside it.
// The pane is opened from a concrete assistant reply, so it does not render the
// old conversation-level debug timeline.

interface AgentDebugPanelProps {
  conversationId: string | null;
  runId: string | null;
}

type DebugLabels = ReturnType<typeof useT>['agentDebug'];

// --- formatting -----------------------------------------------------------

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
}

function formatCost(cost: number): string {
  if (cost <= 0) return '$0.0000';
  if (cost < 0.01) return `$${cost.toFixed(5)}`;
  return `$${cost.toFixed(4)}`;
}

function formatUsageTokens(tokens: number): string {
  return Number.isFinite(tokens) ? new Intl.NumberFormat().format(tokens) : '0';
}

function usageSegmentStyle(value: number, total: number): CSSProperties {
  const share = total > 0 ? value / total : 0;
  return {
    '--segment-size': `${Math.max(share * 100, value > 0 ? 2 : 0)}%`,
  } as CSSProperties;
}

function formatCachedShare(input: number, cacheRead: number, cacheWrite: number): string | null {
  const cacheActivity = cacheRead + cacheWrite;
  const inputContext = input + cacheActivity;
  if (cacheActivity <= 0 || inputContext <= 0) return null;
  return `${Math.round((cacheRead / inputContext) * 100)}%`;
}

function formatTimestamp(value: number | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatDuration(startedAt: number | null, completedAt: number | null): string {
  if (!startedAt || !completedAt || completedAt < startedAt) return '—';
  const totalSeconds = Math.round((completedAt - startedAt) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function truncate(text: string, maxLength = 120): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength).trim()}...` : trimmed;
}

/** A short, stable agent label — the name segment of the agentId. Attribution is
 * by label, never color (design system B4). */
function agentLabel(agentId: string): string {
  return agentId.split(':').pop() || agentId;
}

function statusLabel(status: AgentDebugTurnStatus, labels: DebugLabels): string {
  if (status === 'running') return labels.statusRunning;
  if (status === 'completed') return labels.statusCompleted;
  if (status === 'aborted') return labels.statusAborted;
  return labels.statusError;
}

function kindLabel(kind: string, labels: DebugLabels): string {
  switch (kind) {
    case 'turn': return labels.kindTurn;
    case 'delegation': return labels.kindDelegation;
    case 'background': return labels.kindBackground;
    case 'scheduled': return labels.kindScheduled;
    case 'reflective': return labels.kindReflective;
    default: return kind || labels.unknown;
  }
}

function partTitle(part: AgentDebugMessagePart, labels: DebugLabels): string {
  if (part.kind === 'toolCall') return `tool_call ${part.name}`;
  if (part.kind === 'toolResult') return `tool_result ${part.toolUseId || ''}`.trim();
  if (part.kind === 'thinking') return labels.partThinking;
  if (part.kind === 'image') return labels.partImage;
  if (part.kind === 'json') return labels.partJson;
  return part.isReminder ? labels.partReminder : labels.partText;
}

// --- data hook ------------------------------------------------------------

function useRunDetail(conversationId: string | null, runId: string | null) {
  const [detail, setDetail] = useState<AgentDebugRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (!conversationId || !runId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.agentDebugRun(conversationId, runId);
      if (requestId !== requestRef.current) return;
      setDetail(next);
      setError(null);
    } catch (caught) {
      if (requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [conversationId, runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!conversationId || !runId) return undefined;
    // A live turn fires many tool_call / tool_result / projection events in quick
    // succession; coalesce them with a trailing debounce so we re-derive the tree
    // once the burst settles, not once per event.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = window.lin?.onAgentEvent((event: AgentRuntimeEvent) => {
      if (event.type !== 'projection' && event.type !== 'error' && event.type !== 'tool_call' && event.type !== 'tool_result') return;
      if (event.conversationId !== conversationId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void refresh(); }, 200);
    });
    return () => { if (timer) clearTimeout(timer); unlisten?.(); };
  }, [refresh, conversationId, runId]);

  return { detail, error, loading, refresh };
}

// --- top-level panel ------------------------------------------------------

export function AgentDebugPanel({ conversationId, runId }: AgentDebugPanelProps) {
  const labels = useT().agentDebug;
  const { detail, error, loading, refresh } = useRunDetail(conversationId, runId);

  if (!conversationId || !runId) {
    return (
      <div className="agent-debug-panel">
        <EmptyState className="agent-debug-empty" title={labels.noRunSelected} />
      </div>
    );
  }

  return (
    <div className="agent-debug-panel">
      <header className="agent-debug-header">
        <div>
          <h2>{labels.title}</h2>
        </div>
        <IconButton
          className="agent-debug-icon-button"
          icon={RefreshIcon}
          label={labels.refreshLabel}
          onClick={() => void refresh()}
          title={labels.refreshTitle}
          variant="panel"
        />
      </header>

      {loading && !detail ? <EmptyState icon={LoaderIcon} loading role="status" title={labels.loadingRun} /> : null}
      {error ? <ErrorState message={error} /> : null}
      {detail ? <RunDetail run={detail} labels={labels} /> : (!loading && !error ? <div className="agent-debug-card is-muted">{labels.noRuntimeData}</div> : null)}
    </div>
  );
}

function RunSummaryHeader({ labels, run }: { labels: DebugLabels; run: AgentDebugRun }) {
  const rounds = run.rounds;
  const startedAt = rounds[0]?.startedAt ?? run.createdAt;
  const completedAt = rounds.reduce<number | null>((latest, round) => (
    round.completedAt && (!latest || round.completedAt > latest) ? round.completedAt : latest
  ), null);
  const usage = run.usage;
  const ratios = usage ? usageRatios(usage) : null;
  const toolCallCount = rounds.reduce((count, round) => count + round.toolExchanges.length, 0);
  const showStatus = run.status !== 'completed';
  const timeRange = completedAt
    ? `${formatTimestamp(startedAt)} - ${formatTimestamp(completedAt)}`
    : formatTimestamp(startedAt);
  return (
    <div className="agent-debug-run-summary">
      <div className="agent-debug-run-summary-main">
        <div className="agent-debug-run-summary-title">
          <span className="agent-debug-agent-badge">{agentLabel(run.agentId)}</span>
          <strong>{kindLabel(run.kind, labels)}</strong>
          {showStatus ? <span className={`agent-debug-status-pill is-${run.status}`}>{statusLabel(run.status, labels)}</span> : null}
        </div>
        <code>{run.runId}</code>
      </div>
      <dl className="agent-debug-run-summary-facts">
        <div>
          <dt>{labels.runModel}</dt>
          <dd>{run.modelId ?? labels.unknown}</dd>
          {run.provider ? <small>{run.provider}</small> : null}
        </div>
        <div>
          <dt>{labels.runDuration}</dt>
          <dd>{formatDuration(startedAt, completedAt)}</dd>
          <small>{timeRange}</small>
        </div>
        <div>
          <dt>{labels.modelCallCount}</dt>
          <dd>{rounds.length}</dd>
          <small>{labels.toolCallCount}: {toolCallCount}</small>
        </div>
        {usage ? (
          <div>
            <dt>{labels.totalInputContext}</dt>
            <dd>{formatTokens(ratios?.inputContext ?? 0)}</dd>
            <small>{labels.cachedShare}: {formatPercent(ratios?.cachedShare ?? null)}</small>
            <small>{labels.outputTokens}: {formatTokens(usage.output)}</small>
          </div>
        ) : null}
        {usage ? (
          <div>
            <dt>{labels.statCost}</dt>
            <dd>{formatCost(usage.costUsd)}</dd>
          </div>
        ) : null}
      </dl>
      <ContextDisclosure title={labels.identifiersTitle}>
        <div className="agent-debug-advanced-grid">
          <DebugMetric label="runId" value={run.runId} />
          <DebugMetric label="agentId" value={run.agentId} />
          {run.parentRunId ? <DebugMetric label="parentRunId" value={run.parentRunId} /> : null}
          {run.parentToolCallId ? <DebugMetric label="parentToolCallId" value={run.parentToolCallId} /> : null}
        </div>
      </ContextDisclosure>
    </div>
  );
}

function usageRatios(usage: AgentDebugUsage) {
  const inputContext = usage.input + usage.cacheRead + usage.cacheWrite;
  const cacheActivity = usage.cacheRead + usage.cacheWrite;
  return {
    inputContext,
    cachedShare: cacheActivity > 0 && inputContext > 0 ? usage.cacheRead / inputContext : null,
  };
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

function RunDetail({ run, labels }: { run: AgentDebugRun; labels: DebugLabels }) {
  return (
    <div className="agent-debug-run-detail">
      <DebugPanelSection title={labels.summaryTitle}>
        <RunSummaryHeader labels={labels} run={run} />
      </DebugPanelSection>
      <RunContextSection labels={labels} run={run} />

      <DebugPanelSection className="agent-debug-execution-section" title={labels.executionTitle({ count: run.rounds.length })}>
        {run.rounds.length === 0 ? (
          <div className="agent-debug-card is-muted">{labels.noModelCallsYet}</div>
        ) : run.rounds.map((round) => (
          <RoundCard key={round.index} round={round} labels={labels} />
        ))}
      </DebugPanelSection>
    </div>
  );
}

function RunContextSection({ labels, run }: { labels: DebugLabels; run: AgentDebugRun }) {
  return (
    <DebugPanelSection className="agent-debug-model-input-section" title={labels.modelInputTitle}>
      <div className="agent-debug-context-card">
        <ContextDisclosure copyText={run.systemPrompt ?? ''} title={labels.systemPromptDisclosure}>
          {run.systemPrompt ? <pre>{run.systemPrompt}</pre> : <span className="is-muted">{labels.empty}</span>}
        </ContextDisclosure>
        <ContextDisclosure title={labels.toolsDisclosure({ count: run.tools.length })}>
          {run.tools.length === 0 ? <span className="is-muted">{labels.noTools}</span> : (
            <div className="agent-debug-tool-list">
              {run.tools.map((tool) => (
                <details className="agent-debug-tool-row" key={tool.name}>
                  <summary>
                    <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
                    <code>{tool.name}</code>
                    <span>{tool.description || labels.noDescription}</span>
                  </summary>
                  <pre>{tool.schema}</pre>
                </details>
              ))}
            </div>
          )}
        </ContextDisclosure>
        {run.modelInputMessagesSource === 'legacyRequestWindow' && (
          <p className="agent-debug-inline-note">{labels.legacyInputMessagesNotice}</p>
        )}
        <ModelInputMessageSections messages={run.modelInputMessages} labels={labels} />
      </div>
    </DebugPanelSection>
  );
}

function RoundCard({ round, labels }: { round: AgentDebugRound; labels: DebugLabels }) {
  const showStatus = round.status !== 'completed';
  const emittedToolCallIds = new Set(
    round.responseParts
      .filter((part) => part.kind === 'toolCall')
      .map((part) => part.toolUseId),
  );
  return (
    <details className="agent-debug-round-card" open>
      <summary className="agent-debug-section-header">
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <h3>{labels.modelCallTitle({ index: round.index + 1 })}</h3>
        {showStatus ? <span className={`agent-debug-status-pill is-${round.status}`}>{statusLabel(round.status, labels)}</span> : null}
        <RoundInfoHover labels={labels} round={round} />
      </summary>

      <div className="agent-debug-execution-list">
        {round.responseParts.length === 0 && round.toolExchanges.length === 0 ? (
          <div className="is-muted">{labels.noExecutionOutput}</div>
        ) : null}
        {round.responseParts.map((part, index) => (
          <PartRow
            className="agent-debug-execution-event"
            index={index}
            key={`${round.messageId}-response-${index}`}
            labels={labels}
            part={part}
            rowId={`${round.messageId}:response`}
            summaryOverride={executionEventSummary(part)}
            titleOverride={executionEventLabel(part, labels)}
          />
        ))}
        {round.toolExchanges.map((exchange, index) => (
          <ExecutionToolExchangeRows
            exchange={exchange}
            includeToolCall={!emittedToolCallIds.has(exchange.toolCallId)}
            index={index}
            key={exchange.toolCallId}
            labels={labels}
          />
        ))}
      </div>
    </details>
  );
}

function RoundInfoHover({ labels, round }: { labels: DebugLabels; round: AgentDebugRound }) {
  return (
    <div className="agent-debug-usage-hover" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <IconButton
        className="agent-debug-usage-info-button"
        icon={InfoIcon}
        iconSize={ICON_SIZE.tiny}
        label={labels.roundInfoTitle}
        title={labels.roundInfoTitle}
        variant="panel"
      />
      <span className="agent-debug-usage-popover" role="tooltip" aria-label={labels.roundInfoTitle}>
        <RoundInfoContent labels={labels} round={round} />
      </span>
    </div>
  );
}

function RoundInfoContent({ labels, round }: { labels: DebugLabels; round: AgentDebugRound }) {
  const t = useT();
  const usage = round.usage;
  if (!usage) {
    return (
      <>
        <div className="agent-message-usage-hover-title-row">
          <div className="agent-message-usage-hover-title">{t.agent.message.usageDetails}</div>
        </div>
        <span className="is-muted">{labels.usagePending}</span>
      </>
    );
  }

  const cachedShare = formatCachedShare(usage.input, usage.cacheRead, usage.cacheWrite);
  const usageRows = [
    { kind: 'input', label: t.agent.message.tokenLabels.input, tokens: usage.input, cost: usage.cost.input },
    { kind: 'output', label: t.agent.message.tokenLabels.output, tokens: usage.output, cost: usage.cost.output },
    { kind: 'cache-read', label: t.agent.message.tokenLabels.cacheRead, tokens: usage.cacheRead, cost: usage.cost.cacheRead },
    { kind: 'cache-write', label: t.agent.message.tokenLabels.cacheWrite, tokens: usage.cacheWrite, cost: usage.cost.cacheWrite },
  ];
  const rows = [
    ...usageRows,
    { kind: 'total', label: t.agent.message.tokenLabels.total, tokens: usage.totalTokens, cost: usage.cost.total },
  ];
  return (
    <>
      <div className="agent-message-usage-hover-title-row">
        <div className="agent-message-usage-hover-title">{t.agent.message.usageDetails}</div>
        {cachedShare ? (
          <div className="agent-message-usage-hover-meta">
            {t.agent.message.cachedShare}: <strong>{cachedShare}</strong>
          </div>
        ) : null}
      </div>
      <div className="agent-message-usage-hover-bar" aria-hidden>
        {usageRows.map((row) => (
          <span
            className={`is-${row.kind}`}
            key={row.kind}
            style={usageSegmentStyle(row.tokens, usage.totalTokens)}
          />
        ))}
      </div>
      <div className="agent-message-usage-hover-breakdown" aria-label={t.agent.message.usageDetails}>
        {rows.map((row) => {
          const rowClassName = [
            row.kind === 'total' ? 'is-total' : null,
            row.tokens === 0 && !row.cost ? 'is-zero' : null,
          ].filter(Boolean).join(' ') || undefined;
          return (
            <div className={rowClassName} key={row.kind}>
              <span>
                <i className={`is-${row.kind}`} />
                {row.label}
              </span>
              <strong>{formatUsageTokens(row.tokens)}</strong>
              <strong>{formatCost(row.cost)}</strong>
            </div>
          );
        })}
      </div>
    </>
  );
}

function ExecutionToolExchangeRows({
  exchange,
  includeToolCall,
  index,
  labels,
}: {
  exchange: AgentDebugToolExchange;
  includeToolCall: boolean;
  index: number;
  labels: DebugLabels;
}) {
  const toolCallPart: AgentDebugMessagePart | null = includeToolCall && exchange.args
    ? { kind: 'toolCall', name: exchange.toolName, toolUseId: exchange.toolCallId, body: exchange.args }
    : null;
  return (
    <>
      {toolCallPart ? (
        <PartRow
          className="agent-debug-execution-event"
          index={0}
          labels={labels}
          part={toolCallPart}
          rowId={`${exchange.toolCallId}:tool-call:${index}`}
          summaryOverride={exchange.toolName}
          titleOverride="tool call"
        />
      ) : null}
      <ExecutionToolResultRow exchange={exchange} index={index} labels={labels} />
    </>
  );
}

function ExecutionToolResultRow({ exchange, index, labels }: { exchange: AgentDebugToolExchange; index: number; labels: DebugLabels }) {
  const resultBody = exchange.result ?? labels.toolPending;
  const [blockState, setBlockState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const blockRule = useMemo(() => blockRuleForToolExchange(exchange), [exchange]);
  const resultPart: AgentDebugMessagePart = useMemo(() => ({
    kind: 'toolResult',
    toolUseId: exchange.toolCallId,
    body: resultBody,
    isError: exchange.isError,
  }), [exchange.isError, exchange.toolCallId, resultBody]);

  const addUserBlock = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!blockRule || blockState === 'saving') return;
    setBlockState('saving');
    try {
      await api.agentAppendToolPermissionBlock(blockRule);
      setBlockState('saved');
    } catch {
      setBlockState('error');
    }
  }, [blockRule, blockState]);

  const blockButtonLabel = blockState === 'saving'
    ? labels.userBlockSaving
    : blockState === 'saved'
      ? labels.userBlockAdded({ rule: blockRule ?? '' })
      : blockState === 'error'
        ? labels.userBlockError
        : labels.addUserBlockLabel;

  return (
    <PartRow
      className={`agent-debug-execution-event agent-debug-tool-exchange${exchange.isError ? ' is-error' : ''}`}
      index={0}
      labels={labels}
      part={resultPart}
      rowId={`${exchange.toolCallId}:tool-result:${index}`}
      summaryOverride={`${exchange.toolName} · ${toolResultSummary(resultBody, exchange.toolCallId)}`}
      titleOverride="tool result"
      trailing={(
        <span className="agent-debug-message-actions-inline">
          {exchange.isError ? <span className="agent-debug-tool-flag">{labels.toolError}</span> : null}
          {blockRule ? (
            <IconButton
              className={`agent-debug-block-button is-${blockState}`}
              disabled={blockState === 'saving'}
              icon={BlockIcon}
              iconSize={ICON_SIZE.tiny}
              label={blockButtonLabel}
              onClick={addUserBlock}
              title={blockState === 'idle' ? labels.addUserBlockTitle({ rule: blockRule }) : blockButtonLabel}
              variant="panel"
            />
          ) : null}
        </span>
      )}
    />
  );
}

function executionEventLabel(part: AgentDebugMessagePart, labels: DebugLabels): string {
  if (part.kind === 'text' && !part.isReminder) return 'asst';
  if (part.kind === 'toolCall') return 'call';
  if (part.kind === 'toolResult') return 'result';
  if (part.kind === 'thinking') return 'think';
  return partTitle(part, labels);
}

function executionEventSummary(part: AgentDebugMessagePart): string | undefined {
  if (part.kind === 'toolCall') return part.name;
  if (part.kind === 'toolResult') return toolResultSummary(part.body, part.toolUseId);
  return part.body;
}

function blockRuleForToolExchange(exchange: AgentDebugToolExchange): string | null {
  const parsedArgs = parseDebugArgs(exchange.args);
  const command = stringRecordValue(parsedArgs, 'command');
  if (command) return `Command(${command})`;

  const actionKinds = agentToolActionKindProfile(exchange.toolName, parsedArgs);
  if (actionKinds?.length === 1) return `Action(${actionKinds[0]})`;
  return null;
}

function parseDebugArgs(args: string): unknown {
  if (!args.trim()) return null;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

function stringRecordValue(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const raw = record[key];
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

// --- shared bits ----------------------------------------------------------

function ModelInputMessageSections({ messages, labels }: { messages: AgentDebugMessageRow[]; labels: DebugLabels }) {
  const groups = splitModelInputMessages(messages);
  if (messages.length === 0) return <span className="is-muted">{labels.empty}</span>;
  return (
    <>
      {groups.history.length > 0 ? (
        <ContextDisclosure title={labels.inputHistoryDisclosure({ count: groups.history.length })}>
          <MessageList messages={groups.history} labels={labels} />
        </ContextDisclosure>
      ) : null}
      {groups.current.length > 0 ? (
        <ContextDisclosure defaultOpen title={labels.currentRequestDisclosure}>
          <MessageList messages={groups.current} labels={labels} />
        </ContextDisclosure>
      ) : null}
    </>
  );
}

function splitModelInputMessages(messages: AgentDebugMessageRow[]): { current: AgentDebugMessageRow[]; history: AgentDebugMessageRow[] } {
  let currentRequestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      currentRequestIndex = index;
      break;
    }
  }
  if (currentRequestIndex < 0) return { history: messages, current: [] };
  return {
    history: messages.slice(0, currentRequestIndex),
    current: messages.slice(currentRequestIndex),
  };
}

function MessageList({ labels, messages }: { labels: DebugLabels; messages: AgentDebugMessageRow[] }) {
  return (
    <div className="agent-debug-message-list">
      {messages.map((row) => <MessageRow key={row.id} message={row} labels={labels} />)}
    </div>
  );
}

function MessageRow({
  className,
  labels,
  message,
}: {
  className?: string;
  labels: DebugLabels;
  message: AgentDebugMessageRow;
}) {
  const roleLabel = messageRoleLabel(message);
  const summary = messageSummaryText(message);
  return (
    <details className={`agent-debug-message-row${className ? ` ${className}` : ''}`}>
      <summary className="agent-debug-message-head">
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <span className={`agent-debug-role-label is-${message.role}`}>{roleLabel}</span>
        <strong title={summary}>{summary}</strong>
        <code>{formatBytes(message.bytes)}</code>
      </summary>
      {message.parts.length > 0 ? (
        <div className="agent-debug-part-list">
          {message.parts.map((part, index) => (
            <PartRow part={part} rowId={message.id} index={index} key={`${message.id}-${index}`} labels={labels} />
          ))}
        </div>
      ) : null}
    </details>
  );
}

function messageRoleLabel(message: AgentDebugMessageRow): string {
  const part = displayPartForMessage(message);
  if (part?.kind === 'toolCall') return 'call';
  if (part?.kind === 'toolResult') return 'result';
  if (part?.kind === 'text' && message.role === 'tool' && toolResultPrefixPattern.test(part.body)) return 'result';
  if (message.role === 'assistant') return 'asst';
  return message.role;
}

function messageSummaryText(message: AgentDebugMessageRow): string {
  const part = displayPartForMessage(message);
  if (part && message.parts.length === 1) {
    if (part?.kind === 'text' && message.role === 'tool' && toolResultPrefixPattern.test(part.body)) {
      return toolResultSummary(part.body, '');
    }
    if (part?.kind === 'text' && !part.isReminder) return part.body;
    if (part?.kind === 'toolCall') return part.name;
    if (part?.kind === 'toolResult') return toolResultSummary(part.body, part.toolUseId);
    if (part?.kind === 'thinking') return 'thinking';
    if (part?.kind === 'image') return 'image';
    if (part?.kind === 'json') return 'json';
    if (part?.kind === 'text' && part.isReminder) return 'system reminder';
  }
  const prefix = `${message.role}: `;
  return message.summary.startsWith(prefix) ? message.summary.slice(prefix.length) : message.summary;
}

function displayPartForMessage(message: AgentDebugMessageRow): AgentDebugMessagePart | undefined {
  if (message.parts.length !== 1) return undefined;
  return message.parts[0];
}

const toolResultPrefixPattern = /^\[tool_result\s+[^\]]+\]\s*/;

function toolResultSummary(body: string, toolUseId: string): string {
  const stripped = body.replace(toolResultPrefixPattern, '').trim();
  return stripped || shortId(toolUseId) || 'result';
}

function shortId(value: string): string {
  if (!value) return '';
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-4)}` : value;
}

function PartRow({
  className,
  index,
  labels,
  part,
  rowId,
  summaryOverride,
  titleOverride,
  trailing,
}: {
  className?: string;
  index: number;
  labels: DebugLabels;
  part: AgentDebugMessagePart;
  rowId: string;
  summaryOverride?: string;
  titleOverride?: string;
  trailing?: ReactNode;
}) {
  const title = titleOverride ?? partTitle(part, labels);
  const summary = summaryOverride ?? part.body;
  return (
    <details className={`agent-debug-part-details is-${part.kind}${className ? ` ${className}` : ''}`} key={`${rowId}-${index}`}>
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <span title={title}>{title}</span>
        <strong>{truncate(summary, 120)}</strong>
        {trailing}
        <IconButton
          className="agent-debug-copy-button"
          icon={CopyIcon}
          iconSize={ICON_SIZE.tiny}
          label={labels.copyTitle({ title })}
          onClick={(event) => { event.preventDefault(); void copyText(part.body); }}
          variant="panel"
        />
      </summary>
      <pre>{part.body}</pre>
    </details>
  );
}

function ContextDisclosure(props: { children: ReactNode; copyText?: string; defaultOpen?: boolean; title: string }) {
  const labels = useT().agentDebug;
  const [open, setOpen] = useState(Boolean(props.defaultOpen));

  useEffect(() => {
    setOpen(Boolean(props.defaultOpen));
  }, [props.defaultOpen, props.title]);

  return (
    <details
      className="agent-debug-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.menu} />
        <span className="agent-debug-disclosure-title">{props.title}</span>
        {props.copyText !== undefined && props.copyText !== '' ? (
          <IconButton
            className="agent-debug-copy-button"
            icon={CopyIcon}
            iconSize={ICON_SIZE.tiny}
            label={labels.copyTitle({ title: props.title })}
            onClick={(event) => { event.preventDefault(); void copyText(props.copyText ?? ''); }}
            variant="panel"
          />
        ) : null}
      </summary>
      <div className="agent-debug-disclosure-body">{props.children}</div>
    </details>
  );
}

function DebugPanelSection(props: { children: ReactNode; className?: string; title: string }) {
  return (
    <section className={props.className ? `agent-debug-detail-section ${props.className}` : 'agent-debug-detail-section'}>
      <DebugSectionHeader title={props.title} />
      {props.children}
    </section>
  );
}

function DebugMetric(props: { label: string; meta?: ReactNode; value: ReactNode }) {
  return (
    <div className="agent-debug-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      {props.meta ? <small>{props.meta}</small> : null}
    </div>
  );
}

function DebugSectionHeader(props: { meta?: ReactNode; title: string }) {
  return (
    <div className="agent-debug-section-header">
      <h3>{props.title}</h3>
      {props.meta ? <span>{props.meta}</span> : null}
    </div>
  );
}

async function copyText(text: string) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
}
