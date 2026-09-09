import { expect, type Page } from '@playwright/test';
import type { ConfigurationDestination } from '../../src/core/settingsWindow';
import type { SmokeApp } from './electronApp';

export async function openConfiguration(smoke: SmokeApp, destination: ConfigurationDestination): Promise<Page> {
  await smoke.window.evaluate((destination) => window.lin!.openSettings({ destination }), destination);
  await expect.poll(() => smoke.app.windows().find((page) => new URL(page.url()).searchParams.get('destination') === destination)?.url()).toBeTruthy();
  const page = smoke.app.windows().find((page) => new URL(page.url()).searchParams.get('destination') === destination)!;
  await expect(page.locator('.configuration-window')).toBeVisible();
  return page;
}

/** Exercise the real credential-only child instead of granting test fixtures broader IPC rights. */
export async function configureSmokeProvider(smoke: SmokeApp, baseUrl: string): Promise<void> {
  const models = await openConfiguration(smoke, 'models');
  await models.evaluate(() => window.lin!.openProviderConfig({ providerId: 'groq', mode: 'configure' }));
  await expect.poll(() => smoke.app.windows().find((page) => page.url().includes('surface=provider-config'))?.url()).toBeTruthy();
  const child = smoke.app.windows().find((page) => page.url().includes('surface=provider-config'))!;
  await child.evaluate(async (baseUrl) => {
    const providerId = 'groq';
    await window.lin!.invoke('agent_upsert_provider_config', { provider: { providerId, baseUrl, enabled: true } });
    await window.lin!.invoke('agent_set_provider_api_key', { providerId, apiKey: 'smoke-key' });
    await window.lin!.invoke('agent_set_active_provider', { providerId });
  }, baseUrl);
  const closed = child.waitForEvent('close');
  await child.evaluate(() => { void window.lin!.closeProviderConfig(); });
  await closed;
  await models.close();
  await expect.poll(() => smoke.window.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'ready' });
}
