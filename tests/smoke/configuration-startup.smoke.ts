import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp, REPO_ROOT, type SmokeApp } from './electronApp';
import { loadFilePreferences } from '../../src/main/configuration/filePreferences';
import { loadKeybindings } from '../../src/main/configuration/keybindings';

async function fixture() {
  const userDataDir = await mkdtemp('/tmp/tenon-config-startup-');
  execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], { cwd: REPO_ROOT });
  await mkdir(join(userDataDir, 'config'), { recursive: true });
  const preferences = '{ "appearance": { "language": "en", "theme": "system" } }';
  const keybindings = '{ "global.launcher": false }';
  await writeFile(join(userDataDir, 'config/settings.jsonc'), preferences);
  await writeFile(join(userDataDir, 'config/keybindings.jsonc'), keybindings);
  const snapshotPath = join(userDataDir, 'outline-runtime/workspace/outline.snapshot.json');
  const bytes = await readFile(snapshotPath);
  await rename(snapshotPath, `${snapshotPath}.held`);
  execFileSync('mkfifo', [snapshotPath]);
  let releasing: Promise<void> | undefined;
  const release = () => releasing ??= new Promise<void>((resolve, reject) => {
    const writer = createWriteStream(snapshotPath);
    writer.on('error', reject);
    writer.on('open', () => {
      void rename(`${snapshotPath}.held`, snapshotPath).then(() => writer.end(bytes), reject);
    });
    writer.on('finish', resolve);
  });
  return { userDataDir, preferences, keybindings, release,
    preferencesDigest: loadFilePreferences(userDataDir, { readOnly: true }).sourceDigest,
    keybindingsDigest: loadKeybindings(userDataDir, { readOnly: true }).sourceDigest };
}

async function openEarlySettings(smoke: SmokeApp): Promise<Page> {
  await smoke.app.evaluate(({ Menu }) => {
    const flatten = (items: Electron.MenuItem[]): Electron.MenuItem[] => items.flatMap((item) => [item, ...flatten(item.submenu?.items ?? [])]);
    const entry = flatten(Menu.getApplicationMenu()!.items).find((item) => item.label === 'Keyboard Shortcuts…');
    if (!entry) throw new Error('Missing native shortcut menu');
    entry.click();
  });
  await expect.poll(() => smoke.app.windows().find((page) => page.url().includes('destination=shortcuts'))?.url()).toBeTruthy();
  const page = smoke.app.windows().find((page) => page.url().includes('destination=shortcuts'))!;
  await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts', exact: true })).toBeVisible();
  return page;
}

for (const fail of [false, true]) {
  test(`Settings waits for pending configuration admission and handles ${fail ? 'failure and Retry' : 'success'}`, async () => {
    const data = await fixture();
    // Always release the FIFO even if a regressed build never exposes the window.
    const deadline = setTimeout(() => { void data.release(); }, 20_000);
    let smoke: SmokeApp | undefined;
    try {
      smoke = await launchSmokeApp({ userDataDir: data.userDataDir });
      const settings = await openEarlySettings(smoke);
      expect((await smoke.window.evaluate(() => window.lin!.dataLifecycle.request({ action: 'status' }))).state.phase).toBe('inspecting');
      await expect(settings.locator('[data-shortcut-id]')).toHaveCount(0);
      await settings.getByRole('tab', { name: 'General', exact: true }).click();
      await expect(settings.getByRole('radio', { name: 'Dark', exact: true })).toHaveCount(0);
      await settings.getByRole('tab', { name: 'Models', exact: true }).click();
      await expect(settings.getByRole('tabpanel', { name: 'Models', exact: true })).toBeVisible();
      // Exercise mutation IPC directly as well: no stale/alternate caller can
      // write around the loading UI while the real data read remains pending.
      await settings.evaluate(({ preferencesDigest, keybindingsDigest }) => {
        const results: Record<string, string> = { preference: 'pending', shortcut: 'pending' };
        (window as unknown as { admissionResults: typeof results }).admissionResults = results;
        void window.lin!.preferences.edit({ id: 'appearance.theme', operation: 'set', value: 'dark', expectedDigest: preferencesDigest })
          .then(() => { results.preference = 'saved'; }, (error) => { results.preference = String(error); });
        void window.lin!.keybindings.update({ id: 'global.open_page_in_pane', value: 'Control+Alt+J', observedDigest: keybindingsDigest })
          .then(() => { results.shortcut = 'saved'; }, (error) => { results.shortcut = String(error); });
      }, { preferencesDigest: data.preferencesDigest, keybindingsDigest: data.keybindingsDigest });
      const results = () => settings.evaluate(() => (window as unknown as { admissionResults: Record<string, string> }).admissionResults);
      expect(await results()).toEqual({ preference: 'pending', shortcut: 'pending' });
      expect(await readFile(join(data.userDataDir, 'config/settings.jsonc'), 'utf8')).toBe(data.preferences);
      expect(await readFile(join(data.userDataDir, 'config/keybindings.jsonc'), 'utf8')).toBe(data.keybindings);
      const unknownStore = join(data.userDataDir, 'agent/unregistered.sqlite');
      if (fail) { await mkdir(join(data.userDataDir, 'agent'), { recursive: true }); await writeFile(unknownStore, 'Unknown Store fixture'); }
      await data.release();
      if (fail) {
        await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'failed' });
        await expect.poll(results).toMatchObject({ preference: expect.stringContaining('Unregistered'), shortcut: expect.stringContaining('Unregistered') });
        await expect(settings.getByRole('alert').first()).toBeVisible();
        expect(await readFile(join(data.userDataDir, 'config/settings.jsonc'), 'utf8')).toBe(data.preferences);
        expect(await readFile(join(data.userDataDir, 'config/keybindings.jsonc'), 'utf8')).toBe(data.keybindings);
        await rm(unknownStore);
        await smoke.window.locator('.startup-failure-actions').getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(settings.getByRole('list', { name: 'Providers to add' })).toBeVisible();
      } else {
        await expect.poll(results).toEqual({ preference: 'saved', shortcut: 'saved' });
      }
      await settings.getByRole('tab', { name: 'General', exact: true }).click();
      await expect(settings.getByRole('radio', { name: 'Dark', exact: true })).toBeEnabled();
      await settings.getByRole('radio', { name: 'Light', exact: true }).check();
      await expect.poll(() => smoke!.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
      await settings.getByRole('tab', { name: 'Keyboard Shortcuts', exact: true }).click();
      const row = settings.locator('[data-shortcut-id="global.open_page_in_pane"]');
      await row.getByRole('button', { name: fail ? 'Change CommandOrControl+M' : 'Change Control+Alt+J', exact: true }).dblclick();
      await settings.keyboard.press('Control+Alt+K');
      await expect(row.getByRole('button', { name: 'Change Control+Alt+K', exact: true })).toBeVisible();
      await expect(settings.getByRole('alert')).toHaveCount(0);
    } finally {
      clearTimeout(deadline); await data.release();
      if (smoke) await closeSmokeApp(smoke); else await rm(data.userDataDir, { recursive: true, force: true });
    }
  });
}
