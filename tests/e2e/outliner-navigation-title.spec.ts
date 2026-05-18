import { expect, test } from '@playwright/test';
import {
  ids,
  nodeById,
  openMockedApp,
  row,
  rowEditor,
} from './outlinerMock';

function expectClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.5);
}

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

  test('header more action stays on the title row when a node has no title tags', async ({ page }) => {
    await row(page, ids.alpha).getByRole('button', { name: 'Open' }).click();

    const metrics = await page.evaluate(() => {
      const titleRow = document.querySelector('.panel-title-row')?.getBoundingClientRect();
      const titleEditor = document.querySelector('.panel-title-editor')?.getBoundingClientRect();
      const moreButton = document.querySelector('.panel-title-more-button')?.getBoundingClientRect();
      const tagRow = document.querySelector('.panel-title-toolbar-row');
      if (!titleRow || !titleEditor || !moreButton) throw new Error('missing title row alignment target');
      return {
        moreCenterY: moreButton.top + moreButton.height / 2,
        moreRight: moreButton.right,
        tagRowExists: Boolean(tagRow),
        titleEditorCenterY: titleEditor.top + titleEditor.height / 2,
        titleRowRight: titleRow.right,
      };
    });

    expect(metrics.tagRowExists).toBe(false);
    expectClose(metrics.moreCenterY, metrics.titleEditorCenterY);
    expectClose(metrics.moreRight, metrics.titleRowRight);
  });

  test('day panels expose date navigation and jump through ensured day nodes', async ({ page }) => {
    await expect(page.getByRole('navigation', { name: 'Date navigation' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Date navigation' })).not.toContainText('2026/');

    await page.getByRole('button', { name: 'Next day' }).click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-14');
    await expect(page.getByRole('navigation', { name: 'Date navigation' })).toBeVisible();
    await expect.poll(async () => (await nodeById(page, ids.today))?.content.text).toBe('2026-05-13');

    await page.getByRole('button', { name: 'Open calendar' }).click();
    await expect(page.getByRole('dialog', { name: 'Calendar' })).toBeVisible();
    await expect(page.locator('.panel-date-note-dot')).toHaveCount(0);

    const countedDay = page.locator('.panel-date-calendar-day[data-note-count="3"]').first();
    await expect(countedDay).toHaveAttribute('aria-label', /3 nodes/);
    await expect(countedDay).toHaveClass(/note-density-2/);
    await expect.poll(async () => countedDay.evaluate((element) =>
      getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');

    const radii = await page.evaluate(() => {
      const selectors = [
        '.panel-date-nav-button',
        '.panel-date-nav-today',
        '.panel-date-picker-button',
        '.panel-date-calendar-nav',
        '.panel-date-calendar-day',
      ];
      return selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return Number.parseFloat(getComputedStyle(element).borderTopLeftRadius);
      });
    });
    for (const radius of radii) {
      expect(radius).toBeGreaterThanOrEqual(6);
      expect(radius).toBeLessThanOrEqual(8);
    }

    await page.getByRole('button', { name: 'Go to 2026-05-20' }).click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('2026-05-20');
  });

  test('trailing empty-node hint is focused and singular instead of always visible', async ({ page }) => {
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.setAttribute('data-testid', 'trailing-hint-fixture');
      fixture.innerHTML = `
        <div class="row-editor trailing-editor idle-hint is-empty" data-placeholder="Type here or '/' for commands">
          <div class="ProseMirror" contenteditable="true"></div>
        </div>
        <div class="row-editor trailing-editor idle-hint is-empty" data-placeholder="Type here or '/' for commands">
          <div class="ProseMirror" contenteditable="true"></div>
        </div>
      `;
      document.body.appendChild(fixture);
    });

    await page.locator('[data-testid="trailing-hint-fixture"] .ProseMirror').nth(1).focus();

    await expect.poll(async () => page.locator('.trailing-editor.is-empty').evaluateAll((elements) =>
      elements.filter((element) => Number(getComputedStyle(element, '::before').opacity) > 0.5).length), {
      timeout: 4000,
    }).toBe(1);

    await rowEditor(page, ids.alpha).click();

    await expect.poll(async () => page.locator('.trailing-editor.is-empty').evaluateAll((elements) =>
      elements.filter((element) => Number(getComputedStyle(element, '::before').opacity) > 0.5).length)).toBe(0);
  });

  test('panel scroll containers use the lightweight scrollbar contract', async ({ page }) => {
    const styles = await page.locator('.main-panel').first().evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        scrollbarGutter: computed.scrollbarGutter,
        scrollbarWidth: computed.scrollbarWidth,
      };
    });

    expect(styles.scrollbarWidth).toBe('thin');
    expect(styles.scrollbarGutter).toContain('stable');
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
