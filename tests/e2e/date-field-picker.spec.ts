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
    await expect(dueRow.getByRole('dialog', { name: 'Empty calendar' })).toHaveCount(0);
    await expectCalendarDayRhythm(page);

    await page.getByRole('button', { name: 'Select 2026-05-20' }).click();
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20');

    await ensurePickerOpen(page, dueRow);
    await page.getByRole('switch', { name: 'Include time' }).click();
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20T09:00');

    await ensurePickerOpen(page, dueRow);
    await page.getByLabel('Start time').fill('13:45');
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20T13:45');

    await ensurePickerOpen(page, dueRow);
    await page.getByRole('switch', { name: 'End date' }).click();
    await page.getByRole('button', { name: 'Select 2026-05-24' }).click();
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20T13:45/2026-05-24T13:45');
  });
});

async function ensurePickerOpen(
  page: import('@playwright/test').Page,
  dueRow: ReturnType<typeof row>,
) {
  if (await page.getByRole('dialog', { name: /calendar/ }).isVisible()) return;
  await dueRow.locator('.typed-field-date-trigger').click();
  await expect(page.getByRole('dialog', { name: /calendar/ })).toBeVisible();
}

async function expectCalendarDayRhythm(page: import('@playwright/test').Page) {
  const day20 = await calendarDayBox(page, '2026-05-20');
  const day21 = await calendarDayBox(page, '2026-05-21');
  const day27 = await calendarDayBox(page, '2026-05-27');
  const horizontalGap = Math.round(day21.x - day20.x - day20.width);
  const verticalGap = Math.round(day27.y - day20.y - day20.height);

  expect(Math.round(day20.width)).toBe(Math.round(day20.height));
  expect(Math.abs(horizontalGap - verticalGap)).toBeLessThanOrEqual(1);
}

async function calendarDayBox(page: import('@playwright/test').Page, isoDate: string) {
  const box = await page.getByRole('button', { name: `Select ${isoDate}` }).boundingBox();
  if (!box) throw new Error(`Missing calendar day box: ${isoDate}`);
  return box;
}

async function dateFieldValue(page: import('@playwright/test').Page) {
  const projection = await e2eProjection(page);
  const entry = projection.nodes.find((node) => node.id === ids.dueEntry);
  const valueId = entry?.children[0];
  return projection.nodes.find((node) => node.id === valueId)?.content.text ?? '';
}
