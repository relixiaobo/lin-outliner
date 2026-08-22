import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type {
  JsonValue,
  ThreadImageArtifactReference,
  ThreadTrajectoryDetailReadResponse,
  ThreadTrajectoryModelInputPart,
  ThreadTrajectoryModelOutputPart,
  ThreadTrajectoryRecordDetail,
  ThreadTrajectoryRecordSummary,
  ThreadTrajectoryTimingSummary,
  ThreadTrajectoryUsageSummary,
} from '../../../../core/agent/protocol';
import type { PreviewTarget } from '../../../../core/preview';
import { api } from '../../../api/client';
import { useI18n, useT } from '../../../i18n/I18nProvider';
import { formatNumber } from '../../../ui/formatting';
import { usePreviewObjectUrl } from '../../../ui/preview/usePreviewObjectUrl';
import {
  BackIcon,
  ChevronRightIcon,
  CloseIcon,
  GenericToolIcon,
  ICON_SIZE,
  ImageIcon,
  LoaderIcon,
  OpenIcon,
} from '../../../ui/icons';
import { ReadOnlyCodeBlock } from '../../../ui/editor/CodeBlockSurface';
import { Button } from '../../../ui/primitives/Button';
import { EmptyState, ErrorState } from '../../../ui/primitives/FeedbackState';
import { ThreadMarkdown } from '../ThreadMarkdown';
import {
  trajectoryRecordLabel,
  trajectoryRecordKindClass,
  trajectoryRecordMeta,
  trajectoryRecordRole,
  isStablePromptRecord,
  isToolCatalogRecord,
  type TrajectoryLabels,
} from './trajectoryModel';

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
  readonly onOpenRecord: (recordId: string) => void;
  readonly record: ThreadTrajectoryRecordSummary;
  readonly threadId: string;
  readonly toolCallRecordIds: ReadonlyMap<string, string>;
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
  onOpenRecord,
  record,
  threadId,
  toolCallRecordIds,
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
    setTab(isStablePromptRecord(record) ? 'systemPrompt' : isToolCatalogRecord(record) ? 'tools' : 'summary');
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

  const detailBody = detail?.detail ?? null;
  const resolvedRecord = detail?.record?.id === record.id ? detail.record : record;
  const tabs = tabsForRecord(resolvedRecord, t.agent.trajectory);
  const activeTab = tabs.some((entry) => entry.id === tab) ? tab : tabs[0]!.id;

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
          <span className={`thread-trajectory-kind ${trajectoryRecordKindClass(resolvedRecord)}`}>
            {trajectoryRecordRole(resolvedRecord, t.agent.trajectory)}
          </span>
          <span>{t.agent.trajectory.turnStep({
            turn: resolvedRecord.turnIndex + 1,
            step: resolvedRecord.stepIndex + 1,
          })}</span>
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
          <>
            <InspectorBody
              detail={detailBody}
              onOpenChildTrajectory={onOpenChildTrajectory}
              onOpenRecord={onOpenRecord}
              record={resolvedRecord}
              tab={activeTab}
              threadId={threadId}
              toolCallRecordIds={toolCallRecordIds}
            />
            <AvailabilityList record={resolvedRecord} />
          </>
        ) : null}
      </div>
    </aside>
  );
});

function InspectorBody({
  detail,
  onOpenChildTrajectory,
  onOpenRecord,
  record,
  tab,
  threadId,
  toolCallRecordIds,
}: {
  readonly detail: ThreadTrajectoryRecordDetail;
  readonly onOpenChildTrajectory: (threadId: string) => void;
  readonly onOpenRecord: (recordId: string) => void;
  readonly record: ThreadTrajectoryRecordSummary;
  readonly tab: InspectorTab;
  readonly threadId: string;
  readonly toolCallRecordIds: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const imageAttachments = modelImageAttachments(detail);
  if (tab === 'raw') {
    const parts = modelParts(detail);
    return (
      <div className="thread-trajectory-inspector-body is-evidence-page">
        {parts ? (
          <RawPartsEvidence
            imageAttachments={imageAttachments}
            onOpenRecord={onOpenRecord}
            parts={parts}
            threadId={threadId}
            toolCallRecordIds={toolCallRecordIds}
          />
        ) : null}
        <JsonEvidenceContent title={t.agent.trajectory.rawEvidence} value={detail} />
      </div>
    );
  }
  if (tab === 'systemPrompt') {
    return <RawTextEvidence title={t.agent.trajectory.systemPrompt} text={stablePromptText(detail)} />;
  }
  if (tab === 'tools') {
    return <JsonEvidence title={t.agent.trajectory.tools} value={stablePromptTools(detail)} />;
  }
  if (tab === 'preview') {
    return (
      <PreviewEvidence
        detail={detail}
        imageAttachments={imageAttachments}
        onOpenRecord={onOpenRecord}
        threadId={threadId}
        toolCallRecordIds={toolCallRecordIds}
      />
    );
  }
  if (tab === 'request') {
    return <JsonEvidence title={t.agent.trajectory.request} value={providerRequest(detail)} />;
  }
  if (tab === 'input') {
    return <JsonEvidence title={t.agent.trajectory.input} value={toolInput(detail)} />;
  }
  if (tab === 'output') {
    return <RawTextEvidence title={t.agent.trajectory.output} text={toolOutput(detail)} />;
  }
  if (tab === 'schema') {
    return <JsonEvidence title={t.agent.trajectory.schema} value={toolSchema(detail)} />;
  }
  return (
    <SummaryEvidence
      detail={detail}
      imageAttachments={imageAttachments}
      onOpenChildTrajectory={onOpenChildTrajectory}
      onOpenRecord={onOpenRecord}
      record={record}
      threadId={threadId}
      toolCallRecordIds={toolCallRecordIds}
    />
  );
}

function SummaryEvidence({
  detail,
  imageAttachments,
  onOpenChildTrajectory,
  onOpenRecord,
  record,
  threadId,
  toolCallRecordIds,
}: {
  readonly detail: ThreadTrajectoryRecordDetail;
  readonly imageAttachments: ReadonlyMap<string, TrajectoryImageAttachment>;
  readonly onOpenChildTrajectory: (threadId: string) => void;
  readonly onOpenRecord: (recordId: string) => void;
  readonly record: ThreadTrajectoryRecordSummary;
  readonly threadId: string;
  readonly toolCallRecordIds: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const source = detail.kind === 'assistant'
    ? t.agent.trajectory.requestNumber({ index: detail.providerCallIndex + 1 })
    : detail.kind === 'context'
      ? contextEvidenceSource(detail, record, t.agent.trajectory)
    : trajectoryRecordMeta(record, t.agent.trajectory) ?? evidenceSource(record, t.agent.trajectory);
  return (
    <div className="thread-trajectory-inspector-body is-summary">
      <FactList entries={[
        [t.agent.trajectory.source, source],
        [t.agent.trajectory.status, stateLabel(record.state, t.agent.trajectory)],
        [t.agent.trajectory.model, `${detail.turn.modelProvider} · ${detail.turn.model}`],
        [t.agent.trajectory.duration, durationLabel(record.timing, t.agent.trajectory)],
      ]} />
      {record.usage ? (
        <InspectorSection title={t.agent.trajectory.usage}>
          <UsageFacts usage={record.usage} />
        </InspectorSection>
      ) : null}
      <InspectorSection title={t.agent.trajectory.preview}>
        <PreviewEvidence
          detail={detail}
          imageAttachments={imageAttachments}
          compact
          onOpenRecord={onOpenRecord}
          threadId={threadId}
          toolCallRecordIds={toolCallRecordIds}
        />
      </InspectorSection>
      <InspectorSection title={t.agent.trajectory.requestTiming}>
        <TimingFacts timing={record.timing} usage={record.usage} />
      </InspectorSection>
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
  imageAttachments,
  onOpenRecord,
  threadId,
  toolCallRecordIds,
}: {
  readonly compact?: boolean;
  readonly detail: ThreadTrajectoryRecordDetail;
  readonly imageAttachments: ReadonlyMap<string, TrajectoryImageAttachment>;
  readonly onOpenRecord: (recordId: string) => void;
  readonly threadId: string;
  readonly toolCallRecordIds: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const parts = modelParts(detail);
  const className = compact
    ? 'thread-trajectory-preview is-compact'
    : 'thread-trajectory-inspector-body thread-trajectory-preview';
  if (parts) {
    return (
      <ModelPartsPreview
        className={className}
        compact={compact}
        imageAttachments={imageAttachments}
        onOpenRecord={onOpenRecord}
        parts={parts}
        plainText={detail.kind === 'input'}
        threadId={threadId}
        toolCallRecordIds={toolCallRecordIds}
      />
    );
  }
  const text = previewText(detail);
  if (text && !compact && detail.kind === 'context') {
    return (
      <div className={className}>
        <RawEvidenceBlock code={text} language="text" />
      </div>
    );
  }
  return text ? (
    <div className={className}>
      {text}
    </div>
  ) : (
    <p className="thread-trajectory-note">{t.agent.trajectory.noRetainedEvidence}</p>
  );
}

type TrajectoryModelPart = ThreadTrajectoryModelInputPart | ThreadTrajectoryModelOutputPart;

interface TrajectoryImageAttachment {
  readonly artifactRef: ThreadImageArtifactReference;
  readonly name: string;
}

function modelParts(detail: ThreadTrajectoryRecordDetail): readonly TrajectoryModelPart[] | null {
  if (detail.kind === 'input') return detail.modelInputParts;
  if (detail.kind === 'assistant') return detail.modelOutputParts;
  return null;
}

function modelImageAttachments(
  detail: ThreadTrajectoryRecordDetail,
): ReadonlyMap<string, TrajectoryImageAttachment> {
  const attachments = new Map<string, TrajectoryImageAttachment>();
  if (detail.kind !== 'input' || !detail.message) return attachments;
  for (const content of detail.message.content) {
    if (content.type !== 'attachment' || !content.artifactRef) continue;
    attachments.set(content.artifactRef.observation.id, {
      artifactRef: content.artifactRef,
      name: content.name,
    });
  }
  return attachments;
}

function ModelPartsPreview({
  className,
  compact,
  imageAttachments,
  onOpenRecord,
  parts,
  plainText,
  threadId,
  toolCallRecordIds,
}: {
  readonly className: string;
  readonly compact: boolean;
  readonly imageAttachments: ReadonlyMap<string, TrajectoryImageAttachment>;
  readonly onOpenRecord: (recordId: string) => void;
  readonly parts: readonly TrajectoryModelPart[];
  readonly plainText: boolean;
  readonly threadId: string;
  readonly toolCallRecordIds: ReadonlyMap<string, string>;
}) {
  return (
    <div className={`${className} thread-trajectory-parts-preview${plainText ? ' is-input' : ''}`}>
      {parts.map((part, index) => (
        <ModelPartPreview
          compact={compact}
          imageAttachment={part.type === 'image' && part.sha256 ? imageAttachments.get(part.sha256) : undefined}
          key={`${part.type}:${index}`}
          onOpenRecord={onOpenRecord}
          part={part}
          plainText={plainText}
          threadId={threadId}
          toolCallRecordIds={toolCallRecordIds}
        />
      ))}
    </div>
  );
}

function ModelPartPreview({
  compact,
  imageAttachment,
  onOpenRecord,
  part,
  plainText,
  threadId,
  toolCallRecordIds,
}: {
  readonly compact: boolean;
  readonly imageAttachment?: TrajectoryImageAttachment;
  readonly onOpenRecord: (recordId: string) => void;
  readonly part: TrajectoryModelPart;
  readonly plainText: boolean;
  readonly threadId: string;
  readonly toolCallRecordIds: ReadonlyMap<string, string>;
}) {
  const t = useT();
  if (part.type === 'text') {
    if (plainText) {
      if (!compact) return <RawEvidenceBlock code={part.text} language="text" />;
      return <pre className="thread-trajectory-part-text is-plain">{part.text}</pre>;
    }
    return (
      <div className="thread-trajectory-part-text">
        <ThreadMarkdown text={part.text} />
      </div>
    );
  }
  if (part.type === 'thinking') {
    return (
      <details className="thread-trajectory-part-thinking">
        <summary>
          <ChevronRightIcon aria-hidden="true" size={ICON_SIZE.rowGlyph} />
          {t.agent.trajectory.contentPart.thinking}
        </summary>
        <div className="thread-trajectory-part-thinking-body">
          <ThreadMarkdown text={part.text} />
        </div>
      </details>
    );
  }
  if (part.type === 'toolCall') {
    const recordId = part.callId === null ? null : toolCallRecordIds.get(part.callId) ?? null;
    const content = (
      <>
        <GenericToolIcon aria-hidden="true" size={ICON_SIZE.rowGlyph} />
        <span className="thread-trajectory-part-tool-name">
          {part.name ?? t.agent.trajectory.contentPart.toolCall}
        </span>
        {part.arguments === null ? null : (
          <span className="thread-trajectory-part-tool-arguments">
            {JSON.stringify(part.arguments)}
          </span>
        )}
        {recordId ? <ChevronRightIcon aria-hidden="true" size={ICON_SIZE.rowGlyph} /> : null}
      </>
    );
    return recordId ? (
      <button
        aria-label={t.agent.trajectory.openToolCall}
        className="thread-trajectory-part-tool"
        onClick={() => onOpenRecord(recordId)}
        title={t.agent.trajectory.openToolCall}
        type="button"
      >
        {content}
      </button>
    ) : (
      <div className="thread-trajectory-part-tool">{content}</div>
    );
  }
  if (part.type === 'image') {
    return <ImagePartEvidence attachment={imageAttachment} part={part} threadId={threadId} />;
  }
  if (!compact) {
    return <RawEvidenceBlock code={JSON.stringify(part.value, null, 2)} language="json" />;
  }
  return (
    <section className="thread-trajectory-part-other">
      <span>{t.agent.trajectory.contentPart.other}</span>
      <pre>{JSON.stringify(part.value, null, 2)}</pre>
    </section>
  );
}

function ImagePartEvidence({
  attachment,
  part,
  threadId,
}: {
  readonly attachment?: TrajectoryImageAttachment;
  readonly part: ThreadTrajectoryModelInputPart & { readonly type: 'image' };
  readonly threadId: string;
}) {
  const t = useT();
  const artifactRef = attachment?.artifactRef ?? null;
  const attachmentName = attachment?.name ?? null;
  const target = useMemo<PreviewTarget | null>(() => artifactRef ? {
    kind: 'local-file',
    path: artifactRef.id,
    entryKind: 'file',
    label: attachmentName ?? undefined,
    threadId,
    imageArtifactRef: artifactRef,
  } : null, [artifactRef, attachmentName, threadId]);
  const preview = usePreviewObjectUrl(target, {
    mimeType: part.mimeType ?? artifactRef?.observation.mimeType,
  });
  const metadata = [
    part.mimeType,
    part.byteLength === null ? null : `${formatNumber(part.byteLength)} B`,
  ].filter((value): value is string => value !== null).join(' · ');
  return (
    <section className="thread-trajectory-part-image">
      {artifactRef ? (
        <div className="thread-trajectory-part-image-media">
          {preview.src
            ? <img alt="" loading="lazy" src={preview.src} />
            : <ImageIcon aria-hidden="true" size={ICON_SIZE.menu} />}
        </div>
      ) : <ImageIcon aria-hidden="true" size={ICON_SIZE.menu} />}
      <div className="thread-trajectory-part-image-details">
        <strong>{attachmentName ?? t.agent.trajectory.contentPart.image}</strong>
        {metadata ? <span>{metadata}</span> : null}
        {part.sha256 ? <code>sha256 {part.sha256}</code> : null}
      </div>
    </section>
  );
}

function RawPartsEvidence({
  imageAttachments,
  onOpenRecord,
  parts,
  threadId,
  toolCallRecordIds,
}: {
  readonly imageAttachments: ReadonlyMap<string, TrajectoryImageAttachment>;
  readonly onOpenRecord: (recordId: string) => void;
  readonly parts: readonly TrajectoryModelPart[];
  readonly threadId: string;
  readonly toolCallRecordIds: ReadonlyMap<string, string>;
}) {
  const t = useT();
  return (
    <div className="thread-trajectory-raw-parts">
      {parts.map((part, index) => {
        const label = contentPartLabel(part, t.agent.trajectory);
        if (part.type === 'toolCall') {
          const recordId = part.callId === null ? null : toolCallRecordIds.get(part.callId) ?? null;
          return (
            <section className="thread-trajectory-raw-part" key={`${part.type}:${index}`}>
              {recordId ? (
                <button
                  aria-label={t.agent.trajectory.openToolCall}
                  className="thread-trajectory-raw-part-heading is-link"
                  onClick={() => onOpenRecord(recordId)}
                  title={t.agent.trajectory.openToolCall}
                  type="button"
                >
                  {t.agent.trajectory.partNumber({ index: index + 1 })} · {label}
                  <ChevronRightIcon aria-hidden="true" size={ICON_SIZE.rowGlyph} />
                </button>
              ) : (
                <div className="thread-trajectory-raw-part-heading">
                  {t.agent.trajectory.partNumber({ index: index + 1 })} · {label}
                </div>
              )}
              <RawEvidenceBlock
                code={JSON.stringify({ callId: part.callId, name: part.name, arguments: part.arguments }, null, 2)}
                language="json"
              />
            </section>
          );
        }
        return (
          <section className="thread-trajectory-raw-part" key={`${part.type}:${index}`}>
            <div className="thread-trajectory-raw-part-heading">
              {t.agent.trajectory.partNumber({ index: index + 1 })} · {label}
            </div>
            {part.type === 'image'
              ? (
                <ImagePartEvidence
                  attachment={part.sha256 ? imageAttachments.get(part.sha256) : undefined}
                  part={part}
                  threadId={threadId}
                />
              )
              : (
                <RawEvidenceBlock
                  code={part.type === 'other' ? JSON.stringify(part.value, null, 2) : part.text}
                  language={part.type === 'other' ? 'json' : 'text'}
                />
              )}
          </section>
        );
      })}
    </div>
  );
}

function contentPartLabel(
  part: TrajectoryModelPart,
  labels: ReturnType<typeof useT>['agent']['trajectory'],
): string {
  if (part.type === 'text') return labels.contentPart.text;
  if (part.type === 'thinking') return labels.contentPart.thinking;
  if (part.type === 'toolCall') return labels.contentPart.toolCall;
  if (part.type === 'image') return labels.contentPart.image;
  return labels.contentPart.other;
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
  const t = useT();
  if (record.availability.length === 0) return null;
  return (
    <div className="thread-trajectory-availability">
      {record.availability.map((entry) => (
        <p key={entry.reason}>
          <span>{t.agent.trajectory.availability[entry.reason]}</span>
        </p>
      ))}
    </div>
  );
}

function JsonEvidence({ title, value }: { readonly title: string; readonly value: unknown }) {
  return (
    <div className="thread-trajectory-inspector-body is-evidence-page">
      <JsonEvidenceContent title={title} value={value} />
    </div>
  );
}

function JsonEvidenceContent({ title, value }: { readonly title: string; readonly value: unknown }) {
  const t = useT();
  const code = value === null || value === undefined ? null : JSON.stringify(value, null, 2);
  return (
    <>
      <h4>{title}</h4>
      {code === null ? (
        <p className="thread-trajectory-note">{t.agent.trajectory.noRetainedEvidence}</p>
      ) : (
        <RawEvidenceBlock code={code} language="json" />
      )}
    </>
  );
}

function RawTextEvidence({ title, text }: { readonly title: string; readonly text: string | null }) {
  const t = useT();
  return (
    <div className="thread-trajectory-inspector-body is-evidence-page">
      <h4>{title}</h4>
      {text ? (
        <RawEvidenceBlock code={text} language={rawTextLanguage(text)} />
      ) : (
        <p className="thread-trajectory-note">{t.agent.trajectory.noRetainedEvidence}</p>
      )}
    </div>
  );
}

function RawEvidenceBlock({ code, language }: { readonly code: string; readonly language: string }) {
  const t = useT();
  return (
    <ReadOnlyCodeBlock
      className="thread-trajectory-code"
      code={code}
      copyLabel={t.agent.trajectory.copyEvidence}
      key={code}
      language={language}
      showLanguageLabel={false}
    />
  );
}

function tabsForRecord(
  record: ThreadTrajectoryRecordSummary,
  t: ReturnType<typeof useT>['agent']['trajectory'],
): readonly { readonly id: InspectorTab; readonly label: string }[] {
  if (isStablePromptRecord(record)) return [
    { id: 'systemPrompt', label: t.systemPrompt },
    { id: 'raw', label: t.raw },
  ];
  if (isToolCatalogRecord(record)) return [
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

function previewText(detail: ThreadTrajectoryRecordDetail): string | null {
  if (detail.kind === 'context') return detail.modelContextText;
  if (detail.kind === 'tool' || detail.kind === 'delegation') return detail.outputText;
  if (detail.kind === 'compaction') return detail.summaryText;
  return null;
}

function providerRequest(detail: ThreadTrajectoryRecordDetail): JsonValue | null {
  return 'diagnostics' in detail ? detail.diagnostics?.providerCall?.request ?? null : null;
}

function contextEvidenceSource(
  detail: Extract<ThreadTrajectoryRecordDetail, { readonly kind: 'context' }>,
  record: ThreadTrajectoryRecordSummary,
  labels: TrajectoryLabels,
): string {
  if (isJsonObject(detail.payload) && typeof detail.payload.kind === 'string') return detail.payload.kind;
  return trajectoryRecordMeta(record, labels) ?? evidenceSource(record, labels);
}

function stablePromptText(detail: ThreadTrajectoryRecordDetail): string | null {
  return detail.kind === 'context' ? detail.modelContextText : null;
}

function stablePromptTools(detail: ThreadTrajectoryRecordDetail): JsonValue | null {
  if (detail.kind !== 'context' || !isJsonObject(detail.payload)) return null;
  if (detail.payload.kind === 'toolCatalog') return detail.payload.tools ?? null;
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

function rawTextLanguage(text: string): 'json' | 'text' {
  const candidate = text.trim();
  if (!candidate || (candidate[0] !== '{' && candidate[0] !== '[')) return 'text';
  try {
    JSON.parse(candidate);
    return 'json';
  } catch {
    return 'text';
  }
}

function evidenceSource(record: ThreadTrajectoryRecordSummary, labels: TrajectoryLabels): string {
  const evidence = record.primaryEvidence;
  if (evidence.type === 'providerCall') return labels.requestNumber({ index: evidence.callIndex + 1 });
  if (evidence.type === 'diagnosticActivity') return evidence.activityType;
  if (evidence.type === 'toolExecution') return evidence.callId;
  if (evidence.type === 'threadItem') return trajectoryRecordLabel(record, labels);
  if (evidence.type === 'stablePrompt') return labels.record.stablePrompt;
  if (evidence.type === 'toolCatalog') return labels.requestNumber({ index: evidence.callIndex + 1 });
  if (evidence.type === 'subagent') return labels.record.childThread;
  return labels.turnLabel({ index: record.turnIndex + 1 });
}

function durationLabel(timing: ThreadTrajectoryTimingSummary, labels: TrajectoryLabels): string {
  if (timing.durationMs !== null) return formatDuration(timing.durationMs);
  return timing.startedAt === null ? labels.state.notRecorded : labels.state.running;
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

function stateLabel(
  state: ThreadTrajectoryRecordSummary['state'],
  labels: TrajectoryLabels,
): string {
  if (state === 'completed') return labels.state.completed;
  if (state === 'running') return labels.state.running;
  if (state === 'failed') return labels.state.failed;
  if (state === 'interrupted') return labels.state.interrupted;
  if (state === 'partial') return labels.state.partial;
  return labels.state.pending;
}

function clampDetailsWidth(width: number, splitWidth: number): number {
  const maximum = Math.max(DETAILS_MIN_WIDTH, Math.min(DETAILS_MAX_WIDTH, splitWidth - LEDGER_MIN_WIDTH));
  return Math.round(Math.min(Math.max(width, DETAILS_MIN_WIDTH), maximum));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
