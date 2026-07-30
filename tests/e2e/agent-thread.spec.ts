import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clipboardText, commandCalls, ids, openMockedApp, rowBody } from './outlinerMock';

const FORMER_SHARED_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;

async function createNewThread(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show Threads' }).click();
  await page.getByRole('dialog', { name: 'Threads' })
    .getByRole('button', { name: 'New Thread' })
    .click();
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
    await expect(process.locator('.thread-tool').filter({ hasText: 'node_read' })).toBeVisible();
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
    await expect(liveTurn.getByLabel('Assistant is responding')).toBeVisible();
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
    await expect(selectedFork).toHaveCSS('--thread-depth', '0');

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
    await page.getByRole('menuitem', { name: 'Send to composer' }).click();

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
    await page.getByRole('menuitem', { name: 'Send to composer' }).click();
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

    await showAll.click();
    await expect(gallery.locator('.thread-image-gallery-tile')).toHaveCount(6);
    await expect(gallery).toHaveAttribute('data-layout-count', 'many');
    await expect(showAll).toHaveCount(0);
    const showFewer = gallery.getByRole('button', { name: 'Show fewer images' });
    await expect(showFewer).toBeVisible();
    await showFewer.click();
    await expect(gallery.locator('.thread-image-gallery-tile')).toHaveCount(4);
    await expect(gallery).toHaveAttribute('data-layout-count', '4');
    await expect(gallery.getByRole('button', { name: 'Show all 6 images' })).toBeVisible();

    await page.setViewportSize({ width: 420, height: 760 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(gallery).toBeInViewport();
    const overflowContrast = await gallery.getByRole('button', { name: 'Show all 6 images' }).evaluate((element) => {
      const buttonStyle = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        background: buttonStyle.backgroundColor,
        backdropFilter: buttonStyle.backdropFilter,
        foreground: buttonStyle.color,
        expectedBackground: rootStyle.getPropertyValue('--media-hud-bg').trim(),
        expectedForeground: rootStyle.getPropertyValue('--media-hud-fg').trim(),
      };
    });
    expect(overflowContrast.background).toBe(overflowContrast.expectedBackground);
    expect(overflowContrast.backdropFilter).toBe('none');
    expect(overflowContrast.foreground).toBe(overflowContrast.expectedForeground);
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
    const overflowBadge = gallery.getByRole('button', { name: 'Show all 6 images' });
    const interactionBackgrounds = await overflowBadge.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        hover: rootStyle.getPropertyValue('--media-hud-hover-bg').trim(),
        active: rootStyle.getPropertyValue('--media-hud-active-bg').trim(),
      };
    });
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

  test('keeps Subagent Threads inspectable without exposing a direct composer', async ({ page }) => {
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

    await page.getByRole('button', { name: 'Open Subagent Thread /root/research' }).click();
    await expect(page.locator('.thread-dock-title')).toHaveText('Research child');
    await expect(page.getByRole('textbox', { name: 'Message this Thread' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Show Threads' }).click();
    const childRow = page.getByRole('dialog', { name: 'Threads' }).locator('.thread-list-row').filter({ hasText: 'Research child' });
    await expect(childRow.getByRole('button', { name: /Research child/ })).toBeVisible();
    await expect(childRow).toHaveCSS('--thread-depth', '1');
    await expect(childRow.locator('small')).toContainText('Subagent · research [explorer]');
  });

  test('renders reasoning and grouped tool Items with disclosure and copy interactions', async ({ page }) => {
    await createNewThread(page);
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
            arguments: { node_id: 'node-alpha', file_path: 'notes.md' },
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
    await process.click();

    const thought = page.locator('.thread-reasoning-toggle').first();
    await expect(thought).toBeVisible();
    await expect(thought).toHaveAccessibleName(/Thought.*Inspect the current workspace/);
    await expect(thought.locator('.thread-reasoning-headline')).toHaveCSS('font-weight', '400');
    await expect(thought.locator('.thread-reasoning-gist')).toHaveCSS('font-weight', '400');
    const thoughtChevron = thought.locator('.thread-reasoning-chevron');
    await expect(thoughtChevron).toHaveCSS('opacity', '0');
    const activity = page.getByRole('button', { name: 'Ran a command · read a node' });
    const [thoughtBox, activityBox] = await Promise.all([thought.boundingBox(), activity.boundingBox()]);
    expect(thoughtBox).toBeTruthy();
    expect(activityBox).toBeTruthy();
    expect(Math.abs(thoughtBox!.x - activityBox!.x)).toBeLessThan(1);
    await thought.hover();
    await expect(thoughtChevron).toHaveCSS('opacity', '1');
    await thought.click();
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(thoughtChevron).toHaveCSS('opacity', '1');
    const reasoningBody = page.locator('.thread-reasoning-body');
    await expect(reasoningBody).toContainText('Inspect the current workspace');
    await expect(reasoningBody).toContainText('The workspace has enough evidence.');
    await expect(reasoningBody.locator('p')).toHaveCount(2);
    const [thoughtHeadlineBox, reasoningBodyBox] = await Promise.all([
      thought.locator('.thread-reasoning-headline').boundingBox(),
      reasoningBody.boundingBox(),
    ]);
    expect(thoughtHeadlineBox).toBeTruthy();
    expect(reasoningBodyBox).toBeTruthy();
    expect(Math.abs(thoughtHeadlineBox!.x - reasoningBodyBox!.x)).toBeLessThan(1);
    const singleLineThought = page.locator('.thread-reasoning-toggle').nth(1);
    await expect(singleLineThought).toHaveAccessibleName(/Thought.*Preparing the final response/);
    await expect(singleLineThought).toHaveAttribute('aria-expanded', 'false');
    await singleLineThought.click();
    await expect(singleLineThought).toHaveAttribute('aria-expanded', 'true');
    await expect(singleLineThought.locator('xpath=..').locator('.thread-reasoning-body'))
      .toHaveText('Preparing the final response');

    const activityStatus = activity.locator('.thread-disclosure-status');
    const activityChevron = activity.locator('.thread-disclosure-chevron');
    await expect(activityStatus).toHaveCSS('opacity', '1');
    await expect(activityChevron).toHaveCSS('opacity', '0');
    await activity.hover();
    await expect(activityStatus).toHaveCSS('opacity', '0');
    await expect(activityChevron).toHaveCSS('opacity', '1');
    await activity.click();
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
    await command.click();
    await expect(command.locator('xpath=..')).not.toContainText('exit 0');
    await expect(command.locator('xpath=..').getByRole('button', { name: 'Copy output' })).toHaveCount(1);
    await command.locator('xpath=..').locator('.thread-tool-section').last().locator('.agent-code-block').hover();
    await page.getByRole('button', { name: 'Copy output' }).click();
    expect(await clipboardText(page)).toBe('/mock/workspace');

    const commandPaths = command.locator('xpath=..').locator('.thread-tool-path-reference');
    await expect(commandPaths).toHaveCount(1);
    await expect(commandPaths).toHaveAttribute('data-inline-ref-path', '/mock/workspace');
    const nodeTool = page.getByRole('button', { name: 'Used node.read' });
    await nodeTool.click();
    const relativePath = nodeTool.locator('xpath=..').locator('.thread-tool-path-reference');
    await expect(relativePath).toHaveAttribute('data-inline-ref-path', '/mock/workspace/notes.md');
    await relativePath.click();
    await expect(page.locator('.outline-panel-surface.active-panel.is-file-preview'))
      .toContainText('Mock preview text.');

    await page.getByRole('button', { name: 'Copy message' }).click();
    expect(await clipboardText(page)).toBe([
      '```tool bash',
      JSON.stringify({ command: 'pwd', cwd: '/mock/workspace' }, null, 2),
      '```',
      '',
      '```tool-result',
      '/mock/workspace',
      '```',
      '',
      '```tool node.read',
      JSON.stringify({ node_id: 'node-alpha', file_path: 'notes.md' }, null, 2),
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
    await expect(commandDetails).toContainText('Command failed with exit code 2');
    await expect(commandDetails).not.toContainText('exit 2');
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
    await expect(progress).toHaveText('Step 2 / 24');
    await expect(progress).toHaveAttribute('aria-expanded', 'false');
    await progress.hover();
    const checklist = page.locator('.thread-plan-progress-popover');
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText('Working through the interaction contract');
    await expect(checklist.locator('li')).toHaveCount(24);
    await expect(checklist.locator('li').first()).toHaveText('Inspect the current behavior');
    await expect(checklist.locator('li').last()).toHaveText('Verify interaction checkpoint 24');
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
    await expect(progress).toBeFocused();
    await expect(checklist).not.toBeVisible();

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
            content: [],
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

    const thought = page.getByRole('button', { name: 'Thought' });
    await expect(thought).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('The outline is currently empty.', { exact: true })).toBeVisible();
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
    await transcript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll'));
    });

    await page.evaluate(async () => {
      const target = window as Window & {
        lin?: { agentCoreRequest: <T>(method: string, input?: Record<string, unknown>) => Promise<T> };
        __LIN_E2E__?: { emitAgentCoreNotification: (notification: unknown) => void };
      };
      const response = await target.lin?.agentCoreRequest<{ data: Array<{ id: string }> }>('thread/list', {});
      const threadId = response?.data[0]?.id;
      if (!threadId) throw new Error('Mock Thread not found');
      const turnId = '01910000-0000-7000-8000-00000000ef01';
      const itemId = '01910000-0000-7000-8000-00000000ef02';
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
    });

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
    const savedTop = await transcript.evaluate((element) => {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      const top = Math.max(1, Math.min(480, Math.floor(maximum / 2)));
      element.scrollTop = top;
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop;
    });
    expect(savedTop).toBeGreaterThan(0);

    await createNewThread(page);
    await page.getByRole('button', { name: 'Show Threads' }).click();
    await page.getByRole('dialog', { name: 'Threads' })
      .locator('.thread-list-select')
      .filter({ hasText: 'Long history' })
      .click();

    await expect(page.locator('.thread-dock-title')).toContainText('Long history');
    await expect(page.locator('.thread-transcript-turns')).toHaveAttribute('data-virtualized', 'true');
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(savedTop - 2);
    await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBeLessThan(savedTop + 2);
  });
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
  expect(calls).toContainEqual({ cmd: 'open_settings', args: { category: 'providers' } });
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
