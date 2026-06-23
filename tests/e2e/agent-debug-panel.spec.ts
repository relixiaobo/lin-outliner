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
    await expect(context).toHaveCSS('border-left-width', '0px');
    await expect(context.getByText('System prompt')).toBeVisible();
    const systemPromptDisclosure = context.locator('details.agent-debug-disclosure', { hasText: 'System prompt' }).first();
    const systemPrompt = systemPromptDisclosure.locator('pre').first();
    await expect(systemPrompt).toBeHidden();
    await systemPromptDisclosure.locator('summary').click();
    await expect(systemPrompt).toBeVisible();
    await expect.poll(async () => systemPrompt.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect(context.getByText('Tools · 1')).toBeVisible();
    await expect(context.getByText('Message window · 3')).toHaveCount(0);
    const history = context.locator('details.agent-debug-disclosure', { hasText: 'History · 2' });
    await expect(history.locator(':scope > summary')).toBeVisible();
    await history.locator(':scope > summary').click();
    await expect(history).toContainText('Generate a PPT about Fable 5.');
    await expect(history).toContainText('PPT generated with 11 slides.');
    const currentRequest = context.locator('details.agent-debug-disclosure', { hasText: 'Current request' });
    await expect(currentRequest.locator(':scope > summary')).toBeVisible();
    await expect(currentRequest).toContainText('Summarize current outline.');

    await expect(debugPanel.getByRole('heading', { name: 'Execution · 1' })).toBeVisible();
    const round = debugPanel.locator('.agent-debug-round-card').first();
    await expect(round.getByRole('heading', { name: 'Call 1' })).toBeVisible();
    await expect(round).toHaveCSS('border-left-width', '0px');
    await expect(round.locator('.agent-debug-section-header .agent-debug-status-pill')).toHaveCount(0);
    await expect(round.locator('.agent-debug-section-header > code')).toHaveCount(0);
    await expect(round.locator('.agent-debug-role-label')).toHaveCount(0);
    await expect(round.locator('.agent-debug-message-row')).toHaveCount(0);
    await expect(round.locator('.agent-debug-round-request')).toHaveCount(0);
    await expect(round).not.toContainText('History · 2');
    await expect(round).toContainText('Current outline focuses on UI work.');
    const outputRow = round.locator('.agent-debug-execution-event', { hasText: 'assistant text' }).first();
    await expect(outputRow).not.toContainText('tool_call bash');
    await expect(round.locator('.agent-debug-execution-event', { hasText: 'tool_call bash' })).toContainText('git push origin main');
    await expect(round.locator('.agent-debug-execution-event', { hasText: 'tool_result bash' })).toContainText('Pushed to origin/main.');
    await expect(round.locator('.agent-debug-tool-exchange', { hasText: 'bash' })).toContainText('Pushed to origin/main.');
    await round.locator('summary.agent-debug-section-header').click();
    await expect(outputRow).not.toBeVisible();
    await round.locator('summary.agent-debug-section-header').click();
    await expect(outputRow).toBeVisible();
    await expect.poll(async () => debugPanel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await expect(round.locator('details.agent-debug-disclosure', { hasText: 'Usage' })).toHaveCount(0);

    await round.getByRole('button', { name: 'Call details' }).hover();
    const roundDetails = round.getByRole('tooltip', { name: 'Call details' });
    await expect(roundDetails).toBeVisible();
    await expect(roundDetails).toContainText('Cost');
    await expect(roundDetails).toContainText('Cached');
    await expect(roundDetails).toContainText('73%');
    await expect(roundDetails).toContainText('Input');
    await expect(roundDetails).toContainText('12,000');
    await expect(roundDetails).toContainText('Output');
    await expect(roundDetails).toContainText('420');
    await expect(roundDetails).toContainText('Cache read');
    await expect(roundDetails).toContainText('48,000');
    await expect(roundDetails).toContainText('Cache write');
    await expect(roundDetails).toContainText('6,000');
    await expect(roundDetails).toContainText('Total');
    await expect(roundDetails).toContainText('66,420');
    await expect(roundDetails).toContainText('$0.00050');
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

  test('shows run token and cost preview when hovering the assistant Details button', async ({ page }) => {
    const replyText = 'Open the details pane from this response.';
    await openMockRunDetailsFromAssistantDetailsButton(page, replyText, { openDetails: false });

    const row = page.locator('.agent-message-row.assistant', { hasText: replyText });
    await row.getByRole('button', { name: 'Details' }).hover();

    const preview = page.getByRole('tooltip');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Cost');
    await expect(preview).toContainText('Cached');
    await expect(preview).toContainText('73%');
    await expect(preview).toContainText('66,420');
    await expect(preview).toContainText('$0.00050');
    await expect(preview).toContainText('48,000');
    await expect(preview).not.toContainText('22,559');
    await expect(preview).not.toContainText('$0.0252');
  });

  test('opens selected run details from an assistant Details button', async ({ page }) => {
    await openMockRunDetailsFromAssistantDetailsButton(page);

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');
    await expect(debugPanel.getByRole('heading', { name: 'Run Details' })).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Summary' })).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Model Input', exact: true })).toBeVisible();
    await expect(debugPanel.getByText('System prompt')).toBeVisible();
    await expect(debugPanel.getByText('Tools · 1')).toBeVisible();
    await expect(debugPanel.getByText('History · 2')).toBeVisible();
    await expect(debugPanel.getByText('Current request')).toBeVisible();
    await expect(debugPanel.getByRole('heading', { name: 'Execution · 1' })).toBeVisible();
  });
});
