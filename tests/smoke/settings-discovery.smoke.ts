import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfiguration as open } from './configurationHelpers';
import { closeSmokeApp, launchSmokeApp } from './electronApp';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tenon-discovery-'));
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config/settings.jsonc'), '{\n // Preserve this comment\n "appearance": { "language":"en", "theme":"system" }\n}');
  return dir;
}

test('Settings edits and resets the real source, tracks external errors, and keeps native controls accessible', async ({}, testInfo) => {
  const smoke = await launchSmokeApp({ userDataDir: fixture() });
  try {
    const page = await open(smoke, 'settings');
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    const native = await smoke.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Tenon Settings')!;
      return { minimizable: window.isMinimizable(), maximizable: window.isMaximizable(), fullscreenable: window.isFullScreenable(), resizable: window.isResizable() };
    });
    expect(native).toEqual({ minimizable: false, maximizable: false, fullscreenable: false, resizable: true });
    const appearance = page.getByRole('radiogroup', { name: 'Appearance', exact: true });
    for (const [label, theme] of [['Dark', 'dark'], ['Light', 'light'], ['System', 'system']] as const) {
      await appearance.getByRole('radio', { name: label, exact: true }).check();
      await expect.poll(() => smoke.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(theme);
      await expect(appearance.getByRole('radio', { name: label, exact: true })).toBeChecked();
    }
    await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
    await page.getByText('Advanced Preferences', { exact: true }).click();
    await page.getByRole('radio', { name: 'Modified', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reset Appearance', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Reset Appearance', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reset Appearance', exact: true })).toHaveCount(0);
    const path = join(smoke.userDataDir, 'config/settings.jsonc');
    expect(readFileSync(path, 'utf8')).toContain('// Preserve this comment');
    expect(readFileSync(path, 'utf8')).not.toContain('"theme"');
    await page.getByRole('radio', { name: 'All', exact: true }).click();
    await page.keyboard.press('Meta+f');
    const search = page.getByRole('searchbox', { name: 'Search Settings' });
    await expect(search).toBeFocused();
    await search.fill('agent.provider.timeoutMs');
    const timeout = page.getByRole('textbox', { name: 'Request timeout (ms)' });
    await timeout.fill('1234');
    await timeout.press('Escape');
    await expect(timeout).toHaveValue('');
    await timeout.fill('1234');
    await timeout.press('Enter');
    await expect.poll(() => readFileSync(path, 'utf8')).toContain('1234');
    await timeout.fill('-1');
    await timeout.press('Enter');
    await expect(page.getByRole('alert')).toContainText('whole number');
    await expect(timeout).toHaveValue('-1');
    await timeout.press('Escape');
    writeFileSync(path, '{broken');
    await expect(page.getByRole('alert')).toContainText('last accepted values');
    await expect(timeout).toBeDisabled();
    await search.fill('no-such-setting');
    await expect(page.getByRole('button', { name: 'Open Settings File…' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('last accepted values');
    writeFileSync(path, '{"appearance":{"language":"en","theme":"system"}}');
    await search.fill('');
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const cdp = await page.context().newCDPSession(page);
    for (const locale of ['en', 'zh-Hans'] as const) {
      if (locale === 'zh-Hans') await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption(locale);
      await expect(page.getByRole('searchbox')).toHaveAttribute('aria-label', locale === 'en' ? 'Search Settings' : '搜索设置');
      for (const [scheme, width, scale] of [['light', 760, '100%'], ['dark', 760, '100%'], ['light', 680, '200%'], ['dark', 900, '200%']] as const) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [
          { name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' },
          { name: 'prefers-contrast', value: 'more' }, { name: 'prefers-reduced-transparency', value: 'reduce' },
        ] });
        await smoke.app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('destination=settings'))!.setSize(width, 760), width);
        await page.evaluate((scale) => {
          document.documentElement.style.setProperty('--font-scale', scale);
          document.querySelector('#settings-pane-settings')!.scrollTop = 0;
        }, scale);
        expect(await page.evaluate(() => [...document.querySelectorAll('#settings-pane-settings, #settings-pane-settings .preference-row, .configuration-toolbar, .settings-sidebar')]
          .every((element) => element.scrollWidth <= element.clientWidth))).toBe(true);
        expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true);
        // Theme changes must repaint the new chrome as well as the content.
        await expect(page.getByRole('tab').nth(1)).toHaveCSS('color', scheme === 'dark' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(0, 0, 0, 0.72)');
        await expect(page.locator('.configuration-search')).toHaveCSS('color', scheme === 'dark' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(0, 0, 0, 0.72)');
        await page.screenshot({ path: testInfo.outputPath(`settings-${locale}-${scheme}-${width}-${scale}.png`) });
      }
      const tree = await cdp.send('Accessibility.getFullAXTree');
      expect(tree.nodes.some((node) => node.role?.value === 'searchbox' && node.name?.value === (locale === 'en' ? 'Search Settings' : '搜索设置'))).toBe(true);
      expect(tree.nodes.filter((node) => node.role?.value === 'switch').every((node) => Boolean(node.name?.value))).toBe(true);
    }
    await cdp.detach();
  } finally { await closeSmokeApp(smoke); }
});

test('all Settings destinations reuse one native window with bounded admission and an owned credential sheet', async ({}, testInfo) => {
  const smoke = await launchSmokeApp({ userDataDir: fixture() });
  try {
    const settings = await open(smoke, 'settings');
    const models = await open(smoke, 'models');
    await expect(models.getByRole('list', { name: 'Providers to add' })).toBeVisible();
    expect(models).toBe(settings);
    expect(await open(smoke, 'models')).toBe(settings);
    expect(smoke.app.windows().filter((page) => new URL(page.url()).searchParams.get('destination') === 'models')).toHaveLength(1);
    const admission = await models.evaluate(async () => {
      const commands = ['delete_node', 'agent_future_command', 'agent_set_provider_api_key'];
      return Promise.all(commands.map((command) => window.lin!.invoke(command, {}).then(() => 'allowed', () => 'denied')));
    });
    expect(admission).toEqual(['denied', 'denied', 'denied']);
    expect(await settings.evaluate(() => window.lin!.invoke('agent_get_provider_settings', {}).then(() => 'allowed', () => 'denied'))).toBe('allowed');
    await models.getByRole('searchbox').focus();
    await models.evaluate(() => window.lin!.openProviderConfig({ providerId: 'openai', mode: 'configure' }));
    await expect.poll(() => smoke.app.windows().some((page) => page.url().includes('surface=provider-config'))).toBe(true);
    const ownership = await smoke.app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=provider-config'))!;
      return { modal: child.isModal(), parent: child.getParentWindow()?.webContents.getURL() };
    });
    expect(ownership.modal).toBe(true);
    expect(ownership.parent).toContain('surface=settings');
    expect(ownership.parent).toContain('destination=models');
    await smoke.window.evaluate(() => window.lin!.openSettings({ destination: 'shortcuts' }));
    expect(new URL(settings.url()).searchParams.get('destination')).toBe('models');
    const child = smoke.app.windows().find((page) => page.url().includes('surface=provider-config'))!;
    const closed = child.waitForEvent('close');
    await child.getByRole('button', { name: 'Cancel', exact: true }).click();
    await closed;
    await expect(models.getByRole('searchbox')).toBeFocused();
    const agents = await open(smoke, 'agents');
    await agents.getByRole('list', { name: 'Built-in agents' }).getByRole('button').first().click();
    const dialog = agents.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Instructions' }).fill('Preserve this draft.');
    await smoke.window.evaluate(() => window.lin!.openSettings({ destination: 'shortcuts' }));
    await expect(dialog.getByRole('textbox', { name: 'Instructions' })).toHaveValue('Preserve this draft.');
    expect(new URL(agents.url()).searchParams.get('destination')).toBe('agents');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    for (const destination of ['agents', 'skills', 'memory', 'access', 'data', 'shortcuts', 'about', 'diagnostics'] as const) {
      const page = await open(smoke, destination);
      if (destination !== 'about') expect(page).toBe(settings);
      await expect(page.locator('.configuration-content:visible')).not.toBeEmpty();
      expect(smoke.app.windows().filter((window) => new URL(window.url()).searchParams.get('surface') === 'settings')).toHaveLength(1);
      await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(destination === 'about' ? 0 : 1);
      if (destination === 'shortcuts') {
        await expect(page.getByText('Go to Today', { exact: true })).toBeVisible();
        await expect(page.locator('.configuration-toolbar').getByRole('searchbox', { name: 'Search shortcuts' })).toBeVisible();
        await expect(page.getByRole('switch')).toHaveCount(0);
        for (const colorScheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme });
          await page.screenshot({ path: testInfo.outputPath(`shortcuts-${colorScheme}.png`), animations: 'disabled' });
        }
      }
      if (destination === 'diagnostics') {
        const source = page.locator('.settings-source-list').getByRole('listitem').filter({ hasText: 'keybindings.jsonc' });
        await expect(source.getByRole('button', { name: 'Open File…' })).toBeVisible();
      }
    }
  } finally { await closeSmokeApp(smoke); }
});
