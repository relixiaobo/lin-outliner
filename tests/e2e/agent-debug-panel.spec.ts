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

    await expect(debugPanel.getByText('mock-run-1').first()).toBeVisible();
    await expect(debugPanel.locator('.agent-debug-run-summary')).toContainText('assistant');
    await expect(debugPanel.locator('.agent-debug-run-summary')).toContainText('gpt-5.4');
    await expect(debugPanel.getByRole('heading', { name: 'Summary' })).toHaveCount(0);
    await expect(debugPanel.locator('.agent-debug-run-selector-button')).toHaveCount(0);

    await expect(debugPanel.getByRole('heading', { name: 'Context', exact: true })).toBeVisible();
    await expect(debugPanel.getByText('System prompt')).toBeVisible();
    await expect(debugPanel.getByText('Tools · 1')).toBeVisible();

    await expect(debugPanel.getByRole('heading', { name: 'Rounds · 1' })).toBeVisible();
    const round = debugPanel.locator('.agent-debug-round-card').first();
    await expect(round.getByRole('heading', { name: 'Round 1' })).toBeVisible();
    await expect(round).toContainText('New context · 1 message');
    await expect(round.locator('.agent-debug-message-list')).toContainText('Summarize current outline.');
    await expect(round).toContainText('Current outline focuses on UI work.');
    await expect(round).toContainText('Usage');
    await expect(round).toContainText('Input context');
    await expect(round).toContainText('66k');
    await expect(round).toContainText('Cache hit');
    await expect(round).toContainText('89%');
    await expect(round).toContainText('Cached share');
    await expect(round).toContainText('73%');
    await expect(round.getByLabel('Input context cache composition')).toBeVisible();
    await expect(debugPanel.getByText('Metadata')).toBeVisible();
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
    await expect(debugPanel.getByRole('heading', { name: 'Context', exact: true })).toBeVisible();
    await expect(debugPanel.getByText('System prompt')).toBeVisible();
    await expect(debugPanel.getByText('Tools · 1')).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();
    await expect(debugPanel).toContainText('Cache hit');
  });
});
