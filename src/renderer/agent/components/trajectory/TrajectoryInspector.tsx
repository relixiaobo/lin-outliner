import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type {
  JsonValue,
  ThreadTrajectoryDetailReadResponse,
  ThreadTrajectoryRecordDetail,
  ThreadTrajectoryRecordSummary,
  ThreadTrajectoryTimingSummary,
  ThreadTrajectoryUsageSummary,
  ThreadUserContent,
} from '../../../../core/agent/protocol';
import { api } from '../../../api/client';
import { useI18n, useT } from '../../../i18n/I18nProvider';
import { formatNumber } from '../../../ui/formatting';
import {
  BackIcon,
  CloseIcon,
  ICON_SIZE,
  LoaderIcon,
  OpenIcon,
} from '../../../ui/icons';
import { ReadOnlyCodeBlock } from '../../../ui/editor/CodeBlockSurface';
import { Button } from '../../../ui/primitives/Button';
import { EmptyState, ErrorState } from '../../../ui/primitives/FeedbackState';
import { trajectoryRecordRole, isStablePromptRecord } from './trajectoryModel';

type InspectorTab =
  | 'summary'
  | 'preview'
  | 'request'
  | 'raw'
  | 'systemPrompt'
  | 'tools'
  | 'input'
  | 'output'
  | 'schema';

interface TrajectoryInspectorProps {
  readonly onClose: () => void;
  readonly onOpenChildTrajectory: (threadId: string) => void;
  readonly record: ThreadTrajectoryRecordSummary;
  readonly threadId: string;
  readonly turnIndex: number;
}

interface ResizeDrag {
  readonly pointerId: number;
  readonly splitWidth: number;
  readonly startWidth: number;
  readonly startX: number;
}

const DETAILS_MIN_WIDTH = 320;
const DETAILS_MAX_WIDTH = 720;
const LEDGER_MIN_WIDTH = 280;
const DETAILS_RESIZE_STEP = 16;

export const TrajectoryInspector = memo(function TrajectoryInspector({
  onClose,
  onOpenChildTrajectory,
  record,
  threadId,
  turnIndex,
}: TrajectoryInspectorProps) {
  const t = useT();
  const rootRef = useRef<HTMLElement | null>(null);
  const resizeRef = useRef<ResizeDrag | null>(null);
  const requestSeqRef = useRef(0);
  const [detail, setDetail] = useState<ThreadTrajectoryDetailReadResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<InspectorTab>('summary');
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    setTab(isStablePromptRecord(record) ? 'systemPrompt' : 'summary');
  }, [record.id]);

  useEffect(() => {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    setDetail(null);
    setDetailError(null);
    setLoading(true);
    void api.agentCoreRequest('thread/trajectory/detail/read', { threadId, recordId: record.id })
      .then((response) => {
        if (requestSeqRef.current === seq) setDetail(response);
      })
      .catch((error) => {
        if (requestSeqRef.current === seq) setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (requestSeqRef.current === seq) setLoading(false);
      });
  }, [record.id, record.state, record.timing.completedAt, threadId]);

  const tabs = tabsForRecord(record, t.agent.trajectory);
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : tabs[0]!.id;
  const detailBody = detail?.detail ?? null;

  const resizeStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    const split = root?.parentElement;
    if (!root || !split) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: root.getBoundingClientRect().width,
      splitWidth: split.getBoundingClientRect().width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const resizeMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setWidth(clampDetailsWidth(
      drag.startWidth + drag.startX - event.clientX,
      drag.splitWidth,
    ));
  };

  const resizeEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <aside
      aria-label={t.agent.trajectory.inspector}
      className="thread-trajectory-inspector"
      id="thread-trajectory-inspector"
      ref={rootRef}
      style={width === null ? undefined : { width } as CSSProperties}
    >
      <button
        aria-controls="thread-trajectory-inspector"
        aria-label={t.agent.trajectory.resizeInspector}
        aria-orientation="vertical"
        className="thread-trajectory-inspector-resize"
        onDoubleClick={() => setWidth(null)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          const root = rootRef.current;
          const split = root?.parentElement;
          if (!root || !split) return;
          const direction = event.key === 'ArrowLeft' ? 1 : -1;
          setWidth(clampDetailsWidth(
            root.getBoundingClientRect().width + direction * DETAILS_RESIZE_STEP,
            split.getBoundingClientRect().width,
          ));
          event.preventDefault();
        }}
        onPointerCancel={resizeEnd}
        onPointerDown={resizeStart}
        onPointerMove={resizeMove}
        onPointerUp={resizeEnd}
        role="separator"
        title={t.agent.trajectory.resizeInspector}
        type="button"
      />
      <header className="thread-trajectory-inspector-header">
        <button
          aria-label={t.agent.trajectory.backToLedger}
          className="thread-trajectory-inspector-back"
          onClick={onClose}
          title={t.agent.trajectory.backToLedger}
          type="button"
        >
          <BackIcon size={ICON_SIZE.menu} />
        </button>
        <div className="thread-trajectory-inspector-title">
          <span className={`thread-trajectory-kind is-${record.kind}`}>{trajectoryRecordRole(record)}</span>
          <span>{t.agent.trajectory.turnStep({ turn: turnIndex + 1, step: record.sequence + 1 })}</span>
        </div>
        <button
          aria-label={t.agent.trajectory.closeInspector}
          className="thread-trajectory-inspector-close"
          onClick={onClose}
          title={t.agent.trajectory.closeInspector}
          type="button"
        >
          <CloseIcon size={ICON_SIZE.menu} />
        </button>
      </header>
      <div className="thread-trajectory-tabs" role="tablist" aria-label={t.agent.trajectory.inspectorTabs}>
        {tabs.map((entry) => (
          <button
            aria-selected={activeTab === entry.id}
            className={activeTab === entry.id ? 'is-selected' : ''}
            key={entry.id}
            onClick={() => setTab(entry.id)}
            role="tab"
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="thread-trajectory-inspector-scroll" role="tabpanel">
        {loading && !detailBody ? (
          <EmptyState icon={LoaderIcon} loading title={t.agent.trajectory.loadingDetail} />
        ) : null}
        {detailError ? <ErrorState message={detailError} /> : null}
        {detailBody ? (
          <InspectorBody
            detail={detailBody}
            onOpenChildTrajectory={onOpenChildTrajectory}
            record={record}
            tab={activeTab}
          />
        ) : null}
      </div>
    </aside>
  );
});

function InspectorBody({
  detail,
  onOpenChildTrajectory,
  record,
  tab,
}: {
  readonly detail: ThreadTrajectoryRecordDetail;
  readonly onOpenChildTrajectory: (threadId: string) => void;
  readonly record: ThreadTrajectoryRecordSummary;
  readonly tab: InspectorTab;
}) {
  const t = useT();
  if (tab === 'raw') return <JsonEvidence title={t.agent.trajectory.rawEvidence} value={detail} />;
  if (tab === 'systemPrompt') {
    return <TextEvidence title={t.agent.trajectory.systemPrompt} text={stablePromptText(detail)} />;
  }
  if (tab === 'tools') {
    return <JsonEvidence title={t.agent.trajectory.tools} value={stablePromptTools(detail)} />;
  }
  if (tab === 'preview') {
    return <PreviewEvidence detail={detail} record={record} />;
  }
  if (tab === 'request') {
    return <JsonEvidence title={t.agent.trajectory.request} value={providerRequest(detail)} />;
  }
  if (tab === 'input') {
    return <JsonEvidence title={t.agent.trajectory.input} value={toolInput(detail)} />;
  }
  if (tab === 'output') {
    return <TextEvidence title={t.agent.trajectory.output} text={toolOutput(detail)} />;
  }
  if (tab === 'schema') {
    return <JsonEvidence title={t.agent.trajectory.schema} value={toolSchema(detail)} />;
  }
  return (
    <SummaryEvidence
      detail={detail}
      onOpenChildTrajectory={onOpenChildTrajectory}
      record={record}
    />
  );
}

function SummaryEvidence({
  detail,
  onOpenChildTrajectory,
  record,
}: {
  readonly detail: ThreadTrajectoryRecordDetail;
  readonly onOpenChildTrajectory: (threadId: string) => void;
  readonly record: ThreadTrajectoryRecordSummary;
}) {
  const t = useT();
  const source = detail.kind === 'assistant'
    ? t.agent.trajectory.requestNumber({ index: detail.providerCallIndex + 1 })
    : detail.kind === 'context'
      ? contextEvidenceSource(detail, record)
    : record.subtitle ?? evidenceSource(record);
  return (
    <div className="thread-trajectory-inspector-body is-summary">
      <FactList entries={[
        [t.agent.trajectory.source, source],
        [t.agent.trajectory.status, stateLabel(record.state)],
        [t.agent.trajectory.model, `${detail.turn.modelProvider} · ${detail.turn.model}`],
        [t.agent.trajectory.duration, durationLabel(record.timing)],
      ]} />
      {record.usage ? (
        <InspectorSection title={t.agent.trajectory.usage}>
          <UsageFacts usage={record.usage} />
        </InspectorSection>
      ) : null}
      <InspectorSection title={t.agent.trajectory.preview}>
        <PreviewEvidence detail={detail} record={record} compact />
      </InspectorSection>
      <InspectorSection title={t.agent.trajectory.requestTiming}>
        <TimingFacts timing={record.timing} usage={record.usage} />
      </InspectorSection>
      <AvailabilityList record={record} />
      {detail.kind === 'delegation' && detail.childThreadId ? (
        <Button
          onClick={() => onOpenChildTrajectory(detail.childThreadId!)}
          type="button"
          variant="secondary"
        >
          <OpenIcon size={ICON_SIZE.menu} />
          {t.agent.trajectory.openChildTrajectory}
        </Button>
      ) : null}
    </div>
  );
}

function PreviewEvidence({
  compact = false,
  detail,
  record,
}: {
  readonly compact?: boolean;
  readonly detail: ThreadTrajectoryRecordDetail;
  readonly record: ThreadTrajectoryRecordSummary;
}) {
  const t = useT();
  const text = previewText(detail, record);
  const className = compact
    ? 'thread-trajectory-preview is-compact'
    : 'thread-trajectory-inspector-body thread-trajectory-preview';
  return text ? (
    <div className={className}>
      {text}
    </div>
  ) : (
    <p className="thread-trajectory-note">{t.agent.trajectory.noRetainedEvidence}</p>
  );
}

function InspectorSection({ children, title }: { readonly children: ReactNode; readonly title: string }) {
  return (
    <section className="thread-trajectory-inspector-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function FactList({ entries }: { readonly entries: readonly (readonly [string, string])[] }) {
  return (
    <dl className="thread-trajectory-facts">
      {entries.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  );
}

function UsageFacts({ usage }: { readonly usage: ThreadTrajectoryUsageSummary }) {
  const t = useT();
  return <FactList entries={[
    [t.agent.trajectory.inputTokens, formatNumber(usage.input)],
    [t.agent.trajectory.outputTokens, formatNumber(usage.output)],
    [t.agent.trajectory.reasoningTokens, usage.reasoning === null ? '-' : formatNumber(usage.reasoning)],
    [t.agent.trajectory.totalTokens, formatNumber(usage.totalTokens)],
    [t.agent.trajectory.cacheRead, formatNumber(usage.cacheRead)],
    [t.agent.trajectory.cost, usage.costUsd === null ? '-' : `$${usage.costUsd.toFixed(6)}`],
  ]} />;
}

function TimingFacts({
  timing,
  usage,
}: {
  readonly timing: ThreadTrajectoryTimingSummary;
  readonly usage: ThreadTrajectoryUsageSummary | null;
}) {
  const t = useT();
  const { locale } = useI18n();
  const generationMs = timing.firstTokenAt === null || timing.completedAt === null
    ? null
    : Math.max(0, timing.completedAt - timing.firstTokenAt);
  const throughput = generationMs && usage
    ? `${(usage.output / (generationMs / 1_000)).toFixed(1)} tok/s`
    : '-';
  return <FactList entries={[
    [t.agent.trajectory.started, timing.startedAt === null ? '-' : formatTimestamp(timing.startedAt, locale)],
    [t.agent.trajectory.totalDuration, timing.durationMs === null ? '-' : formatDuration(timing.durationMs)],
    [t.agent.trajectory.firstToken, timing.startedAt === null || timing.firstTokenAt === null
      ? '-'
      : formatDuration(Math.max(0, timing.firstTokenAt - timing.startedAt))],
    [t.agent.trajectory.generation, generationMs === null ? '-' : formatDuration(generationMs)],
    [t.agent.trajectory.throughput, throughput],
  ]} />;
}

function AvailabilityList({ record }: { readonly record: ThreadTrajectoryRecordSummary }) {
  if (record.availability.length === 0) return null;
  return (
    <div className="thread-trajectory-availability">
      {record.availability.map((entry) => (
        <p key={`${entry.reason}:${entry.message}`}>
          <strong>{entry.reason}</strong>
          <span>{entry.message}</span>
        </p>
      ))}
    </div>
  );
}

function JsonEvidence({ title, value }: { readonly title: string; readonly value: unknown }) {
  const t = useT();
  return (
    <div className="thread-trajectory-inspector-body">
      <h4>{title}</h4>
      {value === null || value === undefined ? (
        <p className="thread-trajectory-note">{t.agent.trajectory.noRetainedEvidence}</p>
      ) : (
        <ReadOnlyCodeBlock
          className="thread-trajectory-code"
          code={JSON.stringify(value, null, 2)}
          language="json"
        />
      )}
    </div>
  );
}

function TextEvidence({ title, text }: { readonly title: string; readonly text: string | null }) {
  const t = useT();
  return (
    <div className="thread-trajectory-inspector-body">
      <h4>{title}</h4>
      {text ? (
        <div className="thread-trajectory-preview">{text}</div>
      ) : (
        <p className="thread-trajectory-note">{t.agent.trajectory.noRetainedEvidence}</p>
      )}
    </div>
  );
}

function tabsForRecord(
  record: ThreadTrajectoryRecordSummary,
  t: ReturnType<typeof useT>['agent']['trajectory'],
): readonly { readonly id: InspectorTab; readonly label: string }[] {
  if (isStablePromptRecord(record)) return [
    { id: 'systemPrompt', label: t.systemPrompt },
    { id: 'tools', label: t.tools },
    { id: 'raw', label: t.raw },
  ];
  if (record.kind === 'tool') return [
    { id: 'summary', label: t.tab.summary },
    { id: 'input', label: t.input },
    { id: 'output', label: t.output },
    { id: 'schema', label: t.schema },
    { id: 'raw', label: t.raw },
  ];
  if (record.kind === 'input' || record.kind === 'assistant') return [
    { id: 'summary', label: t.tab.summary },
    { id: 'preview', label: t.preview },
    { id: 'request', label: t.request },
    { id: 'raw', label: t.raw },
  ];
  if (record.kind === 'context') return [
    { id: 'summary', label: t.tab.summary },
    { id: 'preview', label: t.preview },
    { id: 'raw', label: t.raw },
  ];
  return [
    { id: 'summary', label: t.tab.summary },
    { id: 'preview', label: t.preview },
    { id: 'raw', label: t.raw },
  ];
}

function previewText(
  detail: ThreadTrajectoryRecordDetail,
  record: ThreadTrajectoryRecordSummary,
): string | null {
  if (detail.kind === 'assistant') {
    return semanticText(detail.diagnostics?.providerCall?.response ?? null) ?? record.preview;
  }
  if (detail.kind === 'input') {
    return userMessageText(detail.message?.content ?? null) ?? record.preview;
  }
  if (detail.kind === 'context') {
    return detail.modelContextText
      ?? contextPayloadText(detail.payload)
      ?? semanticText(detail.payload)
      ?? record.preview
      ?? record.title;
  }
  if (detail.kind === 'tool') return detail.outputText ?? record.preview;
  if (detail.kind === 'delegation') return detail.outputText ?? record.preview;
  return record.preview ?? record.title;
}

function providerRequest(detail: ThreadTrajectoryRecordDetail): JsonValue | null {
  return 'diagnostics' in detail ? detail.diagnostics?.providerCall?.request ?? null : null;
}

function userMessageText(content: readonly ThreadUserContent[] | null): string | null {
  if (!content) return null;
  const text = content.map(userContentText).filter(Boolean).join('\n');
  return text || null;
}

function userContentText(content: ThreadUserContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'attachment') return content.name;
  return content.note ?? content.nodeId;
}

function contextEvidenceSource(
  detail: Extract<ThreadTrajectoryRecordDetail, { readonly kind: 'context' }>,
  record: ThreadTrajectoryRecordSummary,
): string {
  if (isJsonObject(detail.payload) && typeof detail.payload.kind === 'string') return detail.payload.kind;
  return record.subtitle ?? evidenceSource(record);
}

function contextPayloadText(value: JsonValue | null): string | null {
  if (!isJsonObject(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'turnEnvironment':
      return turnEnvironmentText(value);
    case 'userView':
      return userViewText(value);
    case 'additionalContext':
      return additionalContextText(value);
    case 'referencedResources':
      return referencedResourcesText(value);
    case 'skillCatalog':
      return catalogText(value, 'skill');
    case 'roleCatalog':
      return catalogText(value, 'role');
    case 'skillInvocation':
      return skillInvocationText(value);
    case 'toolOutputProjection':
      return toolOutputProjectionText(value);
    case 'inheritedContext':
      return inheritedContextText(value);
    case 'compactionSummary':
      return stringField(value, 'text');
    case 'compactionInstructions':
      return contextEntriesText(arrayField(value, 'entries'));
    case 'toolCallArguments':
      return jsonValueText(value.value);
    case 'compactionRestoredState':
      return restoredStateText(value);
    default:
      return null;
  }
}

function turnEnvironmentText(payload: JsonObject): string | null {
  const lines = [
    ['accepted_at', stringField(payload, 'utcInstant')],
    ['local_date', stringField(payload, 'localDate')],
    ['local_time', stringField(payload, 'localTime')],
    ['timezone', stringField(payload, 'timeZone')],
    ['utc_offset_minutes', jsonValueText(payload.utcOffsetMinutes)],
    ['locale', stringField(payload, 'locale')],
    ['working_directory', stringField(payload, 'workingDirectory')],
    ['conversation_mode', stringField(payload, 'conversationMode')],
    ['execution_mode', stringField(payload, 'executionMode')],
    ['reply_identity', stringField(payload, 'replyIdentity') ?? 'none'],
    ['today_node_id', stringField(payload, 'todayNodeId') ?? 'none'],
    ['today_node_title', stringField(payload, 'todayNodeTitle') ?? 'none'],
  ].map(([label, text]) => text ? `${label}=${text}` : null)
    .filter((line): line is string => line !== null);
  return lines.join('\n') || null;
}

function userViewText(payload: JsonObject): string | null {
  const lines = [
    `mode=${stringField(payload, 'mode') ?? 'unknown'}`,
    `active_panel=${stringField(payload, 'activePanelId') ?? 'none'}`,
    `focused_panel=${stringField(payload, 'focusedPanelId') ?? 'none'}`,
    `focus_surface=${stringField(payload, 'focusSurface') ?? 'none'}`,
  ];
  const focused = nodeSnapshotText(objectField(payload, 'focusedNode'));
  if (focused) lines.push(`focused_node=${focused}`);
  const selected = nodeListText(arrayField(payload, 'selectedNodes'));
  if (selected) lines.push(`selected_nodes=${selected}`);
  const referenced = nodeListText(arrayField(payload, 'referencedNodes'));
  if (referenced) lines.push(`referenced_nodes=${referenced}`);
  const panels = arrayField(payload, 'panels');
  if (panels.length > 0) {
    lines.push(`panels=${panels.length}`);
    for (const panel of panels) {
      if (!isJsonObject(panel)) continue;
      lines.push(panelText(panel));
    }
  }
  if (payload.truncated === true) lines.push('truncated=true');
  return lines.join('\n') || null;
}

function panelText(panel: JsonObject): string {
  const title = stringField(panel, 'rootTitle') ?? stringField(panel, 'rootNodeId') ?? 'unknown';
  const flags = [
    panel.active === true ? 'active' : null,
    panel.focused === true ? 'focused' : null,
    panel.visibleOutlineTruncated === true ? 'visible_outline_truncated' : null,
  ].filter(Boolean).join(' ');
  const lines = [
    `- panel=${stringField(panel, 'panelId') ?? 'unknown'} root=${title}${flags ? ` ${flags}` : ''}`,
  ];
  const breadcrumb = nodeListText(arrayField(panel, 'breadcrumb'));
  if (breadcrumb) lines.push(`  breadcrumb=${breadcrumb}`);
  const outline = arrayField(panel, 'visibleOutline');
  if (outline.length > 0) {
    lines.push('  visible_outline:');
    for (const node of outline) {
      if (!isJsonObject(node)) continue;
      const depth = typeof node.depth === 'number' ? node.depth : 0;
      const prefix = '  '.repeat(Math.max(0, depth + 2));
      const state = [
        node.focused === true ? 'focused' : null,
        node.collapsed === true ? 'collapsed' : null,
        typeof node.childCount === 'number' ? `children=${node.childCount}` : null,
      ].filter(Boolean).join(' ');
      lines.push(`${prefix}- ${stringField(node, 'title') ?? stringField(node, 'nodeId') ?? 'unknown'}${state ? ` ${state}` : ''}`);
    }
  }
  return lines.join('\n');
}

function additionalContextText(payload: JsonObject): string | null {
  const sections: string[] = [];
  const turnEntries = contextEntriesText(arrayField(payload, 'turnEntries'));
  if (turnEntries) sections.push(`turn_entries:\n${turnEntries}`);
  const threadState = Array.isArray(payload.threadState)
    ? contextEntriesText(payload.threadState)
    : null;
  if (threadState) sections.push(`thread_state:\n${threadState}`);
  return sections.join('\n\n') || null;
}

function referencedResourcesText(payload: JsonObject): string | null {
  const resources = arrayField(payload, 'resources');
  if (resources.length === 0) return null;
  const lines = [`resources=${resources.length}`];
  for (const resource of resources) {
    if (!isJsonObject(resource)) continue;
    const title = stringField(resource, 'title') ?? stringField(resource, 'nodeId') ?? 'unknown';
    const state = [
      `type=${stringField(resource, 'nodeType') ?? 'unknown'}`,
      resource.inlineImage === true ? 'inline_image=true' : null,
      resource.unavailableReason ? `unavailable=${jsonValueText(resource.unavailableReason)}` : null,
      resource.contentTruncated === true ? 'content_truncated=true' : null,
    ].filter(Boolean).join(' ');
    lines.push(`- ${title} ${state}`.trim());
    const breadcrumb = nodeListText(arrayField(resource, 'breadcrumb'));
    if (breadcrumb) lines.push(`  breadcrumb=${breadcrumb}`);
    const content = stringField(resource, 'content');
    if (content) lines.push(`  content:\n${indent(content, '    ')}`);
  }
  return lines.join('\n') || null;
}

function catalogText(payload: JsonObject, label: 'skill' | 'role'): string | null {
  const entries = arrayField(payload, 'entries');
  const lines = [
    `mode=${stringField(payload, 'mode') ?? 'unknown'}`,
    `${label}s=${entries.length}`,
  ];
  const previous = stringField(payload, 'previousCatalogHash');
  if (previous) lines.push(`previous_catalog_hash=${previous}`);
  const current = stringField(payload, 'catalogHash');
  if (current) lines.push(`catalog_hash=${current}`);
  for (const entry of entries) {
    if (!isJsonObject(entry)) continue;
    const name = stringField(entry, 'name') ?? 'unknown';
    const displayName = stringField(entry, 'displayName');
    const fields = [
      `name=${name}`,
      `change=${stringField(entry, 'change') ?? 'unknown'}`,
      `source=${stringField(entry, 'source') ?? 'unknown'}`,
      displayName && displayName !== name ? `display_name=${displayName}` : null,
    ].filter(Boolean).join(' ');
    lines.push(`- ${fields}`);
    const description = stringField(entry, 'description');
    if (description) lines.push(`  description=${description}`);
  }
  return lines.join('\n') || null;
}

function skillInvocationText(payload: JsonObject): string | null {
  const lines = [
    `name=${stringField(payload, 'name') ?? 'unknown'}`,
    `source=${stringField(payload, 'source') ?? 'unknown'}`,
    `execution=${stringField(payload, 'execution') ?? 'unknown'}`,
    `invocation_source=${stringField(payload, 'invocationSource') ?? 'unknown'}`,
  ];
  const argumentsText = stringField(payload, 'arguments');
  if (argumentsText) lines.push(`arguments:\n${indent(argumentsText, '  ')}`);
  const instructions = stringField(payload, 'instructions');
  if (instructions) lines.push(`instructions:\n${indent(instructions, '  ')}`);
  const constraints = objectField(payload, 'constraints');
  if (constraints) lines.push(`constraints=${JSON.stringify(constraints)}`);
  return lines.join('\n') || null;
}

function toolOutputProjectionText(payload: JsonObject): string | null {
  const ref = objectField(payload, 'outputRef');
  const projection = objectField(payload, 'projection');
  const lines = [];
  if (ref) {
    lines.push(`output=${stringField(ref, 'summary') ?? stringField(ref, 'id') ?? 'unknown'}`);
    const mimeType = stringField(ref, 'mimeType');
    if (mimeType) lines.push(`mime_type=${mimeType}`);
  }
  if (projection) {
    const type = stringField(projection, 'type') ?? 'unknown';
    lines.push(`projection=${type}`);
    const text = stringField(projection, 'text');
    if (text) lines.push(`text:\n${indent(text, '  ')}`);
  }
  return lines.join('\n') || null;
}

function inheritedContextText(payload: JsonObject): string | null {
  const lines = [
    `source_thread=${stringField(payload, 'sourceThreadId') ?? 'unknown'}`,
    `requested_turns=${jsonValueText(payload.requestedTurns) ?? 'unknown'}`,
  ];
  const covered = objectField(payload, 'coveredThrough');
  if (covered) {
    lines.push(`covered_through=${stringField(covered, 'turnId') ?? 'unknown'}/${stringField(covered, 'itemId') ?? 'unknown'}`);
  }
  const turns = arrayField(payload, 'turns');
  lines.push(`turns=${turns.length}`);
  for (const turn of turns) {
    if (!isJsonObject(turn)) continue;
    lines.push(`- turn=${stringField(turn, 'id') ?? 'unknown'} status=${stringField(turn, 'status') ?? 'unknown'}`);
    for (const item of arrayField(turn, 'items')) {
      const text = semanticText(item);
      if (text) lines.push(`  - ${text}`);
    }
  }
  return lines.join('\n') || null;
}

function restoredStateText(payload: JsonObject): string | null {
  return [
    `skill_catalog_hash=${stringField(payload, 'skillCatalogHash') ?? 'none'}`,
    `announced_skills=${arrayField(payload, 'announcedSkills').length}`,
    `active_skills=${arrayField(payload, 'activeSkills').length}`,
    `role_catalog_hash=${stringField(payload, 'roleCatalogHash') ?? 'none'}`,
    `announced_roles=${arrayField(payload, 'announcedRoles').length}`,
    `active_observations=${arrayField(payload, 'activeObservations').length}`,
    `degradations=${arrayField(payload, 'degradations').length}`,
  ].join('\n');
}

function contextEntriesText(entries: readonly JsonValue[]): string | null {
  const lines = entries.flatMap((entry) => {
    if (!isJsonObject(entry)) return [];
    const key = stringField(entry, 'key') ?? 'unknown';
    const source = stringField(entry, 'source') ?? 'unknown';
    const authority = stringField(entry, 'authority') ?? 'unknown';
    const purpose = stringField(entry, 'purpose') ?? 'unknown';
    const text = stringField(entry, 'text');
    return text
      ? [`- key=${key} source=${source} authority=${authority} purpose=${purpose}\n${indent(text, '  ')}`]
      : [`- key=${key} source=${source} authority=${authority} purpose=${purpose}`];
  });
  return lines.join('\n') || null;
}

function nodeListText(nodes: readonly JsonValue[]): string | null {
  const text = nodes.flatMap((node) => {
    const value = isJsonObject(node) ? nodeSnapshotText(node) : null;
    return value ? [value] : [];
  }).join(' > ');
  return text || null;
}

function nodeSnapshotText(node: JsonObject | null): string | null {
  if (!node) return null;
  const title = stringField(node, 'title') ?? stringField(node, 'rootTitle') ?? stringField(node, 'nodeId');
  if (!title) return null;
  const nodeId = stringField(node, 'nodeId') ?? stringField(node, 'rootNodeId');
  return nodeId && nodeId !== title ? `${title} (${nodeId})` : title;
}

type JsonObject = { readonly [key: string]: JsonValue };

function objectField(value: JsonObject, key: string): JsonObject | null {
  const field = value[key];
  return isJsonObject(field) ? field : null;
}

function arrayField(value: JsonObject, key: string): readonly JsonValue[] {
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function stringField(value: JsonObject, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function jsonValueText(value: JsonValue | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function semanticText(value: JsonValue | null): string | null {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    const joined = (value as readonly JsonValue[]).map(semanticText).filter(Boolean).join('\n');
    return joined || null;
  }
  if (!isJsonObject(value)) return null;
  for (const key of ['outputText', 'output_text', 'text', 'content', 'summary', 'value']) {
    const candidate = value[key];
    const text = semanticText(candidate ?? null);
    if (text) return text;
  }
  return null;
}

function stablePromptText(detail: ThreadTrajectoryRecordDetail): string | null {
  if (detail.kind !== 'context' || !isJsonObject(detail.payload)) return null;
  const stablePrompt = detail.payload.stablePrompt;
  if (!isJsonObject(stablePrompt)) return null;
  const blocks = stablePrompt.blocks;
  if (!Array.isArray(blocks)) return null;
  const text = (blocks as readonly JsonValue[]).flatMap((block) => {
    if (!isJsonObject(block)) return [];
    return typeof block.text === 'string' ? [block.text] : [];
  }).join('\n\n');
  return text || null;
}

function stablePromptTools(detail: ThreadTrajectoryRecordDetail): JsonValue | null {
  if (detail.kind !== 'context' || !isJsonObject(detail.payload)) return null;
  return detail.payload.toolSchemas ?? null;
}

function isJsonObject(value: JsonValue | null): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolInput(detail: ThreadTrajectoryRecordDetail): JsonValue | null {
  return detail.kind === 'tool' ? detail.input : null;
}

function toolOutput(detail: ThreadTrajectoryRecordDetail): string | null {
  return detail.kind === 'tool' ? detail.outputText : null;
}

function toolSchema(detail: ThreadTrajectoryRecordDetail): JsonValue | null {
  return detail.kind === 'tool' ? detail.schema : null;
}

function evidenceSource(record: ThreadTrajectoryRecordSummary): string {
  const evidence = record.primaryEvidence;
  if (evidence.type === 'providerCall') return `Request #${evidence.callIndex + 1}`;
  if (evidence.type === 'diagnosticActivity') return evidence.activityType;
  if (evidence.type === 'toolExecution') return evidence.callId;
  if (evidence.type === 'threadItem') return record.title;
  if (evidence.type === 'stablePrompt') return 'Stable prompt';
  if (evidence.type === 'subagent') return 'Child Thread';
  return 'Turn';
}

function durationLabel(timing: ThreadTrajectoryTimingSummary): string {
  if (timing.durationMs !== null) return formatDuration(timing.durationMs);
  return timing.startedAt === null ? 'Not recorded' : 'Running';
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

function formatTimestamp(timestamp: number, locale: string): string {
  const date = new Date(timestamp);
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)}.${milliseconds}`;
}

function stateLabel(state: ThreadTrajectoryRecordSummary['state']): string {
  if (state === 'completed') return 'Completed';
  if (state === 'running') return 'Running';
  if (state === 'failed') return 'Failed';
  if (state === 'interrupted') return 'Interrupted';
  if (state === 'partial') return 'Partial';
  return 'Pending';
}

function clampDetailsWidth(width: number, splitWidth: number): number {
  const maximum = Math.max(DETAILS_MIN_WIDTH, Math.min(DETAILS_MAX_WIDTH, splitWidth - LEDGER_MIN_WIDTH));
  return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), maximum));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
