import { expect, test, type Page } from '@playwright/test';
import {
  ids,
  multiSelect,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
} from './outlinerMock';

async function dragPoint(page: Page, rowId: string, xRatio = 0.85) {
  const box = await rowBody(page, rowId).boundingBox();
  if (!box) throw new Error(`Missing row body for ${rowId}`);
  return {
    x: box.x + Math.max(18, Math.min(box.width - 12, box.width * xRatio)),
    y: box.y + box.height / 2,
  };
}

async function dragSelectRows(
  page: Page,
  fromId: string,
  toId: string,
  xRatio = 0.85,
) {
  const start = await dragPoint(page, fromId, xRatio);
  const end = await dragPoint(page, toId, xRatio);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

test.describe('outliner selection parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('multi-selection # opens batch tag selector and applies tag to all selected rows', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.keyboard.type('#');
    await expect(page.locator('.batch-tag-selector')).toBeVisible();
    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);

    await page.locator('.batch-tag-input').fill('project');
    await page.keyboard.press('Enter');

    await expect(page.locator('.batch-tag-selector')).toBeHidden();
    await expect(row(page, ids.alpha).locator('.tag-badge-label')).toContainText('project');
    await expect(row(page, ids.beta).locator('.tag-badge-label')).toContainText('project');
    await expect(rowBody(page, ids.alpha)).not.toHaveClass(/selected/);
  });

  test('multi-selection Backspace trashes every selected row as a batch operation', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.keyboard.press('Backspace');

    await expect(row(page, ids.alpha)).toHaveCount(0);
    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, ids.gamma)).toContainText('Gamma');
  });

  test('right-clicking a selected row keeps the block selection for context-menu batch actions', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await row(page, ids.alpha).click({ button: 'right' });
    await expect(page.getByRole('button', { name: '2 nodes: Trash' })).toBeVisible();

    await page.getByRole('button', { name: '2 nodes: Trash' }).click();
    await expect(row(page, ids.alpha)).toHaveCount(0);
    await expect(row(page, ids.beta)).toHaveCount(0);
  });

  test('clicking blank space exits multi-selection without touching rows', async ({ page }) => {
    await multiSelect(page, [ids.alpha, ids.beta]);

    await page.locator('.main-panel').first().click({ position: { x: 120, y: 520 } });

    await expect(rowBody(page, ids.alpha)).not.toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).not.toHaveClass(/selected/);
    await expect(row(page, ids.alpha)).toContainText('Alpha');
    await expect(row(page, ids.beta)).toContainText('Beta');
  });

  test('mouse drag selects a visible range and leaves row editors unfocused', async ({ page }) => {
    await dragSelectRows(page, ids.alpha, ids.gamma);

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
    await expect(rowEditor(page, ids.gamma)).not.toBeFocused();

    await page.keyboard.press('Backspace');
    await expect(row(page, ids.alpha)).toHaveCount(0);
    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, ids.gamma)).toHaveCount(0);
  });

  test('mouse drag can select a single row without entering text edit', async ({ page }) => {
    const start = await dragPoint(page, ids.alpha, 0.88);
    const end = await dragPoint(page, ids.alpha, 0.82);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 4 });
    await page.mouse.up();

    await expect(rowBody(page, ids.alpha)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.beta)).not.toHaveClass(/selected/);
    await expect(rowEditor(page, ids.alpha)).not.toBeFocused();

    await page.keyboard.type('x');
    await expect(row(page, ids.alpha)).toContainText('Alphax');
  });

  test('mouse drag inside the same text editor keeps native text selection behavior', async ({ page }) => {
    const box = await rowEditor(page, ids.alpha).boundingBox();
    if (!box) throw new Error('Missing Alpha editor');

    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.max(12, box.width - 2), box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();

    await expect(rowBody(page, ids.alpha)).not.toHaveClass(/selected/);
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
  });
});
