import { expect, test } from '@playwright/test';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
import { emitAgentEvent, emitAgentProjection, openMockedApp } from './outlinerMock';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test.describe('provider retry transcript status', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await expect.poll(async () => page.evaluate(() => {
      const win = window as Window & { __LIN_E2E__?: { calls: Array<{ cmd: string }> } };
      return win.__LIN_E2E__?.calls.some((call) => call.cmd.startsWith('agent_restore')) ?? false;
    })).toBe(true);
  });

  test('updates one tail row and puts an exhausted error after generated content', async ({ page }) => {
    const user = {
      role: 'user',
      content: [{ type: 'text', text: 'Summarize the current retry behavior.' }],
      timestamp: 1_800_000_000_100,
    };
    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'General',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [{ nodeId: 'retry-user', message: user, branches: null }],
      messages: [user],
      isStreaming: true,
      errorMessage: null,
    });

    await emitAgentEvent(page, {
      type: 'provider_retry',
      conversationId: DEFAULT_GENERAL_CHANNEL_ID,
      runId: 'run-e2e',
      phase: 'retrying',
      kind: 'request',
      attempt: 1,
      maxRetries: 4,
      timestamp: 1_800_000_000_101,
    });

    const status = page.locator('.agent-provider-retry-status');
    await expect(status).toHaveCount(1);
    await expect(status).toHaveText('Reconnecting 1/4');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    const placement = await status.evaluate((element) => ({
      followsTranscript: element.previousElementSibling?.classList.contains('agent-chat-transcript') ?? false,
      insideScroll: element.parentElement?.classList.contains('agent-chat-scroll') ?? false,
    }));
    expect(placement).toEqual({ followsTranscript: true, insideScroll: true });
    const [statusBox, composerBox] = await Promise.all([
      status.boundingBox(),
      page.locator('.agent-composer-region').boundingBox(),
    ]);
    expect(statusBox).toBeTruthy();
    expect(composerBox).toBeTruthy();
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(composerBox!.y);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const retrySpinnerIterations = await status.locator('.agent-provider-retry-spinner').evaluate((element) => (
      getComputedStyle(element).animationIterationCount
    ));
    expect(retrySpinnerIterations).toBe('1');

    await emitAgentEvent(page, {
      type: 'provider_retry',
      conversationId: DEFAULT_GENERAL_CHANNEL_ID,
      runId: 'run-e2e',
      phase: 'retrying',
      kind: 'request',
      attempt: 2,
      maxRetries: 4,
      timestamp: 1_800_000_000_102,
    });
    await expect(status).toHaveCount(1);
    await expect(status).toHaveText('Reconnecting 2/4');

    await emitAgentEvent(page, {
      type: 'provider_retry',
      conversationId: DEFAULT_GENERAL_CHANNEL_ID,
      runId: 'run-e2e',
      phase: 'cleared',
      kind: 'request',
      attempt: 2,
      maxRetries: 4,
      timestamp: 1_800_000_000_103,
    });
    await expect(status).toHaveCount(0);

    const failedAssistant = {
      role: 'assistant',
      api: 'openai-responses',
      provider: 'openai',
      model: 'gpt-5.4',
      usage,
      stopReason: 'error',
      errorMessage: 'OpenAI API error (524): upstream timeout',
      timestamp: 1_800_000_000_104,
      content: [
        { type: 'thinking', thinking: 'Checked the provider response and retry budget.' },
        { type: 'text', text: 'The provider returned part of the requested summary.' },
      ],
    };
    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'General',
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [
        { nodeId: 'retry-user', message: user, branches: null },
        { nodeId: 'retry-assistant', message: failedAssistant, branches: null, runId: 'run-e2e' },
      ],
      messages: [user, failedAssistant],
      isStreaming: false,
      errorMessage: null,
    }, 2);

    const assistantContent = page.locator('.agent-message-row.assistant .agent-assistant-content').last();
    const order = await assistantContent.evaluate((element) => {
      const children = Array.from(element.children);
      return {
        answer: children.findIndex((child) => child.classList.contains('agent-markdown')),
        error: children.findIndex((child) => child.classList.contains('agent-message-error')),
        actions: children.findIndex((child) => child.classList.contains('agent-message-actions')),
      };
    });
    expect(order.answer).toBeGreaterThanOrEqual(0);
    expect(order.error).toBeGreaterThan(order.answer);
    expect(order.actions).toBeGreaterThan(order.error);
    const error = assistantContent.locator('.agent-message-error');
    const actions = assistantContent.locator('.agent-message-actions');
    const [errorBox, actionsBox] = await Promise.all([error.boundingBox(), actions.boundingBox()]);
    expect(errorBox).toBeTruthy();
    expect(actionsBox).toBeTruthy();
    expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(actionsBox!.y);
    await expect(actions.getByRole('button').first())
      .toHaveAttribute('aria-label', 'Retry response');
    await expect(page.locator('.agent-chat-scroll > .agent-message-error')).toHaveCount(0);
  });
});
