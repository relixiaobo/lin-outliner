import { expect, test } from '@playwright/test';
import { ids, installElectronMock, openMockedApp, row } from './outlinerMock';

// The app must never fall back to window.prompt / window.confirm — blocking
// browser dialogs that look foreign and freeze the renderer. A page-level dialog
// listener proves none are triggered while exercising a text-entry flow; the
// interaction runs through in-app UI instead.
//
// (The former "Set icon" coverage was removed with the node Appearance
// icon/banner context-menu entry — see the workspace-tabs-to-single-pane plan,
// T4 — so the guard now rides on the "Add tag" in-menu input, which is
// icon-independent and the same class of would-be-prompt flow.)
test.describe('in-app dialogs replace native browser prompts', () => {
  test('context-menu text entry uses an in-app field, not window.prompt', async ({ page }) => {
    const browserDialogs: string[] = [];
    page.on('dialog', (dialog) => {
      browserDialogs.push(dialog.type());
      void dialog.dismiss();
    });

    await openMockedApp(page);

    await row(page, ids.alpha).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Add tag/ }).click();

    // An in-app text field appears (a window.prompt would not be a DOM textbox).
    const input = page.getByRole('textbox', { name: 'Tag name' });
    await expect(input).toBeVisible();
    await input.fill('focus');
    await input.press('Enter');

    // The whole text-entry interaction ran through in-app UI — no native browser
    // dialog ever fired.
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
