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
    await expect(page.getByRole('heading', { name: 'Tenon Settings' })).toBeVisible();
    const native = await smoke.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Tenon Settings')!;
      return { minimizable: window.isMinimizable(), maximizable: window.isMaximizable(), fullscreenable: window.isFullScreenable(), resizable: window.isResizable() };
    });
    expect(native).toEqual({ minimizable: false, maximizable: false, fullscreenable: false, resizable: true });
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
    await expect(page.getByRole('alert')).toHaveCount(0);
    const cdp = await page.context().newCDPSession(page);
    for (const locale of ['en', 'zh-Hans'] as const) {
      if (locale === 'zh-Hans') await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption(locale);
      await expect(page.getByRole('searchbox')).toHaveAttribute('aria-label', locale === 'en' ? 'Search Settings' : '搜索设置');
      for (const [scheme, width, scale] of [['light', 760, '100%'], ['dark', 760, '100%'], ['light', 560, '200%'], ['dark', 900, '200%']] as const) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [
          { name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' },
          { name: 'prefers-contrast', value: 'more' }, { name: 'prefers-reduced-transparency', value: 'reduce' },
        ] });
        await smoke.app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('destination=settings'))!.setSize(width, 760), width);
        await page.evaluate((scale) => {
          document.documentElement.style.setProperty('--font-scale', scale);
          document.querySelector('.configuration-content')!.scrollTop = 0;
        }, scale);
        expect(await page.evaluate(() => [...document.querySelectorAll('.configuration-content, .preference-row, .configuration-toolbar')]
          .every((element) => element.scrollWidth <= element.clientWidth))).toBe(true);
        expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`settings-${locale}-${scheme}-${width}-${scale}.png`) });
      }
      const tree = await cdp.send('Accessibility.getFullAXTree');
      expect(tree.nodes.some((node) => node.role?.value === 'searchbox' && node.name?.value === (locale === 'en' ? 'Search Settings' : '搜索设置'))).toBe(true);
      expect(tree.nodes.filter((node) => node.role?.value === 'switch').every((node) => Boolean(node.name?.value))).toBe(true);
    }
    await cdp.detach();
  } finally { await closeSmokeApp(smoke); }
});

test('managers are independent singletons with exact operation admission and an owned credential sheet', async ({}) => {
  const smoke = await launchSmokeApp({ userDataDir: fixture() });
  try {
    const settings = await open(smoke, 'settings');
    const models = await open(smoke, 'models');
    await expect(models.getByRole('list', { name: 'Providers to add' })).toBeVisible();
    await open(smoke, 'models');
    expect(smoke.app.windows().filter((page) => new URL(page.url()).searchParams.get('destination') === 'models')).toHaveLength(1);
    const admission = await models.evaluate(async () => {
      const commands = ['memory_manage', 'agent_get_skill_settings', 'agent_set_provider_api_key'];
      return Promise.all(commands.map((command) => window.lin!.invoke(command, {}).then(() => 'allowed', () => 'denied')));
    });
    expect(admission).toEqual(['denied', 'denied', 'denied']);
    expect(await settings.evaluate(() => window.lin!.invoke('agent_get_provider_settings', {}).then(() => 'allowed', () => 'denied'))).toBe('denied');
    await models.evaluate(() => window.lin!.openProviderConfig({ providerId: 'openai', mode: 'configure' }));
    await expect.poll(() => smoke.app.windows().some((page) => page.url().includes('surface=provider-config'))).toBe(true);
    const ownership = await smoke.app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('surface=provider-config'))!;
      return { modal: child.isModal(), parent: child.getParentWindow()?.webContents.getURL() };
    });
    expect(ownership.modal).toBe(true);
    expect(ownership.parent).toContain('destination=models');
    const child = smoke.app.windows().find((page) => page.url().includes('surface=provider-config'))!;
    const closed = child.waitForEvent('close');
    await child.evaluate(() => { void window.lin!.closeProviderConfig(); });
    await closed;
    for (const destination of ['agents', 'skills', 'memory', 'access', 'data', 'shortcuts', 'about', 'diagnostics'] as const) {
      const page = await open(smoke, destination);
      await expect(page.locator('.configuration-content')).not.toBeEmpty();
      await expect(page.locator('.settings-rail')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
    }
  } finally { await closeSmokeApp(smoke); }
});
