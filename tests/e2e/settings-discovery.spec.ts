import { expect, test, type Page } from '@playwright/test';
import { PREFERENCE_DEFINITIONS, preferenceDefault } from '../../src/core/settingsDefinitions';

async function install(page: Page) {
  await page.addInitScript(({ entries, defaults }) => {
    const listeners = new Map<string, Set<() => void>>();
    const source = { path: '/config/settings.jsonc', status: 'accepted', digest: 'one', acceptedDigest: 'one', error: null, recoveryError: null };
    const state = {
      view: { source, entries, structuredOverrides: [] as string[], sources: [] as unknown[], application: { status: 'applied', error: null } },
      calls: [] as unknown[], failWrite: false, edits: [] as unknown[], destinations: [] as unknown[],
      notify(domain: string) { for (const listener of listeners.get(domain) ?? []) listener(); },
    };
    Object.assign(window, { __settingsTest: state, lin: {
      initialLanguage: 'en', onLanguageChange: () => () => undefined,
      invoke: async (command: string) => { state.calls.push(command); throw new Error('Discovery must not load domain catalogs'); },
      preferences: {
        get: async () => structuredClone(state.view),
        edit: async (input: { id: string; operation: string; value: unknown; expectedDigest: string }) => {
          state.edits.push(input);
          if (state.failWrite || input.expectedDigest !== state.view.source.digest) throw new Error('Settings source changed; refresh before retrying this edit');
          const entry = state.view.entries.find((entry) => entry.id === input.id)!;
          entry.value = input.operation === 'reset' ? defaults[input.id] : input.value;
          entry.modified = input.operation !== 'reset';
          state.view.source.digest += '-next';
          return structuredClone(state.view);
        },
        openFile: async () => { state.calls.push('open-file'); },
      },
      onConfigurationChanged: (domain: string, listener: () => void) => {
        if (!listeners.has(domain)) listeners.set(domain, new Set());
        listeners.get(domain)!.add(listener);
        return () => listeners.get(domain)!.delete(listener);
      },
      onSettingsNavigate: () => () => undefined,
      openSettings: async (target: unknown) => { state.destinations.push(target); },
    } });
  }, { entries: PREFERENCE_DEFINITIONS.map(({ id }) => ({ id, value: preferenceDefault(id), modified: id === 'appearance.theme' })),
    defaults: Object.fromEntries(PREFERENCE_DEFINITIONS.map(({ id }) => [id, preferenceDefault(id)])) });
  await page.goto('/?surface=settings');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
}

test('General loads no catalogs and sidebar navigation stays in the same window', async ({ page }) => {
  await install(page);
  expect(await page.evaluate(() => (window as any).__settingsTest.calls)).toEqual([]);
  await expect(page.locator('[data-preference-id]:visible')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Open Settings File…' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'General', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Models', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__settingsTest.destinations)).toEqual([]);
  await page.getByText('Request Options', { exact: true }).click();
  const number = page.getByRole('textbox', { name: 'Request timeout (ms)' });
  await number.fill('3.5');
  await number.press('Enter');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  await expect(number).toHaveValue('3.5');
  await expect(page.locator('.preference-error')).toContainText('whole number');
  await expect.poll(() => page.evaluate(() => (window as any).__settingsTest.calls.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__settingsTest.calls)).toEqual(['agent_get_provider_settings', 'agent_get_provider_settings']);
  await page.keyboard.press('Control+f');
  await expect(page.getByRole('searchbox')).toBeFocused();
});

test('search finds aliases and IDs and Modified includes explicit defaults', async ({ page }) => {
  await install(page);
  const search = page.getByRole('searchbox');
  await search.fill('backoff');
  await expect(page.getByRole('textbox', { name: 'Maximum retry delay (ms)' })).toBeVisible();
  await search.press('Escape');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await page.getByText('Configuration Inspector', { exact: true }).click();
  await page.getByRole('radio', { name: 'Modified', exact: true }).click();
  await expect(page.locator('[data-preference-id]:visible')).toHaveCount(1);
  await expect(page.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset Appearance', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('No preferences have been customized.');
  expect(await page.evaluate(() => (window as any).__settingsTest.edits)).toEqual([{ id: 'appearance.theme', operation: 'reset', expectedDigest: 'one' }]);
  await page.getByRole('radio', { name: 'All', exact: true }).click();
  await search.fill('agent.provider.timeoutMs');
  await expect(page.getByRole('textbox', { name: 'Request timeout (ms)' })).toBeVisible();
});

test('appearance previews support native radio navigation, failed writes, and reset', async ({ page }) => {
  await install(page);
  const group = page.getByRole('radiogroup', { name: 'Appearance', exact: true });
  const system = group.getByRole('radio', { name: 'System', exact: true });
  const light = group.getByRole('radio', { name: 'Light', exact: true });
  const dark = group.getByRole('radio', { name: 'Dark', exact: true });
  await expect(system).toBeChecked();
  await page.evaluate(() => {
    const original = window.lin!.preferences.edit;
    (window.lin!.preferences as any).edit = async (input: any) => {
      await new Promise<void>((resolve) => { (window as any).__releaseAppearance = resolve; });
      (window.lin!.preferences as any).edit = original;
      return original(input);
    };
  });
  await light.check();
  await expect(light).toBeChecked();
  await expect(light).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(light).toBeChecked();
  await expect(light).toBeFocused();
  await page.evaluate(() => (window as any).__releaseAppearance());
  await expect(light).toBeEnabled();
  await expect(light).toBeChecked();
  await expect(light).toBeFocused();
  await light.press('ArrowRight');
  await expect(dark).toBeChecked();
  await expect(dark).toBeFocused();
  await page.evaluate(() => { (window as any).__settingsTest.failWrite = true; });
  await dark.press('ArrowLeft');
  await expect(page.getByRole('alert')).toContainText('Settings source changed');
  await expect(dark).toBeChecked();
  await page.evaluate(() => { (window as any).__settingsTest.failWrite = false; });
  await page.getByRole('button', { name: 'Reset Appearance', exact: true }).click();
  await expect(system).toBeChecked();
  expect(await page.evaluate(() => (window as any).__settingsTest.edits.map((edit: any) => [edit.operation, edit.value]))).toEqual([
    ['set', 'light'], ['set', 'dark'], ['set', 'light'], ['reset', undefined],
  ]);
});

test('toolbar history preserves drafts, branches on a new category, and returns from search first', async ({ page }) => {
  await install(page);
  const back = page.getByRole('button', { name: 'Back', exact: true });
  const forward = page.getByRole('button', { name: 'Forward', exact: true });
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  await page.getByText('Request Options', { exact: true }).click();
  const number = page.getByRole('textbox', { name: 'Request timeout (ms)' });
  await number.fill('3.5');
  await number.press('Enter');
  await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
  await back.click();
  await expect(number).toHaveValue('3.5');
  await expect(page.getByRole('tab', { name: 'Models', exact: true })).toHaveAttribute('aria-selected', 'true');
  await back.click();
  await expect(back).toBeDisabled();
  await forward.click();
  await expect(number).toHaveValue('3.5');
  await page.getByRole('tab', { name: 'Models', exact: true }).click();
  await expect(forward).toBeEnabled();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await expect(forward).toBeDisabled();
  await back.click();
  const search = page.locator('.settings-rail').getByRole('searchbox');
  await search.fill('appearance');
  await expect(forward).toBeDisabled();
  await back.click();
  await expect(search).toHaveValue('');
  await expect(number).toHaveValue('3.5');
  await expect(forward).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__settingsTest.destinations)).toEqual([]);
});

test('content clicks show no viewport frame and keyboard navigation reaches actual controls', async ({ page }) => {
  await install(page);
  const pane = page.getByRole('tabpanel', { name: 'General', exact: true });
  await pane.click({ position: { x: 20, y: 450 } });
  await expect(pane).not.toBeFocused();
  await expect(pane).toHaveCSS('outline-style', 'none');
  await expect(pane).toHaveCSS('box-shadow', 'none');
  await page.getByRole('tab', { name: 'General', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: 'System', exact: true })).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-input-modality', 'keyboard');
  await expect(pane).toHaveCSS('box-shadow', 'none');
});

test('number edits preserve failed drafts, Escape cancels, and source errors survive filtering', async ({ page }) => {
  await install(page);
  const search = page.getByRole('searchbox');
  await search.fill('agent.provider.timeoutMs');
  const number = page.getByRole('textbox', { name: 'Request timeout (ms)' });
  await number.fill('72');
  await number.press('Escape');
  await expect(number).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__settingsTest.edits)).toEqual([]);
  await number.fill('3.5');
  await number.press('Enter');
  await expect(page.getByRole('alert')).toContainText('whole number');
  await number.fill('700');
  await page.evaluate(() => { (window as any).__settingsTest.failWrite = true; });
  await number.press('Enter');
  await expect(number).toHaveValue('700');
  await expect(page.getByRole('alert')).toContainText('source changed');
  await page.evaluate(() => {
    const state = (window as any).__settingsTest;
    state.view.source.status = 'rejected'; state.view.source.error = 'Invalid JSONC'; state.notify('preferences');
  });
  await search.fill('no match');
  await expect(page.getByRole('alert')).toContainText('last accepted values');
  await expect(page.getByRole('button', { name: 'Open Settings File…' })).toBeVisible();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid JSONC');
});

test('a numeric draft refuses an intervening source revision and retries only after reporting the conflict', async ({ page }) => {
  await install(page);
  await page.getByRole('searchbox').fill('agent.provider.timeoutMs');
  const number = page.getByRole('textbox', { name: 'Request timeout (ms)' });
  await number.fill('700');
  await page.evaluate(() => {
    const state = (window as any).__settingsTest;
    state.view.source.digest = 'external';
    state.view.entries.find((entry: any) => entry.id === 'agent.provider.timeoutMs').value = 800;
    state.notify('preferences');
  });
  await expect(number).toHaveValue('700');
  await number.press('Enter');
  await expect(page.getByRole('alert')).toContainText('source changed');
  expect(await page.evaluate(() => (window as any).__settingsTest.edits.at(-1).expectedDigest)).toBe('one');
  await number.press('Enter');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__settingsTest.edits.at(-1).expectedDigest)).toBe('external');
});

test('source errors remain visible across search and pane navigation', async ({ page }) => {
  await install(page);
  await page.evaluate(() => {
    const state = (window as any).__settingsTest;
    state.view.entries.forEach((entry: any) => { entry.modified = false; });
    state.view.sources = [{ destination: 'shortcuts', path: '/config/keybindings.jsonc', status: 'accepted', digest: 'shortcuts', modified: true, error: null },
      { destination: 'agents', path: '/agent/config.json', status: 'rejected', digest: 'root', modified: false, error: 'Invalid Agent source' }];
    state.notify('preferences');
  });
  await page.getByRole('searchbox').fill('Keyboard Shortcuts');
  await expect(page.getByRole('button', { name: 'Open… Keyboard Shortcuts' })).toBeVisible();
  await page.getByRole('searchbox').fill('not found');
  await expect(page.getByRole('alert')).toContainText('Invalid Agent source');
});

for (const [colorScheme, width] of [['light', 680], ['dark', 900]] as const) {
  test(`discovery remains usable at 200% text and ${width}px in ${colorScheme}`, async ({ page }, testInfo) => {
    await install(page);
    await page.emulateMedia({ colorScheme, contrast: 'more', reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate(() => document.documentElement.style.setProperty('--font-scale', '200%'));
    const search = page.getByRole('searchbox');
    await search.fill('concurrent');
    await expect(page.getByRole('textbox', { name: 'Concurrent tasks per conversation' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`settings-${colorScheme}-${width}.png`) });
  });
}
