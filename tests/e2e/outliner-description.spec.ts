import { expect, test } from '@playwright/test';
import {
  e2eProjection,
  ids,
  openMockedApp,
  row,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

test.describe('outliner node description parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('Ctrl+I toggles from row text to description and back without underline focus chrome', async ({ page }) => {
    await rowEditor(page, ids.alpha).click();
    await page.keyboard.press('Control+I');

    const descriptionEditor = row(page, ids.alpha).locator('textarea.node-description');
    await expect(descriptionEditor).toBeFocused();
    await expect(descriptionEditor).toHaveAttribute('placeholder', 'Description');
    const emptyEditorStyle = await descriptionEditor.evaluate((element) => {
      const style = getComputedStyle(element);
      const placeholder = getComputedStyle(element, '::placeholder');
      return {
        boxShadow: style.boxShadow,
        fontFamily: style.fontFamily,
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        placeholderColor: placeholder.color,
      };
    });
    expect(emptyEditorStyle.boxShadow).toBe('none');
    // Placeholder = 22% of the neutral text token (--text ≈ 0.88 ink), so its
    // effective alpha lands at ~0.194 regardless of color() vs rgba() serialization.
    expect(placeholderAlpha(emptyEditorStyle.placeholderColor)).toBeCloseTo(0.194, 2);
    expect(Math.abs(emptyEditorStyle.height - emptyEditorStyle.lineHeight)).toBeLessThanOrEqual(1);

    await page.keyboard.type('Alpha description');
    const focusedRowRect = await row(page, ids.alpha).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    await page.keyboard.press('Control+I');

    await expect(rowEditor(page, ids.alpha)).toBeFocused();
    await expect(row(page, ids.alpha).locator('textarea.node-description')).toHaveValue('Alpha description');
    const readRowRect = await row(page, ids.alpha).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    expect(Math.abs(readRowRect.top - focusedRowRect.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(readRowRect.height - focusedRowRect.height)).toBeLessThanOrEqual(1);
    const projection = await e2eProjection(page);
    expect(projection.nodes.find((node) => node.id === ids.alpha)?.description).toBe('Alpha description');
  });

  test('description placeholder and blur commit keep the row layout stable', async ({ page }) => {
    await rowEditor(page, ids.alpha).click();
    await page.keyboard.press('Control+I');

    const descriptionEditor = row(page, ids.alpha).locator('textarea.node-description');
    await expect(descriptionEditor).toBeFocused();
    const emptyEditorStyle = await descriptionEditor.evaluate((element) => {
      const style = getComputedStyle(element);
      const placeholder = getComputedStyle(element, '::placeholder');
      return {
        color: style.color,
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        placeholderColor: placeholder.color,
      };
    });
    expect(emptyEditorStyle.color).not.toBe(emptyEditorStyle.placeholderColor);
    expect(placeholderAlpha(emptyEditorStyle.placeholderColor)).toBeCloseTo(0.194, 2);
    expect(Math.abs(emptyEditorStyle.height - emptyEditorStyle.lineHeight)).toBeLessThanOrEqual(1);

    await page.keyboard.type('Blur description');
    const focusedRowRect = await row(page, ids.alpha).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    await descriptionEditor.evaluate((element) => element.blur());

    await expect(row(page, ids.alpha).locator('textarea.node-description')).toHaveValue('Blur description');
    const readRowRect = await row(page, ids.alpha).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    expect(Math.abs(readRowRect.top - focusedRowRect.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(readRowRect.height - focusedRowRect.height)).toBeLessThanOrEqual(1);
  });

  test('committing a new description by clicking another row does not steal focus back', async ({ page }) => {
    await rowEditor(page, ids.alpha).click();
    await page.keyboard.press('Control+I');

    const descriptionEditor = row(page, ids.alpha).locator('textarea.node-description');
    await expect(descriptionEditor).toBeFocused();
    await page.keyboard.type('Click away description');
    const focusedRowRect = await row(page, ids.alpha).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });

    await rowEditor(page, ids.beta).click();

    await expect(rowEditor(page, ids.beta)).toBeFocused();
    await page.keyboard.type('!');
    await expect(rowEditor(page, ids.beta)).toContainText('!');
    await expect(row(page, ids.alpha).locator('textarea.node-description')).toHaveValue('Click away description');
    const readRowRect = await row(page, ids.alpha).evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    });
    expect(Math.abs(readRowRect.top - focusedRowRect.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(readRowRect.height - focusedRowRect.height)).toBeLessThanOrEqual(1);
  });

  test('clicking an existing description places the caret at the clicked text position', async ({ page }) => {
    await rowEditor(page, ids.alpha).click();
    await page.keyboard.press('Control+I');
    await page.keyboard.type('Alpha description');
    await page.keyboard.press('Control+I');

    const descriptionEditor = row(page, ids.alpha).locator('textarea.node-description');
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
    const box = await descriptionEditor.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click((box?.x ?? 0) + 34, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await expect(descriptionEditor).toBeFocused();

    const selectionStart = await descriptionEditor.evaluate((element) => element.selectionStart);
    const valueLength = await descriptionEditor.evaluate((element) => element.value.length);
    expect(selectionStart).toBeGreaterThan(0);
    expect(selectionStart).toBeLessThan(valueLength);
  });

  test('Ctrl+I from a typed trailing row creates the node and focuses its description', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('Trailing source');
    await page.keyboard.press('Control+I');

    const focusedDescription = page.locator('textarea.node-description:focus');
    await expect(focusedDescription).toBeFocused();
    await expect(focusedDescription).toHaveAttribute('placeholder', 'Description');
    const projection = await e2eProjection(page);
    expect(projection.nodes.some((node) => node.content.text === 'Trailing source')).toBe(true);
  });
});

// The placeholder color comes from a color-mix, which chromium serializes as
// `color(srgb r g b / a)`; tolerate the legacy `rgba(r, g, b, a)` form too.
function placeholderAlpha(color: string): number {
  const slashForm = color.match(/\/\s*([\d.]+)\s*\)/);
  if (slashForm) return Number.parseFloat(slashForm[1]);
  const rgbaForm = color.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
  return rgbaForm ? Number.parseFloat(rgbaForm[1]) : 1;
}
