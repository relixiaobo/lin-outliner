import { expect, test } from '@playwright/test';
import { ids, openMockedApp, row } from './outlinerMock';

test.describe('command node fields', () => {
  test('renders a manual command node with a title Run action and no schedule config row', async ({ page }) => {
    await openMockedApp(page, { commandNode: true });

    const commandRow = row(page, ids.commandNode);
    await expect(commandRow).toContainText('Summarize my unread feeds');
    const bullet = commandRow.locator('.row-bullet-shape.command').first();
    await expect(bullet).toBeVisible();
    await expect(bullet).not.toHaveClass(/is-processing/);

    await expect(commandRow.locator('.command-title-run').first()).toBeAttached();
    await expect(page.locator('[data-node-id="field-entry-command-schedule"]')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Date picker' })).toHaveCount(0);
  });
});
