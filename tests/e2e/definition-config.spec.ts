import { expect, test } from '@playwright/test';
import {
  ids,
  nodeById,
  openMockedApp,
  row,
} from './outlinerMock';

async function openSchema(page: import('@playwright/test').Page) {
  await page.locator('.sidebar-primary-nav')
    .getByRole('button', { name: 'Schema', exact: true })
    .click();
}

async function chooseConfigOption(
  page: import('@playwright/test').Page,
  label: string,
  option: string,
) {
  await page.getByLabel(label).click();
  await page.getByRole('option', { name: option, exact: true }).click();
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
    await expect(page.getByLabel('Minimum value')).toBeVisible();
    await page.getByLabel('Minimum value').fill('1');
    await page.getByLabel('Minimum value').blur();
    await page.getByLabel('Maximum value').fill('5');
    await page.getByLabel('Maximum value').blur();
    await page.getByRole('switch', { name: 'Ancestor field value' }).click();
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
