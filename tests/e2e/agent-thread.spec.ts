import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { emulateVisualMedia, resolveTokenColor } from './emulatedMedia';
import { clipboardText, commandCalls, ids, openMockedApp, rowBody } from './outlinerMock';
import { en } from '../../src/core/i18n/messages/en';
import { zhHans } from '../../src/core/i18n/messages/zh-Hans';

const FORMER_SHARED_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;

const ACTION_MENU_LABEL_KEYS = [
  'details', 'rename', 'delete', 'hideFromRecall', 'showInRecall', 'recordsUnavailable',
] as const;

/**
 * Every string the action menu can render, in every locale that overrides one.
 *
 * `en` is indexed strictly rather than through an all-optional type, which would
 * accept the complete object and silently drop a renamed key. That is only half
 * the protection it looks like: `tsconfig.json` includes `src` alone, so
 * `bun run typecheck` never reads this file and a stale key here is not a
 * compile error today. The test therefore checks the key set at runtime too —
 * see the assertions in the guard. `zhHans` genuinely may omit an override, so
 * an optional read is right for it, and a key it invents that `Messages` lacks
 * does fail to compile, in `zh-Hans.ts` itself.
 */
const ACTION_MENU_LABELS = [
  ...ACTION_MENU_LABEL_KEYS.map((key) => en.agent.thread[key]),
  ...ACTION_MENU_LABEL_KEYS
    .map((key) => zhHans.agent?.thread?.[key])
    .filter((label): label is string => typeof label === 'string'),
];

async function createNewThread(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })
    .click();
}

async function setTranscriptFollowingBottom(page: Page): Promise<void> {
  const transcript = page.locator('.thread-transcript');
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.scrollTop - element.clientHeight
  ))).toBeLessThanOrEqual(1);
}

async function toggleDisclosureWithStableAnchor(toggle: Locator, anchor: Locator = toggle): Promise<void> {
  await expect(toggle).toBeVisible();
  await expect(anchor).toBeVisible();
  const top = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  await toggle.click();
  const frameDeltas = await anchor.evaluate(async (element, expectedTop) => {
    const deltas: number[] = [];
    for (let frame = 0; frame < 16; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      deltas.push(Math.abs(element.getBoundingClientRect().top - expectedTop));
    }
    return deltas;
  }, top);
  expect(Math.max(...frameDeltas)).toBeLessThan(1);
}

async function seedOverflowingTranscript(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    const turnId = '01910000-0000-7000-8000-00000000fa01';
    const itemId = '01910000-0000-7000-8000-00000000fa02';
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'turn/completed',
      threadId,
      turnId,
      turn: {
        id: turnId,
        items: [{
          id: itemId,
          type: 'agentMessage',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
          text: Array.from(
            { length: 32 },
            (_, index) => `Earlier transcript evidence ${index + 1}.`,
          ).join('\n\n'),
          phase: 'final_answer',
          memoryCitation: null,
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    });
  });
  await expect(page.getByText('Earlier transcript evidence 32.')).toBeVisible();
}

/**
 * A conversation tall enough to scroll but under the virtualization threshold —
 * the flow-layout transcript nearly every real conversation is, where a saved
 * pixel offset does not survive a remount on its own.
 */
async function seedTallFlowTranscript(page: Page, turnCount: number): Promise<void> {
  await page.evaluate(async (count) => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    for (let index = 0; index < count; index += 1) {
      const text = Array.from(
        { length: 30 },
        (_, line) => `Tall message ${index + 1} line ${line + 1} with enough words to wrap across the transcript.`,
      ).join('\n\n');
      await target.lin?.agentCoreRequest('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        clientUserMessageId: `tall-${index + 1}`,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, turnCount);
  await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'false');
}

interface ReadingAnchor {
  readonly offset: number;
  readonly turnId: string;
}

/** Where the reader is: the Turn at the top of the viewport, and its offset. */
async function captureReadingAnchor(page: Page, fraction: number): Promise<ReadingAnchor> {
  const transcript = page.locator('.thread-transcript');
  await expect.poll(() => transcript.evaluate((element) => (
    element.scrollHeight - element.clientHeight
  ))).toBeGreaterThan(400);
  return transcript.evaluate(async (element, ratio) => {
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.floor(maximum * ratio);
    element.dispatchEvent(new Event('scroll'));
    for (let frame = 0; frame < 8; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    const viewportTop = element.getBoundingClientRect().top;
    const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-thread-turn-row]'));
    // The same predicate production anchors on: the last row starting at or
    // above the viewport top. Requiring a row to straddle it would find nothing
    // whenever the offset lands in the 12px gap between two rows.
    const row = rows.filter((candidate) => (
      candidate.getBoundingClientRect().top <= viewportTop
    )).at(-1) ?? rows[0];
    const turnId = row?.dataset.threadTurnRow;
    if (!row || !turnId) throw new Error('Missing reading anchor');
    return { offset: row.getBoundingClientRect().top - viewportTop, turnId };
  }, fraction);
}

/**
 * The anchored Turn is back where it was — and stays there. Settling for one
 * frame is not enough: a transcript that agrees on arrival and is then pushed
 * by rows rendering above it has still lost the reader's place.
 */
async function expectReadingAnchorRestored(page: Page, anchor: ReadingAnchor): Promise<void> {
  const row = page.locator(`[data-thread-turn-row="${anchor.turnId}"]`);
  await expect(row).toHaveCount(1);
  const drift = (element: HTMLElement, expected: number) => {
    const scroller = element.closest('.thread-transcript');
    if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
    return Math.abs(
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expected,
    );
  };
  await expect.poll(() => row.evaluate(drift, anchor.offset)).toBeLessThanOrEqual(2);
  const frameDrifts = await row.evaluate(async (element, expected) => {
    const scroller = element.closest('.thread-transcript');
    if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
    const drifts: number[] = [];
    for (let frame = 0; frame < 16; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      drifts.push(Math.abs(
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expected,
      ));
    }
    return drifts;
  }, anchor.offset);
  expect(Math.max(...frameDrifts)).toBeLessThanOrEqual(2);
}

async function renameSelectedThread(page: Page, name: string): Promise<void> {
  await openSelectedThreadActions(page);
  await page.getByRole('menu', { name: 'Thread actions' })
    .getByRole('menuitem', { name: 'Rename Thread' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Rename Thread' });
  await dialog.getByRole('textbox', { name: 'Rename Thread' }).fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.thread-dock-title')).toContainText(name);
}

/**
 * One settled Turn holding three consecutive command Items — completed, failed
 * with no exit code, and interrupted — so the counted activity group and each
 * member row can be inspected for their own status treatment.
 */
async function seedMixedStatusToolTurn(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    const turnId = '01910000-0000-7000-8000-00000000b001';
    const commandItem = (suffix: string, command: string, status: string, exitCode: number | null) => {
      const id = `01910000-0000-7000-8000-00000000b0${suffix}`;
      return {
        id,
        type: 'commandExecution',
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: id },
        command,
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'bash' },
          providerName: 'bash',
          arguments: { storage: 'inline', value: { command } },
          schemaDigest: '0'.repeat(64),
        },
        description: null,
        cwd: '/mock/workspace',
        processId: null,
        status,
        commandActions: [],
        aggregatedOutput: null,
        exitCode,
        durationMs: 1,
      };
    };
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'turn/completed',
      threadId,
      turnId,
      turn: {
        id: turnId,
        items: [
          commandItem('02', 'ls', 'completed', 0),
          commandItem('03', 'timeout 1 sleep 5', 'failed', null),
          commandItem('04', 'sleep 30', 'interrupted', null),
          {
            id: '01910000-0000-7000-8000-00000000b005',
            type: 'agentMessage',
            provenance: {
              originThreadId: threadId,
              originTurnId: turnId,
              originItemId: '01910000-0000-7000-8000-00000000b005',
            },
            text: 'One command failed and one was stopped.',
            phase: 'final_answer',
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 5,
        durationMs: 4,
      },
    });
  });
}

async function openSelectedThreadActions(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' })
    .locator('.thread-list-row.is-selected')
    .getByRole('button', { name: 'Thread actions' })
    .click();
}

test.describe('canonical agent Thread surface', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('creates an empty Thread and renders canonical Turn Items', async ({ page }) => {
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await expect(composer).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(page.locator('.thread-empty-state')).toHaveCount(0);
    await expect(page.locator('.thread-dock-title')).toContainText('Untitled Thread');
    await expect(page.locator('.thread-dock-header').getByRole('button', { name: 'New Thread' })).toHaveCount(0);
    await expect(page.locator('.thread-dock-header').getByRole('button', { name: 'Thread actions' })).toHaveCount(0);

    await composer.fill('Summarize current outline.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.thread-dock-title')).toContainText('Summarize current outline.');

    const turn = page.locator('.thread-turn').first();
    const userMessage = turn.locator('.thread-user-message');
    const response = turn.locator('.thread-agent-message');
    await expect(userMessage).toContainText('Summarize current outline.');
    await expect(response).toContainText('Current outline focuses on design-system work.');
    await expect(turn.locator('.thread-process-rule')).toHaveCount(1);
    await page.evaluate(async () => {
      const target = window as unknown as {
        lin?: { agentCoreRequest: (method: string, input: unknown) => Promise<{ data: Array<{ id: string }> }> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const threads = await target.lin!.agentCoreRequest('thread/list', {});
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/name/updated',
        threadId: threads.data[0]!.id,
        threadName: 'Current outline summary',
      });
    });
    await expect(page.locator('.thread-dock-title')).toContainText('Current outline summary');
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await expect(page.locator('.thread-list-row.is-selected')).toContainText('Current outline summary');
    await page.keyboard.press('Escape');
    await response.hover();
    const responseActions = response.locator('.thread-response-actions');
    await expect(responseActions).toHaveCSS('opacity', '1');
    expect(await responseActions.getByRole('button').first().evaluate((button) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-soft)';
      document.body.append(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(button).color === expected;
    })).toBe(true);
    expect(await responseActions.getByRole('button').evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute('aria-label'))
    ))).toEqual([
      'Copy message',
      'Continue in new chat',
      'Details',
    ]);
    const [responseBodyBox, responseActionsBox] = await Promise.all([
      response.locator('.thread-agent-message-body').boundingBox(),
      responseActions.boundingBox(),
    ]);
    expect(responseBodyBox).toBeTruthy();
    expect(responseActionsBox).toBeTruthy();
    expect(responseActionsBox!.y).toBeGreaterThanOrEqual(responseBodyBox!.y + responseBodyBox!.height - 1);

    const messageDetailsButton = responseActions.getByRole('button', { name: 'Details' });
    await messageDetailsButton.hover();
    const usage = page.getByRole('tooltip');
    await expect(usage).toHaveCount(1);
    await expect(usage.locator('.thread-response-usage-context')).toContainText('Timestamp');
    await expect(usage.locator('.thread-response-usage-context')).toContainText('Provideropenai');
    await expect(usage.locator('.thread-response-usage-context')).toContainText('Modelopenai/gpt-5.4');
    await expect(usage.locator('.thread-response-usage-context')).toContainText('Reasoningmedium');
    await expect(usage).toContainText('Usage details');
    await expect(usage).toContainText('Cached: 21%');
    await expect(usage).toContainText('Input120');
    const paneCountBeforeDetails = await page.locator('.outline-panel-surface').count();
    await messageDetailsButton.click();
    await expect(page.getByRole('dialog', { name: 'Details' })).toHaveCount(0);
    await expect(usage).toHaveCount(0);
    const turnDetails = page.locator('.outline-panel-surface.is-thread-turn-details');
    await expect(turnDetails).toBeVisible();
    await expect(turnDetails).toHaveClass(/active-panel/);
    await expect(page.locator('.outline-panel-surface')).toHaveCount(paneCountBeforeDetails);
    await expect(turnDetails).toContainText('Model Interactions');
    await expect(turnDetails).toContainText('Summary');
    await expect(turnDetails).toContainText('Interaction Timeline (1)');
    await expect(turnDetails).toContainText('Internal diagnostics');
    await expect(turnDetails).toContainText('Model calls');
    await expect(turnDetails).toContainText('Tool executions: 0');
    await expect(turnDetails).not.toContainText('Canonical Items (2)');
    await expect(turnDetails).toContainText('Request');
    await expect(turnDetails).toContainText('Response');
    const request = turnDetails.getByRole('heading', { name: 'Request', exact: true }).locator('..');
    await expect(request).toContainText('Provider Request Content');
    await expect(request).not.toContainText('Provider request JSON');
    await expect(request).not.toContainText('Pre-adapter context');
    await expect(request).not.toContainText('Request metadata');
    await request.getByText('input', { exact: true }).click();
    await expect(request).toContainText('System Context');
    await request.locator('.thread-turn-details-part-list > .thread-turn-details-disclosure')
      .filter({ hasText: 'System Context' })
      .first()
      .locator(':scope > summary')
      .click();
    await expect(request).toContainText('Environment · Application · Observation');
    await expect(request).toContainText('Raw system context part');
    const firstCall = turnDetails.locator('.thread-turn-details-timeline-activity').filter({ hasText: 'Model Call 1' });
    const callInformation = firstCall.getByRole('button', { name: 'Model call information' });
    await callInformation.hover();
    const requestFacts = page.locator('.thread-turn-details-request-facts-card');
    await expect(requestFacts).toBeVisible();
    await expect(requestFacts).toContainText('Modelopenai/gpt-5.4');
    await expect(requestFacts).toContainText('Provideropenai');
    await expect(requestFacts).toContainText('Provider parameters');
    await expect(requestFacts).toContainText('modelopenai/gpt-5.4');
    await expect(requestFacts).toContainText('Estimated input tokens');
    await expect(requestFacts).toContainText('HTTP status200');
    await expect(requestFacts).toContainText('Stop reasonstop');
    await expect(requestFacts).toContainText('Usage details');
    const copyModelCall = firstCall.locator('button.thread-turn-details-call-action').last();
    await expect(copyModelCall).toHaveAttribute('aria-label', 'Copy model call');
    await copyModelCall.click();
    await expect(copyModelCall).toHaveAttribute('aria-label', 'Model call copied');
    await expect(firstCall).toHaveAttribute('open', '');
    const copiedCall = JSON.parse(await clipboardText(page)) as Record<string, unknown>;
    expect(Object.keys(copiedCall)).toEqual([
      'format', 'runtime', 'request', 'response', 'limitations',
    ]);
    expect(copiedCall.runtime).toMatchObject({ provider: 'openai', model: 'openai/gpt-5.4' });
    expect(copiedCall.request).toMatchObject({
      modelContext: {
        systemInstructions: 'Canonical mock system prompt.',
        messages: [expect.objectContaining({
          partProvenance: expect.arrayContaining([
            expect.objectContaining({ source: 'systemContext' }),
          ]),
        })],
        toolDefinitions: expect.any(Array),
      },
      providerPayload: {
        model: 'openai/gpt-5.4',
        instructions: 'Canonical mock system prompt.',
        input: expect.any(Array),
        tools: expect.any(Array),
      },
      facts: expect.objectContaining({ callIndex: 0 }),
    });
    expect(copiedCall.response).toMatchObject({
      transport: expect.any(Object),
      model: expect.objectContaining({ stopReason: 'stop', value: expect.any(Object) }),
    });
    expect(copiedCall.limitations).toEqual({
      imageBytes: 'omitted-with-byte-length-and-sha256',
      secretHeaders: 'not-recorded',
      rawProviderResponseBody: 'not-recorded',
    });
    const providerRequestContent = request.locator('.thread-turn-details-flow-group').first();
    await expect(providerRequestContent).not.toContainText('modelopenai/gpt-5.4');
    const requestText = await request.textContent() ?? '';
    expect(requestText).not.toContain('0. model');
    await turnDetails.getByText('Internal diagnostics', { exact: true }).click();
    await expect(turnDetails).toContainText('Canonical Items (2)');
    await expect(turnDetails).toContainText('Stable prompt source blocks');
    await expect(turnDetails).toContainText('Canonical tool schemas (1)');
    await turnDetails.getByText('Canonical Items (2)', { exact: true }).click();
    const userItemDetails = turnDetails.locator('.thread-turn-details-item').filter({ hasText: 'userMessage' });
    await userItemDetails.locator('.thread-turn-details-row-head').click();
    await expect(userItemDetails).toContainText('"type": "userMessage"');
    await turnDetails.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.locator('.outline-panel-surface.active-panel.is-outliner')).toBeVisible();

    await userMessage.hover();
    expect(await userMessage.locator('.thread-message-actions').getByRole('button').evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute('aria-label'))
    ))).toEqual(['Edit message', 'Copy message']);

    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Thread Details' }).click();
    const details = page.getByRole('dialog', { name: 'Thread Details' });
    await expect(details).toContainText('Thread ID');
    await expect(details).toContainText('Turn');
    await expect(details).toContainText('Item');
    await expect(details).toContainText('userMessage');
    await expect(details).toContainText('agentMessage');
    const canonicalIds = (await details.locator('code').allTextContents())
      .filter((value) => /^019[0-9a-f]{5}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
    expect(canonicalIds).toHaveLength(4);
    expect(new Set(canonicalIds).size).toBe(4);
    await details.getByRole('button', { name: 'Close Thread Details' }).click();

    const calls = await commandCalls(page);
    expect(calls.map((call) => call.cmd)).toEqual(expect.arrayContaining([
      'thread/list',
      'thread/start',
      'thread/turn/details/read',
      'thread/turns/list',
      'turn/start',
      'goal/get',
    ]));
  });

  test('renders used Memory as an inline Node reference while keeping node_read in the process', async ({ page }) => {
    const fixture = await page.evaluate(async ({ memoryNodeId }) => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000b101';
      const userId = '01910000-0000-7000-8000-00000000b102';
      const toolId = '01910000-0000-7000-8000-00000000b103';
      const answerId = '01910000-0000-7000-8000-00000000b104';
      const itemProvenance = (itemId: string) => ({
        originThreadId: threadId,
        originTurnId: turnId,
        originItemId: itemId,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: userId,
              type: 'userMessage',
              provenance: itemProvenance(userId),
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Use my saved preference.' }],
            },
            {
              id: toolId,
              type: 'dynamicToolCall',
              provenance: itemProvenance(toolId),
              namespace: null,
              tool: 'node_read',
              arguments: { node_id: memoryNodeId },
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'node_read' },
                providerName: 'node_read',
                arguments: { storage: 'inline', value: { node_id: memoryNodeId } },
                schemaDigest: '0'.repeat(64),
              },
              status: 'completed',
              outputRef: null,
              contentItems: [{ type: 'json', value: { nodeId: memoryNodeId, text: 'Prefer concise answers.' } }],
              success: true,
              durationMs: 8,
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: itemProvenance(answerId),
              text: `I kept the response concise based on [[node:Saved preference^${memoryNodeId}]].`,
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
            diagnosticsRef: null,
            usage: {
              input: 100,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 120,
              cost: null,
            },
          },
          startedAt: Date.now() - 1_000,
          completedAt: Date.now(),
          durationMs: 1_000,
        },
      });
      return { turnId };
    }, { memoryNodeId: ids.today });

    const turn = page.locator(`[data-thread-turn-row="${fixture.turnId}"]`);
    const answer = turn.locator('.thread-agent-message-final_answer');
    await expect(answer).toBeVisible();
    await expect(answer.getByRole('link', { name: 'Saved preference' })).toBeVisible();
    await expect(turn.locator('.thread-memory-citations')).toHaveCount(0);
    await expect(turn.getByText('Used memory')).toHaveCount(0);
    const process = turn.locator('.thread-process-block');
    await process.getByRole('button', { name: 'Worked for 1s' }).click();
    // The row stays in the process, but says what it did rather than which tool
    // was called.
    await expect(process.locator('.thread-tool').filter({ hasText: 'Read' })).toBeVisible();
    await expect(process).not.toContainText('node_read');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.mouse.move(0, 0);
    await expect(answer.getByRole('link', { name: 'Saved preference' })).toBeVisible();
  });

  test('projects live and settled Turn process before the final response', async ({ page }) => {
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    const ids = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const settledTurnId = '01910000-0000-7000-8000-00000000c101';
      const userId = '01910000-0000-7000-8000-00000000c102';
      const answerId = '01910000-0000-7000-8000-00000000c103';
      const reasoningId = '01910000-0000-7000-8000-00000000c104';
      const provenance = { originThreadId: threadId, originTurnId: settledTurnId, trigger: { kind: 'user' } };
      const itemProvenance = (itemId: string) => ({
        originThreadId: threadId,
        originTurnId: settledTurnId,
        originItemId: itemId,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId: settledTurnId,
        turn: {
          id: settledTurnId,
          items: [
            {
              id: userId,
              type: 'userMessage',
              provenance: itemProvenance(userId),
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Inspect the rollout order.' }],
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: itemProvenance(answerId),
              text: 'The final response arrived first.',
              phase: 'final_answer',
              memoryCitation: null,
            },
            {
              id: reasoningId,
              type: 'reasoning',
              provenance: itemProvenance(reasoningId),
              summary: ['Checked the canonical evidence.'],
              content: [],
            },
          ],
          itemsView: 'full',
          provenance,
          status: 'completed',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
            diagnosticsRef: null,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: null,
            },
          },
          startedAt: Date.now() - 2_400,
          completedAt: Date.now(),
          durationMs: 2_400,
        },
      });

      const liveTurnId = '01910000-0000-7000-8000-00000000c201';
      return { liveTurnId, settledTurnId, threadId };
    });

    const settledTurn = page.locator(`[data-thread-turn-row="${ids.settledTurnId}"]`);
    const process = settledTurn.locator('.thread-process-block');
    await expect(process).toHaveCount(1);
    await expect(process.getByRole('button', { name: 'Worked for 2s' })).toBeVisible();
    expect(await settledTurn.locator('.thread-process-block, .thread-agent-message-final_answer')
      .evaluateAll((elements) => elements.map((element) => element.className))).toEqual([
      'thread-process-block',
      'thread-item thread-agent-message thread-agent-message-final_answer',
    ]);
    await process.getByRole('button', { name: 'Worked for 2s' }).click();
    await expect(settledTurn.getByText('Checked the canonical evidence.')).toBeVisible();

    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const userId = '01910000-0000-7000-8000-00000000c202';
      const reasoningId = '01910000-0000-7000-8000-00000000c204';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [
            {
              id: userId,
              type: 'userMessage',
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: userId },
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Show the live state.' }],
            },
            {
              id: reasoningId,
              type: 'reasoning',
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: reasoningId },
              summary: ['Initiating web search.'],
              content: [],
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
            diagnosticsRef: null,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: null,
            },
          },
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
    }, ids);

    const liveTurn = page.locator(`[data-thread-turn-row="${ids.liveTurnId}"]`);
    await expect(liveTurn.locator('.thread-process-block')).toHaveCount(1);
    await expect(liveTurn.locator('.thread-process-title')).toHaveText('Working');
    await expect(liveTurn.getByText('Initiating web search.')).toBeVisible();
    const liveIndicator = liveTurn.getByLabel('Assistant is responding');
    await expect(liveIndicator).toBeVisible();
    const indicatorAlignment = await liveIndicator.evaluate((element) => {
      const footer = element.closest('.thread-response-footer');
      if (!(footer instanceof HTMLElement)) throw new Error('Expected response footer');
      const footerRect = footer.getBoundingClientRect();
      const indicatorRect = element.getBoundingClientRect();
      return Math.abs(
        (footerRect.top + footerRect.height / 2) - (indicatorRect.top + indicatorRect.height / 2),
      );
    });
    expect(indicatorAlignment).toBeLessThan(1);
    await page.evaluate(() => {
      const target = window as Window & {
        lin?: object;
        __threadMessageContextMenuCalls?: number;
      };
      if (!target.lin) throw new Error('Expected renderer bridge');
      target.__threadMessageContextMenuCalls = 0;
      const lin = target.lin as {
        showThreadMessageContextMenu?: () => Promise<null>;
      };
      lin.showThreadMessageContextMenu = async () => {
        target.__threadMessageContextMenuCalls = (target.__threadMessageContextMenuCalls ?? 0) + 1;
        return null;
      };
    });
    await liveIndicator.click({ button: 'right' });
    expect(await page.evaluate(() => (
      (window as Window & { __threadMessageContextMenuCalls?: number }).__threadMessageContextMenuCalls
    ))).toBe(0);
    const liveProcessGaps = await liveTurn.locator('.thread-process-block').evaluate((element) => {
      const title = element.querySelector<HTMLElement>('.thread-process-title');
      const rule = element.querySelector<HTMLElement>('.thread-process-rule');
      const timeline = element.querySelector<HTMLElement>('.thread-process-timeline');
      if (!title || !rule || !timeline) throw new Error('Expected live process geometry elements');
      const titleRect = title.getBoundingClientRect();
      const ruleRect = rule.getBoundingClientRect();
      const timelineRect = timeline.getBoundingClientRect();
      return {
        below: timelineRect.top - ruleRect.bottom,
        above: ruleRect.top - titleRect.bottom,
      };
    });
    expect(Math.abs(liveProcessGaps.above - liveProcessGaps.below)).toBeLessThan(1);

    await page.evaluate(({ liveTurnId, threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const userId = '01910000-0000-7000-8000-00000000c202';
      const answerId = '01910000-0000-7000-8000-00000000c203';
      const reasoningId = '01910000-0000-7000-8000-00000000c204';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [
            {
              id: userId,
              type: 'userMessage',
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: userId },
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Show the live state.' }],
            },
            {
              id: reasoningId,
              type: 'reasoning',
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: reasoningId },
              summary: ['Initiating web search.'],
              content: [],
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: answerId },
              text: 'The live state is complete.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          execution: {
            modelProvider: 'openai',
            model: 'openai/gpt-5.4',
            reasoningEffort: 'medium',
            diagnosticsRef: null,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: null,
            },
          },
          startedAt: Date.now() - 1_400,
          completedAt: Date.now(),
          durationMs: 1_400,
        },
      });
    }, ids);

    await expect(liveTurn.getByLabel('Assistant is responding')).toHaveCount(0);
    await expect(liveTurn.locator('.thread-process-title')).toHaveText('Worked for 1s');
  });

  test('keeps a process-free response stable when the Turn completes', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 340 });
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c301';
      const userId = '01910000-0000-7000-8000-00000000c302';
      const answerId = '01910000-0000-7000-8000-00000000c303';
      const startedAt = Date.now() - 3_000;
      const provenance = { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } };
      const itemProvenance = (itemId: string) => ({
        originThreadId: threadId,
        originTurnId: turnId,
        originItemId: itemId,
      });
      const items = [
        {
          id: userId,
          type: 'userMessage',
          provenance: itemProvenance(userId),
          clientId: null,
          acceptedAt: startedAt,
          content: [{ type: 'text', text: 'Hello again.' }],
        },
        {
          id: answerId,
          type: 'agentMessage',
          provenance: itemProvenance(answerId),
          text: 'Hello, I am here. What would you like to work through?',
          phase: 'final_answer',
          memoryCitation: null,
        },
      ];
      const execution = {
        modelProvider: 'openai',
        model: 'openai/gpt-5.4',
        reasoningEffort: 'medium',
        diagnosticsRef: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items,
          itemsView: 'full',
          provenance,
          status: 'inProgress',
          error: null,
          execution,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { execution, items, provenance, startedAt, threadId, turnId };
    });

    const turn = page.locator(`[data-thread-turn-row="${fixture.turnId}"]`);
    const answer = turn.locator('.thread-agent-message-body');
    const transcript = page.locator('.thread-transcript');
    await expect(turn.getByLabel('Assistant is responding')).toBeVisible();
    await expect(answer).toContainText('Hello, I am here.');
    await expect(turn.locator('.thread-process-timeline')).toHaveCount(0);
    await expect(turn.locator('.thread-user-message .thread-message-actions')).toHaveCount(0);
    await transcript.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await answer.locator('p').evaluate((element) => { element.dataset.identityProbe = 'stable'; });

    const measure = () => turn.evaluate((element) => {
      const answerBody = element.querySelector<HTMLElement>('.thread-agent-message-body');
      const footer = element.querySelector<HTMLElement>('.thread-response-footer');
      const processTitle = element.querySelector<HTMLElement>('.thread-process-title');
      const processRule = element.querySelector<HTMLElement>('.thread-process-rule');
      const scroller = element.closest('.thread-transcript');
      if (!answerBody || !footer || !processTitle || !processRule || !(scroller instanceof HTMLElement)) {
        throw new Error('Expected stable Turn geometry elements');
      }
      const turnRect = element.getBoundingClientRect();
      const answerRect = answerBody.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const titleRect = processTitle.getBoundingClientRect();
      const ruleRect = processRule.getBoundingClientRect();
      return {
        answerOffset: answerRect.top - turnRect.top,
        answerTop: answerRect.top,
        bottomGap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        footerHeight: footerRect.height,
        ruleToAnswer: answerRect.top - ruleRect.bottom,
        titleToRule: ruleRect.top - titleRect.bottom,
      };
    });
    const before = await measure();

    await page.evaluate((value) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const completedAt = Date.now();
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: value.threadId,
        turnId: value.turnId,
        turn: {
          id: value.turnId,
          items: value.items,
          itemsView: 'full',
          provenance: value.provenance,
          status: 'completed',
          error: null,
          execution: value.execution,
          startedAt: value.startedAt,
          completedAt,
          durationMs: completedAt - value.startedAt,
        },
      });
    }, fixture);

    await expect(turn.getByLabel('Assistant is responding')).toHaveCount(0);
    await expect(turn.locator('.thread-process-title')).toHaveText('Worked for 3s');
    await expect(turn.locator('.thread-user-message .thread-message-actions').getByRole('button')).toHaveCount(2);
    await expect(turn.locator('.thread-response-actions').getByRole('button')).toHaveCount(3);
    await expect(answer.locator('p')).toHaveAttribute('data-identity-probe', 'stable');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => (
      requestAnimationFrame(() => resolve())
    ))));
    const after = await measure();

    expect(Math.abs(before.answerOffset - after.answerOffset)).toBeLessThan(1);
    expect(Math.abs(before.answerTop - after.answerTop)).toBeLessThan(1);
    expect(Math.abs(before.footerHeight - after.footerHeight)).toBeLessThan(1);
    expect(before.bottomGap).toBeLessThan(1);
    expect(after.bottomGap).toBeLessThan(1);
    expect(Math.abs(after.titleToRule - after.ruleToAnswer)).toBeLessThan(1);
  });

  test('forks history without changing the source Thread', async ({ page }) => {
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Keep this history.');
    await page.getByRole('button', { name: 'Send' }).click();

    const turn = page.locator('.thread-turn').first();
    await turn.hover();
    await turn.getByRole('button', { name: 'Continue in new chat' }).click();

    await expect(page.locator('.thread-turn')).toHaveCount(1);
    await expect(page.locator('.thread-user-message')).toContainText('Keep this history.');
    await page.getByRole('button', { name: 'Show Threads' }).click();

    const rows = page.locator('.thread-list-row');
    await expect(rows).toHaveCount(2);
    let selectedFork = page.locator('.thread-list-row.is-selected');
    await expect(selectedFork).toContainText('Keep this history. (1)');

    await page.keyboard.press('Escape');
    await page.locator('.thread-turn').first().hover();
    await page.locator('.thread-turn').first().getByRole('button', { name: 'Continue in new chat' }).click();
    await page.getByRole('button', { name: 'Show Threads' }).click();
    selectedFork = page.locator('.thread-list-row.is-selected');
    await expect(selectedFork).toContainText('Keep this history. (2)');
    await expect(page.locator('.thread-list-row')).toHaveCount(3);
    expect((await commandCalls(page)).map((call) => call.cmd)).toContain('thread/fork');
  });

  test('keeps the established keyboard contract when editing a user message', async ({ page }) => {
    await createNewThread(page);
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Original request');
    await page.getByRole('button', { name: 'Send' }).click();
    const userMessage = page.locator('.thread-user-message').first();

    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Edit message' }).click();
    const editor = userMessage.getByRole('textbox', { name: 'Edit message' });
    await expect(editor).toBeFocused();
    await editor.fill('Discard this edit');
    await editor.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(userMessage).toContainText('Original request');

    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Edit message' }).click();
    const savedEditor = userMessage.getByRole('textbox', { name: 'Edit message' });
    await savedEditor.fill('Revised request');
    await savedEditor.press('Control+Enter');

    await expect(page.locator('.thread-user-message').last()).toContainText('Revised request');
    const calls = await commandCalls(page);
    expect(calls.filter((call) => call.cmd === 'thread/rollback').at(-1)?.args).toEqual({
      threadId: expect.any(String),
      numTurns: 1,
    });
    expect(calls.filter((call) => call.cmd === 'thread/fork')).toHaveLength(0);
  });

  test('offers Edit only on the latest user message', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('First request');
    await page.getByRole('button', { name: 'Send' }).click();
    await composer.fill('Latest request');
    await page.getByRole('button', { name: 'Send' }).click();

    const messages = page.locator('.thread-user-message');
    await expect(messages).toHaveCount(2);
    await messages.first().hover();
    await expect(messages.first().getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    await expect(messages.first().getByRole('button', { name: 'Copy message' })).toBeVisible();
    await messages.last().hover();
    await expect(messages.last().getByRole('button', { name: 'Edit message' })).toBeVisible();
  });

  test('sends an Outliner Node to the Thread as structured input', async ({ page }) => {
    await createNewThread(page);
    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Send to Agent' }).click();

    await expect(page.locator('.thread-composer-inline-ref')).toContainText('Alpha');
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    expect(start?.args.input).toEqual([{
      type: 'nodeReference',
      nodeId: ids.alpha,
      note: 'Alpha',
    }]);
  });

  test('preserves inline content order when text surrounds a Node reference', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Before ');
    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Send to Agent' }).click();
    await composer.pressSequentially('after');
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    expect(start?.args.input).toEqual([
      { type: 'text', text: 'Before ' },
      { type: 'nodeReference', nodeId: ids.alpha, note: 'Alpha' },
      { type: 'text', text: ' after' },
    ]);
    const userMessage = page.locator('.thread-user-message').last();
    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe('Before Alpha after');
  });

  test('keeps same-named files from distinct sources and accepts a regular file above the former shared limit', async ({ page }) => {
    await createNewThread(page);
    const fileInput = page.locator('.thread-composer-file-input');
    await fileInput.setInputFiles({
      name: 'report.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('first'),
    });
    await fileInput.setInputFiles({
      name: 'report.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('other'),
    });
    await fileInput.setInputFiles({
      name: 'archive.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(FORMER_SHARED_ATTACHMENT_LIMIT_BYTES + 1),
    });

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(3);
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    const input = start?.args.input as Array<{
      name?: string;
      sizeBytes?: number;
      source?: { kind?: string; ref?: { id?: string } };
      type?: string;
    }>;
    const reports = input.filter((part) => part.type === 'attachment' && part.name === 'report.bin');
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((part) => part.source?.ref?.id)).size).toBe(2);
    expect(input).toContainEqual(expect.objectContaining({
      type: 'attachment',
      name: 'archive.bin',
      sizeBytes: FORMER_SHARED_ATTACHMENT_LIMIT_BYTES + 1,
    }));
  });

  test('skips a pathless file that is already attached by content identity', async ({ page }) => {
    await createNewThread(page);
    const fileInput = page.locator('.thread-composer-file-input');
    const file = {
      name: 'duplicate.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('same content'),
    };
    await fileInput.setInputFiles(file);
    await fileInput.setInputFiles(file);

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(1);
    await expect(page.getByRole('status')).toContainText("Skipped 1 file that's already attached.");
  });

  test('rejects Office ownership files before they enter the composer', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: '.~Quarterly review.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: Buffer.from('ownership metadata'),
    });

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(
      '.~Quarterly review.pptx is a temporary Office ownership file. Choose the original document instead.',
    );
    expect((await commandCalls(page)).filter((call) => call.cmd.startsWith('attachment-upload/'))).toHaveLength(0);
  });

  test('serializes overlapping attachment batches at the composer limit', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.thread-composer-file-input');
      if (!input) throw new Error('Composer file input was not found');
      const dispatchBatch = (prefix: string) => {
        const transfer = new DataTransfer();
        for (let index = 0; index < 4; index += 1) {
          transfer.items.add(new File([`${prefix}-${index}`], `${prefix}-${index}.txt`, { type: 'text/plain' }));
        }
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      dispatchBatch('first');
      dispatchBatch('second');
    });

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(6);
    await expect(page.getByRole('status')).toContainText('Skipped 2 files over the 6 attachment limit.');
    expect((await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/begin')).toHaveLength(6);
  });

  test('preserves a directory selected from the composer mention menu', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('@');
    await page.getByRole('option', { name: /workspace.*mock\/local-root/i }).click();

    const directoryRef = page.locator('.thread-composer-inline-ref[data-inline-ref-entry-kind="directory"]');
    await expect(directoryRef).toContainText('workspace');
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    expect(start?.args.input).toEqual([expect.objectContaining({
      type: 'attachment',
      name: 'workspace',
      mimeType: 'inode/directory',
      sizeBytes: 0,
      source: { kind: 'localFile', path: '/mock/local-root/workspace' },
    })]);
  });

  test('renders one leading image gallery and keeps every file reference in message order', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ac01';
      const itemId = '01910000-0000-7000-8000-00000000ac02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'userMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
            clientId: null,
            acceptedAt: 1,
            content: [
              { type: 'text', text: 'Before' },
              {
                type: 'attachment',
                id: 'document-attachment',
                name: 'agenda.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 12,
                source: { kind: 'localFile', path: '/mock/local-root/agenda.pdf' },
              },
              { type: 'text', text: 'middle' },
              ...Array.from({ length: 6 }, (_, index) => ({
                type: 'attachment' as const,
                id: `image-attachment-${index + 1}`,
                name: `reference-${index + 1}.png`,
                mimeType: 'image/png',
                sizeBytes: 68,
                source: { kind: 'localFile' as const, path: `/mock/local-root/reference-${index + 1}.png` },
              })),
              { type: 'text', text: 'After' },
            ],
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });

    const message = page.locator('.thread-user-message').last();
    const sequence = message.locator('.thread-user-content-sequence');
    const bubbles = sequence.locator(':scope > .thread-user-content-shell');
    const gallery = sequence.locator(':scope > .thread-image-gallery');
    await expect(sequence.locator(':scope > *')).toHaveCount(2);
    await expect(bubbles).toHaveCount(1);
    await expect(bubbles.locator('.thread-user-inline-content')).toContainText(
      'Beforeagenda.pdfmiddlereference-1.png reference-2.png reference-3.png reference-4.png reference-5.png reference-6.pngAfter',
    );
    await expect(gallery).toHaveAccessibleName('6 images');
    await expect(gallery.locator('.thread-image-gallery-tile')).toHaveCount(4);
    await expect(gallery.locator('.thread-image-gallery-preview').first()).toHaveAccessibleName('reference-1.png');
    await expect(gallery.locator('.thread-image-gallery-preview img').first()).toHaveAttribute('alt', 'reference-1.png');
    await expect(message.getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    const showAll = gallery.getByRole('button', { name: 'Show all 6 images' });
    await expect(showAll).toHaveText('+2');
    await expect(showAll).toHaveAttribute('aria-expanded', 'false');
    expect(await sequence.evaluate((element) => Array.from(element.children).map((child) => child.className))).toEqual([
      'thread-image-gallery',
      'thread-user-content-shell',
    ]);
    const narrative = bubbles.locator('.thread-user-inline-content');
    const inlineFlow = await narrative.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        overflowWrap: style.overflowWrap,
        whiteSpace: style.whiteSpace,
      };
    });
    expect(inlineFlow).toEqual({
      overflowWrap: 'anywhere',
      whiteSpace: 'pre-wrap',
    });
    await expect(narrative.locator('.thread-message-file-ref')).toHaveText([
      'agenda.pdf',
      'reference-1.png',
      'reference-2.png',
      'reference-3.png',
      'reference-4.png',
      'reference-5.png',
      'reference-6.png',
    ]);
    expect(await narrative.locator('.thread-message-file-ref').evaluateAll((references) => (
      references.map((reference) => reference.getAttribute('data-inline-ref-path'))
    ))).toEqual([
      '/mock/local-root/agenda.pdf',
      '/mock/local-root/reference-1.png',
      '/mock/local-root/reference-2.png',
      '/mock/local-root/reference-3.png',
      '/mock/local-root/reference-4.png',
      '/mock/local-root/reference-5.png',
      '/mock/local-root/reference-6.png',
    ]);
    const imageReferenceTops = await narrative.locator('.thread-message-file-ref').evaluateAll((references) => (
      references.slice(1).map((reference) => Math.round(reference.getBoundingClientRect().top))
    ));
    expect(new Set(imageReferenceTops).size).toBeLessThan(imageReferenceTops.length);
    expect(await narrative.evaluate((element) => Array.from(element.children).map((child) => ({
      className: child.className,
      text: child.textContent,
    })))).toEqual([
      { className: '', text: 'Before' },
      { className: 'inline-ref thread-message-file-ref', text: 'agenda.pdf' },
      { className: '', text: 'middle' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-1.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-2.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-3.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-4.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-5.png' },
      { className: 'inline-ref thread-message-file-ref', text: 'reference-6.png' },
      { className: '', text: 'After' },
    ]);
    await message.hover();
    await message.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe(
      'Beforeagenda.pdfmiddlereference-1.png reference-2.png reference-3.png reference-4.png reference-5.png reference-6.pngAfter',
    );

    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(showAll, gallery);
    await expect(gallery.locator('.thread-image-gallery-tile')).toHaveCount(6);
    await expect(gallery).toHaveAttribute('data-layout-count', 'many');
    await expect(showAll).toHaveCount(0);
    const showFewer = gallery.getByRole('button', { name: 'Show fewer images' });
    await expect(showFewer).toBeVisible();
    await toggleDisclosureWithStableAnchor(showFewer, gallery);
    await expect(gallery.locator('.thread-image-gallery-tile')).toHaveCount(4);
    await expect(gallery).toHaveAttribute('data-layout-count', '4');
    await expect(gallery.getByRole('button', { name: 'Show all 6 images' })).toBeVisible();

    await page.setViewportSize({ width: 420, height: 760 });
    await expect(gallery).toBeInViewport();
    const overflowBadge = gallery.getByRole('button', { name: 'Show all 6 images' });
    const readOverflowContrast = () => overflowBadge.evaluate((element) => {
      const buttonStyle = getComputedStyle(element);
      return {
        background: buttonStyle.backgroundColor,
        backdropFilter: buttonStyle.backdropFilter,
        foreground: buttonStyle.color,
        reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      };
    });
    const expectResolvedOverflowContrast = async (reducedTransparency: boolean) => {
      const expected = {
        background: await resolveTokenColor(page, '--media-hud-bg'),
        backdropFilter: 'none',
        foreground: await resolveTokenColor(page, '--media-hud-fg'),
        reducedTransparency,
      };
      await expect.poll(readOverflowContrast, {
        message: `Overflow badge contrast did not settle for reducedTransparency=${reducedTransparency}`,
      }).toEqual(expected);
      return expected;
    };

    await emulateVisualMedia(page, { colorScheme: 'dark', reducedTransparency: 'no-preference' });
    const standardContrast = await expectResolvedOverflowContrast(false);

    await emulateVisualMedia(page, { colorScheme: 'dark', reducedTransparency: 'reduce' });
    const reducedContrast = await expectResolvedOverflowContrast(true);
    expect(reducedContrast.background).not.toBe(standardContrast.background);
    const reducedInteractionBackgrounds = {
      hover: await resolveTokenColor(page, '--media-hud-hover-bg'),
      active: await resolveTokenColor(page, '--media-hud-active-bg'),
    };

    await emulateVisualMedia(page, { colorScheme: 'dark', reducedTransparency: 'no-preference' });
    const interactionBackgrounds = {
      hover: await resolveTokenColor(page, '--media-hud-hover-bg'),
      active: await resolveTokenColor(page, '--media-hud-active-bg'),
    };
    expect(interactionBackgrounds.hover).not.toBe(reducedInteractionBackgrounds.hover);
    expect(interactionBackgrounds.active).not.toBe(reducedInteractionBackgrounds.active);

    const overflowGeometry = await gallery.getByRole('button', { name: 'Show all 6 images' }).evaluate((element) => {
      const tile = element.closest('.thread-image-gallery-tile');
      if (!tile) throw new Error('Overflow badge tile was not found');
      const buttonRect = element.getBoundingClientRect();
      const tileRect = tile.getBoundingClientRect();
      const tileStyle = getComputedStyle(tile);
      const cornerInset = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-4'));
      return {
        areaRatio: (buttonRect.width * buttonRect.height) / (tileRect.width * tileRect.height),
        rightInset: tileRect.right - buttonRect.right,
        bottomInset: tileRect.bottom - buttonRect.bottom,
        expectedRightInset: cornerInset + Number.parseFloat(tileStyle.borderRightWidth),
        expectedBottomInset: cornerInset + Number.parseFloat(tileStyle.borderBottomWidth),
      };
    });
    expect(overflowGeometry.areaRatio).toBeLessThan(0.25);
    expect(overflowGeometry.rightInset).toBe(overflowGeometry.expectedRightInset);
    expect(overflowGeometry.bottomInset).toBe(overflowGeometry.expectedBottomInset);
    await overflowBadge.hover();
    await expect(overflowBadge).toHaveCSS('background-color', interactionBackgrounds.hover);
    await page.mouse.down();
    await expect(overflowBadge).toHaveCSS('background-color', interactionBackgrounds.active);
    await page.mouse.up();
  });

  test('keeps a native selected image as a canonical local-file reference', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('@');
    await page.getByRole('option', { name: /reference\.png.*mock\/local-root/i }).click();

    const imageRef = page.locator('.thread-composer-inline-ref[data-inline-ref-path="/mock/local-root/reference.png"]');
    await expect(imageRef).toContainText('reference.png');
    await expect(imageRef).toHaveAttribute('data-inline-ref-thumbnail-data-url', /^data:image\/png;base64,/);
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    expect(start?.args.input).toEqual([expect.objectContaining({
      type: 'attachment',
      name: 'reference.png',
      mimeType: 'image/png',
      source: { kind: 'localFile', path: '/mock/local-root/reference.png' },
    })]);
  });

  test('does not reject an image at the renderer boundary because it exceeds the former shared limit', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'large-source.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(FORMER_SHARED_ATTACHMENT_LIMIT_BYTES + 1),
    });

    await expect(page.locator('.thread-composer-inline-ref')).toContainText('large-source.png');
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('streams a pathless image in bounded chunks and records only a managed reference', async ({ page }) => {
    await createNewThread(page);
    const originalSize = 2 * 1024 * 1024 + 123;
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'noise.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(originalSize, 7),
    });

    const imageRef = page.locator('.thread-composer-inline-ref');
    await expect(imageRef).toContainText('noise.png');
    await expect(imageRef).toHaveAttribute('data-inline-ref-thumbnail-data-url', /^blob:/);
    await page.getByRole('button', { name: 'Send' }).click();

    const start = (await commandCalls(page)).filter((call) => call.cmd === 'turn/start').at(-1);
    const attachment = (start?.args.input as Array<{
      mimeType?: string;
      sizeBytes?: number;
      source?: { kind?: string; ref?: { byteLength?: number; mimeType?: string } };
    }>)[0];
    expect(attachment?.mimeType).toBe('image/png');
    expect(attachment?.sizeBytes).toBe(originalSize);
    expect(attachment?.source).toMatchObject({
      kind: 'threadPayload',
      ref: { byteLength: originalSize, mimeType: 'image/png' },
    });
    const chunks = (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/append');
    expect(chunks.map((call) => call.args.byteLength)).toEqual([1024 * 1024, 1024 * 1024, 123]);
  });

  test('discards an unsent managed resource when its composer reference is removed', async ({ page }) => {
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'draft.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('draft payload'),
    });
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await expect(page.locator('.thread-composer-inline-ref')).toContainText('draft.bin');

    await composer.focus();
    await composer.press('End');
    await composer.press('Backspace');
    await composer.press('Backspace');

    await expect(page.locator('.thread-composer-inline-ref')).toHaveCount(0);
    await expect.poll(async () => (
      (await commandCalls(page)).filter((call) => call.cmd === 'attachment-resource/discard').length
    )).toBe(1);
  });

  test('retains measured long-message disclosure behavior', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Line 1');
    for (let line = 2; line <= 9; line += 1) {
      await composer.press('Shift+Enter');
      await composer.pressSequentially(`Line ${line}`);
    }
    await page.getByRole('button', { name: 'Send' }).click();

    const disclosure = page.getByRole('button', { name: 'Show more' });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.click();
    await expect(page.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('restores composer focus when the Agent rail reopens', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });

    await page.getByRole('button', { name: 'Collapse agent' }).click();
    await page.getByRole('button', { name: 'Expand agent' }).click();

    await expect(composer).toBeFocused();
  });

  test('retains the established full-bleed composer geometry', async ({ page }) => {
    await createNewThread(page);
    const metrics = await page.locator('.thread-view').evaluate((view) => {
      const dock = view.closest('.thread-dock');
      const composer = view.querySelector('.thread-composer-region');
      const surface = view.querySelector('.thread-composer-surface');
      const editor = view.querySelector('.thread-composer-editor');
      const editorText = editor?.querySelector('.ProseMirror');
      const attachment = surface?.querySelector('.icon-button-composerTool');
      const action = surface?.querySelector('.icon-button-composerAction');
      if (!(dock instanceof HTMLElement)
        || !(composer instanceof HTMLElement)
        || !(surface instanceof HTMLElement)
        || !(editor instanceof HTMLElement)
        || !(editorText instanceof HTMLElement)
        || !(attachment instanceof HTMLElement)
        || !(action instanceof HTMLElement)) return null;
      const viewBox = view.getBoundingClientRect();
      const dockBox = dock.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      const surfaceBox = surface.getBoundingClientRect();
      const editorBox = editor.getBoundingClientRect();
      const editorTextBox = editorText.getBoundingClientRect();
      const attachmentBox = attachment.getBoundingClientRect();
      const actionBox = action.getBoundingClientRect();
      const surfaceStyle = getComputedStyle(surface);
      const attachmentStyle = getComputedStyle(attachment);
      const actionStyle = getComputedStyle(action);
      return {
        actionBottomInset: surfaceBox.bottom - actionBox.bottom,
        actionRadius: Number.parseFloat(actionStyle.borderTopLeftRadius),
        actionRightInset: surfaceBox.right - actionBox.right,
        actionSize: actionBox.width,
        attachmentBottomInset: surfaceBox.bottom - attachmentBox.bottom,
        attachmentLeftInset: attachmentBox.left - surfaceBox.left,
        attachmentRadius: Number.parseFloat(attachmentStyle.borderTopLeftRadius),
        attachmentSize: attachmentBox.width,
        composerBottomDelta: Math.abs(viewBox.bottom - composerBox.bottom),
        editorLeftInset: editorBox.left - surfaceBox.left,
        editorRightInset: surfaceBox.right - editorBox.right,
        editorTextLeftInset: editorTextBox.left - surfaceBox.left,
        editorTextRightInset: surfaceBox.right - editorTextBox.right,
        surfaceBottomDelta: Math.abs(viewBox.bottom - surfaceBox.bottom),
        surfaceLeftInset: surfaceBox.left - dockBox.left,
        surfacePaddingBottom: Number.parseFloat(surfaceStyle.paddingBottom),
        surfacePaddingLeft: Number.parseFloat(surfaceStyle.paddingLeft),
        surfacePaddingRight: Number.parseFloat(surfaceStyle.paddingRight),
        surfaceRightInset: dockBox.right - surfaceBox.right,
      };
    });

    expect(metrics).not.toBeNull();
    expect(metrics!.composerBottomDelta).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceBottomDelta).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceLeftInset).toBeLessThanOrEqual(1);
    expect(metrics!.surfaceRightInset).toBeLessThanOrEqual(1);
    expect(metrics!.surfacePaddingLeft).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.surfacePaddingBottom).toBe(metrics!.surfacePaddingRight);
    expect(metrics!.actionSize).toBe(metrics!.attachmentSize);
    expect(metrics!.actionRadius).toBeGreaterThanOrEqual(metrics!.actionSize / 2);
    expect(metrics!.attachmentRadius).toBeGreaterThanOrEqual(metrics!.attachmentSize / 2);
    expect(Math.abs(metrics!.attachmentLeftInset - metrics!.surfacePaddingLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.attachmentBottomInset - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionRightInset - metrics!.surfacePaddingRight)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics!.actionBottomInset - metrics!.surfacePaddingBottom)).toBeLessThanOrEqual(1);
    expect(metrics!.editorLeftInset).toBeLessThanOrEqual(1);
    expect(metrics!.editorRightInset).toBeLessThanOrEqual(1);
    expect(metrics!.editorTextLeftInset).toBe(metrics!.editorTextRightInset);
    expect(metrics!.editorTextLeftInset).toBeGreaterThanOrEqual(metrics!.surfacePaddingLeft);
  });

  test('reuses the composer slash menu for directly invocable Skills', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('/');

    const menu = page.getByRole('listbox', { name: 'Thread slash commands' });
    await expect(menu.getByRole('option', { name: /compact/ })).toContainText('Replace earlier context with a durable summary');
    await expect(menu.getByRole('option', { name: /clear/ })).toContainText('Start a new context epoch without deleting history');
    const skill = menu.getByRole('option', { name: /workspace-review/ });
    await expect(skill).toContainText('Review workspace conventions before automatic use.');
    await skill.click();

    await expect(composer).toHaveText('/workspace-review ');
    await expect(composer).toBeFocused();
    expect((await commandCalls(page)).filter((call) => call.cmd === 'agent_list_all_skills').at(-1)?.args)
      .toMatchObject({ userInvocableOnly: true });
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`renders context boundaries and reset affinity in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await createNewThread(page);
      const composer = page.getByRole('textbox', { name: 'Message this Thread' });
      await composer.fill('Establish context before reset.');
      await page.getByRole('button', { name: 'Send' }).click();

      const fixture = await page.evaluate(async () => {
        const target = window as Window & {
          lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
          __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
        };
        const threadResponse = await target.lin!.agentCoreRequest<{
          data: Array<{ id: string }>;
        }>('thread/list', {});
        const threadId = threadResponse.data[0]?.id;
        if (!threadId) throw new Error('Mock Thread not found');
        const turnsResponse = await target.lin!.agentCoreRequest<{
          data: Array<{ id: string; items: Array<{ id: string }> }>;
        }>('thread/turns/list', { threadId, itemsView: 'full' });
        const prior = turnsResponse.data.at(-1);
        const clearedItem = prior?.items.at(-1);
        if (!prior || !clearedItem) throw new Error('Mock prior Turn not found');
        const resetTurnId = '01910000-0000-7000-8000-00000000fc01';
        const resetItemId = '01910000-0000-7000-8000-00000000fc02';
        const epochTurnId = '01910000-0000-7000-8000-00000000fc03';
        const epochUserItemId = '01910000-0000-7000-8000-00000000fc04';
        const epochAgentItemId = '01910000-0000-7000-8000-00000000fc05';
        const compactionTurnId = '01910000-0000-7000-8000-00000000fc06';
        const compactionItemId = '01910000-0000-7000-8000-00000000fc07';
        const execution = {
          modelProvider: 'openai',
          model: 'openai/gpt-5.4',
          reasoningEffort: 'medium',
          diagnosticsRef: null,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: null,
          },
        };
        const emitTurn = (turn: unknown, turnId: string) => target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId,
          turnId,
          turn,
        });
        emitTurn({
          id: resetTurnId,
          items: [{
            id: resetItemId,
            type: 'contextReset',
            provenance: { originThreadId: threadId, originTurnId: resetTurnId, originItemId: resetItemId },
            clearedThrough: { turnId: prior.id, itemId: clearedItem.id },
          }],
          itemsView: 'full',
          provenance: {
            originThreadId: threadId,
            originTurnId: resetTurnId,
            trigger: { kind: 'feature', feature: 'context.clear', ref: 'e2e-clear' },
          },
          status: 'completed',
          error: null,
          execution,
          startedAt: 100,
          completedAt: 101,
          durationMs: 1,
        }, resetTurnId);

        const epochItemProvenance = (itemId: string) => ({
          originThreadId: threadId,
          originTurnId: epochTurnId,
          originItemId: itemId,
        });
        emitTurn({
          id: epochTurnId,
          items: [
            {
              id: epochUserItemId,
              type: 'userMessage',
              provenance: epochItemProvenance(epochUserItemId),
              clientId: null,
              acceptedAt: 102,
              content: [{ type: 'text', text: 'Establish context after reset.' }],
            },
            {
              id: epochAgentItemId,
              type: 'agentMessage',
              provenance: epochItemProvenance(epochAgentItemId),
              text: 'The new context epoch is active.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: {
            originThreadId: threadId,
            originTurnId: epochTurnId,
            trigger: { kind: 'user' },
          },
          status: 'completed',
          error: null,
          execution,
          startedAt: 102,
          completedAt: 103,
          durationMs: 1,
        }, epochTurnId);

        const summaryRef = {
          id: 'a'.repeat(64),
          mimeType: 'application/vnd.tenon.agent-context+json',
          byteLength: 100,
          schemaVersion: 1,
          kind: 'compactionSummary',
        };
        const restoredStateRef = {
          id: 'b'.repeat(64),
          mimeType: 'application/vnd.tenon.agent-context+json',
          byteLength: 100,
          schemaVersion: 1,
          kind: 'compactionRestoredState',
        };
        emitTurn({
          id: compactionTurnId,
          items: [{
            id: compactionItemId,
            type: 'contextCompaction',
            provenance: {
              originThreadId: threadId,
              originTurnId: compactionTurnId,
              originItemId: compactionItemId,
            },
            trigger: 'manual',
            coveredFrom: { turnId: epochTurnId, itemId: epochUserItemId },
            coveredThrough: { turnId: epochTurnId, itemId: epochAgentItemId },
            preservedFrom: null,
            summaryRef,
            restoredStateRef,
            instructionsRef: null,
            contextRefs: [],
            resourceRefs: [],
            outputRefs: [],
          }],
          itemsView: 'full',
          provenance: {
            originThreadId: threadId,
            originTurnId: compactionTurnId,
            trigger: { kind: 'feature', feature: 'context.compact', ref: 'e2e-compact' },
          },
          status: 'completed',
          error: null,
          execution,
          startedAt: 104,
          completedAt: 105,
          durationMs: 1,
        }, compactionTurnId);
        return { compactionTurnId, resetItemId };
      });

      const boundaries = page.locator('.thread-compaction');
      await expect(boundaries).toHaveText(['Context cleared.', 'Context compacted.']);
      await expect(boundaries.last()).toBeInViewport();
      const transcript = page.locator('.thread-transcript');
      await expect.poll(() => transcript.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
        .toBe(colorScheme === 'dark');

      const compactionTurn = page.locator(`[data-thread-turn-row="${fixture.compactionTurnId}"]`);
      await expect(compactionTurn.getByRole('button', { name: 'Copy message' })).toHaveCount(0);
      await expect(compactionTurn.getByRole('button', { name: 'Continue in new chat' })).toHaveCount(0);
      await compactionTurn.hover();
      await compactionTurn.getByRole('button', { name: 'Details' }).click();
      const turnDetails = page.locator('.outline-panel-surface.is-thread-turn-details');
      await expect(turnDetails).toContainText('Model Interactions');
      await expect(turnDetails).toContainText('Request diagnostics have not been recorded for this Turn.');
      await turnDetails.getByText('Internal diagnostics', { exact: true }).click();
      await turnDetails.getByText('Canonical Items (1)', { exact: true }).click();
      await expect(turnDetails).toContainText('contextCompaction');
      await expect.poll(() => turnDetails.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    });
  }

  test('keeps Thread actions in an anchored keyboard menu', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 620 });
    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    const trigger = page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-row.is-selected')
      .getByRole('button', { name: 'Thread actions' });
    await trigger.click();

    const menu = page.getByRole('menu', { name: 'Thread actions' });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(760);
    expect(box!.y + box!.height).toBeLessThanOrEqual(620);
    await expect(menu.getByRole('menuitem', { name: 'Thread Details' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Rename Thread' })).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  // The menu's width is a constant the anchoring math needs, so a label that
  // outgrows it cannot widen the menu — it wrapped under the icon before, and
  // ellipsizes now. Both are the same defect at the point a label is written,
  // which is where this fails.
  test('fits every action label on one line', async ({ page }) => {
    await openSelectedThreadActions(page);
    await expect(page.getByRole('menu', { name: 'Thread actions' })).toBeVisible();

    const items = await page.locator('.thread-action-menu button').evaluateAll((buttons) => buttons.map((button) => {
      const label = button.querySelector('.thread-action-menu-label');
      return {
        text: label?.textContent ?? '',
        height: button.getBoundingClientRect().height,
        overflow: label ? label.scrollWidth - label.clientWidth : 0,
      };
    }));

    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item.text, 'every item routes its label through the ellipsizing span').not.toBe('');
      expect(item.overflow, `"${item.text}" is truncated`).toBeLessThanOrEqual(0);
      expect(item.height, `"${item.text}" wrapped to a second line`).toBeLessThanOrEqual(32);
      // The key list below is hand-written, and nothing typechecks this file, so
      // a rename that updates the component and the messages leaves it stale and
      // silently measuring one string fewer. What the menu actually rendered has
      // to be in the set, or the set is not the set.
      expect(ACTION_MENU_LABELS, `"${item.text}" is rendered but never measured`).toContain(item.text);
    }

    for (const key of ACTION_MENU_LABEL_KEYS) {
      expect(en.agent.thread, `no en label for "${key}" — the key list is stale`).toHaveProperty(key);
    }

    // What the menu renders is one locale's answer to one records state: the
    // mock always reports `recorded: true`, so "Show in Recall", the failure
    // label, and every zh-Hans label are never on screen to be measured. Feed
    // each through a real label element instead — same font, same box, same
    // available width — so the guard covers the strings rather than the run.
    const measured = await page.locator('.thread-action-menu-label').first()
      .evaluate((label, labels) => {
        const rendered = label.textContent;
        const widths = labels.map((text) => {
          label.textContent = text;
          return { text, overflow: label.scrollWidth - label.clientWidth };
        });
        label.textContent = rendered;
        return widths;
      }, ACTION_MENU_LABELS);

    // No count assertion here: `measured` is `ACTION_MENU_LABELS.map(...)`, so
    // any comparison between the two is true by construction. What keeps the set
    // complete is the strict `en` read where it is built, which fails to
    // compile rather than at runtime.
    for (const label of measured) {
      expect(label.overflow, `"${label.text}" does not fit the menu`).toBeLessThanOrEqual(0);
    }
  });

  test('renames and deletes a Thread through in-app dialogs', async ({ page }) => {
    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Rename Thread' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename Thread' });
    await renameDialog.getByRole('textbox', { name: 'Rename Thread' }).fill('Research notes');
    await renameDialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.thread-dock-title')).toContainText('Research notes');

    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Delete Thread' }).click();
    const deleteDialog = page.getByRole('dialog', { name: 'Delete Thread' });
    await expect(deleteDialog).toContainText('Research notes');
    await deleteDialog.getByRole('button', { name: 'Delete Thread' }).click();

    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeVisible();
    await expect(page.locator('.thread-dock-title')).toContainText('Untitled Thread');
    await expect(page.locator('.thread-empty-state')).toHaveCount(0);
    const calls = (await commandCalls(page)).map((call) => call.cmd);
    expect(calls).toEqual(expect.arrayContaining(['thread/name/set', 'thread/delete']));
    expect(calls.filter((command) => command === 'thread/start')).toHaveLength(2);
  });

  test('changes the canonical Thread model and reasoning from the composer', async ({ page }) => {
    await createNewThread(page);

    const control = page.getByRole('button', { name: 'Model and reasoning' });
    await expect(control).toContainText('GPT-5.4');
    await expect(control).toContainText('Medium');
    await control.click();
    await page.getByRole('menu', { name: 'Model and reasoning' })
      .getByRole('menuitem', { name: 'GPT-5.4' })
      .click();
    await page.getByRole('menu', { name: 'Model', exact: true })
      .getByRole('menuitemradio', { name: 'GPT-5.4 Mini' })
      .click();
    await expect(control).toContainText('GPT-5.4 Mini');

    await control.click();
    await page.getByRole('menu', { name: 'Model and reasoning' })
      .getByRole('menuitem', { name: /Reasoning/ })
      .click();
    await page.getByRole('menu', { name: 'Reasoning' })
      .getByRole('menuitemradio', { name: 'High' })
      .click();
    await expect(control).toContainText('High');

    const updates = (await commandCalls(page)).filter((call) => call.cmd === 'thread/configuration/set');
    expect(updates.map((call) => call.args)).toEqual([
      expect.objectContaining({
        modelProvider: 'openai',
        model: 'openai/gpt-5.4-mini',
        reasoningEffort: 'medium',
      }),
      expect.objectContaining({
        modelProvider: 'openai',
        model: 'openai/gpt-5.4-mini',
        reasoningEffort: 'high',
      }),
    ]);

    await control.click();
    await expect(page.getByRole('menu', { name: 'Model and reasoning' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Model and reasoning' })).toHaveCount(0);
    await expect(control).toBeFocused();
  });

  test('returns a pinned Thread to the connection\'s newest model without changing provider', async ({ page }) => {
    await createNewThread(page);

    const control = page.getByRole('button', { name: 'Model and reasoning' });
    const openModelList = async () => {
      await control.click();
      await page.getByRole('menu', { name: 'Model and reasoning' })
        .getByRole('menuitem', { name: /GPT-5\.4/ })
        .click();
      return page.getByRole('menu', { name: 'Model', exact: true });
    };

    // Pinning is what used to be a one-way door: the menu offered only concrete
    // models, so a Thread could never be handed back to "whatever is newest".
    await (await openModelList()).getByRole('menuitemradio', { name: 'GPT-5.4 Mini' }).click();
    await expect(control).toContainText('GPT-5.4 Mini');

    const alwaysNewest = (await openModelList()).getByRole('menuitemradio', { name: /Always newest/ });
    await expect(alwaysNewest).toHaveAttribute('aria-checked', 'false');
    // The row names what selecting it switches TO — the head — not the model
    // currently pinned, which is what it would advertise if it read the resolved
    // option while pinned.
    await expect(alwaysNewest).not.toContainText('Mini');
    await alwaysNewest.click();
    // The pill keeps naming the model that will run — now the ranked head again.
    // Asserted as an exclusion too: 'GPT-5.4' is a substring of 'GPT-5.4 Mini',
    // so containment alone would pass without the pill ever updating.
    await expect(control).not.toContainText('Mini');
    await expect(control).toContainText('GPT-5.4');

    const restored = (await openModelList()).getByRole('menuitemradio', { name: /Always newest/ });
    await expect(restored).toHaveAttribute('aria-checked', 'true');
    // Floating must not read as a pin to the model it happens to resolve to.
    await expect(
      page.getByRole('menu', { name: 'Model', exact: true })
        .getByRole('menuitemradio', { name: 'GPT-5.4', exact: true }),
    ).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    const updates = (await commandCalls(page)).filter((call) => call.cmd === 'thread/configuration/set');
    expect(updates.map((call) => call.args)).toEqual([
      expect.objectContaining({ modelProvider: 'openai', model: 'openai/gpt-5.4-mini' }),
      // Only the model field moves; the connection is left exactly as it was.
      expect.objectContaining({ modelProvider: 'openai', model: 'inherit' }),
    ]);
  });

  test('retains the anchored Thread list dismissal and row-action interactions', async ({ page }) => {
    await createNewThread(page);
    const listButton = page.getByRole('button', { name: 'Show Threads' });
    await listButton.click();

    const list = page.getByRole('dialog', { name: 'Threads' });
    const row = list.locator('.thread-list-row:not(.is-selected)').first();
    const selectedRow = list.locator('.thread-list-row.is-selected');
    await expect(list).toBeVisible();
    await expect(selectedRow.locator('.thread-list-actions')).toHaveCSS('opacity', '1');
    await expect(row.locator('.thread-list-actions')).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(row.locator('.thread-list-actions')).toHaveCSS('opacity', '1');
    await expect(row.locator('.thread-list-actions').getByRole('button')).toHaveAttribute('aria-label', 'Thread actions');
    await expect(row.locator('small')).not.toContainText('user');

    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(listButton).toBeFocused();

    await listButton.click();
    await page.locator('.thread-transcript').click({ position: { x: 12, y: 180 } });
    await expect(list).toHaveCount(0);
  });

  test('refreshes provider gating without discarding the composer draft', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Keep this draft.');

    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: {
          invoke: <T>(command: string, input?: Record<string, unknown>) => Promise<T>;
          notifySettingsChanged?: () => Promise<void>;
        };
      };
      await target.lin?.invoke('agent_delete_provider_config', { providerId: 'openai' });
      await target.lin?.notifySettingsChanged?.();
    });

    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute('title', 'Configure an AI provider before starting a Thread.');
    await expect(page.getByRole('button', { name: 'Add attachment' })).toBeDisabled();
    await expect(composer).toHaveText('Keep this draft.');
  });

  test('expands a Subagent run in place, like every other process row', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const child = {
        ...root,
        id: '01910000-0000-7000-8000-00000000dd01',
        parentThreadId: root.id,
        agentNickname: 'research',
        agentRole: 'explorer',
        name: 'Research child',
        threadSource: 'subagent',
        updatedAt: Number(root.updatedAt) + 1,
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'thread/started', threadId: child.id, thread: child });
      const turnId = '01910000-0000-7000-8000-00000000dd02';
      const itemId = '01910000-0000-7000-8000-00000000dd03';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: root.id,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'subAgentActivity',
            provenance: { originThreadId: root.id, originTurnId: turnId, originItemId: itemId },
            kind: 'completed',
            agentThreadId: child.id,
            agentPath: '/root/research',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: root.id, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });

    const parentTitle = await page.locator('.thread-dock-title').innerText();
    const trigger = page.getByRole('button', { name: /^Open Subagent Thread research/u });

    // Collapsed until asked, and announced as a disclosure — the same gesture
    // every other row in this timeline answers to.
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const detail = page.locator('.thread-subagent-detail');
    await expect(detail).toHaveCount(0);

    await trigger.click();
    await expect(detail).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Nothing was navigated to and nothing was covered: the dock still names
    // the conversation the user chose, and its composer still belongs to it.
    await expect(page.locator('.thread-dock-title')).toHaveText(parentTitle);
    await expect(detail.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);
    await expect(detail).toContainText('Driven by this conversation');
    // A settled child offers no Stop; there is no Turn to stop.
    await expect(detail.getByRole('button', { name: /^Stop / })).toHaveCount(0);

    // The container is BOUNDED and scrolls itself, so opening it cannot push
    // the transcript around however long the child ran.
    expect(await detail.evaluate((element) => {
      const style = getComputedStyle(element);
      return { bounded: element.getBoundingClientRect().height <= 421, contained: style.overscrollBehavior };
    })).toMatchObject({ bounded: true });

    await trigger.click();
    await expect(detail).toHaveCount(0);
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // A child is an execution artifact, not a conversation: never a list row.
    await page.getByRole('button', { name: 'Show Threads' }).click();
    const list = page.getByRole('dialog', { name: 'Threads' });
    await expect(list.locator('.thread-list-row').filter({ hasText: 'Research child' })).toHaveCount(0);
    // Only the two root conversations this test created.
    await expect(list.locator('.thread-list-row')).toHaveCount(2);
    await expect(list.locator('.thread-list-row small').filter({ hasText: 'Subagent' })).toHaveCount(0);
  });

  test('swaps a grandchild into the same container, never nesting a second scroll region', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const child = {
        ...root,
        id: '01910000-0000-7000-8000-00000000ea01',
        parentThreadId,
        agentNickname: null,
        agentRole: 'worker',
        name: 'research',
        source: 'collaboration',
        threadSource: 'subagent',
        status: { type: 'idle' },
      };
      const grandchild = {
        ...child,
        id: '01910000-0000-7000-8000-00000000ea02',
        parentThreadId: child.id,
        name: 'audit',
      };
      for (const thread of [child, grandchild]) {
        target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'thread/started', threadId: thread.id, thread });
      }
      const provenance = (threadId: string, turnId: string, itemId: string) => ({
        originThreadId: threadId, originTurnId: turnId, originItemId: itemId,
      });
      // Enough parent Turns that the transcript scrolls at all.
      for (let index = 0; index < 12; index += 1) {
        const turnId = `01910000-0000-7000-8000-0000000eb0${index.toString(16)}`;
        const itemId = `01910000-0000-7000-8000-0000000ec0${index.toString(16)}`;
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId: parentThreadId,
          turnId,
          turn: {
            id: turnId,
            items: index === 11
              ? [{
                  id: itemId,
                  type: 'subAgentActivity',
                  provenance: provenance(parentThreadId, turnId, itemId),
                  kind: 'completed',
                  agentThreadId: child.id,
                  agentPath: '/root/research',
                  error: null,
                  spawnItemId: null,
                }]
              : [{
                  id: itemId,
                  type: 'agentMessage',
                  provenance: provenance(parentThreadId, turnId, itemId),
                  phase: 'final',
                  text: `Answer ${index}\n\nwith enough body to give the transcript some height.`,
                }],
            itemsView: 'full',
            provenance: { originThreadId: parentThreadId, originTurnId: turnId, trigger: { kind: 'user' } },
            status: 'completed',
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1,
          },
        });
      }
      // The child's own transcript: a Turn a delegation started, so its "user"
      // message is the task the parent wrote. Seeded as canonical history, not
      // pushed as a notification — the drawer LOADS the child from the host.
      const childTurnId = '01910000-0000-7000-8000-00000000ed01';
      target.__LIN_E2E__?.setMockThreadTurns(child.id, [
        {
          id: childTurnId,
          items: [
            {
              id: '01910000-0000-7000-8000-00000000ed02',
              type: 'userMessage',
              provenance: provenance(child.id, childTurnId, '01910000-0000-7000-8000-00000000ed02'),
              content: [{ type: 'text', text: 'Investigate the deployment story.' }],
            },
            {
              id: '01910000-0000-7000-8000-00000000ed03',
              type: 'subAgentActivity',
              provenance: provenance(child.id, childTurnId, '01910000-0000-7000-8000-00000000ed03'),
              kind: 'completed',
              agentThreadId: grandchild.id,
              agentPath: '/root/research/audit',
              error: null,
              spawnItemId: null,
            },
          ],
          itemsView: 'full',
          provenance: {
            originThreadId: child.id,
            originTurnId: childTurnId,
            trigger: { kind: 'subagent', parentThreadId, parentItemId: 'spawn' },
          },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      ]);
      return { parentThreadId };
    });

    // Scrolled by hand, so the transcript stops following the tail the way it
    // would for a reader who scrolled up to re-read something.
    const scroll = page.locator('.thread-transcript');
    await scroll.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => scroll.evaluate((element) => element.scrollTop))
      .toBeLessThan(await scroll.evaluate((element) => element.scrollHeight - element.clientHeight));
    // Proof the reader is genuinely off the tail: the jump-to-latest affordance
    // only exists when the transcript has stopped following.
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    await page.getByRole('button', { name: /^Open Subagent Thread research/u }).click();
    const detail = page.locator('.thread-subagent-detail');
    await expect(detail).toBeVisible();

    // A child transcript reads exactly like the main chat — same message stream,
    // same bubble — because it is the same thing: one request and the work it
    // produced. What differs is only what cannot act here: no composer, and no
    // Edit or Continue-in-new-chat, since neither can run on a child Thread.
    await expect(detail.locator('.thread-user-message')).toContainText('Investigate the deployment story.');
    await expect(detail.getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Continue in new chat' })).toHaveCount(0);

    const outerHeight = await detail.evaluate((element) => element.getBoundingClientRect().height);

    // Depth 2 REPLACES these contents and names the way back. A second box
    // inside this one would put a scroll region inside a scroll region, which
    // fights the trackpad at the boundary and draws depth as indentation.
    await detail.getByRole('button', { name: /^Open Subagent Thread audit/u }).click();
    await expect(detail).toHaveCount(1);
    await expect(detail.locator('.thread-subagent-detail-title')).toHaveText('audit');
    // Same box, same height: swapping cannot move the transcript around it.
    expect(await detail.evaluate((element) => element.getBoundingClientRect().height)).toBe(outerHeight);

    // The crumb keeps the way back visible by name, so the swap has something
    // to orient against rather than reading as a jump.
    await expect(detail.locator('.thread-subagent-detail-crumb')).toHaveText('research');
    await detail.locator('.thread-subagent-detail-crumb').click();
    await expect(detail.locator('.thread-subagent-detail-title')).toHaveText('research');
    await expect(detail.locator('.thread-subagent-detail-crumb')).toHaveCount(0);
  });

  test('browses and cleans up Subagents from parent Thread Details', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: {
          createMockSubagentThread: (input: {
            parentThreadId: string;
            name: string;
            active?: boolean;
            queuedWork?: boolean;
          }) => { id: string };
          emitAgentCoreNotification: (notification: unknown) => void;
        };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const parentThreadId = response?.data[0]?.id;
      if (!parentThreadId) throw new Error('Mock Thread not found');
      const finished = target.__LIN_E2E__?.createMockSubagentThread({ parentThreadId, name: 'finished worker' });
      (window as Window & { __LIN_E2E_FINISHED_ID__?: string }).__LIN_E2E_FINISHED_ID__ = finished?.id;
      const live = target.__LIN_E2E__?.createMockSubagentThread({
        parentThreadId,
        name: 'live worker',
        active: true,
      });
      target.__LIN_E2E__?.createMockSubagentThread({ parentThreadId, name: 'queued worker', queuedWork: true });
      // A child is read from the delegation row that spawned it, which is what
      // production records for every delegated form — so the Turn that
      // delegated has to carry one here too.
      const turnId = '01910000-0000-7000-8000-00000000f101';
      const itemId = '01910000-0000-7000-8000-00000000f102';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'subAgentActivity',
            provenance: { originThreadId: parentThreadId, originTurnId: turnId, originItemId: itemId },
            kind: 'started',
            agentThreadId: live!.id,
            agentPath: '/root/live_worker',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });

    // A live descendant is the only thing the list says about children now.
    await page.getByRole('button', { name: 'Show Threads' }).click();
    const list = page.getByRole('dialog', { name: 'Threads' });
    await expect(list.locator('.thread-list-row.is-selected .thread-list-activity')).toBeVisible();
    await expect(list.locator('.thread-list-row')).toHaveCount(2);
    await page.keyboard.press('Escape');

    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Thread Details' }).click();
    const details = page.getByRole('dialog', { name: 'Thread Details' });
    await expect(details.locator('.thread-details-subagent')).toHaveCount(3);
    await expect(details.getByRole('button', { name: 'Open live worker' })).toContainText('Running');
    await expect(details.getByRole('button', { name: 'Open finished worker' })).toContainText('Idle');
    // Idle is not finished: this child is holding work the parent handed over.
    await expect(details.getByRole('button', { name: 'Open queued worker' })).toContainText('Work queued');

    // The dialog does not subscribe to the store, so the decision is re-taken
    // against a fresh read on confirm: this child starts running in between.
    await details.getByRole('button', { name: 'Delete finished Subagents' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete finished Subagents' });
    await expect(confirm).toContainText('Delete 1 finished Subagent and its child Threads?');
    await page.evaluate(() => {
      const target = window as Window & {
        __LIN_E2E__?: { setMockThreadActive: (threadId: string, active: boolean) => void };
        __LIN_E2E_FINISHED_ID__?: string;
      };
      if (target.__LIN_E2E_FINISHED_ID__) {
        target.__LIN_E2E__?.setMockThreadActive(target.__LIN_E2E_FINISHED_ID__, true);
      }
    });
    await confirm.getByRole('button', { name: 'Delete Thread' }).click();
    // Nothing was deleted: every child was busy by the time it was confirmed.
    await expect(details.locator('.thread-details-subagent')).toHaveCount(3);
    await expect(details.getByRole('button', { name: 'Open finished worker' })).toContainText('Running');

    // Now let it settle and sweep for real.
    await page.evaluate(() => {
      const target = window as Window & {
        __LIN_E2E__?: { setMockThreadActive: (threadId: string, active: boolean) => void };
        __LIN_E2E_FINISHED_ID__?: string;
      };
      if (target.__LIN_E2E_FINISHED_ID__) {
        target.__LIN_E2E__?.setMockThreadActive(target.__LIN_E2E_FINISHED_ID__, false);
      }
    });
    await details.getByRole('button', { name: 'Delete finished Subagents' }).click();
    await page.getByRole('dialog', { name: 'Delete finished Subagents' })
      .getByRole('button', { name: 'Delete Thread' }).click();
    await expect(details.locator('.thread-details-subagent')).toHaveCount(2);
    await expect(details.getByRole('button', { name: 'Open finished worker' })).toHaveCount(0);
    await expect(details.getByRole('button', { name: 'Open live worker' })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Open queued worker' })).toBeVisible();

    // Details is a browse surface, so its rows land where the transcript rows
    // do — including opening the process fold the row sits inside, which a
    // settled Turn keeps shut. Expanding only the leaf would write a key
    // nothing reads, and nothing would appear on screen.
    await details.getByRole('button', { name: 'Open live worker' }).click();
    const detail = page.locator('.thread-subagent-detail');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.thread-subagent-detail-title')).toHaveText('live worker');
  });
  test('shows a live row for an isolated Skill child while its skill call is in flight', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-00000000df01';
      const skillItemId = '01910000-0000-7000-8000-00000000df02';
      const activityId = '01910000-0000-7000-8000-00000000df03';
      const childId = '01910000-0000-7000-8000-00000000df10';
      const childTurnId = '01910000-0000-7000-8000-00000000df11';
      const taskPath = '/root/skill_research_ab12cd34ef56';
      const startedAt = Date.now() - 5_000;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/started',
        threadId: childId,
        thread: {
          ...root,
          id: childId,
          parentThreadId,
          agentNickname: null,
          agentRole: 'explorer',
          name: null,
          // The distinguishing bit: a delegated child that is NOT collaboration.
          source: 'agent.skill',
          threadSource: 'subagent',
          status: { type: 'active', activeFlags: [] },
          updatedAt: startedAt,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: childId,
        turnId: childTurnId,
        turn: {
          id: childTurnId,
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: childId,
            originTurnId: childTurnId,
            trigger: { kind: 'subagent', parentThreadId, parentItemId: skillItemId },
          },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      const provenance = (itemId: string) => ({
        originThreadId: parentThreadId,
        originTurnId: parentTurnId,
        originItemId: itemId,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: {
          id: parentTurnId,
          items: [
            {
              id: activityId,
              type: 'subAgentActivity',
              provenance: provenance(activityId),
              kind: 'started',
              agentThreadId: childId,
              agentPath: taskPath,
              error: null,
              spawnItemId: null,
            },
            {
              id: skillItemId,
              type: 'dynamicToolCall',
              provenance: provenance(skillItemId),
              namespace: null,
              tool: 'skill',
              arguments: { name: 'research' },
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'skill' },
                providerName: 'skill',
                arguments: { storage: 'inline', value: { name: 'research' } },
                schemaDigest: '0'.repeat(64),
              },
              contentItems: null,
              status: 'inProgress',
              success: null,
              durationMs: null,
              outputRef: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { childId, parentTurnId, taskPath };
    });

    const parentTurn = page.locator(`[data-thread-turn-row="${fixture.parentTurnId}"]`);
    // One row per delegated child, live, in the delegating call's slot.
    const skillLine = parentTurn.locator('.thread-delegation-row');
    await expect(skillLine).toHaveCount(1);
    // The child record carries no name here, so this also covers the fallback:
    // the address alone still yields the Skill's name, never its suffix.
    await expect(skillLine.locator('.thread-delegation-row-name')).toHaveText('research');
    await expect(skillLine.locator('.thread-delegation-row-status')).toContainText(/Running · \d+[smhd]/u);
    const skillRow = skillLine.getByRole('button', { name: /Open Subagent Thread research/u });
    // No wait is in flight, so the divider must not claim to be waiting on it.
    await expect(parentTurn.locator('.thread-process-title')).toContainText(/Working for \d+[smhd]/u);

    await skillRow.click();
    const detail = page.locator('.thread-subagent-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);
  });


  test('keeps one live row per child, stops one from its row, and leaves the rest running', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-00000000fa01';
      const startedAt = Date.now() - 4_000;
      const children = [
        {
          id: '01910000-0000-7000-8000-00000000fa10',
          turnId: '01910000-0000-7000-8000-00000000fa11',
          activityId: '01910000-0000-7000-8000-00000000fa12',
          taskPath: '/root/research',
        },
        {
          id: '01910000-0000-7000-8000-00000000fa20',
          turnId: '01910000-0000-7000-8000-00000000fa21',
          activityId: '01910000-0000-7000-8000-00000000fa22',
          taskPath: '/root/audit',
        },
      ];
      for (const child of children) {
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'thread/started',
          threadId: child.id,
          thread: {
            ...root,
            id: child.id,
            parentThreadId,
            agentNickname: null,
            agentRole: 'worker',
            name: null,
            source: 'collaboration',
            threadSource: 'subagent',
            status: { type: 'active', activeFlags: [] },
            updatedAt: startedAt,
          },
        });
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/started',
          threadId: child.id,
          turnId: child.turnId,
          turn: {
            id: child.turnId,
            items: [],
            itemsView: 'full',
            provenance: {
              originThreadId: child.id,
              originTurnId: child.turnId,
              trigger: { kind: 'subagent', parentThreadId, parentItemId: child.activityId },
            },
            status: 'inProgress',
            error: null,
            startedAt,
            completedAt: null,
            durationMs: null,
          },
        });
      }
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: {
          id: parentTurnId,
          items: children.map((child) => ({
            id: child.activityId,
            type: 'subAgentActivity',
            provenance: {
              originThreadId: parentThreadId,
              originTurnId: parentTurnId,
              originItemId: child.activityId,
            },
            kind: 'started',
            agentThreadId: child.id,
            agentPath: child.taskPath,
            error: null,
            spawnItemId: null,
          })),
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { children, parentThreadId, parentTurnId };
    });

    // Live: one row per child, in the timeline, with no second presentation.
    const parentTurn = page.locator(`[data-thread-turn-row="${fixture.parentTurnId}"]`);
    const rows = parentTurn.locator('.thread-delegation-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.locator('.thread-delegation-row-status').first()).toContainText(/Running · \d+[smhd]/u);

    // Stop one child from its row; the other keeps running.
    await parentTurn.getByRole('button', { name: 'Stop research' }).click();
    await expect(parentTurn.locator('.thread-delegation-row.thread-subagent-interrupted')).toHaveCount(1);
    await expect(parentTurn.getByRole('button', { name: 'Stop audit' })).toBeVisible();
    await expect(parentTurn.getByRole('button', { name: 'Stop research' })).toHaveCount(0);

    // The last child settles in place: same rows, same slots, new status.
    await page.evaluate((child) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: child.id,
        turnId: child.turnId,
        turn: {
          id: child.turnId,
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: child.id,
            originTurnId: child.turnId,
            trigger: { kind: 'subagent', parentThreadId: child.parentThreadId, parentItemId: child.activityId },
          },
          status: 'completed',
          error: null,
          startedAt: Date.now() - 2_000,
          completedAt: Date.now(),
          durationMs: 2_000,
        },
      });
    }, { ...fixture.children[1]!, parentThreadId: fixture.parentThreadId });

    await expect(rows).toHaveCount(2);
    await expect(parentTurn.locator('.thread-delegation-row.thread-subagent-completed')).toHaveCount(1);
    await expect(parentTurn.getByRole('button', { name: /^Stop / })).toHaveCount(0);
  });

  test('never folds a settled Turn over a child that is still running', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-00000000fc01';
      const activityId = '01910000-0000-7000-8000-00000000fc03';
      const answerId = '01910000-0000-7000-8000-00000000fc04';
      const childId = '01910000-0000-7000-8000-00000000fc10';
      const childTurnId = '01910000-0000-7000-8000-00000000fc11';
      const startedAt = Date.now() - 6_000;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/started',
        threadId: childId,
        thread: {
          ...root,
          id: childId,
          parentThreadId,
          agentNickname: null,
          agentRole: 'worker',
          name: 'research',
          source: 'collaboration',
          threadSource: 'subagent',
          status: { type: 'active', activeFlags: [] },
          updatedAt: startedAt,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: childId,
        turnId: childTurnId,
        turn: {
          id: childTurnId,
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: childId,
            originTurnId: childTurnId,
            trigger: { kind: 'subagent', parentThreadId, parentItemId: activityId },
          },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      const provenance = (itemId: string) => ({
        originThreadId: parentThreadId,
        originTurnId: parentTurnId,
        originItemId: itemId,
      });
      const parentItems = [
            {
              id: activityId,
              type: 'subAgentActivity',
              provenance: provenance(activityId),
              kind: 'started',
              agentThreadId: childId,
              agentPath: '/root/research',
              error: null,
              // This test's subject is the fold, not the stand-in: the call that
              // delegated is out of scope here and covered elsewhere.
              spawnItemId: null,
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: provenance(answerId),
              phase: 'final',
              text: 'Delegated and answered.',
            },
      ];
      const parentTurn = (status: string, settled: boolean) => ({
        id: parentTurnId,
        items: parentItems,
        itemsView: 'full',
        provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
        status,
        error: null,
        startedAt,
        completedAt: settled ? Date.now() : null,
        durationMs: settled ? 6_000 : null,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: parentTurn('inProgress', false),
      });
      // The parent answers and settles while its child keeps working — the
      // fire-and-forget shape whose terminal activity lands in a LATER Turn.
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: parentTurn('completed', true),
      });
      return { activityId, childId, childTurnId, parentThreadId, parentTurnId };
    });

    // The fold defaults to closed, so folding here would hide the only signal
    // that a subagent is still burning time and the only Stop that reaches it.
    const parentTurn = page.locator(`[data-thread-turn-row="${fixture.parentTurnId}"]`);
    const row = parentTurn.locator('.thread-delegation-row');
    await expect(row).toBeVisible();
    await expect(row.locator('.thread-delegation-row-status')).toContainText(/Running/u);
    await expect(parentTurn.getByRole('button', { name: 'Stop research' })).toBeVisible();
    await expect(parentTurn.locator('.thread-process-toggle')).toHaveCount(0);

    // Once it settles the Turn is ordinary history again, and folds.
    await page.evaluate((child) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: child.childId,
        turnId: child.childTurnId,
        turn: {
          id: child.childTurnId,
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: child.childId,
            originTurnId: child.childTurnId,
            trigger: { kind: 'subagent', parentThreadId: child.parentThreadId, parentItemId: child.activityId },
          },
          status: 'completed',
          error: null,
          startedAt: Date.now() - 192_000,
          completedAt: Date.now(),
          durationMs: 192_000,
        },
      });
    }, fixture);

    // Ordinary history now: the Turn folds, and the row is behind the fold with
    // the settled span its own Turn recorded rather than a clock it no longer has.
    await expect(parentTurn.locator('.thread-process-toggle')).toHaveCount(1);
    await expect(row).toHaveCount(0);
    await parentTurn.locator('.thread-process-toggle').click();
    await expect(row.locator('.thread-delegation-row-status')).toHaveText('Completed · 3m 12s');
  });

  test('sends the composer Stop against the delegating Turn that owns the request', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const root = response?.data[0];
      if (!root) throw new Error('Mock root Thread not found');
      const parentThreadId = String(root.id);
      const parentTurnId = '01910000-0000-7000-8000-00000000fb01';
      const childId = '01910000-0000-7000-8000-00000000fb10';
      const activityId = '01910000-0000-7000-8000-00000000fb12';
      const startedAt = Date.now() - 3_000;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/started',
        threadId: childId,
        thread: {
          ...root,
          id: childId,
          parentThreadId,
          agentNickname: null,
          agentRole: 'worker',
          name: null,
          source: 'collaboration',
          threadSource: 'subagent',
          status: { type: 'active', activeFlags: [] },
          updatedAt: startedAt,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: childId,
        turnId: '01910000-0000-7000-8000-00000000fb11',
        turn: {
          id: '01910000-0000-7000-8000-00000000fb11',
          items: [],
          itemsView: 'full',
          provenance: {
            originThreadId: childId,
            originTurnId: '01910000-0000-7000-8000-00000000fb11',
            trigger: { kind: 'subagent', parentThreadId, parentItemId: activityId },
          },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId: parentThreadId,
        turnId: parentTurnId,
        turn: {
          id: parentTurnId,
          items: [{
            id: activityId,
            type: 'subAgentActivity',
            provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, originItemId: activityId },
            kind: 'started',
            agentThreadId: childId,
            agentPath: '/root/research',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt,
          completedAt: null,
          durationMs: null,
        },
      });
      return { parentThreadId, parentTurnId };
    });

    await expect(page.locator('.thread-delegation-row')).toBeVisible();
    await page.getByRole('button', { name: 'Interrupt Turn' }).click();

    // The host closes the request from this pair; the renderer's job is to
    // address the delegating Turn that owns it, not to enumerate children.
    const interrupts = (await commandCalls(page)).filter((call) => call.cmd === 'turn/interrupt');
    expect(interrupts.map((call) => call.args)).toEqual([
      { threadId: fixture.parentThreadId, turnId: fixture.parentTurnId },
    ]);
  });
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`projects live Subagent status and wait progress into the parent Turn in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await createNewThread(page);
      const fixture = await page.evaluate(async () => {
        const target = window as Window & {
          lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
          __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
        };
        const response = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
        const root = response?.data[0];
        if (!root) throw new Error('Mock root Thread not found');
        const parentThreadId = String(root.id);
        const parentTurnId = '01910000-0000-7000-8000-00000000de01';
        const waitItemId = '01910000-0000-7000-8000-00000000de02';
        const startedAt = Date.now() - 6_000;
        const children = [
          {
            id: '01910000-0000-7000-8000-00000000de10',
            turnId: '01910000-0000-7000-8000-00000000de11',
            activityId: '01910000-0000-7000-8000-00000000de12',
            taskPath: '/root/research',
            nickname: 'Researcher',
          },
          {
            id: '01910000-0000-7000-8000-00000000de20',
            turnId: '01910000-0000-7000-8000-00000000de21',
            activityId: '01910000-0000-7000-8000-00000000de22',
            taskPath: '/root/audit',
            nickname: 'Auditor',
          },
        ];
        for (const child of children) {
          const thread = {
            ...root,
            id: child.id,
            parentThreadId,
            agentNickname: child.nickname,
            agentRole: 'worker',
            name: null,
            source: 'collaboration',
            threadSource: 'subagent',
            status: { type: 'active', activeFlags: [] },
            updatedAt: startedAt,
          };
          target.__LIN_E2E__?.emitAgentCoreNotification({
            type: 'thread/started',
            threadId: child.id,
            thread,
          });
          target.__LIN_E2E__?.emitAgentCoreNotification({
            type: 'turn/started',
            threadId: child.id,
            turnId: child.turnId,
            turn: {
              id: child.turnId,
              items: [],
              itemsView: 'full',
              provenance: {
                originThreadId: child.id,
                originTurnId: child.turnId,
                trigger: {
                  kind: 'subagent',
                  parentThreadId,
                  parentItemId: waitItemId,
                },
              },
              status: 'inProgress',
              error: null,
              startedAt,
              completedAt: null,
              durationMs: null,
            },
          });
        }
        const provenance = (itemId: string) => ({
          originThreadId: parentThreadId,
          originTurnId: parentTurnId,
          originItemId: itemId,
        });
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/started',
          threadId: parentThreadId,
          turnId: parentTurnId,
          turn: {
            id: parentTurnId,
            items: [
              ...children.map((child) => ({
                id: child.activityId,
                type: 'subAgentActivity',
                provenance: provenance(child.activityId),
                kind: 'started',
                agentThreadId: child.id,
                agentPath: child.taskPath,
                error: null,
                spawnItemId: null,
              })),
              {
                id: waitItemId,
                type: 'collabAgentToolCall',
                provenance: provenance(waitItemId),
                tool: 'wait_agent',
                modelCall: {
                  disposition: 'replayable',
                  identity: { namespace: null, name: 'wait_agent' },
                  providerName: 'wait_agent',
                  arguments: { storage: 'inline', value: {} },
                  schemaDigest: '0'.repeat(64),
                },
                status: 'inProgress',
                outputRef: null,
                senderThreadId: parentThreadId,
                receiverThreadIds: [],
                prompt: null,
                model: null,
                reasoningEffort: null,
                agentsStates: {},
              },
            ],
            itemsView: 'full',
            provenance: { originThreadId: parentThreadId, originTurnId: parentTurnId, trigger: { kind: 'user' } },
            status: 'inProgress',
            error: null,
            startedAt,
            completedAt: null,
            durationMs: null,
          },
        });
        return { children, parentThreadId, parentTurnId, startedAt };
      });

      const parentTurn = page.locator(`[data-thread-turn-row="${fixture.parentTurnId}"]`);
      await expect(parentTurn.locator('.thread-process-title'))
        .toContainText(/Waiting on 2 subagents · \d+[smhd]/u);
      const rows = parentTurn.locator('.thread-delegation-row');
      await expect(rows).toHaveCount(2);
      await expect(rows.locator('.thread-delegation-row-status').first())
        .toContainText(/Running · \d+[smhd]/u);
      // Every colour comes from the ink tokens, so the row follows the scheme
      // instead of carrying a hardcoded value that only works in light. The row
      // also has to share the tool rows' type ramp: it is one more thing the
      // Turn did, and rendering it at content size made it the loudest line in
      // a timeline of quiet ones.
      const rowPaint = await rows.first().evaluate((element) => {
        const root = getComputedStyle(document.documentElement);
        const probe = document.createElement('span');
        document.body.append(probe);
        const resolve = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const sibling = element.closest('.thread-process-timeline')?.querySelector('.thread-tool-toggle');
        const status = element.querySelector('.thread-delegation-row-status');
        const paint = {
          fontSize: getComputedStyle(element).fontSize,
          ink: root.getPropertyValue('--ink').trim(),
          siblingFontSize: sibling ? getComputedStyle(sibling).fontSize : '',
          status: status ? getComputedStyle(status).color : '',
          text: getComputedStyle(element).color,
          textSoft: resolve('--text-soft'),
          textTertiary: resolve('--text-tertiary'),
        };
        probe.remove();
        return paint;
      });
      // The assertion is that the row follows the ink tokens, not what those
      // tokens currently are: pinning the literals here would fail an E2E in
      // this file for a change made in `tokens.css`.
      expect(rowPaint.text).toBe(rowPaint.textSoft);
      expect(rowPaint.status).toBe(rowPaint.textTertiary);
      expect(rowPaint.fontSize).toBe(rowPaint.siblingFontSize);
      expect(rowPaint.ink).toBe(colorScheme === 'dark' ? '255 255 255' : '0 0 0');
      const auditRow = parentTurn.locator('.thread-delegation-row', { hasText: 'audit' });

      await page.evaluate(({ child, parentThreadId, startedAt }) => {
        const target = window as Window & {
          __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
        };
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId: child.id,
          turnId: child.turnId,
          turn: {
            id: child.turnId,
            items: [],
            itemsView: 'full',
            provenance: {
              originThreadId: child.id,
              originTurnId: child.turnId,
              trigger: { kind: 'subagent', parentThreadId, parentItemId: '01910000-0000-7000-8000-00000000de02' },
            },
            status: 'completed',
            error: null,
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          },
        });
      }, { child: fixture.children[0]!, parentThreadId: fixture.parentThreadId, startedAt: fixture.startedAt });

      await expect(parentTurn.locator('.thread-process-title'))
        .toContainText(/Waiting on 1 subagent ·/u);
      await expect(parentTurn.locator('.thread-delegation-row.thread-subagent-completed')).toHaveCount(1);

      await page.evaluate(({ child, parentThreadId, startedAt }) => {
        const target = window as Window & {
          __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
        };
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId: child.id,
          turnId: child.turnId,
          turn: {
            id: child.turnId,
            items: [],
            itemsView: 'full',
            provenance: {
              originThreadId: child.id,
              originTurnId: child.turnId,
              trigger: { kind: 'subagent', parentThreadId, parentItemId: '01910000-0000-7000-8000-00000000de02' },
            },
            status: 'failed',
            error: {
              message: 'Token budget exhausted (9876 of 9000 tokens)',
              code: 'subagent_budget_exhausted',
            },
            startedAt,
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
          },
        });
      }, { child: fixture.children[1]!, parentThreadId: fixture.parentThreadId, startedAt: fixture.startedAt });

      // A settled row states its own Turn's span, failures included.
      await expect(auditRow.locator('.thread-delegation-row-status'))
        .toHaveText(/^Failed · \d+[smhd]/u);
      await expect(auditRow).toContainText('Task reached the system resource limit. Results have been preserved.');
      await expect(auditRow).not.toContainText('9876');
      await expect(auditRow).not.toContainText('9000');
      await expect(auditRow.locator('.thread-delegation-row-error')).toHaveCSS('white-space', 'normal');
      expect(await auditRow.locator('.thread-delegation-row-error').evaluate((element) => (
        element.scrollWidth <= element.clientWidth
      ))).toBe(true);
      // The status colour survives hover: pointing at a failed delegation must
      // not repaint it neutral, which is what a hover rule that did not exempt
      // the status states would do. Polled because the row shares the tool
      // rows' colour transition, so a single read can land mid-interpolation.
      await auditRow.locator('.thread-delegation-row-open').hover();
      await expect.poll(async () => auditRow.locator('.thread-delegation-row-name').evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--status-danger)';
        document.body.append(probe);
        const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
        probe.remove();
        return matches;
      })).toBe(true);
    });
  }

  test('renders reasoning and grouped tool Items with disclosure and copy interactions', async ({ page }) => {
    await createNewThread(page);
    await seedOverflowingTranscript(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000aa01';
      const item = (suffix: string) => `01910000-0000-7000-8000-00000000${suffix}`;
      const provenance = (itemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: itemId });
      const reasoningId = item('aa02');
      const commandId = item('aa03');
      const toolId = item('aa04');
      const summaryOnlyReasoningId = item('aa05');
      const answerId = item('aa06');
      const turn = {
        id: turnId,
        items: [
          {
            id: reasoningId,
            type: 'reasoning',
            provenance: provenance(reasoningId),
            summary: ['Inspect the current workspace'],
            content: ['The workspace has enough evidence.'],
          },
          {
            id: commandId,
            type: 'commandExecution',
            provenance: provenance(commandId),
            command: 'pwd',
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'bash' },
              providerName: 'bash',
              arguments: { storage: 'inline', value: { command: 'pwd' } },
              schemaDigest: '0'.repeat(64),
            },
            cwd: '/mock/workspace',
            processId: null,
            status: 'completed',
            commandActions: [],
            aggregatedOutput: '/mock/workspace',
            exitCode: 0,
            durationMs: 4,
          },
          {
            id: toolId,
            type: 'dynamicToolCall',
            provenance: provenance(toolId),
            namespace: 'node',
            tool: 'read',
            arguments: { node_id: 'node-alpha', file_path: 'notes with spaces.md' },
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: 'node', name: 'read' },
              providerName: 'node__read',
              arguments: {
                storage: 'inline',
                value: { node_id: 'node-alpha', file_path: 'notes with spaces.md' },
              },
              schemaDigest: '0'.repeat(64),
            },
            status: 'completed',
            contentItems: [{ type: 'json', value: { title: 'Alpha' } }],
            success: true,
            durationMs: 8,
          },
          {
            id: summaryOnlyReasoningId,
            type: 'reasoning',
            provenance: provenance(summaryOnlyReasoningId),
            summary: [],
            content: ['Preparing the final response'],
          },
          {
            id: answerId,
            type: 'agentMessage',
            provenance: provenance(answerId),
            text: 'Finished with evidence.',
            phase: 'final_answer',
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 13,
        durationMs: 12,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn,
      });
    });

    const process = page.getByRole('button', { name: 'Worked for <1s' });
    await expect(process).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(process);
    await expect(process).toHaveAttribute('aria-expanded', 'true');
    await toggleDisclosureWithStableAnchor(process);
    await expect(process).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(process);
    await expect(process).toHaveAttribute('aria-expanded', 'true');

    const thought = page.locator('.thread-reasoning-toggle').first();
    await expect(thought).toBeVisible();
    await expect(thought).toHaveAccessibleName('Inspect the current workspace');
    await expect(thought.locator('.thread-reasoning-summary')).toHaveCSS('font-weight', '400');
    await expect(thought).toHaveAttribute('aria-expanded', 'false');
    const thoughtChevron = thought.locator('.thread-reasoning-chevron');
    await expect(thoughtChevron).toHaveCSS('opacity', '0');
    const activity = page.getByRole('button', { name: /^Ran a command · read / });
    const [thoughtBox, activityBox] = await Promise.all([thought.boundingBox(), activity.boundingBox()]);
    expect(thoughtBox).toBeTruthy();
    expect(activityBox).toBeTruthy();
    expect(Math.abs(thoughtBox!.x - activityBox!.x)).toBeLessThan(1);
    await thought.hover();
    await expect(thoughtChevron).toHaveCSS('opacity', '1');
    expect(await thought.boundingBox()).toEqual(thoughtBox);
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(thought);
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(thoughtChevron).toHaveCSS('opacity', '1');
    const reasoningBody = page.locator('.thread-reasoning-body');
    await expect(reasoningBody).toContainText('The workspace has enough evidence.');
    await expect(reasoningBody).not.toContainText('Inspect the current workspace');
    await expect(reasoningBody.locator('p')).toHaveCount(1);
    const [thoughtHeadlineBox, reasoningBodyBox] = await Promise.all([
      thought.locator('.thread-reasoning-summary').boundingBox(),
      reasoningBody.boundingBox(),
    ]);
    expect(thoughtHeadlineBox).toBeTruthy();
    expect(reasoningBodyBox).toBeTruthy();
    expect(Math.abs(thoughtHeadlineBox!.x - reasoningBodyBox!.x)).toBeLessThan(1);
    await toggleDisclosureWithStableAnchor(thought);
    await expect(thought).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(thought);
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    const singleLineThought = page.locator('.thread-reasoning-summary', {
      hasText: 'Preparing the final response',
    });
    await expect(singleLineThought).toHaveCount(1);
    expect(await singleLineThought.evaluate((element) => element.parentElement?.tagName)).toBe('DIV');
    await expect(singleLineThought.locator('xpath=..').locator('.thread-reasoning-chevron')).toHaveCount(0);
    await expect(page.getByText('Thought', { exact: true })).toHaveCount(0);

    const activityStatus = activity.locator('.thread-disclosure-status');
    const activityChevron = activity.locator('.thread-disclosure-chevron');
    await expect(activityStatus).toHaveCSS('opacity', '1');
    await expect(activityChevron).toHaveCSS('opacity', '0');
    await activity.hover();
    await expect(activityStatus).toHaveCSS('opacity', '0');
    await expect(activityChevron).toHaveCSS('opacity', '1');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(activity);
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    await toggleDisclosureWithStableAnchor(activity);
    await expect(activity).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(activity);
    await expect(activity).toHaveAttribute('aria-expanded', 'true');
    const command = page.getByRole('button', { name: /Ran.*pwd/ });
    await expect(command).toBeVisible();
    const commandAlignment = await command.evaluate((element) => {
      const icon = element.querySelector<HTMLElement>('.thread-disclosure-status svg');
      const label = element.querySelector<HTMLElement>('.thread-tool-label');
      if (!icon || !label) return null;
      const iconBox = icon.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
      return Math.abs((iconBox.top + iconBox.height / 2) - (labelBox.top + lineHeight / 2));
    });
    expect(commandAlignment).not.toBeNull();
    expect(commandAlignment!).toBeLessThan(1);
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(command);
    await expect(command.locator('xpath=..')).not.toContainText('exit 0');
    await expect(command.locator('xpath=..').getByRole('button', { name: 'Copy output' })).toHaveCount(1);
    await toggleDisclosureWithStableAnchor(command);
    await expect(command).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    await toggleDisclosureWithStableAnchor(command);
    await expect(command).toHaveAttribute('aria-expanded', 'true');
    await command.locator('xpath=..').locator('.thread-tool-section').last().locator('.agent-code-block').hover();
    await page.getByRole('button', { name: 'Copy output' }).click();
    expect(await clipboardText(page)).toBe('/mock/workspace');

    const commandPaths = command.locator('xpath=..').locator('.thread-tool-path-reference');
    await expect(commandPaths).toHaveCount(1);
    await expect(commandPaths).toHaveAttribute('data-tool-path', '/mock/workspace');
    const nodeTool = page.getByRole('button', { name: /^Read / });
    await nodeTool.click();
    const relativePath = nodeTool.locator('xpath=..').locator('.thread-tool-path-reference');
    await expect(relativePath).toHaveAttribute('data-tool-path', '/mock/workspace/notes with spaces.md');
    await expect(relativePath).toHaveAttribute('data-inline-ref-kind', 'local-file');
    await expect(relativePath).toHaveAttribute('data-inline-ref-path', '/mock/workspace/notes with spaces.md');
    await expect(relativePath).toHaveAttribute('data-inline-ref-entry-kind', 'file');
    await expect(relativePath).toHaveAttribute('title', 'notes with spaces.md');
    await expect(relativePath).not.toHaveAttribute('aria-label', /.+/);
    await expect(relativePath).not.toHaveClass(/inline-ref/);
    await expect(relativePath.locator('.inline-ref-file-icon')).toHaveCount(0);
    await expect(relativePath).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(relativePath).toHaveCSS('cursor', 'auto');
    await expect(relativePath).toHaveCSS('white-space', 'pre');

    const panels = page.locator('.outline-panel-surface');
    const panelCount = await panels.count();
    await relativePath.click();
    await expect(panels).toHaveCount(panelCount);
    await expect(page.locator('.outline-panel-surface.is-file-preview')).toHaveCount(0);

    await relativePath.focus();
    await page.keyboard.press('Enter');
    await expect(panels).toHaveCount(panelCount);
    await expect(page.locator('.outline-panel-surface.active-panel.is-file-preview'))
      .toContainText('Mock preview text.');

    await relativePath.hover();
    await page.keyboard.down('Meta');
    await expect(page.locator('html')).toHaveClass(/is-primary-modifier-pressed/);
    await expect(relativePath).toHaveCSS('cursor', 'pointer');
    await expect(relativePath).toHaveCSS('text-decoration-line', 'underline');
    await page.keyboard.up('Meta');
    await expect(page.locator('html')).not.toHaveClass(/is-primary-modifier-pressed/);
    await expect(relativePath).toHaveCSS('cursor', 'auto');

    await relativePath.click({ modifiers: ['Meta'] });
    await expect(panels).toHaveCount(panelCount + 1);
    await expect(page.locator('.outline-panel-surface.active-panel.is-file-preview'))
      .toContainText('Mock preview text.');

    await page.locator('[data-thread-turn-row="01910000-0000-7000-8000-00000000aa01"]')
      .getByRole('button', { name: 'Copy message' })
      .click();
    expect(await clipboardText(page)).toBe([
      '```tool bash',
      JSON.stringify({ command: 'pwd' }, null, 2),
      '```',
      '',
      '```tool-result',
      '/mock/workspace',
      '```',
      '',
      '```tool node.read',
      JSON.stringify({ node_id: 'node-alpha', file_path: 'notes with spaces.md' }, null, 2),
      '```',
      '',
      '```tool-result',
      JSON.stringify({ title: 'Alpha' }, null, 2),
      '```',
      '',
      'Finished with evidence.',
    ].join('\n'));

    const disclosureOverrides = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((candidate) => (
        candidate.startsWith('tenon:thread-disclosure:v1:')
      ));
      return key ? JSON.parse(window.localStorage.getItem(key) ?? '{}') : {};
    });
    expect(disclosureOverrides).toMatchObject({
      'process:01910000-0000-7000-8000-00000000aa01': true,
      'reasoning:01910000-0000-7000-8000-00000000aa02': true,
      'tool:01910000-0000-7000-8000-00000000aa03': true,
      'tools:01910000-0000-7000-8000-00000000aa03': true,
    });
  });

  test('groups tools across empty commentary and spaces a truncated reasoning line', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000af01';
      const itemId = (suffix: string) => `01910000-0000-7000-8000-00000000${suffix}`;
      const provenance = (originItemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId });
      const webSearch = (id: string, query: string) => ({
        id,
        type: 'webSearch',
        provenance: provenance(id),
        query,
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'web_search' },
          providerName: 'web_search',
          arguments: { storage: 'inline', value: { query } },
          schemaDigest: '0'.repeat(64),
        },
        results: [{ title: 'Forecast', url: 'https://example.com/weather', snippet: 'Rain' }],
        status: 'completed',
        error: null,
      });
      const webFetch = (id: string, url: string) => ({
        id,
        type: 'dynamicToolCall',
        provenance: provenance(id),
        namespace: null,
        tool: 'web_fetch',
        arguments: { url },
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'web_fetch' },
          providerName: 'web_fetch',
          arguments: { storage: 'inline', value: { url } },
          schemaDigest: '0'.repeat(64),
        },
        status: 'completed',
        outputRef: null,
        contentItems: [{ type: 'text', text: 'Forecast loaded' }],
        success: true,
        durationMs: 4,
      });
      const emptyCommentary = (id: string) => ({
        id,
        type: 'agentMessage',
        provenance: provenance(id),
        text: '',
        phase: 'commentary',
        memoryCitation: null,
      });
      const reasoningId = itemId('af06');
      const answerId = itemId('af10');
      const reasoningText = [
        'Planning an additional official NMC search with enough detail to exceed the compact timeline width',
        'while preserving the complete reasoning text when the disclosure is opened',
      ].join(' ');
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            webSearch(itemId('af02'), 'Chengdu weather August 5'),
            emptyCommentary(itemId('af03')),
            webFetch(itemId('af04'), 'https://weather.example.com/chengdu'),
            {
              id: reasoningId,
              type: 'reasoning',
              provenance: provenance(reasoningId),
              summary: [reasoningText],
              content: [],
            },
            webSearch(itemId('af07'), 'Chengdu NMC forecast'),
            emptyCommentary(itemId('af08')),
            webFetch(itemId('af09'), 'https://www.nmc.cn/chengdu'),
            {
              id: answerId,
              type: 'agentMessage',
              provenance: provenance(answerId),
              text: 'Rain is expected today.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 36_001,
          durationMs: 36_000,
        },
      });
      return { reasoningText, turnId };
    });

    const turn = page.locator(`[data-thread-turn-row="${fixture.turnId}"]`);
    await turn.getByRole('button', { name: 'Worked for 36s' }).click();
    const summary = turn.locator('.thread-reasoning-summary', {
      hasText: fixture.reasoningText,
    });
    await expect(summary).toHaveCount(1);
    await expect(turn.locator('.thread-tool-activity-toggle')).toHaveCount(2);
    await expect(turn.locator('.thread-tool-toggle')).toHaveCount(0);
    await expect(turn.locator('.thread-agent-message-commentary')).toHaveCount(0);
    await expect(turn.getByText('Thought', { exact: true })).toHaveCount(0);

    const rhythm = await summary.evaluate((element) => {
      const reasoning = element.closest<HTMLElement>('.thread-reasoning');
      const timeline = reasoning?.parentElement;
      const previousTool = reasoning?.previousElementSibling
        ?.querySelector<HTMLElement>('.thread-tool-activity-toggle');
      const nextTool = reasoning?.nextElementSibling
        ?.querySelector<HTMLElement>('.thread-tool-activity-toggle');
      if (!reasoning || !timeline || !previousTool || !nextTool) {
        throw new Error('Missing split web timeline rhythm elements');
      }
      const expected = Number.parseFloat(getComputedStyle(timeline).rowGap);
      const previousRect = previousTool.getBoundingClientRect();
      const reasoningRect = reasoning.getBoundingClientRect();
      const nextRect = nextTool.getBoundingClientRect();
      return {
        above: reasoningRect.top - previousRect.bottom,
        below: nextRect.top - reasoningRect.bottom,
        expected,
      };
    });
    expect(rhythm.expected).toBeGreaterThan(0);
    expect(Math.abs(rhythm.above - rhythm.expected)).toBeLessThan(1);
    expect(Math.abs(rhythm.below - rhythm.expected)).toBeLessThan(1);
    expect(Math.abs(rhythm.above - rhythm.below)).toBeLessThan(1);

    const reasoningToggle = summary.locator('xpath=..');
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'false');
    expect(await summary.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(true);
    await reasoningToggle.click();
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'true');
    const expandedMetrics = await summary.evaluate((element) => ({
      fits: element.scrollWidth <= element.clientWidth + 1,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      height: element.getBoundingClientRect().height,
      text: element.textContent,
    }));
    expect(expandedMetrics).toEqual(expect.objectContaining({
      fits: true,
      text: fixture.reasoningText,
    }));
    expect(expandedMetrics.height).toBeGreaterThan(expandedMetrics.lineHeight + 1);
    await expect(turn.locator('.thread-reasoning-body')).toHaveCount(0);
  });

  test('explains only non-zero shell exit codes', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000af01';
      const commandId = '01910000-0000-7000-8000-00000000af02';
      const answerId = '01910000-0000-7000-8000-00000000af03';
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: commandId,
              type: 'commandExecution',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: commandId },
              command: 'false',
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'bash' },
                providerName: 'bash',
                arguments: { storage: 'inline', value: { command: 'false' } },
                schemaDigest: '0'.repeat(64),
              },
              cwd: '/mock/workspace',
              processId: null,
              status: 'failed',
              commandActions: [],
              aggregatedOutput: 'permission denied',
              exitCode: 2,
              durationMs: 4,
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: answerId },
              text: 'The command failed.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 5,
          durationMs: 4,
        },
      });
    });

    await page.getByRole('button', { name: 'Worked for <1s' }).click();
    const commandDetails = page.locator('.thread-tool').filter({ hasText: 'false' });
    const command = commandDetails.locator('.thread-tool-toggle');
    await command.click();
    const sections = commandDetails.locator('.thread-tool-section');
    await expect(sections.locator('header')).toHaveText(['Arguments', 'Output · Exit code 2']);
    const failedHeader = sections.filter({ has: page.locator('header', { hasText: 'Exit code 2' }) });
    await expect(failedHeader.locator('header')).toHaveCSS(
      'color',
      await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--status-danger)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      }),
    );
    // The failure is stated where it adds something and nowhere else: the folded
    // row already carries `failed`, so the detail owes no sentence of its own.
    await expect(commandDetails.locator('.thread-inline-error')).toHaveCount(0);
    await expect(commandDetails).not.toContainText('Command failed');
  });

  test('never claims a settled Turn is still working, and states the wait as a wait', async ({ page }) => {
    await createNewThread(page);
    const ids = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c001';
      const toolId = '01910000-0000-7000-8000-00000000c002';
      // A settled Turn with tool work and no final response: the divider used to
      // fall through to the live "Working" label.
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: toolId,
            type: 'dynamicToolCall',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
            namespace: null,
            tool: 'file_read',
            arguments: { file_path: '/mock/workspace/notes.md' },
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'file_read' },
              providerName: 'file_read',
              arguments: { storage: 'inline', value: { file_path: '/mock/workspace/notes.md' } },
              schemaDigest: '0'.repeat(64),
            },
            status: 'completed',
            outputRef: null,
            contentItems: null,
            success: true,
            durationMs: 3,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 5,
          durationMs: 4,
        },
      });
      return { threadId };
    });

    const divider = page.locator('.thread-process-title').first();
    await expect(divider).toHaveText('Read notes.md');
    await expect(page.locator('.thread-process-block')).not.toContainText('Working');

    // Blocked on the user: the label says so, and the spinner stops claiming work.
    await page.evaluate(async ({ threadId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const liveTurnId = '01910000-0000-7000-8000-00000000c003';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'thread/status/changed',
        threadId,
        status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
      });
    }, ids);

    const live = page.locator('.thread-process-block').last();
    await expect(live.locator('.thread-process-title')).toHaveText('Waiting for input');
    await expect(live.locator('.thread-process-spinner')).toHaveCount(0);
  });

  test('states an interrupted Turn once, and never leaves an unlabelled timeline', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const emit = (suffix: string, hasResponse: boolean) => {
        const turnId = `01910000-0000-7000-8000-00000000c1${suffix}`;
        const toolId = `01910000-0000-7000-8000-00000000c2${suffix}`;
        const answerId = `01910000-0000-7000-8000-00000000c3${suffix}`;
        const items: unknown[] = [{
          id: toolId,
          type: 'commandExecution',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
          command: 'sleep 30',
          modelCall: {
            disposition: 'replayable',
            identity: { namespace: null, name: 'bash' },
            providerName: 'bash',
            arguments: { storage: 'inline', value: { command: 'sleep 30' } },
            schemaDigest: '0'.repeat(64),
          },
          description: null,
          cwd: '/mock/workspace',
          processId: null,
          status: 'interrupted',
          outputRef: null,
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: 2,
        }];
        if (hasResponse) {
          items.push({
            id: answerId,
            type: 'agentMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: answerId },
            text: 'Partial answer.',
            phase: 'final_answer',
            memoryCitation: null,
          });
        }
        target.__LIN_E2E__?.emitAgentCoreNotification({
          type: 'turn/completed',
          threadId,
          turnId,
          turn: {
            id: turnId,
            items,
            itemsView: 'full',
            provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
            status: 'interrupted',
            error: null,
            startedAt: 1,
            completedAt: 5,
            durationMs: 4,
          },
        });
      };
      emit('01', false);
      emit('02', true);
    });

    const blocks = page.locator('.thread-process-block');
    await expect(blocks).toHaveCount(2);

    // No response: exactly one "Turn interrupted", owned by the divider.
    const noResponse = blocks.first();
    await expect(noResponse.getByText('Turn interrupted')).toHaveCount(1);

    // With a response the tail owns the status, but the timeline still needs a
    // name — it used to render as an unlabelled list of rows.
    const withResponse = blocks.last();
    await expect(withResponse.locator('.thread-process-timeline')).toHaveCount(1);
    // A neutral, status-free name for the timeline: the duration when known,
    // never a status claim and never the live "Working" label.
    const header = withResponse.locator('.thread-process-title');
    await expect(header).toHaveCount(1);
    await expect(header).toHaveText('Worked for <1s');
    // Exactly one owner per Turn: the divider for the Turn without a response,
    // the response tail for the Turn with one — two in total, never three.
    await expect(page.getByText('Turn interrupted')).toHaveCount(2);
  });

  test('states an interrupted Turn that produced nothing at all', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c401';
      const userId = '01910000-0000-7000-8000-00000000c402';
      // Interrupted before any process Item existed: no tool call, no
      // reasoning, no response. `groupTurnContent` renders no process block at
      // all here, so there is no divider to own the status.
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: userId,
            type: 'userMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: userId },
            clientId: null,
            content: [{ type: 'text', text: 'Stop right away.' }],
            acceptedAt: 1,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'interrupted',
          error: null,
          startedAt: 1,
          completedAt: 5,
          durationMs: 4,
        },
      });
    });

    await expect(page.locator('.thread-process-block')).toHaveCount(0);
    // The status must still be stated — by the response tail, since nothing
    // else can.
    await expect(page.getByText('Turn interrupted')).toHaveCount(1);
  });

  test('keeps an explicitly opened live reasoning disclosure open when a newer Item lands', async ({ page }) => {
    await createNewThread(page);
    const ids = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c501';
      const reasoningId = '01910000-0000-7000-8000-00000000c502';
      const toolId = '01910000-0000-7000-8000-00000000c503';
      const reasoning = {
        id: reasoningId,
        type: 'reasoning',
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: reasoningId },
        summary: ['Deciding which file to open'],
        content: ['Checking the available file candidates.'],
      };
      const liveTurn = (items: unknown[]) => ({
        id: turnId,
        items,
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'inProgress',
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started', threadId, turnId, turn: liveTurn([reasoning]),
      });
      return { threadId, turnId, toolId, reasoning };
    });

    const reasoningToggle = page.locator('.thread-reasoning-toggle');
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(0);
    await reasoningToggle.click();
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(1);

    // A tool call lands: the reasoning is no longer the tail. It must not snap
    // shut and shift the layout under the reader.
    await page.evaluate(({ threadId, turnId, toolId, reasoning }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [reasoning, {
            id: toolId,
            type: 'dynamicToolCall',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
            namespace: null,
            tool: 'file_read',
            arguments: { file_path: '/mock/workspace/notes.md' },
            modelCall: {
              disposition: 'replayable',
              identity: { namespace: null, name: 'file_read' },
              providerName: 'file_read',
              arguments: { storage: 'inline', value: { file_path: '/mock/workspace/notes.md' } },
              schemaDigest: '0'.repeat(64),
            },
            status: 'inProgress',
            outputRef: null,
            contentItems: null,
            success: null,
            durationMs: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
    }, ids);

    await expect(page.locator('.thread-tool')).toHaveCount(1);
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(1);

    await reasoningToggle.click();
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(0);
  });

  test('paints structural process updates at the followed bottom with one compact rhythm', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 520 });
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000c601';
      const userItemId = '01910000-0000-7000-8000-00000000c602';
      const itemId = (sequence: number) => (
        `01910000-0000-7000-8000-${sequence.toString().padStart(12, '0')}`
      );
      const itemProvenance = (originItemId: string) => ({
        originThreadId: threadId,
        originTurnId: turnId,
        originItemId,
      });
      const fileReadItem = (
        id: string,
        index: number,
        status: 'completed' | 'inProgress',
      ) => ({
        id,
        type: 'dynamicToolCall',
        provenance: itemProvenance(id),
        namespace: null,
        tool: 'file_read',
        arguments: { file_path: `/mock/process-${index}.json` },
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'file_read' },
          providerName: 'file_read',
          arguments: {
            storage: 'inline',
            value: { file_path: `/mock/process-${index}.json` },
          },
          schemaDigest: '0'.repeat(64),
        },
        status,
        outputRef: null,
        contentItems: status === 'completed' ? [{ type: 'text', text: 'ok' }] : null,
        success: status === 'completed' ? true : null,
        durationMs: status === 'completed' ? 5 : null,
      });
      const processItems = Array.from({ length: 8 }, (_, index) => {
        const reasoningId = itemId(10_000 + index * 2);
        const toolId = itemId(10_001 + index * 2);
        return [
          {
            id: reasoningId,
            type: 'reasoning',
            provenance: itemProvenance(reasoningId),
            summary: [`Process reasoning ${index + 1}`],
            content: [],
          },
          fileReadItem(toolId, index + 1, 'completed'),
        ];
      }).flat();
      const finalReasoningId = itemId(10_100);
      const nextToolId = itemId(10_101);
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: userItemId,
              type: 'userMessage',
              provenance: itemProvenance(userItemId),
              clientId: null,
              acceptedAt: Date.now(),
              content: [{ type: 'text', text: 'Keep this process timeline stable.' }],
            },
            ...processItems,
            {
              id: finalReasoningId,
              type: 'reasoning',
              provenance: itemProvenance(finalReasoningId),
              summary: ['Preparing the next file read'],
              content: ['Confirming the final candidate before the read.'],
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
      return {
        finalReasoningId,
        nextTool: fileReadItem(nextToolId, 9, 'inProgress'),
        nextToolId,
        threadId,
        turnId,
      };
    });

    const transcript = page.locator('.thread-transcript');
    const reasoningToggle = page.locator(
      `[data-thread-disclosure-id="reasoning:${fixture.finalReasoningId}"]`,
    );
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'false');
    await reasoningToggle.click();
    await expect(reasoningToggle).toHaveAttribute('aria-expanded', 'true');
    await setTranscriptFollowingBottom(page);
    await reasoningToggle.evaluate((element) => { element.dataset.identityProbe = 'stable'; });

    const frames = await page.evaluate(async ({ nextTool, nextToolId, threadId, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const scroll = document.querySelector<HTMLElement>('.thread-transcript');
      const anchor = document.querySelector<HTMLElement>('[data-identity-probe="stable"]');
      if (!scroll || !anchor) throw new Error('Missing process stability probe');
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'item/started',
        threadId,
        turnId,
        item: nextTool,
      });
      const samples: Array<{
        anchorTop: number;
        bottomGap: number;
        toolMounted: boolean;
      }> = [];
      const toolDisclosureId = `tool:${nextToolId}`;
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push({
          anchorTop: anchor.getBoundingClientRect().top,
          bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          toolMounted: Boolean(document.querySelector(
            `[data-thread-disclosure-id="${CSS.escape(toolDisclosureId)}"]`,
          )),
        });
      }
      return samples;
    }, fixture);

    const mountedFrames = frames.filter((frame) => frame.toolMounted);
    expect(mountedFrames.length).toBeGreaterThan(1);
    expect(mountedFrames[0]!.bottomGap).toBeLessThanOrEqual(1);
    expect(Math.max(...mountedFrames.map((frame) => frame.bottomGap))).toBeLessThanOrEqual(1);
    expect(Math.max(...mountedFrames.map((frame) => frame.anchorTop))
      - Math.min(...mountedFrames.map((frame) => frame.anchorTop))).toBeLessThan(1);
    await expect(reasoningToggle).toHaveAttribute('data-identity-probe', 'stable');
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);

    const rhythm = await reasoningToggle.evaluate((toggle) => {
      const reasoning = toggle.closest<HTMLElement>('.thread-reasoning');
      const timeline = reasoning?.parentElement;
      const bodyLine = reasoning?.querySelector<HTMLElement>(
        '.thread-reasoning-body .thread-markdown > :first-child',
      );
      const previousTool = reasoning?.previousElementSibling?.querySelector<HTMLElement>('.thread-tool-toggle');
      const nextTool = reasoning?.nextElementSibling?.querySelector<HTMLElement>('.thread-tool-toggle');
      if (!reasoning || !timeline || !bodyLine || !previousTool || !nextTool) {
        throw new Error('Missing compact process rhythm elements');
      }
      const expected = Number.parseFloat(getComputedStyle(timeline).rowGap);
      const previousRect = previousTool.getBoundingClientRect();
      const toggleRect = toggle.getBoundingClientRect();
      const bodyRect = bodyLine.getBoundingClientRect();
      const nextRect = nextTool.getBoundingClientRect();
      return {
        actual: [
          toggleRect.top - previousRect.bottom,
          bodyRect.top - toggleRect.bottom,
          nextRect.top - bodyRect.bottom,
        ],
        expected,
      };
    });
    expect(rhythm.expected).toBeGreaterThan(0);
    for (const interval of rhythm.actual) {
      expect(Math.abs(interval - rhythm.expected)).toBeLessThan(1);
    }
  });

  test('says a command failed without inventing an exit code it never reported', async ({ page }) => {
    await createNewThread(page);
    await seedMixedStatusToolTurn(page);

    await page.getByRole('button', { name: 'Worked for <1s' }).click();
    await page.locator('.thread-tool-activity-toggle').click();
    const failed = page.locator('.thread-tool-failed.thread-tool');
    await failed.locator('.thread-tool-toggle').click();
    // A timeout reported no code and no output, so the detail adds nothing: the
    // row's own `failed` segment is the whole statement, and no plausible
    // -looking code is borrowed to fill the gap.
    await expect(failed.locator('.thread-tool-label')).toContainText('failed');
    await expect(failed.locator('.thread-tool-section header')).toHaveText(['Arguments']);
    await expect(failed.locator('.thread-inline-error')).toHaveCount(0);
    await expect(failed).not.toContainText('Exit code');
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`carries tool-row status by colour and label in ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await createNewThread(page);
      await seedMixedStatusToolTurn(page);

      await page.getByRole('button', { name: 'Worked for <1s' }).click();
      const group = page.locator('.thread-tool-activity-group');
      await expect(group).toHaveClass(/thread-tool-failed/);
      await expect(group.locator('.thread-tool-activity-summary'))
        .toHaveText('Ran 3 commands · 1 failed · 1 interrupted');
      await group.locator('.thread-tool-activity-toggle').click();
      await expect(page.locator('.thread-tool-activity-members .thread-tool')).toHaveCount(3);

      const probe = await page.evaluate(() => {
        const channels = (value: string): readonly number[] =>
          (value.match(/[\d.]+/g) ?? []).map(Number);
        const luminance = (rgb: readonly number[]): number => {
          const linear = rgb.slice(0, 3).map((channel) => {
            const ratio = channel / 255;
            return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
        };
        const contrast = (a: readonly number[], b: readonly number[]): number => {
          const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
          return (high! + 0.05) / (low! + 0.05);
        };
        const paintedBackground = (element: Element): readonly number[] => {
          let node: Element | null = element;
          while (node) {
            const background = channels(getComputedStyle(node).backgroundColor);
            if ((background[3] ?? 1) > 0.99) return background;
            node = node.parentElement;
          }
          return channels(getComputedStyle(document.body).backgroundColor);
        };
        const token = (name: string): readonly number[] => {
          const probeElement = document.createElement('span');
          probeElement.style.color = `var(${name})`;
          document.body.append(probeElement);
          const resolved = channels(getComputedStyle(probeElement).color);
          probeElement.remove();
          return resolved;
        };
        const leadingSpaceWidth = (element: Element | null): number => {
          const node = element?.firstChild;
          if (!node) return -1;
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 1);
          return range.getBoundingClientRect().width;
        };
        const row = (status: string) => {
          const element = document.querySelector(`.thread-tool-activity-members .thread-tool-${status}`);
          if (!element) throw new Error(`Missing ${status} row`);
          const slot = element.querySelector('.thread-disclosure-status')!;
          const label = element.querySelector('.thread-tool-label')!;
          const slotStyle = getComputedStyle(slot);
          return {
            glyph: slot.querySelector('svg')?.outerHTML ?? '',
            labelColor: channels(getComputedStyle(label).color).slice(0, 3),
            slotBackgroundAlpha: channels(slotStyle.backgroundColor)[3] ?? 1,
            slotBorderWidth: slotStyle.borderTopWidth,
            slotHeight: Math.round(slot.getBoundingClientRect().height),
          };
        };
        const failedRow = row('failed');
        const summary = document.querySelector('.thread-tool-activity-summary')!;
        const tally = summary.querySelector('.thread-tool-activity-count-failed')!;
        return {
          completed: row('completed'),
          failed: failedRow,
          interrupted: row('interrupted'),
          statusDanger: token('--status-danger'),
          textFaint: token('--text-faint'),
          textSoft: token('--text-soft'),
          group: {
            summaryColor: channels(
              getComputedStyle(summary.querySelector('.thread-tool-summary-act')!).color,
            ).slice(0, 3),
            // The act shrinks and the tally is pinned, so a narrow pane can
            // never ellipsize the only failure cue away.
            actFlexShrink: getComputedStyle(summary.querySelector('.thread-tool-summary-act')!).flexShrink,
            tallyFlexShrink: getComputedStyle(tally).flexShrink,
            glyphColor: channels(
              getComputedStyle(document.querySelector('.thread-tool-activity-toggle .thread-disclosure-status')!).color,
            ).slice(0, 3),
            tallyColor: channels(getComputedStyle(tally).color).slice(0, 3),
            tallyText: tally.textContent,
            // Measure the separator as rendered. Text-content assertions
            // normalize whitespace, so they pass on markup that draws
            // "Ran 3 commands· 1 failed".
            tallyLeadingSpaceWidth: leadingSpaceWidth(tally),
            rowLeadingSpaceWidth: leadingSpaceWidth(
              document.querySelector('.thread-tool-activity-members .thread-tool-failed .thread-tool-activity-count-failed'),
            ),
          },
          failedLabelContrast: contrast(
            failedRow.labelColor,
            paintedBackground(document.querySelector('.thread-tool-failed.thread-tool')!),
          ),
        };
      });

      // The tool keeps its own glyph, so a broken row still says which tool broke.
      expect(probe.failed.glyph).toBe(probe.completed.glyph);
      expect(probe.interrupted.glyph).toBe(probe.completed.glyph);
      // Status is colour on the label, never a fill or a second slot geometry.
      expect(probe.failed.labelColor).toEqual(probe.statusDanger.slice(0, 3));
      expect(probe.interrupted.labelColor).toEqual(probe.textFaint.slice(0, 3));
      expect(probe.failed.slotBackgroundAlpha).toBe(0);
      expect(probe.failed.slotBorderWidth).toBe('0px');
      expect(probe.failed.slotHeight).toBe(probe.completed.slotHeight);
      // The whole --status-* family is calibrated as marks and fills, not as
      // small text: measured on the content surface, danger is 3.91 (light) /
      // 3.46 (dark) — better than success (3.33 light) and warning (2.44
      // light). 3:1 is therefore the bar this system actually holds; raising
      // the family to AA small-text is a design-system-wide recalibration
      // owned by docs/plans/dark-mode-contrast-pass.md, not by this row.
      expect(probe.failedLabelContrast).toBeGreaterThanOrEqual(3);

      // A mixed-outcome group stays neutral apart from its tally: one failed
      // call out of three must not paint the line, or the whole group reads as
      // broken. The group glyph stays neutral for the same reason.
      expect(probe.group.tallyText).toBe(' · 1 failed');
      expect(probe.group.tallyColor).toEqual(probe.statusDanger.slice(0, 3));
      expect(probe.group.summaryColor).not.toEqual(probe.statusDanger.slice(0, 3));
      expect(probe.group.summaryColor).toEqual(probe.textSoft.slice(0, 3));
      expect(probe.group.glyphColor).not.toEqual(probe.statusDanger.slice(0, 3));
      expect(probe.group.glyphColor).toEqual(probe.textFaint.slice(0, 3));
      expect(probe.group.tallyFlexShrink).toBe('0');
      expect(probe.group.actFlexShrink).not.toBe('0');
      // The " · " separator has to actually occupy width; a flex item
      // blockifies and a block trims its leading whitespace.
      expect(probe.group.tallyLeadingSpaceWidth).toBeGreaterThan(0);
      expect(probe.group.rowLeadingSpaceWidth).toBeGreaterThan(0);

      // The tint has to survive interaction — the chevron swap used to erase it.
      await page.locator('.thread-tool-failed.thread-tool .thread-tool-toggle').hover();
      const hoveredLabelColor = await page.evaluate(() => getComputedStyle(
        document.querySelector('.thread-tool-activity-members .thread-tool-failed .thread-tool-label')!,
      ).color);
      expect((hoveredLabelColor.match(/[\d.]+/g) ?? []).map(Number).slice(0, 3))
        .toEqual(probe.statusDanger.slice(0, 3));
    });
  }

  test('keeps a running tool spinning on its own row through hover and expansion', async ({ page }) => {
    await createNewThread(page);
    const turnId = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const liveTurnId = '01910000-0000-7000-8000-00000000b101';
      const doneId = '01910000-0000-7000-8000-00000000b102';
      const runningId = '01910000-0000-7000-8000-00000000b103';
      const commandItem = (id: string, command: string, status: string, exitCode: number | null) => ({
        id,
        type: 'commandExecution',
        provenance: { originThreadId: threadId, originTurnId: liveTurnId, originItemId: id },
        command,
        modelCall: {
          disposition: 'replayable',
          identity: { namespace: null, name: 'bash' },
          providerName: 'bash',
          arguments: { storage: 'inline', value: { command } },
          schemaDigest: '0'.repeat(64),
        },
        cwd: '/mock/workspace',
        processId: null,
        status,
        commandActions: [],
        aggregatedOutput: null,
        exitCode,
        durationMs: null,
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId: liveTurnId,
        turn: {
          id: liveTurnId,
          items: [
            commandItem(doneId, 'ls', 'completed', 0),
            commandItem(runningId, 'sleep 30', 'inProgress', null),
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: liveTurnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
      return liveTurnId;
    });

    const turn = page.locator(`[data-thread-turn-row="${turnId}"]`);
    const group = turn.locator('.thread-tool-activity-group');
    await expect(group).toHaveClass(/thread-tool-inProgress/);
    await group.locator('.thread-tool-activity-toggle').click();
    const running = turn.locator('.thread-tool-activity-members .thread-tool-inProgress');
    const done = turn.locator('.thread-tool-activity-members .thread-tool-completed');
    await expect(running).toHaveCount(1);

    // A finished child inside a running group must not borrow the spinner.
    await expect(done.locator('.thread-disclosure-status svg')).toHaveCSS('animation-name', 'none');
    await expect(running.locator('.thread-disclosure-status svg'))
      .toHaveCSS('animation-name', 'thread-tool-spin');

    // Opacity is transitioned, so these assertions have to settle rather than
    // read the frame the hover landed on.
    await running.locator('.thread-tool-toggle').hover();
    await expect(running.locator('.thread-disclosure-status')).toHaveCSS('opacity', '1');
    await expect(running.locator('.thread-disclosure-chevron')).toHaveCSS('opacity', '0');
    await running.locator('.thread-tool-toggle').click();
    await expect(running.locator('.thread-disclosure-status')).toHaveCSS('opacity', '1');
    // A settled sibling still swaps to the chevron on hover.
    await done.locator('.thread-tool-toggle').hover();
    await expect(done.locator('.thread-disclosure-status')).toHaveCSS('opacity', '0');
    await expect(done.locator('.thread-disclosure-chevron')).toHaveCSS('opacity', '1');
  });

  test('shows web tool arguments and results as direct JSON', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ae01';
      const toolId = '01910000-0000-7000-8000-00000000ae02';
      const answerId = '01910000-0000-7000-8000-00000000ae03';
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: toolId,
              type: 'webSearch',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: toolId },
              query: 'Chengdu weather',
              modelCall: {
                disposition: 'replayable',
                identity: { namespace: null, name: 'web_search' },
                providerName: 'web_search',
                arguments: { storage: 'inline', value: { query: 'Chengdu weather' } },
                schemaDigest: '0'.repeat(64),
              },
              results: [{ title: 'Forecast', url: 'https://example.com/weather', snippet: 'Sunny' }],
              status: 'completed',
              error: null,
            },
            {
              id: answerId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: answerId },
              text: 'It will be sunny.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 5,
          durationMs: 4,
        },
      });
    });

    await page.getByRole('button', { name: 'Worked for <1s' }).click();
    const tool = page.locator('.thread-tool').filter({ hasText: 'Chengdu weather' });
    await tool.getByRole('button', { name: /Searched the web/ }).click();
    const sections = tool.locator('.thread-tool-section');
    await expect(tool.getByRole('button', { name: 'Copy arguments' })).toHaveCount(1);
    await expect(tool.getByRole('button', { name: 'Copy output' })).toHaveCount(1);
    await expect(sections.nth(0)).toContainText('Arguments');
    await expect(sections.nth(0).locator('.agent-code-body')).toContainText('"query": "Chengdu weather"');
    await expect(sections.nth(1)).toContainText('Result');
    await expect(sections.nth(1).locator('.agent-code-body')).toContainText('"title": "Forecast"');
  });

  test('keeps Node and local-file references interactive in canonical Agent Markdown', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async ({ nodeId }) => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ac01';
      const answerId = '01910000-0000-7000-8000-00000000ac02';
      const turn = {
        id: turnId,
        items: [{
          id: answerId,
          type: 'agentMessage',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: answerId },
          text: `Review [[node:Alpha^${nodeId}]] and [[file:notes.md^%2Fmock%2Fnotes.md]].`,
          phase: 'final_answer',
          memoryCitation: null,
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 13,
        durationMs: 12,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn,
      });
    }, { nodeId: ids.alpha });

    const message = page.locator('.thread-agent-message').last();
    await expect(message).not.toContainText('[[node:');
    const nodeRef = message.locator(`[data-inline-ref="${ids.alpha}"]`);
    await expect(nodeRef).toHaveText('Alpha');
    await expect(nodeRef).toHaveAttribute('href', new RegExp(`lin-node:${ids.alpha}`));

    const fileRef = message.locator('[data-inline-ref-kind="local-file"]');
    await expect(fileRef).toHaveText('notes.md');
    await fileRef.hover();
    await expect(page.locator('[data-inline-file-preview]')).toContainText('/mock/notes.md');
    await fileRef.click();
    const preview = page.locator('.outline-panel-surface.active-panel.is-file-preview');
    await expect(preview.locator('.file-preview-content')).toContainText('Mock preview text.');
  });

  test('shows a Plan on a Thread that has no composer', async ({ page }) => {
    // `update_plan` is `anyThread`-scoped, so a watched child or automation
    // Thread has a Plan — and the chip used to mount only inside the composer
    // branch, so it had nowhere to appear.
    await createNewThread(page);
    const childThreadId = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin
        ?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>('thread/list', {});
      const parent = response?.data[0];
      if (!parent) throw new Error('Mock Thread not found');
      const thread = {
        ...parent,
        id: '01910000-0000-7000-8000-00000000ce01',
        parentThreadId: parent.id,
        name: 'Child agent',
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'thread/started', thread });
      // A child is not a list row, so the parent transcript is the way in.
      const parentTurnId = '01910000-0000-7000-8000-00000000ce04';
      const activityId = '01910000-0000-7000-8000-00000000ce05';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parent.id,
        turnId: parentTurnId,
        turn: {
          id: parentTurnId,
          items: [{
            id: activityId,
            type: 'subAgentActivity',
            provenance: { originThreadId: parent.id, originTurnId: parentTurnId, originItemId: activityId },
            kind: 'started',
            agentThreadId: thread.id,
            agentPath: '/root/plan_child',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: parent.id, originTurnId: parentTurnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
      return thread.id;
    });

    // Select before seeding: notifications for a Thread whose Turns are not yet
    // loaded are dropped, and selecting reloads them.
    await page.getByRole('button', { name: 'Open Subagent Thread plan_child' }).click();
    await page.evaluate((threadId) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const turnId = '01910000-0000-7000-8000-00000000ce02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/plan/updated',
        threadId,
        turnId,
        explanation: null,
        plan: [
          { step: 'Gather the sources', status: 'completed' },
          { step: 'Cross-check the citations', status: 'in_progress' },
        ],
      });
    }, childThreadId);

    // The child's run detail is the composer-less surface; the parent's
    // composer stays on screen, still the parent's.
    const detail = page.locator('.thread-subagent-detail');
    await expect(detail.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);
    const pill = detail.locator('.thread-plan-progress-summary');
    await expect(pill).toHaveText('2/2 · Cross-check the citations');

    // With no composer to return to, Escape must still land focus somewhere
    // reachable rather than dropping it to the document body.
    await pill.click();
    await expect(page.locator('.thread-plan-progress-popover')).toBeFocused();
    await page.locator('.thread-plan-progress-popover').press('Escape');
    await expect(pill).toBeFocused();

    // The checklist gets the Thread's width here, not the pill's.
    await pill.click();
    const widths = await page.evaluate(() => {
      const popover = document.querySelector('.thread-plan-progress-popover');
      const region = document.querySelector('.thread-composer-region');
      return {
        popover: popover?.getBoundingClientRect().width ?? 0,
        region: region?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(widths.popover).toBeGreaterThan(widths.region * 0.5);
  });

  test('reads an all-complete Plan as complete, not as its last step', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(m: string, i?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (n: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000e101';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId, items: [], itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress', error: null, startedAt: Date.now(), completedAt: null, durationMs: null,
        },
      });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/plan/updated',
        threadId,
        turnId,
        explanation: null,
        plan: [
          { step: 'Read the source', status: 'completed' },
          { step: 'Write the summary', status: 'completed' },
        ],
      });
    });

    // `2/2` beside a check was distinguishable from "on step two" only by the
    // icon; a finished Plan is not "on" its last step.
    await expect(page.locator('.thread-plan-progress-summary')).toHaveText('Plan complete');
  });

  test('shows Turn-local Plan progress only while the Turn is active', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ae01';
      const itemId = '01910000-0000-7000-8000-00000000ae02';
      const turn = {
        id: turnId,
        items: [{
          id: itemId,
          type: 'userMessage',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
          clientId: null,
          acceptedAt: 1,
          content: [{ type: 'text', text: 'Implement the interaction' }],
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'inProgress',
        error: null,
        execution: {
          modelProvider: 'openai',
          model: 'openai/gpt-5.4',
          reasoningEffort: 'medium',
          diagnosticsRef: null,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: null,
          },
        },
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn,
      });
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/plan/updated',
        threadId,
        turnId,
        explanation: 'Working through the interaction contract',
        plan: Array.from({ length: 24 }, (_, index) => ({
          step: index === 0
            ? 'Inspect the current behavior'
            : index === 1
              ? 'Implement the transient projection'
              : `Verify interaction checkpoint ${index + 1}`,
          status: index === 0 ? 'completed' : index === 1 ? 'in_progress' : 'pending',
        })),
      });
      return { threadId, turn };
    });

    const progress = page.locator('.thread-plan-progress-summary');
    // The persistent affordance is the current step's text, not a bare counter.
    await expect(progress).toHaveText('2/24 · Implement the transient projection');
    await expect(progress).toHaveAttribute('aria-expanded', 'false');
    await progress.hover();
    const checklist = page.locator('.thread-plan-progress-popover');
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText('Working through the interaction contract');
    await expect(checklist.locator('li')).toHaveCount(24);
    // Each row states its status for assistive tech; the icons are decorative.
    await expect(checklist.locator('li').first()).toHaveText('Completed: Inspect the current behavior');
    await expect(checklist.locator('li').last()).toHaveText('Pending: Verify interaction checkpoint 24');
    // The current step is marked by weight and colour, so the cue survives
    // reduced motion, where the spinner stops.
    const currentStep = checklist.locator('li.is-in_progress');
    await expect(currentStep).toHaveCount(1);
    await expect(currentStep).toHaveCSS('font-weight', '600');
    expect(await checklist.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    await checklist.hover();
    await page.mouse.wheel(0, 480);
    await expect.poll(() => checklist.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await page.mouse.move(1, 1);
    await expect(checklist).not.toBeVisible();
    await progress.focus();
    await progress.press('Enter');
    await expect(progress).toHaveAttribute('aria-expanded', 'true');
    await expect(checklist).toBeVisible();
    await expect(checklist).toBeFocused();
    await checklist.evaluate((element) => { element.scrollTop = 0; });
    await checklist.press('PageDown');
    await expect.poll(() => checklist.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await checklist.press('Escape');
    await expect(progress).toHaveAttribute('aria-expanded', 'false');
    await expect(checklist).not.toBeVisible();
    // Closing hands focus back to the composer, not to the pill: the Plan is a
    // transient status affordance, not a destination to be stranded in.
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeFocused();

    await page.evaluate(({ threadId, turn }) => {
      const e2eWindow = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId: turn.id,
        turn: { ...turn, status: 'completed', completedAt: 2, durationMs: 1 },
      });
    }, fixture);

    await expect(page.locator('.thread-plan-progress')).toHaveCount(0);
    await expect(page.getByText('Used update_plan')).toHaveCount(0);
  });

  test('shows loaded and isolated Skills through the same tool disclosure', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ad01';
      const loadedId = '01910000-0000-7000-8000-00000000ad02';
      const isolatedId = '01910000-0000-7000-8000-00000000ad03';
      const provenance = (itemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: itemId });
      const turn = {
        id: turnId,
        items: [{
          id: loadedId,
          type: 'dynamicToolCall',
          provenance: provenance(loadedId),
          namespace: null,
          tool: 'skill',
          arguments: { skill: 'review-pr', args: '429 --focus rendering' },
          modelCall: {
            disposition: 'replayable',
            identity: { namespace: null, name: 'skill' },
            providerName: 'skill',
            arguments: {
              storage: 'inline',
              value: { skill: 'review-pr', args: '429 --focus rendering' },
            },
            schemaDigest: '0'.repeat(64),
          },
          status: 'completed',
          contentItems: [{ type: 'text', text: 'Launching skill: review-pr' }],
          success: true,
          durationMs: 2,
        }, {
          id: isolatedId,
          type: 'dynamicToolCall',
          provenance: provenance(isolatedId),
          namespace: null,
          tool: 'skill',
          arguments: { skill: 'investigate', args: 'render regression' },
          modelCall: {
            disposition: 'replayable',
            identity: { namespace: null, name: 'skill' },
            providerName: 'skill',
            arguments: {
              storage: 'inline',
              value: { skill: 'investigate', args: 'render regression' },
            },
            schemaDigest: '0'.repeat(64),
          },
          status: 'completed',
          contentItems: [{ type: 'text', text: 'Isolated skill result.' }],
          success: true,
          durationMs: 8,
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 13,
        durationMs: 12,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn,
      });
    });

    await expect(page.locator('.thread-process-title')).toHaveText('Used 2 skills');
    await page.getByRole('button', { name: 'Used 2 skills' }).click();
    const skills = page.locator('.thread-tool-toggle');
    await expect(skills).toHaveCount(2);
    await skills.nth(0).click();
    await expect(skills.nth(0).locator('xpath=..')).toContainText('review-pr');
    await expect(skills.nth(0).locator('xpath=..')).toContainText('429 --focus rendering');
    await expect(skills.nth(0).locator('xpath=..')).toContainText('Launching skill: review-pr');
    await skills.nth(1).click();
    await expect(page.getByText('Isolated skill result.')).toBeVisible();
  });

  test('opens a lone terminal reasoning Item when the Turn has no final response', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ab01';
      const userMessageId = '01910000-0000-7000-8000-00000000ab02';
      const reasoningId = '01910000-0000-7000-8000-00000000ab03';
      const commentaryId = '01910000-0000-7000-8000-00000000ab04';
      const provenance = (itemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId: itemId });
      const turn = {
        id: turnId,
        items: [
          {
            id: userMessageId,
            type: 'userMessage',
            provenance: provenance(userMessageId),
            clientId: null,
            acceptedAt: 1,
            content: [{ type: 'text', text: 'Inspect the outline.' }],
          },
          {
            id: reasoningId,
            type: 'reasoning',
            provenance: provenance(reasoningId),
            summary: ['The outline is currently empty.'],
            content: ['No outline nodes require inspection.'],
          },
          {
            id: commentaryId,
            type: 'agentMessage',
            provenance: provenance(commentaryId),
            text: '   ',
            phase: 'commentary',
            memoryCitation: null,
          },
        ],
        status: 'completed',
        error: null,
        createdAt: Date.now(),
        completedAt: Date.now(),
        durationMs: 28,
      };
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn,
      });
    });

    const thought = page.getByRole('button', { name: 'The outline is currently empty.' });
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('The outline is currently empty.', { exact: true })).toBeVisible();
    await expect(page.getByText('No outline nodes require inspection.', { exact: true })).toBeVisible();
    await expect(page.getByText('Thought', { exact: true })).toHaveCount(0);
  });

  test('keeps live lone reasoning folded when the Turn settles without a response', async ({ page }) => {
    await createNewThread(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ac01';
      const reasoningId = '01910000-0000-7000-8000-00000000ac02';
      const reasoning = {
        id: reasoningId,
        type: 'reasoning',
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: reasoningId },
        summary: ['Inspecting the current outline'],
        content: ['No outline nodes currently require changes.'],
      };
      const turn = {
        id: turnId,
        items: [reasoning],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'inProgress',
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({ type: 'turn/started', threadId, turnId, turn });
      return { reasoningId, threadId, turn, turnId };
    });

    const toggle = page.locator(`[data-thread-disclosure-id="reasoning:${fixture.reasoningId}"]`);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(0);
    const top = await toggle.evaluate((element) => element.getBoundingClientRect().top);

    await page.evaluate(({ threadId, turn, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: { ...turn, status: 'completed', completedAt: 2, durationMs: 1 },
      });
    }, fixture);

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.thread-reasoning-body')).toHaveCount(0);
    expect(Math.abs(await toggle.evaluate((element) => element.getBoundingClientRect().top) - top)).toBeLessThan(1);
  });

  test('keeps the composer primary action identical to the active Turn state', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const e2eWindow = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await e2eWindow.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000bb01';
      e2eWindow.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      });
    });

    await expect(page.getByRole('button', { name: 'Interrupt Turn' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add attachment' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Model and reasoning' })).toBeDisabled();
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Use the shorter path.');
    await expect(page.getByRole('button', { name: 'Steer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Interrupt Turn' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Steer' }).click();

    const steer = (await commandCalls(page)).filter((call) => call.cmd === 'turn/steer').at(-1);
    expect(steer?.args.input).toEqual([{ type: 'text', text: 'Use the shorter path.' }]);
  });

  test('uses the established step flow for canonical user input without losing the composer draft', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill('Keep this draft while answering.');
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ab01';
      const itemId = '01910000-0000-7000-8000-00000000ab02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'userInput/requested',
        threadId,
        turnId,
        itemId,
        request: {
          threadId,
          turnId,
          itemId,
          questions: [
            {
              id: 'scope',
              header: 'Scope',
              question: 'How broad should the pass be?',
              options: [
                { label: 'Focused', description: 'Only the selected module.' },
                { label: 'Complete', description: 'Cover the full workflow.' },
              ],
            },
            {
              id: 'schedule',
              header: 'Schedule',
              question: 'When should this run?',
              options: [
                { label: 'Now', description: 'Run immediately.' },
                { label: 'Tonight', description: 'Run after work.' },
              ],
            },
          ],
        },
      });
    });

    const form = page.getByRole('form', { name: 'Input needed' });
    await expect(form).toContainText('1 of 2');
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toBeHidden();
    await form.getByRole('radio', { name: /Complete/ }).check();
    await form.getByRole('button', { name: 'Next' }).click();
    await expect(form).toContainText('2 of 2');
    await expect(form.getByRole('radio', { name: /Now/ })).toBeFocused();

    await form.getByRole('button', { name: 'Previous question' }).click();
    await expect(form.getByRole('radio', { name: /Complete/ })).toBeChecked();
    await form.getByRole('button', { name: 'Next' }).click();
    await form.getByRole('radio', { name: 'Other' }).check();
    await form.getByRole('textbox', { name: 'Other' }).fill('Every morning');
    await form.getByRole('button', { name: 'Submit' }).click();

    const response = (await commandCalls(page)).filter((call) => call.cmd === 'userInput/respond').at(-1);
    expect(response?.args.answers).toEqual([
      { questionId: 'scope', optionLabel: 'Complete' },
      { questionId: 'schedule', otherText: 'Every morning' },
    ]);

    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'userInput/resolved',
        threadId,
        turnId: '01910000-0000-7000-8000-00000000ab01',
        itemId: '01910000-0000-7000-8000-00000000ab02',
        response: {
          threadId,
          turnId: '01910000-0000-7000-8000-00000000ab01',
          itemId: '01910000-0000-7000-8000-00000000ab02',
          answers: [],
          autoResolved: false,
        },
      });
    });
    await expect(composer).toHaveText('Keep this draft while answering.');
  });

  test('anchors a sent message and resumes streaming follow only after jumping to latest', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 10; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Earlier scroll evidence ${index + 1}` }],
          clientUserMessageId: `scroll-evidence-${index + 1}`,
        });
      }
    });

    const transcript = page.locator('.thread-transcript');
    await expect(
      page.locator('.thread-user-message').filter({ hasText: 'Earlier scroll evidence' }),
    ).toHaveCount(10);
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill([
      'Anchor this request.',
      ...Array.from({ length: 80 }, (_, index) => `Disclosure evidence ${index + 1}.`),
    ].join(' '));
    await page.getByRole('button', { name: 'Send' }).click();

    const userMessage = page.locator('.thread-user-message').filter({ hasText: 'Anchor this request.' });
    await expect(userMessage).toBeVisible();
    await expect.poll(() => userMessage.evaluate((element) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
    })).toBeLessThanOrEqual(2);
    const sendAnchorSpacer = page.locator('.thread-send-anchor-spacer');
    await expect(sendAnchorSpacer).toHaveCount(1);
    const initialSpacerHeight = await sendAnchorSpacer.evaluate((element) => (
      element.getBoundingClientRect().height
    ));
    expect(initialSpacerHeight).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    const anchoredTop = await transcript.evaluate((element) => element.scrollTop);

    const live = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const threads = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = threads?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const history = await target.lin?.agentCoreRequest<{ data: Array<Record<string, unknown>> }>(
        'thread/turns/list',
        { threadId, limit: 100, itemsView: 'full' },
      );
      const turn = history?.data.at(-1) as Record<string, unknown> | undefined;
      const turnId = typeof turn?.id === 'string' ? turn.id : null;
      const items = Array.isArray(turn?.items) ? turn.items as Array<Record<string, unknown>> : [];
      const userItem = items.find((item) => item.type === 'userMessage');
      const responseItem = items.find((item) => item.type === 'agentMessage');
      const responseItemId = typeof responseItem?.id === 'string' ? responseItem.id : null;
      if (!turnId || !userItem || !responseItem || !responseItemId) throw new Error('Missing sent Turn');
      const streamingText = Array.from(
        { length: 36 },
        (_, index) => `Streaming anchored evidence ${index + 1}.`,
      ).join('\n\n');
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          ...turn,
          items: [userItem, { ...responseItem, text: streamingText }],
          status: 'inProgress',
          completedAt: null,
          durationMs: null,
        },
      });
      return { responseItemId, threadId, turnId };
    });

    await expect(page.getByText('Streaming anchored evidence 36.')).toBeVisible();
    await expect.poll(async () => (
      await sendAnchorSpacer.count() === 0
        ? 0
        : sendAnchorSpacer.evaluate((element) => element.getBoundingClientRect().height)
    )).toBeLessThan(initialSpacerHeight);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(anchoredTop - 2);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThan(anchoredTop + 2);
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);

    await page.evaluate(({ responseItemId, threadId, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'item/delta',
        threadId,
        turnId,
        itemId: responseItemId,
        delta: {
          type: 'agentMessageText',
          delta: Array.from({ length: 18 }, (_, index) => `\n\nPinned stream delta ${index + 1}.`).join(''),
        },
      });
    }, live);
    await expect(page.getByText('Pinned stream delta 18.')).toBeVisible();
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);
  });

  test('keeps a bottom-positioned long-message disclosure anchored', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill(Array.from(
      { length: 80 },
      (_, index) => `Long message evidence ${index + 1}.`,
    ).join(' '));
    await page.getByRole('button', { name: 'Send' }).click();

    const transcript = page.locator('.thread-transcript');
    const disclosure = page.locator('.thread-user-expand-button');
    await expect(disclosure).toHaveAccessibleName('Show more');
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);

    await toggleDisclosureWithStableAnchor(disclosure);
    await expect(disclosure).toHaveAccessibleName('Show less');
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);

    await toggleDisclosureWithStableAnchor(disclosure);
    await expect(disclosure).toHaveAccessibleName('Show more');
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);
  });

  test('lets a keyboard send supersede a pending disclosure anchor', async ({ page }) => {
    await createNewThread(page);
    const composer = page.getByRole('textbox', { name: 'Message this Thread' });
    await composer.fill(Array.from(
      { length: 80 },
      (_, index) => `Pending disclosure evidence ${index + 1}.`,
    ).join(' '));
    await page.getByRole('button', { name: 'Send' }).click();

    const disclosure = page.locator('.thread-user-expand-button');
    await expect(disclosure).toHaveAccessibleName('Show more');
    await composer.fill('Send while the disclosure anchor is pending.');
    await page.evaluate(() => {
      const toggle = document.querySelector<HTMLButtonElement>('.thread-user-expand-button');
      const editor = document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message this Thread"]');
      if (!toggle || !editor) throw new Error('Missing disclosure or composer');
      toggle.click();
      editor.focus();
      editor.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: 'Enter',
        key: 'Enter',
      }));
    });

    const sentMessage = page.locator('.thread-user-message').filter({
      hasText: 'Send while the disclosure anchor is pending.',
    });
    await expect(sentMessage).toBeVisible();
    await expect.poll(() => sentMessage.evaluate((element) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
    })).toBeLessThanOrEqual(2);
    await expect.poll(() => page.locator('.thread-transcript-content').evaluate((element) => (
      element.style.paddingBottom
    ))).toBe('');
  });

  test('replays bottom follow after a streaming update waits on a disclosure anchor', async ({ page }) => {
    await createNewThread(page);
    await seedOverflowingTranscript(page);
    const fixture = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000fb01';
      const userItemId = '01910000-0000-7000-8000-00000000fb02';
      const reasoningItemId = '01910000-0000-7000-8000-00000000fb03';
      const responseItemId = '01910000-0000-7000-8000-00000000fb04';
      const provenance = (originItemId: string) => ({ originThreadId: threadId, originTurnId: turnId, originItemId });
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/started',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: userItemId,
              type: 'userMessage',
              provenance: provenance(userItemId),
              content: [{ type: 'text', text: 'Keep following this short live response.' }],
            },
            {
              id: reasoningItemId,
              type: 'reasoning',
              provenance: provenance(reasoningItemId),
              summary: ['Inspect'],
              content: ['Review the response stream.'],
            },
            {
              id: responseItemId,
              type: 'agentMessage',
              provenance: provenance(responseItemId),
              text: 'Streaming follow checkpoint.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'inProgress',
          error: null,
          startedAt: 3,
          completedAt: null,
          durationMs: null,
        },
      });
      return { responseItemId, threadId, turnId };
    });

    const transcript = page.locator('.thread-transcript');
    const thought = page.locator('.thread-reasoning-toggle').last();
    await expect(thought).toHaveAttribute('aria-expanded', 'false');
    await setTranscriptFollowingBottom(page);
    const anchoredTop = await thought.evaluate((element) => element.getBoundingClientRect().top);
    await page.evaluate(({ responseItemId, threadId, turnId }) => {
      const target = window as Window & {
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const toggle = document.querySelectorAll<HTMLButtonElement>('.thread-reasoning-toggle');
      toggle[toggle.length - 1]?.click();
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'item/delta',
        threadId,
        turnId,
        itemId: responseItemId,
        delta: { type: 'agentMessageText', delta: ' continued' },
      });
    }, fixture);
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await page.evaluate(async () => {
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    expect(Math.abs(await thought.evaluate((element) => (
      element.getBoundingClientRect().top
    )) - anchoredTop)).toBeLessThan(1);
    await expect.poll(() => transcript.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ))).toBeLessThanOrEqual(1);
  });

  test('does not pull the transcript down after the reader scrolls upward', async ({ page }) => {
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ee01';
      const itemId = '01910000-0000-7000-8000-00000000ee02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'agentMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
            text: Array.from({ length: 80 }, (_, index) => `Earlier evidence ${index + 1}`).join('\n\n'),
            phase: 'final_answer',
            memoryCitation: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });

    const transcript = page.locator('.thread-transcript');
    await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await setTranscriptFollowingBottom(page);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const frames = await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const scroll = document.querySelector<HTMLElement>('.thread-transcript');
      if (!scroll) throw new Error('Thread transcript not found');
      const turnId = '01910000-0000-7000-8000-00000000ef01';
      const itemId = '01910000-0000-7000-8000-00000000ef02';
      scroll.scrollTop = 0;
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'agentMessage',
            provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
            text: 'New evidence arrived.',
            phase: 'final_answer',
            memoryCitation: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 3,
          completedAt: 4,
          durationMs: 1,
        },
      });
      const samples: Array<{ bottomGap: number; messageMounted: boolean; scrollTop: number }> = [];
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        samples.push({
          bottomGap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          messageMounted: document.body.textContent?.includes('New evidence arrived.') ?? false,
          scrollTop: scroll.scrollTop,
        });
      }
      return samples;
    });

    const mountedFrames = frames.filter((frame) => frame.messageMounted);
    expect(mountedFrames.length).toBeGreaterThan(1);
    expect(Math.max(...mountedFrames.map((frame) => frame.scrollTop))).toBeLessThanOrEqual(1);
    expect(Math.min(...mountedFrames.map((frame) => frame.bottomGap))).toBeGreaterThan(1);
    await expect(page.getByText('New evidence arrived.')).toHaveCount(1);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  });

  test('virtualizes long Threads and restores their scroll position after switching', async ({ page }) => {
    await createNewThread(page);
    await openSelectedThreadActions(page);
    await page.getByRole('menu', { name: 'Thread actions' }).getByRole('menuitem', { name: 'Rename Thread' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename Thread' });
    await renameDialog.getByRole('textbox', { name: 'Rename Thread' }).fill('Long history');
    await renameDialog.getByRole('button', { name: 'Save' }).click();

    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data.find((thread) => thread.id)?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      for (let index = 0; index < 45; index += 1) {
        await target.lin?.agentCoreRequest('turn/start', {
          threadId,
          input: [{ type: 'text', text: `Long history message ${index + 1}` }],
          clientUserMessageId: `long-history-${index + 1}`,
        });
        if (index % 5 === 4) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }
    });

    const transcript = page.locator('.thread-transcript');
    const turns = page.locator('.thread-transcript-turns');
    await expect(turns).toHaveAttribute('data-virtualized', 'true');
    await expect.poll(() => page.locator('[data-thread-turn-row]').count()).toBeLessThan(45);
    const compensationAnchor = await transcript.evaluate(async (element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.max(1, maximum - 80);
      element.dispatchEvent(new Event('scroll'));
      for (let frame = 0; frame < 16; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const viewportTop = element.getBoundingClientRect().top;
      const rows = Array.from(element.querySelectorAll<HTMLElement>('[data-thread-turn-row]'));
      const anchor = rows.find((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.top <= viewportTop && bounds.bottom > viewportTop;
      });
      const growthRow = rows.filter((row) => row.getBoundingClientRect().bottom <= viewportTop - 200).at(-1);
      const anchorTurnId = anchor?.dataset.threadTurnRow;
      const growthTurnId = growthRow?.dataset.threadTurnRow;
      if (!anchor || !anchorTurnId || !growthRow || !growthTurnId) {
        throw new Error('Missing virtual compensation rows');
      }
      growthRow.querySelector<HTMLElement>('.thread-turn')?.style.setProperty('content-visibility', 'visible');
      const result = {
        anchorTurnId,
        growthTurnId,
        offset: anchor.getBoundingClientRect().top - viewportTop,
        scrollTop: element.scrollTop,
      };
      const growthProbe = document.createElement('div');
      growthProbe.dataset.virtualGrowthProbe = 'true';
      growthProbe.style.height = '180px';
      growthRow.append(growthProbe);
      return result;
    });
    const compensationRow = page.locator(
      `[data-thread-turn-row="${compensationAnchor.anchorTurnId}"]`,
    );
    await expect.poll(() => compensationRow.evaluate((element, expectedOffset) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      return Math.abs(
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expectedOffset,
      );
    }, compensationAnchor.offset)).toBeLessThanOrEqual(2);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(compensationAnchor.scrollTop + 160);
    await page.locator(
      `[data-thread-turn-row="${compensationAnchor.growthTurnId}"]`,
    ).evaluate((element) => {
      element.querySelector('[data-virtual-growth-probe]')?.remove();
    });
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(compensationAnchor.scrollTop - 2);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
      .toBeLessThan(compensationAnchor.scrollTop + 2);
    await expect.poll(() => compensationRow.evaluate((element, expectedOffset) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      return Math.abs(
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expectedOffset,
      );
    }, compensationAnchor.offset)).toBeLessThanOrEqual(2);
    await transcript.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const top = Math.max(1, Math.min(480, Math.floor(maximum / 2)));
      element.scrollTop = top;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByText('Long history message 1', { exact: true })).toHaveCount(1);
    const readingAnchor = await transcript.evaluate(async (element) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      }));
      const viewportTop = element.getBoundingClientRect().top;
      const row = Array.from(element.querySelectorAll<HTMLElement>('[data-thread-turn-row]'))
        .find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.top <= viewportTop && bounds.bottom > viewportTop;
        });
      const turnId = row?.dataset.threadTurnRow;
      if (!row || !turnId) throw new Error('Missing reading anchor');
      return {
        offset: row.getBoundingClientRect().top - viewportTop,
        scrollTop: element.scrollTop,
        turnId,
      };
    });
    expect(readingAnchor.scrollTop).toBeGreaterThan(0);

    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Long history' })
      .click();

    await expect(page.locator('.thread-dock-title')).toContainText('Long history');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    const restoredRow = page.locator(
      `[data-thread-turn-row="${readingAnchor.turnId}"]`,
    );
    await expect(restoredRow).toHaveCount(1);
    await expect.poll(() => restoredRow.evaluate((element, expectedOffset) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const actualOffset = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      return Math.abs(actualOffset - expectedOffset);
    }, readingAnchor.offset)).toBeLessThanOrEqual(2);

    const savedNearBottom = await transcript.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.max(1, maximum - 80);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    const originalViewport = page.viewportSize();
    if (!originalViewport) throw new Error('Missing viewport');
    await createNewThread(page);
    await page.setViewportSize({
      height: originalViewport.height + 240,
      width: originalViewport.width,
    });
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Long history' })
      .click();
    await expect(page.locator('.thread-dock-title')).toContainText('Long history');
    await expect.poll(() => transcript.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      return Math.abs(element.scrollTop - maximum);
    })).toBeLessThanOrEqual(2);
    const clampedRestore = await transcript.evaluate((element) => ({
      maximum: Math.max(0, element.scrollHeight - element.clientHeight),
      top: element.scrollTop,
    }));
    expect(clampedRestore.maximum).toBeGreaterThan(0);
    expect(clampedRestore.maximum).toBeLessThan(savedNearBottom);
    expect(Math.abs(clampedRestore.top - clampedRestore.maximum)).toBeLessThanOrEqual(2);
    await page.setViewportSize(originalViewport);
  });

  test('returns a flow-layout Thread to the Turn it was left on', async ({ page }) => {
    await createNewThread(page);
    await renameSelectedThread(page, 'Tall history');
    await seedTallFlowTranscript(page, 12);
    const anchor = await captureReadingAnchor(page, 0.6);

    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Tall history' })
      .click();
    await expect(page.locator('.thread-dock-title')).toContainText('Tall history');

    await expectReadingAnchorRestored(page, anchor);
  });

  test('lets a send after a restore reach the end instead of being pulled back', async ({ page }) => {
    await createNewThread(page);
    await renameSelectedThread(page, 'Tall history');
    await seedTallFlowTranscript(page, 12);
    const anchor = await captureReadingAnchor(page, 0.6);

    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Tall history' })
      .click();
    await expectReadingAnchorRestored(page, anchor);

    // The restore owns the position until the reader acts. Sending is the reader
    // acting: the new message anchors at the transcript top, and no restore that
    // outlived its arrival gets to pull the transcript back up behind it.
    await page.getByRole('textbox', { name: 'Message this Thread' }).fill('Anchor this send.');
    await page.getByRole('button', { name: 'Send' }).click();
    const sent = page.locator('.thread-user-message').filter({ hasText: 'Anchor this send.' });
    await expect(sent).toBeVisible();
    await expect.poll(() => sent.evaluate((element) => {
      const scroller = element.closest('.thread-transcript');
      if (!(scroller instanceof HTMLElement)) throw new Error('Missing transcript');
      const topInset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      return Math.abs(element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - topInset);
    })).toBeLessThanOrEqual(2);
    await expect(page.locator(`[data-thread-turn-row="${anchor.turnId}"]`)).not.toBeInViewport();
  });

  test('reads a Subagent without moving the parent conversation at all', async ({ page }) => {
    await createNewThread(page);
    await renameSelectedThread(page, 'Parent history');
    await seedTallFlowTranscript(page, 12);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: {
          createMockSubagentThread: (input: { parentThreadId: string; name: string }) => { id: string };
          emitAgentCoreNotification: (notification: unknown) => void;
        };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const parentThreadId = response?.data[0]?.id;
      if (!parentThreadId) throw new Error('Mock Thread not found');
      const child = target.__LIN_E2E__?.createMockSubagentThread({ parentThreadId, name: 'research worker' });
      // The delegation row is where a child is read, so the Turn that delegated
      // it has to carry one — which is what production records for every form.
      const turnId = '01910000-0000-7000-8000-00000000ef01';
      const itemId = '01910000-0000-7000-8000-00000000ef02';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId: parentThreadId,
        turnId,
        turn: {
          id: turnId,
          items: [{
            id: itemId,
            type: 'subAgentActivity',
            provenance: { originThreadId: parentThreadId, originTurnId: turnId, originItemId: itemId },
            kind: 'completed',
            agentThreadId: child!.id,
            agentPath: '/root/research_worker',
            error: null,
            spawnItemId: null,
          }],
          itemsView: 'full',
          provenance: { originThreadId: parentThreadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      });
    });
    // Reading a child is a disclosure in the transcript, so the conversation is
    // never left: the dock still names it and the composer still belongs to it.
    const row = page.locator('[data-thread-disclosure-id^="subagent:"]').first();
    const detail = page.locator('.thread-subagent-detail');
    const rowTop = () => row.evaluate((element) => Math.round(element.getBoundingClientRect().top));

    await row.click();
    await expect(detail).toBeVisible();
    await expect(page.locator('.thread-dock-title')).toHaveText('Parent history');
    const openedAt = await rowTop();

    await row.click();
    await expect(detail).toHaveCount(0);
    // The invariant this shape exists for: the row you opened does not move
    // under you, opening or closing. A bounded container grows BELOW its row,
    // so there is no reading position to lose and none to restore.
    expect(await rowTop()).toBe(openedAt);
  });
});

test('restores the reader position when turn/start rejects', async ({ page }) => {
  await openMockedApp(page, { agentTurnStartReject: 'Mock turn/start rejection' });
  await page.evaluate(async () => {
    const target = window as Window & {
      lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
    };
    const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
    const threadId = response?.data[0]?.id;
    if (!threadId) throw new Error('Mock Thread not found');
    const turnId = '01910000-0000-7000-8000-00000000fc01';
    const itemId = '01910000-0000-7000-8000-00000000fc02';
    target.__LIN_E2E__?.emitAgentCoreNotification({
      type: 'turn/completed',
      threadId,
      turnId,
      turn: {
        id: turnId,
        items: [{
          id: itemId,
          type: 'agentMessage',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
          text: Array.from({ length: 100 }, (_, index) => `Rejected send evidence ${index + 1}.`).join('\n\n'),
          phase: 'final_answer',
          memoryCitation: null,
        }],
        itemsView: 'full',
        provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    });
  });

  const transcript = page.locator('.thread-transcript');
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const savedTop = await transcript.evaluate((element) => {
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.max(1, Math.floor(maximum / 2));
    element.dispatchEvent(new Event('scroll'));
    return element.scrollTop;
  });
  const composer = page.getByRole('textbox', { name: 'Message this Thread' });
  await composer.fill('Keep my reading position when this fails.');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.locator('.thread-inline-error')).toContainText('Mock turn/start rejection');
  await expect(composer).toHaveText('Keep my reading position when this fails.');
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(savedTop - 2);
  await expect.poll(() => transcript.evaluate((element) => element.scrollTop))
    .toBeLessThan(savedTop + 2);
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
});

test('aborts an in-flight pathless upload when its Thread is left', async ({ page }) => {
  await openMockedApp(page, { attachmentUploadDelayMs: 200 });
  await page.locator('.thread-composer-file-input').setInputFiles({
    name: 'pending.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(2 * 1024 * 1024),
  });
  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/begin').length
  )).toBe(1);

  await createNewThread(page);

  await expect.poll(async () => (
    (await commandCalls(page)).filter((call) => call.cmd === 'attachment-upload/abort').length
  )).toBe(1);
  expect((await commandCalls(page)).some((call) => call.cmd === 'attachment-upload/finish')).toBe(false);
});

test('opens provider settings instead of creating a Thread when no provider is usable', async ({ page }) => {
  await openMockedApp(page, { agentProviderUsable: false });

  await page.getByRole('button', { name: 'Show Threads' }).click();
  await expect(page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open Providers' }).click();

  const calls = await commandCalls(page);
  // Model services is a page inside Agent now, so the dock's CTA opens it
  // directly rather than landing on a category and leaving the user to find it.
  expect(calls).toContainEqual({ cmd: 'open_settings', args: { page: 'services' } });
  expect(calls.some((call) => call.cmd === 'thread/start')).toBe(false);
});

test.describe('terminal Thread history actions', () => {
  test('revises an attachment-only failed Turn through same-Thread Edit', async ({ page }) => {
    await openMockedApp(page, {
      agentTurnFailure: 'OpenRouter API error (404): {"error":{"message":"No endpoints found for gpt-5.4"},"request_id":"private"}',
    });
    await createNewThread(page);
    await page.locator('.thread-composer-file-input').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: Buffer.from('mock image'),
    });
    await expect(page.locator('.thread-composer-inline-ref')).toContainText('diagram.png');
    await page.getByRole('button', { name: 'Send' }).click();
    const response = page.locator('.thread-agent-message-response');
    const error = response.locator('.thread-response-error');
    await expect(error).toHaveText('HTTP 404 - No endpoints found for gpt-5.4');
    await expect(response).not.toContainText('request_id');
    await response.hover();
    const actions = response.locator('.thread-response-actions');
    expect(await actions.getByRole('button').evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute('aria-label'))
    ))).toEqual([
      // A failure the user did not cause leads with the way out of it.
      'Retry',
      'Copy message',
      'Continue in new chat',
      'Details',
    ]);
    const [errorBox, actionsBox] = await Promise.all([error.boundingBox(), actions.boundingBox()]);
    expect(errorBox).toBeTruthy();
    expect(actionsBox).toBeTruthy();
    expect(actionsBox!.y).toBeGreaterThanOrEqual(errorBox!.y + errorBox!.height - 1);
    await actions.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe('HTTP 404 - No endpoints found for gpt-5.4');

    const userMessage = page.locator('.thread-user-message').last();
    await expect(userMessage.locator('.thread-message-file-ref')).toHaveText('diagram.png');
    await expect(userMessage.locator('.thread-image-gallery-preview')).toHaveAccessibleName('diagram.png');
    await userMessage.hover();
    await userMessage.getByRole('button', { name: 'Edit message' }).click();
    const editor = userMessage.getByRole('textbox', { name: 'Edit message' });
    await editor.fill('Try the attachment again');
    await editor.press('Control+Enter');

    const calls = await commandCalls(page);
    const starts = calls.filter((call) => call.cmd === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.args.input).toEqual([
      { type: 'text', text: 'Try the attachment again' },
      expect.objectContaining({ type: 'attachment', name: 'diagram.png', mimeType: 'image/png' }),
    ]);
    expect(calls.filter((call) => call.cmd === 'thread/rollback')).toHaveLength(1);
    expect(calls.filter((call) => call.cmd === 'thread/fork')).toHaveLength(0);
  });

  test('keeps an interrupted partial response without Retry or Regenerate', async ({ page }) => {
    await openMockedApp(page);
    await createNewThread(page);
    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000fa01';
      const userItemId = '01910000-0000-7000-8000-00000000fa02';
      const responseItemId = '01910000-0000-7000-8000-00000000fa03';
      target.__LIN_E2E__?.emitAgentCoreNotification({
        type: 'turn/completed',
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [
            {
              id: userItemId,
              type: 'userMessage',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: userItemId },
              clientId: null,
              acceptedAt: 1,
              content: [{ type: 'text', text: 'Stop after a partial answer.' }],
            },
            {
              id: responseItemId,
              type: 'agentMessage',
              provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: responseItemId },
              text: 'This partial answer remains visible.',
              phase: 'final_answer',
              memoryCitation: null,
            },
          ],
          itemsView: 'full',
          provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
          status: 'interrupted',
          error: null,
          startedAt: 10,
          completedAt: 20,
          durationMs: 10,
        },
      });
    });

    const response = page.locator('.thread-agent-message').last();
    await expect(response).toContainText('This partial answer remains visible.');
    await expect(response.locator('.thread-response-stopped')).toHaveText('Turn interrupted');
    await response.hover();
    await expect(response.getByRole('button', { name: 'Retry response' })).toHaveCount(0);
    await expect(response.getByRole('button', { name: 'Regenerate response' })).toHaveCount(0);
    await expect(response.getByRole('button', { name: 'Continue in new chat' })).toBeVisible();
  });
});
