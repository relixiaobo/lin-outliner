import { describe, expect, test } from 'bun:test';
import { en } from '../../src/core/i18n';
import type { IssueSearchRow } from '../../src/core/agentIssue';
import {
  issueDisplayTitleForRow,
  issueRowMatchesWorkPreset,
  issueRowSummaryForRow,
  issueSearchInputForWorkPreset,
  issueSearchInputsForWorkPreset,
} from '../../src/renderer/ui/agent/AgentIssuesPanel';

const TODAY = new Date(2026, 6, 8, 12, 0).getTime();
const TODAY_18 = new Date(2026, 6, 8, 18, 0).getTime();
const TOMORROW_09 = new Date(2026, 6, 9, 9, 0).getTime();

function row(patch: Partial<IssueSearchRow>): IssueSearchRow {
  return {
    target: { type: 'issue', id: 'issue-1' },
    title: 'Issue',
    status: 'Triage',
    revision: 'rev:1',
    updatedAt: TODAY,
    ...patch,
  };
}

describe('AgentIssuesPanel smart views', () => {
  test('uses smart-view names as candidate queries, not stored categories', () => {
    const inboxQueries = issueSearchInputsForWorkPreset('inbox', TODAY);
    expect(issueSearchInputForWorkPreset('today')).toMatchObject({
      filter: { archived: false },
      include: ['activity-summary', 'session-summary', 'sub-issues-summary'],
      limit: 100,
    });
    expect(inboxQueries.some((query) => (
      query.targets?.includes('issue') === true
      && query.filter?.triggerTypes?.includes('manual') === true
      && query.filter?.hasActiveSession === false
    ))).toBe(true);
    expect(issueSearchInputForWorkPreset('logbook')).toMatchObject({
      targets: ['issue'],
      filter: { statusCategories: ['completed', 'canceled', 'archived'] },
    });
  });

  test('derives Inbox from attention and unarranged facts', () => {
    expect(issueRowMatchesWorkPreset(row({ needsAttention: true }), 'inbox', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ needsAttention: false, trigger: { type: 'manual' } }), 'inbox', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ needsAttention: false, hasActiveSession: true }), 'inbox', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(row({ needsAttention: false, trigger: { type: 'scheduled', startAt: TOMORROW_09, timeZone: 'UTC' } }), 'inbox', TODAY)).toBe(false);
  });

  test('derives Today from active sessions, today schedule, repeating rules, and done today', () => {
    expect(issueRowMatchesWorkPreset(row({ hasActiveSession: true }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ trigger: { type: 'scheduled', startAt: TODAY_18, timeZone: 'UTC' } }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ subIssuesSummary: { total: 2, completed: 1, active: 1, needsAttention: 0, latestUpdatedAt: TODAY } }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({
      target: { type: 'recurring-issue', id: 'recurring-1' },
      status: 'active',
      nextMaterializationAt: TODAY_18,
    }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ statusCategory: 'completed', updatedAt: TODAY_18 }), 'today', TODAY)).toBe(true);
  });

  test('keeps Upcoming and Today as overlapping filters for recurring rules', () => {
    const recurringToday = row({
      target: { type: 'recurring-issue', id: 'recurring-1' },
      status: 'active',
      nextMaterializationAt: TODAY_18,
    });
    const recurringTomorrow = row({
      target: { type: 'recurring-issue', id: 'recurring-2' },
      status: 'active',
      nextMaterializationAt: TOMORROW_09,
    });
    expect(issueRowMatchesWorkPreset(recurringToday, 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(recurringToday, 'upcoming', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(recurringTomorrow, 'today', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(recurringTomorrow, 'upcoming', TODAY)).toBe(true);
  });

  test('keeps sub-issues inside their parent in Work views', () => {
    const child = row({
      target: { type: 'issue', id: 'issue-child-1' },
      title: 'Child issue',
      parentIssueId: 'issue-parent-1',
      statusCategory: 'completed',
      updatedAt: TODAY_18,
    });
    const parent = row({
      target: { type: 'issue', id: 'issue-parent-1' },
      title: 'Parent issue',
      subIssuesSummary: { total: 2, completed: 1, active: 0, needsAttention: 0, latestUpdatedAt: TODAY - 30 * 60 * 1000 },
    });
    expect(issueRowMatchesWorkPreset(child, 'today', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(parent, 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(parent, 'inbox', TODAY)).toBe(false);
    expect(issueRowSummaryForRow(parent, 'today', en, TODAY)).toBe('30 minutes ago');
  });

  test('surfaces parent Issues when scheduled sub-issues are upcoming', () => {
    const parent = row({
      target: { type: 'issue', id: 'issue-parent-1' },
      title: 'Parent issue',
      subIssuesSummary: {
        total: 3,
        completed: 0,
        active: 0,
        needsAttention: 0,
        nextScheduledAt: TOMORROW_09,
      },
    });
    expect(issueRowMatchesWorkPreset(parent, 'upcoming', TODAY)).toBe(true);
    expect(issueRowSummaryForRow(parent, 'upcoming', en, TODAY)).toContain('9:00');
    expect(issueRowSummaryForRow(parent, 'upcoming', en, TODAY)).not.toContain('Sub-issues');
  });

  test('displays Recurring Issue templates as readable rule names', () => {
    expect(issueDisplayTitleForRow(row({
      target: { type: 'recurring-issue', id: 'recurring-1' },
      title: 'AI 新闻日报 - {{date}}',
      status: 'active',
    }))).toBe('AI 新闻日报');
    expect(issueDisplayTitleForRow(row({
      target: { type: 'recurring-issue', id: 'recurring-2' },
      title: '{{ date }}: Daily review',
      status: 'active',
    }))).toBe('Daily review');
  });

  test('summarizes rows with the section context removed from the meta line', () => {
    const recurringTomorrow = row({
      target: { type: 'recurring-issue', id: 'recurring-1' },
      title: 'AI news digest - {{date}}',
      status: 'active',
      cadence: { type: 'daily', timeOfDay: '09:00', timeZone: 'UTC' },
      nextMaterializationAt: TOMORROW_09,
    });
    const recurringSummary = issueRowSummaryForRow(recurringTomorrow, 'upcoming', en, TODAY);
    expect(recurringSummary).toContain(en.agent.issue.cadenceDaily);
    expect(recurringSummary).not.toContain(en.agent.issue.section.tomorrow);
    expect(recurringSummary.startsWith(en.agent.issue.cadenceDaily)).toBe(false);

    const scheduledToday = row({
      trigger: { type: 'scheduled', startAt: TODAY_18, timeZone: 'UTC' },
    });
    const scheduledSummary = issueRowSummaryForRow(scheduledToday, 'today', en, TODAY);
    expect(scheduledSummary).toContain(en.agent.issue.summary.scheduled);
    expect(scheduledSummary).not.toContain(en.agent.issue.summary.today);
    expect(scheduledSummary.startsWith(en.agent.issue.summary.scheduled)).toBe(false);

    const completedToday = row({
      status: 'Completed',
      statusCategory: 'completed',
      updatedAt: TODAY - 3 * 60 * 60 * 1000,
    });
    expect(issueRowSummaryForRow(completedToday, 'today', en, TODAY)).not.toContain(en.agent.issue.summary.done);
  });

  test('derives Logbook from durable terminal fields', () => {
    expect(issueRowMatchesWorkPreset(row({ statusCategory: 'completed' }), 'logbook', TODAY)).toBe(true);
  });
});
