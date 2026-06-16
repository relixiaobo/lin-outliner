import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('agent debug panel', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('shows the execution tree: overview, a run node, and its rounds on expand', async ({ page }) => {
    await page.getByRole('button', { name: 'Open agent debug' }).click();

    const debugPanel = page.locator('.outline-panel-surface.is-agent-debug');
    await expect(debugPanel.getByRole('heading', { name: 'Agent Debug' })).toBeVisible();
    await expect(debugPanel).toHaveCSS('background-color', 'rgb(255, 255, 255)');

    // Overview: DM shape + the conversation's run/token rollup.
    const overview = debugPanel.getByLabel('Agent debug overview');
    await expect(overview).toContainText('Direct');

    // One run node, attributed to its agent, showing the model + round count.
    const runHead = debugPanel.locator('.agent-debug-run-head').first();
    await expect(runHead).toContainText('gpt-5.4');
    await expect(runHead).toContainText('1 round');

    // Expanding the run lazily loads its detail: the per-run system prompt and
    // a round whose response carries the final answer.
    await runHead.click();
    await expect(debugPanel.getByText('System prompt')).toBeVisible();
    const round = debugPanel.locator('.agent-debug-round-card').first();
    await expect(round.getByRole('heading', { name: 'Round 1' })).toBeVisible();
    await expect(
      round.locator('.agent-debug-part-details.is-text summary strong')
        .filter({ hasText: /^Current outline focuses on UI work\.$/ }),
    ).toBeVisible();
  });
});
