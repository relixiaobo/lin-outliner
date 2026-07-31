import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AutomationRun } from '../../src/core/agent/automation';
import { AutomationRunsView } from '../../src/renderer/agent/automations/AutomationRunsView';

describe('AutomationRunsView', () => {
  test('translates a Subagent budget failure without rendering token counts', () => {
    const timestamp = 1_720_000_000_000;
    const run: AutomationRun = {
      id: '01920000-0000-7000-8000-000000000201',
      automationId: '01920000-0000-7000-8000-000000000202',
      automationRevision: 1,
      eventSequence: 1,
      scheduledFor: timestamp,
      projectBindingKey: 'no-project',
      snapshot: {
        automationName: 'Bounded research',
        prompt: 'Research',
        schedule: { dtstart: '20260730T090000', rrule: 'FREQ=DAILY', timezone: 'Asia/Shanghai' },
        destination: { type: 'standalone' },
        projectBinding: null,
        configuration: { modelProvider: null, model: null, reasoningEffort: null },
      },
      state: 'failed',
      threadId: null,
      turnId: null,
      worktree: null,
      omission: null,
      error: JSON.stringify({
        error: {
          code: 'subagent_budget_exhausted',
          message: 'Subagent token budget exhausted (1500001 of 1500000 tokens); the child refuses new work. '
            + 'Interrupt, review its output, or spawn a fresh child.',
        },
      }),
      readAt: null,
      pinned: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const html = renderToStaticMarkup(
      <AutomationRunsView
        automationName="Bounded research"
        busy={false}
        hasUnread={false}
        runs={[run]}
        onMarkAllRead={async () => undefined}
        onOpenThread={async () => undefined}
        onPin={async () => undefined}
      />,
    );
    expect(html).toContain('Task reached the system resource limit. Results have been preserved.');
    expect(html).not.toContain('1500001');
    expect(html).not.toContain('1500000 tokens');
  });
});
