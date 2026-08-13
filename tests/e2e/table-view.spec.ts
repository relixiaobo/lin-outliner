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
    const originalViewport = page.viewportSize();
    if (!originalViewport) throw new Error('Missing viewport');
    await page.setViewportSize({ width: 1700, height: originalViewport.height });
    await configureRootTable(page);
    await switchRootFromContextMenu(page, 'Table');

    const grid = rootGrid(page);
    await expect(grid).toHaveAccessibleName('2026-05-13 table');
    await expect(grid).toHaveAttribute('aria-colcount', '3');
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Status', 'Due']);
    await expect(grid.locator('.outliner-table-column-kind')).toHaveCount(2);
    await expect(grid.getByRole('button', { name: 'Add column' })).toHaveText('Add field');
    await expect(grid.getByRole('row')).toHaveCount(5);
    await expect(grid.locator(`[data-table-row-id="${ids.alpha}"][data-table-column-id="__title__"]`)).toContainText('Alpha');

    const geometry = await grid.evaluate((element) => {
      const scroll = element as HTMLElement;
      const header = scroll.querySelector<HTMLElement>('.outliner-table-header')!;
      const title = scroll.querySelector<HTMLElement>('.outliner-table-title-header')!;
      const fields = [...scroll.querySelectorAll<HTMLElement>('.outliner-table-column-header')];
      const add = scroll.querySelector<HTMLElement>('.outliner-table-add-column')!;
      const firstCell = scroll.querySelector<HTMLElement>('.outliner-table-title-cell')!;
      const firstTitleWrap = firstCell.querySelector<HTMLElement>(':scope > .row-wrap')!;
      const firstChevron = firstCell.querySelector<HTMLElement>('.row-chevron-button')!;
      const firstBullet = firstCell.querySelector<HTMLElement>('.row-bullet-button')!;
      const scrollRect = scroll.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const firstCellRect = firstCell.getBoundingClientRect();
      const firstTitleWrapRect = firstTitleWrap.getBoundingClientRect();
      const firstChevronRect = firstChevron.getBoundingClientRect();
      const firstBulletRect = firstBullet.getBoundingClientRect();
      const rootStyle = getComputedStyle(document.documentElement);
      const scrollStyle = getComputedStyle(scroll);
      const resolveFontSize = (token: string) => {
        const probe = document.createElement('span');
        probe.style.fontSize = `var(${token})`;
        document.body.append(probe);
        const fontSize = getComputedStyle(probe).fontSize;
        probe.remove();
        return fontSize;
      };
      const addRect = add.getBoundingClientRect();
      return {
        addBorderBottom: getComputedStyle(add).borderBottomWidth,
        addRight: addRect.right,
        addWidth: addRect.width,
        contentFontFamily: getComputedStyle(firstCell).fontFamily,
        contentFontSize: getComputedStyle(firstCell).fontSize,
        contentFontToken: resolveFontSize('--font-content'),
        fieldWidths: fields.map((field) => field.getBoundingClientRect().width),
        firstBulletLeft: firstBulletRect.left,
        firstCellBackground: getComputedStyle(firstCell).backgroundColor,
        firstCellBorderRight: getComputedStyle(firstCell).borderRightWidth,
        firstCellRight: firstCellRect.right,
        firstChevronLeft: firstChevronRect.left,
        firstChevronRight: firstChevronRect.right,
        firstTitleWrapRight: firstTitleWrapRect.right,
        headerBorderTop: getComputedStyle(header).borderTopWidth,
        headerFontFamily: getComputedStyle(header).fontFamily,
        headerFontSize: getComputedStyle(header).fontSize,
        headerFontToken: resolveFontSize('--font-ui-sm'),
        headerWidth: header.getBoundingClientRect().width,
        rootFontFamily: rootStyle.fontFamily,
        scrollContentWidth: scroll.clientWidth - Number.parseFloat(scrollStyle.paddingLeft),
        scrollLeft: scrollRect.left,
        scrollRight: scrollRect.right,
        scrollWidth: scrollRect.width,
        titleLabelLeft: titleRect.left + Number.parseFloat(getComputedStyle(title).paddingLeft),
        titleWidth: titleRect.width,
      };
    });
    expect(geometry.titleWidth).toBeGreaterThanOrEqual(260);
    expect(geometry.fieldWidths).toEqual([180, 180]);
    expect(geometry.addWidth).toBeCloseTo(104, 0);
    expect(geometry.headerWidth).toBeCloseTo(geometry.scrollContentWidth, 0);
    expect(geometry.addRight).toBeCloseTo(geometry.scrollRight, -1);
    expect(geometry.headerBorderTop).toBe('0px');
    expect(geometry.firstCellBorderRight).toBe('0px');
    expect(geometry.addBorderBottom).toBe('0px');
    expect(geometry.firstCellBackground).toBe('rgba(0, 0, 0, 0)');
    expect(geometry.firstBulletLeft).toBeCloseTo(geometry.titleLabelLeft, 1);
    expect(geometry.firstChevronLeft).toBeGreaterThanOrEqual(geometry.scrollLeft);
    expect(geometry.firstChevronRight).toBeLessThan(geometry.firstBulletLeft);
    expect(geometry.firstTitleWrapRight).toBeCloseTo(geometry.firstCellRight, 1);
    expect(geometry.headerFontFamily).toBe(geometry.rootFontFamily);
    expect(geometry.contentFontFamily).toBe(geometry.rootFontFamily);
    expect(geometry.headerFontSize).toBe(geometry.headerFontToken);
    expect(geometry.contentFontSize).toBe(geometry.contentFontToken);

    await page.setViewportSize({ width: 760, height: originalViewport.height });
    const narrowGeometry = await grid.evaluate((element) => {
      const scroll = element as HTMLElement;
      const title = scroll.querySelector<HTMLElement>('.outliner-table-title-header')!;
      const fields = [...scroll.querySelectorAll<HTMLElement>('.outliner-table-column-header')];
      const add = scroll.querySelector<HTMLElement>('.outliner-table-add-column')!;
      return {
        addWidth: add.getBoundingClientRect().width,
        clientWidth: scroll.clientWidth,
        fieldWidths: fields.map((field) => field.getBoundingClientRect().width),
        scrollWidth: scroll.scrollWidth,
        titleWidth: title.getBoundingClientRect().width,
      };
    });
    expect(narrowGeometry.scrollWidth).toBeGreaterThan(narrowGeometry.clientWidth);
    expect(narrowGeometry.titleWidth).toBeCloseTo(260, 0);
    expect(narrowGeometry.fieldWidths).toEqual([180, 180]);
    expect(narrowGeometry.addWidth).toBeCloseTo(104, 0);
    await page.setViewportSize(originalViewport);

    const tableScope = page.locator(`[data-table-owner-id="${ids.today}"]`);
    const tableControls = tableScope.locator(':scope > .view-toolbar.is-compact-controls');
    await expect(grid.locator('.view-toolbar')).toHaveCount(0);
    await expect(tableControls.getByRole('button', { name: 'Filter by name', exact: true })).toBeVisible();
    await expect(tableControls.getByRole('button', { name: 'Group by', exact: true })).toHaveCount(0);
    await tableControls.getByRole('button', { name: 'Outline', exact: true }).click();
    await expect(rootGrid(page)).toHaveCount(0);
    const outlineToolbar = page.locator('.view-toolbar:not(.is-compact-controls)').first();
    await expect(outlineToolbar.getByRole('button', { name: 'Group by', exact: true })).toBeVisible();

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

    await outlineToolbar.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(rootGrid(page)).toBeVisible();
  });

  test('defaults used custom fields as columns and preserves hidden choices across view switches', async ({ page }) => {
    await invokeCommands(page, [
      {
        cmd: 'create_inline_field',
        args: {
          parentId: ids.alpha,
          index: null,
          name: '',
          fieldType: 'plain',
          targetDefId: ids.statusField,
        },
      },
      {
        cmd: 'create_inline_field',
        args: {
          parentId: ids.beta,
          index: null,
          name: '',
          fieldType: 'plain',
          targetDefId: ids.dueField,
        },
      },
    ]);
    const beforeTable = await e2eProjection(page);
    const alpha = beforeTable.nodes.find((node) => node.id === ids.alpha)!;
    const beta = beforeTable.nodes.find((node) => node.id === ids.beta)!;
    const statusEntry = beforeTable.nodes.find((node) => (
      alpha.children.includes(node.id)
      && node.type === 'fieldEntry'
      && (node as typeof node & { fieldDefId?: string }).fieldDefId === ids.statusField
    ))!;
    const dueEntry = beforeTable.nodes.find((node) => (
      beta.children.includes(node.id)
      && node.type === 'fieldEntry'
      && (node as typeof node & { fieldDefId?: string }).fieldDefId === ids.dueField
    ))!;
    await invokeCommands(page, [
      {
        cmd: 'set_field_free_text_value',
        args: { fieldEntryId: statusEntry.id, text: 'Active', id: 'automatic-status-value' },
      },
      {
        cmd: 'set_field_free_text_value',
        args: { fieldEntryId: dueEntry.id, text: '2026-05-20', id: 'automatic-due-value' },
      },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } },
    ]);

    const grid = rootGrid(page);
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Status', 'Due']);
    await expect(grid.locator(`.outliner-table-cell[data-table-row-id="${ids.alpha}"]`).first()).toContainText('Active');
    await expect(grid.locator(`.outliner-table-cell[data-table-row-id="${ids.beta}"]`).nth(1)).toContainText('2026-05-20');
    await expect(grid.getByRole('columnheader').filter({ hasText: 'Done' })).toHaveCount(0);

    const tableProjection = await e2eProjection(page);
    const statusDisplay = tableProjection.nodes.find((node) => (
      node.type === 'displayField' && node.displayField === ids.statusField
    ))!;
    await invokeCommands(page, [
      {
        cmd: 'update_display_field',
        args: { displayFieldId: statusDisplay.id, visible: false },
      },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'list' } },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } },
    ]);

    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Due']);
    const switchedProjection = await e2eProjection(page);
    const switchedStatusDisplays = switchedProjection.nodes.filter((node) => (
      node.type === 'displayField' && node.displayField === ids.statusField
    ));
    expect(switchedStatusDisplays).toHaveLength(1);
    expect(switchedStatusDisplays[0]?.displayVisible).toBe(false);
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

  test('serializes empty field materialization and replays rapid input', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } }]);
    await page.evaluate(() => {
      const win = window as typeof window & {
        lin?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      };
      const originalInvoke = win.lin!.invoke.bind(win.lin);
      let delayed = false;
      win.lin!.invoke = async (cmd, args) => {
        if (cmd === 'create_inline_field' && !delayed) {
          delayed = true;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
        }
        return originalInvoke(cmd, args);
      };
    });

    const statusCell = rootGrid(page)
      .locator(`.outliner-table-cell[data-table-row-id="${ids.alpha}"]`)
      .first();
    const before = (await commandCalls(page)).filter((call) => call.cmd === 'create_inline_field').length;
    await statusCell.focus();
    await page.keyboard.type('ab');

    await expect.poll(async () => (await commandCalls(page)).filter((call) => (
      call.cmd === 'create_inline_field'
      && call.args.parentId === ids.alpha
      && call.args.targetDefId === ids.statusField
    )).length).toBe(before + 1);
    await expect(statusCell.locator('.field-value-outliner')).toContainText('ab');
  });

  test('starts real and draft Title editors with printable input', async ({ page }) => {
    await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } }]);
    const grid = rootGrid(page);
    const alphaCell = grid.locator(
      `.outliner-table-title-cell[data-table-row-id="${ids.alpha}"]`,
    );

    await alphaCell.focus();
    await alphaCell.press('Z');
    await expect(rowEditor(page, ids.alpha)).toBeFocused();
    await expect(rowEditor(page, ids.alpha)).toContainText('AlphaZ');
    await page.keyboard.press('Escape');

    const draftCell = grid.locator('.outliner-table-title-cell').last();
    const draftId = await draftCell.getAttribute('data-table-row-id');
    expect(draftId).toBeTruthy();
    await draftCell.focus();
    await draftCell.press('Q');
    const draftEditor = grid.locator(
      `.outliner-table-title-cell[data-table-row-id="${draftId}"] .ProseMirror`,
    );
    await expect(draftEditor).toBeFocused();
    await expect(draftEditor).toContainText('Q');
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

  test('does not render any field rows under an expanded table record', async ({ page }) => {
    await configureRootTable(page);
    const configuredProjection = await e2eProjection(page);
    const dueDisplay = configuredProjection.nodes.find((node) => (
      node.type === 'displayField' && node.displayField === ids.dueField
    ))!;
    await invokeCommands(page, [
      {
        cmd: 'update_display_field',
        args: { displayFieldId: dueDisplay.id, visible: false },
      },
      {
        cmd: 'create_inline_field',
        args: {
          parentId: ids.alpha,
          index: null,
          name: '',
          fieldType: 'plain',
          targetDefId: ids.statusField,
        },
      },
      {
        cmd: 'create_inline_field',
        args: {
          parentId: ids.alpha,
          index: null,
          name: '',
          fieldType: 'plain',
          targetDefId: ids.dueField,
        },
      },
    ]);
    const projection = await e2eProjection(page);
    const alpha = projection.nodes.find((node) => node.id === ids.alpha)!;
    const statusEntry = projection.nodes.find((node) => (
      alpha.children.includes(node.id)
      && node.type === 'fieldEntry'
      && (node as typeof node & { fieldDefId?: string }).fieldDefId === ids.statusField
    ))!;
    const hiddenDueEntry = projection.nodes.find((node) => (
      alpha.children.includes(node.id)
      && node.type === 'fieldEntry'
      && (node as typeof node & { fieldDefId?: string }).fieldDefId === ids.dueField
    ))!;
    await invokeCommands(page, [
      {
        cmd: 'set_field_free_text_value',
        args: { fieldEntryId: statusEntry.id, text: 'Column value', id: 'table-column-value' },
      },
      {
        cmd: 'set_field_free_text_value',
        args: { fieldEntryId: hiddenDueEntry.id, text: 'Hidden value', id: 'table-hidden-value' },
      },
      {
        cmd: 'create_node',
        args: { parentId: ids.alpha, index: null, text: 'Nested child', id: 'table-record-child' },
      },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } },
      {
        cmd: 'create_inline_field',
        args: {
          parentId: ids.alpha,
          index: null,
          name: 'Internal notes',
          fieldType: 'plain',
        },
      },
    ]);
    const tableProjection = await e2eProjection(page);
    const currentAlpha = tableProjection.nodes.find((node) => node.id === ids.alpha)!;
    const undisplayedEntry = tableProjection.nodes.find((node) => (
      currentAlpha.children.includes(node.id)
      && node.type === 'fieldEntry'
      && tableProjection.nodes.some((field) => (
        field.id === (node as typeof node & { fieldDefId?: string }).fieldDefId
        && field.type === 'fieldDef'
        && field.content.text === 'Internal notes'
      ))
    ))!;

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
    await expect(nested).toHaveRole('tree');
    await expect(nested).toHaveAccessibleName('Alpha');
    await expect(nested).toHaveAttribute('aria-multiselectable', 'true');
    await expect(nested.locator('[data-node-id="table-record-child"]')).toContainText('Nested child');
    await expect(nested.locator(`[data-node-id="${statusEntry.id}"]`)).toHaveCount(0);
    await expect(nested.locator(`[data-node-id="${hiddenDueEntry.id}"]`)).toHaveCount(0);
    await expect(nested.locator(`[data-node-id="${undisplayedEntry.id}"]`)).toHaveCount(0);
    await expect(statusCell).toContainText('Column value');
  });

  test('opens an authored field definition from its column kind icon', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [
      { cmd: 'add_display_field', args: { nodeId: ids.today, field: 'sys:done' } },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } },
    ]);

    const grid = rootGrid(page);
    await expect(grid.locator('.outliner-table-column-kind')).toHaveCount(3);
    await expect(grid.getByRole('button', { name: 'Open field: Done' })).toHaveCount(0);
    const authoredKind = grid.getByRole('button', { name: 'Open field: Status' });
    const authoredIcon = authoredKind.locator('svg');
    const authoredHeader = authoredKind.locator('..');
    const idleIconColor = await authoredIcon.evaluate((element) => getComputedStyle(element).color);

    await authoredKind.hover();
    await expect.poll(() => authoredIcon.evaluate((element) => getComputedStyle(element).color)).not.toBe(idleIconColor);
    await expect(authoredHeader).toHaveCSS('box-shadow', 'none');

    const systemHeader = grid.getByText('Done', { exact: true }).locator('..');
    const systemKind = systemHeader.locator('.outliner-table-column-kind');
    const systemIcon = systemKind.locator('svg');
    const idleSystemIconColor = await systemIcon.evaluate((element) => getComputedStyle(element).color);
    await systemKind.hover();
    await expect.poll(() => systemIcon.evaluate((element) => getComputedStyle(element).color)).toBe(idleSystemIconColor);

    await authoredKind.click();

    await expect(page.locator('.panel-title-editor').first()).toContainText('Status');
    await expect(page.getByRole('region', { name: 'Definition configuration' })).toBeVisible();
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

  test('adds, creates, reorders, relabels, resizes, and hides columns', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [
      {
        cmd: 'create_inline_field',
        args: {
          parentId: ids.alpha,
          index: null,
          name: '',
          fieldType: 'plain',
          targetDefId: ids.statusField,
        },
      },
      { cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } },
    ]);

    const grid = rootGrid(page);
    const configuredProjection = await e2eProjection(page);
    const dueDisplay = configuredProjection.nodes.find((node) => (
      node.type === 'displayField' && node.displayField === ids.dueField
    ));
    expect(dueDisplay).toBeTruthy();
    const dueMenuButton = grid.getByRole('button', { name: 'Due column menu' });
    await dueMenuButton.focus();
    await dueMenuButton.press('Enter');
    const dueMenu = page.getByRole('menu', { name: 'Due column menu' });
    await expect(dueMenu.getByRole('menuitem', { name: 'Rename for this view' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(dueMenu.getByRole('menuitem', { name: 'Move left' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dueMenuButton).toBeFocused();

    await dueMenuButton.click();
    await page.getByRole('menuitem', { name: 'Move left' }).click();
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Due', 'Status']);

    await dueMenuButton.click();
    await page.getByRole('menuitem', { name: 'Rename for this view' }).click();
    const rename = page.getByLabel('Rename for this view');
    await expect(rename).toBeFocused();
    await rename.fill('Discard me');
    await rename.press('Escape');
    await expect(dueMenuButton).toBeFocused();
    await expect(grid.getByRole('columnheader').nth(1)).toContainText('Due');

    await dueMenuButton.click();
    await page.getByRole('menuitem', { name: 'Rename for this view' }).click();
    await rename.fill('Deadline');
    await rename.press('Enter');
    await expect(grid.getByRole('columnheader').nth(1)).toContainText('Deadline');
    await expect(grid.getByRole('button', { name: 'Deadline column menu' })).toBeFocused();

    const deadlineHeader = grid.getByRole('columnheader').nth(1);
    const widthBefore = await deadlineHeader.evaluate((element) => element.getBoundingClientRect().width);
    await grid.getByRole('separator', { name: 'Resize Deadline column' }).press('ArrowRight');
    await expect.poll(() => deadlineHeader.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(widthBefore);
    await expect.poll(async () => {
      const projection = await e2eProjection(page);
      const display = projection.nodes.find((node) => node.id === dueDisplay!.id);
      return display?.type === 'displayField' ? display.displayWidth : null;
    }).toBe(196);

    await invokeCommands(page, [{
      cmd: 'update_display_field',
      args: { displayFieldId: dueDisplay!.id, width: 200 },
    }]);
    await expect.poll(() => deadlineHeader.evaluate((element) => element.getBoundingClientRect().width))
      .toBeCloseTo(200, 0);

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

    await grid.getByRole('button', { name: 'Add column' }).click();
    await page.getByRole('dialog', { name: 'Add column' }).getByRole('button', { name: 'Budget', exact: true }).click();
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Deadline', 'Status', 'Done', 'Budget']);
    await grid.getByRole('button', { name: 'Budget column menu' }).click();
    await page.getByRole('menuitem', { name: 'Hide column' }).click();

    await grid.getByRole('button', { name: 'Status column menu' }).click();
    await page.getByRole('menuitem', { name: 'Hide column' }).click();
    await grid.getByRole('button', { name: 'Done column menu' }).click();
    await page.getByRole('menuitem', { name: 'Move left' }).click();
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Done', 'Deadline']);

    await grid.getByRole('button', { name: 'Add column' }).click();
    await page.getByRole('dialog', { name: 'Add column' })
      .getByRole('button', { name: 'Status', exact: true })
      .click();
    await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Done', 'Status', 'Deadline']);

    await grid.getByRole('button', { name: 'Done column menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Remove from view' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await grid.getByRole('button', { name: 'Status column menu' }).click();
    await page.getByRole('menuitem', { name: 'Hide column' }).click();
    await grid.getByRole('button', { name: 'Add column' }).click();
    const groupedDialog = page.getByRole('dialog', { name: 'Add column' });
    await expect(groupedDialog.locator('.outliner-table-field-group > .popover-section-header')).toHaveText([
      'Fields in use',
      'Other custom fields',
      'System fields',
    ]);
    await groupedDialog.getByLabel('Search fields').fill('Status');
    await expect(groupedDialog.locator('.outliner-table-field-group > .popover-section-header')).toHaveText([
      'Fields in use',
    ]);
    await expect(groupedDialog.getByRole('button', { name: 'Status', exact: true })).toBeVisible();
  });

  test('toggles a column menu from its trigger and commits rename on outside dismissal', async ({ page }) => {
    await configureRootTable(page);
    await invokeCommands(page, [{ cmd: 'set_view_mode', args: { nodeId: ids.today, mode: 'table' } }]);

    const grid = rootGrid(page);
    const dueMenuButton = grid.getByRole('button', { name: 'Due column menu' });
    const dueMenu = page.getByRole('menu', { name: 'Due column menu' });
    await dueMenuButton.click();
    await expect(dueMenu).toBeVisible();
    await dueMenuButton.click();
    await expect(dueMenu).toHaveCount(0);

    await dueMenuButton.click();
    await dueMenu.getByRole('menuitem', { name: 'Rename for this view' }).click();
    const rename = page.getByLabel('Rename for this view');
    await rename.fill('Outside commit');
    const commitsBefore = (await commandCalls(page)).filter((call) => (
      call.cmd === 'update_display_field' && call.args.label === 'Outside commit'
    )).length;

    await grid.getByRole('columnheader').first().click();
    await expect(grid.getByRole('columnheader').filter({ hasText: 'Outside commit' })).toBeVisible();
    await expect(page.getByLabel('Rename for this view')).toHaveCount(0);
    await expect.poll(async () => (await commandCalls(page)).filter((call) => (
      call.cmd === 'update_display_field' && call.args.label === 'Outside commit'
    )).length).toBe(commitsBefore + 1);

    const outsideCommitButton = grid.getByRole('button', { name: 'Outside commit column menu' });
    await outsideCommitButton.click();
    await page.getByRole('menu', { name: 'Outside commit column menu' })
      .getByRole('menuitem', { name: 'Rename for this view' })
      .click();
    await rename.fill('Trigger commit');
    const triggerCommitsBefore = (await commandCalls(page)).filter((call) => (
      call.cmd === 'update_display_field' && call.args.label === 'Trigger commit'
    )).length;

    await outsideCommitButton.click();
    await expect(page.getByRole('menu', { name: 'Outside commit column menu' })).toHaveCount(0);
    await expect(grid.getByRole('columnheader').filter({ hasText: 'Trigger commit' })).toBeVisible();
    await expect.poll(async () => (await commandCalls(page)).filter((call) => (
      call.cmd === 'update_display_field' && call.args.label === 'Trigger commit'
    )).length).toBe(triggerCommitsBefore + 1);
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
    const tableScope = page.locator(`[data-table-owner-id="${ids.recents}"]`);
    const tableControls = tableScope.locator(':scope > .view-toolbar.is-compact-controls');
    const summary = page.locator('.search-query-summary-bar');
    await expect(grid.locator('.view-toolbar')).toHaveCount(0);
    await expect(tableControls.getByRole('button', { name: 'Filter by name', exact: true })).toBeVisible();
    await expect(tableControls.getByRole('button', { name: 'Outline', exact: true })).toBeVisible();
    await expect(tableControls.getByRole('button', { name: 'Sort by', exact: true })).toBeVisible();
    await expect(tableControls.getByRole('button', { name: 'Filter by', exact: true })).toBeVisible();
    await expect(summary).toHaveCount(0);

    await tableControls.getByRole('button', { name: 'Filter by name', exact: true }).click();
    const nameSearch = tableControls.getByRole('textbox', { name: 'Filter by name', exact: true });
    await expect(nameSearch).toBeVisible();
    await nameSearch.press('Escape');
    await expect(tableControls.getByRole('button', { name: 'Filter by name', exact: true })).toBeVisible();

    const searchTableGeometry = await page.locator('.panel-inner').evaluate((panel) => {
      const header = panel.querySelector<HTMLElement>('.outliner-table-header')!;
      const title = panel.querySelector<HTMLElement>('.outliner-table-title-header')!;
      const tableControls = panel.querySelector<HTMLElement>('.outliner-table-scope > .view-toolbar.is-compact-controls')!;
      const headerRect = header.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const controlsRect = tableControls.getBoundingClientRect();
      const controlsStyle = getComputedStyle(tableControls);
      return {
        controlsBackground: controlsStyle.backgroundColor,
        controlsBottom: controlsRect.bottom,
        controlsLeft: controlsRect.left,
        controlsPseudoAfter: getComputedStyle(tableControls, '::after').display,
        controlsPseudoBefore: getComputedStyle(tableControls, '::before').display,
        controlsTop: controlsRect.top,
        directToolbarCount: panel.querySelectorAll('.outliner-table-scope > .view-toolbar.is-compact-controls').length,
        headerLeft: headerRect.left,
        headerRight: headerRect.right,
        headerTop: headerRect.top,
        titleBottom: titleRect.bottom,
        titleLabelLeft: titleRect.left + Number.parseFloat(getComputedStyle(title).paddingLeft),
        titleTop: titleRect.top,
      };
    });
    expect(searchTableGeometry.directToolbarCount).toBe(1);
    expect(searchTableGeometry.controlsBottom).toBeLessThanOrEqual(searchTableGeometry.headerTop);
    expect(searchTableGeometry.controlsLeft).toBeCloseTo(searchTableGeometry.titleLabelLeft, 1);
    expect(searchTableGeometry.controlsBackground).toBe('rgba(0, 0, 0, 0)');
    expect(searchTableGeometry.controlsPseudoBefore).toBe('none');
    expect(searchTableGeometry.controlsPseudoAfter).toBe('none');
    expect(searchTableGeometry.titleTop).toBe(searchTableGeometry.headerTop);
    expect(searchTableGeometry.titleBottom).toBeGreaterThan(searchTableGeometry.titleTop);
    expect(searchTableGeometry.titleLabelLeft).toBeGreaterThan(searchTableGeometry.headerLeft);
    expect(searchTableGeometry.headerRight).toBeGreaterThan(searchTableGeometry.titleLabelLeft);

    // The in-flight gate coalesces React StrictMode's extra setup cycle. A second
    // call before another view mutation would mean the search has more than one
    // refresh owner.
    await expect.poll(async () => (await commandCalls(page)).filter((call) => (
      call.cmd === 'refresh_search_node_results' && call.args.nodeId === ids.recents
    )).length).toBe(1);

    await tableControls.getByRole('button', { name: 'Sort by', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Sort by' })).toBeVisible();
    await page.keyboard.press('Escape');
    await tableControls.getByRole('button', { name: 'Filter by', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Filter by' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.locator('.panel-title-editor').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit displayed fields', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Add column' })).toBeVisible();
    await expect(tableControls).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(grid).toHaveAttribute('aria-rowcount', '1');
    await expect(grid.getByRole('row')).toHaveCount(1);
    await expect(grid.getByRole('gridcell')).toHaveCount(0);
    await expect(page.locator(`[data-trailing-parent-id="${ids.recents}"]`)).toHaveCount(0);
  });

  test('gives a nested search table a single refresh owner', async ({ page }) => {
    await invokeCommands(page, [
      { cmd: 'move_node', args: { nodeId: ids.recents, parentId: ids.alpha, index: null } },
      { cmd: 'set_view_mode', args: { nodeId: ids.recents, mode: 'table' } },
    ]);

    await row(page, ids.alpha).locator('.row-chevron-button').click({ force: true });
    const recentsRow = row(page, ids.recents);
    await expect(recentsRow).toBeVisible();
    const refreshesBefore = (await commandCalls(page)).filter((call) => (
      call.cmd === 'refresh_search_node_results' && call.args.nodeId === ids.recents
    )).length;

    await recentsRow.locator('.row-chevron-button').click({ force: true });
    await expect(page.getByRole('grid', { name: 'Recents table' })).toBeVisible();
    await expect.poll(async () => (await commandCalls(page)).filter((call) => (
      call.cmd === 'refresh_search_node_results' && call.args.nodeId === ids.recents
    )).length - refreshesBefore).toBe(1);
  });
});

test('reads and edits saved-search table fields through the complete reference chain', async ({ page }) => {
  await openMockedApp(page, { dateField: true, searchReferenceChain: true });
  await invokeCommands(page, [
    { cmd: 'set_view_mode', args: { nodeId: ids.recents, mode: 'table' } },
    { cmd: 'add_display_field', args: { nodeId: ids.recents, field: ids.dueField } },
  ]);
  await page.locator('.sidebar-primary-nav .sidebar-nav-item').filter({ hasText: 'Recents' }).click();

  const grid = page.getByRole('grid', { name: 'Recents table' });
  await expect(grid.getByRole('columnheader')).toHaveText(['Title', 'Status', 'Due']);
  const statusCell = grid.locator(
    `.outliner-table-cell[data-table-row-id="${ids.searchResult}"]`,
  ).first();
  const dueCell = grid.locator(
    `.outliner-table-cell[data-table-row-id="${ids.searchResult}"]`,
  ).nth(1);
  await expect(statusCell).toContainText('Chain value');
  await expect(statusCell.locator(`[data-node-id="${ids.searchStatusValue}"]`)).toBeVisible();

  const createsBefore = (await commandCalls(page)).filter((call) => call.cmd === 'create_inline_field').length;
  await dueCell.focus();
  await dueCell.press('Enter');
  await expect.poll(async () => (await commandCalls(page)).filter((call) => (
    call.cmd === 'create_inline_field'
    && call.args.parentId === ids.alpha
    && call.args.targetDefId === ids.dueField
  )).length).toBe(1);
  expect((await commandCalls(page)).filter((call) => call.cmd === 'create_inline_field')).toHaveLength(createsBefore + 1);

  const projection = await e2eProjection(page);
  const alpha = projection.nodes.find((node) => node.id === ids.alpha)!;
  expect(projection.nodes.some((node) => (
    alpha.children.includes(node.id)
    && node.type === 'fieldEntry'
    && (node as typeof node & { fieldDefId?: string }).fieldDefId === ids.dueField
  ))).toBe(true);
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
