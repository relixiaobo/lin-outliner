import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Activity,
  AgentIssue,
  AgentRecurringIssue,
  AgentSession,
  IssueReadResult,
  IssueSearchInput,
  IssueSearchRow,
  IssueTargetRef,
} from '../../api/types';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import {
  type AppIcon,
  BackIcon,
  CheckIcon,
  CalendarIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  ICON_SIZE,
  InboxIcon,
  LoaderIcon,
  RepeatIcon,
  ScheduledIcon,
  WarningIcon,
} from '../icons';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { ButtonControl } from '../primitives/ButtonControl';
import { AgentMarkdown } from './AgentMarkdown';
import { AgentDetailDrawerResizeHandle, useAgentDetailDrawerHeight } from './AgentDetailDrawerResize';

export type IssueWorkPreset = 'inbox' | 'today' | 'upcoming' | 'logbook';

const ISSUE_WORK_PRESETS: readonly IssueWorkPreset[] = ['inbox', 'today', 'upcoming', 'logbook'];
const ISSUE_WORK_PRESET_ICONS = {
  inbox: InboxIcon,
  today: ClockIcon,
  upcoming: CalendarIcon,
  logbook: CheckIcon,
} satisfies Record<IssueWorkPreset, AppIcon>;
const ACTIVE_SESSION_STATES = new Set<AgentSession['state']>(['pending', 'active', 'awaitingInput']);
const TERMINAL_STATUS_CATEGORIES = new Set(['completed', 'canceled']);
const ISSUE_ROW_INCLUDE: NonNullable<IssueSearchInput['include']> = ['activity-summary', 'session-summary'];

interface AgentIssuesPanelProps {
  activeSessionCount: number;
  error: string | null;
  loading: boolean;
  onOpenIssue: (target: IssueTargetRef) => void;
  onPresetChange: (preset: IssueWorkPreset) => void;
  onRefresh: () => void;
  preset: IssueWorkPreset;
  rows: readonly IssueSearchRow[];
}

interface AgentIssueDetailsPanelProps {
  breadcrumbs?: readonly IssueDetailBreadcrumb[];
  onBack?: () => void;
  onClose: () => void;
  onOpenIssue?: (target: IssueTargetRef, title?: string) => void;
  onSelectBreadcrumb?: (index: number) => void;
  target: IssueTargetRef;
}

export interface IssueDetailBreadcrumb {
  target: IssueTargetRef;
  title?: string;
}

const ISSUE_DETAIL_INCLUDE = ['activity', 'sessions', 'sub-issues', 'generated-issues', 'criteria'] as const;

export function issueSearchInputForWorkPreset(preset: IssueWorkPreset): IssueSearchInput {
  return issueSearchInputsForWorkPreset(preset)[0]!;
}

export function issueSearchInputsForWorkPreset(preset: IssueWorkPreset, now = Date.now()): IssueSearchInput[] {
  const start = startOfLocalDay(now);
  const end = endOfLocalDay(now);
  switch (preset) {
    case 'inbox':
      return [
        { filter: { archived: false, needsAttention: true }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { archived: false, triggerTypes: ['manual'], hasActiveSession: false }, include: ISSUE_ROW_INCLUDE, limit: 100 },
      ];
    case 'today':
      return [
        { targets: ['issue'], filter: { archived: false, hasActiveSession: true }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { archived: false, statusCategories: ['scheduled'] }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { archived: false, dueDate: { to: end } }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['recurring-issue'], filter: { archived: false, nextMaterializationAt: { to: end } }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { statusCategories: ['completed', 'canceled'], updatedAt: { from: start, to: end } }, include: ISSUE_ROW_INCLUDE, limit: 100 },
      ];
    case 'upcoming':
      return [
        { targets: ['recurring-issue'], filter: { archived: false }, include: ISSUE_ROW_INCLUDE, orderBy: [{ field: 'nextMaterializationAt', direction: 'asc' }], limit: 100 },
        { targets: ['issue'], filter: { archived: false, statusCategories: ['scheduled'] }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { archived: false, dueDate: { from: end + 1 } }, include: ISSUE_ROW_INCLUDE, orderBy: [{ field: 'dueDate', direction: 'asc' }], limit: 100 },
      ];
    case 'logbook':
      return [{
        targets: ['issue'],
        filter: { statusCategories: ['completed', 'canceled', 'archived'] },
        include: ISSUE_ROW_INCLUDE,
        limit: 100,
      }];
  }
}

function targetKey(target: IssueTargetRef): string {
  return `${target.type}:${target.id}`;
}

function relativeTimeLabel(timestamp: number, labels: ReturnType<typeof useT>['agent']['run'], now = Date.now()): string {
  const deltaMs = Math.max(0, now - timestamp);
  if (deltaMs < 60_000) return labels.relativeJustNow;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return labels.relativeMinutesAgo({ count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.relativeHoursAgo({ count: hours });
  return labels.relativeDaysAgo({ count: Math.floor(hours / 24) });
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function endOfLocalDay(timestamp: number): number {
  return startOfLocalDay(timestamp) + 86_400_000 - 1;
}

function isWithinToday(timestamp: number | undefined, now: number): boolean {
  return timestamp !== undefined && timestamp >= startOfLocalDay(now) && timestamp <= endOfLocalDay(now);
}

function isDueByToday(timestamp: number | undefined, now: number): boolean {
  return timestamp !== undefined && timestamp <= endOfLocalDay(now);
}

function isAfterToday(timestamp: number | undefined, now: number): boolean {
  return timestamp !== undefined && timestamp > endOfLocalDay(now);
}

function timeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}

function dateTimeLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}

function dateSectionLabel(timestamp: number, now: number, labels: ReturnType<typeof useT>['agent']['issue']): string {
  const start = startOfLocalDay(timestamp);
  if (start === startOfLocalDay(now)) return labels.view.today;
  if (start === startOfLocalDay(now) + 86_400_000) return labels.section.tomorrow;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', weekday: 'long' }).format(new Date(timestamp));
}

function dateTimeRelativeLabel(timestamp: number, now: number, labels: ReturnType<typeof useT>['agent']['issue']): string {
  const start = startOfLocalDay(timestamp);
  if (start === startOfLocalDay(now)) return `${labels.summary.today}, ${timeLabel(timestamp)}`;
  if (start === startOfLocalDay(now) + 86_400_000) return `${labels.section.tomorrow}, ${timeLabel(timestamp)}`;
  return dateTimeLabel(timestamp);
}

function scheduleTimeForPreset(timestamp: number, preset: IssueWorkPreset, now: number, labels: ReturnType<typeof useT>['agent']['issue']): string {
  if (preset === 'today' || preset === 'upcoming') return timeLabel(timestamp);
  return dateTimeRelativeLabel(timestamp, now, labels);
}

function joinRowSummaryParts(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

export function issueDisplayTitleForRow(row: IssueSearchRow): string {
  return row.target.type === 'recurring-issue'
    ? displayRecurringTemplateTitle(row.title)
    : row.title;
}

function issueDisplayTitleForDetail(issue: AgentIssue | undefined, recurringIssue: AgentRecurringIssue | undefined, fallback: string): string {
  if (issue) return issue.title;
  if (recurringIssue) return displayRecurringTemplateTitle(recurringIssue.titleTemplate);
  return fallback;
}

function displayRecurringTemplateTitle(titleTemplate: string): string {
  const cleaned = titleTemplate
    .replace(/\s*[-:|\/\u2013\u2014]\s*\{\{\s*date\s*\}\}\s*/gi, ' ')
    .replace(/\s*\{\{\s*date\s*\}\}\s*[-:|\/\u2013\u2014]\s*/gi, ' ')
    .replace(/\{\{\s*date\s*\}\}/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[-:|\/\u2013\u2014]\s*/, '')
    .replace(/\s*[-:|\/\u2013\u2014]$/, '')
    .trim();
  return cleaned || titleTemplate;
}

function activityText(activity: Activity): string {
  switch (activity.content.type) {
    case 'comment':
    case 'agent-progress':
    case 'agent-question':
    case 'agent-response':
    case 'agent-error':
      return activity.content.body;
    case 'field-change':
      return `Changed ${activity.content.field}.`;
    case 'status-change':
      return `Status changed to ${activity.content.to}.`;
    case 'agent-action':
      return activity.content.result
        ? `${activity.content.action}: ${activity.content.result}`
        : activity.content.action;
    case 'verification-result':
      return `${activity.content.verdict}: ${activity.content.body}`;
    case 'output-link':
      return activity.content.label;
  }
}

function sessionStateLabel(state: AgentSession['state'], labels: ReturnType<typeof useT>['agent']['issue']): string {
  switch (state) {
    case 'pending':
      return labels.sessionState.pending;
    case 'active':
      return labels.sessionState.active;
    case 'awaitingInput':
      return labels.sessionState.awaitingInput;
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

function issueTriggerLabel(issue: AgentIssue, labels: ReturnType<typeof useT>['agent']['issue']): string {
  if (issue.trigger.type === 'manual') return labels.triggerManual;
  if (issue.trigger.type === 'when-ready') return labels.triggerWhenReady;
  return labels.triggerScheduled;
}

function cadenceLabel(recurringIssue: AgentRecurringIssue, labels: ReturnType<typeof useT>['agent']['issue']): string {
  switch (recurringIssue.cadence.type) {
    case 'daily':
      return labels.cadenceDaily;
    case 'weekly':
      return labels.cadenceWeekly;
    case 'monthly':
      return labels.cadenceMonthly;
  }
}

function cadenceLabelForRow(row: IssueSearchRow, labels: ReturnType<typeof useT>['agent']['issue']): string {
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
  labels: ReturnType<typeof useT>,
  now = Date.now(),
): string | null {
  if (recurringIssue) {
    const next = recurringIssue.nextMaterializationAt !== undefined
      ? dateTimeRelativeLabel(recurringIssue.nextMaterializationAt, now, labels.agent.issue)
      : labels.agent.issue.summary.noNextRun;
    return `${labels.agent.issueDetail.nextRun} ${next} · ${cadenceLabel(recurringIssue, labels.agent.issue)}`;
  }
  if (!issue) return null;
  if (issue.trigger.type === 'scheduled') {
    return `${labels.agent.issueDetail.starts} ${dateTimeRelativeLabel(issue.trigger.startAt, now, labels.agent.issue)}`;
  }
  if (issue.dueDate) {
    return `${labels.agent.issue.summary.due} ${dateTimeRelativeLabel(issue.dueDate.targetAt, now, labels.agent.issue)}`;
  }
  if (issue.status.category === 'completed' || issue.status.category === 'canceled') return null;
  return issueTriggerLabel(issue, labels.agent.issue);
}

function issueTargetFallbackLabel(target: IssueTargetRef, labels: ReturnType<typeof useT>['agent']['issue']): string {
  return target.type === 'recurring-issue' ? labels.recurringIssue : labels.issue;
}

function issueBreadcrumbLabel(
  entry: IssueDetailBreadcrumb,
  currentTitle: string,
  index: number,
  lastIndex: number,
  labels: ReturnType<typeof useT>['agent']['issue'],
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

function issueDetailMarker(
  issue: AgentIssue | undefined,
  recurringIssue: AgentRecurringIssue | undefined,
  sessions: readonly AgentSession[],
): { icon: AppIcon; className: string } {
  if (issue?.status.category === 'completed') return { icon: CheckIcon, className: 'is-complete' };
  if (issue?.status.category === 'canceled') return { icon: WarningIcon, className: 'is-attention' };
  if (sessions.some((session) => ACTIVE_SESSION_STATES.has(session.state))) return { icon: LoaderIcon, className: 'is-active' };
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

function sessionSummary(session: AgentSession, labels: ReturnType<typeof useT>): string {
  if (session.errorMessage) return session.errorMessage;
  if (session.latestOutput) return session.latestOutput.replace(/\s+/g, ' ').trim();
  if (session.plan.length > 0) {
    const completed = session.plan.filter((item) => item.status === 'completed').length;
    return `${completed}/${session.plan.length}`;
  }
  return relativeTimeLabel(session.updatedAt, labels.agent.run);
}

function actorLabel(actor: Activity['actor'], labels: ReturnType<typeof useT>): string {
  if (actor.type === 'user') return labels.agent.message.you;
  if (actor.type === 'agent') return actor.agentId;
  return 'System';
}

function rowScheduledAt(row: IssueSearchRow): number | undefined {
  if (row.target.type === 'recurring-issue') return row.nextMaterializationAt;
  if (row.trigger?.type === 'scheduled') return row.trigger.startAt;
  return undefined;
}

function rowIsTerminal(row: IssueSearchRow): boolean {
  return Boolean(row.statusCategory && TERMINAL_STATUS_CATEGORIES.has(row.statusCategory));
}

function rowHasActiveSession(row: IssueSearchRow): boolean {
  return Boolean(row.hasActiveSession || (row.latestSessionState && ACTIVE_SESSION_STATES.has(row.latestSessionState)));
}

function rowIsUnarranged(row: IssueSearchRow): boolean {
  return row.target.type === 'issue'
    && !rowIsTerminal(row)
    && !rowHasActiveSession(row)
    && !row.needsAttention
    && row.trigger?.type !== 'scheduled'
    && row.dueDate === undefined;
}

export function issueRowMatchesWorkPreset(row: IssueSearchRow, preset: IssueWorkPreset, now = Date.now()): boolean {
  const scheduledAt = rowScheduledAt(row);
  switch (preset) {
    case 'inbox':
      return Boolean(row.needsAttention)
        || row.latestSessionState === 'awaitingInput'
        || row.latestSessionState === 'error'
        || row.latestSessionState === 'stale'
        || rowIsUnarranged(row);
    case 'today':
      return rowHasActiveSession(row)
        || isDueByToday(scheduledAt, now)
        || isDueByToday(row.dueDate?.targetAt, now)
        || isWithinToday(row.nextMaterializationAt, now)
        || isWithinToday(row.latestSessionUpdatedAt, now)
        || (rowIsTerminal(row) && isWithinToday(row.updatedAt, now));
    case 'upcoming':
      return row.target.type === 'recurring-issue'
        ? row.status !== 'archived'
        : !rowIsTerminal(row) && (isAfterToday(scheduledAt, now) || isAfterToday(row.dueDate?.targetAt, now));
    case 'logbook':
      return row.target.type === 'issue' && (rowIsTerminal(row) || row.viewBuckets?.includes('archived') === true);
  }
}

function issueWorkPresetRank(row: IssueSearchRow, preset: IssueWorkPreset, now: number): number {
  if (preset === 'today') {
    if (row.needsAttention) return 0;
    if (rowHasActiveSession(row)) return 1;
    if (row.target.type === 'recurring-issue' && isDueByToday(row.nextMaterializationAt, now)) return 2;
    if (isDueByToday(rowScheduledAt(row), now) || isDueByToday(row.dueDate?.targetAt, now)) return 3;
    if (rowIsTerminal(row)) return 4;
  }
  if (preset === 'inbox') {
    if (row.latestSessionState === 'awaitingInput') return 0;
    if (row.latestSessionState === 'error' || row.latestSessionState === 'stale') return 1;
    if (rowIsUnarranged(row)) return 2;
  }
  return 10;
}

function compareIssueRowsForPreset(left: IssueSearchRow, right: IssueSearchRow, preset: IssueWorkPreset, now: number): number {
  const rank = issueWorkPresetRank(left, preset, now) - issueWorkPresetRank(right, preset, now);
  if (rank !== 0) return rank;
  if (preset === 'upcoming') {
    const leftTime = rowScheduledAt(left) ?? left.dueDate?.targetAt ?? Number.MAX_SAFE_INTEGER;
    const rightTime = rowScheduledAt(right) ?? right.dueDate?.targetAt ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
  }
  return right.updatedAt - left.updatedAt || left.title.localeCompare(right.title);
}

interface IssueRowSection {
  key: string;
  label?: string;
  rows: IssueSearchRow[];
}

function sectionForTodayRow(row: IssueSearchRow, now: number, labels: ReturnType<typeof useT>['agent']['issue']): string {
  if (row.needsAttention) return labels.section.attention;
  if (rowHasActiveSession(row)) return labels.section.running;
  if (row.target.type === 'recurring-issue' && isDueByToday(row.nextMaterializationAt, now)) return labels.section.repeatingToday;
  if (isDueByToday(rowScheduledAt(row), now) || isDueByToday(row.dueDate?.targetAt, now)) return labels.section.dueToday;
  if (rowIsTerminal(row)) return labels.section.doneToday;
  return labels.view.today;
}

function sectionForInboxRow(row: IssueSearchRow, labels: ReturnType<typeof useT>['agent']['issue']): string {
  if (row.latestSessionState === 'awaitingInput') return labels.section.attention;
  if (row.latestSessionState === 'error' || row.latestSessionState === 'stale' || row.needsAttention) return labels.section.attention;
  return labels.section.unarranged;
}

function sectionForUpcomingRow(row: IssueSearchRow, now: number, labels: ReturnType<typeof useT>['agent']['issue']): string {
  const timestamp = rowScheduledAt(row) ?? row.dueDate?.targetAt;
  if (timestamp !== undefined) return dateSectionLabel(timestamp, now, labels);
  if (row.target.type === 'recurring-issue') return labels.section.repeating;
  return labels.view.upcoming;
}

function groupIssueRowsForPreset(
  rows: readonly IssueSearchRow[],
  preset: IssueWorkPreset,
  now: number,
  labels: ReturnType<typeof useT>['agent']['issue'],
): IssueRowSection[] {
  if (preset === 'logbook') return [{ key: preset, rows: [...rows] }];

  const sections: IssueRowSection[] = [];
  const byLabel = new Map<string, IssueRowSection>();
  for (const row of rows) {
    const label = preset === 'today'
      ? sectionForTodayRow(row, now, labels)
      : preset === 'inbox'
        ? sectionForInboxRow(row, labels)
        : sectionForUpcomingRow(row, now, labels);
    let section = byLabel.get(label);
    if (!section) {
      section = { key: `${preset}:${label}`, label, rows: [] };
      byLabel.set(label, section);
      sections.push(section);
    }
    section.rows.push(row);
  }
  return sections;
}

function IssueStatusMarker({ row }: { row: IssueSearchRow }) {
  const isRecurring = row.target.type === 'recurring-issue';
  const isActive = rowHasActiveSession(row);
  const isComplete = rowIsTerminal(row);
  const isAttention = row.target.type !== 'recurring-issue' && Boolean(row.needsAttention);
  const isScheduled = !isRecurring && (rowScheduledAt(row) !== undefined || row.dueDate !== undefined);
  const isUnarranged = rowIsUnarranged(row);
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
            : isUnarranged
              ? InboxIcon
              : ClockIcon;
  const classes = [
    'agent-issue-marker',
    isRecurring ? 'is-recurring' : '',
    isActive ? 'is-active' : '',
    isComplete ? 'is-complete' : '',
    isAttention ? 'is-attention' : '',
    isScheduled ? 'is-scheduled' : '',
    isUnarranged ? 'is-unarranged' : '',
  ].filter(Boolean).join(' ');
  return (
    <span className={classes}>
      <Icon aria-hidden="true" size={ICON_SIZE.menu} />
    </span>
  );
}

export function issueRowSummaryForRow(row: IssueSearchRow, preset: IssueWorkPreset, labels: ReturnType<typeof useT>, now = Date.now()): string {
  const issueLabels = labels.agent.issue;
  const sessionState = row.latestSessionState ? sessionStateLabel(row.latestSessionState, issueLabels) : null;
  const sessionNeedsAttention = row.latestSessionState === 'awaitingInput'
    || row.latestSessionState === 'error'
    || row.latestSessionState === 'stale'
    || Boolean(row.needsAttention);
  if (sessionNeedsAttention && sessionState) {
    return `${sessionState} · ${relativeTimeLabel(row.latestSessionUpdatedAt ?? row.updatedAt, labels.agent.run, now)}`;
  }
  if (rowHasActiveSession(row) && sessionState) {
    return `${sessionState} · ${relativeTimeLabel(row.latestSessionUpdatedAt ?? row.updatedAt, labels.agent.run, now)}`;
  }
  if (row.target.type === 'recurring-issue') {
    const next = row.nextMaterializationAt !== undefined
      ? scheduleTimeForPreset(row.nextMaterializationAt, preset, now, issueLabels)
      : issueLabels.summary.noNextRun;
    return joinRowSummaryParts([
      next,
      cadenceLabelForRow(row, issueLabels),
      row.status === 'paused' ? issueLabels.summary.paused : undefined,
    ]);
  }
  if (row.trigger?.type === 'scheduled') {
    return joinRowSummaryParts([
      scheduleTimeForPreset(row.trigger.startAt, preset, now, issueLabels),
      issueLabels.summary.scheduled,
    ]);
  }
  if (row.dueDate) {
    return joinRowSummaryParts([
      scheduleTimeForPreset(row.dueDate.targetAt, preset, now, issueLabels),
      issueLabels.summary.due,
    ]);
  }
  if (rowIsTerminal(row)) {
    if (preset === 'today') return relativeTimeLabel(row.updatedAt, labels.agent.run, now);
    return `${row.statusCategory === 'canceled' ? issueLabels.summary.canceled : issueLabels.summary.done} · ${relativeTimeLabel(row.updatedAt, labels.agent.run, now)}`;
  }
  if (row.latestActivity) {
    return `${activityText(row.latestActivity)} · ${relativeTimeLabel(row.latestActivity.createdAt, labels.agent.run, now)}`;
  }
  return `${row.status} · ${relativeTimeLabel(row.updatedAt, labels.agent.run, now)}`;
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
  const t = useT();
  const now = Date.now();
  const visibleRows = useMemo(() => rows
    .filter((row) => issueRowMatchesWorkPreset(row, preset, now))
    .sort((left, right) => compareIssueRowsForPreset(left, right, preset, now)), [now, preset, rows]);
  const sections = useMemo(() => groupIssueRowsForPreset(visibleRows, preset, now, t.agent.issue), [now, preset, t.agent.issue, visibleRows]);
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
                {section.rows.map((row) => (
                  <button
                    className="agent-run-row agent-issue-row is-clickable"
                    key={targetKey(row.target)}
                    onClick={() => onOpenIssue(row.target)}
                    type="button"
                  >
                    <IssueStatusMarker row={row} />
                    <span className="agent-run-main">
                      <span className="agent-run-title-row">
                        <span className="agent-run-title">{issueDisplayTitleForRow(row)}</span>
                      </span>
                      <span className="agent-run-summary">
                        {issueRowSummaryForRow(row, preset, t, now)}
                      </span>
                    </span>
                    <ChevronRightIcon className="agent-run-open-affordance" size={ICON_SIZE.menu} />
                  </button>
                ))}
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

function AgentSessionDetailsView({
  issueTitle,
  onBack,
  sessionId,
}: {
  issueTitle: string;
  onBack: () => void;
  sessionId: string;
}) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.agentSessionRead>> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.agentSessionRead({ agentSessionId: sessionId, include: ['activity-summary'] }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const session = result?.agentSession;
  const activity = useMemo(() => [...(result?.activity ?? [])].sort((left, right) => left.createdAt - right.createdAt), [result?.activity]);
  const StatusIcon = session?.state === 'complete'
    ? CheckIcon
    : session?.state === 'error' || session?.state === 'stale' || session?.state === 'canceled'
      ? WarningIcon
      : LoaderIcon;
  const status = session ? sessionStateLabel(session.state, t.agent.issue) : t.agent.issueDetail.none;
  const statusClass = session ? sessionStatusClass(session) : '';

  return (
    <>
      <div className="agent-run-detail-title-line">
        <span className={`agent-issue-detail-marker ${statusClass}`}>
          <StatusIcon aria-hidden="true" size={ICON_SIZE.menu} />
        </span>
        <div className="agent-issue-detail-title-copy">
          <h3>{t.agent.issueDetail.sessionTitle}</h3>
          <span className={`agent-issue-detail-status-chip ${statusClass}`}>{status}</span>
        </div>
      </div>
      <div className="agent-run-detail-content-column">
        <button className="agent-issue-detail-inline-back" onClick={onBack} type="button">
          <BackIcon aria-hidden="true" size={ICON_SIZE.menu} />
          <span>{issueTitle}</span>
        </button>
        {error ? (
          <ErrorState
            className="agent-run-detail-empty"
            message={error}
            onRetry={() => void load()}
            retryLabel={t.agent.issue.refresh}
          />
        ) : loading && !session ? (
          <EmptyState
            className="agent-run-detail-empty"
            icon={LoaderIcon}
            loading
            title={t.agent.issue.loading}
          />
        ) : session ? (
          <>
            {session.plan.length > 0 ? (
              <section className="agent-issue-detail-section">
                <h4>{t.agent.issueDetail.plan}</h4>
                <ol className="agent-issue-detail-list">
                  {session.plan.map((item, index) => (
                    <li key={`${index}:${item.content}`}>
                      <span>{item.content}</span>
                      <small>{item.status}</small>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
            <section className="agent-issue-detail-section">
              <h4>{t.agent.issueDetail.transcript}</h4>
              {activity.length === 0 && !session.latestOutput && !session.errorMessage ? (
                <div className="agent-issue-activity-empty">{t.agent.issueDetail.noSessionActivity}</div>
              ) : (
                <div className="agent-issue-session-transcript">
                  {activity.map((entry) => (
                    <article className="agent-issue-session-message" key={entry.id}>
                      <header>
                        <span>{actorLabel(entry.actor, t)}</span>
                        <time>{relativeTimeLabel(entry.createdAt, t.agent.run)}</time>
                      </header>
                      <AgentMarkdown keyPrefix={`agent-session-activity-${entry.id}`} text={activityText(entry)} />
                    </article>
                  ))}
                  {session.latestOutput ? (
                    <article className="agent-issue-session-message is-result">
                      <header>
                        <span>{t.agent.issueDetail.latestResult}</span>
                        <time>{relativeTimeLabel(session.updatedAt, t.agent.run)}</time>
                      </header>
                      <AgentMarkdown keyPrefix={`agent-session-result-${session.id}`} text={session.latestOutput} />
                    </article>
                  ) : null}
                  {session.errorMessage ? (
                    <article className="agent-issue-session-message is-error">
                      <header>
                        <span>{t.agent.issue.sessionState.error}</span>
                        <time>{relativeTimeLabel(session.updatedAt, t.agent.run)}</time>
                      </header>
                      <AgentMarkdown keyPrefix={`agent-session-error-${session.id}`} text={session.errorMessage} />
                    </article>
                  ) : null}
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="agent-run-detail-empty">{t.agent.issueDetail.sessionNotFound}</div>
        )}
      </div>
    </>
  );
}

export function AgentIssueDetailsPanel({
  breadcrumbs = [],
  onBack,
  onClose,
  onOpenIssue,
  onSelectBreadcrumb,
  target,
}: AgentIssueDetailsPanelProps) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<IssueReadResult | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  useAgentDetailDrawerHeight(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.agentIssueRead({ target, include: [...ISSUE_DETAIL_INCLUDE] }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [target]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSelectedSessionId(null);
  }, [target]);

  const issue = detail?.issue;
  const recurringIssue = detail?.recurringIssue;
  const title = issueDisplayTitleForDetail(issue, recurringIssue, t.agent.issue.unknown);
  const activity = useMemo(() => [...(detail?.activity ?? [])].sort((left, right) => right.createdAt - left.createdAt), [detail?.activity]);
  const sessions = useMemo(() => [...(detail?.sessions ?? [])].sort((left, right) => right.updatedAt - left.updatedAt), [detail?.sessions]);
  const detailMarker = issueDetailMarker(issue, recurringIssue, sessions);
  const DetailMarkerIcon = detailMarker.icon;
  const statusLabel = issueDetailStatusLabel(issue, recurringIssue);
  const statusClass = issueDetailStatusClass(issue, recurringIssue);
  const timingLine = issueDetailTimingLine(issue, recurringIssue, t);
  const breadcrumbEntries = breadcrumbs.length > 0 ? breadcrumbs : [{ target }];
  const lastBreadcrumbIndex = breadcrumbEntries.length - 1;

  return (
    <section className="agent-run-detail-panel agent-issue-detail-panel" aria-label={t.agent.issueDetail.detailsAriaLabel}>
      <AgentDetailDrawerResizeHandle />
      <header className="agent-run-detail-header">
        <div className="agent-run-detail-breadcrumb-row">
          {selectedSessionId ? (
            <IconButton
              className="agent-run-detail-back"
              icon={BackIcon}
              label={t.agent.issueDetail.backToIssue}
              onClick={() => setSelectedSessionId(null)}
              title={t.agent.issueDetail.backToIssue}
              variant="message"
            />
          ) : onBack ? (
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
            {selectedSessionId ? (
              <span className="agent-issue-breadcrumb-segment">
                <ChevronRightIcon aria-hidden="true" size={ICON_SIZE.tiny} />
                <span>{t.agent.issueDetail.sessionTitle}</span>
              </span>
            ) : null}
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
          selectedSessionId ? (
            <AgentSessionDetailsView
              issueTitle={title}
              onBack={() => setSelectedSessionId(null)}
              sessionId={selectedSessionId}
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
              {issue?.description || recurringIssue?.descriptionTemplate ? (
                <section className="agent-issue-detail-section">
                  <h4>{t.agent.issueDetail.instructions}</h4>
                  <div className="agent-issue-detail-description">
                    {issue?.description ?? recurringIssue?.descriptionTemplate}
                  </div>
                </section>
              ) : null}
              {sessions.length > 0 ? (
                <section className="agent-issue-detail-section">
                  <h4>{t.agent.issueDetail.sessions}</h4>
                  <div className="agent-issue-session-list">
                    {sessions.map((session) => (
                      <button
                        className="agent-issue-session-row is-clickable"
                        key={session.id}
                        onClick={() => setSelectedSessionId(session.id)}
                        type="button"
                      >
                        <div className="agent-issue-session-head">
                          <span>{sessionStateLabel(session.state, t.agent.issue)}</span>
                          <span>{relativeTimeLabel(session.updatedAt, t.agent.run)}</span>
                        </div>
                        <p>{sessionSummary(session, t)}</p>
                        {session.errorMessage ? (
                          <p className="agent-issue-session-error">
                            <WarningIcon size={ICON_SIZE.menu} />
                            <span>{session.errorMessage}</span>
                          </p>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              {detail?.subIssues?.length ? (
                <section className="agent-issue-detail-section">
                  <h4>{t.agent.issueDetail.subIssues}</h4>
                  <div className="agent-issue-detail-list">
                    {detail.subIssues.map((subIssue) => (
                      <button
                        className="agent-issue-linked-row"
                        key={subIssue.id}
                        onClick={() => onOpenIssue?.(detailTargetForIssue(subIssue), subIssue.title)}
                        type="button"
                      >
                        <span className={`agent-issue-linked-status ${issueStatusClassForIssue(subIssue)}`}>
                          {subIssue.status.category === 'completed' ? <CheckIcon size={ICON_SIZE.menu} /> : <ClockIcon size={ICON_SIZE.menu} />}
                        </span>
                        <span className="agent-issue-linked-main">
                          <span>{subIssue.title}</span>
                          <small>{subIssue.status.name}</small>
                        </span>
                        <ChevronRightIcon aria-hidden="true" size={ICON_SIZE.menu} />
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              {detail?.generatedIssues?.length ? (
                <section className="agent-issue-detail-section">
                  <h4>{t.agent.issueDetail.generatedIssues}</h4>
                  <div className="agent-issue-detail-list">
                    {detail.generatedIssues.map((generatedIssue) => (
                      <button
                        className="agent-issue-linked-row"
                        key={generatedIssue.id}
                        onClick={() => onOpenIssue?.(detailTargetForIssue(generatedIssue), generatedIssue.title)}
                        type="button"
                      >
                        <span className={`agent-issue-linked-status ${issueStatusClassForIssue(generatedIssue)}`}>
                          {generatedIssue.status.category === 'completed' ? <CheckIcon size={ICON_SIZE.menu} /> : <ClockIcon size={ICON_SIZE.menu} />}
                        </span>
                        <span className="agent-issue-linked-main">
                          <span>{generatedIssue.title}</span>
                          <small>{generatedIssue.status.name}</small>
                        </span>
                        <ChevronRightIcon aria-hidden="true" size={ICON_SIZE.menu} />
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="agent-issue-detail-section">
                <h4>{t.agent.issueDetail.activity}</h4>
                {activity.length === 0 ? (
                  <div className="agent-issue-activity-empty">{t.agent.issueDetail.noActivity}</div>
                ) : (
                  <ol className="agent-issue-activity-list">
                    {activity.map((entry) => (
                      <li key={entry.id}>
                        <span>{activityText(entry)}</span>
                        <time>{relativeTimeLabel(entry.createdAt, t.agent.run)}</time>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
          )
        )}
      </div>
    </section>
  );
}
