import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('search query builder', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { searchReferenceChain: true });
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
    const firstResult = page.locator('.outliner-flat-flow-row .row').first();
    const viewMode = controls.getByRole('group', { name: 'View mode', exact: true });
    const outlineMode = viewMode.getByRole('button', { name: 'Outline', exact: true });
    const tableMode = viewMode.getByRole('button', { name: 'Table', exact: true });
    await expect(controls).toHaveCount(1);
    await expect(firstResult).toBeVisible();
    await expect(page.locator('.search-query-summary-bar')).toHaveCount(0);
    await expect(controls.getByRole('button', { name: 'Filter by name', exact: true })).toBeVisible();
    await expect(outlineMode).toHaveAttribute('aria-pressed', 'true');
    await expect(tableMode).toHaveAttribute('aria-pressed', 'false');
    await expect(controls.getByRole('button', { name: 'Display', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Group by', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Sort by', exact: true })).toBeVisible();
    await expect(controls.getByRole('button', { name: 'Filter by', exact: true })).toBeVisible();
    await expect(viewMode).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(viewMode).not.toHaveCSS('box-shadow', 'none');

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
        pseudoAfter: getComputedStyle(toolbar, '::after').display,
        pseudoBefore: getComputedStyle(toolbar, '::before').display,
        resolvedMarginLeft: Number.parseFloat(style.marginLeft),
        scopeLeft: scopeRect.left,
      };
    });
    expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
    expect(geometry.pseudoBefore).toBe('none');
    expect(geometry.pseudoAfter).toBe('none');
    expect(geometry.left).toBeCloseTo(geometry.firstContentLeft, 1);
    expect(geometry.left).toBeCloseTo(geometry.scopeLeft + geometry.resolvedMarginLeft, 1);
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

    await outlineMode.hover();
    await expect(outlineMode).toHaveAttribute('title', 'Outline');
    await expect(tableMode).toHaveAttribute('title', 'Table');
    await expect(tooltip).toHaveCount(0);

    await page.setViewportSize({ width: 760, height: originalViewport.height });
    const narrowGeometry = await controls.evaluate((toolbar) => {
      const scope = toolbar.parentElement!;
      const controlSize = Number.parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--control-size-xl'));
      const contentStart = Number.parseFloat(getComputedStyle(toolbar).marginLeft);
      scope.style.width = `calc(3 * var(--control-size-xl) + ${contentStart}px)`;
      const toolbarRect = toolbar.getBoundingClientRect();
      const controls = [...toolbar.querySelectorAll<HTMLElement>(
        '.view-toolbar-button-row > .view-toolbar-pill, .view-toolbar-mode-button',
      )];
      const modeButtons = [...toolbar.querySelectorAll<HTMLElement>('.view-toolbar-mode-button')];
      const modeGroup = toolbar.querySelector<HTMLElement>('.view-toolbar-mode')!;
      const geometry = {
        controlsContained: controls.every((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left >= toolbarRect.left - 0.5
            && rect.right <= toolbarRect.right + 0.5
            && rect.width >= controlSize - 0.5;
        }),
        modeGroupIntact: modeButtons.every((button) => (
          Math.abs(button.getBoundingClientRect().top - modeGroup.getBoundingClientRect().top) < 0.5
        )) && modeGroup.getBoundingClientRect().width >= (2 * controlSize) - 0.5,
        overflowFree: toolbar.scrollWidth <= toolbar.clientWidth + 1,
        wrapped: toolbarRect.height > controlSize + 0.5,
      };
      scope.style.removeProperty('width');
      return geometry;
    });
    expect(narrowGeometry).toEqual({
      controlsContained: true,
      modeGroupIntact: true,
      overflowFree: true,
      wrapped: true,
    });
    await page.setViewportSize(originalViewport);

    await tableMode.click();
    const tableControls = page.locator('.outliner-table-scope > .view-toolbar.is-compact-controls');
    const tableViewMode = tableControls.getByRole('group', { name: 'View mode', exact: true });
    await expect(tableControls).toBeVisible();
    await expect(tableViewMode.getByRole('button', { name: 'Outline', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(tableViewMode.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true');
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
