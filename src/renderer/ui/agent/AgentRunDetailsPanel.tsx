import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentMessage,
  AgentRunDetailPayload,
  AgentToolResultWithPayloads,
  ToolResultMessage,
} from '../../../core/agentTypes';
import type { Messages } from '../../../core/i18n';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
import type { DocumentIndex } from '../../state/document';
import { localStorageOrNull } from '../../state/localStorageStore';
import { api } from '../../api/client';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  HashIcon,
  ICON_SIZE,
  LoaderIcon,
  WarningIcon,
} from '../icons';
import { IconButton } from '../primitives/IconButton';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentTranscriptMessageList } from './AgentTranscriptMessageList';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { useT } from '../../i18n/I18nProvider';
import {
  AgentRunStatusMarker,
  AgentRunRow,
  displayRunStatus,
  runStatusLabel,
  runWorkLabel,
  isCompletedRunStatus,
  type AgentRunDisplayStatus,
  type AgentRunRowData,
} from './AgentRunRow';

interface AgentRunDetailsPanelProps {
  breadcrumbRootLabel?: string;
  onBack?: () => void;
  onClose: () => void;
  conversationId: string | null;
  runId: string | null;
  runUpdatedAt?: number;
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRun?: (runId: string, conversationId: string | null) => void;
  onOpenRuns?: () => void;
  showHeader?: boolean;
}

type AgentRunDetailChild = AgentRunDetailPayload['subRuns'][number];
type DisplayRunStatus = AgentRunDisplayStatus;

/** Live-run transcript poll cadence (the fetch is meta-keyed in main, near-free when unchanged). */
const LIVE_TRANSCRIPT_POLL_MS = 1_500;
const RESULT_PREVIEW_CHAR_LIMIT = 900;
const DRAWER_HEIGHT_RATIO_STORAGE_KEY = 'lin:agent-run-detail-drawer-height-ratio';
const DRAWER_DEFAULT_HEIGHT_RATIO = 0.8;
const DRAWER_MIN_HEIGHT_PX = 360;
const DRAWER_TOP_GAP_PX = 52;
const DRAWER_KEYBOARD_STEP_PX = 48;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value)) return false;
  return value.role === 'user' || value.role === 'assistant' || value.role === 'toolResult';
}

function parseTranscript(raw: unknown[] | null): AgentMessage[] {
  if (!raw) return [];
  return raw.filter(isAgentMessage);
}

function toolResultFromMessage(message: ToolResultMessage): AgentToolResultWithPayloads {
  return {
    ...message,
    payloadRefs: [],
  };
}

function buildToolResultMap(messages: readonly AgentMessage[]): Map<string, AgentToolResultWithPayloads> {
  const results = new Map<string, AgentToolResultWithPayloads>();
  for (const message of messages) {
    if (message.role !== 'toolResult') continue;
    results.set(message.toolCallId, toolResultFromMessage(message));
  }
  return results;
}

function collectPendingToolCallIds(messages: readonly AgentMessage[], running: boolean): Set<string> {
  if (!running) return new Set();
  const toolResults = buildToolResultMap(messages);
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && !toolResults.has(block.id)) pending.add(block.id);
    }
  }
  return pending;
}

function transcriptHasActiveAssistantTurn(
  messages: readonly AgentMessage[],
  running: boolean,
  pendingToolCallIds: ReadonlySet<string>,
): boolean {
  if (!running) return false;
  if (pendingToolCallIds.size > 0) return true;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'assistant') return message.stopReason === null;
    if (message.role === 'user') return false;
  }
  return false;
}

function displayStatusFor(detail: Pick<AgentRunDetailPayload, 'objectiveStatus' | 'status'>): DisplayRunStatus {
  return displayRunStatus(detail);
}

function clampDrawerHeight(height: number, maxHeight: number): number {
  return Math.min(Math.max(height, DRAWER_MIN_HEIGHT_PX), Math.max(DRAWER_MIN_HEIGHT_PX, maxHeight));
}

function clampDrawerHeightRatio(ratio: number): number {
  return Math.min(Math.max(ratio, 0), 1);
}

function drawerMaxHeight(drawer: HTMLElement): number {
  const backdrop = drawer.parentElement;
  const availableHeight = backdrop?.getBoundingClientRect().height ?? 0;
  return Math.max(DRAWER_MIN_HEIGHT_PX, availableHeight - DRAWER_TOP_GAP_PX);
}

function readDrawerHeightRatio(): number {
  const storage = localStorageOrNull();
  const raw = storage?.getItem(DRAWER_HEIGHT_RATIO_STORAGE_KEY);
  const parsed = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(parsed) ? clampDrawerHeightRatio(parsed) : DRAWER_DEFAULT_HEIGHT_RATIO;
}

function writeDrawerHeightRatio(height: number, maxHeight: number) {
  const storage = localStorageOrNull();
  if (!storage || maxHeight <= 0) return;
  try {
    storage.setItem(DRAWER_HEIGHT_RATIO_STORAGE_KEY, clampDrawerHeightRatio(height / maxHeight).toFixed(4));
  } catch {
    // Best-effort renderer preference.
  }
}

function detailDrawerElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.agent-run-detail-drawer');
}

function setDetailDrawerHeight(height: number, persist: boolean) {
  const drawer = detailDrawerElement();
  if (!drawer) return;
  const maxHeight = drawerMaxHeight(drawer);
  const nextHeight = clampDrawerHeight(height, maxHeight);
  drawer.style.setProperty('--agent-run-detail-drawer-height', `${nextHeight}px`);
  if (persist) writeDrawerHeightRatio(nextHeight, maxHeight);
}

function applyStoredDetailDrawerHeight() {
  const drawer = detailDrawerElement();
  if (!drawer) return;
  const maxHeight = drawerMaxHeight(drawer);
  setDetailDrawerHeight(maxHeight * readDrawerHeightRatio(), false);
}

function isVerifierRun(run: Pick<AgentRunDetailChild, 'objectiveRole' | 'runProfile'>): boolean {
  return run.objectiveRole === 'verifier' || run.runProfile === 'verify';
}

function runTitle(run: AgentRunDetailChild, labels: Messages['agent']): string {
  if (isVerifierRun(run)) return labels.run.kind.verifier;
  return run.title || run.runId;
}

function compareRuns(left: AgentRunDetailChild, right: AgentRunDetailChild): number {
  return left.startedAt - right.startedAt || left.runId.localeCompare(right.runId);
}

function runDetailToTranscriptRun(detail: AgentRunDetailPayload): AgentRenderRunEntity {
  return {
    id: detail.runId,
    agentId: detail.agentId,
    anchor: detail.conversationId
      ? { type: 'conversation', agentId: detail.agentId, conversationId: detail.conversationId }
      : { type: 'principal', principal: { type: 'agent', agentId: detail.agentId } },
    conversationId: detail.conversationId ?? undefined,
    title: detail.title,
    parentRunId: detail.parentRunId,
    parentToolCallId: detail.parentToolCallId,
    runProfile: detail.runProfile,
    runProfileLabel: detail.runProfileLabel,
    status: detail.status,
    objectiveStatus: detail.objectiveStatus,
    objectiveRole: detail.objectiveRole,
    context: detail.context,
    startedAt: detail.startedAt,
    updatedAt: detail.updatedAt,
    completedAt: detail.completedAt,
  };
}

function childToTranscriptRun(child: AgentRunDetailChild, parent: AgentRunDetailPayload): AgentRenderRunEntity {
  return {
    id: child.runId,
    agentId: parent.agentId,
    anchor: parent.conversationId
      ? { type: 'conversation', agentId: parent.agentId, conversationId: parent.conversationId }
      : { type: 'principal', principal: { type: 'agent', agentId: parent.agentId } },
    conversationId: parent.conversationId ?? undefined,
    title: child.title,
    parentRunId: child.parentRunId,
    parentToolCallId: child.parentToolCallId,
    runProfile: child.runProfile,
    runProfileLabel: child.runProfileLabel,
    status: child.status,
    objectiveStatus: child.objectiveStatus,
    objectiveRole: child.objectiveRole,
    context: parent.context,
    startedAt: child.startedAt,
    updatedAt: child.updatedAt,
    completedAt: child.completedAt,
  };
}

function CopyResultButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

  async function copy() {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <IconButton
      className="agent-message-action-button"
      disabled={!text}
      icon={CopyStateIcon}
      label={t.agent.runDetail.copyResult}
      onClick={() => void copy()}
      title={t.agent.message.copy}
      variant="message"
    />
  );
}

function ResultText({ text }: { text: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const displayText = text || t.agent.runDetail.noResultYet;
  const collapsible = text.length > RESULT_PREVIEW_CHAR_LIMIT;
  return (
    <div className="agent-run-detail-result-box">
      <div className={`agent-run-detail-result-content ${collapsible && !expanded ? 'is-collapsed' : ''}`}>
        <AgentMarkdown keyPrefix="run-detail-result" text={displayText} />
      </div>
      {collapsible ? (
        <ButtonControl
          aria-expanded={expanded}
          className="agent-run-detail-result-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t.agent.message.showLess : t.agent.message.showMore}
        </ButtonControl>
      ) : null}
    </div>
  );
}

function DisclosureSection({
  children,
  defaultOpen,
  title,
  variant = 'section',
}: {
  children: ReactNode;
  defaultOpen: boolean;
  title: ReactNode;
  variant?: 'section' | 'process';
}) {
  // Own the open state and seed it once from `defaultOpen`. A bare controlled
  // `open={defaultOpen}` (no onToggle) is re-asserted on every poll re-render, so
  // the user can neither collapse it while the run streams nor keep it open once
  // the derived default flips on completion. Per-run remounting (a key at the call
  // site) re-seeds it for a freshly opened run.
  const [open, setOpen] = useState(defaultOpen);
  const process = variant === 'process';
  return (
    <details
      className={`agent-run-detail-disclosure-section ${process ? 'is-process agent-process-block' : ''}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="agent-work-divider">
        <span className="agent-process-title">{title}</span>
        <ChevronRightIcon
          aria-hidden
          className={`agent-run-detail-disclosure-chevron${open ? ' is-expanded' : ''}`}
          size={14}
        />
      </summary>
      <div aria-hidden className="agent-process-rule" />
      <div className="agent-run-detail-disclosure-body">
        {children}
      </div>
    </details>
  );
}

function childRowData(run: AgentRunDetailChild, labels: Messages['agent']): AgentRunRowData {
  return {
    runId: run.runId,
    title: runTitle(run, labels),
    status: run.status,
    objectiveStatus: run.objectiveStatus,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    childRunCount: run.childRunCount,
    completedChildRunCount: run.completedChildRunCount,
    blockedReason: run.blockedReason,
    error: run.error,
  };
}

function completedRunCount(runs: readonly AgentRunDetailChild[]): number {
  let count = 0;
  for (const run of runs) {
    if (isCompletedRunStatus(displayStatusFor(run))) count += 1;
  }
  return count;
}

function RunChildList({
  conversationId,
  runs,
  onOpenRun,
}: {
  conversationId: string | null;
  runs: AgentRunDetailChild[];
  onOpenRun?: (runId: string, conversationId: string | null) => void;
}) {
  const t = useT();
  return (
    <div className="agent-sub-run-list">
      {runs.map((run) => (
        <AgentRunRow
          className="agent-sub-run-row"
          key={run.runId}
          onOpen={onOpenRun ? () => onOpenRun(run.runId, conversationId) : undefined}
          run={childRowData(run, t.agent)}
        />
      ))}
    </div>
  );
}

function RunBreadcrumb({
  currentTitle,
  rootLabel,
  detail,
  titleDocked,
  onOpenRuns,
  onOpenRun,
}: {
  currentTitle: string;
  rootLabel: string;
  detail: AgentRunDetailPayload;
  titleDocked: boolean;
  onOpenRuns?: () => void;
  onOpenRun?: (runId: string, conversationId: string | null) => void;
}) {
  const t = useT();
  const items = detail.ancestors ?? [];
  const rootContent = (
    <>
      <HashIcon aria-hidden className="agent-run-breadcrumb-root-icon" size={ICON_SIZE.menu} />
      <span className="agent-run-breadcrumb-root-label">{rootLabel}</span>
    </>
  );
  return (
    <nav className="agent-run-breadcrumb panel-breadcrumb" aria-label={t.agent.runDetail.detailsAriaLabel}>
      <span className="panel-breadcrumb-segment agent-run-breadcrumb-root">
        {onOpenRuns ? (
          <ButtonControl
            className="panel-breadcrumb-button"
            onClick={onOpenRuns}
          >
            {rootContent}
          </ButtonControl>
        ) : (
          <span className="panel-breadcrumb-current-label">{rootContent}</span>
        )}
      </span>
      {items.map((item) => (
        <span className="panel-breadcrumb-segment" key={item.runId}>
          <span className="panel-breadcrumb-divider">/</span>
          {onOpenRun ? (
            <ButtonControl
              className="panel-breadcrumb-button"
              onClick={() => onOpenRun(item.runId, detail.conversationId)}
            >
              {item.title}
            </ButtonControl>
          ) : (
            <span className="panel-breadcrumb-current-label">{item.title}</span>
          )}
        </span>
      ))}
      {titleDocked ? (
        <span className="panel-breadcrumb-segment panel-breadcrumb-current">
          <span className="panel-breadcrumb-divider">/</span>
          <span className="panel-breadcrumb-current-label" data-current-page-title title={currentTitle}>
            {currentTitle}
          </span>
        </span>
      ) : null}
    </nav>
  );
}

function DrawerResizeHandle({
  onResize,
}: {
  onResize: (height: number) => void;
}) {
  const t = useT();

  const updateFromKeyboard = useCallback((direction: 1 | -1) => {
    const drawer = document.querySelector<HTMLElement>('.agent-run-detail-drawer');
    const backdrop = drawer?.parentElement;
    if (!drawer || !backdrop) return;
    const maxHeight = backdrop.getBoundingClientRect().height - DRAWER_TOP_GAP_PX;
    onResize(clampDrawerHeight(drawer.getBoundingClientRect().height + (direction * DRAWER_KEYBOARD_STEP_PX), maxHeight));
  }, [onResize]);

  return (
    <div
      aria-label={t.agent.runDetail.resizeDrawer}
      aria-orientation="horizontal"
      className="agent-run-detail-resize-handle"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        updateFromKeyboard(event.key === 'ArrowUp' ? 1 : -1);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const drawer = event.currentTarget.closest<HTMLElement>('.agent-run-detail-drawer');
        const backdrop = drawer?.parentElement;
        if (!drawer || !backdrop) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const startY = event.clientY;
        const startHeight = drawer.getBoundingClientRect().height;
        const maxHeight = backdrop.getBoundingClientRect().height - DRAWER_TOP_GAP_PX;

        const move = (moveEvent: PointerEvent) => {
          onResize(clampDrawerHeight(startHeight + startY - moveEvent.clientY, maxHeight));
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
      }}
      role="separator"
      tabIndex={0}
    >
      <span aria-hidden="true" />
    </div>
  );
}

function TranscriptTimeline({
  error,
  loading,
  messages,
  pendingToolCallIds,
  reload,
  conversationId,
  run,
  subRunsByParentToolCallId,
  index,
  onNodeReferenceOpen,
  onOpenRun,
  toolResults,
}: {
  error: string | null;
  loading: boolean;
  messages: AgentMessage[];
  pendingToolCallIds: ReadonlySet<string>;
  reload: () => void;
  conversationId: string | null;
  run: AgentRenderRunEntity;
  subRunsByParentToolCallId?: Map<string, AgentRenderRunEntity>;
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRun?: (runId: string, conversationId: string | null) => void;
  toolResults: Map<string, AgentToolResultWithPayloads>;
}) {
  const t = useT();
  if (loading && messages.length === 0) {
    return (
      <EmptyState
        className="agent-run-detail-empty"
        icon={LoaderIcon}
        iconClassName="agent-tool-call-spinner"
        loading
        role="status"
        title={t.agent.runDetail.loadingTranscript}
      />
    );
  }
  if (error) {
    return (
      <ErrorState
        className="agent-run-detail-empty"
        message={error}
        onRetry={reload}
        retryLabel={t.agent.runDetail.retry}
      />
    );
  }
  if (messages.length === 0) {
    return <EmptyState className="agent-run-detail-empty" title={t.agent.runDetail.noTranscriptMessages} />;
  }

  return (
    <AgentTranscriptMessageList
      active={transcriptHasActiveAssistantTurn(messages, run.status === 'running', pendingToolCallIds)}
      className="agent-run-detail-transcript-list"
      conversationId={conversationId}
      index={index}
      messages={messages}
      onNodeReferenceOpen={onNodeReferenceOpen}
      onOpenRunTranscript={(runId) => onOpenRun?.(runId, conversationId)}
      pendingToolCallIds={pendingToolCallIds}
      run={run}
      showFinalMessages={false}
      showProcessStatus={false}
      subRunsByParentToolCallId={subRunsByParentToolCallId}
      toolResults={toolResults}
    />
  );
}

export function AgentRunDetailsPanel({
  breadcrumbRootLabel,
  onBack,
  onClose,
  conversationId,
  runId,
  runUpdatedAt,
  index,
  onNodeReferenceOpen,
  onOpenRun,
  onOpenRuns,
  showHeader = true,
}: AgentRunDetailsPanelProps) {
  const t = useT();
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<'stop' | null>(null);
  const [detail, setDetail] = useState<AgentRunDetailPayload | null>(null);
  const [rawTranscript, setRawTranscript] = useState<unknown[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [titleDocked, setTitleDocked] = useState(false);
  const detailBodyRef = useRef<HTMLDivElement | null>(null);
  const detailTitleRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  const updateTitleDocked = useCallback(() => {
    const body = detailBodyRef.current;
    const title = detailTitleRef.current;
    if (!body || !title) {
      setTitleDocked(false);
      return;
    }
    const threshold = Math.max(0, title.offsetTop + title.offsetHeight - 1);
    const nextDocked = body.scrollTop >= threshold;
    setTitleDocked((previous) => previous === nextDocked ? previous : nextDocked);
  }, []);

  const loadRun = useCallback(() => {
    if (!conversationId || !runId) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setDetailError(null);
    setTranscriptError(null);
    void Promise.allSettled([
      api.agentRunDetail(conversationId, runId),
      api.agentRunTranscript(conversationId, runId),
    ])
      .then(([detailResult, transcriptResult]) => {
        if (requestId !== requestRef.current) return;
        if (detailResult.status === 'fulfilled' && detailResult.value !== null) {
          setDetail(detailResult.value);
        } else {
          setDetail(null);
          setDetailError(
            detailResult.status === 'rejected'
              ? detailResult.reason instanceof Error ? detailResult.reason.message : String(detailResult.reason)
              : t.agent.runDetail.detailUnavailable,
          );
        }

        if (transcriptResult.status === 'fulfilled' && transcriptResult.value !== null) {
          setRawTranscript(transcriptResult.value.messages);
        } else {
          setRawTranscript(null);
          setTranscriptError(
            transcriptResult.status === 'rejected'
              ? transcriptResult.reason instanceof Error ? transcriptResult.reason.message : String(transcriptResult.reason)
              : t.agent.runDetail.transcriptPayloadUnavailable,
          );
        }
      })
      .finally(() => {
        if (requestId === requestRef.current) setLoading(false);
      });
  }, [conversationId, runId, t.agent.runDetail.detailUnavailable, t.agent.runDetail.transcriptPayloadUnavailable]);

  useEffect(() => {
    setActionError(null);
    setActionPending(null);
    setDetail(null);
    setRawTranscript(null);
    setDetailError(null);
    setTranscriptError(null);
    setTitleDocked(false);
    if (detailBodyRef.current) detailBodyRef.current.scrollTop = 0;
    requestRef.current += 1;
  }, [runId]);

  useEffect(() => {
    loadRun();
  }, [loadRun, runUpdatedAt]);

  useEffect(() => {
    if (detail?.status !== 'running') return undefined;
    const interval = window.setInterval(loadRun, LIVE_TRANSCRIPT_POLL_MS);
    return () => {
      window.clearInterval(interval);
      requestRef.current += 1;
    };
  }, [detail?.status, loadRun]);

  useLayoutEffect(() => {
    if (!conversationId || !runId) return undefined;
    applyStoredDetailDrawerHeight();
    const deferredApply = typeof window.requestAnimationFrame === 'function'
      ? { kind: 'frame' as const, id: window.requestAnimationFrame(applyStoredDetailDrawerHeight) }
      : { kind: 'timeout' as const, id: window.setTimeout(applyStoredDetailDrawerHeight, 0) };
    window.addEventListener('resize', applyStoredDetailDrawerHeight);
    return () => {
      if (deferredApply.kind === 'frame' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(deferredApply.id);
      } else {
        window.clearTimeout(deferredApply.id);
      }
      window.removeEventListener('resize', applyStoredDetailDrawerHeight);
    };
  }, [conversationId, runId]);

  useLayoutEffect(() => {
    if (!detail) return undefined;
    const measure = () => updateTitleDocked();
    const frame = typeof window.requestAnimationFrame === 'function'
      ? { kind: 'frame' as const, id: window.requestAnimationFrame(measure) }
      : { kind: 'timeout' as const, id: window.setTimeout(measure, 0) };
    window.addEventListener('resize', measure);
    return () => {
      if (frame.kind === 'frame' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frame.id);
      } else {
        window.clearTimeout(frame.id);
      }
      window.removeEventListener('resize', measure);
    };
  }, [detail, updateTitleDocked]);


  const messages = useMemo(() => parseTranscript(rawTranscript), [rawTranscript]);
  const toolResults = useMemo(() => buildToolResultMap(messages), [messages]);
  const pendingToolCallIds = useMemo(
    () => collectPendingToolCallIds(messages, detail?.status === 'running'),
    [messages, detail?.status],
  );
  const transcriptRun = useMemo(() => detail ? runDetailToTranscriptRun(detail) : null, [detail]);
  const subRunsByParentToolCallId = useMemo(() => {
    if (!detail) return undefined;
    const map = new Map<string, AgentRenderRunEntity>();
    for (const child of [...detail.subRuns, ...detail.verificationRuns]) {
      if (child.parentToolCallId) map.set(child.parentToolCallId, childToTranscriptRun(child, detail));
    }
    return map.size > 0 ? map : undefined;
  }, [detail]);
  const resizeDrawer = useCallback((height: number) => {
    setDetailDrawerHeight(height, true);
  }, []);

  if (!conversationId || !runId) return null;
  if (loading && !detail) {
    return (
      <EmptyState
        className="agent-run-detail-empty"
        icon={LoaderIcon}
        iconClassName="agent-tool-call-spinner"
        loading
        role="status"
        title={t.agent.runDetail.loading}
      />
    );
  }
  if (!detail || !transcriptRun) {
    return (
      <ErrorState
        className="agent-run-detail-empty"
        message={detailError ?? t.agent.runDetail.detailUnavailable}
        onRetry={loadRun}
        retryLabel={t.agent.runDetail.retry}
      />
    );
  }

  const displayStatus = displayStatusFor(detail);
  const canStop = detail.status === 'running';
  const allChildRuns = [...detail.subRuns, ...detail.verificationRuns].sort(compareRuns);
  const completedChildRuns = completedRunCount(allChildRuns);
  const resultText = detail.result?.summary
    ?? detail.objective?.blockedReason
    ?? detail.objective?.latestVerifierGap
    ?? detail.error
    ?? '';
  const activityTitle = runWorkLabel({
    completedAt: detail.completedAt,
    startedAt: detail.startedAt,
    status: detail.status,
    updatedAt: detail.updatedAt,
  }, t.agent.process);

  async function stopRun() {
    if (!conversationId || !detail || !canStop || actionPending) return;
    setActionPending('stop');
    setActionError(null);
    try {
      await api.agentRunStop(conversationId, detail.runId);
      loadRun();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActionPending(null);
    }
  }

  const stopButton = canStop ? (
    <Button
      disabled={actionPending !== null}
      onClick={() => void stopRun()}
      size="sm"
      variant="danger"
    >
      {actionPending === 'stop' ? t.agent.runDetail.stopping : t.agent.runDetail.stop}
    </Button>
  ) : null;

  return (
    <section className="agent-run-detail-panel" aria-label={t.agent.runDetail.detailsAriaLabel}>
      <DrawerResizeHandle onResize={resizeDrawer} />
      {showHeader ? (
        <header className="agent-run-detail-header">
          <div className="agent-run-detail-breadcrumb-row">
            <IconButton
              className="agent-run-detail-back panel-page-back-button"
              disabled={!onBack}
              icon={ChevronLeftIcon}
              iconSize={14}
              label={t.agent.run.backToRuns}
              onClick={onBack}
              title={t.agent.run.backToRuns}
              variant="panel"
            />
            <RunBreadcrumb
              currentTitle={detail.title}
              rootLabel={breadcrumbRootLabel ?? t.agent.run.heading}
              detail={detail}
              titleDocked={titleDocked}
              onOpenRuns={onOpenRuns ?? onBack}
              onOpenRun={onOpenRun}
            />
            <div className="agent-run-detail-header-actions">
              {stopButton}
              <IconButton
                className="agent-run-detail-close"
                icon={CloseIcon}
                label={t.agent.runDetail.closeDetails}
                onClick={onClose}
                title={t.agent.runDetail.close}
                variant="panel"
              />
            </div>
          </div>
        </header>
      ) : null}
      {actionError ? (
        <div className="agent-run-detail-action-error" role="alert">
          <WarningIcon size={ICON_SIZE.menu} />
          <span>{actionError}</span>
        </div>
      ) : null}
      <div className="agent-run-detail-body" onScroll={updateTitleDocked} ref={detailBodyRef}>
        <div className="agent-run-detail-title-line" ref={detailTitleRef}>
          <AgentRunStatusMarker className="agent-run-detail-title-marker" status={displayStatus} />
          <h3>{detail.title}</h3>
        </div>
        <div className="agent-run-detail-content-column">
          <div className="agent-run-detail-answer">
            <DisclosureSection
              key={`activity-${detail.runId}`}
              defaultOpen={false}
              title={activityTitle}
              variant="process"
            >
              <TranscriptTimeline
                error={transcriptError}
                loading={loading}
                messages={messages}
                pendingToolCallIds={pendingToolCallIds}
                reload={loadRun}
                conversationId={conversationId}
                run={transcriptRun}
                subRunsByParentToolCallId={subRunsByParentToolCallId}
                index={index}
                onNodeReferenceOpen={onNodeReferenceOpen}
                onOpenRun={onOpenRun}
                toolResults={toolResults}
              />
            </DisclosureSection>
            <div className="agent-run-detail-result">
              <div className="agent-run-detail-result-actions">
                <CopyResultButton text={resultText} />
              </div>
              <ResultText key={detail.runId} text={resultText} />
            </div>
          </div>
          {allChildRuns.length > 0 ? (
            <DisclosureSection
              key={`subruns-${detail.runId}`}
              defaultOpen
              title={t.agent.runDetail.sectionSubRuns({ completed: completedChildRuns, total: allChildRuns.length })}
            >
              <RunChildList
                conversationId={detail.conversationId}
                runs={allChildRuns}
                onOpenRun={onOpenRun}
              />
            </DisclosureSection>
          ) : null}
          <DisclosureSection key={`technical-${detail.runId}`} defaultOpen={false} title={t.agent.runDetail.sectionTechnicalDetails}>
            <dl className="agent-run-detail-metadata">
              <div>
                <dt>{t.agent.runDetail.metaRunId}</dt>
                <dd>{detail.runId}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaAgentId}</dt>
                <dd>{detail.agentId}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.status}</dt>
                <dd>{runStatusLabel(displayStatus, t.agent.run.status)}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaProfile}</dt>
                <dd>{detail.runProfileLabel}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaObjectiveRole}</dt>
                <dd>{detail.objectiveRole ?? t.agent.runDetail.metaNone}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaContext}</dt>
                <dd>{detail.context}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaDisposition}</dt>
                <dd>{detail.disposition}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaParentToolCall}</dt>
                <dd>{detail.parentToolCallId ?? t.agent.runDetail.metaNone}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaParentRun}</dt>
                <dd>{detail.parentRunId ?? t.agent.runDetail.metaNone}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaStarted}</dt>
                <dd>{new Date(detail.startedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt>{t.agent.runDetail.metaUpdated}</dt>
                <dd>{new Date(detail.updatedAt).toLocaleString()}</dd>
              </div>
            </dl>
          </DisclosureSection>
        </div>
      </div>
    </section>
  );
}
