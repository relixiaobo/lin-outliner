import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('search query builder', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('opens from the search title action and keeps locked searches read-only', async ({ page }) => {
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();

    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Recents');
    const controls = page.locator('.view-toolbar.is-compact-controls');
    await expect(controls).toBeVisible();
    await expect(page.locator('.search-query-summary-bar')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show query' }).click();

    const builder = page.locator('[data-search-query-builder]');
    await expect(builder).toBeVisible();
    await expect(controls).toHaveCount(0);
    await expect(builder.locator('textarea')).toHaveValue([
      '- EDITED_LAST_DAYS',
      '  - value:: 30',
    ].join('\n'));
    await expect(builder.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(page.locator('[data-node-id="recents-query"]')).toHaveCount(0);
    await builder.getByRole('button', { name: 'Close query', exact: true }).click();
    await expect(page.locator('.view-toolbar.is-compact-controls')).toBeVisible();
  });

  test('search outline uses one compact result-view control band', async ({ page }) => {
    const originalViewport = page.viewportSize()!;
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();

    const controls = page.locator('.view-toolbar.is-compact-controls');
    const emptyState = page.locator('.outliner-empty-state');
    await expect(controls).toHaveCount(1);
    await expect(emptyState).toBeVisible();
    await expect(page.locator('.search-query-summary-bar')).toHaveCount(0);
    await expect(controls.getByRole('button', { name: 'Filter by name', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Table', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Display', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Group by', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Sort by', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Filter by', exact: true })).toBeVisible();

    const geometry = await controls.evaluate((toolbar) => {
      const rect = toolbar.getBoundingClientRect();
      const scope = toolbar.parentElement!;
      const scopeRect = scope.getBoundingClientRect();
      const style = getComputedStyle(toolbar);
      const rowSelectionStart = Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--row-selection-start'));
      return {
        background: style.backgroundColor,
        left: rect.left,
        pseudoAfter: getComputedStyle(toolbar, '::after').display,
        pseudoBefore: getComputedStyle(toolbar, '::before').display,
        rowSelectionStart,
        scopeLeft: scopeRect.left,
      };
    });
    expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
    expect(geometry.pseudoBefore).toBe('none');
    expect(geometry.pseudoAfter).toBe('none');
    expect(geometry.left).toBeCloseTo(geometry.scopeLeft + geometry.rowSelectionStart, 1);
    expect(await controls.evaluate((toolbar, empty) => (
      Boolean(toolbar.compareDocumentPosition(empty as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
    ), await emptyState.elementHandle())).toBe(true);

    await page.setViewportSize({ width: 760, height: originalViewport.height });
    const narrowGeometry = await controls.evaluate((toolbar) => {
      const scope = toolbar.parentElement!;
      scope.style.width = 'calc(3 * var(--control-size-xl) + var(--row-selection-start))';
      const toolbarRect = toolbar.getBoundingClientRect();
      const controlSize = Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--control-size-xl'));
      const buttons = [...toolbar.querySelectorAll<HTMLElement>('.view-toolbar-button-row > .view-toolbar-pill')];
      const rowTops = new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
      const geometry = {
        controlsContained: buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= toolbarRect.left - 0.5
            && rect.right <= toolbarRect.right + 0.5
            && rect.width >= controlSize - 0.5;
        }),
        overflowFree: toolbar.scrollWidth <= toolbar.clientWidth + 1,
        rowCount: rowTops.size,
      };
      scope.style.removeProperty('width');
      return geometry;
    });
    expect(narrowGeometry).toEqual({ controlsContained: true, overflowFree: true, rowCount: 2 });
    await page.setViewportSize(originalViewport);

    await controls.getByRole('button', { name: 'Table', exact: true }).click();
    const tableControls = page.locator('.outliner-table-scope > .view-toolbar.is-compact-controls');
    await expect(tableControls).toBeVisible();
    await expect(tableControls.getByRole('button', { name: 'Outline', exact: true })).toBeVisible();
  });
});
