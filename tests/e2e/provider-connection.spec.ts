import { expect, test } from '@playwright/test';
import { commandCalls, emitOAuthEvent, installElectronMock } from './outlinerMock';

test('requires a custom endpoint and accepts a local connection without a key', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=provider-config&mode=custom');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await page.getByLabel('Provider ID').fill('local-server');
  await expect(save).toBeDisabled();
  await page.getByLabel('Base URL').fill('localhost:1234');
  await expect(page.getByText('Enter a complete URL', { exact: false })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.getByLabel('Base URL').fill('http://localhost:1234/v1');
  await expect(save).toBeEnabled();
  await page.getByLabel('Base URL').press('Enter');
  await expect.poll(async () => (await commandCalls(page)).findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args)
    .toMatchObject({ provider: { providerId: 'local-server', baseUrl: 'http://localhost:1234/v1' } });
  expect((await commandCalls(page)).some((call) => call.cmd === 'agent_set_provider_api_key')).toBe(false);
});

test('preserves a key draft when switching between API key and account sign-in', async ({ page }) => {
  await installElectronMock(page, { oauthApiKeyProvider: true });
  await page.goto('/?surface=provider-config&provider=openrouter');
  const key = page.locator('input.input-control[aria-label="API key"]');
  await key.fill('sk-unfinished');
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByLabel('Base URL').fill('https://proxy.example.com/v1');
  await page.getByRole('radio', { name: 'Account', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Sign in to OpenRouter' })).toBeVisible();
  await page.getByRole('radio', { name: 'Account', exact: true }).press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'API key', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'API key', exact: true })).toBeFocused();
  await expect(key).toHaveValue('sk-unfinished');
  await expect(page.getByLabel('Base URL')).toHaveValue('https://proxy.example.com/v1');
  expect((await commandCalls(page)).some((call) => call.cmd === 'agent_set_provider_api_key')).toBe(false);
});

test('discards an old test result after the user changes the connection', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=provider-config&provider=anthropic');
  await page.getByLabel('API key').fill('sk-first');
  await page.evaluate(() => {
    const original = window.lin!.invoke;
    const state = window as unknown as { finishTest: () => void };
    window.lin!.invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'agent_test_provider_connection') await new Promise<void>((resolve) => { state.finishTest = resolve; });
      return original<T>(command, args);
    };
  });
  await page.getByRole('button', { name: 'Test Connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Testing…' })).toBeDisabled();
  await page.getByLabel('API key').fill('sk-second');
  await page.evaluate(() => (window as unknown as { finishTest: () => void }).finishTest());
  await expect.poll(async () => (await commandCalls(page)).some((call) => call.cmd === 'agent_test_provider_connection')).toBe(true);
  await expect(page.getByText('Connection successful', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Test Connection', exact: true })).toBeEnabled();
});

test('locks the draft during Save and keeps it after a failed write', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=provider-config&provider=anthropic');
  await page.getByLabel('API key').fill('sk-retry');
  await page.evaluate(() => {
    const original = window.lin!.invoke;
    const state = window as unknown as { failSave: () => void; saveCount: number; closeCount: number };
    state.saveCount = 0;
    state.closeCount = 0;
    window.lin!.closeProviderConfig = async () => { state.closeCount += 1; };
    window.lin!.invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'agent_set_provider_api_key' && ++state.saveCount === 1) {
        await new Promise<void>((_resolve, reject) => { state.failSave = () => reject(new Error('Unable to save key')); });
      }
      return original<T>(command, args);
    };
  });
  await page.getByLabel('API key').press('Enter');
  await expect(page.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expect(page.getByLabel('API key')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as unknown as { closeCount: number }).closeCount)).toBe(0);
  await page.evaluate(() => (window as unknown as { failSave: () => void }).failSave());
  await expect(page.getByRole('alert')).toContainText('Unable to save key');
  await expect(page.getByLabel('API key')).toHaveValue('sk-retry');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { closeCount: number }).closeCount)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { saveCount: number }).saveCount)).toBe(2);
});

test('a rejected OAuth reply remains cancellable', async ({ page }) => {
  await installElectronMock(page, { oauthProvider: true });
  await page.goto('/?surface=provider-config&provider=github-copilot');
  await page.getByRole('button', { name: 'Sign in to GitHub Copilot' }).click();
  await page.evaluate(() => {
    const original = window.lin!.invoke;
    window.lin!.invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'agent_oauth_respond') throw new Error('The reply could not be sent');
      return original<T>(command, args);
    };
  });
  await emitOAuthEvent(page, 'github-copilot', { kind: 'prompt', requestId: 'reply-1', message: 'Account name' });
  await page.getByRole('textbox', { name: 'Account name' }).fill('test-account');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The reply could not be sent');
  await page.getByRole('button', { name: 'Cancel sign-in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in to GitHub Copilot' })).toBeEnabled();
});

for (const scheme of ['light', 'dark'] as const) {
  for (const provider of ['openai', 'custom', 'amazon-bedrock', 'github-copilot', 'openrouter']) {
    test(`${provider} connection fits its native sheet in ${scheme}`, async ({ page }, testInfo) => {
      const height = provider === 'custom' ? 480 : 400;
      await page.setViewportSize({ width: 520, height });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await installElectronMock(page, { oauthProvider: true, oauthApiKeyProvider: true });
      await page.goto(`/?surface=provider-config&provider=${provider === 'custom' ? '' : provider}&mode=${provider === 'custom' ? 'custom' : 'configure'}`);
      await expect(page.locator('.provider-config-window')).toHaveAttribute('aria-busy', 'false');
      await expect(page.getByRole('button', { name: /^(Save|Sign in to GitHub Copilot)$/ })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${provider}-${scheme}.png`) });
      for (const scale of ['100%', '200%']) {
        await page.evaluate((value) => document.documentElement.style.setProperty('--font-scale', value), scale);
        expect(await page.locator('.settings-sheet-body').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        const footer = await page.locator('.settings-sheet-actions').boundingBox();
        expect(footer!.y + footer!.height).toBeLessThanOrEqual(height);
        await expect(page.getByRole('button', { name: /^(Save|Sign in to GitHub Copilot)$/ })).toBeInViewport();
      }
    });
  }
}


test('offers Retry and Cancel after provider settings fail to load', async ({ page }) => {
  await installElectronMock(page, { providerSettingsUnavailable: true });
  await page.goto('/?surface=provider-config&provider=openai');
  await expect(page.getByRole('alert')).toContainText('Provider settings are temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { __LIN_E2E__: { setProviderSettingsAvailable: () => void } }).__LIN_E2E__.setProviderSettingsAvailable());
  await page.getByRole('button', { name: 'Try Again', exact: true }).click();
  await expect(page.getByLabel('API key')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});


test('a custom provider cannot overwrite an existing provider by reusing its ID', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=provider-config&mode=custom');
  await page.getByLabel('Provider ID').fill('openai');
  await page.getByLabel('Base URL').fill('https://proxy.example.com/v1');
  await page.getByLabel('API key').fill('sk-new');
  await expect(page.getByText('This provider already exists. Choose a different ID.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Test Connection', exact: true })).toBeDisabled();
  await page.getByLabel('Provider ID').fill('office-proxy');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});
