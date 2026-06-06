import { expect, test } from '@playwright/test';
import {
  e2eProjection,
  e2eNodeInlineRef,
  emitDocumentEvent,
  ids,
  openMockedApp,
  row,
  rowBody,
  rowEditor,
  trailingEditor,
} from './outlinerMock';

function expectClose(actual: number, expected: number, tolerance = 0.5) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

async function lastTodayChildId(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  return projection.nodes.find((node) => node.id === ids.today)?.children.at(-1);
}

async function directChevronOpacity(locator: ReturnType<typeof rowBody>) {
  return locator.evaluate((element) => {
    const chevron = element.querySelector(':scope > .row-leading > .row-chevron-button');
    if (!chevron) throw new Error('missing direct row chevron');
    return Number(getComputedStyle(chevron).opacity);
  });
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
        bulletCenterY: bulletRect.top + bulletRect.height / 2,
        contentCenterY: contentRect.top + contentRect.height / 2,
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
        bulletCenterY: bulletRect.top + bulletRect.height / 2,
        editorCenterY: editorRect.top + editorRect.height / 2,
        editorLeft: editorRect.left - rowRect.left,
      };
    });

    expectClose(contentMetrics.chevronLeft, 6);
    expectClose(contentMetrics.chevronWidth, 15);
    expectClose(contentMetrics.bulletLeft, 25);
    expectClose(contentMetrics.bulletWidth, 15);
    expectClose(contentMetrics.contentLeft - contentMetrics.bulletCenter, 15.5);
    expectClose(contentMetrics.bulletCenterY, contentMetrics.contentCenterY);
    expectClose(trailingMetrics.bulletLeft, 25);
    expectClose(trailingMetrics.bulletWidth, 15);
    expectClose(trailingMetrics.editorLeft - trailingMetrics.bulletCenter, 15.5);
    expectClose(trailingMetrics.bulletCenterY, trailingMetrics.editorCenterY);
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
    await page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Schema', exact: true }).click();

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
    await page.getByRole('button', { name: 'Daily Notes', exact: true }).first().click();

    const todayRow = row(page, ids.today);
    const expandedBullet = todayRow.locator('.row-bullet-shape.content.has-children.expanded').first();
    if (await expandedBullet.isVisible().catch(() => false)) {
      await todayRow.locator('.row-chevron-button').first().click({ force: true });
    }
    const collapsedBullet = row(page, ids.today).locator('.row-bullet-shape.content.has-children.collapsed').first();
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

  test('parent chevrons are hover-only and do not duplicate the child bullet state', async ({ page }) => {
    await page.getByRole('button', { name: 'Daily Notes', exact: true }).first().click();

    const dailyRow = rowBody(page, ids.today);
    const restingMetrics = await dailyRow.evaluate((element) => {
      const rowRect = element.getBoundingClientRect();
      const chevron = element.querySelector('.row-chevron-button');
      const chevronShell = element.querySelector('.row-chevron-shell');
      const bullet = element.querySelector('.row-bullet-button');
      const bulletShape = element.querySelector('.row-bullet-shape');
      if (!chevron || !chevronShell || !bullet || !bulletShape) throw new Error('missing row leading elements');
      const chevronRect = chevron.getBoundingClientRect();
      const chevronShellRect = chevronShell.getBoundingClientRect();
      const bulletRect = bullet.getBoundingClientRect();
      const bulletShapeRect = bulletShape.getBoundingClientRect();
      return {
        chevronOpacity: Number(getComputedStyle(chevron).opacity),
        chevronLeft: chevronRect.left - rowRect.left,
        chevronShellWidth: chevronShellRect.width,
        bulletLeft: bulletRect.left - rowRect.left,
        bulletShapeWidth: bulletShapeRect.width,
        bulletCursor: getComputedStyle(bullet).cursor,
      };
    });

    expect(restingMetrics.chevronOpacity).toBe(0);
    expectClose(restingMetrics.chevronLeft, 6);
    expectClose(restingMetrics.bulletLeft, 25);
    expectClose(restingMetrics.chevronShellWidth, restingMetrics.bulletShapeWidth);
    // Strict-native cursor policy: the bullet is a chrome control, not a content
    // hyperlink, so it keeps the arrow cursor instead of switching to the hand.
    expect(restingMetrics.bulletCursor).toBe('default');

    await dailyRow.hover();

    await expect.poll(async () => dailyRow.locator('.row-chevron-button').evaluate((element) =>
      Number(getComputedStyle(element).opacity))).toBeGreaterThan(0.9);
  });

  test('focused row editors do not reveal chevrons without row hover', async ({ page }) => {
    await rowEditor(page, ids.alpha).click();
    await expect(rowEditor(page, ids.alpha)).toBeFocused();

    await page.mouse.move(5, 5);

    await expect.poll(() => directChevronOpacity(rowBody(page, ids.alpha))).toBe(0);
  });

  test('nested field value hover keeps field row chevrons hidden', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('>');
    const fieldId = await lastTodayChildId(page);
    if (!fieldId) throw new Error('missing field');

    await trailingEditor(page, fieldId).click();
    await page.keyboard.type('>');
    const projection = await e2eProjection(page);
    const nestedFieldId = projection.nodes.find((node) => node.id === fieldId)?.children.at(-1);
    if (!nestedFieldId) throw new Error('missing nested field');

    await rowBody(page, nestedFieldId).hover();

    await expect.poll(() => directChevronOpacity(rowBody(page, fieldId))).toBe(0);
    await expect.poll(() => directChevronOpacity(rowBody(page, nestedFieldId))).toBe(0);
  });

  test('trailing placeholder bullet keeps a neutral cursor', async ({ page }) => {
    const cursor = await page.locator(`[data-trailing-parent-id="${ids.today}"] .row-bullet-button`).first().evaluate((element) =>
      getComputedStyle(element).cursor);

    expect(cursor).toBe('default');
  });
});

test.describe('outliner field row visual parity', () => {
  test('root field entries render in normal body order', async ({ page }) => {
    await openMockedApp(page, { optionsField: true });

    const panel = page.locator('.main-panel').first();
    await expect(panel.locator('.panel-heading-fields')).toHaveCount(0);
    await expect(panel.locator(`.panel-inner > .outliner [data-node-id="${ids.priorityEntry}"]`)).toBeVisible();

    const priorityBox = await row(page, ids.priorityEntry).boundingBox();
    const alphaBox = await row(page, ids.alpha).boundingBox();
    expect(priorityBox).toBeTruthy();
    expect(alphaBox).toBeTruthy();
    expect(priorityBox!.y).toBeLessThan(alphaBox!.y);
  });

  test('field value rows use a node-like value preview on the dense label-value axis', async ({ page }) => {
    await openMockedApp(page, { optionsField: true });

    const priorityRow = rowBody(page, ids.priorityEntry);
    // An empty options value now renders a node-like editable row (with a bullet),
    // not a click-to-open picker.
    await expect(priorityRow.locator('.field-value-outliner .row-bullet-button')).toHaveCount(1);
    await expect(priorityRow.locator('.field-value-node-preview')).toHaveAttribute('aria-label', 'Select option');

    const metrics = await priorityRow.evaluate((element) => {
      const name = element.querySelector('.field-name-input')?.getBoundingClientRect();
      const value = element.querySelector('.field-value-node-preview')?.getBoundingClientRect();
      if (!name || !value) throw new Error('missing field row cells');
      return {
        nameCenter: name.top + name.height / 2,
        valueCenter: value.top + value.height / 2,
      };
    });

    expectClose(metrics.nameCenter, metrics.valueCenter, 1);
  });

  test('field label keeps first-line alignment when the value contains multiple rows', async ({ page }) => {
    await openMockedApp(page, { optionsField: true });

    await page.evaluate(async ({ parentId }) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('create_node', { parentId, index: null, text: 'First value' });
      await win.lin?.invoke('create_node', { parentId, index: null, text: 'Second value' });
    }, { parentId: ids.priorityEntry });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    const priorityRow = rowBody(page, ids.priorityEntry);
    await expect(priorityRow.locator('.field-value-outliner .row-wrap')).toHaveCount(2);

    const metrics = await priorityRow.evaluate((element) => {
      const leading = element.querySelector(':scope > .row-leading')?.getBoundingClientRect();
      const name = element.querySelector('.field-name-input')?.getBoundingClientRect();
      const firstValueLeading = element
        .querySelector('.field-value-outliner > .row-wrap:first-child > .row > .row-leading')
        ?.getBoundingClientRect();
      if (!leading || !name || !firstValueLeading) throw new Error('missing field alignment target');
      return {
        leadingTop: leading.top,
        nameTop: name.top,
        firstValueLeadingTop: firstValueLeading.top,
      };
    });

    expectClose(metrics.nameTop, metrics.leadingTop, 1);
    expectClose(metrics.nameTop, metrics.firstValueLeadingTop, 1);
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
              inlineRefs: [e2eNodeInlineRef(4, targetId, 'Alpha')],
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
    await expect(inlineRef).toHaveText('Alpha');

    const styles = await inlineRef.evaluate((element) => {
      const computed = getComputedStyle(element);
      const expected = document.createElement('span');
      expected.style.color = 'var(--inline-ref-default)';
      element.appendChild(expected);
      const expectedColor = getComputedStyle(expected).color;
      expected.remove();
      return {
        display: computed.display,
        background: computed.backgroundColor,
        color: computed.color,
        expectedColor,
        cursor: computed.cursor,
        textDecorationLine: computed.textDecorationLine,
        fontWeight: Number(computed.fontWeight),
      };
    });
    expect(styles.display).toBe('inline');
    expect(styles.background).toBe('rgba(0, 0, 0, 0)');
    expect(styles.color).toBe(styles.expectedColor);
    expect(styles.cursor).toBe('auto');
    expect(styles.textDecorationLine).toBe('none');
    expect(styles.fontWeight).toBeLessThan(500);

    await inlineRef.hover();
    const hoverStyles = await inlineRef.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        cursor: computed.cursor,
        textDecorationLine: computed.textDecorationLine,
      };
    });
    expect(hoverStyles.cursor).toBe('pointer');
    expect(hoverStyles.textDecorationLine).toContain('underline');

    await inlineRef.click();
    const titleEditor = page.locator('.panel-title-editor .ProseMirror').first();
    await expect(titleEditor).toHaveText('Alpha');
    await expect(titleEditor).not.toBeFocused();
  });

  test('inline references use target tag color before the default color', async ({ page }) => {
    await page.evaluate(async ({ nodeId, tagId, targetId }) => {
      const win = window as Window & {
        lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      };
      await win.lin?.invoke('apply_tag', { nodeId: targetId, tagId });
      await win.lin?.invoke('apply_node_text_patch', {
        nodeId,
        patch: {
          ops: [{
            type: 'replace_all',
            content: {
              text: 'See ',
              marks: [],
              inlineRefs: [e2eNodeInlineRef(4, targetId, 'Alpha')],
            },
          }],
        },
      });
    }, { nodeId: ids.beta, tagId: ids.projectTag, targetId: ids.alpha });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    const colors = await row(page, ids.beta).locator('.inline-ref').first().evaluate((element) => {
      const defaultProbe = document.createElement('span');
      defaultProbe.style.color = 'var(--inline-ref-default)';
      const tagProbe = document.createElement('span');
      tagProbe.style.color = '#5e8e65';
      element.append(defaultProbe, tagProbe);
      const result = {
        actual: getComputedStyle(element).color,
        defaultColor: getComputedStyle(defaultProbe).color,
        tagColor: getComputedStyle(tagProbe).color,
      };
      defaultProbe.remove();
      tagProbe.remove();
      return result;
    });
    expect(colors.actual).toBe(colors.tagColor);
    expect(colors.actual).not.toBe(colors.defaultColor);
  });

  test('inline references without display names do not expose node ids', async ({ page }) => {
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
              inlineRefs: [e2eNodeInlineRef(4, targetId)],
            },
          }],
        },
      });
    }, { nodeId: ids.beta, targetId: 'node-missing-inline-ref' });
    await emitDocumentEvent(page, {
      type: 'projection_changed',
      origin: 'test',
      projection: await e2eProjection(page),
      timestamp: Date.now(),
    });

    const inlineRef = row(page, ids.beta).locator('.inline-ref').first();
    await expect(inlineRef).toHaveText('Referenced node');
    await expect(inlineRef).not.toContainText('node-missing-inline-ref');
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
