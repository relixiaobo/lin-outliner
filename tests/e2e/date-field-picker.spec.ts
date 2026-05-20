import { expect, test } from '@playwright/test';
import {
  e2eProjection,
  ids,
  openMockedApp,
  row,
} from './outlinerMock';

test.describe('date field picker', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page, { dateField: true });
  });

  test('selects dates, datetime values, and datetime ranges', async ({ page }) => {
    const dueRow = row(page, ids.dueEntry);
    await dueRow.locator('.typed-field-date-trigger').click();
    await expect(page.getByRole('dialog', { name: 'Empty calendar' })).toBeVisible();

    await page.getByRole('button', { name: 'Select 2026-05-20' }).click();
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20');

    await dueRow.getByRole('button', { name: 'Include time' }).click();
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20T09:00');

    await dueRow.getByLabel('Start time').fill('13:45');
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20T13:45');

    await dueRow.getByRole('button', { name: 'End date' }).click();
    await page.getByRole('button', { name: 'Select 2026-05-24' }).click();
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20T13:45/2026-05-24T13:45');
  });
});

async function dateFieldValue(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  const entry = projection.nodes.find((node) => node.id === ids.dueEntry);
  const valueId = entry?.children[0];
  return projection.nodes.find((node) => node.id === valueId)?.content.text ?? '';
}
