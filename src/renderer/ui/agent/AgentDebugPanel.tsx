import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { ChevronDownIcon, CopyIcon, RefreshIcon, ICON_SIZE, LoaderIcon } from '../icons';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';

// Run-grounded debug view ([[agent-debug-run-grounded]]): a read-only window onto
// the execution tree — conversation → runs (per agent) → rounds (one provider
// call) → request window / response / tool exchanges — sourced from the run
// ledgers the system already writes. DM is the single-member case of Channel.

interface AgentDebugPanelProps {
  conversationId: string | null;
}

type DebugLabels = ReturnType<typeof useT>['agentDebug'];

// --- formatting -----------------------------------------------------------

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
    `cache r/w: ${usage.cacheRead.toLocaleString()} / ${usage.cacheWrite.toLocaleString()}`,
    `total: ${usage.totalTokens.toLocaleString()}`,
    `cost: ${formatCost(usage.costUsd)}`,
  ].join('\n');
}

function truncate(text: string, maxLength = 120): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength).trim()}...` : trimmed;
}

/** A short, stable agent label + a 0–7 palette bucket for per-agent coloring. */
function agentBadge(agentId: string): { label: string; tone: number } {
  const label = agentId.split(':').pop() || agentId;
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  return { label, tone: hash % 8 };
}

function statusLabel(status: AgentDebugTurnStatus, labels: DebugLabels): string {
  if (status === 'running') return labels.statusRunning;
  if (status === 'completed') return labels.statusCompleted;
  if (status === 'aborted') return labels.statusAborted;
  if (status === 'interrupted') return labels.statusInterrupted;
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
    const unlisten = window.lin?.onAgentEvent((event: AgentRuntimeEvent) => {
      if (event.type !== 'projection' && event.type !== 'error' && event.type !== 'tool_call' && event.type !== 'tool_result') return;
      if (event.conversationId !== eventConversationId) return;
      void refresh();
    });
    return () => { unlisten?.(); };
  }, [refresh, resolvedConversationId, conversationId]);

  return { conversation, error, loading, refresh, resolvedConversationId };
}

// A run summary plus its delegated children (the run tree by parentRunId).
interface RunTreeNode {
  run: AgentDebugRunSummary;
  children: RunTreeNode[];
}

function buildRunTree(runs: readonly AgentDebugRunSummary[]): RunTreeNode[] {
  const byId = new Map<string, RunTreeNode>();
  for (const run of runs) byId.set(run.runId, { run, children: [] });
  const roots: RunTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.run.parentRunId ? byId.get(node.run.parentRunId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// --- top-level panel ------------------------------------------------------

export function AgentDebugPanel({ conversationId }: AgentDebugPanelProps) {
  const labels = useT().agentDebug;
  const { conversation, error, loading, refresh, resolvedConversationId } = useDebugTimeline(conversationId);
  const [agentFilter, setAgentFilter] = useState<string | null>(null);

  const tree = useMemo(() => buildRunTree(conversation?.runs ?? []), [conversation]);
  const members = conversation?.members ?? [];

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

  const visibleTree = agentFilter ? tree.filter((node) => node.run.agentId === agentFilter) : tree;

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
        <>
          <Overview conversation={conversation} labels={labels} />
          {members.length > 1 ? (
            <AgentFilter members={members} active={agentFilter} onChange={setAgentFilter} labels={labels} />
          ) : null}
          <section className="agent-debug-run-stack" aria-label={labels.timelineAriaLabel}>
            {visibleTree.length === 0 ? (
              <div className="agent-debug-card is-muted">{labels.noRuntimeData}</div>
            ) : visibleTree.map((node) => (
              <RunNode key={node.run.runId} node={node} conversationId={resolvedConversationId} depth={0} labels={labels} />
            ))}
          </section>
        </>
      ) : (
        !loading && !error ? <div className="agent-debug-card is-muted">{labels.noRuntimeData}</div> : null
      )}
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

function AgentFilter({ members, active, onChange, labels }: { members: string[]; active: string | null; onChange: (value: string | null) => void; labels: DebugLabels }) {
  return (
    <div className="agent-debug-filter" role="group" aria-label={labels.filterAriaLabel}>
      <button type="button" className={`agent-debug-chip${active === null ? ' is-active' : ''}`} onClick={() => onChange(null)}>
        {labels.filterAll}
      </button>
      {members.map((agentId) => {
        const { label, tone } = agentBadge(agentId);
        return (
          <button
            key={agentId}
            type="button"
            className={`agent-debug-chip${active === agentId ? ' is-active' : ''}`}
            data-tone={tone}
            onClick={() => onChange(active === agentId ? null : agentId)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// --- run node (lazy detail) ----------------------------------------------

function RunNode({ node, conversationId, depth, labels }: { node: RunTreeNode; conversationId: string | null; depth: number; labels: DebugLabels }) {
  const { run } = node;
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AgentDebugRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { label, tone } = agentBadge(run.agentId);

  const loadDetail = useCallback(async () => {
    if (detail || !conversationId) return;
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
  }, [detail, conversationId, run.runId]);

  return (
    <div className="agent-debug-run-node" data-depth={depth}>
      <button
        type="button"
        className="agent-debug-run-head"
        aria-expanded={open}
        onClick={() => { const next = !open; setOpen(next); if (next) void loadDetail(); }}
      >
        <ChevronDownIcon className={`agent-debug-summary-chevron${open ? ' is-open' : ''}`} size={ICON_SIZE.tiny} />
        <span className="agent-debug-agent-badge" data-tone={tone}>{label}</span>
        <span className="agent-debug-run-kind">{kindLabel(run.kind, labels)}</span>
        {run.parentToolCallId ? <span className="agent-debug-run-parent">{labels.delegatedBadge}</span> : null}
        <span className={`agent-debug-status-pill is-${run.status}`}>{statusLabel(run.status, labels)}</span>
        {run.modelId ? <code className="agent-debug-run-model">{run.modelId}</code> : null}
        <span className="agent-debug-run-rounds">{labels.runRounds({ count: run.roundCount })}</span>
        {run.usage ? <CostInline usage={run.usage} /> : null}
      </button>

      {open ? (
        <div className="agent-debug-run-body">
          {loading ? <EmptyState icon={LoaderIcon} loading role="status" title={labels.loadingRun} /> : null}
          {error ? <ErrorState message={error} /> : null}
          {detail ? <RunDetail run={detail} labels={labels} /> : (!loading && !error ? <div className="agent-debug-card is-muted">{labels.noRoundsYet}</div> : null)}
        </div>
      ) : null}

      {node.children.length > 0 ? (
        <div className="agent-debug-run-children">
          {node.children.map((child) => (
            <RunNode key={child.run.runId} node={child} conversationId={conversationId} depth={depth + 1} labels={labels} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RunDetail({ run, labels }: { run: AgentDebugRun; labels: DebugLabels }) {
  return (
    <div className="agent-debug-run-detail">
      <div className="agent-debug-context-card">
        <ContextDisclosure title={labels.systemPromptDisclosure} copyText={run.systemPrompt ?? ''}>
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
      </div>

      {run.rounds.length === 0 ? (
        <div className="agent-debug-card is-muted">{labels.noRoundsYet}</div>
      ) : run.rounds.map((round) => (
        <RoundCard key={round.index} round={round} labels={labels} />
      ))}
    </div>
  );
}

function RoundCard({ round, labels }: { round: AgentDebugRound; labels: DebugLabels }) {
  return (
    <article className="agent-debug-round-card">
      <div className="agent-debug-section-header">
        <h3>{labels.roundTitle({ index: round.index + 1 })}</h3>
        <span className={`agent-debug-status-pill is-${round.status}`}>{statusLabel(round.status, labels)}</span>
        {round.modelId ? <code className="agent-debug-run-model">{round.modelId}</code> : null}
        {round.usage ? <CostInline usage={round.usage} /> : <span className="is-muted">{labels.usagePending}</span>}
      </div>

      {round.usage ? (
        <div className="agent-debug-round-usage">
          <span>{labels.usageTokens({ total: formatTokens(round.usage.totalTokens), input: formatTokens(round.usage.input), output: formatTokens(round.usage.output) })}</span>
          {round.stopReason ? <code>{round.stopReason}</code> : null}
        </div>
      ) : null}

      {round.requestWindow.length > 0 ? (
        <ContextDisclosure title={labels.requestWindowLabel({ count: round.requestWindow.length })}>
          <div className="agent-debug-message-list">
            {round.requestWindow.map((row) => <MessageRow key={row.id} message={row} labels={labels} />)}
          </div>
        </ContextDisclosure>
      ) : null}

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

function ToolExchangeRow({ exchange, labels }: { exchange: AgentDebugToolExchange; labels: DebugLabels }) {
  const resultBody = exchange.result ?? labels.toolPending;
  return (
    <details className={`agent-debug-tool-exchange${exchange.isError ? ' is-error' : ''}`}>
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <code>{exchange.toolName}</code>
        <strong>{truncate(exchange.result ?? (exchange.args || ''), 96)}</strong>
        {exchange.isError ? <span className="agent-debug-tool-flag">{labels.toolError}</span> : null}
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

function ContextDisclosure(props: { children: ReactNode; copyText?: string; title: string }) {
  const labels = useT().agentDebug;
  return (
    <details className="agent-debug-disclosure">
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
