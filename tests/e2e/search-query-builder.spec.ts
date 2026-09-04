import { expect, test, type Page } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

async function switchCurrentViewFromContextMenu(page: Page, mode: 'Outline' | 'Table') {
  await page.locator('.panel-title-editor').first().click({ button: 'right' });
  const viewAs = page.getByRole('menu', { name: 'Node actions' })
    .getByRole('menuitem', { name: 'View as', exact: true });
  await viewAs.hover();
  await page.getByRole('menu', { name: 'View as' })
    .getByRole('menuitemradio', { name: mode, exact: true })
    .click();
}

test.describe('search query builder', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { searchReferenceChain: true });
  });

  test('opens from the search title action and keeps locked searches read-only', async ({ page }) => {
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();

    await expect(page.locator('.outline-panel-surface.active-panel .panel-title-editor')).toContainText('Recents');
    const controls = page.locator('.view-toolbar');
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
    await expect(page.locator('.view-toolbar')).toBeVisible();
  });

  test('lets a search hide and restore the shared toolbar explicitly', async ({ page }) => {
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();

    const title = page.locator('.panel-title-editor').first();
    const toolbar = page.locator('.view-toolbar');
    await expect(toolbar).toBeVisible();

    await title.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide view toolbar', exact: true }).click();
    await expect(toolbar).toHaveCount(0);

    await page.getByRole('button', { name: 'Show query', exact: true }).click();
    await page.getByRole('button', { name: 'Close query', exact: true }).click();
    await expect(toolbar).toHaveCount(0);

    await title.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show view toolbar', exact: true }).click();
    await expect(toolbar).toBeVisible();
  });

  test('search outline and table use the same configuration toolbar', async ({ page }) => {
    const originalViewport = page.viewportSize()!;
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();

    const controls = page.locator('.view-toolbar');
    const firstResult = page.locator('.outliner-flat-flow-row .row').first();
    await expect(controls).toHaveCount(1);
    await expect(firstResult).toBeVisible();
    await expect(page.locator('.search-query-summary-bar')).toHaveCount(0);
    await expect(controls.getByRole('button', { name: 'Filter by name', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Outline', exact: true })).toHaveCount(0);
    await expect(controls.getByRole('button', { name: 'Table', exact: true })).toHaveCount(0);
    await expect(controls.getByRole('button', { name: 'Display', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(controls.getByRole('button', { name: 'Group by', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Sort by', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Filter by', exact: true })).toBeVisible();
    const outlineButtonLabels = await controls.locator(
      '.view-toolbar-button-row .view-toolbar-pill',
    ).evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')
    ));

    const geometry = await controls.evaluate((toolbar) => {
      const rect = toolbar.getBoundingClientRect();
      const scope = toolbar.parentElement!;
      const scopeRect = scope.getBoundingClientRect();
      const firstContent = document.querySelector<HTMLElement>('.outliner-flat-flow-row .row-content-line')!;
      const style = getComputedStyle(toolbar);
      return {
        background: style.backgroundColor,
        firstContentLeft: firstContent.getBoundingClientRect().left,
        left: rect.left,
        resolvedMarginLeft: Number.parseFloat(style.marginLeft),
        scopeLeft: scopeRect.left,
        right: rect.right,
        scopeRight: scopeRect.right,
      };
    });
    expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
    expect(geometry.left).toBeCloseTo(geometry.firstContentLeft, 1);
    expect(geometry.left).toBeCloseTo(geometry.scopeLeft + geometry.resolvedMarginLeft, 1);
    expect(geometry.right).toBeCloseTo(geometry.scopeRight, 1);
    expect(await controls.evaluate((toolbar, result) => (
      Boolean(toolbar.compareDocumentPosition(result as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
    ), await firstResult.elementHandle())).toBe(true);

    const nameFilter = controls.getByRole('button', { name: 'Filter by name', exact: true });
    await nameFilter.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toHaveText('Filter by name');
    const nameFilterBox = await nameFilter.boundingBox();
    expect(nameFilterBox).not.toBeNull();
    const tooltipGeometry = await tooltip.evaluate((element) => {
      const tooltipRect = element.getBoundingClientRect();
      return {
        tooltipLeft: tooltipRect.left,
        tooltipRight: tooltipRect.right,
        tooltipTop: tooltipRect.top,
        tooltipWidth: tooltipRect.width,
      };
    });
    expect(tooltipGeometry.tooltipLeft).toBeLessThan(nameFilterBox!.x + nameFilterBox!.width);
    expect(tooltipGeometry.tooltipRight).toBeGreaterThan(nameFilterBox!.x);
    expect(tooltipGeometry.tooltipTop).toBeGreaterThanOrEqual(nameFilterBox!.y + nameFilterBox!.height);
    expect(tooltipGeometry.tooltipWidth).toBeLessThan(180);

    await controls.getByRole('button', { name: 'Sort by', exact: true }).hover();
    await expect(tooltip).toHaveText('Sort by');
    const shortTooltipWidth = await tooltip.evaluate((element) => element.getBoundingClientRect().width);
    expect(shortTooltipWidth).toBeLessThan(tooltipGeometry.tooltipWidth);

    await page.setViewportSize({ width: 760, height: originalViewport.height });
    const narrowGeometry = await controls.evaluate((toolbar) => {
      const scope = toolbar.parentElement!;
      const controlSize = Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--control-size-xl'));
      const contentStart = Number.parseFloat(getComputedStyle(toolbar).marginLeft);
      scope.style.width = `${2 * controlSize + contentStart}px`;
      const row = toolbar.querySelector<HTMLElement>('.view-toolbar-button-row')!;
      const controls = [...toolbar.querySelectorAll<HTMLElement>(
        '.view-toolbar-button-row .view-toolbar-pill',
      )];
      const controlCenter = (() => {
        const rect = controls[0]!.getBoundingClientRect();
        return rect.top + rect.height / 2;
      })();
      const geometry = {
        controlsUnshrunk: controls.every((control) => (
          control.getBoundingClientRect().width >= controlSize - 0.5
        )),
        ownsHorizontalOverflow: getComputedStyle(row).overflowX === 'auto'
          && row.scrollWidth > row.clientWidth + 1,
        scrollbarHidden: getComputedStyle(row).scrollbarWidth === 'none',
        singleLine: getComputedStyle(row).flexWrap === 'nowrap'
          && controls.every((control) => {
            const rect = control.getBoundingClientRect();
            return Math.abs(rect.top + rect.height / 2 - controlCenter) < 0.5;
          }),
      };
      scope.style.removeProperty('width');
      return geometry;
    });
    expect(narrowGeometry).toEqual({
      controlsUnshrunk: true,
      ownsHorizontalOverflow: true,
      scrollbarHidden: true,
      singleLine: true,
    });
    await page.setViewportSize(originalViewport);

    await switchCurrentViewFromContextMenu(page, 'Table');
    const tableControls = page.locator('.outliner-table-scope > .view-toolbar');
    await expect(tableControls).toBeVisible();
    await expect(tableControls.getByRole('button', { name: 'Outline', exact: true })).toHaveCount(0);
    await expect(tableControls.getByRole('button', { name: 'Table', exact: true })).toHaveCount(0);
    const tableButtonLabels = await tableControls.locator(
      '.view-toolbar-button-row .view-toolbar-pill',
    ).evaluateAll((buttons) => (
      buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')
    ));
    expect(tableButtonLabels).toEqual(outlineButtonLabels);
    await expect(tableControls.getByRole('button', { name: 'Display', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(tableControls.locator('.view-toolbar-summary-chip')).toHaveCount(0);
  });
});

test.describe('truncated search query builder', () => {
  test('keeps an over-limit projection visible but unwritable', async ({ page }) => {
    await openMockedApp(page, { truncatedSearchQuery: true });
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Recents', exact: true })
      .click();
    await page.getByRole('button', { name: 'Show query' }).click();

    const builder = page.locator('[data-search-query-builder]');
    const warning = builder.getByRole('alert');
    await expect(warning).toContainText('Some rules are omitted');
    await expect(builder.locator('textarea')).toHaveAttribute('readonly', '');
    await expect(builder.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
    const save = builder.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();

    await save.click({ force: true });
    const queryWrites = await page.evaluate(() => (
      (window as Window & { __LIN_E2E__?: { calls: Array<{ cmd: string }> } })
        .__LIN_E2E__?.calls.filter((call) => call.cmd === 'set_search_query_outline').length ?? 0
    ));
    expect(queryWrites).toBe(0);
  });
});
