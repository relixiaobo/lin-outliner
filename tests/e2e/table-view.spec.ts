import { expect, test, type Page } from '@playwright/test';
import {
  commandCalls,
  e2eProjection,
  ids,
  openMockedApp,
  row,
  rowEditor,
} from './outlinerMock';

type MockCommand = { cmd: string; args: Record<string, unknown> };

async function invokeCommands(page: Page, commands: MockCommand[]) {
  await page.evaluate(async (input) => {
    const win = window as typeof window & {
      lin?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
      __LIN_E2E__?: { emitDocumentEvent: (event: unknown) => void };
    };
    let projection: unknown;
    for (const command of input) {
      const outcome = await win.lin!.invoke<{ update: { projection: unknown } }>(command.cmd, command.args);
      projection = outcome.update.projection;
    }
    if (projection) {
      win.__LIN_E2E__?.emitDocumentEvent({ type: 'projection_changed', projection });
    }
  }, commands);
}

async function configureRootTable(page: Page) {
  await invokeCommands(page, [
    { cmd: 'set_view_toolbar_visible', args: { nodeId: ids.today, visible: true } },
    { cmd: 'set_group_field', args: { nodeId: ids.today, field: 'sys:done' } },
    { cmd: 'add_display_field', args: { nodeId: ids.today, field: ids.statusField } },
    { cmd: 'add_display_field', args: { nodeId: ids.today, field: ids.dueField } },
  ]);
}

async function switchRootFromContextMenu(page: Page, mode: 'Outline' | 'Table') {
  await page.locator('.panel-title-editor').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'View as', exact: true }).click();
  await page.getByRole('dialog', { name: 'View as' }).getByRole('button', { name: mode, exact: true }).click();
}

function rootGrid(page: Page) {
  return page.locator(`[data-table-owner-id="${ids.today}"]`).getByRole('grid');
}

test.describe('table view', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { dateField: true });
  });

  test('switches the same children through View as and preserves the saved group rule', async ({ page }) => {
    await configureRootTable(page);
    await switchRootFromContextMenu(page, 'Table');

    const grid = rootGrid(page);
    await expect(grid).toHaveAccessibleName('2026-05-13 table');
    await expect(grid).toHaveAttribute('aria-colcount', '3');
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Status', 'Due']);
    await expect(grid.locator('.outliner-table-column-kind')).toHaveCount(2);
    await expect(grid.getByRole('button', { name: 'Add column' })).toHaveText('Add');
    await expect(grid.getByRole('row')).toHaveCount(5);
    await expect(grid.locator(`[data-table-row-id="${ids.alpha}"][data-table-column-id="__title__"]`)).toContainText('Alpha');

    const geometry = await grid.evaluate((element) => {
      const scroll = element as HTMLElement;
      const header = scroll.querySelector<HTMLElement>('.outliner-table-header')!;
      const title = scroll.querySelector<HTMLElement>('.outliner-table-title-header')!;
      const fields = [...scroll.querySelectorAll<HTMLElement>('.outliner-table-column-header')];
      const add = scroll.querySelector<HTMLElement>('.outliner-table-add-column')!;
      const firstCell = scroll.querySelector<HTMLElement>('.outliner-table-title-cell')!;
      return {
        addBorderBottom: getComputedStyle(add).borderBottomWidth,
        addWidth: add.getBoundingClientRect().width,
        fieldWidths: fields.map((field) => field.getBoundingClientRect().width),
        firstCellBackground: getComputedStyle(firstCell).backgroundColor,
        firstCellBorderRight: getComputedStyle(firstCell).borderRightWidth,
        headerBorderTop: getComputedStyle(header).borderTopWidth,
        headerWidth: header.getBoundingClientRect().width,
        scrollWidth: scroll.getBoundingClientRect().width,
        titleWidth: title.getBoundingClientRect().width,
      };
    });
    expect(geometry.titleWidth).toBeCloseTo(152, 0);
    expect(geometry.fieldWidths).toEqual([86, 86]);
    expect(geometry.addWidth).toBeCloseTo(82, 0);
    expect(geometry.headerWidth).toBeLessThan(geometry.scrollWidth - 100);
    expect(geometry.headerBorderTop).toBe('0px');
    expect(geometry.firstCellBorderRight).toBe('0px');
    expect(geometry.addBorderBottom).toBe('0px');
    expect(geometry.firstCellBackground).toBe('rgba(0, 0, 0, 0)');

    const toolbar = page.locator('.view-toolbar').first();
    await expect(toolbar.getByRole('button', { name: 'Group by', exact: true })).toHaveCount(0);
    await toolbar.getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(rootGrid(page)).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Group by', exact: true })).toBeVisible();

    const groupField = await page.evaluate((todayId) => {
      const win = window as typeof window & {
        __LIN_E2E__?: { projection: () => { nodes: Array<Record<string, unknown>> } };
      };
      const projection = win.__LIN_E2E__!.projection();
      const owner = projection.nodes.find((node) => node.id === todayId);
      const view = projection.nodes.find((node) => (
        node.parentId === todayId
        && node.type === 'viewDef'
        && (owner?.children as string[] | undefined)?.includes(node.id as string)
      ));
      return view?.groupField;
    }, ids.today);
    expect(groupField).toBe('sys:done');

    await toolbar.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(rootGrid(page)).toBeVisible();
  });

  test('keeps an empty field cell inert until editing starts', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } }]);

    const statusCell = rootGrid(page)
      .locator(`.outliner-table-cell[data-table-row-id="${ids.alpha}"]`)
      .first();
    const before = (await commandCalls(page)).filter((call) => call.cmd === 'create_inline_field').length;

    await statusCell.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    expect((await commandCalls(page)).filter((call) => call.cmd === 'create_inline_field')).toHaveLength(before);

    await statusCell.press('Enter');
    await expect.poll(async () => (await commandCalls(page)).filter((call) => (
      call.cmd === 'create_inline_field'
      && call.args.parentId === ids.alpha
      && call.args.targetDefId === ids.statusField
    )).length).toBe(1);

    const projection = await e2eProjection(page);
    const alpha = projection.nodes.find((node) => node.id === ids.alpha)!;
    const entries = projection.nodes.filter((node) => (
      alpha.children.includes(node.id)
      && node.type === 'fieldEntry'
      && (node as typeof node & { fieldDefId?: string }).fieldDefId === ids.statusField
    ));
    expect(entries).toHaveLength(1);

    const dueCell = rootGrid(page)
      .locator(`.outliner-table-cell[data-table-row-id="${ids.alpha}"]`)
      .nth(1);
    await expect(statusCell.locator('.ProseMirror')).toBeFocused();
    await expect(statusCell.locator('.field-value-outliner .row-bullet-dot')).toBeVisible();
    await page.keyboard.type('3');
    await page.keyboard.press('Escape');
    await expect(statusCell).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dueCell).toBeFocused();
    await expect(statusCell.locator('.field-value-outliner')).toContainText('3');
    await expect(statusCell.locator('.row-bullet-shape.content .row-bullet-dot')).toBeVisible();
    await expect(dueCell.locator('.outliner-table-empty-cell .row-bullet-dot')).toBeVisible();
    expect((await commandCalls(page)).some((call) => call.cmd === 'indent_node')).toBe(false);
  });

  test('projects title-node selection across the complete table record', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } }]);

    const grid = rootGrid(page);
    const tableRow = (rowId: string) => grid
      .locator(`.outliner-table-title-cell[data-table-row-id="${rowId}"]`)
      .locator('..');
    const titleNode = (rowId: string) => grid
      .locator(`.outliner-table-title-cell[data-table-row-id="${rowId}"] [data-node-id="${rowId}"]`);

    await titleNode(ids.alpha).click({ modifiers: ['Meta'] });
    await titleNode(ids.beta).click({ modifiers: ['Meta'] });

    await expect(tableRow(ids.alpha)).toHaveClass(/is-selected/);
    await expect(tableRow(ids.alpha)).toHaveAttribute('aria-selected', 'true');
    await expect(tableRow(ids.beta)).toHaveClass(/is-selected/);
    await expect(tableRow(ids.gamma)).not.toHaveClass(/is-selected/);
    await expect(tableRow(ids.gamma)).toHaveAttribute('aria-selected', 'false');
    await expect(grid).toHaveAttribute('aria-multiselectable', 'true');

    const selectionVisual = await tableRow(ids.alpha).evaluate((element) => {
      const titleSelection = element.querySelector<HTMLElement>('.outliner-table-title-cell .row.selected')!;
      const cells = [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
      return {
        rowBackground: getComputedStyle(element).backgroundColor,
        titleSelectionOverlay: getComputedStyle(titleSelection, '::before').display,
        cellBackgrounds: cells.map((cell) => getComputedStyle(cell).backgroundColor),
      };
    });
    expect(selectionVisual.rowBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(selectionVisual.titleSelectionOverlay).toBe('none');
    expect(selectionVisual.cellBackgrounds.every((background) => background === 'rgba(0, 0, 0, 0)')).toBe(true);
  });

  test('does not repeat visible column fields under an expanded record', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [{
      cmd: 'create_inline_field',
      args: {
        parentId: ids.alpha,
        index: null,
        name: '',
        fieldType: 'plain',
        targetDefId: ids.statusField,
      },
    }]);
    const projection = await e2eProjection(page);
    const alpha = projection.nodes.find((node) => node.id === ids.alpha)!;
    const entry = projection.nodes.find((node) => (
      alpha.children.includes(node.id)
      && node.type === 'fieldEntry'
      && (node as typeof node & { fieldDefId?: string }).fieldDefId === ids.statusField
    ));
    expect(entry).toBeTruthy();
    await invokeCommands(page, [
      {
        cmd: 'set_field_free_text_value',
        args: { fieldEntryId: entry!.id, text: 'Column value', id: 'table-column-value' },
      },
      {
        cmd: 'create_node',
        args: { parentId: ids.alpha, index: null, text: 'Nested child', id: 'table-record-child' },
      },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } },
    ]);

    const grid = rootGrid(page);
    const titleCell = grid.locator(
      `[data-table-row-id="${ids.alpha}"][data-table-column-id="__title__"]`,
    );
    const statusCell = grid.locator(`.outliner-table-cell[data-table-row-id="${ids.alpha}"]`).first();
    await expect(statusCell).toContainText('Column value');

    const titleNode = titleCell.locator(`[data-node-id="${ids.alpha}"]`);
    await titleNode.locator(':scope > .row').hover();
    await titleNode.locator(':scope > .row > .row-leading > .row-chevron-button').click();

    const nested = titleCell.locator('..').locator('..').locator(':scope > .outliner-table-nested');
    await expect(nested.locator('[data-node-id="table-record-child"]')).toContainText('Nested child');
    await expect(nested.locator(`[data-node-id="${entry!.id}"]`)).toHaveCount(0);
    await expect(statusCell).toContainText('Column value');
  });

  test('renders an existing authored value as an ordinary interactive node', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [{
      cmd: 'create_inline_field',
      args: {
        parentId: ids.alpha,
        index: null,
        name: '',
        fieldType: 'plain',
        targetDefId: ids.statusField,
      },
    }]);
    const projection = await e2eProjection(page);
    const alpha = projection.nodes.find((node) => node.id === ids.alpha)!;
    const entry = projection.nodes.find((node) => (
      alpha.children.includes(node.id)
      && node.type === 'fieldEntry'
      && (node as typeof node & { fieldDefId?: string }).fieldDefId === ids.statusField
    ));
    expect(entry).toBeTruthy();
    await invokeCommands(page, [
      {
        cmd: 'set_field_free_text_value',
        args: { fieldEntryId: entry!.id, text: 'Existing value', id: 'table-interactive-value' },
      },
      {
        cmd: 'set_field_free_text_value',
        args: { fieldEntryId: entry!.id, text: 'Second value', id: 'table-interactive-value-2' },
      },
      {
        cmd: 'create_node',
        args: {
          parentId: 'table-interactive-value',
          index: null,
          text: 'Nested value',
          id: 'table-interactive-child',
        },
      },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } },
    ]);

    const grid = rootGrid(page);
    const titleCell = grid.locator(
      `[data-table-row-id="${ids.alpha}"][data-table-column-id="__title__"]`,
    );
    const valueCell = grid.locator(`.outliner-table-cell[data-table-row-id="${ids.alpha}"]`).first();
    const valueRow = valueCell.locator('[data-node-id="table-interactive-value"]');
    const valueEditor = valueRow.locator('.ProseMirror').first();

    await expect(valueRow).toContainText('Existing value');
    await expect(valueEditor).toBeVisible();
    await valueEditor.click();
    await expect(valueEditor).toBeFocused();

    const bulletGeometry = await grid.evaluate((element, alphaId) => {
      const titleDot = element.querySelector<HTMLElement>(
        `[data-table-row-id="${alphaId}"][data-table-column-id="__title__"] .row-bullet-dot`,
      )!;
      const valueDot = element.querySelector<HTMLElement>(
        `[data-node-id="table-interactive-value"] .row-bullet-dot`,
      )!;
      const emptyDot = element.querySelector<HTMLElement>(
        `.outliner-table-cell[data-table-row-id="${alphaId}"] .outliner-table-empty-cell .row-bullet-dot`,
      )!;
      return [titleDot, valueDot, emptyDot].map((dot) => ({
        height: dot.getBoundingClientRect().height,
        width: dot.getBoundingClientRect().width,
      }));
    }, ids.alpha);
    expect(bulletGeometry[1]).toEqual(bulletGeometry[0]);
    expect(bulletGeometry[2]).toEqual(bulletGeometry[0]);

    await valueRow.locator(':scope > .row').click({ button: 'right' });
    await expect(page.locator('.node-context-menu')).toBeVisible();
    await page.keyboard.press('Escape');

    await valueRow.locator(':scope > .row').hover();
    const disclosure = valueRow.locator(':scope > .row > .row-leading > .row-chevron-button');
    await expect(disclosure).toBeVisible();
    await expect(valueRow.locator(':scope > .row > .row-leading > .row-bullet-button')).toBeVisible();
    const leadingGeometry = await valueRow.evaluate((element) => {
      const row = element.querySelector<HTMLElement>(':scope > .row')!;
      const chevron = row.querySelector<HTMLElement>(':scope > .row-leading > .row-chevron-button')!;
      const bullet = row.querySelector<HTMLElement>(':scope > .row-leading > .row-bullet-button')!;
      const content = row.querySelector<HTMLElement>(':scope > .row-content-line')!;
      const rowRect = row.getBoundingClientRect();
      const chevronRect = chevron.getBoundingClientRect();
      const bulletRect = bullet.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      return {
        bulletLeft: bulletRect.left - rowRect.left,
        chevronLeft: chevronRect.left - rowRect.left,
        chevronRight: chevronRect.right - rowRect.left,
        contentLeft: contentRect.left - rowRect.left,
      };
    });
    expect(leadingGeometry.bulletLeft - leadingGeometry.chevronLeft).toBeCloseTo(19, 0);
    expect(leadingGeometry.contentLeft - leadingGeometry.chevronLeft).toBeCloseTo(42, 0);
    expect(leadingGeometry.bulletLeft).toBeGreaterThanOrEqual(leadingGeometry.chevronRight);
    await disclosure.click();
    await expect(valueCell.getByText('Nested value', { exact: true })).toBeVisible();

    await valueCell.focus();
    const wrapperFocusBackground = await valueCell.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(wrapperFocusBackground).not.toBe('rgba(0, 0, 0, 0)');
    const nestedEditor = valueCell.locator('[data-node-id="table-interactive-child"] .ProseMirror').first();
    await nestedEditor.click();
    await expect(nestedEditor).toBeFocused();
    const descendantFocusBackgrounds = await Promise.all([
      valueCell.evaluate((element) => getComputedStyle(element).backgroundColor),
      titleCell.evaluate((element) => getComputedStyle(element).backgroundColor),
    ]);
    expect(descendantFocusBackgrounds[0]).toBe('rgba(0, 0, 0, 0)');
    expect(descendantFocusBackgrounds[0]).toBe(descendantFocusBackgrounds[1]);

    const secondEditor = valueCell.locator('[data-node-id="table-interactive-value-2"] .ProseMirror').first();
    await secondEditor.click();
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await commandCalls(page)).some((call) => (
      call.cmd === 'indent_node' && call.args.nodeId === 'table-interactive-value-2'
    ))).toBe(true);
  });

  test('enters a title editor and creates the next row from the final title cell', async ({ page }) => {
    await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } }]);
    const finalTitleCell = rootGrid(page).locator(
      `[data-table-row-id="${ids.gamma}"][data-table-column-id="__title__"]`,
    );
    const before = (await commandCalls(page)).filter((call) => call.cmd === 'create_node').length;

    await finalTitleCell.focus();
    await finalTitleCell.press('Enter');
    await expect(rowEditor(page, ids.gamma)).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    await expect.poll(async () => (await commandCalls(page)).filter((call) => (
      call.cmd === 'create_node' && call.args.parentId === ids.today
    )).length).toBe(before + 1);
    await expect(rootGrid(page).getByRole('row')).toHaveCount(6);
  });

  test('adds, creates, reorders, relabels, resizes, hides, and removes columns', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } }]);

    const grid = rootGrid(page);
    await grid.getByRole('button', { name: 'Due column menu' }).click();
    await page.getByRole('menuitem', { name: 'Move left' }).click();
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Due', 'Status']);

    await grid.getByRole('button', { name: 'Due column menu' }).click();
    await page.getByRole('menuitem', { name: 'Rename for this view' }).click();
    const rename = page.getByLabel('Rename for this view');
    await rename.fill('Deadline');
    await rename.press('Enter');
    await expect(grid.getByRole('columnheader').nth(1)).toContainText('Deadline');

    const deadlineHeader = grid.getByRole('columnheader').nth(1);
    const widthBefore = await deadlineHeader.evaluate((element) => element.getBoundingClientRect().width);
    await grid.getByRole('separator', { name: 'Resize Deadline column' }).press('ArrowRight');
    await expect.poll(() => deadlineHeader.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(widthBefore);

    await grid.getByRole('button', { name: 'Add column' }).click();
    await page.getByRole('dialog', { name: 'Add column' }).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(grid.getByRole('columnheader').filter({ hasText: 'Done' })).toBeVisible();

    await grid.getByRole('button', { name: 'Add column' }).click();
    const addColumnDialog = page.getByRole('dialog', { name: 'Add column' });
    await addColumnDialog.getByRole('button', { name: 'New field' }).click();
    await addColumnDialog.getByLabel('Field name').fill('Budget');
    await addColumnDialog.getByLabel('Field type').selectOption('number');
    await addColumnDialog.getByRole('button', { name: 'Create field', exact: true }).click();
    await expect(grid.getByRole('columnheader').filter({ hasText: 'Budget' })).toBeVisible();

    const projection = await e2eProjection(page);
    const budgetField = projection.nodes.find((node) => node.type === 'fieldDef' && node.content.text === 'Budget');
    expect(budgetField?.fieldType).toBe('number');
    expect(projection.nodes.some((node) => node.parentId === ids.alpha && node.type === 'fieldEntry'
      && (node as typeof node & { fieldDefId?: string }).fieldDefId === budgetField?.id)).toBe(false);

    await grid.getByRole('button', { name: 'Budget column menu' }).click();
    await page.getByRole('menuitem', { name: 'Hide column' }).click();
    await expect(grid.getByRole('columnheader').filter({ hasText: 'Budget' })).toHaveCount(0);

    await grid.getByRole('button', { name: 'Status column menu' }).click();
    await page.getByRole('menuitem', { name: 'Hide column' }).click();
    await grid.getByRole('button', { name: 'Done column menu' }).click();
    await page.getByRole('menuitem', { name: 'Move left' }).click();
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Done', 'Deadline']);

    const toolbar = page.locator('.view-toolbar').first();
    await toolbar.getByRole('button', { name: 'Display', exact: true }).click();
    await page.getByRole('dialog', { name: 'Display' }).getByText('Status', { exact: true }).click();
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Done', 'Status', 'Deadline']);

    await grid.getByRole('button', { name: 'Done column menu' }).click();
    await page.getByRole('menuitem', { name: 'Remove from view' }).click();
    await expect(grid.getByRole('columnheader').filter({ hasText: 'Done' })).toHaveCount(0);
  });

  test('renders an expanded child table as an independent named grid', async ({ page }) => {
    await invokeCommands(page, [
      { cmd: 'create_node', args: { parentId: ids.alpha, index: null, text: 'Nested task', id: 'nested-table-task' } },
      { cmd: 'set_view_mode', args: { nodeId: ids.alpha, mode: 'table' } },
      { cmd: 'add_display_field', args: { nodeId: ids.alpha, field: ids.statusField } },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } },
    ]);

    await row(page, ids.alpha).locator('.row-chevron-button').click({ force: true });
    const grids = page.getByRole('grid');
    await expect(grids).toHaveCount(2);
    await expect(grids.nth(0)).toHaveAccessibleName('2026-05-13 table');
    await expect(grids.nth(1)).toHaveAccessibleName('Alpha table');
    await expect(grids.nth(1).getByRole('columnheader')).toHaveText(['Title', 'Status']);
    await expect(grids.nth(1).locator(
      '[data-table-row-id="nested-table-task"][data-table-column-id="__title__"]',
    )).toContainText('Nested task');
  });

  test('renders search results without a writable trailing draft', async ({ page }) => {
    await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.recents, mode: 'table' } }]);
    await page.locator('.sidebar-primary-nav .sidebar-nav-item').filter({ hasText: 'Recents' }).click();

    const grid = page.getByRole('grid', { name: 'Recents table' });
    await expect(grid).toHaveAttribute('aria-rowcount', '1');
    await expect(grid.getByRole('row')).toHaveCount(1);
    await expect(grid.getByRole('gridcell')).toHaveCount(0);
    await expect(page.locator(`[data-trailing-parent-id="${ids.recents}"]`)).toHaveCount(0);
    // React StrictMode runs one extra setup/cleanup cycle in this dev renderer.
    // Two calls therefore represent one refresh owner; Outline + Table ownership
    // would regress this count to four.
    await expect.poll(async () => (await commandCalls(page)).filter((call) => (
      call.cmd === 'refresh_search_node_results' && call.args.nodeId === ids.recents
    )).length).toBe(2);
  });
});

test('table keeps a bounded DOM window for long outlines', async ({ page }) => {
  await openMockedApp(page, { tableRowCount: 180 });
  await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } }]);

  const grid = rootGrid(page);
  await expect(grid.locator('.outliner-table-body')).toHaveClass(/is-windowed/);
  const rowCount = Number(await grid.getAttribute('aria-rowcount'));
  expect(rowCount).toBeGreaterThan(180);
  await expect.poll(() => grid.locator('.outliner-table-window-row').count()).toBeLessThan(120);

  await page.locator('.main-panel').first().evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight });
  });
  await expect(grid.locator('[data-table-row-id="table-row-179"]')).toBeVisible();
  await expect.poll(() => grid.locator('.outliner-table-window-row').count()).toBeLessThan(120);
});
