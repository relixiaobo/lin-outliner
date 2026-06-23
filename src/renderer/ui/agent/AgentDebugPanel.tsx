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
  return (
    <div className="agent-debug-run-summary">
      <div className="agent-debug-run-summary-main">
        <div className="agent-debug-run-summary-title">
          <span className="agent-debug-agent-badge">{agentLabel(run.agentId)}</span>
          <strong>{kindLabel(run.kind, labels)}</strong>
          <span className={`agent-debug-status-pill is-${run.status}`}>{statusLabel(run.status, labels)}</span>
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
          <dt>{labels.runStarted}</dt>
          <dd>{formatTimestamp(startedAt)}</dd>
          <small>{labels.runCompleted}: {formatTimestamp(completedAt)}</small>
        </div>
        <div>
          <dt>{labels.runDuration}</dt>
          <dd>{formatDuration(startedAt, completedAt)}</dd>
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
            <small>{labels.cacheHitRate}: {formatPercent(ratios?.cacheHitRate ?? null)}</small>
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
    cacheHitRate: cacheActivity > 0 ? usage.cacheRead / cacheActivity : null,
    cachedContextShare: inputContext > 0 ? usage.cacheRead / inputContext : null,
    inputShare: inputContext > 0 ? usage.input / inputContext : 0,
    cacheReadShare: inputContext > 0 ? usage.cacheRead / inputContext : 0,
    cacheWriteShare: inputContext > 0 ? usage.cacheWrite / inputContext : 0,
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

      <DebugPanelSection title={labels.executionTitle({ count: run.rounds.length })}>
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
    <DebugPanelSection title={labels.modelInputTitle}>
      <div className="agent-debug-context-card">
        <ContextDisclosure title={labels.systemPromptDisclosure} copyText={run.systemPrompt ?? ''} defaultOpen>
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
  return (
    <article className="agent-debug-round-card">
      <div className="agent-debug-section-header">
        <h3>{labels.modelCallTitle({ index: round.index + 1 })}</h3>
        <span className={`agent-debug-status-pill is-${round.status}`}>{statusLabel(round.status, labels)}</span>
        {round.modelId ? <code className="agent-debug-run-model">{round.modelId}</code> : null}
        {round.stopReason ? <code>{round.stopReason}</code> : null}
        <UsageInfoHover labels={labels} usage={round.usage} />
      </div>

      <div className="agent-debug-round-response">
        <DebugSectionHeader title={labels.responseLabel} />
        {round.responseParts.length === 0 ? (
          <div className="is-muted">{labels.noResponseParts}</div>
        ) : (
          <div className="agent-debug-part-list">
            {round.responseParts.map((part, index) => <PartRow key={index} part={part} index={index} rowId={`${round.index}-resp`} labels={labels} />)}
          </div>
        )}
      </div>

      {round.toolExchanges.length > 0 ? (
        <div className="agent-debug-round-tools">
          <DebugSectionHeader title={labels.toolExchangesLabel({ count: round.toolExchanges.length })} />
          {round.toolExchanges.map((exchange) => <ToolExchangeRow key={exchange.toolCallId} exchange={exchange} labels={labels} />)}
        </div>
      ) : null}
    </article>
  );
}

function UsageInfoHover({ labels, usage }: { labels: DebugLabels; usage: AgentDebugUsage | null }) {
  return (
    <div className="agent-debug-usage-hover">
      <IconButton
        className="agent-debug-usage-info-button"
        icon={InfoIcon}
        iconSize={ICON_SIZE.tiny}
        label={labels.usageTitle}
        title={usage ? labels.usageTitle : labels.usagePending}
        variant="panel"
      />
      <span className="agent-debug-usage-popover" role="tooltip" aria-label={labels.usageTitle}>
        {usage ? <UsageBreakdown usage={usage} labels={labels} /> : <span className="is-muted">{labels.usagePending}</span>}
      </span>
    </div>
  );
}

function UsageBreakdown({ labels, usage }: { labels: DebugLabels; usage: AgentDebugUsage }) {
  const ratios = usageRatios(usage);
  const hasCacheActivity = usage.cacheRead > 0 || usage.cacheWrite > 0;
  const segmentStyle = (share: number) => ({
    '--segment-size': `${Math.max(share * 100, share > 0 ? 2 : 0)}%`,
  }) as CSSProperties;

  return (
    <div className="agent-debug-usage-card">
      <div className="agent-debug-usage-grid">
        <DebugMetric label={labels.totalInputContext} value={formatTokens(ratios.inputContext)} />
        <DebugMetric label={labels.inputTokens} value={formatTokens(usage.input)} />
        <DebugMetric label={labels.outputTokens} value={formatTokens(usage.output)} />
        <DebugMetric label={labels.cacheReadTokens} value={formatTokens(usage.cacheRead)} />
        <DebugMetric label={labels.cacheWriteTokens} value={formatTokens(usage.cacheWrite)} />
        <DebugMetric label={labels.actualCost} value={formatCost(usage.costUsd)} />
        <DebugMetric label={labels.cacheHitRate} value={formatPercent(ratios.cacheHitRate)} />
        <DebugMetric label={labels.cachedContextShare} value={formatPercent(ratios.cachedContextShare)} />
      </div>
      <div className="agent-debug-cache-chart" aria-label={labels.cacheChartLabel}>
        <div className="agent-debug-cache-chart-bar">
          <span className="is-input" style={segmentStyle(ratios.inputShare)} />
          <span className="is-cache-read" style={segmentStyle(ratios.cacheReadShare)} />
          <span className="is-cache-write" style={segmentStyle(ratios.cacheWriteShare)} />
        </div>
        <div className="agent-debug-cache-chart-legend">
          <span><i className="is-input" />{labels.uncachedInput}</span>
          <span><i className="is-cache-read" />{labels.cacheRead}</span>
          <span><i className="is-cache-write" />{labels.cacheWrite}</span>
        </div>
        {!hasCacheActivity ? <small className="is-muted">{labels.noCacheActivity}</small> : null}
      </div>
      <div className="agent-debug-cost-grid">
        <DebugMetric label={labels.costInput} value={formatCost(usage.cost.input)} />
        <DebugMetric label={labels.costOutput} value={formatCost(usage.cost.output)} />
        <DebugMetric label={labels.costCacheRead} value={formatCost(usage.cost.cacheRead)} />
        <DebugMetric label={labels.costCacheWrite} value={formatCost(usage.cost.cacheWrite)} />
      </div>
    </div>
  );
}

function ToolExchangeRow({ exchange, labels }: { exchange: AgentDebugToolExchange; labels: DebugLabels }) {
  const resultBody = exchange.result ?? labels.toolPending;
  const [blockState, setBlockState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const blockRule = useMemo(() => blockRuleForToolExchange(exchange), [exchange]);

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
    <details className={`agent-debug-tool-exchange${exchange.isError ? ' is-error' : ''}`}>
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <code>{exchange.toolName}</code>
        <strong>{truncate(exchange.result ?? (exchange.args || ''), 96)}</strong>
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
      </summary>
      <div className="agent-debug-tool-exchange-body">
        {exchange.args ? (
          <div>
            <small>{labels.toolArgs}</small>
            <pre>{exchange.args}</pre>
          </div>
        ) : null}
        <div>
          <small>{labels.toolResultLabel}</small>
          <pre>{resultBody}</pre>
        </div>
      </div>
    </details>
  );
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

function MessageRow({ message, labels }: { message: AgentDebugMessageRow; labels: DebugLabels }) {
  const visibleParts = shouldShowMessageParts(message.parts);
  const summary = messageSummaryText(message);
  return (
    <article className={`agent-debug-message-row${visibleParts ? '' : ' is-compact'}`}>
      <div className="agent-debug-message-head">
        <span className={`agent-debug-role-pill is-${message.role}`}>{message.role}</span>
        <strong title={summary}>{summary}</strong>
        <code>{formatBytes(message.bytes)}</code>
      </div>
      {visibleParts ? (
        <div className="agent-debug-part-list">
          {message.parts.map((part, index) => (
            <PartRow part={part} rowId={message.id} index={index} key={`${message.id}-${index}`} labels={labels} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function messageSummaryText(message: AgentDebugMessageRow): string {
  if (message.parts.length === 1) {
    const [part] = message.parts;
    if (part?.kind === 'text' && !part.isReminder) return part.body;
    if (part?.kind === 'toolCall') return `tool_call ${part.name}`;
    if (part?.kind === 'toolResult') return `tool_result ${shortId(part.toolUseId)}`;
    if (part?.kind === 'thinking') return 'thinking';
    if (part?.kind === 'image') return 'image';
    if (part?.kind === 'json') return 'json';
    if (part?.kind === 'text' && part.isReminder) return 'system reminder';
  }
  const prefix = `${message.role}: `;
  return message.summary.startsWith(prefix) ? message.summary.slice(prefix.length) : message.summary;
}

function shouldShowMessageParts(parts: AgentDebugMessagePart[]): boolean {
  if (parts.length !== 1) return true;
  const [part] = parts;
  return !(part?.kind === 'text' && !part.isReminder);
}

function shortId(value: string): string {
  if (!value) return '';
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-4)}` : value;
}

function PartRow({ part, index, rowId, labels }: { index: number; part: AgentDebugMessagePart; rowId: string; labels: DebugLabels }) {
  const title = partTitle(part, labels);
  return (
    <details className={`agent-debug-part-details is-${part.kind}`} key={`${rowId}-${index}`}>
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <span>{title}</span>
        <strong>{truncate(part.body, 120)}</strong>
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
        <span>{props.title}</span>
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

function DebugPanelSection(props: { children: ReactNode; title: string }) {
  return (
    <section className="agent-debug-detail-section">
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
