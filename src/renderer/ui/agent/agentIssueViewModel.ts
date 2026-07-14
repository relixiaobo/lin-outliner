import type {
  Activity,
  AgentSession,
  IssueSearchInput,
  IssueSearchResult,
  IssueSearchRow,
} from '../../api/types';
import type { AgentRuntimeEvent } from '../../../core/agentTypes';
import {
  isActiveAgentSessionState,
  isUserVisibleIssueActivity,
  isUserVisibleSessionProcessActivity,
} from '../../../core/agentIssue';
import type { Messages } from '../../../core/i18n';

export type IssueWorkPreset = 'inbox' | 'today' | 'upcoming' | 'logbook';

const ISSUE_ROW_INCLUDE: NonNullable<IssueSearchInput['include']> = ['activity-summary', 'session-summary'];
const TERMINAL_STATUS_CATEGORIES = new Set(['completed', 'canceled']);
const ISSUE_SEARCH_PAGE_LIMIT = 100;

export const ISSUE_DETAIL_INCLUDE = ['activity', 'sessions', 'child-issues', 'generated-issues'] as const;

export async function loadAllIssueSearchRows(
  input: IssueSearchInput,
  search: (page: IssueSearchInput) => Promise<IssueSearchResult>,
): Promise<IssueSearchRow[]> {
  const rows: IssueSearchRow[] = [];
  const seenCursors = new Set<string>();
  let cursor = input.cursor;
  if (cursor) seenCursors.add(cursor);
  while (true) {
    const result = await search({ ...input, limit: ISSUE_SEARCH_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    rows.push(...result.rows);
    if (!result.nextCursor || seenCursors.has(result.nextCursor)) return rows;
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
}

export function shouldRefreshIssueWorkForAgentEvent(event: AgentRuntimeEvent): boolean {
  return !(
    (event.type === 'projection' || event.type === 'projection_patch')
    && event.lastEventType === 'message_update'
  );
}

export function issueSearchInputForWorkPreset(preset: IssueWorkPreset): IssueSearchInput {
  return issueSearchInputsForWorkPreset(preset)[0]!;
}

export function issueSearchInputsForWorkPreset(preset: IssueWorkPreset, now = Date.now()): IssueSearchInput[] {
  const start = startOfLocalDay(now);
  const end = endOfLocalDay(now);
  switch (preset) {
    case 'inbox':
      return [
        { filter: { archived: false, needsAttention: true, hasParentIssue: false }, include: ISSUE_ROW_INCLUDE, limit: 100 },
      ];
    case 'today':
      return [
        { targets: ['issue'], filter: { archived: false, hasActiveSession: true, hasParentIssue: false }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { archived: false, triggerTypes: ['when-ready'], hasActiveSession: false, hasParentIssue: false }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { archived: false, statusCategories: ['scheduled'], hasParentIssue: false }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { archived: false, dueDate: { to: end }, hasParentIssue: false }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['recurring-issue'], filter: { archived: false, nextMaterializationAt: { to: end } }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { statusCategories: ['completed', 'canceled'], terminalAt: { from: start, to: end }, hasParentIssue: false }, include: ISSUE_ROW_INCLUDE, limit: 100 },
      ];
    case 'upcoming':
      return [
        { targets: ['recurring-issue'], filter: { archived: false }, include: ISSUE_ROW_INCLUDE, orderBy: [{ field: 'nextMaterializationAt', direction: 'asc' }], limit: 100 },
        { targets: ['issue'], filter: { archived: false, statusCategories: ['scheduled'], hasParentIssue: false }, include: ISSUE_ROW_INCLUDE, limit: 100 },
        { targets: ['issue'], filter: { archived: false, dueDate: { from: end + 1 }, hasParentIssue: false }, include: ISSUE_ROW_INCLUDE, orderBy: [{ field: 'dueDate', direction: 'asc' }], limit: 100 },
      ];
    case 'logbook':
      return [{
        targets: ['issue'],
        filter: { statusCategories: ['completed', 'canceled', 'archived'], hasParentIssue: false },
        include: ISSUE_ROW_INCLUDE,
        limit: 100,
      }];
  }
}

export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfNextLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

export function endOfLocalDay(timestamp: number): number {
  return startOfNextLocalDay(timestamp) - 1;
}

export function millisecondsUntilNextLocalMidnight(timestamp: number): number {
  return Math.max(1, startOfNextLocalDay(timestamp) - timestamp);
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

function timeLabel(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}

function dateTimeLabel(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
}

export function dateSectionLabel(timestamp: number, now: number, labels: Messages['agent']['issue'], locale: string): string {
  const start = startOfLocalDay(timestamp);
  if (start === startOfLocalDay(now)) return labels.view.today;
  if (start === startOfNextLocalDay(now)) return labels.section.tomorrow;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'long' }).format(new Date(timestamp));
}

export function dateTimeRelativeLabel(timestamp: number, now: number, labels: Messages['agent']['issue'], locale: string): string {
  const start = startOfLocalDay(timestamp);
  if (start === startOfLocalDay(now)) return `${labels.summary.today}, ${timeLabel(timestamp, locale)}`;
  if (start === startOfNextLocalDay(now)) return `${labels.section.tomorrow}, ${timeLabel(timestamp, locale)}`;
  return dateTimeLabel(timestamp, locale);
}

function scheduleTimeForPreset(timestamp: number, preset: IssueWorkPreset, now: number, labels: Messages['agent']['issue'], locale: string): string {
  if (preset === 'today' || preset === 'upcoming') return timeLabel(timestamp, locale);
  return dateTimeRelativeLabel(timestamp, now, labels, locale);
}

function joinRowSummaryParts(parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' · ');
}

export function displayRecurringTemplateTitle(titleTemplate: string): string {
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

export function issueDisplayTitleForRow(row: IssueSearchRow): string {
  return row.target.type === 'recurring-issue'
    ? displayRecurringTemplateTitle(row.title)
    : row.title;
}

type IssueActivityEventLabels = Messages['agent']['issueDetail']['activityEvent'];

export function agentActionActivityText(
  action: string,
  labels: IssueActivityEventLabels['action'],
): string {
  switch (action) {
    case 'agent_session_start':
      return labels.agentSessionStarted;
    case 'agent_session_stop':
      return labels.agentSessionStopped;
    case 'child_issue_created':
      return labels.childIssueCreated;
    case 'child_issue_completed':
      return labels.childIssueCompleted;
    case 'skip-next':
      return labels.skippedNextOccurrence;
    case 'materialize':
      return labels.generatedIssue;
    default:
      return action;
  }
}

export function activityText(activity: Activity, labels: IssueActivityEventLabels): string {
  switch (activity.content.type) {
    case 'created':
      return labels.created;
    case 'updated':
      return activity.content.fields?.length
        ? labels.updatedFields({ fields: activity.content.fields.join(', ') })
        : labels.updated;
    case 'archived':
      return labels.archived;
    case 'deleted':
      return labels.deleted;
    case 'comment':
    case 'agent-progress':
    case 'agent-question':
    case 'agent-response':
    case 'agent-error':
      return activity.content.body;
    case 'field-change':
      return labels.changedField({ field: activity.content.field });
    case 'status-change':
      return labels.changedStatus({ status: activity.content.to });
    case 'agent-action':
      return agentActionActivityText(activity.content.action, labels.action);
    case 'verification-result':
      return labels.verification[activity.content.verdict]({ body: activity.content.body });
    case 'output-link':
      return activity.content.label;
  }
}

export function rowScheduledAt(row: IssueSearchRow): number | undefined {
  if (row.target.type === 'recurring-issue') return row.nextMaterializationAt;
  if (row.trigger?.type === 'scheduled') return row.trigger.startAt;
  return undefined;
}

export function rowIsTerminal(row: IssueSearchRow): boolean {
  return Boolean(row.statusCategory && TERMINAL_STATUS_CATEGORIES.has(row.statusCategory));
}

export function rowHasActiveSession(row: IssueSearchRow): boolean {
  return Boolean(
    row.hasActiveSession
    || (row.latestSessionState && isActiveAgentSessionState(row.latestSessionState)),
  );
}

export function rowNeedsAttention(row: IssueSearchRow): boolean {
  return Boolean(row.needsAttention);
}

function rowLatestWorkAt(row: IssueSearchRow): number {
  return Math.max(row.terminalAt ?? row.updatedAt, row.latestSessionUpdatedAt ?? 0);
}

export function issueRowMatchesWorkPreset(row: IssueSearchRow, preset: IssueWorkPreset, now = Date.now()): boolean {
  if (row.target.type === 'issue' && row.parentIssueId !== undefined) return false;
  const scheduledAt = rowScheduledAt(row);
  switch (preset) {
    case 'inbox':
      return rowNeedsAttention(row)
        || row.latestSessionState === 'error'
        || row.latestSessionState === 'stale';
    case 'today':
      return rowHasActiveSession(row)
        || (row.target.type === 'issue' && row.trigger?.type === 'when-ready' && !rowIsTerminal(row))
        || (row.target.type === 'issue' && !rowIsTerminal(row) && isDueByToday(scheduledAt, now))
        || (row.target.type === 'issue' && !rowIsTerminal(row) && isDueByToday(row.dueDate?.targetAt, now))
        || (row.target.type === 'recurring-issue' && row.status === 'active' && isWithinToday(row.nextMaterializationAt, now))
        || isWithinToday(row.latestSessionUpdatedAt, now)
        || (rowIsTerminal(row) && isWithinToday(row.terminalAt, now));
    case 'upcoming':
      return row.target.type === 'recurring-issue'
        ? row.status !== 'archived'
        : !rowIsTerminal(row) && (isAfterToday(scheduledAt, now) || isAfterToday(row.dueDate?.targetAt, now));
    case 'logbook':
      return row.target.type === 'issue'
        && (rowIsTerminal(row) || row.viewBuckets?.includes('archived') === true);
  }
}

function issueWorkPresetRank(row: IssueSearchRow, preset: IssueWorkPreset, now: number): number {
  if (preset === 'today') {
    if (row.needsAttention) return 0;
    if (rowHasActiveSession(row)) return 1;
    if (row.target.type === 'issue' && row.trigger?.type === 'when-ready' && !rowIsTerminal(row)) return 2;
    if (row.target.type === 'recurring-issue' && row.status === 'active' && isDueByToday(row.nextMaterializationAt, now)) return 3;
    if (!rowIsTerminal(row) && (isDueByToday(rowScheduledAt(row), now) || isDueByToday(row.dueDate?.targetAt, now))) return 4;
    if (rowIsTerminal(row)) return 5;
  }
  if (preset === 'inbox') {
    if (row.latestSessionState === 'error' || row.latestSessionState === 'stale') return 1;
  }
  return 10;
}

export function compareIssueRowsForPreset(left: IssueSearchRow, right: IssueSearchRow, preset: IssueWorkPreset, now: number): number {
  const rank = issueWorkPresetRank(left, preset, now) - issueWorkPresetRank(right, preset, now);
  if (rank !== 0) return rank;
  if (preset === 'upcoming') {
    const leftTime = rowScheduledAt(left) ?? left.dueDate?.targetAt ?? Number.MAX_SAFE_INTEGER;
    const rightTime = rowScheduledAt(right) ?? right.dueDate?.targetAt ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
  }
  return rowLatestWorkAt(right) - rowLatestWorkAt(left) || left.title.localeCompare(right.title);
}

export interface IssueRowSection {
  key: string;
  label?: string;
  rows: IssueSearchRow[];
}

function sectionForTodayRow(row: IssueSearchRow, now: number, labels: Messages['agent']['issue']): string {
  if (rowNeedsAttention(row)) return labels.section.attention;
  if (rowHasActiveSession(row)) return labels.section.running;
  if (row.target.type === 'recurring-issue' && isDueByToday(row.nextMaterializationAt, now)) return labels.section.repeatingToday;
  if (isDueByToday(rowScheduledAt(row), now) || isDueByToday(row.dueDate?.targetAt, now)) return labels.section.dueToday;
  if (rowIsTerminal(row)) return labels.section.doneToday;
  return labels.view.today;
}

function sectionForInboxRow(row: IssueSearchRow, labels: Messages['agent']['issue']): string {
  if (row.latestSessionState === 'error' || row.latestSessionState === 'stale' || rowNeedsAttention(row)) return labels.section.attention;
  return labels.view.inbox;
}

function sectionForUpcomingRow(row: IssueSearchRow, now: number, labels: Messages['agent']['issue'], locale: string): string {
  const timestamp = rowScheduledAt(row) ?? row.dueDate?.targetAt;
  if (timestamp !== undefined) return dateSectionLabel(timestamp, now, labels, locale);
  if (row.target.type === 'recurring-issue') return labels.section.repeating;
  return labels.view.upcoming;
}

export function groupIssueRowsForPreset(
  rows: readonly IssueSearchRow[],
  preset: IssueWorkPreset,
  now: number,
  labels: Messages['agent']['issue'],
  locale: string,
): IssueRowSection[] {
  if (preset === 'logbook') return [{ key: preset, rows: [...rows] }];

  const sections: IssueRowSection[] = [];
  const byLabel = new Map<string, IssueRowSection>();
  for (const row of rows) {
    const label = preset === 'today'
      ? sectionForTodayRow(row, now, labels)
      : preset === 'inbox'
        ? sectionForInboxRow(row, labels)
        : sectionForUpcomingRow(row, now, labels, locale);
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

function cadenceLabelForRow(row: IssueSearchRow, labels: Messages['agent']['issue']): string {
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

export function relativeTimeLabel(timestamp: number, labels: Messages['agent']['run'], now = Date.now()): string {
  const deltaMs = Math.max(0, now - timestamp);
  if (deltaMs < 60_000) return labels.relativeJustNow;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return labels.relativeMinutesAgo({ count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return labels.relativeHoursAgo({ count: hours });
  return labels.relativeDaysAgo({ count: Math.floor(hours / 24) });
}

function sessionStateLabel(state: AgentSession['state'], labels: Messages['agent']['issue']): string {
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

export function issueRowSummaryForRow(row: IssueSearchRow, preset: IssueWorkPreset, labels: Messages, locale: string, now = Date.now()): string | null {
  const issueLabels = labels.agent.issue;
  const sessionState = row.latestSessionState ? sessionStateLabel(row.latestSessionState, issueLabels) : null;
  const sessionNeedsAttention = row.latestSessionState === 'error'
    || row.latestSessionState === 'stale'
    || rowNeedsAttention(row);
  if (sessionNeedsAttention && sessionState) {
    return `${sessionState} · ${relativeTimeLabel(row.latestSessionUpdatedAt ?? row.updatedAt, labels.agent.run, now)}`;
  }
  if (rowHasActiveSession(row) && sessionState) {
    return `${sessionState} · ${relativeTimeLabel(row.latestSessionUpdatedAt ?? row.updatedAt, labels.agent.run, now)}`;
  }
  if (row.target.type === 'recurring-issue') {
    const next = row.nextMaterializationAt !== undefined
      ? scheduleTimeForPreset(row.nextMaterializationAt, preset, now, issueLabels, locale)
      : issueLabels.summary.noNextRun;
    return joinRowSummaryParts([
      next,
      cadenceLabelForRow(row, issueLabels),
      row.status === 'paused' ? issueLabels.summary.paused : undefined,
    ]);
  }
  if (rowIsTerminal(row)) {
    const terminalLabel = row.statusCategory === 'canceled' ? issueLabels.summary.canceled : issueLabels.summary.done;
    const recency = relativeTimeLabel(row.terminalAt ?? row.updatedAt, labels.agent.run, now);
    if (preset === 'today') return recency;
    return joinRowSummaryParts([terminalLabel, recency]);
  }
  const scheduledAt = rowScheduledAt(row);
  if (scheduledAt !== undefined) {
    return joinRowSummaryParts([
      scheduleTimeForPreset(scheduledAt, preset, now, issueLabels, locale),
      issueLabels.summary.scheduled,
    ]);
  }
  if (row.dueDate) {
    return joinRowSummaryParts([
      scheduleTimeForPreset(row.dueDate.targetAt, preset, now, issueLabels, locale),
      issueLabels.summary.due,
    ]);
  }
  if (row.latestActivity) {
    return `${activityText(row.latestActivity, labels.agent.issueDetail.activityEvent)} · ${relativeTimeLabel(row.latestActivity.createdAt, labels.agent.run, now)}`;
  }
  return `${row.status} · ${relativeTimeLabel(row.updatedAt, labels.agent.run, now)}`;
}

export function sessionProcessActivityEntriesForDisplay(activity: readonly Activity[], session: AgentSession): Activity[] {
  return activity
    .filter((entry) => (
      (entry.target.type === 'agent-session' && entry.target.agentSessionId === session.id)
      || (entry.relatedTargets?.some((target) => target.type === 'agent-session' && target.id === session.id) ?? false)
    ))
    .filter(isUserVisibleSessionProcessActivity)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function activityEntriesForDisplay(activity: readonly Activity[]): Activity[] {
  return activity
    .filter(isUserVisibleIssueActivity)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export type IssueActivityTimelineItem = {
  activity: Activity | null;
  id: string;
  session?: AgentSession;
  timestamp: number;
  type: 'activity' | 'execution';
};

function sessionTimelineTimestamp(session: AgentSession): number {
  return session.completedAt ?? session.updatedAt ?? session.startedAt ?? session.createdAt;
}

function activityReferencesKnownSession(activity: Activity, sessionIds: ReadonlySet<string>): boolean {
  if (activity.target.type === 'agent-session' && sessionIds.has(activity.target.agentSessionId)) return true;
  return activity.relatedTargets?.some((target) => target.type === 'agent-session' && sessionIds.has(target.id)) ?? false;
}

function executionSessionIdFromActivity(activity: Activity, sessionsById: ReadonlyMap<string, AgentSession>): string | null {
  if (activity.content.type !== 'agent-action') return null;
  if (activity.content.action !== 'agent_session_start' && activity.content.action !== 'agent_session_stop') return null;
  if (activity.target.type === 'agent-session' && sessionsById.has(activity.target.agentSessionId)) {
    return activity.target.agentSessionId;
  }
  const result = activity.content.result;
  if (typeof result === 'string' && sessionsById.has(result)) return result;
  const related = activity.relatedTargets?.find((target) => target.type === 'agent-session' && sessionsById.has(target.id));
  return related?.type === 'agent-session' ? related.id : null;
}

function isSessionProcessActivity(activity: Activity, sessionIds: ReadonlySet<string>): boolean {
  if (!activityReferencesKnownSession(activity, sessionIds)) return false;
  switch (activity.content.type) {
    case 'agent-progress':
    case 'agent-question':
    case 'agent-response':
    case 'agent-error':
      return true;
    case 'verification-result':
      return activity.target.type === 'agent-session';
    case 'agent-action':
    case 'created':
    case 'updated':
    case 'archived':
    case 'deleted':
    case 'comment':
    case 'field-change':
    case 'status-change':
    case 'output-link':
      return false;
  }
}

export function issueActivityTimelineItems(
  activity: readonly Activity[],
  sessions: readonly AgentSession[],
): IssueActivityTimelineItem[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session] as const));
  const sessionIds = new Set(sessions.map((session) => session.id));
  const anchoredSessionIds = new Set<string>();
  const items: IssueActivityTimelineItem[] = [];

  for (const entry of activityEntriesForDisplay(activity)) {
    const executionSessionId = executionSessionIdFromActivity(entry, sessionsById);
    if (executionSessionId) {
      const session = sessionsById.get(executionSessionId);
      if (session && !anchoredSessionIds.has(session.id)) {
        anchoredSessionIds.add(session.id);
        items.push({
          type: 'execution',
          id: entry.id,
          timestamp: sessionTimelineTimestamp(session),
          activity: entry,
          session,
        });
      }
      continue;
    }

    if (isSessionProcessActivity(entry, sessionIds)) continue;

    items.push({
      type: 'activity',
      id: entry.id,
      timestamp: entry.createdAt,
      activity: entry,
    });
  }

  for (const session of sessions) {
    if (anchoredSessionIds.has(session.id)) continue;
    items.push({
      type: 'execution',
      id: session.id,
      timestamp: sessionTimelineTimestamp(session),
      activity: null,
      session,
    });
  }

  return items.sort((left, right) => {
    if (left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
    if (left.type !== right.type) return left.type === 'execution' ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}
