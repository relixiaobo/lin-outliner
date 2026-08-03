import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('window chrome hit regions', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('keeps the agent toggle outside the Thread header drag region', async ({ page }) => {
    const regions = await page.evaluate(() => {
      const appRegion = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).getPropertyValue('-webkit-app-region').trim();
      };
      return {
        rightZone: appRegion('.window-chrome-zone-right'),
        agentToggle: appRegion('.agent-toggle'),
        threadHeader: appRegion('.thread-dock-header'),
      };
    });

    expect(regions.rightZone).toBe('drag');
    expect(regions.agentToggle).toBe('no-drag');
    // Plain Chromium does not consume native title-bar clicks, so guard the
    // Electron failure mechanism directly as well as exercising the state path.
    expect(regions.threadHeader).not.toBe('drag');

    const dock = page.locator('.agent-dock');
    await expect(dock).toHaveAttribute('data-rail-state', 'open');
    await page.getByRole('button', { name: 'Collapse agent' }).click();
    await expect(dock).toHaveAttribute('data-rail-state', 'collapsed');
    await page.getByRole('button', { name: 'Expand agent' }).click();
    await expect(dock).toHaveAttribute('data-rail-state', 'open');
  });
});
