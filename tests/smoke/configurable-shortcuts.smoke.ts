import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeybindingsView } from '../../src/core/keybindings';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

async function openShortcuts(smoke: SmokeApp): Promise<Page> {
  await expect.poll(() => smoke.app.evaluate(({ Menu }) => Boolean(Menu.getApplicationMenu()))).toBe(true);
  await smoke.app.evaluate(({ Menu }) => {
    const flatten = (items: Electron.MenuItem[]): Electron.MenuItem[] => (
      items.flatMap((item) => [item, ...flatten(item.submenu?.items ?? [])])
    );
    const item = flatten(Menu.getApplicationMenu()!.items).find((item) => item.label === 'Keyboard Shortcuts…');
    if (!item) throw new Error('Keyboard Shortcuts menu item is missing');
    item.click();
  });
  await expect.poll(() => smoke.app.windows().some((page) => page.url().includes('surface=settings'))).toBe(true);
  const page = smoke.app.windows().find((page) => page.url().includes('surface=settings'))!;
  await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Application', exact: true })).toBeVisible();
  return page;
}

const view = (page: Page): Promise<KeybindingsView> => page.evaluate(() => window.lin!.keybindings.get());

function fixture(source: string): string {
  // Leave room for the Host's Unix socket suffix on macOS.
  const userDataDir = mkdtempSync(join(tmpdir(), 'ks-'));
  mkdirSync(join(userDataDir, 'config'));
  writeFileSync(join(userDataDir, 'config/settings.jsonc'), '{ "appearance": { "language": "en" } }');
  writeFileSync(join(userDataDir, 'config/keybindings.jsonc'), source);
  return userDataDir;
}

test('native shortcut editor and external edits converge through the live Host', async () => {
  const userDataDir = fixture('{\n  // Preserve this comment.\n  "global.launcher": false\n}\n');
  const smoke = await launchSmokeApp({ userDataDir });
  try {
    const page = await openShortcuts(smoke);
    const sourcePath = join(userDataDir, 'config/keybindings.jsonc');
    const row = page.locator('.inset-row').filter({ hasText: 'global.open_page_in_pane' });
    await row.getByRole('button', { name: 'Change CommandOrControl+M', exact: true }).click();
    await page.keyboard.press('Control+Alt+J');
    await expect(row.getByRole('button', { name: 'Change Control+Alt+J', exact: true })).toBeVisible();
    expect(readFileSync(sourcePath, 'utf8')).toContain('// Preserve this comment.');
    expect(readFileSync(sourcePath, 'utf8')).toContain('Control+Alt+J');

    await row.getByRole('switch', { name: 'Enable Open page in new pane' }).click();
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.open_page_in_pane')?.effective).toEqual([]);
    await row.getByRole('button', { name: 'Reset Open page in new pane', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Change CommandOrControl+M', exact: true })).toBeVisible();
    expect(readFileSync(sourcePath, 'utf8')).not.toContain('global.open_page_in_pane');

    writeFileSync(sourcePath, '{ "global.launcher": false, "global.open_page_in_pane": "Control+Alt+J" }');
    await expect(row.getByRole('button', { name: 'Change Control+Alt+J', exact: true })).toBeVisible();
    const accepted = await view(page);
    // Verify the application handler, not only the Settings projection.
    await smoke.window.bringToFront();
    await smoke.app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) => /\/index\.html$/.test(window.webContents.getURL()));
      main?.setSize(1400, 900);
    });
    await smoke.window.getByRole('button', { name: 'Collapse agent', exact: true }).click();
    await expect(smoke.window.getByRole('button', { name: 'Expand agent', exact: true })).toBeVisible();
    await smoke.window.getByRole('tree', { name: 'Outline' }).locator('[contenteditable="true"]').first().click();
    await expect(smoke.window.locator('.outline-panel-surface')).toHaveCount(1);
    await smoke.window.keyboard.press('Control+Alt+J');
    await expect(smoke.window.locator('.outline-panel-surface')).toHaveCount(2);

    const invalid = '{ "global.open_page_in_pane": "Control+"';
    writeFileSync(sourcePath, invalid);
    await expect.poll(async () => (await view(page)).source.status).toBe('rejected');
    expect((await view(page)).source.acceptedDigest).toBe(accepted.source.acceptedDigest);
    expect((await view(page)).entries.find((entry) => entry.id === 'global.open_page_in_pane')?.effective).toEqual(['Control+Alt+J']);
    expect(readFileSync(sourcePath, 'utf8')).toBe(invalid);
    await expect(row.getByRole('switch')).toBeDisabled();

    writeFileSync(sourcePath, '{ "global.launcher": false }');
    await expect(row.getByRole('button', { name: 'Change CommandOrControl+M', exact: true })).toBeEnabled();
    expect((await view(page)).source.status).toBe('accepted');
    const status = JSON.parse(readFileSync(join(userDataDir, 'config/status.json'), 'utf8'));
    expect(status.keybindings.source.acceptedDigest).toBe((await view(page)).source.acceptedDigest);
  } finally {
    await closeSmokeApp(smoke);
  }
});

test('failed native registration retains owned bindings and recovers them after restart', async () => {
  const previous = 'Control+Alt+F18';
  const blocked = 'Control+Alt+F19';
  const userDataDir = fixture(JSON.stringify({ 'global.launcher': previous }));
  let smoke = await launchSmokeApp({ userDataDir });
  try {
    let page = await openShortcuts(smoke);
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.effective).toEqual([previous]);
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.register(chord, () => {}), blocked)).toBe(true);
    writeFileSync(join(userDataDir, 'config/keybindings.jsonc'), JSON.stringify({ 'global.launcher': blocked }));
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.status).toBe('failed');
    expect((await view(page)).entries.find((entry) => entry.id === 'global.launcher')).toMatchObject({ desired: blocked, effective: [previous] });
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.isRegistered(chord), previous)).toBe(true);
    expect(JSON.parse(readFileSync(join(userDataDir, 'config/keybindings.last-applied.json'), 'utf8')).launcher).toEqual([previous]);

    await closeSmokeApp(smoke, { keepUserData: true });
    // The last accepted desired source is unavailable; the last applied set is
    // distinct and must be restored even when the public file is now invalid.
    writeFileSync(join(userDataDir, 'config/keybindings.jsonc'), '{');
    smoke = await launchSmokeApp({ userDataDir });
    page = await openShortcuts(smoke);
    expect((await view(page)).source.status).toBe('rejected');
    expect((await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.effective).toEqual([previous]);
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.isRegistered(chord), previous)).toBe(true);
  } finally {
    await closeSmokeApp(smoke);
  }
});
