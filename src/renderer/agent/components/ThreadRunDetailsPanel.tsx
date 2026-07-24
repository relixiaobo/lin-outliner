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

interface ThreadRunDetailsPanelProps {
  readonly onClose: () => void;
  readonly showClose: boolean;
  readonly threadId: string;
  readonly turnId: string;
}

interface ThreadRunDetailsData {
  readonly thread: Thread;
  readonly turn: Turn;
}

export function ThreadRunDetailsPanel({
  onClose,
  showClose,
  threadId,
  turnId,
}: ThreadRunDetailsPanelProps) {
  const t = useT();
  const stickyBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const { detail, error, loading, refresh } = useThreadRunDetails(threadId, turnId);
  return (
    <main className="main-panel thread-run-details-panel">
      <PanelStickyBreadcrumb
        breadcrumbAriaLabel={t.nodePanel.breadcrumbAriaLabel}
        canGoBack={false}
        closeLabel={t.nodePanel.closePanel}
        currentTitle={t.agent.runDetails.title}
        origin={null}
        onBack={() => undefined}
        onClose={onClose}
        previousPageLabel={t.nodePanel.previousPage}
        showClose={showClose}
        stickyRef={stickyBreadcrumbRef}
        titleDocked={false}
      >
        <span className="panel-breadcrumb-segment panel-breadcrumb-current thread-run-details-breadcrumb-title">
          <span className="panel-breadcrumb-current-label" data-current-page-title>
            {t.agent.runDetails.title}
          </span>
        </span>
      </PanelStickyBreadcrumb>
      <div className="panel-inner thread-run-details-content">
        {loading && !detail ? (
          <EmptyState icon={LoaderIcon} loading role="status" title={t.agent.runDetails.loading} />
        ) : null}
        {error ? (
          <ErrorState
            message={error}
            onRetry={() => void refresh()}
            retryLabel={t.agent.runDetails.retry}
          />
        ) : null}
        {detail ? <ThreadRunDetailsView detail={detail} /> : null}
        {!loading && !error && !detail ? (
          <EmptyState className="thread-run-details-empty" title={t.agent.runDetails.unavailable} />
        ) : null}
      </div>
    </main>
  );
}

function useThreadRunDetails(threadId: string, turnId: string) {
  const t = useT();
  const [detail, setDetail] = useState<ThreadRunDetailsData | null>(null);
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
      if (!turn) throw new Error(t.agent.runDetails.unavailable);
      setDetail({ thread: threadResponse.thread, turn });
    } catch (caught) {
      if (requestRef.current !== request) return;
      setError(caught instanceof Error && caught.message ? caught.message : t.agent.runDetails.unavailable);
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [t.agent.runDetails.unavailable, threadId, turnId]);

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

function ThreadRunDetailsView({ detail }: { readonly detail: ThreadRunDetailsData }) {
  const t = useT();
  const { thread, turn } = detail;
  const userInput = turn.items.flatMap((item): readonly ThreadUserContent[] => (
    item.type === 'userMessage' ? item.content : []
  ));
  return (
    <div className="thread-run-details-body">
      <RunDetailsSection title={t.agent.runDetails.summary}>
        <RunSummaryHeader turn={turn} />
      </RunDetailsSection>

      <RunDetailsSection title={t.agent.runDetails.modelInput}>
        <div className="thread-run-details-context-card">
          <ContextDisclosure defaultOpen resetKey={turn.id} title={t.agent.runDetails.currentRequest}>
            {userInput.length > 0 ? (
              <ReadOnlyCodeBlock
                className="thread-run-details-code-block thread-run-details-inline-code-block"
                code={jsonText(userInput)}
                language="json"
              />
            ) : (
              <span className="is-muted">{t.agent.runDetails.noUserInput}</span>
            )}
          </ContextDisclosure>
          <ContextDisclosure resetKey={turn.id} title={t.agent.runDetails.canonicalContext}>
            <dl className="thread-run-details-identity-list">
              <RunDetailsIdentity label={t.agent.runDetails.threadId} value={thread.id} />
              <RunDetailsIdentity label={t.agent.runDetails.turnId} value={turn.id} />
              <RunDetailsIdentity label={t.agent.runDetails.sessionId} value={thread.sessionId} />
              <RunDetailsIdentity label={t.agent.runDetails.originThreadId} value={turn.provenance.originThreadId} />
              <RunDetailsIdentity label={t.agent.runDetails.originTurnId} value={turn.provenance.originTurnId} />
              <RunDetailsIdentity label={t.agent.runDetails.trigger} value={jsonText(turn.provenance.trigger)} />
            </dl>
          </ContextDisclosure>
        </div>
      </RunDetailsSection>

      <RunDetailsSection
        className="thread-run-details-execution-section"
        title={t.agent.runDetails.execution({ count: 1 })}
      >
        <TurnExecutionCard turn={turn} />
      </RunDetailsSection>
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
    <div className="thread-run-details-run-summary">
      <dl className="thread-run-details-run-summary-facts">
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
          <dt>{t.agent.runDetails.duration}</dt>
          <dd>{formatDuration(turn.durationMs)}</dd>
          <small>{timeRange}</small>
        </div>
        <div>
          <dt>{t.agent.runDetails.itemCount}</dt>
          <dd>{formatNumber(turn.items.length)}</dd>
          <small>{t.agent.runDetails.toolCount}: {formatNumber(tools.length)}</small>
        </div>
        <div>
          <dt>{t.agent.runDetails.inputContext}</dt>
          <dd>{formatCompactTokens(inputContext)}</dd>
          <small>{t.agent.message.cachedShare}: {cachedShare}</small>
          <small>{t.agent.runDetails.outputTokens}: {formatCompactTokens(usage.output)}</small>
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
      className="thread-run-details-execution-card"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="thread-run-details-execution-head">
        <ChevronDownIcon className="thread-run-details-summary-chevron" size={ICON_SIZE.tiny} />
        <span className="thread-run-details-disclosure-title">{t.agent.runDetails.turnExecution}</span>
        {turn.status !== 'completed' ? (
          <span className={`thread-run-details-status-pill is-${turn.status}`}>
            {t.agent.thread.item.status[turn.status]}
          </span>
        ) : null}
        <div
          className="thread-run-details-usage-hover"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <IconButton
            className="thread-run-details-usage-info-button"
            icon={InfoIcon}
            iconSize={ICON_SIZE.tiny}
            label={t.agent.runDetails.executionDetails}
            title={t.agent.runDetails.executionDetails}
            variant="panel"
          />
          <div
            aria-label={t.agent.runDetails.executionDetails}
            className="thread-run-details-usage-popover"
            role="tooltip"
          >
            <ThreadUsageBreakdown usage={turn.execution.usage} />
          </div>
        </div>
      </summary>
      {open ? (
        <div className="thread-run-details-execution-list">
          {turn.items.map((item) => <ExecutionItemRow item={item} key={item.id} />)}
        </div>
      ) : null}
    </details>
  );
}

function ExecutionItemRow({ item }: { readonly item: ThreadItem }) {
  const encoded = jsonText(item);
  return (
    <details className="thread-run-details-part-details thread-run-details-execution-event">
      <summary className="thread-run-details-part-head thread-run-details-message-head">
        <ChevronDownIcon className="thread-run-details-summary-chevron" size={ICON_SIZE.tiny} />
        <span className="thread-run-details-role-label">{itemRole(item)}</span>
        <strong title={itemSummary(item)}>{itemSummary(item)}</strong>
        <code>{formatBytes(new TextEncoder().encode(encoded).byteLength)}</code>
      </summary>
      <ReadOnlyCodeBlock
        className="thread-run-details-code-block"
        code={encoded}
        language="json"
      />
    </details>
  );
}

function RunDetailsSection({
  children,
  className,
  title,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly title: string;
}) {
  return (
    <section className={`thread-run-details-detail-section${className ? ` ${className}` : ''}`}>
      <header className="thread-run-details-section-header">
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
      className="thread-run-details-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <ChevronDownIcon className="thread-run-details-summary-chevron" size={ICON_SIZE.tiny} />
        <span className="thread-run-details-disclosure-title">{title}</span>
      </summary>
      <div className="thread-run-details-disclosure-body">{children}</div>
    </details>
  );
}

function RunDetailsIdentity({ label, value }: { readonly label: string; readonly value: string }) {
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
