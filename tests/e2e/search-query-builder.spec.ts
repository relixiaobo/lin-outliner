import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('search query builder', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('opens from the search title action and keeps locked searches read-only', async ({ page }) => {
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();

    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Recents');
    await page.getByRole('button', { name: 'Show query' }).click();

    const builder = page.locator('[data-search-query-builder]');
    await expect(builder).toBeVisible();
    await expect(builder.locator('textarea')).toHaveValue([
      '- EDITED_LAST_DAYS',
      '  - value:: 30',
    ].join('\n'));
    await expect(builder.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(page.locator('[data-node-id="recents-query"]')).toHaveCount(0);
  });
});
