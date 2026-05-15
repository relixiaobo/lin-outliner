import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('agent settings dialog', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('uses modal focus behavior and restores focus on close', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Agent settings' });
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Agent settings' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
