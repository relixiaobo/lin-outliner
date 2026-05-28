import { expect, test } from '@playwright/test';
import { ids, installElectronMock, openMockedApp, row } from './outlinerMock';

// The app must never fall back to window.prompt / window.confirm — blocking
// browser dialogs that look foreign and freeze the renderer. A page-level dialog
// listener proves none are triggered while exercising the flows that used to use
// them; the interactions instead run through in-app UI.
test.describe('in-app dialogs replace native browser prompts', () => {
  test('Set icon edits through an in-menu input, not window.prompt', async ({ page }) => {
    const browserDialogs: string[] = [];
    page.on('dialog', (dialog) => {
      browserDialogs.push(dialog.type());
      void dialog.dismiss();
    });

    await openMockedApp(page);

    await row(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Appearance' }).click();
    // Inside the appearance sub-mode the surface is a dialog, so its items are
    // plain buttons rather than menuitems.
    await page.getByRole('button', { name: 'Set icon' }).click();

    // An in-app text field appears, pre-seeded for editing, instead of a blocking
    // window.prompt.
    const input = page.getByRole('textbox', { name: 'Icon', exact: true });
    await expect(input).toBeVisible();
    await input.fill('★');
    await input.press('Enter');

    // Submitting closes the menu, and crucially no native browser dialog ever
    // fired during the whole interaction.
    await expect(page.getByRole('dialog', { name: 'Set icon' })).toHaveCount(0);
    expect(browserDialogs).toEqual([]);
  });

  test('the ?surface=settings route renders the standalone settings window', async ({ page }) => {
    await installElectronMock(page);
    await page.goto('/?surface=settings');

    // The settings surface renders its own full-window page, not the outliner.
    await expect(page.locator('.settings-window')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveCount(0);
    await expect(row(page, ids.alpha)).toHaveCount(0);
  });
});
