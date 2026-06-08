import { expect, test } from '@playwright/test';
import {
  e2eProjection,
  ids,
  openMockedApp,
  row,
  trailingEditor,
} from './outlinerMock';

test.describe('date field picker', () => {
  test.beforeEach(async ({ page }) => {
    // Pin the wall clock to the fixture's month: an empty date value opens its
    // calendar on the real "today", so without this the seeded May 2026 dates would
    // fall off the grid whenever the suite runs in another month. setFixedTime keeps
    // timers running (unlike install()), so the app behaves normally otherwise.
    await page.clock.setFixedTime(new Date('2026-05-13T09:00:00'));
    await openMockedApp(page, { dateField: true });
  });

  test('selects dates, datetime values, and datetime ranges', async ({ page }) => {
    const dueRow = row(page, ids.dueEntry);
    // The date value reads as a plain row: an empty value summons its picker with
    // Space on the trailing draft, a committed value reopens it through the
    // calendar affordance (see ensurePickerOpen). No dedicated whole-field trigger.
    await openEmptyDatePicker(page);
    await expect(page.getByRole('dialog', { name: 'Date picker' })).toBeVisible();
    await expect(dueRow.getByRole('dialog', { name: 'Date picker' })).toHaveCount(0);
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

  test('arms a recurrence on a single date and hides repeat for ranges', async ({ page }) => {
    const dueRow = row(page, ids.dueEntry);
    await openEmptyDatePicker(page);
    await page.getByRole('button', { name: 'Select 2026-05-20' }).click();
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20');

    // A generic date field now carries a "Repeat" control (B1). Arming a preset
    // encodes the rule into the value string.
    await ensurePickerOpen(page, dueRow);
    await page.locator('.typed-field-date-recurrence-select').selectOption('daily');
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20 RRULE:FREQ=DAILY');

    // Switching to a range hides the repeat control (a range never recurs) and
    // drops the rule from the committed value.
    await ensurePickerOpen(page, dueRow);
    await page.getByRole('switch', { name: 'End date' }).click();
    await expect(page.locator('.typed-field-date-recurrence')).toHaveCount(0);
    await page.getByRole('button', { name: 'Select 2026-05-24' }).click();
    await expect.poll(() => dateFieldValue(page)).toBe('2026-05-20/2026-05-24');
  });

  test('a malformed typed value flags an icon whose message is hover-only, never inline text', async ({ page }) => {
    const draft = trailingEditor(page, ids.dueEntry);
    await draft.click();
    // Commit a value the date field cannot parse. The validation hint only
    // decorates a committed value node, so type then Enter to materialize it.
    await page.keyboard.type('notadate');
    await page.keyboard.press('Enter');

    const dueRow = row(page, ids.dueEntry);
    const hint = dueRow.locator('.field-value-hint');
    await expect(hint).toBeVisible();
    // The message rides in the accessible name / native tooltip (revealed on
    // hover), not as always-on row text crowding the value.
    await expect(hint).toHaveAttribute('title', 'Value should be a date');
    await expect(hint).toHaveAttribute('aria-label', 'Value should be a date');
    await expect(hint.locator('svg')).toBeVisible();
    await expect(page.getByText('Value should be a date')).toHaveCount(0);
  });

  test('Space only summons the picker on an empty draft, not while typing a value', async ({ page }) => {
    const draft = trailingEditor(page, ids.dueEntry);
    await draft.click();
    // A non-empty draft keeps Space literal (e.g. typing "next monday") instead of
    // summoning the picker, so natural-language values can contain spaces.
    await page.keyboard.type('next');
    await page.keyboard.press('Space');
    await page.keyboard.type('monday');

    await expect(page.getByRole('dialog', { name: 'Date picker' })).toHaveCount(0);
    await expect(draft).toHaveText('next monday');
  });
});

async function openEmptyDatePicker(page: import('@playwright/test').Page) {
  const draft = trailingEditor(page, ids.dueEntry);
  await draft.click();
  await page.keyboard.press('Space');
}

async function ensurePickerOpen(
  page: import('@playwright/test').Page,
  dueRow: ReturnType<typeof row>,
) {
  if (await page.getByRole('dialog', { name: 'Date picker' }).isVisible()) return;
  await dueRow.locator('.field-value-date-trigger').click();
  await expect(page.getByRole('dialog', { name: 'Date picker' })).toBeVisible();
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
