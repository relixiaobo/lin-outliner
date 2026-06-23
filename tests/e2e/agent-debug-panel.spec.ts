import { expect, test } from '@playwright/test';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
import { commandCalls, emitAgentProjection, openMockedApp } from './outlinerMock';

test.describe('agent debug panel', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('shows a run-focused detail pane with context, process, and usage', async ({ page }) => {
    await page.getByRole('button', { name: 'Open agent debug' }).click();

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');
    await expect(debugPanel.getByRole('heading', { name: 'Run Details' })).toBeVisible();
    await expect(debugPanel).toHaveCSS('background-color', 'rgb(255, 255, 255)');

    // Overview: Channel shape + the conversation's run/token rollup.
    const overview = debugPanel.getByLabel('Agent debug overview');
    await expect(overview).toContainText('Channel');
    await expect(overview).toContainText('66k');

    const runSelector = debugPanel.locator('.agent-debug-run-selector-button').first();
    await expect(runSelector).toContainText('assistant');
    await expect(runSelector).toContainText('gpt-5.4');
    await expect(runSelector).toContainText('1 round');

    // The selected run detail leads with the actual model-facing request context.
    await expect(debugPanel.getByRole('heading', { name: 'Context' })).toBeVisible();
    await expect(debugPanel.getByText('System prompt')).toBeVisible();
    await expect(debugPanel.getByText('Tools · 1')).toBeVisible();
    await expect(debugPanel.locator('.agent-debug-message-list')).toContainText('Summarize current outline.');

    // Process and usage are secondary sections below the context.
    await expect(debugPanel.getByRole('heading', { name: 'Process' })).toBeVisible();
    const round = debugPanel.locator('.agent-debug-round-card').first();
    await expect(round.getByRole('heading', { name: 'Round 1' })).toBeVisible();
    await expect(round).toContainText('Current outline focuses on UI work.');
    await expect(debugPanel.getByRole('heading', { name: 'Usage' })).toBeVisible();
    await expect(debugPanel).toContainText('Input context');
    await expect(debugPanel).toContainText('66k');
    await expect(debugPanel).toContainText('Cache hit');
    await expect(debugPanel).toContainText('89%');
    await expect(debugPanel).toContainText('Cached share');
    await expect(debugPanel).toContainText('73%');
    await expect(debugPanel.getByLabel('Input context cache composition')).toBeVisible();
  });

  test('adds a user block rule from a logged tool exchange', async ({ page }) => {
    await page.getByRole('button', { name: 'Open agent debug' }).click();

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');

    const exchange = debugPanel.locator('.agent-debug-tool-exchange', { hasText: 'bash' }).first();
    await expect(exchange).toContainText('Pushed to origin/main.');

    await exchange.getByRole('button', { name: 'Add to user blocks' }).click();
    await expect(exchange.getByRole('button', { name: /User block added: Command\(git push origin main\)/ })).toBeVisible();

    await expect.poll(async () => {
      const appendCall = (await commandCalls(page)).findLast((call) => call.cmd === 'agent_append_tool_permission_block');
      return appendCall?.args.ruleValue;
    }).toBe('Command(git push origin main)');
  });

  test('opens selected run details from an assistant More menu', async ({ page }) => {
    await emitAgentProjection(page, DEFAULT_GENERAL_CHANNEL_ID, {
      conversationTitle: 'General',
      members: [
        { principal: { type: 'user', userId: 'local-user' }, mention: '', displayName: 'You' },
        {
          principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
          mention: 'assistant',
          displayName: 'Neva',
          coordinator: true,
        },
      ],
      model: { id: 'gpt-5.4', provider: 'openai' },
      conversation: [
        {
          nodeId: 'agent-user-more-details',
          actor: { type: 'user', userId: 'local-user' },
          message: {
            role: 'user',
            timestamp: 1_800_000_000_000,
            content: [{ type: 'text', text: 'Summarize current outline.' }],
          },
        },
        {
          nodeId: 'assistant-more-details',
          runId: 'mock-run-1',
          actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
          message: {
            role: 'assistant',
            timestamp: 1_800_000_000_100,
            api: 'openai-completions',
            provider: 'openai',
            model: 'gpt-5.4',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'Open the details pane from this response.' }],
          },
        },
      ],
    });

    const row = page.locator('.agent-message-row.assistant', { hasText: 'Open the details pane from this response.' });
    await row.hover();
    await row.getByRole('button', { name: 'More reply actions' }).click();

    const menu = page.getByRole('menu', { name: 'More reply actions' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Details' }).click();

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');
    await expect(debugPanel.getByRole('heading', { name: 'Run Details' })).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Context' })).toBeVisible();
    await expect(debugPanel.getByText('System prompt')).toBeVisible();
    await expect(debugPanel.getByText('Tools · 1')).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Usage' })).toBeVisible();
    await expect(debugPanel).toContainText('Cache hit');
  });
});
