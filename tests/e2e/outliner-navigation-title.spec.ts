import { expect, test } from '@playwright/test';
import {
  ids,
  nodeById,
  openMockedApp,
  row,
  rowEditor,
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

  test('Cmd+Enter in page title commits current text while cycling checkbox state', async ({ page }) => {
    const titleEditor = page.locator('.panel-title-editor .ProseMirror').first();
    await titleEditor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Today renamed');
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => (await nodeById(page, ids.today))?.content.text).toBe('Today renamed');
    await expect.poll(async () => (await nodeById(page, ids.today))?.showCheckbox).toBe(true);
    await expect.poll(async () => Boolean((await nodeById(page, ids.today))?.completedAt)).toBe(false);

    await page.keyboard.press('Meta+Enter');
    await expect.poll(async () => (await nodeById(page, ids.today))?.showCheckbox).toBe(true);
    await expect.poll(async () => Boolean((await nodeById(page, ids.today))?.completedAt)).toBe(true);

    await page.keyboard.press('Meta+Enter');
    await expect.poll(async () => (await nodeById(page, ids.today))?.showCheckbox).toBe(false);
    await expect.poll(async () => Boolean((await nodeById(page, ids.today))?.completedAt)).toBe(false);
  });

  test('Cmd+Enter in row editor commits current text while cycling checkbox state', async ({ page }) => {
    const editor = rowEditor(page, ids.alpha);
    await editor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Alpha done');
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => (await nodeById(page, ids.alpha))?.content.text).toBe('Alpha done');
    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(true);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(true);

    await editor.click();
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(false);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(false);

    await editor.click();
    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(false);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(true);
  });

  test('mouse checkbox click only toggles undone and done states', async ({ page }) => {
    await row(page, ids.alpha).getByTitle('Mark done').click();
    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(true);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(true);

    await row(page, ids.alpha).getByTitle('Mark not done').click();
    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(false);
    await expect.poll(async () => (await nodeById(page, ids.alpha))?.showCheckbox).toBe(true);
  });

  test('nodex-style main surface does not render an inspector side panel', async ({ page }) => {
    await expect(page.getByText('INSPECTOR')).toHaveCount(0);
    await expect(page.locator('.main-panel').first()).toBeVisible();
  });
});
