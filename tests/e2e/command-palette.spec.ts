import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('command palette', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('uses dialog focus behavior and restores focus on close', async ({ page }) => {
    const trigger = page.locator('.sidebar-primary-nav').getByRole('button', { name: 'Library', exact: true });
    await trigger.focus();
    await page.keyboard.press('Meta+K');

    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    const input = dialog.getByLabel('Search or create');
    await expect(input).toBeFocused();
    await expect(dialog.locator('.command-item[data-selected="true"] .command-item-label')).toHaveText('Today');

    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator('.command-action-button')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('keeps search input focused while navigating listbox results', async ({ page }) => {
    await page.keyboard.press('Meta+K');

    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    const input = dialog.getByLabel('Search or create');
    const selectedLabel = dialog.locator('.command-item[data-selected="true"] .command-item-label');

    await input.fill('Alpha');
    await expect(selectedLabel).toHaveText('Alpha');
    await expect(input).toHaveAttribute('aria-activedescendant', 'command-item-0');
    await expect(input).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(selectedLabel).toHaveText('Create "Alpha"');
    await expect(input).toHaveAttribute('aria-activedescendant', 'command-item-1');
    await expect(input).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect(selectedLabel).toHaveText('Alpha');
    await expect(input).toHaveAttribute('aria-activedescendant', 'command-item-0');

    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.panel-title-editor').first()).toContainText('Alpha');
  });
});
