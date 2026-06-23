import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { agentToolActionKindProfile } from '../../../core/agentPermissionModel';
import type {
  AgentDebugConversation,
  AgentDebugMessagePart,
  AgentDebugMessageRow,
  AgentDebugRound,
  AgentDebugRun,
  AgentDebugRunSummary,
  AgentDebugToolExchange,
  AgentDebugTurnStatus,
  AgentDebugUsage,
  AgentRuntimeEvent,
} from '../../../core/agentTypes';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { BlockIcon, ChevronDownIcon, CopyIcon, RefreshIcon, ICON_SIZE, LoaderIcon } from '../icons';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { formatBytes } from '../preview/fileNode';

// Run-grounded debug view ([[agent-debug-run-grounded]]): a read-only window onto
// the execution tree — conversation → runs (per agent) → rounds (one provider
// call) → request window / response / tool exchanges — sourced from the run
// ledgers the system already writes. DM is the single-member case of Channel.

interface AgentDebugPanelProps {
  conversationId: string | null;
  selectedRunId?: string | null;
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

function useDebugTimeline(conversationId: string | null) {
  const [resolvedConversationId, setResolvedConversationId] = useState<string | null>(conversationId);
  const [conversation, setConversation] = useState<AgentDebugConversation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    try {
      let target = conversationId;
      if (!target) {
        const conversations = await api.agentListConversations();
        if (requestId !== requestRef.current) return;
        target = conversations[0]?.id ?? null;
      }
      if (requestId !== requestRef.current) return;
      setResolvedConversationId(target);
      if (!target) {
        setConversation(null);
        setError(null);
        return;
      }
      const next = await api.agentDebugView(target);
      if (requestId !== requestRef.current) return;
      setConversation(next);
      setError(null);
    } catch (caught) {
      if (requestId !== requestRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const eventConversationId = conversationId ?? resolvedConversationId;
    if (!eventConversationId) return undefined;
    // A live turn fires many tool_call / tool_result / projection events in quick
    // succession; coalesce them with a trailing debounce so we re-derive the tree
    // once the burst settles, not once per event.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = window.lin?.onAgentEvent((event: AgentRuntimeEvent) => {
      if (event.type !== 'projection' && event.type !== 'error' && event.type !== 'tool_call' && event.type !== 'tool_result') return;
      if (event.conversationId !== eventConversationId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void refresh(); }, 200);
    });
    return () => { if (timer) clearTimeout(timer); unlisten?.(); };
  }, [refresh, resolvedConversationId, conversationId]);

  return { conversation, error, loading, refresh, resolvedConversationId };
}

// --- top-level panel ------------------------------------------------------

export function AgentDebugPanel({ conversationId, selectedRunId: preferredRunId = null }: AgentDebugPanelProps) {
  const labels = useT().agentDebug;
  const { conversation, error, loading, refresh, resolvedConversationId } = useDebugTimeline(conversationId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(preferredRunId);

  useEffect(() => {
    setSelectedRunId(preferredRunId);
  }, [preferredRunId]);

  const runs = useMemo(
    () => [...(conversation?.runs ?? [])].sort((left, right) => right.createdAt - left.createdAt),
    [conversation],
  );
  const selectedRun = useMemo(() => {
    if (runs.length === 0) return null;
    return runs.find((run) => run.runId === selectedRunId) ?? runs[0]!;
  }, [runs, selectedRunId]);

  useEffect(() => {
    if (!selectedRun && runs.length > 0) setSelectedRunId(runs[0]!.runId);
  }, [runs, selectedRun]);

  if (!conversationId && !resolvedConversationId && loading) {
    return (
      <div className="agent-debug-panel">
        <EmptyState className="agent-debug-empty" icon={LoaderIcon} loading role="status" title={labels.loadingConversation} />
      </div>
    );
  }
  if (!conversationId && !resolvedConversationId) {
    return (
      <div className="agent-debug-panel">
        <EmptyState className="agent-debug-empty" title={labels.noConversation} />
      </div>
    );
  }

  return (
    <div className="agent-debug-panel">
      <header className="agent-debug-header">
        <div>
          <h2>{labels.title}</h2>
          <p>{resolvedConversationId ?? conversationId}</p>
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

      {loading && !conversation ? <EmptyState icon={LoaderIcon} loading role="status" title={labels.loadingRuntime} /> : null}
      {error ? <ErrorState message={error} /> : null}

      {conversation ? (
        <div className="agent-debug-run-details-layout">
          <aside className="agent-debug-run-selector" aria-label={labels.runListAriaLabel}>
            <Overview conversation={conversation} labels={labels} />
            {runs.length === 0 ? (
              <div className="agent-debug-card is-muted">{labels.noRuntimeData}</div>
            ) : runs.map((run) => (
              <RunSelectorButton
                key={run.runId}
                labels={labels}
                onSelect={() => setSelectedRunId(run.runId)}
                run={run}
                selected={selectedRun?.runId === run.runId}
              />
            ))}
          </aside>
          <section className="agent-debug-selected-run" aria-label={labels.selectedRunAriaLabel}>
            {selectedRun ? (
              <SelectedRunDetail
                conversationId={resolvedConversationId}
                labels={labels}
                run={selectedRun}
              />
            ) : (
              <div className="agent-debug-card is-muted">{labels.noRuntimeData}</div>
            )}
          </section>
        </div>
      ) : (
        !loading && !error ? <div className="agent-debug-card is-muted">{labels.noRuntimeData}</div> : null
      )}
    </div>
  );
}

function RunSelectorButton({
  labels,
  onSelect,
  run,
  selected,
}: {
  labels: DebugLabels;
  onSelect: () => void;
  run: AgentDebugRunSummary;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`agent-debug-run-selector-button${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      type="button"
    >
      <span className="agent-debug-run-selector-main">
        <span className="agent-debug-agent-badge">{agentLabel(run.agentId)}</span>
        <span className="agent-debug-run-kind">{kindLabel(run.kind, labels)}</span>
        <span className={`agent-debug-status-pill is-${run.status}`}>{statusLabel(run.status, labels)}</span>
      </span>
      <span className="agent-debug-run-selector-meta">
        {run.modelId ? <code>{run.modelId}</code> : <span>{labels.unknown}</span>}
        <span>{labels.runRounds({ count: run.roundCount })}</span>
        {run.usage ? <span>{formatCost(run.usage.costUsd)}</span> : null}
      </span>
    </button>
  );
}

function useSelectedRunDetail(
  conversationId: string | null,
  run: AgentDebugRunSummary,
) {
  const [detail, setDetail] = useState<AgentDebugRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDetail = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const next = await api.agentDebugRun(conversationId, run.runId);
      setDetail(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [conversationId, run.runId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    void loadDetail();
  }, [loadDetail]);

  return { detail, error, loading };
}

function SelectedRunDetail({
  conversationId,
  labels,
  run,
}: {
  conversationId: string | null;
  labels: DebugLabels;
  run: AgentDebugRunSummary;
}) {
  const { detail, error, loading } = useSelectedRunDetail(conversationId, run);
  return (
    <div className="agent-debug-run-detail-shell">
      <RunSummaryHeader labels={labels} run={detail ?? run} />
      {loading && !detail ? <EmptyState icon={LoaderIcon} loading role="status" title={labels.loadingRun} /> : null}
      {error ? <ErrorState message={error} /> : null}
      {detail ? <RunDetail run={detail} labels={labels} /> : (!loading && !error ? <div className="agent-debug-card is-muted">{labels.noRoundsYet}</div> : null)}
    </div>
  );
}

function RunSummaryHeader({ labels, run }: { labels: DebugLabels; run: AgentDebugRun | AgentDebugRunSummary }) {
  const rounds = 'rounds' in run ? run.rounds : [];
  const startedAt = rounds[0]?.startedAt ?? run.createdAt;
  const completedAt = rounds.reduce<number | null>((latest, round) => (
    round.completedAt && (!latest || round.completedAt > latest) ? round.completedAt : latest
  ), null);
  const usage = run.usage;
  return (
    <div className="agent-debug-run-summary">
      <div>
        <div className="agent-debug-run-summary-title">
          <span className="agent-debug-agent-badge">{agentLabel(run.agentId)}</span>
          <strong>{kindLabel(run.kind, labels)}</strong>
          <span className={`agent-debug-status-pill is-${run.status}`}>{statusLabel(run.status, labels)}</span>
        </div>
        <code>{run.runId}</code>
      </div>
      <div className="agent-debug-run-summary-grid">
        <DebugMetric label={labels.runModel} value={run.modelId ?? labels.unknown} meta={run.provider ?? undefined} />
        <DebugMetric label={labels.runStarted} value={formatTimestamp(startedAt)} />
        <DebugMetric label={labels.runCompleted} value={formatTimestamp(completedAt)} />
        <DebugMetric label={labels.runDuration} value={formatDuration(startedAt, completedAt)} />
        {usage ? <DebugMetric label={labels.statTokens} value={formatTokens(usage.totalTokens)} meta={labels.usageTokens({ total: formatTokens(usage.totalTokens), input: formatTokens(usage.input), output: formatTokens(usage.output) })} /> : null}
        {usage ? <DebugMetric label={labels.statCost} value={formatCost(usage.costUsd)} /> : null}
      </div>
    </div>
  );
}

function Overview({ conversation, labels }: { conversation: AgentDebugConversation; labels: DebugLabels }) {
  const { totals, shape, members } = conversation;
  return (
    <div className="agent-debug-overview-grid" aria-label={labels.overviewAriaLabel}>
      <DebugMetric label={labels.metricShape} value={shape === 'channel' ? labels.shapeChannel : labels.shapeDm} meta={labels.membersCount({ count: members.length })} />
      <DebugMetric label={labels.statTotalRuns} value={conversation.runs.length} meta={labels.statRoundsMeta({ count: totals.rounds })} />
      <DebugMetric label={labels.statTokens} value={formatTokens(totals.totalTokens)} meta={`${formatTokens(totals.input)} / ${formatTokens(totals.output)}`} />
      <DebugMetric label={labels.statCost} value={formatCost(totals.costUsd)} />
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
      <DebugPanelSection title={labels.contextTitle}>
        <div className="agent-debug-context-card">
          <ContextDisclosure title={labels.systemPromptDisclosure} copyText={run.systemPrompt ?? ''} defaultOpen>
            {run.systemPrompt ? <pre>{run.systemPrompt}</pre> : <span className="is-muted">{labels.empty}</span>}
          </ContextDisclosure>
          <ContextDisclosure title={labels.toolsDisclosure({ count: run.tools.length })} defaultOpen>
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
          {run.rounds.map((round) => (
            <ContextDisclosure
              defaultOpen={round.index === 0}
              key={round.index}
              title={labels.requestWindowLabel({ count: round.requestWindow.length })}
            >
              {round.requestWindow.length === 0 ? (
                <span className="is-muted">{labels.empty}</span>
              ) : (
                <div className="agent-debug-message-list">
                  {round.requestWindow.map((row) => <MessageRow key={row.id} message={row} labels={labels} />)}
                </div>
              )}
            </ContextDisclosure>
          ))}
        </div>
      </DebugPanelSection>

      <DebugPanelSection title={labels.processTitle}>
        {run.rounds.length === 0 ? (
          <div className="agent-debug-card is-muted">{labels.noRoundsYet}</div>
        ) : run.rounds.map((round) => (
          <RoundProcessCard key={round.index} round={round} labels={labels} />
        ))}
      </DebugPanelSection>

      <DebugPanelSection title={labels.usageTitle}>
        {run.usage ? <UsageBreakdown usage={run.usage} labels={labels} /> : <div className="agent-debug-card is-muted">{labels.usagePending}</div>}
      </DebugPanelSection>

      <DebugPanelSection title={labels.advancedTitle}>
        <div className="agent-debug-advanced-grid">
          <DebugMetric label="runId" value={run.runId} />
          <DebugMetric label="parentRunId" value={run.parentRunId ?? labels.empty} />
          <DebugMetric label="parentToolCallId" value={run.parentToolCallId ?? labels.empty} />
          <DebugMetric label="agentId" value={run.agentId} />
        </div>
      </DebugPanelSection>
    </div>
  );
}

function RoundProcessCard({ round, labels }: { round: AgentDebugRound; labels: DebugLabels }) {
  return (
    <article className="agent-debug-round-card">
      <div className="agent-debug-section-header">
        <h3>{labels.roundTitle({ index: round.index + 1 })}</h3>
        <span className={`agent-debug-status-pill is-${round.status}`}>{statusLabel(round.status, labels)}</span>
        {round.modelId ? <code className="agent-debug-run-model">{round.modelId}</code> : null}
        {round.stopReason ? <code>{round.stopReason}</code> : null}
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

function MessageRow({ message, labels }: { message: AgentDebugMessageRow; labels: DebugLabels }) {
  return (
    <article className="agent-debug-message-row">
      <div className="agent-debug-message-head">
        <span>{message.role}</span>
        <strong>{message.summary}</strong>
        <code>{formatBytes(message.bytes)}</code>
      </div>
      <div className="agent-debug-part-list">
        {message.parts.map((part, index) => (
          <PartRow part={part} rowId={message.id} index={index} key={`${message.id}-${index}`} labels={labels} />
        ))}
      </div>
    </article>
  );
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
