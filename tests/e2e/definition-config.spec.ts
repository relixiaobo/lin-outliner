import { expect, test } from '@playwright/test';
import {
  ids,
  nodeById,
  openMockedApp,
  row,
} from './outlinerMock';

async function openSchema(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Library' }).click();
  await row(page, ids.schema).getByRole('button', { name: 'Open' }).click();
}

test.describe('definition configuration parity', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('tag definitions render virtual config rows and write typed config patches', async ({ page }) => {
    await openSchema(page);
    await row(page, ids.dayTag).getByRole('button', { name: 'Open' }).click();

    await expect(page.getByRole('region', { name: 'Definition configuration' })).toBeVisible();
    await page.locator('[data-config-key="color"] input[type="color"]').fill('#446655');
    await page.getByLabel('Extend from').selectOption(ids.projectTag);
    await page.getByRole('switch', { name: 'Show as checkbox' }).click();
    await page.getByLabel('Default child supertag').selectOption(ids.projectTag);

    await expect.poll(async () => {
      const node = await nodeById(page, ids.dayTag);
      return {
        color: node?.color,
        extends: node?.extends,
        childSupertag: node?.childSupertag,
        showCheckbox: node?.showCheckbox,
      };
    }).toEqual({
      color: '#446655',
      extends: ids.projectTag,
      childSupertag: ids.projectTag,
      showCheckbox: true,
    });
  });

  test('field definitions render config rows by field type and clear stale type-specific state', async ({ page }) => {
    await openSchema(page);
    await row(page, ids.statusField).getByRole('button', { name: 'Open' }).click();

    await page.getByLabel('Field type').selectOption('number');
    await expect(page.getByLabel('Minimum value')).toBeVisible();
    await page.getByLabel('Minimum value').fill('1');
    await page.getByLabel('Minimum value').press('Enter');
    await page.getByLabel('Maximum value').fill('5');
    await page.getByLabel('Maximum value').press('Enter');
    await page.getByRole('switch', { name: 'Required' }).click();
    await page.getByLabel('Hide field').selectOption('empty');

    await expect.poll(async () => {
      const node = await nodeById(page, ids.statusField);
      return {
        fieldType: node?.fieldType,
        nullable: node?.nullable,
        hideField: node?.hideField,
        minValue: node?.minValue,
        maxValue: node?.maxValue,
      };
    }).toEqual({
      fieldType: 'number',
      nullable: false,
      hideField: 'empty',
      minValue: 1,
      maxValue: 5,
    });

    await page.getByLabel('Field type').selectOption('options');
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
});
