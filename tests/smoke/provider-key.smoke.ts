import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfiguration } from './configurationHelpers';
import { closeSmokeApp, launchSmokeApp } from './electronApp';

test('the owned credential sheet previews a real saved key without disclosing its middle', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'tenon-key-preview-'));
  const key = `sk-ant-${'x'.repeat(96)}abcd`;
  mkdirSync(join(userDataDir, 'config'));
  writeFileSync(join(userDataDir, 'config/settings.jsonc'), JSON.stringify({
    appearance: { language: 'en', theme: 'system' },
    models: { connections: [{ providerId: 'anthropic', enabled: true }] },
  }));
  writeFileSync(join(userDataDir, 'agent-secrets.json'), JSON.stringify({
    credentials: { anthropic: { type: 'api_key', key } },
  }), { mode: 0o600 });
  writeFileSync(join(userDataDir, 'agent-model-state.json'), JSON.stringify({
    providers: [{ providerId: 'anthropic', connectionCheck: {
      outcome: 'ok', at: Date.now() - 300_000, message: 'Connection successful. 12 model(s) available.',
    } }],
  }));
  const smoke = await launchSmokeApp({ userDataDir });
  try {
    const settings = await openConfiguration(smoke, 'models');
    for (const page of [smoke.window, settings]) {
      expect(await page.evaluate(async () => Promise.all((['preview', 'reveal'] as const).map((mode) =>
        window.lin!.getProviderApiKey('anthropic', mode).then(() => 'allowed', () => 'denied'))))).toEqual(['denied', 'denied']);
    }
    await settings.evaluate(() => window.lin!.openProviderConfig({ providerId: 'anthropic', mode: 'configure' }));
    await expect.poll(() => smoke.app.windows().some((page) => page.url().includes('surface=provider-config'))).toBe(true);
    const child = smoke.app.windows().find((page) => page.url().includes('surface=provider-config'))!;
    await expect(child.getByRole('radio', { name: 'API key', exact: true })).toBeChecked();
    const input = child.locator('input.input-control[aria-label="API key"]');
    await expect(input).toHaveValue('');
    await expect(child.locator('.settings-sheet-key-preview')).toHaveText(`sk-a${'•'.repeat(99)}abcd`);
    const preview = await child.evaluate(() => window.lin!.getProviderApiKey('anthropic', 'preview'));
    expect(preview).toEqual({ providerId: 'anthropic', preview: { prefix: 'sk-a', mask: '•'.repeat(99), suffix: 'abcd', length: 107 } });
    expect(JSON.stringify(preview)).not.toContain('xxxxxxxx');
    expect(await child.evaluate(() => window.lin!.getProviderApiKey('anthropic', undefined as never).then(() => 'allowed', () => 'denied'))).toBe('denied');
    for (const colorScheme of ['light', 'dark'] as const) {
      await child.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await expect(child.getByText('107 characters', { exact: true })).toBeVisible();
      const testButton = child.getByRole('button', { name: 'Connection successful', exact: true });
      await expect(testButton).toBeInViewport();
      await expect(testButton).toHaveAttribute('title', /Last checked.*Click to test again/);
      expect(await child.locator('.settings-sheet-body').evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
      await child.screenshot({ path: testInfo.outputPath(`anthropic-key-${colorScheme}.png`) });
    }
    await child.getByRole('button', { name: 'Show key', exact: true }).click();
    await expect(input).toHaveValue(key);
    await child.getByRole('button', { name: 'Hide key', exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(child.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  } finally { await closeSmokeApp(smoke); }
});
