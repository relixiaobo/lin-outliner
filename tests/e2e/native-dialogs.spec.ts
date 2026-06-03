import { expect, test } from '@playwright/test';
import { ids, installElectronMock, row } from './outlinerMock';

// The app must never fall back to window.prompt / window.confirm — blocking
// browser dialogs that look foreign and freeze the renderer. The interactions
// run through in-app UI instead.
//
// (The former "Set icon" coverage was removed with the node Appearance
// icon/banner context-menu entry — see the workspace-tabs-to-single-pane plan,
// T4.)
test.describe('in-app dialogs replace native browser prompts', () => {
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
