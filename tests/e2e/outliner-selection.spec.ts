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
    await expect(page.getByRole('menuitem', { name: '2 nodes: Trash' })).toBeVisible();

    await page.getByRole('menuitem', { name: '2 nodes: Trash' }).click();
    await expect(row(page, ids.alpha)).toHaveCount(0);
    await expect(row(page, ids.beta)).toHaveCount(0);
  });

  test('context menu clamps to viewport edges', async ({ page }) => {
    await page.setViewportSize({ width: 980, height: 620 });
    const target = rowBody(page, ids.alpha);
    const box = await target.boundingBox();
    expect(box).toBeTruthy();

    await target.click({
      button: 'right',
      position: { x: box!.width - 2, y: Math.max(4, box!.height / 2) },
    });

    const menu = page.getByRole('menu', { name: 'Node actions' });
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox).toBeTruthy();
    expect(menuBox!.x).toBeGreaterThanOrEqual(8);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(972);
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

// Regression: a row's `selected` class is computed during its own render from the
// prop-drilled `ui`. A nested row receives that `ui` through its owning expanded
// ancestor, so when the ancestor's OWN memo state is unchanged it used to skip
// re-rendering and freeze its descendants' `ui` — the newly drag/cmd-click
// selected children kept a stale (unselected) class until an unrelated render
// woke them up ("re-enter a node to fix it"). Direct children of the view root
// never hit this (the root view is not gated behind an ancestor row's memo), so
// the bug only showed inside an expanded node — most often a supertagged one,
// since tagged nodes routinely carry an expanded child list.
test.describe('outliner selection inside an expanded non-root node', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    // Nest Beta + Gamma under Alpha so they render through Alpha's nested view.
    await rowEditor(page, ids.beta).click();
    await page.keyboard.press('Tab');
    await rowEditor(page, ids.gamma).click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(row(page, ids.beta)).toBeVisible();
    await expect(row(page, ids.gamma)).toBeVisible();
  });

  test('drag-select highlights nested children', async ({ page }) => {
    await dragSelectRows(page, ids.beta, ids.gamma);

    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
    await expect(rowEditor(page, ids.beta)).not.toBeFocused();
  });

  test('cmd-click highlights nested children', async ({ page }) => {
    // Click into Alpha first so the cmd-clicks are fresh ADDs rather than a
    // toggle-off of a child the nesting setup happened to leave selected.
    await rowEditor(page, ids.alpha).click();
    await multiSelect(page, [ids.beta, ids.gamma]);

    await expect(rowBody(page, ids.beta)).toHaveClass(/selected/);
    await expect(rowBody(page, ids.gamma)).toHaveClass(/selected/);
  });
});
