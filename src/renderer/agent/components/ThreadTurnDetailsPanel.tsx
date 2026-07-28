import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  JsonValue,
  ThreadItem,
  ThreadTurnDetailsReadResponse,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsProviderCall,
} from '../../../core/agent/protocol';
import { api } from '../../api/client';
import { useI18n, useT } from '../../i18n/I18nProvider';
import { formatDateTime, formatNumber } from '../../ui/formatting';
import { ChevronDownIcon, ICON_SIZE, InfoIcon, LoaderIcon } from '../../ui/icons';
import { PanelStickyBreadcrumb } from '../../ui/PanelShared';
import { ReadOnlyCodeBlock } from '../../ui/editor/CodeBlockSurface';
import { Button } from '../../ui/primitives/Button';
import { EmptyState, ErrorState } from '../../ui/primitives/FeedbackState';
import { IconButton } from '../../ui/primitives/IconButton';
import {
  ThreadUsageBreakdown,
  formatCachedShare,
  formatUsageCost,
} from './ThreadUsageBreakdown';

interface ThreadTurnDetailsPanelProps {
  readonly canGoBack: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly showClose: boolean;
  readonly threadId: string;
  readonly turnId: string;
}

export function ThreadTurnDetailsPanel({
  canGoBack,
  onBack,
  onClose,
  showClose,
  threadId,
  turnId,
}: ThreadTurnDetailsPanelProps) {
  const t = useT();
  const stickyBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const { detail, error, loading, refresh } = useThreadTurnDetails(threadId, turnId);
  return (
    <main className="main-panel thread-turn-details-panel">
      <PanelStickyBreadcrumb
        breadcrumbAriaLabel={t.nodePanel.breadcrumbAriaLabel}
        canGoBack={canGoBack}
        closeLabel={t.nodePanel.closePanel}
        currentTitle={t.agent.turnDetails.title}
        origin={null}
        onBack={onBack}
        onClose={onClose}
        previousPageLabel={t.nodePanel.previousPage}
        showClose={showClose}
        stickyRef={stickyBreadcrumbRef}
        titleDocked={false}
      >
        <span className="panel-breadcrumb-segment panel-breadcrumb-current thread-turn-details-breadcrumb-title">
          <span className="panel-breadcrumb-current-label" data-current-page-title>
            {t.agent.turnDetails.title}
          </span>
        </span>
      </PanelStickyBreadcrumb>
      <div className="panel-inner thread-turn-details-content">
        {loading && !detail ? (
          <EmptyState icon={LoaderIcon} loading role="status" title={t.agent.turnDetails.loading} />
        ) : null}
        {error ? (
          <ErrorState
            message={error}
            onRetry={() => void refresh()}
            retryLabel={t.agent.turnDetails.retry}
          />
        ) : null}
        {detail ? <ThreadTurnDetailsView detail={detail} /> : null}
        {!loading && !error && !detail ? (
          <EmptyState className="thread-turn-details-empty" title={t.agent.turnDetails.unavailable} />
        ) : null}
      </div>
    </main>
  );
}

function useThreadTurnDetails(threadId: string, turnId: string) {
  const t = useT();
  const [detail, setDetail] = useState<ThreadTurnDetailsReadResponse | null>(null);
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
      const response = await api.agentCoreRequest('thread/turn/details/read', { threadId, turnId });
      if (requestRef.current === request) setDetail(response);
    } catch (caught) {
      if (requestRef.current === request) {
        setError(caught instanceof Error && caught.message ? caught.message : t.agent.turnDetails.unavailable);
      }
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [t.agent.turnDetails.unavailable, threadId, turnId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  return { detail, error, loading, refresh };
}

function ThreadTurnDetailsView({ detail }: { readonly detail: ThreadTurnDetailsReadResponse }) {
  const t = useT();
  const { diagnostics, thread, turn } = detail;
  return (
    <div className="thread-turn-details-body">
      <TurnDetailsSection title={t.agent.turnDetails.overview}>
        <TurnOverview turn={turn} />
      </TurnDetailsSection>
      <TurnDetailsSection title={t.agent.turnDetails.requestConstruction}>
        <RequestConstruction detail={detail} />
      </TurnDetailsSection>
      <TurnDetailsSection title={t.agent.turnDetails.providerCalls({
        count: diagnostics?.payload.providerCalls.length ?? 0,
      })}>
        {diagnostics ? (
          <ProviderCallList payload={diagnostics.payload} />
        ) : (
          <p className="thread-turn-details-notice">{t.agent.turnDetails.diagnosticsUnavailable}</p>
        )}
      </TurnDetailsSection>
      <TurnDetailsSection title={t.agent.turnDetails.canonicalItems({ count: turn.items.length })}>
        <div className="thread-turn-details-item-list">
          {turn.items.map((item) => (
            <CanonicalItemRow
              item={item}
              key={`${turn.id}:${item.id}`}
              threadId={thread.id}
              turnId={turn.id}
            />
          ))}
        </div>
      </TurnDetailsSection>
    </div>
  );
}

function TurnOverview({ turn }: { readonly turn: Turn }) {
  const t = useT();
  const { locale } = useI18n();
  const usage = turn.execution.usage;
  const cachedShare = formatCachedShare(usage.input, usage.cacheRead, usage.cacheWrite);
  const toolCount = turn.items.filter(isToolItem).length;
  const timeRange = turn.completedAt
    ? `${formatTimestamp(turn.startedAt, locale)} - ${formatTimestamp(turn.completedAt, locale)}`
    : formatTimestamp(turn.startedAt, locale);
  return (
    <div className="thread-turn-details-overview">
      <dl className="thread-turn-details-fact-grid">
        <div>
          <dt>{t.agent.thread.status}</dt>
          <dd>{t.agent.thread.item.status[turn.status]}</dd>
        </div>
        <div>
          <dt>{t.agent.message.model}</dt>
          <dd>{turn.execution.model}</dd>
          <small>{turn.execution.modelProvider}</small>
          <small>{t.agent.message.reasoningEffort}: {turn.execution.reasoningEffort}</small>
        </div>
        <div>
          <dt>{t.agent.turnDetails.duration}</dt>
          <dd>{formatDuration(turn.durationMs)}</dd>
          <small>{timeRange}</small>
        </div>
        <div>
          <dt>{t.agent.turnDetails.itemCount}</dt>
          <dd>{formatNumber(turn.items.length)}</dd>
          <small>{t.agent.turnDetails.toolCount}: {formatNumber(toolCount)}</small>
        </div>
        <div>
          <dt>{t.agent.turnDetails.inputTokens}</dt>
          <dd>{formatCompactTokens(usage.input)}</dd>
          <small>{t.agent.message.cachedShare}: {cachedShare}</small>
          <small>
            {t.agent.turnDetails.cacheRead}: {formatCompactTokens(usage.cacheRead)}
            {' · '}
            {t.agent.turnDetails.cacheWrite}: {formatCompactTokens(usage.cacheWrite)}
          </small>
        </div>
        <div>
          <dt>{t.agent.turnDetails.outputTokens}</dt>
          <dd>{formatCompactTokens(usage.output)}</dd>
          <small>{t.agent.message.cost}: {usage.cost ? formatUsageCost(usage.cost.total) : t.agent.message.usageUnavailable}</small>
        </div>
      </dl>
      {turn.error ? (
        <dl aria-label={t.agent.turnDetails.turnError} className="thread-turn-details-identity-list">
          <Fact label={t.agent.turnDetails.turnError} value={turn.error.message} />
          {turn.error.code ? <Identity label={t.agent.turnDetails.errorCode} value={turn.error.code} /> : null}
          {turn.error.detail ? <Fact label={t.agent.turnDetails.errorDetail} value={turn.error.detail} /> : null}
        </dl>
      ) : null}
      <UsagePopover usage={usage} />
    </div>
  );
}

function UsagePopover({ usage }: { readonly usage: Turn['execution']['usage'] }) {
  const t = useT();
  return (
    <div className="thread-turn-details-usage-hover">
      <IconButton
        className="thread-turn-details-usage-info-button"
        icon={InfoIcon}
        iconSize={ICON_SIZE.tiny}
        label={t.agent.turnDetails.usageDetails}
        title={t.agent.turnDetails.usageDetails}
        variant="panel"
      />
      <div
        aria-label={t.agent.turnDetails.usageDetails}
        className="thread-turn-details-usage-popover"
        role="tooltip"
      >
        <ThreadUsageBreakdown usage={usage} />
      </div>
    </div>
  );
}

function RequestConstruction({ detail }: { readonly detail: ThreadTurnDetailsReadResponse }) {
  const t = useT();
  const { diagnostics, thread, turn } = detail;
  const userItems = turn.items.filter((item) => item.type === 'userMessage');
  return (
    <div className="thread-turn-details-disclosure-stack">
      <JsonDisclosure
        defaultOpen
        resetKey={turn.id}
        title={t.agent.turnDetails.acceptedUserInput}
        value={userItems.map((item) => ({
          itemId: item.id,
          acceptedAt: item.acceptedAt,
          content: item.content,
        }))}
      />
      <LazyDisclosure resetKey={turn.id} title={t.agent.turnDetails.requestIdentity} render={() => (
        <dl className="thread-turn-details-identity-list">
          <Identity label={t.agent.turnDetails.threadId} value={thread.id} />
          <Identity label={t.agent.turnDetails.turnId} value={turn.id} />
          <Identity label={t.agent.turnDetails.sessionId} value={thread.sessionId} />
          {diagnostics ? <Identity label={t.agent.turnDetails.contextEpoch} value={diagnostics.payload.contextEpochId} /> : null}
          {diagnostics ? <Identity label={t.agent.turnDetails.cacheAffinity} value={diagnostics.payload.cacheAffinity} /> : null}
          <Identity label={t.agent.turnDetails.originThreadId} value={turn.provenance.originThreadId} />
          <Identity label={t.agent.turnDetails.originTurnId} value={turn.provenance.originTurnId} />
          <Identity label={t.agent.turnDetails.trigger} value={jsonText(turn.provenance.trigger)} />
          {diagnostics ? <Identity label={t.agent.turnDetails.diagnosticsDigest} value={diagnostics.ref.id} /> : null}
        </dl>
      )} />
      {diagnostics ? <DiagnosticsConstruction payload={diagnostics.payload} resetKey={turn.id} /> : (
        <p className="thread-turn-details-notice">{t.agent.turnDetails.diagnosticsUnavailable}</p>
      )}
    </div>
  );
}

function DiagnosticsConstruction({
  payload,
  resetKey,
}: {
  readonly payload: TurnDiagnosticsPayload;
  readonly resetKey: string;
}) {
  const t = useT();
  return (
    <>
      <JsonDisclosure
        resetKey={resetKey}
        title={t.agent.turnDetails.effectiveConfiguration}
        value={payload.configuration}
      />
      <LazyDisclosure resetKey={resetKey} title={t.agent.turnDetails.stablePrompt} render={() => (
        payload.stablePrompt ? (
          <div className="thread-turn-details-nested-list">
            {payload.stablePrompt.blocks.map((block) => (
              <TextDisclosure
                key={`${block.layer}:${block.id}`}
                metadata={block.fingerprint}
                resetKey={resetKey}
                text={block.text}
                title={t.agent.turnDetails.promptBlock({ layer: block.layer, id: block.id })}
              />
            ))}
            <JsonDisclosure
              resetKey={resetKey}
              title={t.agent.turnDetails.stablePromptFingerprints}
              value={payload.stablePrompt.fingerprints}
            />
          </div>
        ) : <p className="thread-turn-details-notice">{t.agent.turnDetails.diagnosticsUnavailable}</p>
      )} />
      <LazyDisclosure
        resetKey={resetKey}
        title={t.agent.turnDetails.toolSchemas({ count: payload.toolSchemas.length })}
        render={() => (
          <div className="thread-turn-details-nested-list">
            {payload.toolSchemas.map((tool) => (
              <JsonDisclosure key={tool.name} resetKey={resetKey} title={tool.name} value={tool} />
            ))}
          </div>
        )}
      />
      <JsonDisclosure
        resetKey={resetKey}
        title={t.agent.turnDetails.runtimeSettings}
        value={payload.runtime}
      />
    </>
  );
}

function ProviderCallList({ payload }: { readonly payload: TurnDiagnosticsPayload }) {
  const t = useT();
  const messagesById = useMemo(
    () => new Map(payload.messages.map((message) => [message.id, message])),
    [payload.messages],
  );
  if (payload.providerCalls.length === 0) {
    return <p className="thread-turn-details-notice">{t.agent.turnDetails.noProviderCalls}</p>;
  }
  return (
    <div className="thread-turn-details-call-list">
      {payload.providerCalls.map((call) => (
        <ProviderCallCard
          call={call}
          defaultOpen={call.index === 0}
          key={call.index}
          messagesById={messagesById}
        />
      ))}
    </div>
  );
}

function ProviderCallCard({
  call,
  defaultOpen,
  messagesById,
}: {
  readonly call: TurnDiagnosticsProviderCall;
  readonly defaultOpen: boolean;
  readonly messagesById: ReadonlyMap<string, TurnDiagnosticsPayload['messages'][number]>;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  const status = call.response ? providerCallStatus(call.response.stopReason) : null;
  return (
    <details
      className="thread-turn-details-call"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="thread-turn-details-call-head">
        <ChevronDownIcon className="thread-turn-details-summary-chevron" size={ICON_SIZE.tiny} />
        <strong>{t.agent.turnDetails.providerCall({ index: call.index + 1 })}</strong>
        <span>{t.agent.turnDetails.inputTokenSummary({ count: formatNumber(call.estimatedInputTokens) })}</span>
        <span>{status ? t.agent.thread.item.status[status] : t.agent.turnDetails.noAssistantResponse}</span>
      </summary>
      {open ? (
        <div className="thread-turn-details-call-body">
          <dl className="thread-turn-details-fact-grid is-compact">
            <Fact label={t.agent.turnDetails.requestedAt} value={formatTimestamp(call.requestedAt, locale)} />
            <Fact
              label={t.agent.turnDetails.headersReceivedAt}
              value={call.transportResponse
                ? formatTimestamp(call.transportResponse.headersReceivedAt, locale)
                : '-'}
            />
            <Fact
              label={t.agent.turnDetails.timeToHeaders}
              value={call.transportResponse
                ? formatDuration(call.transportResponse.headersReceivedAt - call.requestedAt)
                : '-'}
            />
            <Fact
              label={t.agent.turnDetails.assistantResponseCompletedAt}
              value={call.response ? formatTimestamp(call.response.receivedAt, locale) : '-'}
            />
            <Fact
              label={t.agent.turnDetails.totalCallDuration}
              value={call.response ? formatDuration(call.response.receivedAt - call.requestedAt) : '-'}
            />
            <Fact
              label={t.agent.turnDetails.httpStatus}
              value={call.transportResponse ? String(call.transportResponse.httpStatus) : '-'}
            />
            {call.response ? (
              <>
                <Fact label={t.agent.turnDetails.stopReason} value={call.response.stopReason} />
                <Fact label={t.agent.turnDetails.reportedInputTokens} value={formatNumber(call.response.usage.input)} />
                <Fact label={t.agent.turnDetails.reportedOutputTokens} value={formatNumber(call.response.usage.output)} />
                <Fact label={t.agent.turnDetails.reportedCacheRead} value={formatNumber(call.response.usage.cacheRead)} />
                <Fact label={t.agent.turnDetails.reportedCacheWrite} value={formatNumber(call.response.usage.cacheWrite)} />
                {call.response.usage.cacheWrite1h === null ? null : (
                  <Fact
                    label={t.agent.turnDetails.reportedCacheWrite1h}
                    value={formatNumber(call.response.usage.cacheWrite1h)}
                  />
                )}
                {call.response.usage.reasoning === null ? null : (
                  <Fact
                    label={t.agent.turnDetails.reportedReasoningTokens}
                    value={formatNumber(call.response.usage.reasoning)}
                  />
                )}
                <Fact label={t.agent.turnDetails.reportedTotalTokens} value={formatNumber(call.response.usage.totalTokens)} />
                <Fact label={t.agent.turnDetails.calculatedCost} value={formatUsageCost(call.response.usage.cost.total)} />
                {call.response.errorMessage ? (
                  <Fact label={t.agent.turnDetails.providerError} value={call.response.errorMessage} />
                ) : null}
              </>
            ) : null}
            <Fact label={t.agent.turnDetails.estimatedInputTokens} value={formatNumber(call.estimatedInputTokens)} />
            <Fact label={t.agent.turnDetails.inputTokenLimit} value={formatNumber(call.inputTokenLimit)} />
            <Fact label={t.agent.turnDetails.reservedOutputTokens} value={formatNumber(call.reservedOutputTokens)} />
            <Fact label={t.agent.turnDetails.protectedBoundary} value={formatNumber(call.protectedFromMessageIndex)} />
            <Fact label={t.agent.turnDetails.commonPrefixMessages} value={formatNumber(call.commonPrefixMessageCount)} />
          </dl>
          <dl className="thread-turn-details-identity-list">
            <Identity label={t.agent.turnDetails.requestFingerprint} value={call.requestFingerprint} />
            <Identity
              label={t.agent.turnDetails.requestId}
              value={call.transportResponse?.requestId ?? '-'}
            />
            <Identity
              label={t.agent.turnDetails.cacheBreakpoints}
              value={call.cacheBreakpoints.length > 0 ? jsonText(call.cacheBreakpoints) : '-'}
            />
          </dl>
          <JsonDisclosure
            resetKey={String(call.index)}
            title={t.agent.turnDetails.requestParameters}
            value={call.requestParameters}
          />
          <LazyDisclosure
            resetKey={String(call.index)}
            title={t.agent.turnDetails.messageWindow({ count: call.messageIds.length })}
            render={() => (
              <div className="thread-turn-details-nested-list">
                {call.messageIds.map((messageId, index) => {
                  const message = messagesById.get(messageId);
                  return message ? (
                    <JsonDisclosure
                      key={`${index}:${messageId}`}
                      metadata={`${formatNumber(message.estimatedTokens)} tokens · ${messageId}`}
                      resetKey={String(call.index)}
                      title={`${index + 1}. ${messageRole(message.value)}`}
                      value={message.value}
                    />
                  ) : null;
                })}
              </div>
            )}
          />
          {call.response ? (
            <JsonDisclosure
              resetKey={String(call.index)}
              title={t.agent.turnDetails.assistantResponse}
              value={call.response.value}
            />
          ) : <p className="thread-turn-details-notice">{t.agent.turnDetails.noAssistantResponse}</p>}
        </div>
      ) : null}
    </details>
  );
}

function CanonicalItemRow({
  item,
  threadId,
  turnId,
}: {
  readonly item: ThreadItem;
  readonly threadId: string;
  readonly turnId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [contextPayload, setContextPayload] = useState<unknown | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    requestRef.current += 1;
    setOpen(false);
    setContextPayload(null);
    setContextLoading(false);
    setContextError(null);
  }, [item.id, threadId, turnId]);

  const loadContext = useCallback(async () => {
    if (item.type !== 'contextEvidence' || contextLoading || contextPayload !== null) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setContextLoading(true);
    setContextError(null);
    try {
      const response = await api.agentCoreRequest('thread/context/read', {
        threadId,
        turnId,
        itemId: item.id,
        contextId: item.payloadRef.id,
      });
      if (!response.context) throw new Error(t.agent.turnDetails.contextUnavailable);
      if (requestRef.current === request) setContextPayload(response.context.payload);
    } catch (caught) {
      if (requestRef.current === request) {
        setContextError(caught instanceof Error && caught.message
          ? caught.message
          : t.agent.turnDetails.contextUnavailable);
      }
    } finally {
      if (requestRef.current === request) setContextLoading(false);
    }
  }, [contextLoading, contextPayload, item, t.agent.turnDetails.contextUnavailable, threadId, turnId]);

  return (
    <details
      className="thread-turn-details-item"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) void loadContext();
      }}
      open={open}
    >
      <summary className="thread-turn-details-row-head">
        <ChevronDownIcon className="thread-turn-details-summary-chevron" size={ICON_SIZE.tiny} />
        <code>{item.type}</code>
        <strong title={itemSummary(item)}>{itemSummary(item)}</strong>
        <code>{item.id}</code>
      </summary>
      {open ? (
        <div className="thread-turn-details-row-body">
          <JsonCode value={item} />
          {item.type === 'contextEvidence' ? (
            <div className="thread-turn-details-context-payload">
              {contextLoading ? <span className="is-muted">{t.agent.turnDetails.loadingContext}</span> : null}
              {contextError ? (
                <div className="thread-turn-details-context-error">
                  <span>{contextError}</span>
                  <Button onClick={() => void loadContext()} size="sm" variant="ghost">
                    {t.agent.turnDetails.retry}
                  </Button>
                </div>
              ) : null}
              {contextPayload ? <JsonCode value={contextPayload} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function TurnDetailsSection({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <section className="thread-turn-details-section">
      <header className="thread-turn-details-section-header"><h3>{title}</h3></header>
      {children}
    </section>
  );
}

function LazyDisclosure({
  defaultOpen = false,
  metadata,
  render,
  resetKey,
  title,
}: {
  readonly defaultOpen?: boolean;
  readonly metadata?: string;
  readonly render: () => ReactNode;
  readonly resetKey: string;
  readonly title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen, resetKey]);
  return (
    <details
      className="thread-turn-details-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <ChevronDownIcon className="thread-turn-details-summary-chevron" size={ICON_SIZE.tiny} />
        <span>{title}</span>
        {metadata ? <code>{metadata}</code> : null}
      </summary>
      {open ? <div className="thread-turn-details-disclosure-body">{render()}</div> : null}
    </details>
  );
}

function JsonDisclosure({
  defaultOpen,
  metadata,
  resetKey,
  title,
  value,
}: {
  readonly defaultOpen?: boolean;
  readonly metadata?: string;
  readonly resetKey: string;
  readonly title: string;
  readonly value: unknown;
}) {
  return (
    <LazyDisclosure
      defaultOpen={defaultOpen}
      metadata={metadata}
      render={() => <JsonCode value={value} />}
      resetKey={resetKey}
      title={title}
    />
  );
}

function TextDisclosure({
  metadata,
  resetKey,
  text,
  title,
}: {
  readonly metadata: string;
  readonly resetKey: string;
  readonly text: string;
  readonly title: string;
}) {
  return (
    <LazyDisclosure
      metadata={metadata}
      render={() => <ReadOnlyCodeBlock className="thread-turn-details-code-block" code={text} language="markdown" />}
      resetKey={resetKey}
      title={title}
    />
  );
}

function JsonCode({ value }: { readonly value: unknown }) {
  return (
    <ReadOnlyCodeBlock
      className="thread-turn-details-code-block"
      code={jsonText(value)}
      language="json"
    />
  );
}

function Identity({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd><code>{value}</code></dd></div>;
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function isToolItem(item: ThreadItem): boolean {
  return item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch';
}

function itemSummary(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage':
      return item.content.flatMap((content) => (
        content.type === 'text' ? [content.text] : content.type === 'attachment' ? [content.name] : [content.note ?? content.nodeId]
      )).join(' ') || item.type;
    case 'agentMessage': return item.text || item.type;
    case 'reasoning': return [...item.summary, ...item.content].find(Boolean) ?? item.type;
    case 'commandExecution': return item.command;
    case 'fileChange': return item.changes.map((change) => change.path).join(', ') || item.type;
    case 'mcpToolCall': return `${item.server}.${item.tool}`;
    case 'dynamicToolCall': return [item.namespace, item.tool].filter(Boolean).join('.');
    case 'collabAgentToolCall': return item.tool;
    case 'subAgentActivity': return item.agentPath;
    case 'webSearch': return item.query;
    case 'imageView': return item.path;
    case 'contextEvidence': return item.summary;
    case 'contextReset': return item.type;
    case 'contextCompaction': return item.type;
  }
}

function messageRole(value: JsonValue): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'message';
  const role = (value as Readonly<Record<string, JsonValue>>).role;
  return typeof role === 'string' ? role : 'message';
}

function providerCallStatus(
  stopReason: NonNullable<TurnDiagnosticsProviderCall['response']>['stopReason'],
): Extract<Turn['status'], 'completed' | 'failed' | 'interrupted'> {
  if (stopReason === 'error') return 'failed';
  if (stopReason === 'aborted') return 'interrupted';
  return 'completed';
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

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
