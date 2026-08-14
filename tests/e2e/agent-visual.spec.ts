import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { emulateVisualMedia } from './emulatedMedia';
import { openMockedApp } from './outlinerMock';

async function createNewThread(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })
    .click();
}

/**
 * Visual verification pass for the Agent surfaces, in both themes.
 *
 * Not a guard: it seeds one conversation that exercises the chips, the work
 * strip, and the pushed detail view, then writes screenshots for a human to
 * look at. Deleted before the PR is marked ready.
 */
for (const colorScheme of ['light', 'dark'] as const) {
  test(`agent surfaces in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openMockedApp(page);
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: {
          emitAgentCoreNotification: (n: unknown) => void;
          setMockSubagentExecution: (agentId: string, patch: Record<string, unknown>) => void;
          setMockThreadTurns: (threadId: string, turns: readonly unknown[]) => void;
        };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const startedAt = Date.now() - 96_000;
      const agents = [
        { id: '01910000-0000-7000-8000-0000000ba001', turnId: '01910000-0000-7000-8000-0000000ba002', description: 'survey the runtime', running: true, worktree: true },
        { id: '01910000-0000-7000-8000-0000000ba011', turnId: '01910000-0000-7000-8000-0000000ba012', description: 'draft the release note', running: false, worktree: false },
      ];
      for (const agent of agents) {
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'thread/started',
          threadId: agent.id,
          thread: {
            ...root,
            id: agent.id,
            parentThreadId,
            agentNickname: null,
            agentRole: 'worker',
            name: null,
            source: 'collaboration',
            threadSource: 'subagent',
            status: agent.running ? { type: 'active', activeFlags: [] } : { type: 'idle' },
            updatedAt: startedAt,
          },
        });
        target.__LIN_E2E__?.setMockSubagentExecution(agent.id, {
          description: agent.description,
          currentTurnId: agent.turnId,
          ...(agent.worktree
            ? { worktree: { branch: 'tenon/agent-survey', path: '/tmp/agent-survey' } }
            : {}),
          ...(agent.running ? {} : { terminalStatus: 'completed', notificationState: 'delivered', updatedAt: Date.now() }),
        });
        const childTurn = {
          id: agent.turnId,
          items: [{
            id: `${agent.id}-item`,
            type: 'agentMessage',
            provenance: { originThreadId: agent.id, originTurnId: agent.turnId, originItemId: `${agent.id}-item` },
            phase: 'final_answer',
            memoryCitation: null,
            text: 'Checked the runtime and recorded what changed.',
          }],
          itemsView: 'full',
          provenance: {
            originThreadId: agent.id,
            originTurnId: agent.turnId,
            trigger: { kind: 'subagent', parentThreadId, parentItemId: `${agent.id}-call` },
          },
          status: agent.running ? 'inProgress' : 'completed',
          error: null,
          startedAt,
          completedAt: agent.running ? null : startedAt + 96_000,
          durationMs: agent.running ? null : 96_000,
        };
        target.__LIN_E2E__?.setMockThreadTurns(agent.id, [childTurn]);
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: agent.running ? 'turn/started' : 'turn/completed',
          threadId: agent.id,
          turnId: agent.turnId,
          turn: childTurn,
        });
      }
      const turnId = '01910000-0000-7000-8000-0000000bb001';
      const provenance = (itemId: string) => ({
        originThreadId: parentThreadId, originTurnId: turnId, originItemId: itemId,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: 'user-1',
              type: 'userMessage',
              provenance: provenance('user-1'),
              content: [{ type: 'text', text: 'Survey the runtime and draft a release note.' }],
            },
            ...agents.flatMap((agent) => [{
              id: `${agent.id}-call`,
              type: 'collabAgentToolCall',
              provenance: provenance(`${agent.id}-call`),
              tool: 'agent',
              status: 'completed',
              outputRef: null,
              senderThreadId: parentThreadId,
              receiverThreadIds: [agent.id],
              prompt: agent.description,
              summary: null,
              model: null,
              reasoningEffort: null,
              agentsStates: {},
              modelCall: null,
            }, {
              id: `${agent.id}-activity`,
              type: 'subAgentActivity',
              provenance: provenance(`${agent.id}-activity`),
              kind: 'started',
              agentThreadId: agent.id,
              agentTurnId: agent.turnId,
              agentPath: `/root/${agent.description}`,
              error: null,
              spawnItemId: `${agent.id}-call`,
            }]),
            {
              id: 'answer-1',
              type: 'agentMessage',
              provenance: provenance('answer-1'),
              phase: 'final_answer',
              memoryCitation: null,
              text: 'Delegated both, and I will report back when they finish.',
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt,
          completedAt: startedAt + 4_000,
          durationMs: 4_000,
        },
      });
      // The continuation the first Agent's result started: an attribution
      // divider instead of the raw task-notification text.
      const continuationTurnId = '01910000-0000-7000-8000-0000000bb002';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId: continuationTurnId,
        turn: {
          id: continuationTurnId,
          items: [
            {
              id: 'host-1',
              type: 'userMessage',
              provenance: {
                originThreadId: parentThreadId,
                originTurnId: continuationTurnId,
                originItemId: 'host-1',
              },
              content: [{ type: 'text', text: '[SYSTEM NOTIFICATION - NOT USER INPUT] …' }],
            },
            {
              id: 'answer-2',
              type: 'agentMessage',
              provenance: {
                originThreadId: parentThreadId,
                originTurnId: continuationTurnId,
                originItemId: 'answer-2',
              },
              phase: 'final_answer',
              memoryCitation: null,
              text: 'The release note is drafted; the runtime survey is still running.',
            },
          ],
          itemsView: 'full',
          provenance: {
            originThreadId: parentThreadId,
            originTurnId: continuationTurnId,
            trigger: {
              kind: 'subagent',
              parentThreadId,
              parentItemId: '01910000-0000-7000-8000-0000000ba011-call',
            },
          },
          status: 'completed',
          error: null,
          startedAt: startedAt + 5_000,
          completedAt: startedAt + 6_000,
          durationMs: 1_000,
        },
      });
    });

    const deck = page.locator('.agent-dock');
    await expect(page.locator('.thread-agent-chip').first()).toBeVisible();
    await deck.screenshot({ path: `tmp/visual/agent-conversation-${colorScheme}.png` });

    await page.locator('.thread-work-strip-pill').click();
    await expect(page.locator('.thread-work-strip-row').first()).toBeVisible();
    await deck.screenshot({ path: `tmp/visual/agent-strip-${colorScheme}.png` });
    await page.locator('.thread-work-strip-pill').click();

    await page.locator('.thread-agent-chip').first().click();
    await expect(page.locator('.thread-agent-detail')).toBeVisible();
    await deck.screenshot({ path: `tmp/visual/agent-detail-${colorScheme}.png` });

    // The accessibility passes the material and the motion owe: the strip's
    // overlay must go opaque, and nothing may sweep.
    await page.locator('.thread-agent-detail-back').click();
    await emulateVisualMedia(page, { colorScheme, reducedTransparency: 'reduce' });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.locator('.thread-work-strip-pill').click();
    await expect(page.locator('.thread-work-strip-row').first()).toBeVisible();
    await deck.screenshot({ path: `tmp/visual/agent-reduced-${colorScheme}.png` });
  });
}
