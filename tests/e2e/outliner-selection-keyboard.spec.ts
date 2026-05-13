import { expect, test } from '@playwright/test';
import {
  clipboardText,
  ids,
  multiSelect,
  nodeById,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
} from './outlinerMock';

test.describe('outliner selection keyboard parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('typing in selection mode edits the first selected row and appends the character', async ({ page }) => {
    await multiSelect(page, [ids.beta]);

    await page.keyboard.type('x');

    await expect(row(page, ids.beta)).toContainText('Betax');
    await expect(rowEditor(page, ids.beta)).toBeFocused();
    await expect(rowBody(page, ids.beta)).not.toHaveClass(/selected/);
  });

  test('ArrowUp and ArrowDown leave selection mode and focus adjacent rows', async ({ page }) => {
    await multiSelect(page, [ids.beta]);

    await page.keyboard.press('ArrowUp');
    await expect(rowEditor(page, ids.alpha)).toBeFocused();

    await row(page, ids.beta).click({ modifiers: ['Meta'] });
    await page.keyboard.press('ArrowDown');
    await expect(rowEditor(page, ids.gamma)).toBeFocused();
  });

  test('Shift click and Cmd+A select visible rows in root scope', async ({ page }) => {
    await row(page, ids.alpha).click({ modifiers: ['Meta'] });
    await row(page, ids.gamma).click({ modifiers: ['Shift'] });

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);

    await page.keyboard.press('Escape');
    await row(page, ids.beta).click({ modifiers: ['Meta'] });
    await page.keyboard.press('Meta+A');

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });

  test('Tab indents selected rows under the previous sibling and keeps the target expanded', async ({ page }) => {
    await multiSelect(page, [ids.beta]);

    await page.keyboard.press('Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);
    await expect(row(page, ids.beta)).toBeVisible();
    await expect(rowEditor(page, ids.beta)).toBeFocused();
  });

  test('Shift+Tab outdents selected rows back to the parent scope', async ({ page }) => {
    await multiSelect(page, [ids.beta]);
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.alpha);

    await page.keyboard.press('Escape');
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await page.keyboard.press('Shift+Tab');

    await expect.poll(async () => (await nodeById(page, ids.beta))?.parentId).toBe(ids.today);
  });

  test('Cmd+Enter toggles done state for all selected target rows', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.keyboard.press('Meta+Enter');

    await expect.poll(async () => Boolean((await nodeById(page, ids.alpha))?.completedAt)).toBe(true);
    await expect.poll(async () => Boolean((await nodeById(page, ids.beta))?.completedAt)).toBe(true);
  });

  test('Cmd+Shift+D duplicates all selected rows after their sources', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.keyboard.press('Meta+Shift+D');

    await expect(page.getByText('Alpha')).toHaveCount(2);
    await expect(page.getByText('Beta')).toHaveCount(2);
  });

  test('Cmd+C copies selected rows and Cmd+X cuts them as a batch', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.keyboard.press('Meta+C');
    await expect.poll(() => clipboardText(page)).toContain('Alpha');
    await expect.poll(() => clipboardText(page)).toContain('Beta');

    await page.keyboard.press('Meta+X');

    await expect(row(page, ids.alpha)).toHaveCount(0);
    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, ids.gamma)).toContainText('Gamma');
  });
});
