import { expect, test } from '@playwright/test';
import {
  ids,
  nodeById,
  openMockedApp,
  row,
} from './outlinerMock';

test.describe('outliner navigation and page title parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('clicking a node bullet drills into that node page', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
  });

  test('node page title is editable and writes back to the same node', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();

    const titleEditor = page.locator('.panel-title-editor .ProseMirror').first();
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Alpha renamed');
    await page.locator('.main-panel').first().click({ position: { x: 120, y: 520 } });

    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha renamed');
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Alpha renamed');
  });

  test('nodex-style main surface does not render an inspector side panel', async ({ page }) => {
    await expect(page.getByText('INSPECTOR')).toHaveCount(0);
    await expect(page.locator('.main-panel').first()).toBeVisible();
  });
});
