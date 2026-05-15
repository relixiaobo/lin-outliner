import { expect, test } from '@playwright/test';
import { commandCalls, emitAgentEvent, openMockedApp } from './outlinerMock';

async function waitForAgentSession(page: import('@playwright/test').Page) {
  await expect.poll(async () => {
    const calls = await commandCalls(page);
    return calls.some((call) => call.cmd === 'agent_restore_latest_session');
  }).toBe(true);
}

test.describe('agent composer controls', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await waitForAgentSession(page);
  });

  test('sends from the primary action and keeps attachment chips removable', async ({ page }) => {
    const input = page.getByLabel('Agent message');
    await input.fill('Summarize current outline.');
    await page.getByRole('button', { name: 'Send message' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_send_message')?.args;
    }).toMatchObject({
      message: 'Summarize current outline.',
      sessionId: 'mock-agent-session',
    });

    await page.locator('.agent-composer-file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello from test'),
    });
    await expect(page.getByText('notes.txt')).toBeVisible();

    await page.getByRole('button', { name: 'Remove notes.txt' }).click();
    await expect(page.getByText('notes.txt')).toHaveCount(0);
  });

  test('uses shared menu semantics for model and reasoning controls', async ({ page }) => {
    const modelButton = page.getByRole('button', { name: 'Select model' });
    await expect(modelButton).toHaveAttribute('aria-expanded', 'false');
    await modelButton.click();
    await expect(modelButton).toHaveAttribute('aria-expanded', 'true');

    const menu = page.getByRole('menu', { name: 'Model and reasoning settings' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'GPT-5.4', exact: true })).toBeVisible();
    await expect(menu.getByRole('switch', { name: 'Thinking' })).toHaveAttribute('aria-checked', 'true');

    await menu.getByRole('menuitem', { name: 'GPT-5.4 Mini', exact: true }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => (
        call.cmd === 'agent_upsert_provider_config'
        && call.args.provider
        && typeof call.args.provider === 'object'
        && 'modelId' in call.args.provider
        && call.args.provider.modelId === 'gpt-5.4-mini'
      ));
    }).toBe(true);

    await modelButton.click();
    await page.getByRole('button', { name: 'Thinking level' }).click();
    const thinkingLevels = page.getByRole('menu', { name: 'Thinking levels' });
    await expect(thinkingLevels.getByRole('menuitemradio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
    await thinkingLevels.getByRole('menuitemradio', { name: 'High' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => (
        call.cmd === 'agent_upsert_provider_config'
        && call.args.provider
        && typeof call.args.provider === 'object'
        && 'reasoningLevel' in call.args.provider
        && call.args.provider.reasoningLevel === 'high'
      ));
    }).toBe(true);
  });

  test('switches the primary action between stop and queued follow-up while streaming', async ({ page }) => {
    await emitAgentEvent(page, {
      type: 'snapshot',
      sessionId: 'mock-agent-session',
      state: {
        sessionTitle: 'Agent System',
        systemPrompt: '',
        model: { id: 'gpt-5.4', provider: 'openai' },
        thinkingLevel: 'medium',
        messages: [],
        conversation: [],
        streamingMessage: null,
        isStreaming: true,
        pendingToolCallIds: [],
        errorMessage: null,
      },
    });

    await page.getByRole('button', { name: 'Stop agent' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'agent_stop_session');
    }).toBe(true);

    await page.getByLabel('Agent message').fill('Compare tag layout stability.');
    await page.getByRole('button', { name: 'Queue follow-up' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_queue_follow_up')?.args;
    }).toMatchObject({
      message: 'Compare tag layout stability.',
      sessionId: 'mock-agent-session',
    });
    await expect(page.getByText('Compare tag layout stability.')).toBeVisible();
  });
});
