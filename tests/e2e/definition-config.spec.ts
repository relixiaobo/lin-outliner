import { expect, test, type Page } from '@playwright/test';
import {
  ids,
  nodeById,
  openMockedApp,
  row,
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

  test('view toolbar add-field select stays compact and chevron-free', async ({ page }) => {
    await showViewToolbar(page, ids.library);
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Library', exact: true })
      .click();
    const toolbar = page.locator('.view-toolbar');
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: 'Sort by' }).click();

    const addField = page.locator('.view-toolbar-add-field').last();
    await expect(addField).toBeVisible();
    await expect(addField.locator('svg')).toHaveCount(1);
    await expect(addField.locator('.input-select-shell')).toHaveCount(0);
    await expect(addField.locator('.input-select-chevron')).toHaveCount(0);
    await expect(addField.locator('select')).toHaveCSS('height', '24px');
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
