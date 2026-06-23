import { expect, test } from '@playwright/test';
import { commandCalls, openMockedApp, openMockRunDetailsFromAssistantDetailsButton } from './outlinerMock';

test.describe('agent debug panel', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('shows a run-focused detail pane with model input and execution separated', async ({ page }) => {
    await openMockRunDetailsFromAssistantDetailsButton(page);

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');
    await expect(debugPanel.getByRole('heading', { name: 'Run Details' })).toBeVisible();
    await expect(debugPanel).toHaveCSS('background-color', 'rgb(255, 255, 255)');

    await expect(debugPanel.locator('.agent-debug-run-summary')).toContainText('assistant');
    await expect(debugPanel.locator('.agent-debug-run-summary')).toContainText('gpt-5.4');
    await expect(debugPanel.getByRole('heading', { name: 'Summary' })).toBeVisible();
    const identifiers = debugPanel.locator('.agent-debug-run-summary details.agent-debug-disclosure', { hasText: 'Identifiers' });
    await identifiers.locator('summary').click();
    await expect(identifiers).toContainText('mock-run-1');
    await expect(debugPanel.getByText('Metadata')).toHaveCount(0);
    await expect(debugPanel.locator('.agent-debug-run-selector-button')).toHaveCount(0);

    await expect(debugPanel.getByRole('heading', { name: 'Model Input', exact: true })).toBeVisible();
    const context = debugPanel.locator('.agent-debug-context-card');
    await expect(context.getByText('System prompt')).toBeVisible();
    const systemPrompt = context.locator('pre').first();
    await expect(systemPrompt).toBeVisible();
    await expect.poll(async () => systemPrompt.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect(context.getByText('Tools · 1')).toBeVisible();
    await expect(context).toContainText('Messages · 1');
    await expect(context.locator('.agent-debug-message-list')).toContainText('Summarize current outline.');

    await expect(debugPanel.getByRole('heading', { name: 'Execution · 1' })).toBeVisible();
    const round = debugPanel.locator('.agent-debug-round-card').first();
    await expect(round.getByRole('heading', { name: 'Model call 1' })).toBeVisible();
    await expect(round.locator('.agent-debug-round-request')).toHaveCount(0);
    await expect(round).not.toContainText('Messages · 1');
    await expect(round).toContainText('Current outline focuses on UI work.');
    await expect(round).toContainText('Usage');

    const roundUsage = round.locator('details.agent-debug-disclosure', { hasText: 'Usage' });
    await roundUsage.locator('summary').click();
    await expect(round).toContainText('Input context');
    await expect(round).toContainText('66k');
    await expect(round).toContainText('Cache hit');
    await expect(round).toContainText('89%');
    await expect(round).toContainText('Cached share');
    await expect(round).toContainText('73%');
    await expect(round.getByLabel('Input context cache composition')).toBeVisible();
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
    await expect(debugPanel.getByRole('heading', { name: 'Summary' })).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Model Input', exact: true })).toBeVisible();
    await expect(debugPanel.getByText('System prompt')).toBeVisible();
    await expect(debugPanel.getByText('Tools · 1')).toBeVisible();
    await expect(debugPanel.getByText('Messages · 1')).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Execution · 1' })).toBeVisible();
  });
});
