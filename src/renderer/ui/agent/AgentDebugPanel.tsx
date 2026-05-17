import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentDebugMessagePart,
  AgentDebugMessageRow,
  AgentDebugSnapshot,
  AgentDebugTotals,
  AgentDebugUsage,
  AgentRuntimeEvent,
} from '../../../core/agentTypes';
import { api } from '../../api/client';
import { ChevronDownIcon, CopyIcon, RefreshIcon, ICON_SIZE } from '../icons';

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

function formatPercent(value: number | null): string {
  return value == null ? 'unknown' : `${value.toFixed(1)}%`;
}

function sourceLabel(snapshot: AgentDebugSnapshot): string {
  return snapshot.source === 'provider_payload' ? 'Provider payload' : 'Runtime state';
}

function statusLabel(input: Pick<AgentDebugSnapshot, 'status'>): string {
  if (input.status === 'running') return 'Running';
  if (input.status === 'completed') return 'Completed';
  if (input.status === 'aborted') return 'Aborted';
  if (input.status === 'interrupted') return 'Interrupted';
  return 'Error';
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

function previewFromSnapshot(snapshot: AgentDebugSnapshot): string {
  for (let i = snapshot.messages.length - 1; i >= 0; i -= 1) {
    const message = snapshot.messages[i]!;
    if (message.role !== 'user') continue;
    const text = message.parts.find((part) => part.kind === 'text' && !part.isReminder);
    if (text?.kind === 'text') return truncate(text.body, 80);
  }
  return `Provider request #${snapshot.turnIndex}`;
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

function buildQueryBlocks(history: AgentDebugSnapshot[]): AgentDebugQueryBlock[] {
  const blocks = new Map<number, AgentDebugQueryBlock>();
  for (const snapshot of history) {
    const queryIndex = snapshot.queryIndex || snapshot.turnIndex;
    let block = blocks.get(queryIndex);
    if (!block) {
      block = {
        id: `query-${queryIndex}`,
        queryIndex,
        preview: previewFromSnapshot(snapshot),
        rounds: [],
        status: snapshot.status,
        total: emptyUsage(),
      };
      blocks.set(queryIndex, block);
    }
    block.rounds.push(snapshot);
    block.status = snapshot.status;
    const nextPreview = previewFromSnapshot(snapshot);
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
      if (event.type !== 'snapshot' && event.type !== 'error' && event.type !== 'tool_call' && event.type !== 'tool_result') {
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
  const { error, history, loading, refresh, resolvedSessionId, snapshot, totals } = useAgentDebug(sessionId);
  const latest = snapshot ?? history.at(-1) ?? null;
  const queryBlocks = useMemo(() => buildQueryBlocks(history), [history]);

  if (!sessionId && !resolvedSessionId && loading) {
    return (
      <div className="agent-debug-panel">
        <div className="agent-debug-empty">Loading latest agent session...</div>
      </div>
    );
  }

  if (!sessionId && !resolvedSessionId) {
    return (
      <div className="agent-debug-panel">
        <div className="agent-debug-empty">No active agent session.</div>
      </div>
    );
  }

  return (
    <div className="agent-debug-panel">
      <header className="agent-debug-header">
        <div>
          <h2>Agent Debug</h2>
          <p>{resolvedSessionId ?? sessionId}</p>
        </div>
        <button
          aria-label="Refresh agent debug"
          className="agent-debug-icon-button"
          onClick={() => void refresh()}
          title="Refresh"
          type="button"
        >
          <RefreshIcon size={ICON_SIZE.toolbar} />
        </button>
      </header>

      {loading && !latest ? <div className="agent-debug-card is-muted">Loading live runtime data...</div> : null}
      {error ? <div className="agent-debug-error">{error}</div> : null}

      {latest ? (
        <>
          <SessionBar latest={latest} totals={totals} />
          <ContextCard snapshot={latest} />
          <section className="agent-debug-query-stack" aria-label="Provider request timeline">
            {queryBlocks.length === 0 ? (
              <div className="agent-debug-card is-muted">No provider requests captured yet.</div>
            ) : queryBlocks.map((block) => (
              <QueryCard block={block} key={block.id} />
            ))}
          </section>
        </>
      ) : (
        <div className="agent-debug-card is-muted">No runtime data available.</div>
      )}
    </div>
  );
}

function SessionBar(props: { latest: AgentDebugSnapshot; totals: AgentDebugTotals }) {
  const latest = props.latest;
  return (
    <section className="agent-debug-session-bar">
      <div>
        <div className="agent-debug-session-title">Session</div>
        <div className="agent-debug-session-meta">
          {props.totals.queries} queries · {props.totals.rounds} rounds · <CostInline usage={props.totals} />
        </div>
      </div>
      <div className="agent-debug-session-model">
        <strong>{latest.modelId}</strong>
        <span>{latest.provider} · {sourceLabel(latest)} · {statusLabel(latest)}</span>
      </div>
    </section>
  );
}

function ContextCard({ snapshot }: { snapshot: AgentDebugSnapshot }) {
  const estimate = snapshot.tokenEstimate;
  const contextWindow = estimate.contextWindow ? formatTokens(estimate.contextWindow) : 'unknown';
  return (
    <section className="agent-debug-card agent-debug-context-card">
      <div className="agent-debug-context-head">
        <div>
          <div className="agent-debug-section-title">Context</div>
          <div className="agent-debug-context-summary">
            {formatTokens(estimate.total)} / {contextWindow} tokens · {formatPercent(estimate.usagePercent)}
          </div>
        </div>
        <code>{formatBytes(snapshot.wire.bytes)} request JSON</code>
      </div>
      <div className="agent-debug-token-bar">
        <div
          className="agent-debug-token-bar-fill"
          style={{ width: `${Math.min(100, estimate.usagePercent ?? 0)}%` }}
        />
      </div>
      <div className="agent-debug-stat-row">
        <span>system {formatTokens(estimate.systemPrompt)}</span>
        <span>tools {formatTokens(estimate.tools)}</span>
        <span>messages {formatTokens(estimate.messages)}</span>
        <strong>total {formatTokens(estimate.total)}</strong>
      </div>
      <div className="agent-debug-context-details">
        <ContextDisclosure title={`System Prompt · ${formatBytes(snapshot.systemPromptBytes)}`} copyText={snapshot.systemPrompt}>
          <pre>{snapshot.systemPrompt || '(empty)'}</pre>
        </ContextDisclosure>
        <ContextDisclosure title={`Tools · ${snapshot.tools.length}`}>
          {snapshot.tools.length === 0 ? (
            <div className="agent-debug-empty-line">No tools in this request.</div>
          ) : snapshot.tools.map((tool) => (
            <details className="agent-debug-tool-row" key={tool.name}>
              <summary>
                <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
                <strong>{tool.name}</strong>
                <span>{tool.description || 'No description'}</span>
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
  return (
    <details className="agent-debug-card agent-debug-query-card" open>
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.menu} />
        <span className="agent-debug-query-index">Q{block.queryIndex}</span>
        <strong>{block.preview}</strong>
        <span>
          {block.rounds.length} rounds · <CostInline usage={block.total} /> · {statusLabel({ status: block.status })}
        </span>
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
  return (
    <article className="agent-debug-round-card">
      <div className="agent-debug-round-head">
        <div>
          <strong>Round {round.turnIndex}</strong>
          <span>{formatTime(round.capturedAt)} · {round.modelId}</span>
        </div>
        <div className="agent-debug-round-meta">
          <span>{statusLabel(round)}</span>
          <span>{round.usage ? <CostInline usage={round.usage} /> : 'usage pending'}</span>
          <code>{round.wire.hash}</code>
        </div>
      </div>
      <div className="agent-debug-round-grid">
        <section>
          <div className="agent-debug-subsection-title">Request Context · {round.messageCount} messages</div>
          <div className="agent-debug-message-list">
            {round.messages.map((message) => (
              <MessageRow message={message} key={message.id} />
            ))}
          </div>
        </section>
        <section>
          <div className="agent-debug-subsection-title">Response</div>
          {round.usage ? <UsageRow usage={round.usage} /> : <div className="agent-debug-empty-line">No provider usage yet.</div>}
          {round.responseParts.length === 0 ? (
            <div className="agent-debug-empty-line">No response parts captured yet.</div>
          ) : round.responseParts.map((part, index) => (
            <PartRow part={part} rowId={`response-${round.id}`} index={index} key={`response-${index}`} />
          ))}
          {round.errorMessage ? <div className="agent-debug-error">{round.errorMessage}</div> : null}
        </section>
      </div>
      <ContextDisclosure title={`Raw Provider Payload · ${formatBytes(round.wire.bytes)}`} copyText={round.wire.json}>
        <pre>{round.wire.json}</pre>
      </ContextDisclosure>
    </article>
  );
}

function MessageRow({ message }: { message: AgentDebugMessageRow }) {
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
      <ContextDisclosure title="Raw message JSON" copyText={message.json}>
        <pre>{message.json}</pre>
      </ContextDisclosure>
    </article>
  );
}

function PartRow(props: { index: number; part: AgentDebugMessagePart; rowId: string }) {
  const body = partBody(props.part);
  return (
    <details className={`agent-debug-part-details is-${props.part.kind}`}>
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <span>{partTitle(props.part)}</span>
        <strong>{previewFromPart(props.part)}</strong>
        <button
          aria-label={`Copy ${partTitle(props.part)}`}
          className="agent-debug-copy-button"
          onClick={(event) => {
            event.preventDefault();
            void copyText(body);
          }}
          type="button"
        >
          <CopyIcon size={ICON_SIZE.tiny} />
        </button>
      </summary>
      <pre>{body}</pre>
    </details>
  );
}

function UsageRow({ usage }: { usage: AgentDebugUsage }) {
  return (
    <div className="agent-debug-usage-row">
      <span>Provider usage</span>
      <CostInline usage={usage} />
    </div>
  );
}

function ContextDisclosure(props: { children: ReactNode; copyText?: string; title: string }) {
  return (
    <details className="agent-debug-disclosure">
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.menu} />
        <span>{props.title}</span>
        {props.copyText !== undefined ? (
          <button
            aria-label={`Copy ${props.title}`}
            className="agent-debug-copy-button"
            onClick={(event) => {
              event.preventDefault();
              void copyText(props.copyText ?? '');
            }}
            type="button"
          >
            <CopyIcon size={ICON_SIZE.tiny} />
          </button>
        ) : null}
      </summary>
      <div className="agent-debug-disclosure-body">{props.children}</div>
    </details>
  );
}
