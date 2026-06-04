import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentDebugMessagePart,
  AgentDebugMessageRow,
  AgentDebugSnapshot,
  AgentDebugTotals,
  AgentDebugUsage,
  AgentRuntimeEvent,
} from '../../../core/agentTypes';
import type { Messages } from '../../../core/i18n';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { ChevronDownIcon, CopyIcon, RefreshIcon, ICON_SIZE } from '../icons';
import { IconButton } from '../primitives/IconButton';

type DebugLabels = Messages['agentDebug'];

interface AgentDebugPanelProps {
  sessionId: string | null;
}

function emptyTotals(): AgentDebugTotals {
  return {
    queries: 0,
    rounds: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    costInputUsd: 0,
    costOutputUsd: 0,
    costCacheReadUsd: 0,
    costCacheWriteUsd: 0,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
}

function formatCost(cost: number): string {
  if (cost <= 0) return '$0.0000';
  if (cost < 0.01) return `$${cost.toFixed(5)}`;
  return `$${cost.toFixed(4)}`;
}

function usageTooltip(usage: AgentDebugUsage): string {
  return [
    `input: ${usage.input.toLocaleString()}`,
    `output: ${usage.output.toLocaleString()}`,
    `cache read: ${usage.cacheRead.toLocaleString()}`,
    `cache write: ${usage.cacheWrite.toLocaleString()}`,
    `total tokens: ${usage.totalTokens.toLocaleString()}`,
    `cost input: ${formatCost(usage.costInputUsd)}`,
    `cost output: ${formatCost(usage.costOutputUsd)}`,
    `cost cache read: ${formatCost(usage.costCacheReadUsd)}`,
    `cost cache write: ${formatCost(usage.costCacheWriteUsd)}`,
  ].join('\n');
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatPercent(value: number | null, labels: DebugLabels): string {
  return value == null ? labels.unknown : `${value.toFixed(1)}%`;
}

function sourceLabel(snapshot: AgentDebugSnapshot, labels: DebugLabels): string {
  if (snapshot.source === 'provider_payload') return labels.sourceProviderPayload;
  if (snapshot.source === 'provider_response') return labels.sourceProviderResponse;
  return labels.sourceRuntimeState;
}

function statusLabel(input: Pick<AgentDebugSnapshot, 'status'>, labels: DebugLabels): string {
  if (input.status === 'running') return labels.statusRunning;
  if (input.status === 'completed') return labels.statusCompleted;
  if (input.status === 'aborted') return labels.statusAborted;
  if (input.status === 'interrupted') return labels.statusInterrupted;
  return labels.statusError;
}

function statusClassName(input: Pick<AgentDebugSnapshot, 'status'>): string {
  return `agent-debug-status-pill is-${input.status}`;
}

function partTitle(part: AgentDebugMessagePart): string {
  if (part.kind === 'toolCall') return `tool_call ${part.name}`;
  if (part.kind === 'toolResult') return `tool_result ${part.toolUseId || ''}`.trim();
  if (part.kind === 'thinking') return 'thinking';
  if (part.kind === 'image') return 'image';
  if (part.kind === 'json') return 'json';
  return part.isReminder ? 'system reminder' : 'text';
}

function partBody(part: AgentDebugMessagePart): string {
  if (part.kind === 'toolCall' || part.kind === 'toolResult') return part.body;
  return part.body;
}

function truncate(text: string, maxLength = 96): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength).trim()}...` : trimmed;
}

function previewFromPart(part: AgentDebugMessagePart): string {
  if (part.kind === 'toolCall') return truncate(part.body, 120);
  if (part.kind === 'toolResult') return truncate(part.body, 120);
  return truncate(part.body, 120);
}

function previewFromSnapshot(snapshot: AgentDebugSnapshot, labels: DebugLabels): string {
  for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
    const message = snapshot.messages[i]!;
    if (message.role !== 'user') continue;
    const text = message.parts.find((part) => part.kind === 'text' && !part.isReminder);
    if (text?.kind === 'text') return truncate(text.body, 80);
  }
  return labels.requestFallbackPreview({ index: snapshot.turnIndex });
}

function addUsage(total: AgentDebugUsage, usage: AgentDebugUsage) {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.costUsd += usage.costUsd;
  total.costInputUsd += usage.costInputUsd;
  total.costOutputUsd += usage.costOutputUsd;
  total.costCacheReadUsd += usage.costCacheReadUsd;
  total.costCacheWriteUsd += usage.costCacheWriteUsd;
}

function emptyUsage(): AgentDebugUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    costInputUsd: 0,
    costOutputUsd: 0,
    costCacheReadUsd: 0,
    costCacheWriteUsd: 0,
  };
}

interface AgentDebugQueryBlock {
  id: string;
  queryIndex: number;
  preview: string;
  rounds: AgentDebugSnapshot[];
  status: AgentDebugSnapshot['status'];
  total: AgentDebugUsage;
}

function buildQueryBlocks(history: AgentDebugSnapshot[], labels: DebugLabels): AgentDebugQueryBlock[] {
  const blocks = new Map<number, AgentDebugQueryBlock>();
  for (const snapshot of history) {
    const queryIndex = snapshot.queryIndex || snapshot.turnIndex;
    let block = blocks.get(queryIndex);
    if (!block) {
      block = {
        id: `query-${queryIndex}`,
        queryIndex,
        preview: previewFromSnapshot(snapshot, labels),
        rounds: [],
        status: snapshot.status,
        total: emptyUsage(),
      };
      blocks.set(queryIndex, block);
    }
    block.rounds.push(snapshot);
    block.status = snapshot.status;
    const nextPreview = previewFromSnapshot(snapshot, labels);
    if (nextPreview) block.preview = nextPreview;
    if (snapshot.usage) addUsage(block.total, snapshot.usage);
  }
  return [...blocks.values()].sort((left, right) => left.queryIndex - right.queryIndex);
}

async function copyText(text: string) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
}

function CostInline({ usage }: { usage: AgentDebugUsage }) {
  const tooltip = usageTooltip(usage);
  return (
    <span aria-label={tooltip} className="agent-debug-cost" data-tooltip={tooltip} tabIndex={0}>
      {formatCost(usage.costUsd)}
    </span>
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

function DebugSectionHeader(props: { id?: string; meta?: ReactNode; title: string }) {
  return (
    <div className="agent-debug-section-header">
      <h3 id={props.id}>{props.title}</h3>
      {props.meta ? <span>{props.meta}</span> : null}
    </div>
  );
}

function useAgentDebug(sessionId: string | null) {
  const [resolvedSessionId, setResolvedSessionId] = useState<string | null>(sessionId);
  const [snapshot, setSnapshot] = useState<AgentDebugSnapshot | null>(null);
  const [history, setHistory] = useState<AgentDebugSnapshot[]>([]);
  const [totals, setTotals] = useState<AgentDebugTotals>(() => emptyTotals());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    setLoading(true);
    try {
      let targetSessionId = sessionId;
      if (!targetSessionId) {
        const sessions = await api.agentListSessions();
        if (requestId !== refreshRequestRef.current) return;
        targetSessionId = sessions[0]?.id ?? null;
      }
      if (requestId !== refreshRequestRef.current) return;
      setResolvedSessionId(targetSessionId);

      if (!targetSessionId) {
        setSnapshot(null);
        setHistory([]);
        setTotals(emptyTotals());
        setError(null);
        return;
      }

      const nextSnapshot = await api.agentDebugSnapshot(targetSessionId);
      const [nextHistory, nextTotals] = await Promise.all([
        api.agentDebugHistory(targetSessionId),
        api.agentDebugTotals(targetSessionId),
      ]);
      if (requestId !== refreshRequestRef.current) return;
      setSnapshot(nextSnapshot);
      setHistory(nextHistory);
      setTotals(nextTotals);
      setError(null);
    } catch (caught) {
      if (requestId !== refreshRequestRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const eventSessionId = sessionId ?? resolvedSessionId;
    if (!eventSessionId) return undefined;
    const unlisten = window.lin?.onAgentEvent((event: AgentRuntimeEvent) => {
      if (event.type !== 'projection' && event.type !== 'error' && event.type !== 'tool_call' && event.type !== 'tool_result') {
        return;
      }
      if (event.sessionId !== eventSessionId) return;
      void refresh();
    });
    return () => {
      unlisten?.();
    };
  }, [refresh, resolvedSessionId, sessionId]);

  return { error, history, loading, refresh, resolvedSessionId, snapshot, totals };
}

export function AgentDebugPanel({ sessionId }: AgentDebugPanelProps) {
  const labels = useT().agentDebug;
  const { error, history, loading, refresh, resolvedSessionId, snapshot, totals } = useAgentDebug(sessionId);
  const latest = snapshot ?? history.at(-1) ?? null;
  const queryBlocks = useMemo(() => buildQueryBlocks(history, labels), [history, labels]);

  if (!sessionId && !resolvedSessionId && loading) {
    return (
      <div className="agent-debug-panel">
        <div className="agent-debug-empty">{labels.loadingSession}</div>
      </div>
    );
  }

  if (!sessionId && !resolvedSessionId) {
    return (
      <div className="agent-debug-panel">
        <div className="agent-debug-empty">{labels.noSession}</div>
      </div>
    );
  }

  return (
    <div className="agent-debug-panel">
      <header className="agent-debug-header">
        <div>
          <h2>{labels.title}</h2>
          <p>{resolvedSessionId ?? sessionId}</p>
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

      {loading && !latest ? <div className="agent-debug-card is-muted">{labels.loadingRuntime}</div> : null}
      {error ? <div className="agent-debug-error">{error}</div> : null}

      {latest ? (
        <>
          <SessionBar latest={latest} totals={totals} />
          <ContextCard snapshot={latest} />
          <section className="agent-debug-query-stack" aria-label={labels.timelineAriaLabel}>
            {queryBlocks.length === 0 ? (
              <div className="agent-debug-card is-muted">{labels.noRequests}</div>
            ) : queryBlocks.map((block) => (
              <QueryCard block={block} key={block.id} />
            ))}
          </section>
        </>
      ) : (
        <div className="agent-debug-card is-muted">{labels.noRuntimeData}</div>
      )}
    </div>
  );
}

function SessionBar(props: { latest: AgentDebugSnapshot; totals: AgentDebugTotals }) {
  const labels = useT().agentDebug;
  const latest = props.latest;
  const estimate = latest.tokenEstimate;
  const contextWindow = estimate.contextWindow ? formatTokens(estimate.contextWindow) : labels.unknown;
  return (
    <section className="agent-debug-overview-grid" aria-label={labels.overviewAriaLabel}>
      <DebugMetric
        label={labels.metricSession}
        value={labels.queries({ count: props.totals.queries })}
        meta={<>{labels.rounds({ count: props.totals.rounds })} · <CostInline usage={props.totals} /></>}
      />
      <DebugMetric
        label={labels.metricModel}
        value={latest.modelId}
        meta={<>{latest.provider} · {sourceLabel(latest, labels)}</>}
      />
      <DebugMetric
        label={labels.metricContext}
        value={`${formatTokens(estimate.total)} / ${contextWindow}`}
        meta={formatPercent(estimate.usagePercent, labels)}
      />
      <DebugMetric
        label={labels.metricStatus}
        value={<span className={statusClassName(latest)}>{statusLabel(latest, labels)}</span>}
        meta={formatTime(latest.capturedAt)}
      />
    </section>
  );
}

function ContextCard({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const labels = useT().agentDebug;
  const estimate = snapshot.tokenEstimate;
  const contextWindow = estimate.contextWindow ? formatTokens(estimate.contextWindow) : labels.unknown;
  const requestJson = labels.requestJson({ size: formatBytes(snapshot.wire.bytes) });
  return (
    <section className="agent-debug-card agent-debug-context-card" aria-labelledby="agent-debug-context-heading">
      <DebugSectionHeader
        id="agent-debug-context-heading"
        title={labels.requestContext}
        meta={requestJson}
      />
      <div className="agent-debug-context-head">
        <div>
          <div className="agent-debug-section-title">{labels.contextLabel}</div>
          <div className="agent-debug-context-summary">
            {labels.contextSummary({
              total: formatTokens(estimate.total),
              window: contextWindow,
              percent: formatPercent(estimate.usagePercent, labels),
            })}
          </div>
        </div>
        <code>{requestJson}</code>
      </div>
      <div className="agent-debug-token-bar">
        <div
          className="agent-debug-token-bar-fill"
          style={{ width: `${Math.min(100, estimate.usagePercent ?? 0)}%` }}
        />
      </div>
      <div className="agent-debug-stat-row">
        <span>{labels.statSystem} {formatTokens(estimate.systemPrompt)}</span>
        <span>{labels.statTools} {formatTokens(estimate.tools)}</span>
        <span>{labels.statMessages} {formatTokens(estimate.messages)}</span>
        <strong>{labels.statTotal} {formatTokens(estimate.total)}</strong>
      </div>
      <div className="agent-debug-context-details">
        <ContextDisclosure title={labels.systemPromptDisclosure({ size: formatBytes(snapshot.systemPromptBytes) })} copyText={snapshot.systemPrompt}>
          <pre>{snapshot.systemPrompt || labels.empty}</pre>
        </ContextDisclosure>
        <ContextDisclosure title={labels.toolsDisclosure({ count: snapshot.tools.length })}>
          {snapshot.tools.length === 0 ? (
            <div className="agent-debug-empty-line">{labels.noTools}</div>
          ) : snapshot.tools.map((tool) => (
            <details className="agent-debug-tool-row" key={tool.name}>
              <summary>
                <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
                <strong>{tool.name}</strong>
                <span>{tool.description || labels.noDescription}</span>
                <code>{formatBytes(tool.bytes)}</code>
              </summary>
              <pre>{tool.schema}</pre>
            </details>
          ))}
        </ContextDisclosure>
      </div>
    </section>
  );
}

function QueryCard({ block }: { block: AgentDebugQueryBlock }) {
  const labels = useT().agentDebug;
  return (
    <details className="agent-debug-card agent-debug-query-card" open>
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.menu} />
        <span className="agent-debug-query-index">{labels.queryIndex({ index: block.queryIndex })}</span>
        <strong>{block.preview}</strong>
        <span className="agent-debug-query-meta">
          {labels.rounds({ count: block.rounds.length })} · <CostInline usage={block.total} />
        </span>
        <span className={statusClassName({ status: block.status })}>{statusLabel({ status: block.status }, labels)}</span>
      </summary>
      <div className="agent-debug-query-body">
        {block.rounds.map((round) => (
          <RoundCard round={round} key={round.id} />
        ))}
      </div>
    </details>
  );
}

function RoundCard({ round }: { round: AgentDebugSnapshot }) {
  const labels = useT().agentDebug;
  return (
    <article className="agent-debug-round-card">
      <div className="agent-debug-round-head">
        <div>
          <strong>{labels.round({ index: round.turnIndex })}</strong>
          <span>{formatTime(round.capturedAt)} · {round.modelId}</span>
        </div>
        <div className="agent-debug-round-meta">
          <span className={statusClassName(round)}>{statusLabel(round, labels)}</span>
          <span>{round.usage ? <CostInline usage={round.usage} /> : labels.usagePending}</span>
          <code>{round.wire.hash}</code>
        </div>
      </div>
      <div className="agent-debug-round-timeline">
        <div className="agent-debug-subsection-title">{labels.messagesSubsection({ count: round.messageCount })}</div>
        <div className="agent-debug-message-list">
          {round.messages.map((message) => (
            <MessageRow message={message} key={message.id} />
          ))}
          <ResponseMessageRow round={round} />
        </div>
      </div>
      <RawProviderPayload round={round} />
    </article>
  );
}

function RawProviderPayload({ round }: { round: AgentDebugSnapshot }) {
  const labels = useT().agentDebug;
  const [payload, setPayload] = useState<string | null>(round.wire.json ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPayload(round.wire.json ?? null);
    setLoading(false);
    setError(null);
  }, [round.id, round.wire.json]);

  const loadPayload = useCallback(() => {
    const payloadId = round.wire.payloadRef?.id;
    if (payload || loading || !payloadId) return;
    setLoading(true);
    setError(null);
    void api.agentDebugPayload(round.sessionId, payloadId)
      .then((nextPayload) => {
        setPayload(nextPayload ?? '');
        if (nextPayload == null) setError(labels.payloadUnavailableNow);
      })
      .catch((nextError) => setError(nextError instanceof Error ? nextError.message : String(nextError)))
      .finally(() => setLoading(false));
  }, [labels, loading, payload, round.sessionId, round.wire.payloadRef?.id]);

  return (
    <details
      className="agent-debug-disclosure"
      onToggle={(event) => {
        if (event.currentTarget.open) loadPayload();
      }}
    >
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.menu} />
        <span>{labels.rawPayload({ size: formatBytes(round.wire.bytes) })}</span>
        {payload ? (
          <IconButton
            className="agent-debug-copy-button"
            icon={CopyIcon}
            iconSize={ICON_SIZE.tiny}
            label={labels.copyRawPayload}
            onClick={(event) => {
              event.preventDefault();
              void copyText(payload);
            }}
            variant="panel"
          />
        ) : null}
      </summary>
      <div className="agent-debug-disclosure-body">
        {payload ? (
          <pre>{payload}</pre>
        ) : error ? (
          <div className="agent-debug-error">{error}</div>
        ) : loading ? (
          <div className="agent-debug-empty-line">{labels.loadingPayload}</div>
        ) : round.wire.payloadRef ? (
          <div className="agent-debug-empty-line">{labels.openToLoad}</div>
        ) : (
          <div className="agent-debug-empty-line">{labels.rawPayloadUnavailable}</div>
        )}
      </div>
    </details>
  );
}

function ResponseMessageRow({ round }: { round: AgentDebugSnapshot }) {
  const labels = useT().agentDebug;
  return (
    <article className="agent-debug-message-row is-response">
      <div className="agent-debug-message-head">
        {/* `assistant` is the wire role name, mirrored verbatim like other protocol fields. */}
        <span>assistant</span>
        <strong>{labels.providerResponse}</strong>
        <span>{round.usage ? <CostInline usage={round.usage} /> : labels.usagePending}</span>
      </div>
      <div className="agent-debug-part-list">
        {round.responseParts.length === 0 ? (
          <div className="agent-debug-empty-line">{labels.noResponseParts}</div>
        ) : round.responseParts.map((part, index) => (
          <PartRow part={part} rowId={`response-${round.id}`} index={index} key={`response-${index}`} />
        ))}
      </div>
      {round.errorMessage ? <div className="agent-debug-error">{round.errorMessage}</div> : null}
    </article>
  );
}

function MessageRow({ message }: { message: AgentDebugMessageRow }) {
  const labels = useT().agentDebug;
  return (
    <article className="agent-debug-message-row">
      <div className="agent-debug-message-head">
        <span>{message.role}</span>
        <strong>{message.summary}</strong>
        <code>{formatBytes(message.bytes)}</code>
      </div>
      <div className="agent-debug-part-list">
        {message.parts.map((part, index) => (
          <PartRow part={part} rowId={message.id} index={index} key={`${message.id}-${index}`} />
        ))}
      </div>
      <ContextDisclosure title={labels.rawMessageJson} copyText={message.json}>
        <pre>{message.json}</pre>
      </ContextDisclosure>
    </article>
  );
}

function PartRow(props: { index: number; part: AgentDebugMessagePart; rowId: string }) {
  const labels = useT().agentDebug;
  const body = partBody(props.part);
  return (
    <details className={`agent-debug-part-details is-${props.part.kind}`}>
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <span>{partTitle(props.part)}</span>
        <strong>{previewFromPart(props.part)}</strong>
        <IconButton
          className="agent-debug-copy-button"
          icon={CopyIcon}
          iconSize={ICON_SIZE.tiny}
          label={labels.copyTitle({ title: partTitle(props.part) })}
          onClick={(event) => {
            event.preventDefault();
            void copyText(body);
          }}
          variant="panel"
        />
      </summary>
      <pre>{body}</pre>
    </details>
  );
}

function ContextDisclosure(props: { children: ReactNode; copyText?: string; title: string }) {
  const labels = useT().agentDebug;
  return (
    <details className="agent-debug-disclosure">
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.menu} />
        <span>{props.title}</span>
        {props.copyText !== undefined ? (
          <IconButton
            className="agent-debug-copy-button"
            icon={CopyIcon}
            iconSize={ICON_SIZE.tiny}
            label={labels.copyTitle({ title: props.title })}
            onClick={(event) => {
              event.preventDefault();
              void copyText(props.copyText ?? '');
            }}
            variant="panel"
          />
        ) : null}
      </summary>
      <div className="agent-debug-disclosure-body">{props.children}</div>
    </details>
  );
}
