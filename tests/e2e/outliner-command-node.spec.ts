import { expect, test } from '@playwright/test';
import { ids, openMockedApp, row } from './outlinerMock';

test.describe('command node fields', () => {
  test('renders node-native config rows + a title Run action; values use the standard outliner style', async ({ page }) => {
    await openMockedApp(page, { commandNode: true });

    const commandRow = row(page, ids.commandNode);
    await expect(commandRow).toContainText('Summarize my unread feeds');
    // A command node carries the command glyph, not a bullet dot, and the glyph is
    // idle (not the running spinner) at rest.
    const bullet = commandRow.locator('.row-bullet-shape.command').first();
    await expect(bullet).toBeVisible();
    await expect(bullet).not.toHaveClass(/is-processing/);

    // Run lives at the START of the command title now (not in the Schedule value).
    await expect(commandRow.locator('.command-title-run').first()).toBeAttached();

    // The Schedule field row: a plain date-value summary (no chip pill, no inline
    // Run), editor hidden. Each value carries its own leading bullet (Tana-style:
    // a value reads as its own node).
    const scheduleRow = row(page, ids.commandScheduleEntry);
    await expect(scheduleRow.locator('.command-field-value-label')).toHaveText('Daily · 09:00');
    await expect(scheduleRow.locator('.command-field-value-bullet')).toBeVisible();
    await expect(scheduleRow.locator('.command-run-now')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Date picker' })).toHaveCount(0);

    // The Agent field row: a plain value (the stored choice as text) with its own
    // leading bullet, no pill <select>, listbox closed.
    const agentRow = row(page, ids.commandAgentEntry);
    await expect(agentRow.locator('.command-field-value-label')).toHaveText('general');
    await expect(agentRow.locator('.command-field-value-bullet')).toBeVisible();
    await expect(agentRow.locator('.command-agent-select-control')).toHaveCount(0);
    await expect(page.locator('.command-agent-popover')).toHaveCount(0);
  });

  test('clicking the schedule value opens the shared date editor (single-only)', async ({ page }) => {
    await openMockedApp(page, { commandNode: true });
    const scheduleRow = row(page, ids.commandScheduleEntry);

    // The value reveals the standard date picker — the same editor every date field
    // uses — now carrying the Repeat control, but no end-date/range toggle (a
    // schedule is always a single anchor).
    await scheduleRow.locator('.command-schedule-value').click();
    const picker = page.getByRole('dialog', { name: 'Date picker' });
    await expect(picker).toBeVisible();
    await expect(picker.locator('.typed-field-date-recurrence-select')).toBeVisible();
    await expect(picker.getByRole('switch', { name: 'End date' })).toHaveCount(0);

    // Escape collapses it back to the value.
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  });

  test('the agent value opens a standard listbox reflecting the stored choice', async ({ page }) => {
    await openMockedApp(page, { commandNode: true });
    const agentRow = row(page, ids.commandAgentEntry);

    await agentRow.locator('.command-agent-value').click();
    const listbox = page.locator('.command-agent-popover');
    await expect(listbox).toBeVisible();
    // Main agent (the implicit empty choice) + every registry definition.
    await expect(listbox.getByRole('option')).toHaveText(['Main agent', 'general']);
    // The stored agent is marked selected.
    await expect(listbox.getByRole('option', { name: 'general', exact: true })).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Escape');
    await expect(listbox).toHaveCount(0);
  });
});
