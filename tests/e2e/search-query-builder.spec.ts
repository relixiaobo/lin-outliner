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
    await expect(page.locator('.search-query-summary-bar')).toBeVisible();
    await page.getByRole('button', { name: 'Show query' }).click();

    const builder = page.locator('[data-search-query-builder]');
    await expect(builder).toBeVisible();
    await expect(page.locator('.search-query-summary-bar')).toHaveCount(0);
    await expect(builder.locator('textarea')).toHaveValue([
      '- EDITED_LAST_DAYS',
      '  - value:: 30',
    ].join('\n'));
    await expect(builder.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(page.locator('[data-node-id="recents-query"]')).toHaveCount(0);
  });

  test('search summary exposes the result view toolbar', async ({ page }) => {
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();

    const summary = page.locator('.search-query-summary-bar');
    await expect(summary).toBeVisible();
    await expect(summary.locator('.search-query-chip')).toContainText('Edited in 30 days');
    await expect(summary).toContainText('0 results');

    await summary.getByRole('button', { name: 'Show view toolbar' }).click();

    const toolbar = page.locator('.view-toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Display' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Filter by', exact: true })).toBeVisible();
  });
});
