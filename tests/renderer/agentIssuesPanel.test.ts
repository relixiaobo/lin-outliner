import { describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { en, getMessages } from '../../src/core/i18n';
import type { IssueSearchRow } from '../../src/core/agentIssue';
import { AgentIssuesPanel } from '../../src/renderer/ui/agent/AgentIssuesPanel';
import {
  activityEntriesForDisplay,
  activityText,
  dateSectionLabel,
  dateTimeRelativeLabel,
  ISSUE_DETAIL_INCLUDE,
  issueActivityTimelineItems,
  issueDisplayTitleForRow,
  loadAllIssueSearchRows,
  issueRowMatchesWorkPreset,
  issueRowSummaryForRow,
  issueSearchInputForWorkPreset,
  issueSearchInputsForWorkPreset,
  sessionProcessActivityEntriesForDisplay,
  shouldRefreshIssueWorkForAgentEvent,
} from '../../src/renderer/ui/agent/agentIssueViewModel';
import type { Activity, AgentSession } from '../../src/core/agentIssue';

const TODAY = new Date(2026, 6, 8, 12, 0).getTime();
const TODAY_18 = new Date(2026, 6, 8, 18, 0).getTime();
const TOMORROW_09 = new Date(2026, 6, 9, 9, 0).getTime();
const agentIssuesPanelSource = await Bun.file('src/renderer/ui/agent/AgentIssuesPanel.tsx').text();
const agentChatPanelSource = await Bun.file('src/renderer/ui/agent/AgentChatPanel.tsx').text();
const runDetailCss = await Bun.file('src/renderer/styles/agent-run-detail.css').text();

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
      include: ['activity-summary', 'session-summary'],
      limit: 100,
    });
    expect(inboxQueries).toHaveLength(1);
    expect(inboxQueries[0]).toMatchObject({ filter: { archived: false, needsAttention: true } });
    expect(issueSearchInputsForWorkPreset('today', TODAY).some((query) => (
      query.targets?.includes('issue') === true
      && query.filter?.triggerTypes?.includes('when-ready') === true
      && query.filter?.hasActiveSession === false
    ))).toBe(true);
    expect(issueSearchInputsForWorkPreset('today', TODAY)).toContainEqual(expect.objectContaining({
      filter: expect.objectContaining({ terminalAt: expect.any(Object) }),
    }));
    expect(issueSearchInputForWorkPreset('logbook')).toMatchObject({
      targets: ['issue'],
      filter: { statusCategories: ['completed', 'canceled', 'archived'], hasParentIssue: false },
    });
  });

  test('loads every search page instead of truncating Work at 100 rows', async () => {
    const calls: Array<string | undefined> = [];
    const rows = await loadAllIssueSearchRows({ targets: ['issue'] }, async (input) => {
      calls.push(input.cursor);
      expect(input.limit).toBe(100);
      const offset = input.cursor ? Number(input.cursor) : 0;
      const count = offset < 200 ? 100 : 5;
      return {
        rows: Array.from({ length: count }, (_, index) => row({
          target: { type: 'issue', id: `issue-${offset + index}` },
        })),
        ...(offset + count < 205 ? { nextCursor: String(offset + count) } : {}),
      };
    });

    expect(rows).toHaveLength(205);
    expect(calls).toEqual([undefined, '100', '200']);
  });

  test('does not reload Issue data for pure streaming text patches', () => {
    expect(shouldRefreshIssueWorkForAgentEvent({
      type: 'projection_patch',
      conversationId: 'conversation:streaming',
      lastEventType: 'message_update',
      revision: 1,
      patch: {},
      timestamp: TODAY,
    })).toBe(false);
    expect(shouldRefreshIssueWorkForAgentEvent({
      type: 'tool_result',
      conversationId: 'conversation:streaming',
      toolCallId: 'tool:issue-update',
      timestamp: TODAY,
    })).toBe(true);
  });

  test('formats Work calendar labels with the application locale', () => {
    const timestamp = new Date(2026, 9, 12, 9, 30).getTime();
    const zhHans = getMessages('zh-Hans');
    expect(dateSectionLabel(timestamp, TODAY, zhHans.agent.issue, 'zh-Hans')).toBe(
      new Intl.DateTimeFormat('zh-Hans', { month: 'short', day: 'numeric', weekday: 'long' })
        .format(new Date(timestamp)),
    );
    expect(dateTimeRelativeLabel(timestamp, TODAY, zhHans.agent.issue, 'zh-Hans')).toBe(
      new Intl.DateTimeFormat('zh-Hans', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        .format(new Date(timestamp)),
    );
  });

  test('queries and projects only root Issues in first-level Work views', () => {
    for (const preset of ['inbox', 'today', 'upcoming', 'logbook'] as const) {
      const issueQueries = issueSearchInputsForWorkPreset(preset, TODAY)
        .filter((query) => query.targets?.includes('recurring-issue') !== true);
      expect(issueQueries.length).toBeGreaterThan(0);
      expect(issueQueries.every((query) => query.filter?.hasParentIssue === false)).toBe(true);
    }

    const child = row({
      parentIssueId: 'issue:parent',
      needsAttention: true,
      hasActiveSession: true,
      statusCategory: 'completed',
      updatedAt: TODAY_18,
    });
    expect(issueRowMatchesWorkPreset(child, 'inbox', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(child, 'today', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(row({
      parentIssueId: 'issue:parent',
      trigger: { type: 'scheduled', startAt: TOMORROW_09, timeZone: 'UTC' },
    }), 'upcoming', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(child, 'logbook', TODAY)).toBe(false);
  });

  test('loads direct child Issues for hierarchical detail navigation', () => {
    expect(ISSUE_DETAIL_INCLUDE).toContain('child-issues');
  });

  test('derives Inbox from attention facts', () => {
    expect(issueRowMatchesWorkPreset(row({ needsAttention: true }), 'inbox', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ needsAttention: false, trigger: { type: 'when-ready' } }), 'inbox', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(row({ needsAttention: false, hasActiveSession: true }), 'inbox', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(row({ needsAttention: false, trigger: { type: 'scheduled', startAt: TOMORROW_09, timeZone: 'UTC' } }), 'inbox', TODAY)).toBe(false);
  });

  test('derives Today from active sessions, today schedule, repeating rules, and done today', () => {
    expect(issueRowMatchesWorkPreset(row({ hasActiveSession: true }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ trigger: { type: 'when-ready' } }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ trigger: { type: 'scheduled', startAt: TODAY_18, timeZone: 'UTC' } }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({
      target: { type: 'recurring-issue', id: 'recurring-1' },
      status: 'active',
      nextMaterializationAt: TODAY_18,
    }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({ statusCategory: 'completed', terminalAt: TODAY_18 }), 'today', TODAY)).toBe(true);
    expect(issueRowMatchesWorkPreset(row({
      statusCategory: 'completed',
      terminalAt: TODAY - 86_400_000,
      updatedAt: TODAY_18,
      trigger: { type: 'scheduled', startAt: TODAY_18, timeZone: 'UTC' },
    }), 'today', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(row({
      statusCategory: 'canceled',
      terminalAt: TODAY - 86_400_000,
      updatedAt: TODAY_18,
      dueDate: { targetAt: TODAY_18, timeZone: 'UTC' },
    }), 'today', TODAY)).toBe(false);
    expect(issueRowMatchesWorkPreset(row({
      target: { type: 'recurring-issue', id: 'recurring-paused' },
      status: 'paused',
      nextMaterializationAt: TODAY_18,
    }), 'today', TODAY)).toBe(false);
  });

  test('keeps an open Issue detail subscribed after its Session becomes temporarily terminal', () => {
    expect(agentIssuesPanelSource).toContain('window.lin?.onAgentEvent((event) => {');
    expect(agentIssuesPanelSource).toContain('shouldRefreshIssueWorkForAgentEvent(event)');
    expect(agentIssuesPanelSource).toContain('scheduleLoad();');
  });

  test('offers an explicit trusted-user completion action only for review-ready human-review Issues', () => {
    expect(agentIssuesPanelSource).toContain("issue.verificationPolicy?.mode === 'human-review'");
    expect(agentIssuesPanelSource).toContain('&& !hasActiveSessions');
    expect(agentIssuesPanelSource).toContain("session.purpose !== 'verify' && session.state === 'complete'");
    expect(agentIssuesPanelSource).toContain('api.agentIssueCompleteHumanReview(issue.id, issue.revision)');
    expect(agentIssuesPanelSource).toContain('t.agent.issueDetail.acceptReview');
  });

  test('maintains the active Session badge outside the Work page lifecycle', () => {
    expect(agentChatPanelSource).toContain('void loadActiveIssueSessionCount();');
    expect(agentChatPanelSource).toContain('return window.lin?.onAgentEvent((event) => {');
    expect(agentChatPanelSource).toContain('shouldRefreshIssueWorkForAgentEvent(event)');
    expect(agentChatPanelSource).toContain('scheduleActiveIssueSessionCountRefresh();');
    expect(agentChatPanelSource).toContain('activeIssueSessionCountRefreshTimerRef');
    expect(agentChatPanelSource).not.toContain('if (!workPanelOpen) return undefined;');
  });

  test('invalidates delayed Work refreshes when the preset changes', () => {
    const handlerStart = agentChatPanelSource.indexOf('const setIssueWorkPreset');
    const handlerEnd = agentChatPanelSource.indexOf('\n\n  useEffect', handlerStart);
    const handlerSource = agentChatPanelSource.slice(handlerStart, handlerEnd);
    expect(handlerSource).toContain('window.clearTimeout(issueIndexRefreshTimerRef.current);');
    expect(handlerSource).not.toContain('activeIssueSessionCountRefreshTimerRef');
    expect(handlerSource).toContain('if (issueIndexPresetRef.current === preset)');
    expect(handlerSource).toContain('issueIndexPresetRef.current = preset;');
    expect(handlerSource).toContain('issueIndexRequestRef.current += 1;');
  });

  test('uses calendar-day boundaries across daylight-saving transitions', () => {
    const probe = Bun.spawnSync({
      cmd: [process.execPath, '-e', `
        import {
          dateSectionLabel,
          dateTimeRelativeLabel,
          endOfLocalDay,
          issueRowMatchesWorkPreset,
          issueSearchInputsForWorkPreset,
          millisecondsUntilNextLocalMidnight,
        } from './src/renderer/ui/agent/agentIssueViewModel.ts';

        const labels = {
          view: { today: 'Today' },
          section: { tomorrow: 'Tomorrow' },
          summary: { today: 'Today' },
        };
        const row = (patch) => ({
          target: { type: 'issue', id: 'issue-dst' },
          title: 'DST Issue',
          status: 'Triage',
          revision: 'rev:dst',
          updatedAt: 0,
          ...patch,
        });
        const spring = new Date(2025, 2, 9, 12, 0).getTime();
        const springStart = new Date(2025, 2, 9, 0, 0).getTime();
        const springNext = new Date(2025, 2, 10, 0, 0).getTime();
        const fall = new Date(2025, 10, 2, 12, 0).getTime();
        const fallStart = new Date(2025, 10, 2, 0, 0).getTime();
        const fallNext = new Date(2025, 10, 3, 0, 0).getTime();
        const inspectDay = (now, start, next) => {
          const beforeMidnight = next - 1;
          const todayQueries = issueSearchInputsForWorkPreset('today', now);
          const upcomingQueries = issueSearchInputsForWorkPreset('upcoming', now);
          return {
            hours: (next - start) / 3_600_000,
            end: endOfLocalDay(now),
            next,
            refreshDelay: millisecondsUntilNextLocalMidnight(start),
            beforeMidnightIsToday: issueRowMatchesWorkPreset(row({
              trigger: { type: 'scheduled', startAt: beforeMidnight, timeZone: 'America/Los_Angeles' },
            }), 'today', now),
            midnightIsToday: issueRowMatchesWorkPreset(row({
              trigger: { type: 'scheduled', startAt: next, timeZone: 'America/Los_Angeles' },
            }), 'today', now),
            beforeMidnightIsUpcoming: issueRowMatchesWorkPreset(row({
              trigger: { type: 'scheduled', startAt: beforeMidnight, timeZone: 'America/Los_Angeles' },
            }), 'upcoming', now),
            midnightIsUpcoming: issueRowMatchesWorkPreset(row({
              trigger: { type: 'scheduled', startAt: next, timeZone: 'America/Los_Angeles' },
            }), 'upcoming', now),
            todayLabel: dateSectionLabel(beforeMidnight, now, labels, 'en'),
            tomorrowLabel: dateSectionLabel(next, now, labels, 'en'),
            todayRelative: dateTimeRelativeLabel(beforeMidnight, now, labels, 'en'),
            tomorrowRelative: dateTimeRelativeLabel(next, now, labels, 'en'),
            todayDueTo: todayQueries.find((query) => query.filter?.dueDate)?.filter?.dueDate?.to,
            upcomingDueFrom: upcomingQueries.find((query) => query.filter?.dueDate)?.filter?.dueDate?.from,
          };
        };
        console.log(JSON.stringify({
          spring: inspectDay(spring, springStart, springNext),
          fall: inspectDay(fall, fallStart, fallNext),
        }));
      `],
      cwd: process.cwd(),
      env: { ...process.env, TZ: 'America/Los_Angeles' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(probe.exitCode).toBe(0);
    const result = JSON.parse(probe.stdout.toString()) as Record<'spring' | 'fall', Record<string, unknown>>;
    for (const [name, expectedHours] of [['spring', 23], ['fall', 25]] as const) {
      const day = result[name];
      expect(day).toMatchObject({
        hours: expectedHours,
        end: (day.next as number) - 1,
        refreshDelay: expectedHours * 3_600_000,
        beforeMidnightIsToday: true,
        midnightIsToday: false,
        beforeMidnightIsUpcoming: false,
        midnightIsUpcoming: true,
        todayLabel: 'Today',
        tomorrowLabel: 'Tomorrow',
        todayDueTo: (day.next as number) - 1,
        upcomingDueFrom: day.next,
      });
      expect(day.todayRelative).toMatch(/^Today,/);
      expect(day.tomorrowRelative).toMatch(/^Tomorrow,/);
    }
  });

  test('refreshes at each local midnight and clears the pending timer on unmount', () => {
    const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    const globalKeys = [
      'document',
      'window',
      'Event',
      'HTMLElement',
      'Node',
      'setTimeout',
      'clearTimeout',
      'IS_REACT_ACT_ENVIRONMENT',
    ] as const;
    const savedGlobals = globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    const cleared: number[] = [];
    let nextTimerId = 1;
    const timerWindow = window as unknown as {
      clearTimeout: (timerId: number) => void;
      setTimeout: (callback: () => void, delay: number) => number;
    };
    timerWindow.setTimeout = (callback, delay) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      scheduled.set(timerId, {
        callback: () => {
          scheduled.delete(timerId);
          callback();
        },
        delay,
      });
      return timerId;
    };
    timerWindow.clearTimeout = (timerId) => {
      cleared.push(timerId);
      scheduled.delete(timerId);
    };
    Object.assign(globalThis, {
      document,
      window,
      Event: window.Event,
      HTMLElement: window.HTMLElement,
      Node: window.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    const container = document.getElementById('root');
    if (!container) throw new Error('Missing root container');
    const root = createRoot(container);
    let unmounted = false;
    let firstRefreshCount = 0;
    let latestRefreshCount = 0;
    const render = (onRefresh: () => void) => createElement(AgentIssuesPanel, {
      activeSessionCount: 0,
      error: null,
      loading: false,
      onOpenIssue: () => undefined,
      onPresetChange: () => undefined,
      onRefresh,
      preset: 'today',
      rows: [],
    });

    try {
      act(() => root.render(render(() => { firstRefreshCount += 1; })));
      const firstTimer = scheduled.get(1);
      expect(firstTimer).toBeDefined();
      expect(firstTimer!.delay).toBeGreaterThan(0);
      expect(firstTimer!.delay).toBeLessThanOrEqual(48 * 3_600_000);

      act(() => root.render(render(() => { latestRefreshCount += 1; })));
      expect(scheduled.size).toBe(1);
      act(() => firstTimer!.callback());
      expect(firstRefreshCount).toBe(0);
      expect(latestRefreshCount).toBe(1);
      expect(scheduled.has(2)).toBe(true);

      act(() => root.unmount());
      unmounted = true;
      expect(cleared).toContain(2);
      expect(scheduled.size).toBe(0);
    } finally {
      if (!unmounted) act(() => root.unmount());
      for (const [key, descriptor] of savedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });

  test('polls time-derived Issue buckets so expired deadlines enter Inbox without another event', () => {
    expect(agentIssuesPanelSource).toContain('const ISSUE_TIME_REFRESH_INTERVAL_MS = 60_000;');
    expect(agentIssuesPanelSource).toContain('window.setInterval(() => onRefreshRef.current(), ISSUE_TIME_REFRESH_INTERVAL_MS)');
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
    const recurringSummary = issueRowSummaryForRow(recurringTomorrow, 'upcoming', en, 'en', TODAY);
    expect(recurringSummary).toContain(en.agent.issue.cadenceDaily);
    expect(recurringSummary).not.toContain(en.agent.issue.section.tomorrow);
    expect(recurringSummary.startsWith(en.agent.issue.cadenceDaily)).toBe(false);

    const scheduledToday = row({
      trigger: { type: 'scheduled', startAt: TODAY_18, timeZone: 'UTC' },
    });
    const scheduledSummary = issueRowSummaryForRow(scheduledToday, 'today', en, 'en', TODAY);
    expect(scheduledSummary).toContain(en.agent.issue.summary.scheduled);
    expect(scheduledSummary).not.toContain(en.agent.issue.summary.today);
    expect(scheduledSummary.startsWith(en.agent.issue.summary.scheduled)).toBe(false);

    const completedToday = row({
      status: 'Completed',
      statusCategory: 'completed',
      terminalAt: TODAY - 3 * 60 * 60 * 1000,
      updatedAt: TODAY,
    });
    expect(issueRowSummaryForRow(completedToday, 'today', en, 'en', TODAY)).not.toContain(en.agent.issue.summary.done);
  });

  test('derives Logbook from durable terminal fields', () => {
    expect(issueRowMatchesWorkPreset(row({ statusCategory: 'completed' }), 'logbook', TODAY)).toBe(true);
  });

  test('keeps Process folded by default and preserves complete Activity text', () => {
    expect(agentIssuesPanelSource).not.toMatch(/agent-issue-session-process" open=\{active\}/);
    expect(runDetailCss).toMatch(
      /\.agent-issue-activity-heading > span\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*pre-wrap;/s,
    );
    expect(runDetailCss.match(/\.agent-issue-activity-heading > span\s*\{([^}]*)\}/s)?.[1]).not.toContain('text-overflow');
  });

  test('keeps Agent Session process entries user-visible instead of audit-oriented', () => {
    const session = {
      id: 'agent-session:1',
      issueId: 'issue-1',
      delegate: { type: 'default-agent' },
      state: 'complete',
      source: { type: 'runtime-action', actor: { type: 'system' } },
      issueSnapshot: {
        id: 'issue-1',
        title: 'Weather',
        description: '',
        status: { name: 'Completed', category: 'completed' },
        relations: [],
        trigger: { type: 'when-ready' },
        input: { type: 'none' },
        output: { type: 'activity-only' },
        delegate: { type: 'default-agent' },
        completionCriteria: [],
        permissionMode: 'unattended',
        confirmation: { confirmedBy: { type: 'system' }, confirmedAt: TODAY },
        revision: 'rev:issue',
        createdAt: TODAY,
        updatedAt: TODAY,
      },
      revision: 'rev:session',
      createdAt: TODAY,
      updatedAt: TODAY,
    } satisfies AgentSession;
    const entries: Activity[] = [
      {
        id: 'activity:start-action',
        target: { type: 'issue', issueId: 'issue-1' },
        actor: { type: 'system' },
        content: { type: 'agent-action', action: 'agent_session_start', result: session.id },
        relatedTargets: [{ type: 'agent-session', id: session.id }],
        createdAt: TODAY,
      },
      {
        id: 'activity:bootstrap-progress',
        target: { type: 'agent-session', agentSessionId: session.id },
        actor: { type: 'system' },
        content: { type: 'agent-progress', body: 'Agent Session created and waiting for runtime execution.' },
        createdAt: TODAY + 1,
      },
      {
        id: 'activity:real-progress',
        target: { type: 'agent-session', agentSessionId: session.id },
        actor: { type: 'system' },
        content: { type: 'agent-progress', body: 'Checked district coverage.' },
        createdAt: TODAY + 2,
      },
      {
        id: 'activity:response',
        target: { type: 'agent-session', agentSessionId: session.id },
        actor: { type: 'system' },
        content: { type: 'agent-response', body: 'Final result.' },
        createdAt: TODAY + 3,
      },
    ];

    expect(sessionProcessActivityEntriesForDisplay(entries, session).map((entry) => entry.id)).toEqual([
      'activity:real-progress',
    ]);
  });

  test('renders Agent Sessions as Activity timeline items without duplicate lifecycle rows', () => {
    const session = {
      id: 'agent-session:1',
      issueId: 'issue-1',
      delegate: { type: 'default-agent' },
      state: 'canceled',
      source: { type: 'runtime-action', actor: { type: 'system' } },
      issueSnapshot: {
        id: 'issue-1',
        title: 'Weather',
        description: '',
        status: { name: 'Canceled', category: 'canceled' },
        relations: [],
        trigger: { type: 'when-ready' },
        input: { type: 'none' },
        output: { type: 'activity-only' },
        delegate: { type: 'default-agent' },
        completionCriteria: [],
        permissionMode: 'unattended',
        confirmation: { confirmedBy: { type: 'system' }, confirmedAt: TODAY },
        revision: 'rev:issue',
        createdAt: TODAY,
        updatedAt: TODAY + 4,
      },
      latestOutput: 'Final weather summary.',
      startedAt: TODAY + 1,
      completedAt: TODAY + 3,
      revision: 'rev:session',
      createdAt: TODAY + 1,
      updatedAt: TODAY + 3,
    } satisfies AgentSession;
    const entries: Activity[] = [
      {
        id: 'activity:created',
        target: { type: 'issue', issueId: 'issue-1' },
        actor: { type: 'system' },
        content: { type: 'created' },
        createdAt: TODAY,
      },
      {
        id: 'activity:start-action',
        target: { type: 'issue', issueId: 'issue-1' },
        actor: { type: 'system' },
        content: { type: 'agent-action', action: 'agent_session_start', result: session.id },
        relatedTargets: [{ type: 'agent-session', id: session.id }],
        createdAt: TODAY + 1,
      },
      {
        id: 'activity:progress',
        target: { type: 'agent-session', agentSessionId: session.id },
        actor: { type: 'agent', agentId: 'neva' },
        content: { type: 'agent-progress', body: 'Checked district coverage.' },
        createdAt: TODAY + 2,
      },
      {
        id: 'activity:stop-action',
        target: { type: 'agent-session', agentSessionId: session.id },
        actor: { type: 'system' },
        content: { type: 'agent-action', action: 'agent_session_stop', result: 'canceled' },
        relatedTargets: [{ type: 'issue', id: 'issue-1' }],
        createdAt: TODAY + 3,
      },
      {
        id: 'activity:status',
        target: { type: 'issue', issueId: 'issue-1' },
        actor: { type: 'system' },
        content: { type: 'status-change', from: 'Active', to: 'Canceled' },
        createdAt: TODAY + 4,
      },
    ];

    expect(issueActivityTimelineItems(entries, [session]).map((item) => (
      item.type === 'execution'
        ? `execution:${item.session?.id}:${item.activity?.id ?? 'unanchored'}`
        : `activity:${item.activity?.id}`
    ))).toEqual([
      'activity:activity:status',
      'execution:agent-session:1:activity:stop-action',
      'activity:activity:created',
    ]);
  });

  test('keeps Issue-targeted verifier results in the main Activity timeline', () => {
    const session = {
      id: 'agent-session:verifier',
      issueId: 'issue-1',
      delegate: { type: 'default-agent' },
      state: 'complete',
      source: { type: 'runtime-action', actor: { type: 'system' } },
      issueSnapshot: {
        id: 'issue-1',
        title: 'Weather',
        description: '',
        status: { name: 'Completed', category: 'completed' },
        relations: [],
        trigger: { type: 'when-ready' },
        input: { type: 'none' },
        output: { type: 'activity-only' },
        delegate: { type: 'default-agent' },
        completionCriteria: [],
        permissionMode: 'unattended',
        confirmation: { confirmedBy: { type: 'system' }, confirmedAt: TODAY },
        revision: 'rev:issue',
        createdAt: TODAY,
        updatedAt: TODAY,
      },
      revision: 'rev:session',
      createdAt: TODAY,
      updatedAt: TODAY + 1,
    } satisfies AgentSession;
    const verdict = {
      id: 'activity:verification',
      target: { type: 'issue', issueId: 'issue-1' },
      actor: { type: 'agent', agentId: 'verifier' },
      content: {
        type: 'verification-result',
        verdict: 'pass',
        body: 'All acceptance criteria passed.',
        agentSessionId: session.id,
      },
      relatedTargets: [{ type: 'agent-session', id: session.id }],
      createdAt: TODAY + 2,
    } satisfies Activity;
    const relatedProgress = {
      id: 'activity:related-progress',
      target: { type: 'issue', issueId: 'issue-1' },
      actor: { type: 'agent', agentId: 'verifier' },
      content: { type: 'agent-progress', body: 'Checking acceptance criteria.' },
      relatedTargets: [{ type: 'agent-session', id: session.id }],
      createdAt: TODAY + 1,
    } satisfies Activity;

    expect(issueActivityTimelineItems([verdict, relatedProgress], [session]).map((item) => (
      item.type === 'activity' ? item.activity?.id : `execution:${item.session?.id}`
    ))).toEqual([
      verdict.id,
      `execution:${session.id}`,
    ]);
  });

  test('keeps Issue Activity user-visible instead of audit-oriented', () => {
    const entries: Activity[] = [
      {
        id: 'activity:created',
        target: { type: 'issue', issueId: 'issue-1' },
        actor: { type: 'system' },
        content: { type: 'created' },
        createdAt: TODAY,
      },
      {
        id: 'activity:updated',
        target: { type: 'issue', issueId: 'issue-1' },
        actor: { type: 'system' },
        content: { type: 'updated', fields: ['description'] },
        createdAt: TODAY + 1,
      },
      {
        id: 'activity:start-action',
        target: { type: 'issue', issueId: 'issue-1' },
        actor: { type: 'system' },
        content: { type: 'agent-action', action: 'agent_session_start', result: 'agent-session:1' },
        relatedTargets: [{ type: 'agent-session', id: 'agent-session:1' }],
        createdAt: TODAY + 2,
      },
      {
        id: 'activity:generic-progress',
        target: { type: 'agent-session', agentSessionId: 'agent-session:1' },
        actor: { type: 'system' },
        content: { type: 'agent-progress', body: 'Agent Session is active.' },
        relatedTargets: [{ type: 'issue', id: 'issue-1' }],
        createdAt: TODAY + 3,
      },
      {
        id: 'activity:status',
        target: { type: 'issue', issueId: 'issue-1' },
        actor: { type: 'system' },
        content: { type: 'status-change', from: 'Active', to: 'Completed' },
        createdAt: TODAY + 4,
      },
      {
        id: 'activity:response',
        target: { type: 'agent-session', agentSessionId: 'agent-session:1' },
        actor: { type: 'system' },
        content: { type: 'agent-response', body: 'Final result.' },
        relatedTargets: [{ type: 'issue', id: 'issue-1' }],
        createdAt: TODAY + 5,
      },
    ];

    expect(activityEntriesForDisplay(entries).map((entry) => entry.id)).toEqual([
      'activity:status',
      'activity:start-action',
      'activity:updated',
      'activity:created',
    ]);
  });

  test('localizes child Issue lifecycle Activity instead of exposing raw action names', () => {
    const zhHans = getMessages('zh-Hans');
    const created = {
      id: 'activity:child-created',
      target: { type: 'issue', issueId: 'issue-1' },
      actor: { type: 'system' },
      content: { type: 'agent-action', action: 'child_issue_created', result: 'issue-child' },
      createdAt: TODAY,
    } satisfies Activity;
    const completed = {
      ...created,
      id: 'activity:child-completed',
      content: { type: 'agent-action', action: 'child_issue_completed', result: 'issue-child' },
    } satisfies Activity;

    expect(activityText(created, en.agent.issueDetail.activityEvent)).toBe('Child Issue created.');
    expect(activityText(completed, en.agent.issueDetail.activityEvent)).toBe('Child Issue completed.');
    expect(activityText(created, zhHans.agent.issueDetail.activityEvent)).toBe('子 Issue 已创建。');
    expect(activityText(completed, zhHans.agent.issueDetail.activityEvent)).toBe('子 Issue 已完成。');
  });
});
