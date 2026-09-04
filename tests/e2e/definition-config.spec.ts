import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  ids,
  nodeById,
  openMockedApp,
  row,
  rowBody,
} from './outlinerMock';

async function openSchema(page: Page) {
  await page.locator('.sidebar-primary-nav')
    .getByRole('button', { name: 'Schema', exact: true })
    .click();
}

async function chooseConfigOption(
  page: Page,
  label: string,
  option: string,
) {
  await page.getByLabel(label).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function showViewToolbar(page: Page, nodeId: string) {
  await page.evaluate(async (targetNodeId) => {
    const win = window as typeof window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
    };
    const outcome = await win.lin!.invoke<{ update: { projection: unknown } }>('set_view_toolbar_visible', {
      nodeId: targetNodeId,
      visible: true,
    });
    win.__LIN_E2E__?.emitDocumentEvent({ type: 'projection_changed', projection: outcome.update.projection });
  }, nodeId);
}

async function invokeDocumentCommand(page: Page, cmd: string, args: Record<string, unknown>) {
  await page.evaluate(async ({ cmd, args }) => {
    const win = window as typeof window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
    };
    const outcome = await win.lin!.invoke<{ update: { projection: unknown } }>(cmd, args);
    win.__LIN_E2E__?.emitDocumentEvent({ type: 'projection_changed', projection: outcome.update.projection });
  }, { cmd, args });
}

async function expectToolbarButtonIsUnconfigured(toolbar: Locator, name: string) {
  const button = toolbar.getByRole('button', { name, exact: true });
  await expect(button.locator('.view-toolbar-pill-count')).toHaveCount(0);
  await expect(button).not.toHaveClass(/is-configured/);
  await expect(button).toHaveAttribute('aria-pressed', 'false');
}

async function expectToolbarButtonIsConfigured(toolbar: Locator, name: string) {
  const button = toolbar.getByRole('button', { name, exact: true });
  await expect(button.locator('.view-toolbar-pill-count')).toHaveCount(0);
  await expect(button).toHaveClass(/is-configured/);
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

async function expectToolbarButtonUsesConfiguredColor(toolbar: Locator, name: string) {
  const button = toolbar.getByRole('button', { name, exact: true });
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(button).toHaveCSS('color', 'rgb(63, 158, 106)');
}

async function expectFilterChipPairedWithControl(
  toolbar: Locator,
  summaryText: string,
): Promise<Locator> {
  const controlGroup = toolbar.locator(
    '.view-toolbar-control-group[data-toolbar-section="filter"]',
  );
  const summaryChip = controlGroup.locator('.view-toolbar-summary-chip', { hasText: summaryText });
  await expect(controlGroup.getByRole('button', { name: 'Filter by', exact: true })).toBeVisible();
  await expect(summaryChip).toBeVisible();
  await expect(summaryChip.locator('.view-toolbar-summary-chip-main')).toHaveText(summaryText);
  const childOrder = await controlGroup.evaluate((group) => (
    [...group.children].map((child) => {
      if (child.classList.contains('view-toolbar-pill')) return 'control';
      if (child.classList.contains('view-toolbar-summary')) return 'summary';
      return 'unknown';
    })
  ));
  expect(childOrder).toEqual(['control', 'summary']);
  return summaryChip;
}

test.describe('definition configuration parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('tag definitions render virtual config rows and write typed config patches', async ({ page }) => {
    await openSchema(page);
    await row(page, ids.dayTag).getByRole('button', { name: 'Open' }).click();

    await expect(page.getByRole('region', { name: 'Definition configuration' })).toBeVisible();
    await page.locator('[data-config-key="color"]').getByRole('radio', { name: 'Green', exact: true }).click();
    await chooseConfigOption(page, 'Extend from', 'project');
    await page.getByRole('switch', { name: 'Show as checkbox' }).click();
    await chooseConfigOption(page, 'Default child supertag', 'project');

    await expect.poll(async () => {
      const node = await nodeById(page, ids.dayTag);
      return {
        color: node?.color,
        extends: node?.extends,
        childSupertag: node?.childSupertag,
        showCheckbox: node?.showCheckbox,
      };
    }).toEqual({
      color: 'green',
      extends: ids.projectTag,
      childSupertag: ids.projectTag,
      showCheckbox: true,
    });
  });

  test('field definitions render config rows by field type and clear stale type-specific state', async ({ page }) => {
    await openSchema(page);
    await row(page, ids.statusField).getByRole('button', { name: 'Open' }).click();

    await chooseConfigOption(page, 'Field type', 'number');
    const minValue = page.getByLabel('Minimum value');
    await expect(minValue).toBeVisible();
    await expect(minValue).toHaveClass(/input-bare/);
    await expect(minValue).not.toHaveClass(/input-boxed/);
    await expect(minValue).toHaveCSS('height', '28px');
    await expect(minValue).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await minValue.fill('1');
    await minValue.blur();
    await page.getByLabel('Maximum value').fill('5');
    await page.getByLabel('Maximum value').blur();
    // Auto-initialize is a multi-select picker (a field can carry several
    // strategies); pick one, then close the still-open checklist with Escape.
    await page.getByLabel('Auto-initialize').click();
    await page.getByRole('option', { name: 'Ancestor field value', exact: true }).click();
    await page.keyboard.press('Escape');
    const requiredSwitch = page.getByRole('switch', { name: 'Required' });
    const requiredSwitchMark = requiredSwitch.locator('.switch-mark');
    await expect(requiredSwitchMark).toHaveCount(1);
    await expect(requiredSwitchMark).not.toHaveClass(/checked/);
    await expect(requiredSwitchMark).toHaveCSS('width', '30px');
    await expect(requiredSwitchMark).toHaveCSS('height', '18px');
    await expect(requiredSwitch.locator('.switch-mark-thumb')).toHaveCSS('width', '14px');
    await requiredSwitch.click();
    await expect(requiredSwitchMark).toHaveClass(/checked/);
    await chooseConfigOption(page, 'Hide field', 'When empty');

    await expect.poll(async () => {
      const node = await nodeById(page, ids.statusField);
      return {
        fieldType: node?.fieldType,
        nullable: node?.nullable,
        hideField: node?.hideField,
        autoInitialize: node?.autoInitialize,
        minValue: node?.minValue,
        maxValue: node?.maxValue,
      };
    }).toEqual({
      fieldType: 'number',
      nullable: false,
      hideField: 'empty',
      autoInitialize: 'ancestor_field_value',
      minValue: 1,
      maxValue: 5,
    });

    await chooseConfigOption(page, 'Field type', 'options');
    const fieldTypeValueMarker = page.locator(
      '[data-config-key="fieldType"] .definition-config-control .field-option-picker-leading',
    );
    await expect(fieldTypeValueMarker.locator('.row-bullet-shape.content')).toHaveCount(1);
    await expect(fieldTypeValueMarker.locator('svg')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Auto-collect values' })).toBeVisible();
    await expect(page.getByLabel('Minimum value')).toHaveCount(0);

    await expect.poll(async () => {
      const node = await nodeById(page, ids.statusField);
      return {
        fieldType: node?.fieldType,
        minValue: node?.minValue,
        maxValue: node?.maxValue,
      };
    }).toEqual({
      fieldType: 'options',
      minValue: undefined,
      maxValue: undefined,
    });
  });

  test('view toolbar sort uses a Tana-style field-first drill-in menu', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    const toolbar = page.locator('.view-toolbar');
    await expect(toolbar).toBeVisible();
    for (const name of ['Filter by name', 'Display', 'Group by', 'Sort by', 'Filter by']) {
      const button = toolbar.getByRole('button', { name, exact: true });
      await expect(button).toHaveAttribute('data-tooltip', name);
      await expect(button).not.toHaveAttribute('title', /.*/);
    }
    await toolbar.getByRole('button', { name: 'Display', exact: true }).hover();
    await expect(page.getByRole('tooltip', { name: 'Display' })).toBeVisible();
    await toolbar.getByRole('button', { name: 'Sort by' }).click();

    const dialog = page.getByRole('dialog', { name: 'Sort by' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('System fields')).toBeVisible();
    await expect(dialog.getByText('Created time')).toBeVisible();
    await expect(dialog.getByText('Date from calendar node')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Tags/ })).toHaveCount(0);

    await dialog.getByRole('button', { name: /Created time/ }).click();
    await expect(dialog.locator('.view-toolbar-filter-back')).toContainText('Created time');
    await expect(dialog.getByRole('radio', { name: 'Old → New' })).toBeVisible();
    await expect(toolbar.locator('.view-toolbar-summary-chip')).toHaveCount(0);
    await expectToolbarButtonIsConfigured(toolbar, 'Sort by');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expectToolbarButtonIsConfigured(toolbar, 'Sort by');
    await expectToolbarButtonUsesConfiguredColor(toolbar, 'Sort by');
    await toolbar.getByRole('button', { name: 'Sort by' }).click();
    await expect(dialog).toBeVisible();
    await expect(toolbar.locator('.view-toolbar-summary-chip')).toHaveCount(0);
    await expect(dialog.locator('.view-toolbar-filter-back')).toHaveCount(0);
    await expect(dialog.locator('.view-toolbar-option', { hasText: 'Created time' })).toContainText('1. Old → New');
  });

  test('view toolbar sort blocks duplicate pending adds after back navigation', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await page.evaluate(() => {
      const win = window as typeof window & {
        __LIN_E2E_SORT_DELAY__?: { attempts: number; release: () => void };
        lin?: { outline?: { request: <T>(request: { command: string; input: unknown }) => Promise<T> } };
      };
      const outline = win.lin!.outline!;
      const originalRequest = outline.request.bind(outline);
      let releasePending: (() => void) | null = null;
      win.__LIN_E2E_SORT_DELAY__ = {
        attempts: 0,
        release: () => releasePending?.(),
      };
      outline.request = async <T,>(request: { command: string; input: unknown }) => {
        const input = request.input as {
          diff?: { normalizedChangeSet?: { operations?: Array<{ changes?: Array<Record<string, unknown>> }> } };
          changeSet?: { operations?: Array<{ changes?: Array<Record<string, unknown>> }> };
        };
        const operations = request.command === 'apply'
          ? input.diff?.normalizedChangeSet?.operations ?? []
          : request.command === 'transact' ? input.changeSet?.operations ?? [] : [];
        const addsSort = operations
          .some((operation) => (operation.changes ?? []).some((change) => (
            change.kind === 'view' && change.property === 'sort' && change.action === 'add'
          )));
        if (addsSort) {
          win.__LIN_E2E_SORT_DELAY__!.attempts += 1;
          await new Promise<void>((resolve) => {
            releasePending = resolve;
          });
        }
        return originalRequest<T>(request);
      };
    });

    const toolbar = page.locator('.view-toolbar');
    await toolbar.getByRole('button', { name: 'Sort by' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sort by' });
    await dialog.getByRole('button', { name: /Created time/ }).click();
    await expect(dialog.getByText('Adding sort…')).toBeVisible();

    await dialog.locator('.view-toolbar-filter-back').click();
    const createdButton = dialog.getByRole('button', { name: /Created time/ });
    await expect(createdButton).toBeDisabled();
    await expect.poll(async () => page.evaluate(() => {
      const win = window as typeof window & { __LIN_E2E_SORT_DELAY__?: { attempts: number } };
      return win.__LIN_E2E_SORT_DELAY__?.attempts ?? 0;
    })).toBe(1);

    await page.evaluate(() => {
      const win = window as typeof window & { __LIN_E2E_SORT_DELAY__?: { release: () => void } };
      win.__LIN_E2E_SORT_DELAY__?.release();
    });
    await expectToolbarButtonIsConfigured(toolbar, 'Sort by');
  });

  test('row context menu expands a collapsed node when revealing its view toolbar', async ({ page }) => {
    await invokeDocumentCommand(page, 'set_view_toolbar_visible', { nodeId: ids.alpha, visible: true });
    await expect(row(page, ids.alpha).locator('.view-toolbar')).toHaveCount(0);

    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show view toolbar' }).click();

    await expect(page.locator('.view-toolbar')).toBeVisible();
    await expect(row(page, ids.alpha).getByRole('button', { name: 'Collapse' })).toBeVisible();
  });

  test('nested view toolbar aligns its first control with the owner bullet and stays frameless', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'set_view_toolbar_visible', { nodeId: ids.alpha, visible: true });

    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show view toolbar' }).click();

    const rootToolbar = page.locator('.view-toolbar').nth(0);
    const nestedToolbar = page.locator('.view-toolbar').nth(1);
    await expect(rootToolbar).toBeVisible();
    await expect(nestedToolbar).toBeVisible();

    const geometry = await page.evaluate((ownerId) => {
      const toolbars = [...document.querySelectorAll<HTMLElement>('.view-toolbar')];
      const rootRect = toolbars[0]?.getBoundingClientRect();
      const nestedRect = toolbars[1]?.getBoundingClientRect();
      const firstControlRect = toolbars[1]
        ?.querySelector<HTMLElement>('.view-toolbar-pill')
        ?.getBoundingClientRect();
      const bulletRect = document.querySelector<HTMLElement>(
        `[data-node-id="${ownerId}"] > .row > .row-leading .row-bullet-button`,
      )?.getBoundingClientRect();
      const before = toolbars[1] ? getComputedStyle(toolbars[1], '::before') : null;
      const after = toolbars[1] ? getComputedStyle(toolbars[1], '::after') : null;
      return {
        rootLeft: rootRect?.left ?? 0,
        nestedLeft: nestedRect?.left ?? 0,
        firstControlCenter: firstControlRect ? firstControlRect.left + firstControlRect.width / 2 : 0,
        bulletCenter: bulletRect ? bulletRect.left + bulletRect.width / 2 : 0,
        beforeContent: before?.content ?? '',
        afterContent: after?.content ?? '',
      };
    }, ids.alpha);

    expect(Math.abs(geometry.nestedLeft - geometry.rootLeft)).toBeLessThan(2);
    expect(Math.abs(geometry.firstControlCenter - geometry.bulletCenter)).toBeLessThan(2);
    expect(geometry.beforeContent).toBe('none');
    expect(geometry.afterContent).toBe('none');
  });

  test('view toolbar display fields stay out of Outline descriptions and remain available to Table', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'apply_tag', { nodeId: ids.alpha, tagId: ids.projectTag });
    await invokeDocumentCommand(page, 'add_display_field', { nodeId: ids.today, field: 'sys:tags' });

    const toolbar = page.locator('.view-toolbar');
    await expect(toolbar).toBeVisible();
    await expectToolbarButtonIsConfigured(toolbar, 'Display');
    await expectToolbarButtonUsesConfiguredColor(toolbar, 'Display');
    await expect(toolbar.locator('.view-toolbar-summary-chip')).toHaveCount(0);
    await toolbar.getByRole('button', { name: 'Display', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Display' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Created time')).toBeVisible();
    await expect(dialog.getByText('Date from calendar node')).toBeVisible();
    await expect(dialog.getByText('Owner node')).toBeVisible();
    await expect(dialog.getByText('Tags')).toBeVisible();
    await expect(dialog.getByText('Number of references')).toHaveCount(0);

    await expect(row(page, ids.alpha).locator('.view-display-fields')).toHaveCount(0);
    await expect(row(page, ids.beta).locator('.view-display-fields')).toHaveCount(0);

    await invokeDocumentCommand(page, 'set_view_mode', { nodeId: ids.today, mode: 'table' });
    await expect(page.getByRole('columnheader').filter({ hasText: 'Tags' })).toBeVisible();
  });

  test('field-only Nodes keep parent disclosure state', async ({ page }) => {
    await invokeDocumentCommand(page, 'create_inline_field', {
      parentId: ids.alpha,
      index: null,
      name: 'Status',
      fieldType: 'plain',
    });

    const alpha = row(page, ids.alpha);
    const marker = alpha.locator(':scope > .row > .row-leading .row-bullet-shape.content');
    await expect(marker).toHaveClass(/has-children/);
    await expect(marker).toHaveClass(/collapsed/);
    await expect(alpha).toHaveAttribute('aria-expanded', 'false');

    await alpha.hover();
    await alpha.locator(':scope > .row > .row-leading .row-chevron-button').click();
    await expect(alpha).toHaveAttribute('aria-expanded', 'true');
    await expect(marker).toHaveClass(/expanded/);
  });

  test('view toolbar group state activates the control without a summary chip', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'set_group_field', { nodeId: ids.today, field: 'sys:done' });

    const toolbar = page.locator('.view-toolbar');
    await expectToolbarButtonIsConfigured(toolbar, 'Group by');
    await expectToolbarButtonUsesConfiguredColor(toolbar, 'Group by');
    await expect(toolbar.locator('.view-toolbar-summary-chip')).toHaveCount(0);

    await toolbar.getByRole('button', { name: 'Group by', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Group by' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Done', exact: true })).toHaveAttribute('aria-checked', 'true');
  });

  test('view toolbar filter rule chip opens the matching rule editor', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:tags',
      operator: 'contains',
      values: ['project'],
      valueLogic: 'any',
    });

    const toolbar = page.locator('.view-toolbar');
    const filterChip = await expectFilterChipPairedWithControl(toolbar, 'Tags: project');
    await expectToolbarButtonIsConfigured(toolbar, 'Filter by');
    await expectToolbarButtonUsesConfiguredColor(toolbar, 'Filter by');
    await filterChip.locator('.view-toolbar-summary-chip-main').click();

    const dialog = page.getByRole('dialog', { name: 'Filter by' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.view-toolbar-filter-back')).toContainText('Tags');
    await expect(dialog.getByLabel('Filter values')).toHaveValue('project');
    await page.keyboard.press('Escape');

    await filterChip.getByRole('button', { name: 'Remove filter rule' }).click();
    await expect(toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Tags' })).toHaveCount(0);
    await expectToolbarButtonIsUnconfigured(toolbar, 'Filter by');
    await expect(row(page, ids.alpha)).toBeVisible();
  });

  test('view toolbar filter chips use compact labels and scroll overflow', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:done',
      operator: 'is',
      values: ['false'],
      valueLogic: 'any',
    });
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:tags',
      operator: 'contains',
      values: ['project', 'archive'],
      valueLogic: 'all',
    });
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:createdAt',
      operator: 'is',
      values: ['2026-09-03'],
      valueLogic: 'any',
    });
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:updatedAt',
      operator: 'is_not_empty',
      values: [],
      valueLogic: 'any',
    });

    const toolbar = page.locator('.view-toolbar');
    await expectFilterChipPairedWithControl(toolbar, 'Not done');
    await expectFilterChipPairedWithControl(toolbar, 'Tags: project and archive');
    await expectFilterChipPairedWithControl(toolbar, 'Created: 2026-09-03');
    await expectFilterChipPairedWithControl(toolbar, 'Edited: Set');
    await expectToolbarButtonIsConfigured(toolbar, 'Filter by');
    const toolbarRow = toolbar.locator('.view-toolbar-button-row');
    await expect.poll(() => toolbarRow.evaluate((row) => row.scrollWidth > row.clientWidth)).toBe(true);
    await toolbarRow.hover();
    await page.mouse.wheel(0, 240);
    await expect.poll(() => toolbarRow.evaluate((row) => row.scrollLeft)).toBeGreaterThan(0);
  });

  test('view toolbar filter chips edit the exact rule when a field has multiple filters', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:name',
      operator: 'contains',
      values: ['Al'],
      valueLogic: 'any',
    });
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:tags',
      operator: 'contains',
      values: ['project'],
      valueLogic: 'any',
    });
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:tags',
      operator: 'not_contains',
      values: ['archive'],
      valueLogic: 'any',
    });

    const toolbar = page.locator('.view-toolbar');
    const filterChips = toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Tags' });
    await expect(filterChips).toHaveCount(2);
    await expect(filterChips.locator('.view-toolbar-summary-chip-main')).toHaveText([
      'Tags: project',
      'Tags · Does not contain · archive',
    ]);

    await filterChips.nth(0).locator('.view-toolbar-summary-chip-main').click();
    const dialog = page.getByRole('dialog', { name: 'Filter by' });
    await expect(dialog.getByLabel('Filter operator')).toHaveValue('contains');
    await expect(dialog.getByLabel('Filter values')).toHaveValue('project');
    await dialog.getByLabel('Filter values').fill('stale');

    await filterChips.nth(1).locator('.view-toolbar-summary-chip-main').click();
    await expect(dialog.getByLabel('Filter operator')).toHaveValue('not_contains');
    await expect(dialog.getByLabel('Filter values')).toHaveValue('archive');
    await dialog.getByLabel('Filter values').blur();

    await expect(filterChips.locator('.view-toolbar-summary-chip-main')).toHaveText([
      'Tags: stale',
      'Tags · Does not contain · archive',
    ]);

    await expect.poll(async () => page.evaluate(() => {
      const win = window as typeof window & {
        __LIN_E2E__?: { projection: () => { nodes: Array<Record<string, unknown>> } };
      };
      return win.__LIN_E2E__!.projection().nodes
        .filter((node) => node.type === 'filterRule' && node.filterField === 'sys:tags')
        .map((node) => [node.filterOperator, node.filterValues]);
    })).toEqual([
      ['contains', ['stale']],
      ['not_contains', ['archive']],
    ]);
  });

  test('view toolbar filter keeps filtered-out rows behind an expandable disclosure', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'toggle_done', { nodeId: ids.alpha });
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:done',
      operator: 'is',
      values: ['true'],
      valueLogic: 'any',
    });

    const toolbar = page.locator('.view-toolbar');
    const filterChip = await expectFilterChipPairedWithControl(toolbar, 'Done');
    await expect(filterChip.locator('.view-toolbar-summary-chip-remove')).toBeVisible();
    await expectToolbarButtonIsConfigured(toolbar, 'Filter by');
    const filterButton = toolbar.getByRole('button', { name: 'Filter by', exact: true });
    const [filterBox, chipBox] = await Promise.all([filterButton.boundingBox(), filterChip.boundingBox()]);
    expect(filterBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    expect(Math.abs(filterBox!.y - chipBox!.y)).toBeLessThan(2);
    expect(filterBox!.x + filterBox!.width).toBeLessThanOrEqual(chipBox!.x);

    await expect(row(page, ids.alpha)).toBeVisible();
    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, ids.gamma)).toHaveCount(0);

    const filteredOut = page.getByRole('button', { name: '2 items filtered out' });
    await expect(filteredOut).toBeVisible();
    const [filteredTextBox, bulletBox] = await Promise.all([
      filteredOut.locator('span').first().boundingBox(),
      row(page, ids.alpha).locator(':scope > .row > .row-leading .row-bullet-button').boundingBox(),
    ]);
    expect(filteredTextBox).not.toBeNull();
    expect(bulletBox).not.toBeNull();
    expect(Math.abs(filteredTextBox!.x - bulletBox!.x)).toBeLessThan(2);
    await filteredOut.click();
    await expect(row(page, ids.beta)).toBeVisible();
    await expect(row(page, ids.gamma)).toBeVisible();
    await expect(filteredOut).toHaveAttribute('aria-expanded', 'true');
  });

  test('view toolbar filter field list starts with real system fields and contextual custom fields', async ({ page }) => {
    await showViewToolbar(page, ids.today);

    const toolbar = page.locator('.view-toolbar');
    await toolbar.getByRole('button', { name: 'Filter by', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Filter by' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('No matching fields')).toHaveCount(0);
    await expect(dialog.getByText('System fields')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Created time/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Date from calendar node/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Owner node/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Tags/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Number of references/ })).toHaveCount(0);

    await page.keyboard.press('Escape');
    await invokeDocumentCommand(page, 'create_inline_field', {
      parentId: ids.alpha,
      index: null,
      name: 'Status',
      fieldType: 'plain',
    });

    await toolbar.getByRole('button', { name: 'Filter by', exact: true }).click();
    await expect(dialog.getByText('No matching fields')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /Status/ })).toBeVisible();
  });

  test('nested view toolbar filter field list includes Done', async ({ page }) => {
    const nestedCheckboxId = 'nested-checkbox';
    await invokeDocumentCommand(page, 'create_node', {
      parentId: ids.alpha,
      index: null,
      text: 'Nested checkbox',
      id: nestedCheckboxId,
    });
    await invokeDocumentCommand(page, 'cycle_done_state', { nodeId: nestedCheckboxId });
    await invokeDocumentCommand(page, 'set_view_toolbar_visible', { nodeId: ids.alpha, visible: true });

    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show view toolbar' }).click();

    const nestedToolbar = page.locator('.view-toolbar').first();
    await expect(nestedToolbar).toBeVisible();
    await nestedToolbar.getByRole('button', { name: 'Filter by', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Filter by' });
    await expect(dialog.getByText('No matching fields')).toHaveCount(0);
    await expect(dialog.getByText('System fields')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  });

  test('view toolbar filters child rows by name from the search chip', async ({ page }) => {
    await showViewToolbar(page, ids.today);

    const toolbar = page.locator('.view-toolbar');
    await toolbar.getByRole('button', { name: 'Filter by name' }).click();
    await toolbar.getByLabel('Filter by name').fill('Al');

    await expect(row(page, ids.alpha)).toBeVisible();
    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, ids.gamma)).toHaveCount(0);
    await expect(toolbar.getByLabel('Filter by name')).toHaveValue('Al');
    await expectToolbarButtonIsUnconfigured(toolbar, 'Filter by');

    await toolbar.getByRole('button', { name: 'Clear name filter' }).click();
    await expect(row(page, ids.beta)).toBeVisible();
    await expect(row(page, ids.gamma)).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Filter by name' })).toBeVisible();
  });

  // An empty Default-content / Pre-determined-options block used to read as an
  // orphaned label over a near-invisible ghost bullet. Its trailing draft now
  // carries an "add here" placeholder so the section's intent is legible.
  test('definition template/options blocks invite content via the trailing-draft placeholder', async ({ page }) => {
    await openSchema(page);

    // tagDef → Default content (empty template).
    await row(page, ids.projectTag).getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('region', { name: 'Definition configuration' })).toBeVisible();
    await expect(page.locator('.definition-template-outliner .row-editor.is-empty').first())
      .toHaveAttribute('data-placeholder', 'Add default content…');

    // options fieldDef → Pre-determined options (same affordance, option copy).
    await openSchema(page);
    await row(page, ids.statusField).getByRole('button', { name: 'Open' }).click();
    await chooseConfigOption(page, 'Field type', 'options');
    await expect(page.locator('.definition-template-outliner .row-editor.is-empty').first())
      .toHaveAttribute('data-placeholder', 'Add an option…');
  });
});
