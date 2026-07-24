import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Thread,
  ThreadItem,
  ThreadTurnsListResponse,
  ThreadUserContent,
  Turn,
} from '../../../core/agent/protocol';
import { api } from '../../api/client';
import { useI18n, useT } from '../../i18n/I18nProvider';
import { formatDateTime, formatNumber } from '../../ui/formatting';
import { ChevronDownIcon, ICON_SIZE, InfoIcon, LoaderIcon } from '../../ui/icons';
import { PanelStickyBreadcrumb } from '../../ui/PanelShared';
import { ReadOnlyCodeBlock } from '../../ui/editor/CodeBlockSurface';
import { EmptyState, ErrorState } from '../../ui/primitives/FeedbackState';
import { IconButton } from '../../ui/primitives/IconButton';
import {
  ThreadUsageBreakdown,
  formatCachedShare,
  formatUsageCost,
} from './ThreadUsageBreakdown';

interface ThreadDebugPanelProps {
  readonly onClose: () => void;
  readonly showClose: boolean;
  readonly threadId: string;
  readonly turnId: string;
}

interface ThreadDebugDetail {
  readonly thread: Thread;
  readonly turn: Turn;
}

export function ThreadDebugPanel({
  onClose,
  showClose,
  threadId,
  turnId,
}: ThreadDebugPanelProps) {
  const t = useT();
  const stickyBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const { detail, error, loading, refresh } = useThreadDebugDetail(threadId, turnId);
  return (
    <main className="main-panel agent-debug-panel">
      <PanelStickyBreadcrumb
        breadcrumbAriaLabel={t.nodePanel.breadcrumbAriaLabel}
        canGoBack={false}
        closeLabel={t.nodePanel.closePanel}
        currentTitle={t.agent.debug.title}
        origin={null}
        onBack={() => undefined}
        onClose={onClose}
        previousPageLabel={t.nodePanel.previousPage}
        showClose={showClose}
        stickyRef={stickyBreadcrumbRef}
        titleDocked={false}
      >
        <span className="panel-breadcrumb-segment panel-breadcrumb-current agent-debug-breadcrumb-title">
          <span className="panel-breadcrumb-current-label" data-current-page-title>
            {t.agent.debug.title}
          </span>
        </span>
      </PanelStickyBreadcrumb>
      <div className="panel-inner agent-debug-content">
        {loading && !detail ? (
          <EmptyState icon={LoaderIcon} loading role="status" title={t.agent.debug.loading} />
        ) : null}
        {error ? (
          <ErrorState
            message={error}
            onRetry={() => void refresh()}
            retryLabel={t.agent.debug.retry}
          />
        ) : null}
        {detail ? <ThreadDebugDetailView detail={detail} /> : null}
        {!loading && !error && !detail ? (
          <EmptyState className="agent-debug-empty" title={t.agent.debug.unavailable} />
        ) : null}
      </div>
    </main>
  );
}

function useThreadDebugDetail(threadId: string, turnId: string) {
  const t = useT();
  const [detail, setDetail] = useState<ThreadDebugDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const refresh = useCallback(async () => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setDetail(null);
    setError(null);
    setLoading(true);
    try {
      const [threadResponse, turn] = await Promise.all([
        api.agentCoreRequest('thread/read', { threadId }),
        readCanonicalTurn(threadId, turnId),
      ]);
      if (requestRef.current !== request) return;
      if (!turn) throw new Error(t.agent.debug.unavailable);
      setDetail({ thread: threadResponse.thread, turn });
    } catch (caught) {
      if (requestRef.current !== request) return;
      setError(caught instanceof Error && caught.message ? caught.message : t.agent.debug.unavailable);
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [t.agent.debug.unavailable, threadId, turnId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  return { detail, error, loading, refresh };
}

async function readCanonicalTurn(threadId: string, turnId: string): Promise<Turn | null> {
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const page: ThreadTurnsListResponse = await api.agentCoreRequest('thread/turns/list', {
      cursor,
      itemsView: 'full',
      limit: 100,
      sortDirection: 'desc',
      threadId,
    });
    const turn = page.data.find((candidate) => candidate.id === turnId);
    if (turn) return turn;
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) return null;
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return null;
}

function ThreadDebugDetailView({ detail }: { readonly detail: ThreadDebugDetail }) {
  const t = useT();
  const { thread, turn } = detail;
  const userInput = turn.items.flatMap((item): readonly ThreadUserContent[] => (
    item.type === 'userMessage' ? item.content : []
  ));
  return (
    <div className="agent-debug-run-detail">
      <DebugPanelSection title={t.agent.debug.summary}>
        <RunSummaryHeader turn={turn} />
      </DebugPanelSection>

      <DebugPanelSection title={t.agent.debug.modelInput}>
        <div className="agent-debug-context-card">
          <ContextDisclosure defaultOpen resetKey={turn.id} title={t.agent.debug.currentRequest}>
            {userInput.length > 0 ? (
              <ReadOnlyCodeBlock
                className="agent-debug-code-block agent-debug-inline-code-block"
                code={jsonText(userInput)}
                language="json"
              />
            ) : (
              <span className="is-muted">{t.agent.debug.noUserInput}</span>
            )}
          </ContextDisclosure>
          <ContextDisclosure resetKey={turn.id} title={t.agent.debug.canonicalContext}>
            <dl className="agent-debug-identity-list">
              <DebugIdentity label={t.agent.debug.threadId} value={thread.id} />
              <DebugIdentity label={t.agent.debug.turnId} value={turn.id} />
              <DebugIdentity label={t.agent.debug.sessionId} value={thread.sessionId} />
              <DebugIdentity label={t.agent.debug.originThreadId} value={turn.provenance.originThreadId} />
              <DebugIdentity label={t.agent.debug.originTurnId} value={turn.provenance.originTurnId} />
              <DebugIdentity label={t.agent.debug.trigger} value={jsonText(turn.provenance.trigger)} />
            </dl>
          </ContextDisclosure>
        </div>
      </DebugPanelSection>

      <DebugPanelSection
        className="agent-debug-execution-section"
        title={t.agent.debug.execution({ count: 1 })}
      >
        <TurnExecutionCard turn={turn} />
      </DebugPanelSection>
    </div>
  );
}

function RunSummaryHeader({ turn }: { readonly turn: Turn }) {
  const t = useT();
  const { locale } = useI18n();
  const usage = turn.execution.usage;
  const inputContext = usage.input + usage.cacheRead + usage.cacheWrite;
  const cachedShare = formatCachedShare(usage.input, usage.cacheRead, usage.cacheWrite);
  const tools = turn.items.filter(isToolItem);
  const timeRange = turn.completedAt
    ? `${formatTimestamp(turn.startedAt, locale)} - ${formatTimestamp(turn.completedAt, locale)}`
    : formatTimestamp(turn.startedAt, locale);
  return (
    <div className="agent-debug-run-summary">
      <dl className="agent-debug-run-summary-facts">
        {turn.status !== 'completed' ? (
          <div>
            <dt>{t.agent.thread.status}</dt>
            <dd>{t.agent.thread.item.status[turn.status]}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t.agent.message.model}</dt>
          <dd>{turn.execution.model}</dd>
          <small>{turn.execution.modelProvider}</small>
          <small>{t.agent.message.reasoningEffort}: {turn.execution.reasoningEffort}</small>
        </div>
        <div>
          <dt>{t.agent.debug.duration}</dt>
          <dd>{formatDuration(turn.durationMs)}</dd>
          <small>{timeRange}</small>
        </div>
        <div>
          <dt>{t.agent.debug.itemCount}</dt>
          <dd>{formatNumber(turn.items.length)}</dd>
          <small>{t.agent.debug.toolCount}: {formatNumber(tools.length)}</small>
        </div>
        <div>
          <dt>{t.agent.debug.inputContext}</dt>
          <dd>{formatCompactTokens(inputContext)}</dd>
          <small>{t.agent.message.cachedShare}: {cachedShare}</small>
          <small>{t.agent.debug.outputTokens}: {formatCompactTokens(usage.output)}</small>
        </div>
        <div>
          <dt>{t.agent.message.cost}</dt>
          <dd>{usage.cost ? formatUsageCost(usage.cost.total) : t.agent.message.usageUnavailable}</dd>
        </div>
      </dl>
    </div>
  );
}

function TurnExecutionCard({ turn }: { readonly turn: Turn }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  return (
    <details
      className="agent-debug-round-card"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="agent-debug-round-head">
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <span className="agent-debug-disclosure-title">{t.agent.debug.turnExecution}</span>
        {turn.status !== 'completed' ? (
          <span className={`agent-debug-status-pill is-${turn.status}`}>
            {t.agent.thread.item.status[turn.status]}
          </span>
        ) : null}
        <div
          className="agent-debug-usage-hover"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <IconButton
            className="agent-debug-usage-info-button"
            icon={InfoIcon}
            iconSize={ICON_SIZE.tiny}
            label={t.agent.debug.executionDetails}
            title={t.agent.debug.executionDetails}
            variant="panel"
          />
          <div
            aria-label={t.agent.debug.executionDetails}
            className="agent-debug-usage-popover"
            role="tooltip"
          >
            <ThreadUsageBreakdown usage={turn.execution.usage} />
          </div>
        </div>
      </summary>
      {open ? (
        <div className="agent-debug-execution-list">
          {turn.items.map((item) => <ExecutionItemRow item={item} key={item.id} />)}
        </div>
      ) : null}
    </details>
  );
}

function ExecutionItemRow({ item }: { readonly item: ThreadItem }) {
  const encoded = jsonText(item);
  return (
    <details className="agent-debug-part-details agent-debug-execution-event">
      <summary className="agent-debug-part-head agent-debug-message-head">
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <span className="agent-debug-role-label">{itemRole(item)}</span>
        <strong title={itemSummary(item)}>{itemSummary(item)}</strong>
        <code>{formatBytes(new TextEncoder().encode(encoded).byteLength)}</code>
      </summary>
      <ReadOnlyCodeBlock
        className="agent-debug-code-block"
        code={encoded}
        language="json"
      />
    </details>
  );
}

function DebugPanelSection({
  children,
  className,
  title,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly title: string;
}) {
  return (
    <section className={`agent-debug-detail-section${className ? ` ${className}` : ''}`}>
      <header className="agent-debug-section-header">
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  );
}

function ContextDisclosure({
  children,
  defaultOpen = false,
  resetKey,
  title,
}: {
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly resetKey: string;
  readonly title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen, resetKey]);
  return (
    <details
      className="agent-debug-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <ChevronDownIcon className="agent-debug-summary-chevron" size={ICON_SIZE.tiny} />
        <span className="agent-debug-disclosure-title">{title}</span>
      </summary>
      <div className="agent-debug-disclosure-body">{children}</div>
    </details>
  );
}

function DebugIdentity({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><code>{value}</code></dd>
    </div>
  );
}

function isToolItem(item: ThreadItem): boolean {
  return item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch';
}

function itemRole(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage': return 'user';
    case 'agentMessage': return 'asst';
    case 'plan': return 'plan';
    case 'reasoning': return 'think';
    case 'commandExecution':
    case 'fileChange': return 'call';
    case 'mcpToolCall': return 'mcp';
    case 'dynamicToolCall': return 'tool';
    case 'collabAgentToolCall': return 'collab';
    case 'subAgentActivity': return 'agent';
    case 'webSearch': return 'search';
    case 'imageView': return 'image';
    case 'contextCompaction': return 'system';
  }
}

function itemSummary(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage':
      return item.content.flatMap((content) => (
        content.type === 'text' ? [content.text] : content.type === 'attachment' ? [content.name] : [content.note ?? content.nodeId]
      )).join(' ') || item.type;
    case 'agentMessage': return item.text || item.type;
    case 'plan': return item.text || item.type;
    case 'reasoning': return [...item.summary, ...item.content].find(Boolean) ?? item.type;
    case 'commandExecution': return item.command;
    case 'fileChange': return item.changes.map((change) => change.path).join(', ') || item.type;
    case 'mcpToolCall': return `${item.server}.${item.tool}`;
    case 'dynamicToolCall': return [item.namespace, item.tool].filter(Boolean).join('.');
    case 'collabAgentToolCall': return item.tool;
    case 'subAgentActivity': return item.agentPath;
    case 'webSearch': return item.query;
    case 'imageView': return item.path;
    case 'contextCompaction': return item.type;
  }
}

function formatTimestamp(timestamp: number, locale: string): string {
  return formatDateTime(timestamp, locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs)) return '-';
  const seconds = Math.max(0, durationMs) / 1_000;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens < 1_000) return formatNumber(tokens);
  return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
