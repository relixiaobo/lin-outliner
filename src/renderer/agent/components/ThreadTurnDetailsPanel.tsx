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
  ThreadItemOutputReference,
  ThreadTurnDetailsReadResponse,
  Turn,
  TurnDiagnosticsPayload,
  TurnDiagnosticsMessagePartProvenance,
  TurnDiagnosticsProviderCall,
  TurnDiagnosticsProviderRequest,
  TurnDiagnosticsProviderRequestField,
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

type TurnDetailsLabels = ReturnType<typeof useT>['agent']['turnDetails'];
type JsonRecord = Readonly<Record<string, JsonValue>>;

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
  const callCount = detail.diagnostics?.payload.providerCalls.length ?? 0;
  return (
    <div className="thread-turn-details-body">
      <TurnDetailsSection title={t.agent.turnDetails.overview}>
        <TurnOverview turn={detail.turn} />
      </TurnDetailsSection>
      <TurnDetailsSection title={t.agent.turnDetails.requestsAndResults({ count: callCount })}>
        {detail.diagnostics ? (
          <RequestResultSequence
            payload={detail.diagnostics.payload}
            threadId={detail.thread.id}
            turn={detail.turn}
          />
        ) : (
          <p className="thread-turn-details-notice">{t.agent.turnDetails.diagnosticsUnavailable}</p>
        )}
      </TurnDetailsSection>
      <TurnDetailsSection title={t.agent.turnDetails.turnRecord}>
        <TurnRecord detail={detail} />
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
        <Fact label={t.agent.thread.status} value={t.agent.thread.item.status[turn.status]} />
        <div className="thread-turn-details-model-fact">
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
          <small>
            {t.agent.message.cost}: {usage.cost
              ? formatUsageCost(usage.cost.total)
              : t.agent.message.usageUnavailable}
          </small>
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

function RequestResultSequence({
  payload,
  threadId,
  turn,
}: {
  readonly payload: TurnDiagnosticsPayload;
  readonly threadId: string;
  readonly turn: Turn;
}) {
  const t = useT();
  const fragmentsById = useMemo(
    () => new Map(payload.requestFragments.map((fragment) => [fragment.id, fragment])),
    [payload.requestFragments],
  );
  const messagesById = useMemo(
    () => new Map(payload.canonicalMessages.map((message) => [message.id, message])),
    [payload.canonicalMessages],
  );
  const toolSchemasByName = useMemo(
    () => new Map(payload.toolSchemas.map((tool) => [tool.name, tool])),
    [payload.toolSchemas],
  );
  const itemsById = useMemo(
    () => new Map(turn.items.map((item) => [item.id, item])),
    [turn.items],
  );
  if (payload.providerCalls.length === 0) {
    return <p className="thread-turn-details-notice">{t.agent.turnDetails.noProviderCalls}</p>;
  }
  return (
    <div className="thread-turn-details-call-list">
      {payload.providerCalls.map((call) => (
        <RequestResultUnit
          call={call}
          defaultOpen={call.index === 0}
          fragmentsById={fragmentsById}
          itemsById={itemsById}
          key={call.index}
          messagesById={messagesById}
          threadId={threadId}
          toolSchemasByName={toolSchemasByName}
          turnId={turn.id}
        />
      ))}
    </div>
  );
}

function RequestResultUnit({
  call,
  defaultOpen,
  fragmentsById,
  itemsById,
  messagesById,
  threadId,
  toolSchemasByName,
  turnId,
}: {
  readonly call: TurnDiagnosticsProviderCall;
  readonly defaultOpen: boolean;
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
  readonly itemsById: ReadonlyMap<string, ThreadItem>;
  readonly messagesById: ReadonlyMap<string, TurnDiagnosticsPayload['canonicalMessages'][number]>;
  readonly threadId: string;
  readonly toolSchemasByName: ReadonlyMap<string, TurnDiagnosticsPayload['toolSchemas'][number]>;
  readonly turnId: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const status = call.response ? providerCallStatus(call.response.stopReason) : null;
  const executionItems = call.executionItemIds.flatMap((id) => {
    const item = itemsById.get(id);
    return item ? [item] : [];
  });
  return (
    <details
      className="thread-turn-details-call"
      onToggle={(event) => setOpen(isDetailsOpen(event.currentTarget))}
      open={open}
    >
      <summary className="thread-turn-details-call-head">
        <ChevronDownIcon className="thread-turn-details-summary-chevron" size={ICON_SIZE.tiny} />
        <strong>{t.agent.turnDetails.modelRequest({ index: call.index + 1 })}</strong>
        <span>{t.agent.turnDetails.inputTokenSummary({ count: formatNumber(call.estimatedInputTokens) })}</span>
        <span>{status ? t.agent.thread.item.status[status] : t.agent.turnDetails.noAssistantResponse}</span>
      </summary>
      {open ? (
        <div className="thread-turn-details-call-body">
          <TimelinePhase title={t.agent.turnDetails.request}>
            <ProviderRequestView
              call={call}
              fragmentsById={fragmentsById}
              messagesById={messagesById}
              toolSchemasByName={toolSchemasByName}
            />
          </TimelinePhase>
          <TimelinePhase title={t.agent.turnDetails.result}>
            <ProviderResponseView call={call} />
            <FlowGroup title={t.agent.turnDetails.localExecution({ count: executionItems.length })}>
              {executionItems.length > 0 ? (
                <div className="thread-turn-details-item-list">
                  {executionItems.map((item) => (
                    <CanonicalItemRow
                      item={item}
                      key={item.id}
                      threadId={threadId}
                      turnId={turnId}
                    />
                  ))}
                </div>
              ) : (
                <p className="thread-turn-details-notice">{t.agent.turnDetails.noLocalExecution}</p>
              )}
            </FlowGroup>
          </TimelinePhase>
        </div>
      ) : null}
    </details>
  );
}

function ProviderRequestView({
  call,
  fragmentsById,
  messagesById,
  toolSchemasByName,
}: {
  readonly call: TurnDiagnosticsProviderCall;
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
  readonly messagesById: ReadonlyMap<string, TurnDiagnosticsPayload['canonicalMessages'][number]>;
  readonly toolSchemasByName: ReadonlyMap<string, TurnDiagnosticsPayload['toolSchemas'][number]>;
}) {
  const t = useT();
  return (
    <div className="thread-turn-details-request">
      <PreparedContextView
        call={call}
        fragmentsById={fragmentsById}
        messagesById={messagesById}
        toolSchemasByName={toolSchemasByName}
      />
      <FlowGroup title={t.agent.turnDetails.sentRequest}>
        <ProviderPayloadView fragmentsById={fragmentsById} request={call.request} />
        <LazyDisclosure
          resetKey={String(call.index)}
          title={t.agent.turnDetails.rawProviderRequest}
          render={() => <JsonCode value={materializeProviderRequest(call.request, fragmentsById)} />}
        />
      </FlowGroup>
      <LazyDisclosure
        resetKey={String(call.index)}
        title={t.agent.turnDetails.requestDiagnostics}
        render={() => (
          <>
            <dl className="thread-turn-details-fact-grid is-compact">
              <Fact label={t.agent.turnDetails.estimatedInputTokens} value={formatNumber(call.estimatedInputTokens)} />
              <Fact label={t.agent.turnDetails.inputTokenLimit} value={formatNumber(call.inputTokenLimit)} />
              <Fact label={t.agent.turnDetails.reservedOutputTokens} value={formatNumber(call.reservedOutputTokens)} />
              <Fact label={t.agent.turnDetails.protectedBoundary} value={formatNumber(call.protectedFromMessageIndex)} />
              <Fact label={t.agent.turnDetails.commonPrefixMessages} value={formatNumber(call.commonPrefixMessageCount)} />
            </dl>
            <dl className="thread-turn-details-identity-list">
              <Identity label={t.agent.turnDetails.requestFingerprint} value={call.requestFingerprint} />
              <Identity
                label={t.agent.turnDetails.cacheBreakpoints}
                value={call.cacheBreakpoints.length > 0 ? jsonText(call.cacheBreakpoints) : '-'}
              />
            </dl>
          </>
        )}
      />
    </div>
  );
}

function PreparedContextView({
  call,
  fragmentsById,
  messagesById,
  toolSchemasByName,
}: {
  readonly call: TurnDiagnosticsProviderCall;
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
  readonly messagesById: ReadonlyMap<string, TurnDiagnosticsPayload['canonicalMessages'][number]>;
  readonly toolSchemasByName: ReadonlyMap<string, TurnDiagnosticsPayload['toolSchemas'][number]>;
}) {
  const t = useT();
  const systemPrompt = fragmentsById.get(call.preparedContext.systemPromptFragmentId);
  const tools = call.preparedContext.toolNames.flatMap((name) => {
    const tool = toolSchemasByName.get(name);
    return tool ? [tool] : [];
  });
  const messages = call.preparedContext.messageIds.flatMap((id, index) => {
    const message = messagesById.get(id);
    return message ? [{
      message,
      partProvenance: call.preparedContext.messagePartProvenance[index] ?? [],
    }] : [];
  });
  return (
    <FlowGroup title={t.agent.turnDetails.preparedRequest}>
      {systemPrompt && typeof systemPrompt.value === 'string' ? (
        <TextDisclosure
          metadata={systemPrompt.id}
          resetKey={`${call.index}:prepared-system-prompt`}
          text={systemPrompt.value}
          title={t.agent.turnDetails.systemInstructions}
        />
      ) : systemPrompt ? (
        <JsonDisclosure
          metadata={systemPrompt.id}
          resetKey={`${call.index}:prepared-system-prompt`}
          title={t.agent.turnDetails.systemInstructions}
          value={systemPrompt.value}
        />
      ) : null}
      <LazyDisclosure
        metadata={t.agent.turnDetails.orderedValues({ count: tools.length })}
        resetKey={`${call.index}:prepared-tools`}
        title={t.agent.turnDetails.preparedTools({ count: tools.length })}
        render={() => (
          <div className="thread-turn-details-nested-list">
            {tools.map((tool) => (
              <JsonDisclosure key={tool.name} resetKey={String(call.index)} title={tool.name} value={tool} />
            ))}
          </div>
        )}
      />
      <LazyDisclosure
        defaultOpen
        metadata={t.agent.turnDetails.orderedValues({ count: messages.length })}
        resetKey={`${call.index}:prepared-messages`}
        title={t.agent.turnDetails.preparedMessages({ count: messages.length })}
        render={() => (
          <div className="thread-turn-details-request-fragments">
            {messages.map(({ message, partProvenance }, index) => (
              <ProviderRequestFragmentView
                fieldName="preparedContext.messages"
                index={index}
                key={`${index}:${message.id}`}
                partProvenance={partProvenance}
                value={message.value}
              />
            ))}
          </div>
        )}
      />
    </FlowGroup>
  );
}

function ProviderPayloadView({
  fragmentsById,
  request,
}: {
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
  readonly request: TurnDiagnosticsProviderRequest;
}) {
  if (request.kind === 'value') return <SemanticValue value={request.value} />;
  return (
    <div className="thread-turn-details-flow-fields">
      {request.fields.map((field) => (
        <ProviderRequestFieldView field={field} fragmentsById={fragmentsById} key={field.name} />
      ))}
    </div>
  );
}

function FlowGroup({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <section className="thread-turn-details-flow-group">
      <h5>{title}</h5>
      <div className="thread-turn-details-flow-fields">{children}</div>
    </section>
  );
}

function ProviderRequestFieldView({
  field,
  fragmentsById,
}: {
  readonly field: TurnDiagnosticsProviderRequestField;
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
}) {
  const t = useT();
  const resetKey = `provider-payload:${field.name}`;
  if (field.representation === 'inline') {
    return isPrimitiveJson(field.value) ? (
      <div className="thread-turn-details-inline-field">
        <code>{field.name}</code>
        <span>{primitiveText(field.value)}</span>
      </div>
    ) : (
      <JsonDisclosure resetKey={resetKey} title={field.name} value={field.value} />
    );
  }
  const fragments = field.fragmentIds.flatMap((id) => {
    const fragment = fragmentsById.get(id);
    return fragment ? [fragment] : [];
  });
  return (
    <LazyDisclosure
      metadata={t.agent.turnDetails.orderedValues({ count: fragments.length })}
      resetKey={resetKey}
      title={field.name}
      render={() => (
        <div className="thread-turn-details-request-fragments">
          {fragments.map((fragment, fragmentIndex) => (
            <ProviderRequestFragmentView
              fieldName={field.name}
              index={fragmentIndex}
              key={`${fragmentIndex}:${fragment.id}`}
              value={fragment.value}
            />
          ))}
        </div>
      )}
    />
  );
}

function ProviderRequestFragmentView({
  fieldName,
  index,
  partProvenance,
  value,
}: {
  readonly fieldName: string;
  readonly index: number;
  readonly partProvenance?: readonly TurnDiagnosticsMessagePartProvenance[];
  readonly value: JsonValue;
}) {
  const t = useT();
  const parts = orderedContentParts(value);
  const label = semanticLabel(value, t.agent.turnDetails);
  const preview = semanticPreview(value);
  if (parts.length === 0) {
    return (
      <JsonDisclosure
        metadata={preview}
        resetKey={`${fieldName}:${index}`}
        title={`[${index}] ${label}`}
        value={value}
      />
    );
  }
  return (
    <div className="thread-turn-details-request-message">
      <div className="thread-turn-details-request-message-head">
        <code>[{index}]</code>
        <strong>{label}</strong>
        {preview ? <span>{preview}</span> : null}
      </div>
      <div className="thread-turn-details-part-list">
        {parts.map((part, partIndex) => (
          <JsonDisclosure
            metadata={semanticPreview(part, partProvenance?.[partIndex])}
            resetKey={`${fieldName}:${index}:${partIndex}`}
            title={`[${partIndex}] ${semanticLabel(part, t.agent.turnDetails, partProvenance?.[partIndex])}`}
            value={part}
            key={`${partIndex}:${jsonIdentity(part)}`}
          />
        ))}
      </div>
      <JsonDisclosure
        resetKey={`${fieldName}:${index}:raw`}
        title={t.agent.turnDetails.rawMessage}
        value={value}
      />
    </div>
  );
}

function ProviderResponseView({ call }: { readonly call: TurnDiagnosticsProviderCall }) {
  const t = useT();
  const { locale } = useI18n();
  if (!call.response) {
    return (
      <div className="thread-turn-details-result">
        <FlowGroup title={t.agent.turnDetails.modelResponse}>
          <p className="thread-turn-details-notice">{t.agent.turnDetails.noAssistantResponse}</p>
        </FlowGroup>
        <ResponseDiagnostics call={call} locale={locale} />
      </div>
    );
  }
  return (
    <div className="thread-turn-details-result">
      <FlowGroup title={t.agent.turnDetails.modelResponse}>
        <SemanticValue value={call.response.value} />
        <JsonDisclosure
          resetKey={`${call.index}:response`}
          title={t.agent.turnDetails.rawProviderResponse}
          value={call.response.value}
        />
      </FlowGroup>
      <ResponseDiagnostics call={call} locale={locale} />
    </div>
  );
}

function ResponseDiagnostics({ call, locale }: { readonly call: TurnDiagnosticsProviderCall; readonly locale: string }) {
  const t = useT();
  return (
    <LazyDisclosure
      resetKey={`${call.index}:response-diagnostics`}
      title={t.agent.turnDetails.responseDiagnostics}
      render={() => (
        <>
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
          </dl>
          <dl className="thread-turn-details-identity-list">
            <Identity label={t.agent.turnDetails.requestId} value={call.transportResponse?.requestId ?? '-'} />
          </dl>
        </>
      )}
    />
  );
}

function SemanticValue({ value }: { readonly value: JsonValue }) {
  const t = useT();
  const parts = orderedContentParts(value);
  if (parts.length === 0) return <JsonCode value={value} />;
  return (
    <div className="thread-turn-details-part-list">
      {parts.map((part, index) => (
        <JsonDisclosure
          metadata={semanticPreview(part)}
          resetKey={`semantic:${index}`}
          title={`[${index}] ${semanticLabel(part, t.agent.turnDetails)}`}
          value={part}
          key={`${index}:${jsonIdentity(part)}`}
        />
      ))}
    </div>
  );
}

function TurnRecord({ detail }: { readonly detail: ThreadTurnDetailsReadResponse }) {
  const t = useT();
  const { diagnostics, thread, turn } = detail;
  const userItems = turn.items.filter((item) => item.type === 'userMessage');
  return (
    <div className="thread-turn-details-disclosure-stack">
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
      <JsonDisclosure
        resetKey={turn.id}
        title={t.agent.turnDetails.acceptedUserInput}
        value={userItems.map((item) => ({
          itemId: item.id,
          acceptedAt: item.acceptedAt,
          content: item.content,
        }))}
      />
      {diagnostics ? <DiagnosticsRecord payload={diagnostics.payload} resetKey={turn.id} /> : (
        <p className="thread-turn-details-notice">{t.agent.turnDetails.diagnosticsUnavailable}</p>
      )}
      <LazyDisclosure
        metadata={formatNumber(turn.items.length)}
        resetKey={turn.id}
        title={t.agent.turnDetails.canonicalItems({ count: turn.items.length })}
        render={() => (
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
        )}
      />
    </div>
  );
}

function DiagnosticsRecord({ payload, resetKey }: { readonly payload: TurnDiagnosticsPayload; readonly resetKey: string }) {
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
      <JsonDisclosure resetKey={resetKey} title={t.agent.turnDetails.runtimeSettings} value={payload.runtime} />
      <LazyDisclosure
        metadata={formatNumber(payload.canonicalMessages.length)}
        resetKey={resetKey}
        title={t.agent.turnDetails.canonicalMessages}
        render={() => (
          <div className="thread-turn-details-nested-list">
            {payload.canonicalMessages.map((message, index) => (
              <JsonDisclosure
                key={`${index}:${message.id}`}
                metadata={`${formatNumber(message.estimatedTokens)} tokens · ${message.id}`}
                resetKey={resetKey}
                title={`[${index}] ${messageRole(message.value)}`}
                value={message.value}
              />
            ))}
          </div>
        )}
      />
    </>
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
  const [output, setOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const outputRef = itemOutputReference(item);

  useEffect(() => {
    requestRef.current += 1;
    setOpen(false);
    setContextPayload(null);
    setOutput(null);
    setLoading(false);
    setLoadError(null);
  }, [item.id, threadId, turnId]);

  const loadPayload = useCallback(async () => {
    if (loading || contextPayload !== null || output !== null) return;
    if (item.type !== 'contextEvidence' && !outputRef) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    setLoadError(null);
    try {
      if (item.type === 'contextEvidence') {
        const response = await api.agentCoreRequest('thread/context/read', {
          threadId,
          turnId,
          itemId: item.id,
          contextId: item.payloadRef.id,
        });
        if (!response.context) throw new Error(t.agent.turnDetails.contextUnavailable);
        if (requestRef.current === request) setContextPayload(response.context.payload);
      } else if (outputRef) {
        const response = await api.agentCoreRequest('thread/item/output/read', {
          threadId,
          turnId,
          itemId: item.id,
          outputId: outputRef.id,
        });
        if (!response.output) throw new Error(t.agent.turnDetails.outputUnavailable);
        if (requestRef.current === request) setOutput(response.output.text);
      }
    } catch (caught) {
      if (requestRef.current === request) {
        setLoadError(caught instanceof Error && caught.message
          ? caught.message
          : t.agent.turnDetails.payloadUnavailable);
      }
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [contextPayload, item, loading, output, outputRef, t.agent.turnDetails, threadId, turnId]);

  return (
    <details
      className="thread-turn-details-item"
      onToggle={(event) => {
        const nextOpen = isDetailsOpen(event.currentTarget);
        setOpen(nextOpen);
        if (nextOpen) void loadPayload();
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
          {loading ? <span className="is-muted">{t.agent.turnDetails.loadingPayload}</span> : null}
          {loadError ? (
            <div className="thread-turn-details-context-error">
              <span>{loadError}</span>
              <Button onClick={() => void loadPayload()} size="sm" variant="ghost">
                {t.agent.turnDetails.retry}
              </Button>
            </div>
          ) : null}
          {contextPayload ? <JsonCode value={contextPayload} /> : null}
          {output !== null && outputRef ? (
            <ReadOnlyCodeBlock
              className="thread-turn-details-code-block"
              code={output}
              language={outputRef.mimeType === 'application/json' ? 'json' : 'text'}
            />
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function TimelinePhase({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <section className="thread-turn-details-phase">
      <h4>{title}</h4>
      {children}
    </section>
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
      onToggle={(event) => setOpen(isDetailsOpen(event.currentTarget))}
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

function materializeProviderRequest(
  request: TurnDiagnosticsProviderRequest,
  fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>,
): JsonValue {
  if (request.kind === 'value') return request.value;
  const entries: Array<readonly [string, JsonValue]> = request.fields.map((field) => {
    if (field.representation === 'inline') return [field.name, field.value] as const;
    const values = field.fragmentIds.map((id) => fragmentsById.get(id)?.value ?? null);
    return [field.name, field.container === 'array' ? values : values[0] ?? null] as const;
  });
  return Object.fromEntries(entries);
}

function orderedContentParts(value: JsonValue): readonly JsonValue[] {
  const record = jsonRecord(value);
  if (!record) return [];
  if (Array.isArray(record.content)) return record.content;
  if (Array.isArray(record.parts)) return record.parts;
  if (record.content !== undefined && record.content !== null) return [record.content];
  return [];
}

function semanticLabel(
  value: JsonValue,
  labels: TurnDetailsLabels,
  provenance?: TurnDiagnosticsMessagePartProvenance,
): string {
  if (provenance?.source === 'contextEvidence') {
    return labels.contextEvidence({ kind: provenance.kind });
  }
  if (provenance?.source === 'contextCompaction') {
    return labels.contextCompaction;
  }
  const text = semanticText(value);
  if (
    provenance?.source === 'userInput'
    && (text?.startsWith('[Attachment image:') || text?.startsWith('[Attachment:'))
  ) return labels.attachment;
  const record = jsonRecord(value);
  if (!record) return typeof value === 'string' ? labels.textPart : labels.value;
  const type = stringProperty(record, 'type');
  if (type && /^(?:input_|output_)?text$/i.test(type)) return labels.textPart;
  if (type && /image/i.test(type)) return labels.imagePart;
  if (type && /tool[_-]?(?:use|call)|function_call/i.test(type)) return labels.toolCallPart;
  if (type && /tool[_-]?result|function_call_output/i.test(type)) return labels.toolResultPart;
  const role = stringProperty(record, 'role');
  if (role) return role;
  const name = stringProperty(record, 'name');
  if (name) return name;
  return type ?? labels.value;
}

function semanticPreview(
  value: JsonValue,
  provenance?: TurnDiagnosticsMessagePartProvenance,
): string {
  const text = semanticText(value);
  if (text) {
    if (provenance?.source === 'contextEvidence' || provenance?.source === 'contextCompaction') {
      const body = firstWrappedBodyLine(text);
      if (body) return body;
    }
    return compactPreview(text);
  }
  const record = jsonRecord(value);
  if (record) {
    const name = stringProperty(record, 'name');
    if (name) return name;
  }
  return compactPreview(jsonText(value));
}

function firstWrappedBodyLine(text: string): string | null {
  const first = text.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('<') && !line.endsWith('>'));
  return first ? compactPreview(first) : null;
}

function semanticText(value: JsonValue): string | null {
  if (typeof value === 'string') return value;
  const record = jsonRecord(value);
  if (!record) return null;
  for (const key of ['text', 'input_text', 'output_text']) {
    const text = stringProperty(record, key);
    if (text) return text;
  }
  return typeof record.content === 'string' ? record.content : null;
}

function compactPreview(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function jsonRecord(value: JsonValue): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringProperty(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value ? value : null;
}

function isPrimitiveJson(value: JsonValue): boolean {
  return value === null || typeof value !== 'object';
}

function primitiveText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isDetailsOpen(details: HTMLDetailsElement): boolean {
  return typeof details.open === 'boolean' ? details.open : details.hasAttribute('open');
}

function jsonIdentity(value: JsonValue): string {
  const record = jsonRecord(value);
  return record
    ? stringProperty(record, 'id') ?? stringProperty(record, 'type') ?? semanticPreview(value)
    : semanticPreview(value);
}

function Identity({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd><code>{value}</code></dd></div>;
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function itemOutputReference(item: ThreadItem): ThreadItemOutputReference | null {
  return 'outputRef' in item ? item.outputRef : null;
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
  return jsonRecord(value) ? stringProperty(jsonRecord(value)!, 'role') ?? 'message' : 'message';
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
