import { expect, test } from '@playwright/test';
import {
  e2eProjection,
  ids,
  nodeByText,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

test.describe('outliner trailing input and expansion parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('plain typing in trailing input creates a real node and focuses it', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('Delta');

    await expect.poll(async () => (await nodeByText(page, 'Delta'))?.parentId).toBe(ids.today);
    const projectionBeforeBlur = await e2eProjection(page);
    const createdId = projectionBeforeBlur.nodes.find((node) => node.content.text === 'Delta')?.id;
    expect(createdId).toBeTruthy();
    await expect(rowEditor(page, createdId!)).toBeFocused();

    await page.locator('.main-panel').first().click({ position: { x: 120, y: 520 } });
    await expect.poll(async () => (await nodeByText(page, 'Delta'))?.parentId).toBe(ids.today);
  });

  test('empty trailing placeholder stays outside the editable ProseMirror paragraph', async ({ page }) => {
    const editor = page.locator(`[data-trailing-parent-id="${ids.today}"] .trailing-editor`).first();
    await expect(editor).toHaveClass(/is-empty/);

    await expect.poll(async () => editor.evaluate((element) =>
      getComputedStyle(element, '::before').content,
    )).toBe('"Type here or \'/\' for commands"');

    const paragraphPlaceholder = await editor.locator('.ProseMirror p').evaluate((element) =>
      getComputedStyle(element, '::before').content,
    );
    expect(paragraphPlaceholder).toBe('none');
  });

  test('empty Enter in trailing input creates an empty node in the current scope', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Enter');

    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const today = projection.nodes.find((node) => node.id === ids.today);
      return today?.children.length;
    }).toBe(4);

    const projection = await e2eProjection(page);
    const today = projection.nodes.find((node) => node.id === ids.today)!;
    const createdId = today.children.at(-1)!;
    const created = projection.nodes.find((node) => node.id === createdId)!;
    expect(created.content.text).toBe('');
    await expect(rowEditor(page, createdId)).toBeFocused();
  });

  test('Tab and Shift+Tab in trailing input choose the parent for the next node without collapsing state', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Tab');
    await page.keyboard.type('Nested');

    await expect.poll(async () => (await nodeByText(page, 'Nested'))?.parentId).toBe(ids.gamma);
    await expect(page.getByText('Nested')).toBeVisible();
    await page.locator('.main-panel').first().click({ position: { x: 120, y: 520 } });
    await expect.poll(async () => (await nodeByText(page, 'Nested'))?.parentId).toBe(ids.gamma);
    await expect(row(page, ids.gamma).getByRole('button', { name: 'Collapse' })).toBeVisible();
    await expect(page.getByText('Nested')).toBeVisible();

    await trailingEditor(page).click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('topagain');

    await expect(page.getByText('topagain')).toBeVisible();
    await page.locator('.main-panel').first().click({ position: { x: 120, y: 520 } });
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const full = projection.nodes.find((node) => node.content.text === 'topagain');
      if (full) return full.parentId === ids.today;
      const split = ['t', 'opagain'].map((text) => projection.nodes.find((node) => node.content.text === text));
      return split.every((node) => node?.parentId === ids.today);
    }).toBe(true);
  });

  test('Backspace in an empty trailing input focuses the last visible node above it', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.press('Backspace');

    await expect(rowEditor(page, ids.gamma)).toBeFocused();
  });

  test('expanding a leaf with the chevron focuses its child trailing input and Backspace collapses back to the leaf', async ({ page }) => {
    await rowBody(page, ids.gamma).hover();
    await row(page, ids.gamma).locator('.row-chevron-button').click();

    await expect(trailingEditor(page, ids.gamma)).toBeFocused();

    await page.keyboard.press('Backspace');

    await expect(rowEditor(page, ids.gamma)).toBeFocused();
    await expect(trailingEditor(page, ids.gamma)).toHaveCount(0);
  });
});
