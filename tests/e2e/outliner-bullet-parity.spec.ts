import { expect, test } from '@playwright/test';
import {
  e2eProjection,
  emitDocumentEvent,
  ids,
  openMockedApp,
  row,
  rowBody,
} from './outlinerMock';

function expectClose(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(0.5);
}

async function lastTodayChildId(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children.at(-1);
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

  test('top-level bullets align to the panel header content start', async ({ page }) => {
    const metrics = await page.evaluate((ids) => {
      const titleRect = document.querySelector('.panel-title-editor')?.getBoundingClientRect();
      const tagRect = document.querySelector('.panel-title-toolbar-row .tag-bar')?.getBoundingClientRect();
      const rootStyle = getComputedStyle(document.documentElement);
      const panelRect = document.querySelector('.main-panel')?.getBoundingClientRect();
      const moreRect = document.querySelector('.panel-title-more-button')?.getBoundingClientRect();
      const rowElement = document.querySelector(`[data-node-id="${ids.alpha}"] > .row`);
      const rowBulletRect = rowElement?.querySelector('.row-bullet-button')?.getBoundingClientRect();
      const rowChevronRect = rowElement?.querySelector('.row-chevron-button')?.getBoundingClientRect();
      const trailingBulletRect = document
        .querySelector(`[data-trailing-parent-id="${ids.today}"] .row-bullet-button`)
        ?.getBoundingClientRect();
      if (!titleRect || !tagRect || !panelRect || !moreRect || !rowBulletRect || !rowChevronRect || !trailingBulletRect) {
        throw new Error('missing panel alignment target');
      }
      return {
        panelContentX: Number.parseFloat(rootStyle.getPropertyValue('--panel-content-x')),
        panelLeft: panelRect.left,
        panelRight: panelRect.right,
        titleLeft: titleRect.left,
        tagLeft: tagRect.left,
        moreRight: moreRect.right,
        rowBulletLeft: rowBulletRect.left,
        rowChevronLeft: rowChevronRect.left,
        trailingBulletLeft: trailingBulletRect.left,
      };
    }, ids);

    expectClose(metrics.tagLeft, metrics.titleLeft);
    expectClose(metrics.rowBulletLeft, metrics.titleLeft);
    expectClose(metrics.trailingBulletLeft, metrics.titleLeft);
    expect(metrics.rowChevronLeft).toBeGreaterThanOrEqual(metrics.panelLeft + 8);
    expect(metrics.rowChevronLeft).toBeLessThan(metrics.titleLeft);
    expectClose(metrics.panelRight - metrics.moreRight, metrics.panelContentX);
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

  test('tree reference rows use a centered dashed marker', async ({ page }) => {
    await page.evaluate(async ({ parentId, targetId }) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('add_reference', { parentId, targetId, index: null });
    }, { parentId: ids.today, targetId: ids.alpha });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });
    const referenceRowId = await lastTodayChildId(page);
    expect(referenceRowId).toBeTruthy();

    const marker = row(page, referenceRowId!).locator('.row-bullet-shape.reference').first();
    await expect(marker).toBeVisible();

    const styles = await marker.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        width: computed.width,
        height: computed.height,
        borderStyle: computed.borderTopStyle,
        background: computed.backgroundColor,
      };
    });
    expect(styles.width).toBe('13px');
    expect(styles.height).toBe('13px');
    expect(styles.borderStyle).toBe('dashed');
    expect(styles.background).toBe('rgba(0, 0, 0, 0)');
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

  test('parent chevrons remain visible without moving the bullet axis', async ({ page }) => {
    await page.getByRole('button', { name: 'Library' }).click();

    const dailyRow = rowBody(page, ids.daily);
    const metrics = await dailyRow.evaluate((element) => {
      const rowRect = element.getBoundingClientRect();
      const chevron = element.querySelector('.row-chevron-button');
      const bullet = element.querySelector('.row-bullet-button');
      if (!chevron || !bullet) throw new Error('missing row leading elements');
      const chevronRect = chevron.getBoundingClientRect();
      const bulletRect = bullet.getBoundingClientRect();
      return {
        chevronOpacity: Number(getComputedStyle(chevron).opacity),
        chevronLeft: chevronRect.left - rowRect.left,
        bulletLeft: bulletRect.left - rowRect.left,
      };
    });

    expect(metrics.chevronOpacity).toBeGreaterThan(0.3);
    expectClose(metrics.chevronLeft, 6);
    expectClose(metrics.bulletLeft, 25);
  });
});

test.describe('outliner field row visual parity', () => {
  test('root field entries render in the panel heading field segment, not the body list', async ({ page }) => {
    await openMockedApp(page, { optionsField: true });

    const panel = page.locator('.main-panel').first();
    await expect(panel.locator(`.panel-heading-fields [data-node-id="${ids.priorityEntry}"]`)).toBeVisible();
    await expect(panel.locator(`.panel-inner > .outliner [data-node-id="${ids.priorityEntry}"]`)).toHaveCount(0);
  });

  test('field value rows use the dense label-value axis without an inner value bullet', async ({ page }) => {
    await openMockedApp(page, { optionsField: true });

    const priorityRow = rowBody(page, ids.priorityEntry);
    await expect(priorityRow.locator('.field-value-node-bullet')).toHaveCount(0);

    const metrics = await priorityRow.evaluate((element) => {
      const name = element.querySelector('.field-name-input')?.getBoundingClientRect();
      const value = element.querySelector('.field-value-row-content')?.getBoundingClientRect();
      if (!name || !value) throw new Error('missing field row cells');
      return {
        nameCenter: name.top + name.height / 2,
        valueCenter: value.top + value.height / 2,
      };
    });

    expectClose(metrics.nameCenter, metrics.valueCenter);
  });
});

test.describe('outliner inline atom and drag visuals', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('inline references stay text-like instead of rendering as chips', async ({ page }) => {
    await page.evaluate(async ({ nodeId, targetId }) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('apply_node_text_patch', {
        nodeId,
        patch: {
          ops: [{
            type: 'replace_all',
            content: {
              text: 'See ',
              marks: [],
              inlineRefs: [{ offset: 4, targetNodeId: targetId, displayName: 'Alpha' }],
            },
          }],
        },
      });
    }, { nodeId: ids.beta, targetId: ids.alpha });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    const inlineRef = row(page, ids.beta).locator('.inline-ref').first();
    await expect(inlineRef).toHaveText('@Alpha');

    const styles = await inlineRef.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        display: computed.display,
        background: computed.backgroundColor,
        textDecorationLine: computed.textDecorationLine,
        fontWeight: Number(computed.fontWeight),
      };
    });
    expect(styles.display).toBe('inline');
    expect(styles.background).toBe('rgba(0, 0, 0, 0)');
    expect(styles.textDecorationLine).toContain('underline');
    expect(styles.fontWeight).toBeGreaterThanOrEqual(500);
  });

  test('drag drop indicators use the row selection axis without layout shift', async ({ page }) => {
    const alpha = rowBody(page, ids.alpha);
    const before = await alpha.evaluate((element) => {
      const contentRect = element.querySelector('.row-content-line')?.getBoundingClientRect();
      if (!contentRect) throw new Error('missing row content');
      return {
        contentLeft: contentRect.left,
      };
    });

    const visual = await alpha.evaluate((element) => {
      const rootStyle = getComputedStyle(document.documentElement);
      element.classList.add('drop-before');
      const dropBeforeClass = element.classList.contains('drop-before');
      element.classList.remove('drop-before');
      element.classList.add('drop-inside');
      const insideStyle = getComputedStyle(element);
      const contentRect = element.querySelector('.row-content-line')?.getBoundingClientRect();
      if (!contentRect) throw new Error('missing row content');
      return {
        dropBeforeClass,
        indicatorLeft: rootStyle.getPropertyValue('--row-selection-start').trim(),
        insideShadow: insideStyle.boxShadow,
        contentLeft: contentRect.left,
      };
    });

    expect(visual.dropBeforeClass).toBe(true);
    expect(visual.indicatorLeft).toBe('21px');
    expect(visual.insideShadow).not.toBe('none');
    expectClose(visual.contentLeft, before.contentLeft);
  });
});
