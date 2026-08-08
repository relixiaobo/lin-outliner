import { expect, test } from '@playwright/test';
import { openMockedApp, trailingEditor } from './outlinerMock';

// The in-app palette is gone: there is ONE command surface, and the global ⌘K
// binding retired with it. What must not regress is the entry points — D3
// retires the BINDING, not the ways a mouse-first or menu-first user reaches
// the panel. A surface that teaches its own keystroke still has to be reachable
// by someone who has not learned it.
//
// (The panel's own behaviour lives in the launcher specs; it renders in a
// separate window this page cannot drive.)

test.describe('command surface entry points', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
    await page.evaluate(() => {
      const win = window as typeof window & { lin?: Record<string, unknown>; __summons?: number };
      win.__summons = 0;
      if (win.lin) {
        win.lin.showLauncher = async () => { win.__summons = (win.__summons ?? 0) + 1; };
      }
    });
  });

  test('the sidebar Search row summons it', async ({ page }) => {
    await page.locator('.sidebar-primary-nav')
      .getByRole('button', { name: 'Search', exact: true })
      .click();
    expect(await page.evaluate(() => (window as typeof window & { __summons?: number }).__summons))
      .toBe(1);
  });

  test('the /-menu row summons it', async ({ page }) => {
    await trailingEditor(page).click();
    await page.keyboard.type('/');
    const menu = page.getByRole('listbox', { name: 'Slash commands' });
    await menu.waitFor({ state: 'visible' });
    // Retargeted, not deleted — and re-copied per D8, so it reads as the noun
    // the panel searches rather than "Command palette".
    await menu.getByRole('option', { name: 'Search', exact: true }).click();
    expect(await page.evaluate(() => (window as typeof window & { __summons?: number }).__summons))
      .toBe(1);
  });

  test('the retired ⌘K binding opens nothing in the app window', async ({ page }) => {
    await page.keyboard.press('Meta+K');
    // No in-app palette, and the keystroke is NOT quietly re-bound to the
    // summon either: it lives inside the panel now, as "show this object's
    // actions".
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as typeof window & { __summons?: number }).__summons))
      .toBe(0);
  });
});
