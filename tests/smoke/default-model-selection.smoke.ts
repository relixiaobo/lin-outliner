import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfiguration } from './configurationHelpers';
import { closeSmokeApp, launchSmokeApp } from './electronApp';

test('the selected default model is written to configuration and survives an app restart', async ({}, testInfo) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'model-'));
  const configPath = join(userDataDir, 'config/settings.jsonc');
  mkdirSync(join(userDataDir, 'config'));
  writeFileSync(configPath, JSON.stringify({
    appearance: { language: 'en', theme: 'system' },
    models: { connections: [{ providerId: 'anthropic', enabled: true }] },
  }));
  writeFileSync(join(userDataDir, 'agent-secrets.json'), JSON.stringify({
    credentials: { anthropic: { type: 'api_key', key: 'smoke-key' } },
  }), { mode: 0o600 });
  let smoke = await launchSmokeApp({ userDataDir });
  try {
    const settings = await openConfiguration(smoke, 'models');
    const select = settings.getByRole('combobox', { name: 'Default text model', exact: true });
    await expect(select).toBeEnabled();
    const model = await select.locator('optgroup option').first().getAttribute('value');
    expect(model).toMatch(/^anthropic\//);
    await select.selectOption(model!);
    await expect(select).toHaveValue(model!);
    await expect.poll(() => JSON.parse(readFileSync(configPath, 'utf8')).models.default).toBe(model);
    for (const colorScheme of ['light', 'dark'] as const) {
      await settings.emulateMedia({ colorScheme });
      await settings.screenshot({ path: testInfo.outputPath(`default-model-${colorScheme}.png`) });
    }
    await closeSmokeApp(smoke, { keepUserData: true });
    smoke = await launchSmokeApp({ userDataDir });
    const reopened = await openConfiguration(smoke, 'models');
    const restored = reopened.getByRole('combobox', { name: 'Default text model', exact: true });
    await expect(restored).toHaveValue(model!);
    await restored.selectOption('');
    await expect(restored).toHaveValue('');
    await expect.poll(() => JSON.parse(readFileSync(configPath, 'utf8')).models.default).toBe('auto');
  } finally {
    await closeSmokeApp(smoke);
  }
});
