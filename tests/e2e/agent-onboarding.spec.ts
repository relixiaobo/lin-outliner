import { expect, test } from '@playwright/test';
import { DEFAULT_GENERAL_CHANNEL_ID } from '../../src/core/agentChannel';
import { commandCalls, openMockedApp } from './outlinerMock';

async function waitForAgentReady(page: import('@playwright/test').Page) {
  await expect(page.locator('.agent-empty-state')).toBeVisible();
  await expect(page.getByLabel('Agent message')).toBeVisible();
}

test.describe('agent panel empty state', () => {
  test('with a provider: stays blank and sends normally', async ({ page }) => {
    await openMockedApp(page);
    await waitForAgentReady(page);

    await expect(page.locator('.agent-empty-state')).toBeVisible();
    await expect(page.locator('.agent-empty-greeting')).toHaveCount(0);
    await expect(page.getByText('Connect an AI provider to start.')).toHaveCount(0);

    const send = page.getByRole('button', { name: 'Send message' });
    await expect(send).toBeDisabled(); // empty draft

    await page.getByLabel('Agent message').fill('Summarize current outline.');
    await expect(send).toBeEnabled();
    await send.click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.find((call) => call.cmd === 'agent_send_message')?.args;
    }).toMatchObject({
      message: 'Summarize current outline.',
      conversationId: DEFAULT_GENERAL_CHANNEL_ID,
    });
  });

  test('without a provider: shows onboarding, CTA opens Settings, and send is blocked', async ({ page }) => {
    await openMockedApp(page, { noProvider: true });
    await waitForAgentReady(page);

    // Onboarding replaces the greeting; no suggestion chips remain.
    await expect(page.getByText('Connect an AI provider to start.')).toBeVisible();
    await expect(page.locator('.agent-empty-greeting')).toHaveCount(0);

    // Send is guarded even with a non-empty draft, with an actionable tooltip.
    const send = page.getByRole('button', { name: 'Send message' });
    await page.getByLabel('Agent message').fill('Summarize current outline.');
    await expect(send).toBeDisabled();
    await expect(send).toHaveAttribute('title', 'Add a provider in Settings');

    // Enter does not slip a message past the guard.
    await page.getByLabel('Agent message').press('Enter');
    await page.waitForTimeout(150);
    const callsAfterEnter = await commandCalls(page);
    expect(callsAfterEnter.some((call) => call.cmd === 'agent_send_message')).toBe(false);

    // The CTA deep-links to Settings › Providers (openSettings defaults there).
    await page.getByRole('button', { name: 'Open Settings › Providers' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.some((call) => call.cmd === 'open_settings');
    }).toBe(true);
  });
});
