import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  JsonValue,
  ThreadItem,
  ThreadItemOutputReference,
  ThreadTurnDetailsReadResponse,
  Turn,
  TurnDiagnosticsActivity,
  TurnDiagnosticsPayload,
  TurnDiagnosticsMessagePartProvenance,
  TurnDiagnosticsProviderCall,
  TurnDiagnosticsProviderRequest,
  TurnDiagnosticsProviderRequestField,
} from '../../../core/agent/protocol';
import { api } from '../../api/client';
import { useI18n, useT } from '../../i18n/I18nProvider';
import { formatDateTime, formatNumber } from '../../ui/formatting';
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ICON_SIZE,
  InfoIcon,
  LoaderIcon,
} from '../../ui/icons';
import { PanelStickyBreadcrumb, type PanelDragHandle } from '../../ui/PanelShared';
import { ReadOnlyCodeBlock } from '../../ui/editor/CodeBlockSurface';
import { Button } from '../../ui/primitives/Button';
import { EmptyState, ErrorState } from '../../ui/primitives/FeedbackState';
import { IconButton } from '../../ui/primitives/IconButton';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { userFacingAgentErrorRecord } from '../threadErrorMessage';
import { threadItemForUserSurface } from '../subagentPresentation';
import {
  ThreadUsageBreakdown,
  formatCachedShare,
  formatUsageCost,
} from './ThreadUsageBreakdown';

interface ThreadTurnDetailsPanelProps {
  readonly canGoBack: boolean;
  readonly onBack: () => void;
  readonly onClose: () => void;
  readonly panelDragHandle?: PanelDragHandle;
  readonly showClose: boolean;
  readonly threadId: string;
  readonly turnId: string;
}

type TurnDetailsLabels = ReturnType<typeof useT>['agent']['turnDetails'];
type JsonRecord = Readonly<Record<string, JsonValue>>;
type InlineProviderRequestField = Extract<
  TurnDiagnosticsProviderRequestField,
  { readonly representation: 'inline' }
>;
type FragmentedProviderRequestField = Extract<
  TurnDiagnosticsProviderRequestField,
  { readonly representation: 'fragments' }
>;

export function ThreadTurnDetailsPanel({
  canGoBack,
  onBack,
  onClose,
  panelDragHandle,
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
        dragHandle={panelDragHandle}
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
  const activityCount = detail.diagnostics
    ? interactionActivities(detail.diagnostics.payload).length
    : 0;
  return (
    <div className="thread-turn-details-body">
      <TurnDetailsSection title={t.agent.turnDetails.summary}>
        <TurnOverview diagnostics={detail.diagnostics?.payload ?? null} turn={detail.turn} />
      </TurnDetailsSection>
      <TurnDetailsSection title={t.agent.turnDetails.timeline({ count: activityCount })}>
        {detail.diagnostics ? (
          <TurnTimeline
            payload={detail.diagnostics.payload}
            threadId={detail.thread.id}
            turn={detail.turn}
          />
        ) : (
          <p className="thread-turn-details-notice">{t.agent.turnDetails.diagnosticsUnavailable}</p>
        )}
      </TurnDetailsSection>
      <section className="thread-turn-details-internal-section">
        <LazyDisclosure
          metadata={t.agent.turnDetails.internalDiagnosticsHint}
          render={() => <TurnRecord detail={detail} />}
          resetKey={detail.turn.id}
          title={t.agent.turnDetails.internalDiagnostics}
        />
      </section>
    </div>
  );
}

function TurnOverview({
  diagnostics,
  turn,
}: {
  readonly diagnostics: TurnDiagnosticsPayload | null;
  readonly turn: Turn;
}) {
  const t = useT();
  const { locale } = useI18n();
  const usage = turn.execution.usage;
  const cachedShare = formatCachedShare(usage.input, usage.cacheRead, usage.cacheWrite);
  const modelCallCount = diagnostics?.providerCalls.length ?? null;
  const toolExecutionCount = diagnostics
    ? diagnostics.activities.reduce((count, activity) => (
        activity.type === 'toolExecutionBatch' ? count + activity.executions.length : count
      ), 0)
    : null;
  const timeRange = turn.completedAt
    ? `${formatTimestamp(turn.startedAt, locale)} - ${formatTimestamp(turn.completedAt, locale)}`
    : formatTimestamp(turn.startedAt, locale);
  const turnError = turn.error
    ? userFacingAgentErrorRecord(turn.error, t.agent.thread.resourceLimitReached)
    : null;
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
          <dt>{t.agent.turnDetails.modelCalls}</dt>
          <dd>{modelCallCount === null ? '-' : formatNumber(modelCallCount)}</dd>
          <small>
            {t.agent.turnDetails.toolExecutions}: {toolExecutionCount === null ? '-' : formatNumber(toolExecutionCount)}
          </small>
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
      {turnError ? (
        <dl aria-label={t.agent.turnDetails.turnError} className="thread-turn-details-identity-list">
          <Fact
            label={t.agent.turnDetails.turnError}
            value={turnError.message}
          />
          {turnError.code ? <Identity label={t.agent.turnDetails.errorCode} value={turnError.code} /> : null}
          {turnError.detail ? <Fact label={t.agent.turnDetails.errorDetail} value={turnError.detail} /> : null}
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

function TurnTimeline({
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
  const activities = interactionActivities(payload);
  const callActivities = activities.filter((activity) => activity.type === 'modelCall');
  const defaultOpenCallIndex = defaultTimelineCallIndex(payload);
  return (
    <div className="thread-turn-details-timeline">
      {activities.map((activity, index) => {
        const key = timelineActivityKey(activity, index);
        if (activity.type === 'modelCall') {
          const call = payload.providerCalls[activity.callIndex];
          return call ? (
            <ModelCallUnit
              call={call}
              defaultOpen={call.index === defaultOpenCallIndex}
              fragmentsById={fragmentsById}
              key={key}
              messagesById={messagesById}
              runtime={payload.runtime}
              toolSchemasByName={toolSchemasByName}
            />
          ) : null;
        }
        if (activity.type === 'toolExecutionBatch') {
          return (
            <ToolExecutionBatchActivity
              activity={activity}
              itemsById={itemsById}
              key={key}
              threadId={threadId}
              turnId={turn.id}
            />
          );
        }
        if (activity.type === 'contextCompaction') {
          return (
            <ContextCompactionActivity
              activity={activity}
              item={itemsById.get(activity.itemId)}
              key={key}
              threadId={threadId}
              turnId={turn.id}
            />
          );
        }
        return <ProviderRetryActivity activity={activity} key={key} />;
      })}
      {callActivities.length === 0 ? (
        <p className="thread-turn-details-notice">{t.agent.turnDetails.noProviderCalls}</p>
      ) : null}
    </div>
  );
}

function ToolExecutionBatchActivity({
  activity,
  itemsById,
  threadId,
  turnId,
}: {
  readonly activity: Extract<TurnDiagnosticsActivity, { type: 'toolExecutionBatch' }>;
  readonly itemsById: ReadonlyMap<string, ThreadItem>;
  readonly threadId: string;
  readonly turnId: string;
}) {
  const t = useT();
  const executions = activity.executions;
  const failed = executions.some((execution) => execution.status === 'failed');
  const relation = activity.consumedByCallIndex === null
    ? t.agent.turnDetails.afterCall({ index: activity.sourceCallIndex + 1 })
    : t.agent.turnDetails.betweenCalls({
        source: activity.sourceCallIndex + 1,
        target: activity.consumedByCallIndex + 1,
      });
  return (
    <TimelineActivityDisclosure
      defaultOpen={failed}
      metadata={relation}
      resetKey={`tools:${activity.sourceCallIndex}:${activity.consumedByCallIndex ?? 'none'}`}
      title={t.agent.turnDetails.toolExecutionBatch({ count: executions.length })}
      render={() => (
        <div className="thread-turn-details-item-list">
          {executions.map((execution) => {
            const item = execution.itemId ? itemsById.get(execution.itemId) : null;
            return item ? (
              <CanonicalItemRow item={item} key={execution.callId} threadId={threadId} turnId={turnId} />
            ) : (
              <div className="thread-turn-details-transient-tool" key={execution.callId}>
                <strong>{execution.toolName}</strong>
                <span>{t.agent.thread.item.status[execution.status]}</span>
                <code>{execution.callId}</code>
              </div>
            );
          })}
        </div>
      )}
    />
  );
}

function ProviderRetryActivity({
  activity,
}: {
  readonly activity: Extract<TurnDiagnosticsActivity, { type: 'providerRetry' }>;
}) {
  const t = useT();
  return (
    <div className="thread-turn-details-timeline-fact">
      <strong>{activity.retryKind === 'request'
        ? t.agent.turnDetails.requestRetry
        : t.agent.turnDetails.streamRetry}</strong>
      <span>{t.agent.turnDetails.retryAttempt({ attempt: activity.attempt, max: activity.maxRetries })}</span>
      <code>{activity.nextCallIndex === null
        ? t.agent.turnDetails.afterCall({ index: activity.sourceCallIndex + 1 })
        : t.agent.turnDetails.betweenCalls({
            source: activity.sourceCallIndex + 1,
            target: activity.nextCallIndex + 1,
          })}</code>
    </div>
  );
}

function ContextCompactionActivity({
  activity,
  item,
  threadId,
  turnId,
}: {
  readonly activity: Extract<TurnDiagnosticsActivity, { type: 'contextCompaction' }>;
  readonly item: ThreadItem | undefined;
  readonly threadId: string;
  readonly turnId: string;
}) {
  const t = useT();
  const relation = activity.sourceCallIndex === null
    ? activity.nextCallIndex === null
      ? t.agent.turnDetails.beforeAnyModelCall
      : t.agent.turnDetails.beforeCall({ index: activity.nextCallIndex + 1 })
    : activity.nextCallIndex === null
      ? t.agent.turnDetails.afterCall({ index: activity.sourceCallIndex + 1 })
      : t.agent.turnDetails.betweenCalls({
          source: activity.sourceCallIndex + 1,
          target: activity.nextCallIndex + 1,
        });
  return (
    <TimelineActivityDisclosure
      defaultOpen={false}
      metadata={relation}
      resetKey={`compaction:${activity.itemId}`}
      title={activity.trigger === 'automaticPreflight'
        ? t.agent.turnDetails.preflightCompaction
        : t.agent.turnDetails.overflowCompaction}
      render={() => item ? (
        <CanonicalItemRow item={item} threadId={threadId} turnId={turnId} />
      ) : (
        <p className="thread-turn-details-notice">{t.agent.turnDetails.payloadUnavailable}</p>
      )}
    />
  );
}

function ModelCallUnit({
  call,
  defaultOpen,
  fragmentsById,
  messagesById,
  runtime,
  toolSchemasByName,
}: {
  readonly call: TurnDiagnosticsProviderCall;
  readonly defaultOpen: boolean;
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
  readonly messagesById: ReadonlyMap<string, TurnDiagnosticsPayload['canonicalMessages'][number]>;
  readonly runtime: TurnDiagnosticsPayload['runtime'];
  readonly toolSchemasByName: ReadonlyMap<string, TurnDiagnosticsPayload['toolSchemas'][number]>;
}) {
  const t = useT();
  const status = call.response ? providerCallStatus(call.response.stopReason) : null;
  return (
    <TimelineActivityDisclosure
      actions={(
        <CallHeaderActions
          call={call}
          fragmentsById={fragmentsById}
          messagesById={messagesById}
          runtime={runtime}
          toolSchemasByName={toolSchemasByName}
        />
      )}
      defaultOpen={defaultOpen}
      metadata={status ? t.agent.thread.item.status[status] : t.agent.turnDetails.noAssistantResponse}
      resetKey={`call:${call.index}`}
      title={t.agent.turnDetails.modelCall({ index: call.index + 1 })}
      render={() => (
        <div className="thread-turn-details-call-body">
          <TimelinePhase title={t.agent.turnDetails.request}>
            <ProviderRequestView
              call={call}
              fragmentsById={fragmentsById}
            />
          </TimelinePhase>
          <TimelinePhase title={t.agent.turnDetails.response}>
            <ProviderResponseView call={call} />
          </TimelinePhase>
        </div>
      )}
    />
  );
}

function CallHeaderActions({
  call,
  fragmentsById,
  messagesById,
  runtime,
  toolSchemasByName,
}: {
  readonly call: TurnDiagnosticsProviderCall;
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
  readonly messagesById: ReadonlyMap<string, TurnDiagnosticsPayload['canonicalMessages'][number]>;
  readonly runtime: TurnDiagnosticsPayload['runtime'];
  readonly toolSchemasByName: ReadonlyMap<string, TurnDiagnosticsPayload['toolSchemas'][number]>;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [factsOpen, setFactsOpen] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const factsButtonRef = useRef<HTMLButtonElement | null>(null);
  const tooltipId = useId();

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
  }, []);

  const copyModelCall = async () => {
    const value = materializeModelCallDiagnostics(
      call,
      fragmentsById,
      messagesById,
      runtime,
      toolSchemasByName,
    );
    try {
      await navigator.clipboard.writeText(jsonText(value));
    } catch {
      return;
    }
    setCopied(true);
    if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = window.setTimeout(() => {
      copyResetTimerRef.current = null;
      setCopied(false);
    }, 1_200);
  };

  return (
    <span
      className="thread-turn-details-call-actions"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="thread-turn-details-request-facts-anchor">
        <IconButton
          aria-describedby={factsOpen ? tooltipId : undefined}
          className="thread-turn-details-call-action"
          icon={InfoIcon}
          iconSize={ICON_SIZE.menu}
          label={t.agent.turnDetails.callInformation}
          onBlur={() => setFactsOpen(false)}
          onFocus={() => setFactsOpen(true)}
          onMouseEnter={() => setFactsOpen(true)}
          onMouseLeave={() => setFactsOpen(false)}
          ref={factsButtonRef}
          title=""
          variant="panel"
        />
        {factsOpen ? (
          <RequestFactsCard
            anchorRef={factsButtonRef}
            call={call}
            id={tooltipId}
            runtime={runtime}
          />
        ) : null}
      </span>
      <IconButton
        className="thread-turn-details-call-action"
        icon={copied ? CheckIcon : CopyIcon}
        iconSize={ICON_SIZE.menu}
        label={copied ? t.agent.turnDetails.modelCallCopied : t.agent.turnDetails.copyModelCall}
        onClick={() => void copyModelCall()}
        variant="panel"
      />
    </span>
  );
}

function RequestFactsCard({
  anchorRef,
  call,
  id,
  runtime,
}: {
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly call: TurnDiagnosticsProviderCall;
  readonly id: string;
  readonly runtime: TurnDiagnosticsPayload['runtime'];
}) {
  const t = useT();
  const { locale } = useI18n();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const status = call.response ? providerCallStatus(call.response.stopReason) : null;
  const usage = call.response?.usage ?? null;
  const usageBreakdown = usage ? {
    ...usage,
    cost: { ...usage.cost, currency: 'USD' as const },
  } : null;
  const parameterFields = providerParameterFields(call.request);
  const style = useAnchoredOverlay(cardRef, {
    anchorRef,
    gap: 8,
    layoutKey: [
      call.index,
      call.requestedAt,
      call.response?.receivedAt ?? 'pending',
      call.requestFingerprint,
      runtime.provider,
      runtime.model,
      usage?.totalTokens ?? 0,
      usage?.cost.total ?? 0,
    ].join(':'),
    maxHeight: 640,
    placement: 'bottom-end',
    width: 360,
  });
  return createPortal(
    <div
      className="thread-response-usage-card thread-turn-details-request-facts-card"
      id={id}
      ref={cardRef}
      role="tooltip"
      style={style}
    >
      <div className="thread-turn-details-request-facts-title">
        {t.agent.turnDetails.callInformation}
      </div>
      <dl className="thread-response-usage-context">
        <div><dt>{t.agent.message.model}</dt><dd>{runtime.model}</dd></div>
        <div><dt>{t.agent.message.provider}</dt><dd>{runtime.provider}</dd></div>
        <div>
          <dt>{t.agent.thread.status}</dt>
          <dd>{status ? t.agent.thread.item.status[status] : t.agent.turnDetails.noAssistantResponse}</dd>
        </div>
        <div><dt>{t.agent.turnDetails.requestedAt}</dt><dd>{formatTimestamp(call.requestedAt, locale)}</dd></div>
        <div>
          <dt>{t.agent.turnDetails.duration}</dt>
          <dd>{call.response ? formatDuration(call.response.receivedAt - call.requestedAt) : '-'}</dd>
        </div>
        <div>
          <dt>{t.agent.turnDetails.timeToHeaders}</dt>
          <dd>{call.transportResponse
            ? formatDuration(call.transportResponse.headersReceivedAt - call.requestedAt)
            : '-'}</dd>
        </div>
        <div>
          <dt>{t.agent.turnDetails.httpStatus}</dt>
          <dd>{call.transportResponse ? String(call.transportResponse.httpStatus) : '-'}</dd>
        </div>
        <div>
          <dt>{t.agent.turnDetails.requestId}</dt>
          <dd>{call.transportResponse?.requestId ?? '-'}</dd>
        </div>
        <div>
          <dt>{t.agent.turnDetails.estimatedInputTokens}</dt>
          <dd>{formatNumber(call.estimatedInputTokens)}</dd>
        </div>
        <div>
          <dt>{t.agent.turnDetails.inputTokenLimit}</dt>
          <dd>{formatNumber(call.inputTokenLimit)}</dd>
        </div>
        <div>
          <dt>{t.agent.turnDetails.reservedOutputTokens}</dt>
          <dd>{formatNumber(call.reservedOutputTokens)}</dd>
        </div>
        <div>
          <dt>{t.agent.turnDetails.commonPrefixMessages}</dt>
          <dd>{formatNumber(call.commonPrefixMessageCount)}</dd>
        </div>
        {call.response ? (
          <div>
            <dt>{t.agent.turnDetails.stopReason}</dt>
            <dd>{call.response.stopReason}</dd>
          </div>
        ) : null}
        {usage ? (
          <div><dt>{t.agent.message.cost}</dt><dd>{formatUsageCost(usage.cost.total)}</dd></div>
        ) : null}
      </dl>
      {parameterFields.length > 0 ? (
        <section className="thread-turn-details-parameter-section">
          <div className="thread-turn-details-parameter-title">
            {t.agent.turnDetails.providerParameters}
          </div>
          <ProviderParameterList compact fields={parameterFields} />
        </section>
      ) : null}
      {usage && usageBreakdown ? (
        <>
          <ThreadUsageBreakdown usage={usageBreakdown} />
          <dl className="thread-turn-details-request-usage-extras">
            <div>
              <dt>{t.agent.turnDetails.reportedReasoningTokens}</dt>
              <dd>{usage.reasoning === null ? '-' : formatNumber(usage.reasoning)}</dd>
            </div>
            {usage.cacheWrite1h === null ? null : (
              <div>
                <dt>{t.agent.turnDetails.reportedCacheWrite1h}</dt>
                <dd>{formatNumber(usage.cacheWrite1h)}</dd>
              </div>
            )}
          </dl>
        </>
      ) : (
        <p className="thread-turn-details-notice">{t.agent.turnDetails.noAssistantResponse}</p>
      )}
      {call.response?.errorMessage ? (
        <p className="thread-turn-details-call-error">
          <strong>{t.agent.turnDetails.providerError}</strong>
          <span>{call.response.errorMessage}</span>
        </p>
      ) : null}
    </div>,
    document.body,
  );
}

function ProviderRequestView({
  call,
  fragmentsById,
}: {
  readonly call: TurnDiagnosticsProviderCall;
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
}) {
  const t = useT();
  return (
    <div className="thread-turn-details-request">
      <FlowGroup title={t.agent.turnDetails.providerRequest}>
        <ProviderPayloadView fragmentsById={fragmentsById} request={call.request} />
      </FlowGroup>
    </div>
  );
}

function ProviderPayloadView({
  fragmentsById,
  request,
}: {
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
  readonly request: TurnDiagnosticsProviderRequest;
}) {
  const t = useT();
  if (request.kind === 'value') return <SemanticValue value={request.value} />;
  const contentFields = request.fields.filter((field): field is FragmentedProviderRequestField => (
    field.representation === 'fragments'
  ));
  if (contentFields.length === 0) {
    return <p className="thread-turn-details-notice">{t.agent.turnDetails.noProviderRequestContent}</p>;
  }
  return (
    <div className="thread-turn-details-flow-fields">
      {contentFields.map((field) => (
        <ProviderRequestFieldView field={field} fragmentsById={fragmentsById} key={field.name} />
      ))}
    </div>
  );
}

function ProviderParameterList({
  compact = false,
  fields,
}: {
  readonly compact?: boolean;
  readonly fields: readonly InlineProviderRequestField[];
}) {
  return (
    <dl className={`thread-turn-details-parameter-list${compact ? ' is-compact' : ''}`}>
      {fields.map((field) => {
        const value = providerParameterText(field.value);
        return (
          <div key={field.name}>
            <dt><code>{field.name}</code></dt>
            <dd title={jsonText(field.value)}>{value}</dd>
          </div>
        );
      })}
    </dl>
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
  readonly field: FragmentedProviderRequestField;
  readonly fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>;
}) {
  const t = useT();
  const resetKey = `provider-payload:${field.name}`;
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
              partProvenance={field.fragmentPartProvenance[fragmentIndex]!}
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
  readonly partProvenance: readonly TurnDiagnosticsMessagePartProvenance[] | null;
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
        {parts.map((part, partIndex) => {
          const provenance = partProvenance?.[partIndex];
          const resetKey = `${fieldName}:${index}:${partIndex}`;
          return provenance?.source === 'systemContext' ? (
            <SystemContextDisclosure
              index={partIndex}
              key={`${partIndex}:${jsonIdentity(part)}`}
              provenance={provenance}
              resetKey={resetKey}
              value={part}
            />
          ) : (
            <JsonDisclosure
              metadata={semanticPreview(part, provenance)}
              resetKey={resetKey}
              title={`[${partIndex}] ${semanticLabel(part, t.agent.turnDetails, provenance)}`}
              value={part}
              key={`${partIndex}:${jsonIdentity(part)}`}
            />
          );
        })}
      </div>
      <JsonDisclosure
        resetKey={`${fieldName}:${index}:raw`}
        title={t.agent.turnDetails.rawMessage}
        value={value}
      />
    </div>
  );
}

function SystemContextDisclosure({
  index,
  provenance,
  resetKey,
  value,
}: {
  readonly index: number;
  readonly provenance: Extract<TurnDiagnosticsMessagePartProvenance, { readonly source: 'systemContext' }>;
  readonly resetKey: string;
  readonly value: JsonValue;
}) {
  const t = useT();
  return (
    <LazyDisclosure
      metadata={t.agent.turnDetails.contextEntries({ count: provenance.entries.length })}
      resetKey={resetKey}
      title={`[${index}] ${t.agent.turnDetails.systemContext}`}
      render={() => (
        <div className="thread-turn-details-flow-fields">
          <dl className="thread-turn-details-parameter-list is-compact">
            {provenance.entries.map((entry, entryIndex) => (
              <div key={`${entryIndex}:${entry.kind}:${entry.authority}:${entry.purpose}`}>
                <dt><code>[{entryIndex}]</code></dt>
                <dd>{t.agent.turnDetails.contextEntry(entry)}</dd>
              </div>
            ))}
          </dl>
          <JsonDisclosure
            resetKey={`${resetKey}:raw`}
            title={t.agent.turnDetails.rawSystemContext}
            value={value}
          />
        </div>
      )}
    />
  );
}

function ProviderResponseView({ call }: { readonly call: TurnDiagnosticsProviderCall }) {
  const t = useT();
  if (!call.response) {
    return (
      <div className="thread-turn-details-result">
        <FlowGroup title={t.agent.turnDetails.modelResponse}>
          <p className="thread-turn-details-notice">{t.agent.turnDetails.noAssistantResponse}</p>
        </FlowGroup>
      </div>
    );
  }
  return (
    <div className="thread-turn-details-result">
      <FlowGroup title={t.agent.turnDetails.modelResponse}>
        <SemanticValue value={call.response.value} />
      </FlowGroup>
    </div>
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
  const admissions = payload.activities.filter((activity) => activity.type === 'acceptedInput');
  return (
    <>
      <JsonDisclosure
        metadata={formatNumber(admissions.length)}
        resetKey={resetKey}
        title={t.agent.turnDetails.inputAdmissions}
        value={admissions}
      />
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
  const displayItem = threadItemForUserSurface(item, t.agent.thread.resourceLimitReached);
  const outputRef = itemOutputReference(displayItem);

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
          <JsonCode value={displayItem} />
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

function TimelineActivityDisclosure({
  actions,
  defaultOpen,
  metadata,
  render,
  resetKey,
  title,
}: {
  readonly actions?: ReactNode;
  readonly defaultOpen: boolean;
  readonly metadata: string;
  readonly render: () => ReactNode;
  readonly resetKey: string;
  readonly title: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen, resetKey]);
  return (
    <details
      className="thread-turn-details-timeline-activity"
      onToggle={(event) => setOpen(isDetailsOpen(event.currentTarget))}
      open={open}
    >
      <summary className="thread-turn-details-activity-head">
        <ChevronDownIcon className="thread-turn-details-summary-chevron" size={ICON_SIZE.tiny} />
        <strong>{title}</strong>
        <span>{metadata}</span>
        {actions ?? <span aria-hidden="true" />}
      </summary>
      {open ? <div className="thread-turn-details-activity-body">{render()}</div> : null}
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

function providerParameterFields(
  request: TurnDiagnosticsProviderRequest,
): readonly InlineProviderRequestField[] {
  if (request.kind !== 'object') return [];
  return request.fields.filter((field): field is InlineProviderRequestField => field.representation === 'inline');
}

function providerParameterText(value: JsonValue): string {
  return isPrimitiveJson(value) ? primitiveText(value) : compactPreview(jsonText(value));
}

function provenanceJson(provenance: TurnDiagnosticsMessagePartProvenance): JsonValue {
  if (provenance.source !== 'systemContext') return { source: provenance.source };
  return {
    source: provenance.source,
    entries: provenance.entries.map((entry) => ({
      kind: entry.kind,
      authority: entry.authority,
      purpose: entry.purpose,
    })),
  };
}

function materializeModelCallDiagnostics(
  call: TurnDiagnosticsProviderCall,
  fragmentsById: ReadonlyMap<string, TurnDiagnosticsPayload['requestFragments'][number]>,
  messagesById: ReadonlyMap<string, TurnDiagnosticsPayload['canonicalMessages'][number]>,
  runtime: TurnDiagnosticsPayload['runtime'],
  toolSchemasByName: ReadonlyMap<string, TurnDiagnosticsPayload['toolSchemas'][number]>,
): JsonValue {
  const systemInstructions = fragmentsById.get(call.preparedContext.systemPromptFragmentId)?.value ?? null;
  const toolDefinitions = call.preparedContext.toolNames.flatMap((name) => {
    const tool = toolSchemasByName.get(name);
    return tool ? [{ name: tool.name, description: tool.description, parameters: tool.parameters }] : [];
  });
  const messages = call.preparedContext.messageIds.flatMap((id, index) => {
    const message = messagesById.get(id);
    return message ? [{
      id: message.id,
      estimatedTokens: message.estimatedTokens,
      value: message.value,
      partProvenance: call.preparedContext.messagePartProvenance[index]!.map(provenanceJson),
    }] : [];
  });
  return {
    format: 'tenon.model-call-diagnostics/v1',
    runtime: {
      provider: runtime.provider,
      model: runtime.model,
      api: runtime.api,
      configuredBaseUrl: runtime.configuredBaseUrl,
      transportSelection: runtime.transportSelection,
      timeoutMs: runtime.timeoutMs,
      maxRetries: runtime.maxRetries,
      maxRetryDelayMs: runtime.maxRetryDelayMs,
      cacheRetention: runtime.cacheRetention,
    },
    request: {
      modelContext: {
        systemInstructions,
        toolDefinitions,
        messages,
      },
      providerPayload: materializeProviderRequest(call.request, fragmentsById),
      facts: {
        callIndex: call.index,
        requestedAt: call.requestedAt,
        protectedFromMessageIndex: call.protectedFromMessageIndex,
        estimatedInputTokens: call.estimatedInputTokens,
        inputTokenLimit: call.inputTokenLimit,
        reservedOutputTokens: call.reservedOutputTokens,
        commonPrefixMessageCount: call.commonPrefixMessageCount,
        requestFingerprint: call.requestFingerprint,
        cacheBreakpoints: call.cacheBreakpoints,
      },
    },
    response: {
      streamNoiseFrames: (call.streamNoiseFrames ?? []).map((frame) => ({
        arrivedAt: frame.arrivedAt,
        frameType: frame.frameType,
        snippet: frame.snippet,
      })),
      transport: call.transportResponse ? {
        headersReceivedAt: call.transportResponse.headersReceivedAt,
        httpStatus: call.transportResponse.httpStatus,
        requestId: call.transportResponse.requestId,
      } : null,
      model: call.response ? {
        receivedAt: call.response.receivedAt,
        stopReason: call.response.stopReason,
        errorMessage: call.response.errorMessage,
        usage: {
          input: call.response.usage.input,
          output: call.response.usage.output,
          cacheRead: call.response.usage.cacheRead,
          cacheWrite: call.response.usage.cacheWrite,
          cacheWrite1h: call.response.usage.cacheWrite1h,
          reasoning: call.response.usage.reasoning,
          totalTokens: call.response.usage.totalTokens,
          cost: {
            input: call.response.usage.cost.input,
            output: call.response.usage.cost.output,
            cacheRead: call.response.usage.cost.cacheRead,
            cacheWrite: call.response.usage.cost.cacheWrite,
            total: call.response.usage.cost.total,
          },
        },
        value: call.response.value,
      } : null,
    },
    limitations: {
      imageBytes: 'omitted-with-byte-length-and-sha256',
      secretHeaders: 'not-recorded',
      rawProviderResponseBody: 'not-recorded',
    },
  };
}

function defaultTimelineCallIndex(payload: TurnDiagnosticsPayload): number | null {
  if (payload.providerCalls.length === 0) return null;
  const exceptional = [...payload.providerCalls].reverse().find((call) => (
    call.response?.stopReason === 'error' || call.response?.stopReason === 'aborted'
  ));
  return exceptional?.index ?? payload.providerCalls.at(-1)!.index;
}

function interactionActivities(payload: TurnDiagnosticsPayload) {
  return payload.activities.filter((activity) => activity.type !== 'acceptedInput');
}

function timelineActivityKey(activity: TurnDiagnosticsActivity, index: number): string {
  switch (activity.type) {
    case 'acceptedInput': return `input:${activity.source}:${activity.acceptedAt}`;
    case 'modelCall': return `call:${activity.callIndex}`;
    case 'toolExecutionBatch': return `tools:${activity.sourceCallIndex}:${index}`;
    case 'providerRetry': return `retry:${activity.sourceCallIndex}:${activity.retryKind}:${activity.attempt}`;
    case 'contextCompaction': return `compaction:${activity.itemId}`;
  }
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
  if (provenance?.source === 'systemContext') return labels.systemContext;
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
    if (provenance?.source === 'systemContext') return '';
    return compactPreview(text);
  }
  const record = jsonRecord(value);
  if (record) {
    const name = stringProperty(record, 'name');
    if (name) return name;
  }
  return compactPreview(jsonText(value));
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
    case 'webSearch': return item.query || item.type;
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
