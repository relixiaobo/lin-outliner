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

async function expectToolbarButtonHasNoPersistentState(toolbar: Locator, name: string) {
  const button = toolbar.getByRole('button', { name, exact: true });
  await expect(button.locator('.view-toolbar-pill-count')).toHaveCount(0);
  await expect(button).not.toHaveClass(/is-active/);
}

async function expectToolbarButtonHasPersistentState(toolbar: Locator, name: string) {
  const button = toolbar.getByRole('button', { name, exact: true });
  await expect(button.locator('.view-toolbar-pill-count')).toHaveCount(0);
  await expect(button).toHaveClass(/is-active/);
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
    await expect(toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Sorted by Created time ↑' })).toBeVisible();
    await expectToolbarButtonHasPersistentState(toolbar, 'Sort by');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Sorted by Created time ↑' })).toHaveCount(0);
    await expectToolbarButtonHasPersistentState(toolbar, 'Sort by');
    await toolbar.getByRole('button', { name: 'Sort by' }).click();
    await expect(dialog).toBeVisible();
    await expect(toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Sorted by Created time ↑' })).toBeVisible();
    await expect(dialog.locator('.view-toolbar-filter-back')).toHaveCount(0);
    await expect(dialog.locator('.view-toolbar-option', { hasText: 'Created time' })).toContainText('1. Old → New');
  });

  test('row context menu expands a collapsed node when revealing its view toolbar', async ({ page }) => {
    await invokeDocumentCommand(page, 'set_view_toolbar_visible', { nodeId: ids.alpha, visible: true });
    await expect(row(page, ids.alpha).locator('.view-toolbar')).toHaveCount(0);

    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show view toolbar' }).click();

    await expect(page.locator('.view-toolbar')).toBeVisible();
    await expect(row(page, ids.alpha).getByRole('button', { name: 'Collapse' })).toBeVisible();
  });

  test('nested view toolbar reads as part of the expanded child outline', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'set_view_toolbar_visible', { nodeId: ids.alpha, visible: true });

    await rowBody(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show view toolbar' }).click();

    const rootToolbar = page.locator('.view-toolbar').nth(0);
    const nestedToolbar = page.locator('.view-toolbar').nth(1);
    await expect(rootToolbar).toBeVisible();
    await expect(nestedToolbar).toBeVisible();

    const geometry = await page.evaluate(() => {
      const toolbars = [...document.querySelectorAll<HTMLElement>('.view-toolbar')];
      const rootRect = toolbars[0]?.getBoundingClientRect();
      const nestedRect = toolbars[1]?.getBoundingClientRect();
      const before = toolbars[1] ? getComputedStyle(toolbars[1], '::before') : null;
      const after = toolbars[1] ? getComputedStyle(toolbars[1], '::after') : null;
      return {
        rootLeft: rootRect?.left ?? 0,
        nestedLeft: nestedRect?.left ?? 0,
        beforeContent: before?.content ?? '',
        afterContent: after?.content ?? '',
        beforeHeight: before?.height ?? '',
        afterHeight: after?.height ?? '',
        beforeBackground: before?.backgroundColor ?? '',
        afterBackground: after?.backgroundColor ?? '',
      };
    });

    expect(geometry.nestedLeft - geometry.rootLeft).toBeGreaterThan(24);
    expect(geometry.beforeContent).not.toBe('none');
    expect(geometry.afterContent).not.toBe('none');
    expect(geometry.beforeHeight).toBe('1px');
    expect(geometry.afterHeight).toBe('1px');
    expect(geometry.beforeBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(geometry.afterBackground).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('view toolbar display fields render as active chips and row metadata', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'apply_tag', { nodeId: ids.alpha, tagId: ids.projectTag });
    await invokeDocumentCommand(page, 'add_display_field', { nodeId: ids.today, field: 'sys:tags' });

    const toolbar = page.locator('.view-toolbar');
    await expect(toolbar).toBeVisible();
    const displayChip = toolbar.locator('.view-toolbar-summary-chip', { hasText: '1 displayed field' });
    await expect(displayChip).toBeVisible();
    await expectToolbarButtonHasNoPersistentState(toolbar, 'Display');
    await displayChip.click();
    const dialog = page.getByRole('dialog', { name: 'Display' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Created time')).toBeVisible();
    await expect(dialog.getByText('Date from calendar node')).toBeVisible();
    await expect(dialog.getByText('Owner node')).toBeVisible();
    await expect(dialog.getByText('Tags')).toBeVisible();
    await expect(dialog.getByText('Number of references')).toHaveCount(0);

    const alphaDisplay = row(page, ids.alpha).locator('.view-display-fields');
    await expect(alphaDisplay).toBeVisible();
    await expect(alphaDisplay.locator('.view-display-field-label')).toHaveText('Tags');
    await expect(alphaDisplay.locator('.view-display-field-value')).toHaveText('project');
    await expect(row(page, ids.beta).locator('.view-display-fields')).toHaveCount(0);
  });

  test('view toolbar group state is represented by the inline chip only', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'set_group_field', { nodeId: ids.today, field: 'sys:done' });

    const toolbar = page.locator('.view-toolbar');
    const groupChip = toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Grouped by Done' });
    await expect(groupChip).toBeVisible();
    await expectToolbarButtonHasNoPersistentState(toolbar, 'Group by');

    await groupChip.click();
    const dialog = page.getByRole('dialog', { name: 'Group by' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Done', exact: true })).toHaveAttribute('aria-checked', 'true');
  });

  test('view toolbar filter summary chip opens the matching rule editor', async ({ page }) => {
    await showViewToolbar(page, ids.today);
    await invokeDocumentCommand(page, 'add_filter_rule', {
      nodeId: ids.today,
      field: 'sys:tags',
      operator: 'contains',
      values: ['project'],
      valueLogic: 'any',
    });

    const toolbar = page.locator('.view-toolbar');
    const filterChip = toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Tags' });
    await expect(filterChip).toBeVisible();
    await filterChip.locator('.view-toolbar-summary-chip-main').click();

    const dialog = page.getByRole('dialog', { name: 'Filter by' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.view-toolbar-filter-back')).toContainText('Tags');
    await expect(dialog.getByLabel('Filter values')).toHaveValue('project');
    await page.keyboard.press('Escape');

    await filterChip.getByRole('button', { name: 'Remove filter rule' }).click();
    await expect(toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Tags' })).toHaveCount(0);
    await expect(row(page, ids.alpha)).toBeVisible();
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

    await filterChips.nth(0).locator('.view-toolbar-summary-chip-main').click();
    const dialog = page.getByRole('dialog', { name: 'Filter by' });
    await expect(dialog.getByLabel('Filter operator')).toHaveValue('contains');
    await expect(dialog.getByLabel('Filter values')).toHaveValue('project');
    await page.keyboard.press('Escape');

    await filterChips.nth(1).locator('.view-toolbar-summary-chip-main').click();
    await expect(dialog.getByLabel('Filter operator')).toHaveValue('not_contains');
    await expect(dialog.getByLabel('Filter values')).toHaveValue('archive');
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
    const filterChip = toolbar.locator('.view-toolbar-summary-chip', { hasText: 'Done' });
    await expect(filterChip).toBeVisible();
    await expect(filterChip.locator('.view-toolbar-summary-chip-remove')).toBeVisible();
    await expectToolbarButtonHasNoPersistentState(toolbar, 'Filter by');
    const inlineGeometry = await page.evaluate(() => {
      const chip = document.querySelector<HTMLElement>('.view-toolbar .view-toolbar-summary-chip');
      const filterButton = [...document.querySelectorAll<HTMLElement>('.view-toolbar .view-toolbar-pill')]
        .find((button) => button.getAttribute('aria-label') === 'Filter by');
      const chipRect = chip?.getBoundingClientRect();
      const filterRect = filterButton?.getBoundingClientRect();
      return {
        sameRow: chipRect && filterRect ? Math.abs(chipRect.top - filterRect.top) < 2 : false,
        chipBeforeFilter: chipRect && filterRect ? chipRect.right <= filterRect.left : false,
      };
    });
    expect(inlineGeometry).toEqual({ sameRow: true, chipBeforeFilter: true });

    await expect(row(page, ids.alpha)).toBeVisible();
    await expect(row(page, ids.beta)).toHaveCount(0);
    await expect(row(page, ids.gamma)).toHaveCount(0);

    const filteredOut = page.getByRole('button', { name: '2 items filtered out' });
    await expect(filteredOut).toBeVisible();
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
    await expectToolbarButtonHasNoPersistentState(toolbar, 'Filter by');

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
