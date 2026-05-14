import { expect, test } from '@playwright/test';
import {
  ids,
  openMockedApp,
  row,
  rowBody,
} from './outlinerMock';

function expectClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.5);
}

test.describe('outliner bullet parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('content and trailing bullets keep nodex leading geometry', async ({ page }) => {
    const contentMetrics = await rowBody(page, ids.alpha).evaluate((element) => {
      const rowRect = element.getBoundingClientRect();
      const chevronRect = element.querySelector('.row-chevron-button')?.getBoundingClientRect();
      const bulletRect = element.querySelector('.row-bullet-button')?.getBoundingClientRect();
      const contentRect = element.querySelector('.row-content-line')?.getBoundingClientRect();
      if (!chevronRect || !bulletRect || !contentRect) throw new Error('missing row leading element');
      return {
        chevronLeft: chevronRect.left - rowRect.left,
        chevronWidth: chevronRect.width,
        bulletLeft: bulletRect.left - rowRect.left,
        bulletWidth: bulletRect.width,
        bulletCenter: bulletRect.left - rowRect.left + bulletRect.width / 2,
        contentLeft: contentRect.left - rowRect.left,
      };
    });

    const trailingMetrics = await page.locator(`[data-trailing-parent-id="${ids.today}"]`).first().evaluate((element) => {
      const rowRect = element.getBoundingClientRect();
      const bulletRect = element.querySelector('.row-bullet-button')?.getBoundingClientRect();
      const editorRect = element.querySelector('.row-editor')?.getBoundingClientRect();
      if (!bulletRect || !editorRect) throw new Error('missing trailing leading element');
      return {
        bulletLeft: bulletRect.left - rowRect.left,
        bulletWidth: bulletRect.width,
        bulletCenter: bulletRect.left - rowRect.left + bulletRect.width / 2,
        editorLeft: editorRect.left - rowRect.left,
      };
    });

    expectClose(contentMetrics.chevronLeft, 6);
    expectClose(contentMetrics.chevronWidth, 15);
    expectClose(contentMetrics.bulletLeft, 25);
    expectClose(contentMetrics.bulletWidth, 15);
    expectClose(contentMetrics.contentLeft - contentMetrics.bulletCenter, 15.5);
    expectClose(trailingMetrics.bulletLeft, 25);
    expectClose(trailingMetrics.bulletWidth, 15);
    expectClose(trailingMetrics.editorLeft - trailingMetrics.bulletCenter, 15.5);
  });

  test('tag definition bullet uses nodex hash glyph', async ({ page }) => {
    await page.getByRole('button', { name: 'Supertags' }).click();

    const tagBullet = row(page, ids.projectTag).locator('.row-bullet-shape.tag').first();
    await expect(tagBullet.locator('.row-bullet-tag-glyph')).toHaveText('#');

    const styles = await tagBullet.locator('.row-bullet-tag-glyph').evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
      };
    });
    expect(styles.fontSize).toBe('9px');
    expect(Number(styles.fontWeight)).toBeGreaterThanOrEqual(700);
    expect(styles.lineHeight).toBe('9px');
  });

  test('collapsed content bullets use fill only without an outer border', async ({ page }) => {
    await page.getByRole('button', { name: 'Library' }).click();

    const collapsedBullet = row(page, ids.daily).locator('.row-bullet-shape.content.has-children.collapsed').first();
    await expect(collapsedBullet).toBeVisible();

    const borderWidths = await collapsedBullet.evaluate((element) => {
      const computed = getComputedStyle(element);
      return [
        computed.borderTopWidth,
        computed.borderRightWidth,
        computed.borderBottomWidth,
        computed.borderLeftWidth,
      ];
    });
    expect(borderWidths).toEqual(['0px', '0px', '0px', '0px']);
  });
});
