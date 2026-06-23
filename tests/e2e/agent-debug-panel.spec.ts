import { expect, test } from '@playwright/test';
import { commandCalls, openMockedApp, openMockRunDetailsFromAssistantDetailsButton } from './outlinerMock';

test.describe('agent debug panel', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('shows a run-focused detail pane with context, process, and usage', async ({ page }) => {
    await openMockRunDetailsFromAssistantDetailsButton(page);

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');
    await expect(debugPanel.getByRole('heading', { name: 'Run Details' })).toBeVisible();
    await expect(debugPanel).toHaveCSS('background-color', 'rgb(255, 255, 255)');

    // Overview: Channel shape + the conversation's run/token rollup.
    await expect(debugPanel.getByRole('heading', { name: 'Summary' })).toBeVisible();
    const overview = debugPanel.getByLabel('Agent debug overview');
    await expect(overview).toContainText('Channel');
    await expect(overview).toContainText('66k');

    await expect(debugPanel.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
    await expect(debugPanel.getByText('Turns')).toBeVisible();
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
    await openMockRunDetailsFromAssistantDetailsButton(page);

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

  test('shows token and cost preview when hovering the assistant Details button', async ({ page }) => {
    const replyText = 'Open the details pane from this response.';
    await openMockRunDetailsFromAssistantDetailsButton(page, replyText, { openDetails: false });

    const row = page.locator('.agent-message-row.assistant', { hasText: replyText });
    await row.getByRole('button', { name: 'Details' }).hover();

    const preview = page.getByRole('tooltip');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Tokens and cost');
    await expect(preview).toContainText('66,420');
    await expect(preview).toContainText('$0.00050');
    await expect(preview).toContainText('48,000');
  });

  test('opens selected run details from an assistant Details button', async ({ page }) => {
    await openMockRunDetailsFromAssistantDetailsButton(page);

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');
    await expect(debugPanel.getByRole('heading', { name: 'Run Details' })).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Context' })).toBeVisible();
    await expect(debugPanel.getByText('System prompt')).toBeVisible();
    await expect(debugPanel.getByText('Tools · 1')).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Usage' })).toBeVisible();
    await expect(debugPanel).toContainText('Cache hit');
  });
});
