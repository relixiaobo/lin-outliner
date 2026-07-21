import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Activity,
  AgentIssue,
  AgentRecurringIssue,
  AgentSession,
  AgentSessionTranscriptResult,
  IssueReadResult,
  IssueSearchRow,
  IssueTargetRef,
} from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import type { AgentMessage } from '../../../core/agentTypes';
import { isActiveAgentSessionState } from '../../../core/agentIssue';
import { api } from '../../api/client';
import { useI18n } from '../../i18n/I18nProvider';
import {
  type AppIcon,
  BackIcon,
  CheckIcon,
  AddChildIcon,
  CalendarIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  DescriptionIcon,
  ICON_SIZE,
  InboxIcon,
  LoaderIcon,
  RepeatIcon,
  RunStatusToolIcon,
  ScheduledIcon,
  WarningIcon,
} from '../icons';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { ButtonControl } from '../primitives/ButtonControl';
import { formatLocaleDateTime } from '../formatting';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentDetailDrawerResizeHandle, useAgentDetailDrawerHeight } from './AgentDetailDrawerResize';
import { formatRunDuration } from './agentProcessTypes';
import type { AgentNodeReferenceOpenHandler } from './AgentInlineReferenceText';
import { AgentTranscriptMessageList } from './AgentTranscriptMessageList';
import {
  agentRunDetailToTranscriptRun,
  agentRunSubRunsByParentToolCallId,
  agentRunTranscriptHasActiveAssistantTurn,
  buildAgentRunToolResultMap,
  collectPendingAgentRunToolCallIds,
  parseAgentRunTranscript,
} from './agentRunTranscriptAdapter';
import {
  activityText,
  compareIssueRowsForPreset,
  dateTimeRelativeLabel,
  displayRecurringTemplateTitle,
  groupIssueRowsForPreset,
  ISSUE_DETAIL_INCLUDE,
  issueActivityTimelineItems,
  issueDisplayTitleForRow,
  issueRowMatchesWorkPreset,
  issueRowSummaryForRow,
  millisecondsUntilNextLocalMidnight,
  relativeTimeLabel,
  rowHasActiveSession,
  rowIsTerminal,
  rowNeedsAttention,
  rowScheduledAt,
  sessionProcessActivityEntriesForDisplay,
  shouldRefreshIssueWorkForAgentEvent,
  type IssueActivityTimelineItem,
  type IssueWorkPreset,
} from './agentIssueViewModel';

const ISSUE_WORK_PRESETS: readonly IssueWorkPreset[] = ['inbox', 'today', 'upcoming', 'logbook'];
const ISSUE_TIME_REFRESH_INTERVAL_MS = 60_000;
type I18nMessages = ReturnType<typeof useI18n>['t'];
const ISSUE_WORK_PRESET_ICONS = {
  inbox: InboxIcon,
  today: ClockIcon,
  upcoming: CalendarIcon,
  logbook: CheckIcon,
} satisfies Record<IssueWorkPreset, AppIcon>;
interface AgentIssuesPanelProps {
  activeSessionCount: number;
  error: string | null;
  loading: boolean;
  onOpenIssue: (target: IssueTargetRef, title?: string) => void;
  onPresetChange: (preset: IssueWorkPreset) => void;
  onRefresh: () => void;
  preset: IssueWorkPreset;
  rows: readonly IssueSearchRow[];
}

interface AgentIssueDetailsPanelProps {
  breadcrumbs?: readonly IssueDetailBreadcrumb[];
  index: DocumentIndex;
  onBack?: () => void;
  onClose: () => void;
  onOpenIssue?: (target: IssueTargetRef, title?: string) => void;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRunDetailsPanel?: (conversationId: string | null, runId: string | null) => boolean | void;
  onSelectBreadcrumb?: (index: number) => void;
  target: IssueTargetRef;
}

export interface IssueDetailBreadcrumb {
  target: IssueTargetRef;
  title?: string;
}

function targetKey(target: IssueTargetRef): string {
  return `${target.type}:${target.id}`;
}

function issueDisplayTitleForDetail(issue: AgentIssue | undefined, recurringIssue: AgentRecurringIssue | undefined, fallback: string): string {
  if (issue) return issue.title;
  if (recurringIssue) return displayRecurringTemplateTitle(recurringIssue.titleTemplate);
  return fallback;
}

function activityTimestampTitle(timestamp: number, locale: string): string {
  return formatLocaleDateTime(timestamp, locale);
}

function activityActorLabel(actor: Activity['actor'], systemLabel: string): string {
  switch (actor.type) {
    case 'agent':
      return actor.agentId;
    case 'user':
      return actor.userId;
    case 'system':
      return systemLabel;
  }
}

function activityValueLabel(value: unknown, labels: { nullValue: string; unset: string }): string {
  if (value === undefined) return labels.unset;
  if (value === null) return labels.nullValue;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function activityEventIcon(activity: Activity): AppIcon {
  switch (activity.content.type) {
    case 'created':
    case 'updated':
    case 'field-change':
    case 'output-link':
      return DescriptionIcon;
    case 'status-change':
      return activity.content.to.toLowerCase() === 'completed' ? CheckIcon : ClockIcon;
    case 'agent-question':
    case 'agent-error':
    case 'deleted':
      return WarningIcon;
    case 'archived':
      return InboxIcon;
    case 'agent-action':
      return RunStatusToolIcon;
    case 'verification-result':
      return activity.content.verdict === 'pass' ? CheckIcon : WarningIcon;
    case 'comment':
    case 'agent-progress':
    case 'agent-response':
      return DescriptionIcon;
  }
}

function activityEventClass(activity: Activity): string {
  switch (activity.content.type) {
    case 'status-change':
      return activity.content.to.toLowerCase() === 'completed' ? 'is-complete' : '';
    case 'verification-result':
      return activity.content.verdict === 'pass' ? 'is-complete' : 'is-attention';
    case 'agent-error':
    case 'agent-question':
    case 'deleted':
      return 'is-attention';
    case 'archived':
      return 'is-muted';
    case 'created':
    case 'updated':
    case 'comment':
    case 'field-change':
    case 'agent-progress':
    case 'agent-action':
    case 'agent-response':
    case 'output-link':
      return '';
  }
}

function IssueDetailSectionHeading({
  children,
  icon: Icon,
}: {
  children: string;
  icon: AppIcon;
}) {
  return (
    <h4>
      <Icon aria-hidden="true" size={ICON_SIZE.menu} />
      <span>{children}</span>
    </h4>
  );
}

function sessionStateLabel(state: AgentSession['state'], labels: I18nMessages['agent']['issue']): string {
  switch (state) {
    case 'pending':
      return labels.sessionState.pending;
    case 'active':
      return labels.sessionState.active;
    case 'complete':
      return labels.sessionState.complete;
    case 'error':
      return labels.sessionState.error;
    case 'stale':
      return labels.sessionState.stale;
    case 'canceled':
      return labels.sessionState.canceled;
  }
}

function issueTriggerLabel(issue: AgentIssue, labels: I18nMessages['agent']['issue']): string {
  if (issue.trigger.type === 'when-ready') return labels.triggerWhenReady;
  return labels.triggerScheduled;
}

function cadenceLabel(recurringIssue: AgentRecurringIssue, labels: I18nMessages['agent']['issue']): string {
  switch (recurringIssue.cadence.type) {
    case 'daily':
      return labels.cadenceDaily;
    case 'weekly':
      return labels.cadenceWeekly;
    case 'monthly':
      return labels.cadenceMonthly;
  }
}

function cadenceLabelForRow(row: IssueSearchRow, labels: I18nMessages['agent']['issue']): string {
  switch (row.cadence?.type) {
    case 'daily':
      return labels.cadenceDaily;
    case 'weekly':
      return labels.cadenceWeekly;
    case 'monthly':
      return labels.cadenceMonthly;
    default:
      return labels.recurringIssue;
  }
}

function displayStatusLabel(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function issueDetailStatusLabel(
  issue: AgentIssue | undefined,
  recurringIssue: AgentRecurringIssue | undefined,
): string | null {
  if (issue?.status.category === 'canceled') return issue.status.name;
  if (recurringIssue?.status === 'paused' || recurringIssue?.status === 'archived') return displayStatusLabel(recurringIssue.status);
  return null;
}

function issueDetailStatusClass(issue: AgentIssue | undefined, recurringIssue: AgentRecurringIssue | undefined): string {
  if (issue?.status.category === 'canceled') return 'is-attention';
  if (recurringIssue?.status === 'paused') return 'is-paused';
  if (recurringIssue?.status === 'archived') return 'is-muted';
  return '';
}

function issueDetailTimingLine(
  issue: AgentIssue | undefined,
  recurringIssue: AgentRecurringIssue | undefined,
  labels: I18nMessages,
  locale: string,
  now = Date.now(),
): string | null {
  if (recurringIssue) {
    const next = recurringIssue.nextMaterializationAt !== undefined
      ? dateTimeRelativeLabel(recurringIssue.nextMaterializationAt, now, labels.agent.issue, locale)
      : labels.agent.issue.summary.noNextRun;
    return `${labels.agent.issueDetail.nextRun} ${next} · ${cadenceLabel(recurringIssue, labels.agent.issue)}`;
  }
  if (!issue) return null;
  if (issue.trigger.type === 'scheduled') {
    return `${labels.agent.issueDetail.starts} ${dateTimeRelativeLabel(issue.trigger.startAt, now, labels.agent.issue, locale)}`;
  }
  if (issue.dueDate) {
    return `${labels.agent.issue.summary.due} ${dateTimeRelativeLabel(issue.dueDate.targetAt, now, labels.agent.issue, locale)}`;
  }
  if (issue.status.category === 'completed' || issue.status.category === 'canceled') return null;
  return issueTriggerLabel(issue, labels.agent.issue);
}

function issueTargetFallbackLabel(target: IssueTargetRef, labels: I18nMessages['agent']['issue']): string {
  return target.type === 'recurring-issue' ? labels.recurringIssue : labels.issue;
}

function issueBreadcrumbLabel(
  entry: IssueDetailBreadcrumb,
  currentTitle: string,
  index: number,
  lastIndex: number,
  labels: I18nMessages['agent']['issue'],
): string {
  if (index === lastIndex) return currentTitle;
  return entry.title ?? issueTargetFallbackLabel(entry.target, labels);
}

function issueStatusClassForIssue(issue: AgentIssue): string {
  if (issue.status.category === 'completed') return 'is-complete';
  if (issue.status.category === 'canceled') return 'is-attention';
  return '';
}

function detailTargetForIssue(issue: AgentIssue): IssueTargetRef {
  return { type: 'issue', id: issue.id };
}

function IssueLinkedRows({
  issues,
  onOpenIssue,
}: {
  issues: readonly AgentIssue[];
  onOpenIssue?: (target: IssueTargetRef, title?: string) => void;
}) {
  return (
    <div className="agent-issue-detail-list">
      {issues.map((linkedIssue) => (
        <button
          className="agent-issue-linked-row"
          key={linkedIssue.id}
          onClick={() => onOpenIssue?.(detailTargetForIssue(linkedIssue), linkedIssue.title)}
          type="button"
        >
          <span className={`agent-issue-linked-status ${issueStatusClassForIssue(linkedIssue)}`}>
            {linkedIssue.status.category === 'completed'
              ? <CheckIcon aria-hidden="true" size={ICON_SIZE.menu} />
              : <ClockIcon aria-hidden="true" size={ICON_SIZE.menu} />}
          </span>
          <span className="agent-issue-linked-main">
            <span>{linkedIssue.title}</span>
            <small>{linkedIssue.status.name}</small>
          </span>
          <ChevronRightIcon aria-hidden="true" size={ICON_SIZE.menu} />
        </button>
      ))}
    </div>
  );
}

function issueDetailMarker(
  issue: AgentIssue | undefined,
  recurringIssue: AgentRecurringIssue | undefined,
  sessions: readonly AgentSession[],
): { icon: AppIcon; className: string } {
  if (issue?.status.category === 'completed') return { icon: CheckIcon, className: 'is-complete' };
  if (issue?.status.category === 'canceled') return { icon: WarningIcon, className: 'is-attention' };
  if (sessions.some((session) => isActiveAgentSessionState(session.state))) return { icon: LoaderIcon, className: 'is-active' };
  if (recurringIssue) return { icon: RepeatIcon, className: recurringIssue.status === 'paused' ? 'is-muted' : '' };
  if (issue?.trigger.type === 'scheduled' || issue?.dueDate) return { icon: ScheduledIcon, className: 'is-scheduled' };
  return { icon: ClockIcon, className: '' };
}

function sessionStatusClass(session: AgentSession): string {
  if (session.state === 'complete') return 'is-complete';
  if (session.state === 'error' || session.state === 'stale' || session.state === 'canceled') return 'is-attention';
  if (rowHasActiveSession({ target: { type: 'issue', id: session.issueId }, title: '', status: '', revision: '', updatedAt: session.updatedAt, latestSessionState: session.state })) return 'is-active';
  return '';
}

function sessionStatusIcon(session: AgentSession): AppIcon {
  if (session.state === 'complete') return CheckIcon;
  if (session.state === 'error' || session.state === 'stale' || session.state === 'canceled') return WarningIcon;
  if (isActiveAgentSessionState(session.state)) return LoaderIcon;
  return ClockIcon;
}

function sessionIsLive(session: AgentSession): boolean {
  return isActiveAgentSessionState(session.state);
}

function sessionWorkLabel(session: AgentSession, labels: I18nMessages, liveElapsedMs: number | null): string {
  if (session.state === 'active' || session.state === 'pending') {
    if (liveElapsedMs !== null) {
      return labels.agent.process.workingFor({ duration: formatRunDuration(liveElapsedMs) });
    }
    return labels.agent.process.working;
  }
  if (session.state === 'complete' && session.startedAt && session.completedAt) {
    return labels.agent.process.workedFor({ duration: formatRunDuration(session.completedAt - session.startedAt) });
  }
  if (session.state === 'canceled' && session.startedAt && session.completedAt) {
    return labels.agent.process.stoppedAfter({ duration: formatRunDuration(session.completedAt - session.startedAt) });
  }
  return sessionStateLabel(session.state, labels.agent.issue);
}

function useSessionElapsedMs(session: AgentSession): number | null {
  const live = sessionIsLive(session);
  const startedAt = session.startedAt !== undefined && session.startedAt > 0 ? session.startedAt : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live || startedAt === null) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [live, startedAt]);
  if (!live || startedAt === null) return null;
  return Math.max(0, now - startedAt);
}

function transcriptHasProcessDetails(
  messages: readonly AgentMessage[],
  subRunsByParentToolCallId: Map<string, unknown> | undefined,
): boolean {
  if (subRunsByParentToolCallId && subRunsByParentToolCallId.size > 0) return true;
  return messages.some((message) => (
    message.role === 'assistant'
    && message.content.some((block) => block.type === 'thinking' || block.type === 'toolCall')
  ));
}

function IssueStatusMarker({ row }: { row: IssueSearchRow }) {
  const isRecurring = row.target.type === 'recurring-issue';
  const isActive = rowHasActiveSession(row);
  const isComplete = rowIsTerminal(row);
  const isAttention = row.target.type !== 'recurring-issue' && rowNeedsAttention(row);
  const isScheduled = !isRecurring && (rowScheduledAt(row) !== undefined || row.dueDate !== undefined);
  const Icon = isAttention
    ? WarningIcon
    : isActive
      ? LoaderIcon
      : isComplete
        ? CheckIcon
        : isRecurring
          ? RepeatIcon
          : isScheduled
            ? ScheduledIcon
            : ClockIcon;
  const classes = [
    'agent-issue-marker',
    isRecurring ? 'is-recurring' : '',
    isActive ? 'is-active' : '',
    isComplete ? 'is-complete' : '',
    isAttention ? 'is-attention' : '',
    isScheduled ? 'is-scheduled' : '',
  ].filter(Boolean).join(' ');
  return (
    <span className={classes}>
      <Icon aria-hidden="true" size={ICON_SIZE.menu} />
    </span>
  );
}

export function AgentIssuesPanel({
  activeSessionCount,
  error,
  loading,
  onOpenIssue,
  onPresetChange,
  onRefresh,
  preset,
  rows,
}: AgentIssuesPanelProps) {
  const { locale, t } = useI18n();
  const [, setLocalDayRevision] = useState(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const scheduleNextLocalDay = () => {
      if (!active) return;
      timer = window.setTimeout(() => {
        timer = null;
        setLocalDayRevision((revision) => revision + 1);
        onRefreshRef.current();
        scheduleNextLocalDay();
      }, millisecondsUntilNextLocalMidnight(Date.now()));
    };

    scheduleNextLocalDay();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => onRefreshRef.current(), ISSUE_TIME_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const now = Date.now();
  const visibleRows = useMemo(() => rows
    .filter((row) => issueRowMatchesWorkPreset(row, preset, now))
    .sort((left, right) => compareIssueRowsForPreset(left, right, preset, now)), [now, preset, rows]);
  const sections = useMemo(() => groupIssueRowsForPreset(visibleRows, preset, now, t.agent.issue, locale), [locale, now, preset, t.agent.issue, visibleRows]);
  const viewTitle = t.agent.issue.view[preset];

  return (
    <section className="agent-issue-panel" aria-label={t.agent.issue.panelAriaLabel}>
      <header className="agent-issue-view-header">
        <h2 className="agent-issue-view-title">{viewTitle}</h2>
      </header>
      {activeSessionCount > 0 ? (
        <div className="agent-issue-active-summary" role="status">
          <LoaderIcon className="agent-run-status-spinner" size={ICON_SIZE.menu} />
          <span>{t.agent.issue.activeSessions({ count: activeSessionCount })}</span>
        </div>
      ) : null}
      <div className="agent-issue-content">
        {error ? (
          <ErrorState
            className="agent-run-empty"
            message={error}
            onRetry={onRefresh}
            retryLabel={t.agent.issue.refresh}
          />
        ) : loading && visibleRows.length === 0 ? (
          <EmptyState
            className="agent-run-empty"
            icon={LoaderIcon}
            iconClassName="agent-tool-call-spinner"
            loading
            role="status"
            title={t.agent.issue.loading}
          />
        ) : visibleRows.length === 0 ? (
          <div className="agent-run-empty">{t.agent.issue.empty}</div>
        ) : (
          <div className="agent-run-list" aria-label={t.agent.issue.listAriaLabel}>
            {sections.map((section) => (
              <section className="agent-issue-list-section" key={section.key}>
                {section.label ? <h3 className="agent-issue-section-title">{section.label}</h3> : null}
                {section.rows.map((row) => {
                  const summary = issueRowSummaryForRow(row, preset, t, locale, now);
                  return (
                    <button
                      aria-label={[issueDisplayTitleForRow(row), summary].filter(Boolean).join(', ')}
                      className="agent-run-row agent-issue-row is-clickable"
                      key={targetKey(row.target)}
                      onClick={() => onOpenIssue(row.target, issueDisplayTitleForRow(row))}
                      type="button"
                    >
                      <IssueStatusMarker row={row} />
                      <span className="agent-run-main">
                        <span className="agent-run-title-row">
                          <span className="agent-run-title">{issueDisplayTitleForRow(row)}</span>
                        </span>
                        {summary ? (
                          <span className="agent-run-meta-row">
                            <span className="agent-run-meta-chip" title={summary}>{summary}</span>
                          </span>
                        ) : null}
                      </span>
                      <ChevronRightIcon className="agent-run-open-affordance" size={ICON_SIZE.menu} />
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </div>
      <div className="agent-issue-toolbar" role="tablist" aria-label={t.agent.issue.viewsAriaLabel}>
        <div className="agent-issue-tab-bar">
          {ISSUE_WORK_PRESETS.map((item) => {
            const PresetIcon = ISSUE_WORK_PRESET_ICONS[item];
            return (
              <ButtonControl
                aria-selected={preset === item}
                className={`agent-issue-view-tab${preset === item ? ' is-selected' : ''}`}
                key={item}
                onClick={() => onPresetChange(item)}
                role="tab"
              >
                <PresetIcon aria-hidden="true" size={ICON_SIZE.menu} />
                <span>{t.agent.issue.view[item]}</span>
              </ButtonControl>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AgentSessionInlineCard({
  activity,
  index,
  onNodeReferenceOpen,
  onOpenRunDetailsPanel,
  session,
}: {
  activity: readonly Activity[];
  index: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRunDetailsPanel?: (conversationId: string | null, runId: string | null) => boolean | void;
  session: AgentSession;
}) {
  const { locale, t } = useI18n();
  const [transcript, setTranscript] = useState<AgentSessionTranscriptResult | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const transcriptRequestRef = useRef(0);
  const processEntries = useMemo(() => sessionProcessActivityEntriesForDisplay(activity, session), [activity, session]);
  const hasProcessDetails = processEntries.length > 0;
  const liveElapsedMs = useSessionElapsedMs(session);
  const workLabel = sessionWorkLabel(session, t, liveElapsedMs);
  const active = isActiveAgentSessionState(session.state);
  const [executionOpen, setExecutionOpen] = useState(active);
  const loadTranscript = useCallback(async () => {
    const requestId = transcriptRequestRef.current + 1;
    transcriptRequestRef.current = requestId;
    try {
      const nextTranscript = await api.agentSessionTranscript(session.id);
      if (requestId !== transcriptRequestRef.current) return;
      setTranscript(nextTranscript);
      setTranscriptError(null);
    } catch (caught) {
      if (requestId !== transcriptRequestRef.current) return;
      setTranscriptError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [session.id]);

  useEffect(() => {
    void loadTranscript();
  }, [loadTranscript, session.updatedAt]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => void loadTranscript(), 1_000);
    return () => window.clearInterval(timer);
  }, [active, loadTranscript]);

  useEffect(() => {
    if (active) setExecutionOpen(true);
  }, [active]);

  useEffect(() => () => {
    transcriptRequestRef.current += 1;
  }, []);

  const transcriptMessages = useMemo(() => (
    transcript ? parseAgentRunTranscript(transcript.transcript.messages) : []
  ), [transcript]);
  const transcriptProcessMessages = useMemo(() => (
    transcriptMessages.filter((message) => message.role !== 'user')
  ), [transcriptMessages]);
  const transcriptToolResults = useMemo(
    () => buildAgentRunToolResultMap(transcriptMessages),
    [transcriptMessages],
  );
  const transcriptPendingToolCallIds = useMemo(
    () => collectPendingAgentRunToolCallIds(transcriptMessages, transcript?.run.status === 'running'),
    [transcriptMessages, transcript?.run.status],
  );
  const transcriptRun = useMemo(() => (
    transcript ? agentRunDetailToTranscriptRun(transcript.run) : null
  ), [transcript]);
  const transcriptSubRunsByParentToolCallId = useMemo(() => (
    transcript ? agentRunSubRunsByParentToolCallId(transcript.run) : undefined
  ), [transcript]);
  const transcriptActive = transcript
    ? agentRunTranscriptHasActiveAssistantTurn(
      transcriptMessages,
      transcript.run.status === 'running',
      transcriptPendingToolCallIds,
    )
    : false;

  const openRunDetails = useCallback((runId: string) => {
    onOpenRunDetailsPanel?.(transcript?.conversationId ?? null, runId);
  }, [onOpenRunDetailsPanel, transcript?.conversationId]);

  const transcriptProcessAvailable = transcriptProcessMessages.length > 0
    && transcriptHasProcessDetails(transcriptProcessMessages, transcriptSubRunsByParentToolCallId);
  const SessionIcon = sessionStatusIcon(session);
  const resultText = session.latestOutput
    ?? transcript?.run.result?.summary
    ?? null;
  const resultError = session.errorMessage
    ?? (!resultText ? transcriptError : null);

  const transcriptProcessBlock = transcript && transcriptRun && transcriptProcessAvailable ? (
    <details className="agent-issue-session-process">
      <summary>
        <span>{t.agent.issueDetail.process}</span>
        <ChevronRightIcon aria-hidden className="agent-issue-session-process-chevron" size={ICON_SIZE.tiny} />
      </summary>
      <div className="agent-issue-session-process-transcript">
        <AgentTranscriptMessageList
          active={transcriptActive}
          className="agent-issue-session-transcript agent-run-detail-transcript-list"
          conversationId={transcript.conversationId}
          filePreviewPresentation="reader"
          index={index}
          isChannel={false}
          messages={transcriptProcessMessages}
          onNodeReferenceOpen={onNodeReferenceOpen}
          onOpenRunTranscript={openRunDetails}
          pendingToolCallIds={transcriptPendingToolCallIds}
          run={transcriptRun}
          showFinalMessages={false}
          showProcessDetails
          showProcessStatus={false}
          subRunsByParentToolCallId={transcriptSubRunsByParentToolCallId}
          toolResults={transcriptToolResults}
        />
      </div>
    </details>
  ) : null;

  const fallbackProcessBlock = !transcriptProcessBlock && hasProcessDetails ? (
    <details className="agent-issue-session-process">
      <summary>
        <span>{t.agent.issueDetail.process}</span>
        <ChevronRightIcon aria-hidden className="agent-issue-session-process-chevron" size={ICON_SIZE.tiny} />
      </summary>
      {processEntries.length > 0 ? (
        <ol className="agent-issue-session-process-list">
          {processEntries.map((entry) => (
            <li key={entry.id}>
              <span>{activityText(entry, t.agent.issueDetail.activityEvent)}</span>
              <small title={activityTimestampTitle(entry.createdAt, locale)}>{relativeTimeLabel(entry.createdAt, t.agent.run)}</small>
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  ) : null;
  const processBlock = transcriptProcessBlock ?? fallbackProcessBlock;
  const hasExpandedContent = Boolean(
    (transcriptRun && onOpenRunDetailsPanel)
    || processBlock
    || resultText
    || resultError,
  );

  return (
    <details
      className={`agent-issue-activity-row agent-issue-session-card ${sessionStatusClass(session)}`}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        setExecutionOpen(event.currentTarget.open);
      }}
      open={executionOpen}
    >
      <summary className="agent-issue-activity-summary agent-issue-execution-summary">
        <span className={`agent-issue-activity-status agent-issue-execution-status ${sessionStatusClass(session)}`}>
          <SessionIcon aria-hidden="true" size={ICON_SIZE.menu} />
        </span>
        <span className="agent-issue-activity-heading agent-issue-execution-heading">
          <span>{t.agent.issueDetail.execution}</span>
          <small>{workLabel}</small>
        </span>
        <ChevronRightIcon aria-hidden className="agent-issue-activity-chevron agent-issue-execution-chevron" size={ICON_SIZE.menu} />
      </summary>
      <div className="agent-issue-activity-expanded agent-issue-session-expanded">
        {transcriptRun && onOpenRunDetailsPanel ? (
          <ButtonControl
            className="agent-issue-execution-transcript"
            onClick={() => openRunDetails(transcriptRun.id)}
            type="button"
          >
            {t.agent.issueDetail.transcript}
          </ButtonControl>
        ) : null}
        {processBlock}
        {resultText ? (
          <div className="agent-issue-session-result">
            <AgentMarkdown keyPrefix={`agent-session-result-${session.id}`} text={resultText} />
          </div>
        ) : resultError ? (
          <div className="agent-issue-session-result is-error">
            <AgentMarkdown keyPrefix={`agent-session-error-${session.id}`} text={resultError} />
          </div>
        ) : null}
        {!hasExpandedContent ? (
          <div className="agent-issue-session-empty">{t.agent.issueDetail.noExecutionDetails}</div>
        ) : null}
      </div>
    </details>
  );
}

function ActivityEventRow({ entry }: { entry: Activity }) {
  const { locale, t } = useI18n();
  const metadataLabels = t.agent.issueDetail.activityMetadata;
  const EventIcon = activityEventIcon(entry);
  const eventClass = activityEventClass(entry);
  return (
    <details className={`agent-issue-activity-row agent-issue-activity-event-card ${eventClass}`.trim()}>
      <summary className="agent-issue-activity-summary">
        <span className={`agent-issue-activity-status ${eventClass}`.trim()}>
          <EventIcon aria-hidden="true" size={ICON_SIZE.menu} />
        </span>
        <span className="agent-issue-activity-heading">
          <span>{activityText(entry, t.agent.issueDetail.activityEvent)}</span>
          <small>
            <time dateTime={new Date(entry.createdAt).toISOString()} title={activityTimestampTitle(entry.createdAt, locale)}>
              {relativeTimeLabel(entry.createdAt, t.agent.run)}
            </time>
          </small>
        </span>
        <ChevronRightIcon aria-hidden className="agent-issue-activity-chevron" size={ICON_SIZE.menu} />
      </summary>
      <dl className="agent-issue-activity-expanded agent-issue-activity-details">
        <div>
          <dt>{metadataLabels.time}</dt>
          <dd>
            <time dateTime={new Date(entry.createdAt).toISOString()}>
              {activityTimestampTitle(entry.createdAt, locale)}
            </time>
          </dd>
        </div>
        <div>
          <dt>{metadataLabels.actor}</dt>
          <dd>{activityActorLabel(entry.actor, metadataLabels.system)}</dd>
        </div>
        {entry.content.type === 'field-change' && (entry.content.from !== undefined || entry.content.to !== undefined) ? (
          <>
            <div>
              <dt>{metadataLabels.from}</dt>
              <dd>{activityValueLabel(entry.content.from, metadataLabels)}</dd>
            </div>
            <div>
              <dt>{metadataLabels.to}</dt>
              <dd>{activityValueLabel(entry.content.to, metadataLabels)}</dd>
            </div>
          </>
        ) : null}
        {entry.content.type === 'updated' && entry.content.fields?.length ? (
          <div>
            <dt>{metadataLabels.fields}</dt>
            <dd>{entry.content.fields.join(', ')}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

function IssueActivityTimelineRow({
  activity,
  index,
  item,
  onNodeReferenceOpen,
  onOpenRunDetailsPanel,
}: {
  activity: readonly Activity[];
  index: DocumentIndex;
  item: IssueActivityTimelineItem;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenRunDetailsPanel?: (conversationId: string | null, runId: string | null) => boolean | void;
}) {
  if (item.type === 'execution' && item.session) {
    return (
      <AgentSessionInlineCard
        activity={activity}
        index={index}
        onNodeReferenceOpen={onNodeReferenceOpen}
        onOpenRunDetailsPanel={onOpenRunDetailsPanel}
        session={item.session}
      />
    );
  }
  if (item.activity) return <ActivityEventRow entry={item.activity} />;
  return null;
}

export function AgentIssueDetailsPanel({
  breadcrumbs = [],
  index,
  onBack,
  onClose,
  onOpenIssue,
  onNodeReferenceOpen,
  onOpenRunDetailsPanel,
  onSelectBreadcrumb,
  target,
}: AgentIssueDetailsPanelProps) {
  const { locale, t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [acceptingReview, setAcceptingReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<IssueReadResult | null>(null);
  const loadRequestRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  useAgentDetailDrawerHeight(true);

  const load = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setLoading(true);
    setError(null);
    try {
      const nextDetail = await api.agentIssueRead({ target, include: [...ISSUE_DETAIL_INCLUDE] });
      if (requestId === loadRequestRef.current) setDetail(nextDetail);
    } catch (caught) {
      if (requestId === loadRequestRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [target]);

  const scheduleLoad = useCallback(() => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void load();
    }, 300);
  }, [load]);

  useEffect(() => {
    setDetail(null);
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    void load();
    return () => {
      loadRequestRef.current += 1;
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [load]);

  const issue = detail?.issue;
  const recurringIssue = detail?.recurringIssue;
  const title = issueDisplayTitleForDetail(issue, recurringIssue, t.agent.issue.unknown);
  const rawActivity = useMemo(() => [...(detail?.activity ?? [])].sort((left, right) => right.createdAt - left.createdAt), [detail?.activity]);
  const sessions = useMemo(() => [...(detail?.sessions ?? [])].sort((left, right) => right.updatedAt - left.updatedAt), [detail?.sessions]);
  const activityTimeline = useMemo(() => issueActivityTimelineItems(rawActivity, sessions), [rawActivity, sessions]);
  const hasActiveSessions = useMemo(() => sessions.some((session) => isActiveAgentSessionState(session.state)), [sessions]);
  const canAcceptHumanReview = Boolean(
    issue
    && issue.status.category !== 'completed'
    && issue.status.category !== 'canceled'
    && issue.verificationPolicy?.mode === 'human-review'
    && !hasActiveSessions
    && sessions.some((session) => session.purpose !== 'verify' && session.state === 'complete'),
  );
  const detailMarker = issueDetailMarker(issue, recurringIssue, sessions);
  const DetailMarkerIcon = detailMarker.icon;
  const statusLabel = issueDetailStatusLabel(issue, recurringIssue);
  const statusClass = issueDetailStatusClass(issue, recurringIssue);
  const timingLine = issueDetailTimingLine(issue, recurringIssue, t, locale);
  const breadcrumbEntries = breadcrumbs.length > 0 ? breadcrumbs : [{ target }];
  const lastBreadcrumbIndex = breadcrumbEntries.length - 1;

  useEffect(() => {
    if (!hasActiveSessions) return undefined;
    const timer = window.setInterval(() => scheduleLoad(), 1_500);
    return () => window.clearInterval(timer);
  }, [hasActiveSessions, scheduleLoad]);

  useEffect(() => window.lin?.onAgentEvent((event) => {
    if (!shouldRefreshIssueWorkForAgentEvent(event)) return;
    scheduleLoad();
  }), [scheduleLoad]);

  const acceptHumanReview = useCallback(async () => {
    if (!issue || acceptingReview) return;
    setAcceptingReview(true);
    setError(null);
    try {
      const result = await api.agentIssueCompleteHumanReview(issue.id, issue.revision);
      if (result.status !== 'applied') {
        throw new Error(result.validation?.[0]?.message ?? t.agent.issueDetail.reviewFailed);
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAcceptingReview(false);
    }
  }, [acceptingReview, issue, load, t.agent.issueDetail.reviewFailed]);

  return (
    <section className="agent-run-detail-panel agent-issue-detail-panel" aria-label={t.agent.issueDetail.detailsAriaLabel}>
      <AgentDetailDrawerResizeHandle />
      <header className="agent-run-detail-header">
        <div className="agent-run-detail-breadcrumb-row">
          {onBack ? (
            <IconButton
              className="agent-run-detail-back"
              icon={BackIcon}
              label={t.agent.issueDetail.backToParent}
              onClick={onBack}
              title={t.agent.issueDetail.backToParent}
              variant="message"
            />
          ) : null}
          <nav className="agent-issue-breadcrumb" aria-label={t.agent.issueDetail.breadcrumbAriaLabel}>
            <span className="agent-run-detail-breadcrumb-root">{t.agent.issue.heading}</span>
            {breadcrumbEntries.map((entry, index) => {
              const label = issueBreadcrumbLabel(entry, title, index, lastBreadcrumbIndex, t.agent.issue);
              return (
                <span className="agent-issue-breadcrumb-segment" key={`${entry.target.type}:${entry.target.id}:${index}`}>
                  <ChevronRightIcon aria-hidden="true" size={ICON_SIZE.tiny} />
                  {index < lastBreadcrumbIndex && onSelectBreadcrumb ? (
                    <ButtonControl
                      className="agent-issue-breadcrumb-button"
                      onClick={() => onSelectBreadcrumb(index)}
                    >
                      {label}
                    </ButtonControl>
                  ) : (
                    <span>{label}</span>
                  )}
                </span>
              );
            })}
          </nav>
          <div className="agent-run-detail-header-actions">
            <IconButton
              className="agent-run-detail-close"
              icon={CloseIcon}
              label={t.agent.issueDetail.close}
              onClick={onClose}
              title={t.agent.issueDetail.close}
              variant="message"
            />
          </div>
        </div>
      </header>
      <div className="agent-run-detail-body">
        {error ? (
          <ErrorState
            className="agent-run-detail-empty"
            message={error}
            onRetry={() => void load()}
            retryLabel={t.agent.issue.refresh}
          />
        ) : loading && !detail ? (
          <EmptyState
            className="agent-run-detail-empty"
            icon={LoaderIcon}
            loading
            title={t.agent.issue.loading}
          />
        ) : (
          <>
            <div className="agent-run-detail-title-line">
              <span className={`agent-issue-detail-marker ${detailMarker.className}`.trim()}>
                <DetailMarkerIcon aria-hidden="true" size={ICON_SIZE.menu} />
              </span>
              <div className="agent-issue-detail-title-copy">
                <h3>{title}</h3>
                {statusLabel ? (
                  <span className={`agent-issue-detail-status-chip ${statusClass}`}>
                    {statusLabel}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="agent-run-detail-content-column">
              {timingLine ? <div className="agent-issue-detail-timing">{timingLine}</div> : null}
              {canAcceptHumanReview ? (
                <div className="agent-issue-review-action">
                  <ButtonControl
                    className="agent-issue-review-accept"
                    disabled={acceptingReview}
                    onClick={() => void acceptHumanReview()}
                  >
                    {acceptingReview
                      ? <LoaderIcon className="agent-run-status-spinner" size={ICON_SIZE.menu} />
                      : <CheckIcon aria-hidden="true" size={ICON_SIZE.menu} />}
                    <span>{acceptingReview ? t.agent.issueDetail.acceptingReview : t.agent.issueDetail.acceptReview}</span>
                  </ButtonControl>
                </div>
              ) : null}
              {issue?.description || recurringIssue?.descriptionTemplate ? (
                <section className="agent-issue-detail-section">
                  <IssueDetailSectionHeading icon={DescriptionIcon}>{t.agent.issueDetail.instructions}</IssueDetailSectionHeading>
                  <div className="agent-issue-detail-description">
                    {issue?.description ?? recurringIssue?.descriptionTemplate}
                  </div>
                </section>
              ) : null}
              {detail?.childIssues?.length ? (
                <section className="agent-issue-detail-section">
                  <IssueDetailSectionHeading icon={AddChildIcon}>{t.agent.issueDetail.childIssues}</IssueDetailSectionHeading>
                  <IssueLinkedRows issues={detail.childIssues} onOpenIssue={onOpenIssue} />
                </section>
              ) : null}
              {detail?.generatedIssues?.length ? (
                <section className="agent-issue-detail-section">
                  <IssueDetailSectionHeading icon={AddChildIcon}>{t.agent.issueDetail.generatedIssues}</IssueDetailSectionHeading>
                  <IssueLinkedRows issues={detail.generatedIssues} onOpenIssue={onOpenIssue} />
                </section>
              ) : null}
              <section className="agent-issue-detail-section">
                <IssueDetailSectionHeading icon={RunStatusToolIcon}>{t.agent.issueDetail.activity}</IssueDetailSectionHeading>
                {activityTimeline.length === 0 ? (
                  <div className="agent-issue-activity-empty">{t.agent.issueDetail.noActivity}</div>
                ) : (
                  <ol className="agent-issue-activity-list">
                    {activityTimeline.map((item) => (
                      <li className="agent-issue-activity-item" key={`${item.type}:${item.id}`}>
                        <IssueActivityTimelineRow
                          activity={rawActivity}
                          index={index}
                          item={item}
                          onNodeReferenceOpen={onNodeReferenceOpen}
                          onOpenRunDetailsPanel={onOpenRunDetailsPanel}
                        />
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
