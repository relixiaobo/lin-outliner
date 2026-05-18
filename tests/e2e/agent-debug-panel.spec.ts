import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('agent debug panel', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('shows a compact overview, request context, and provider timeline', async ({ page }) => {
    await page.getByRole('button', { name: 'Open agent debug' }).click();

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');
    await expect(debugPanel.getByRole('heading', { name: 'Agent Debug' })).toBeVisible();
    await expect(debugPanel).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(debugPanel.getByLabel('Agent debug overview')).toContainText('gpt-5.4');
    await expect(debugPanel.getByLabel('Agent debug overview')).toContainText('12k / 256k');
    await expect(debugPanel.getByRole('heading', { name: 'Request Context' })).toBeVisible();
    await expect(debugPanel.getByLabel('Provider request timeline')).toContainText('Q1');
    const round = debugPanel.locator('.agent-debug-round-card').first();
    await expect(round.locator('.agent-debug-round-grid')).toHaveCount(0);
    await expect(round.locator('.agent-debug-message-row')).toHaveCount(2);
    await expect(round.locator('.agent-debug-message-row').last()).toContainText('assistant');
    await expect(round.locator('.agent-debug-message-row').last()).toContainText('Provider response');
    await expect(
      debugPanel.locator('.agent-debug-part-details.is-text summary strong')
        .filter({ hasText: /^Current outline focuses on UI work\.$/ }),
    ).toBeVisible();
  });
});
