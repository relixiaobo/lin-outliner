import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  await expect.poll(() => smoke.app.windows().some((page) => page.url().includes('destination=shortcuts'))).toBe(true);
  const page = smoke.app.windows().find((page) => page.url().includes('destination=shortcuts'))!;
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
    const row = page.locator('[data-shortcut-id="global.open_page_in_pane"]');
    await row.getByRole('button', { name: 'Change CommandOrControl+M', exact: true }).click();
    await page.keyboard.press('Control+Alt+J');
    await expect(row.getByRole('button', { name: 'Change Control+Alt+J', exact: true })).toBeVisible();
    expect(readFileSync(sourcePath, 'utf8')).toContain('// Preserve this comment.');
    expect(readFileSync(sourcePath, 'utf8')).toContain('Control+Alt+J');

    await row.getByRole('checkbox', { name: 'Enable Open page in new pane' }).click();
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.open_page_in_pane')?.effective).toEqual([]);
    await row.getByRole('button', { name: 'Open page in new pane actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Reset Open page in new pane', exact: true }).click();
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
    await expect(row.getByRole('checkbox')).toBeDisabled();

    writeFileSync(sourcePath, '{ "global.launcher": false }');
    await expect(row.getByRole('button', { name: 'Change CommandOrControl+M', exact: true })).toBeEnabled();
    expect((await view(page)).source.status).toBe('accepted');
    const status = JSON.parse(readFileSync(join(userDataDir, 'config/status.json'), 'utf8'));
    expect(status.keybindings.source.acceptedDigest).toBe((await view(page)).source.acceptedDigest);
  } finally {
    await closeSmokeApp(smoke);
  }
});

test('failed native registration retains conflict-free application bindings and recovers them after restart', async () => {
  const previous = 'Control+Alt+F18';
  const blocked = 'Control+Alt+F19';
  const userDataDir = fixture(JSON.stringify({ 'global.launcher': previous }));
  let smoke = await launchSmokeApp({ userDataDir });
  try {
    let page = await openShortcuts(smoke);
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.effective).toEqual([previous]);
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.register(chord, () => {}), blocked)).toBe(true);
    writeFileSync(join(userDataDir, 'config/keybindings.jsonc'), JSON.stringify({
      'global.launcher': blocked,
      'global.open_page_in_pane': previous,
      'global.new_thread': 'CommandOrControl+M',
    }));
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.status).toBe('failed');
    expect((await view(page)).entries.find((entry) => entry.id === 'global.launcher')).toMatchObject({ desired: blocked, effective: [previous] });
    expect((await view(page)).entries.find((entry) => entry.id === 'global.open_page_in_pane')).toMatchObject({
      desired: previous, effective: ['CommandOrControl+M'], status: 'failed',
    });
    expect((await view(page)).entries.find((entry) => entry.id === 'global.new_thread')).toMatchObject({
      desired: 'CommandOrControl+M', effective: ['CommandOrControl+Shift+O'], status: 'failed',
    });
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.isRegistered(chord), previous)).toBe(true);
    expect(JSON.parse(readFileSync(join(userDataDir, 'config/keybindings.last-applied.json'), 'utf8')).bindings).toMatchObject({
      'global.launcher': [previous], 'global.open_page_in_pane': ['CommandOrControl+M'],
    });
    const acceptedEntries = (await view(page)).entries;

    await closeSmokeApp(smoke, { keepUserData: true });
    // The last accepted desired source is unavailable; the last applied set is
    // distinct and must be restored even when the public file is now invalid.
    writeFileSync(join(userDataDir, 'config/keybindings.jsonc'), '{');
    smoke = await launchSmokeApp({ userDataDir });
    page = await openShortcuts(smoke);
    expect((await view(page)).source.status).toBe('rejected');
    expect((await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.effective).toEqual([previous]);
    expect((await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.status).toBe('failed');
    for (const id of ['global.open_page_in_pane', 'global.new_thread']) {
      expect((await view(page)).entries.find((entry) => entry.id === id))
        .toEqual(acceptedEntries.find((entry) => entry.id === id));
    }
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.isRegistered(chord), previous)).toBe(true);
    const status = JSON.parse(readFileSync(join(userDataDir, 'config/status.json'), 'utf8'));
    expect(status.keybindings.entries).toEqual((await view(page)).entries);

    // A later valid source retries the complete move; the blocked native chord
    // is free in this process, so all affected failures must clear together.
    writeFileSync(join(userDataDir, 'config/keybindings.jsonc'), JSON.stringify({
      'global.launcher': blocked,
      'global.open_page_in_pane': previous,
      'global.new_thread': 'CommandOrControl+M',
    }));
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.effective).toEqual([blocked]);
    expect((await view(page)).entries.some((entry) => entry.status === 'failed')).toBe(false);
    expect((await view(page)).entries.find((entry) => entry.id === 'global.open_page_in_pane')?.effective).toEqual([previous]);
  } finally {
    await closeSmokeApp(smoke);
  }
});

test('equivalent native accelerator spelling keeps ownership while other alternates change', async () => {
  test.skip(process.platform !== 'darwin', 'Checks macOS native accelerator identity.');
  const old = 'Command+Alt+F18';
  const portable = 'CommandOrControl+Alt+F18';
  const alternate = 'Control+Alt+F19';
  const userDataDir = fixture(JSON.stringify({ 'global.launcher': old }));
  const smoke = await launchSmokeApp({ userDataDir });
  try {
    const page = await openShortcuts(smoke);
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.effective).toEqual([old]);
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.isRegistered(chord), portable)).toBe(true);
    const sourcePath = join(userDataDir, 'config/keybindings.jsonc');
    writeFileSync(sourcePath, JSON.stringify({ 'global.launcher': [portable, alternate] }));
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.effective).toEqual([portable, alternate]);
    expect((await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.status).toBe('applied');
    expect(await smoke.app.evaluate(({ globalShortcut }, chords) => chords.every((chord) => globalShortcut.isRegistered(chord)), [old, portable, alternate])).toBe(true);
    writeFileSync(sourcePath, JSON.stringify({ 'global.launcher': old }));
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.launcher')?.effective).toEqual([old]);
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.isRegistered(chord), alternate)).toBe(false);
    expect(await smoke.app.evaluate(({ globalShortcut }, chord) => globalShortcut.isRegistered(chord), portable)).toBe(true);
  } finally {
    await closeSmokeApp(smoke);
  }
});

test('deleting a custom source then recreating invalid JSONC preserves defaults across restart', async () => {
  const userDataDir = fixture(JSON.stringify({ 'global.launcher': false, 'global.new_thread': 'Control+N' }));
  let smoke = await launchSmokeApp({ userDataDir });
  try {
    let page = await openShortcuts(smoke);
    await expect.poll(async () => (await view(page)).entries.find((entry) => entry.id === 'global.new_thread')?.effective).toEqual(['Control+N']);
    const sourcePath = join(userDataDir, 'config/keybindings.jsonc');
    rmSync(sourcePath);
    await expect.poll(async () => (await view(page)).source.status).toBe('missing');
    expect((await view(page)).entries.find((entry) => entry.id === 'global.new_thread')?.effective).toEqual(['CommandOrControl+Shift+O']);
    writeFileSync(sourcePath, '{ invalid');
    await expect.poll(async () => (await view(page)).source.status).toBe('rejected');
    const reset = await view(page);
    await closeSmokeApp(smoke, { keepUserData: true });
    smoke = await launchSmokeApp({ userDataDir });
    page = await openShortcuts(smoke);
    expect((await view(page)).source).toEqual(reset.source);
    expect((await view(page)).entries.find((entry) => entry.id === 'global.new_thread'))
      .toEqual(reset.entries.find((entry) => entry.id === 'global.new_thread'));
    expect(readFileSync(sourcePath, 'utf8')).toBe('{ invalid');
  } finally {
    await closeSmokeApp(smoke);
  }
});

test('fixed selection chords reject remapping through both source and editor while Today remains disjoint', async () => {
  const userDataDir = fixture('{ "global.launcher": false, "global.go_to_today": false }');
  const smoke = await launchSmokeApp({ userDataDir });
  try {
    const page = await openShortcuts(smoke);
    const sourcePath = join(userDataDir, 'config/keybindings.jsonc');
    const original = readFileSync(sourcePath, 'utf8');
    const result = await page.evaluate(async () => {
      try {
        await window.lin!.keybindings.update({
          id: 'global.open_page_in_pane', value: 'CommandOrControl+Shift+D',
          observedDigest: (await window.lin!.keybindings.get()).source.observedDigest,
        });
        return null;
      } catch (error) { return String(error); }
    });
    expect(result).toContain('selection.duplicate');
    expect(readFileSync(sourcePath, 'utf8')).toBe(original);
    const source = '{ "global.launcher": false, "global.go_to_today": false, "global.open_page_in_pane": "CommandOrControl+Shift+D" }';
    writeFileSync(sourcePath, source);
    await expect.poll(async () => (await view(page)).source.status).toBe('rejected');
    expect((await view(page)).source.error).toContain('selection.duplicate');
    expect((await view(page)).entries.find((entry) => entry.id === 'global.open_page_in_pane')?.effective).toEqual(['CommandOrControl+M']);
    expect(readFileSync(sourcePath, 'utf8')).toBe(source);
    writeFileSync(sourcePath, '{ "global.launcher": false, "global.go_to_today": "CommandOrControl+Shift+D" }');
    await expect.poll(async () => (await view(page)).source.status).toBe('accepted');
    expect((await view(page)).entries.find((entry) => entry.id === 'global.go_to_today')?.effective).toEqual(['CommandOrControl+Shift+D']);
  } finally {
    await closeSmokeApp(smoke);
  }
});
