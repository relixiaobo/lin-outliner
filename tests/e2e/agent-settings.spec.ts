import { expect, test, type Locator, type Page } from '@playwright/test';
import { commandCalls, installElectronMock } from './outlinerMock';

// Settings render in their own window (the ?surface=settings route), not an
// in-app modal. These tests drive that standalone surface directly and assert
// the current provider-centric settings layout.
test.describe('agent settings window', () => {
  test('renders as a standalone window and closes through the host', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // It owns the whole window — not a modal layered over the app.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveCount(0);

    // Close asks the host (main process) to close the window.
    await page.evaluate(() => {
      const probe = window as unknown as { __closeCalls: number; lin: Record<string, unknown> };
      probe.__closeCalls = 0;
      probe.lin.closeSettings = () => {
        probe.__closeCalls += 1;
      };
    });
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { __closeCalls: number }).__closeCalls)).toBe(1);
  });

  test('shows the active provider detail with model, reasoning and a configured key', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('button', { name: 'OpenAI, Active' })).toBeVisible();
    await expect(settings.getByRole('button', { name: /Anthropic/ })).toBeVisible();
    // The configured provider's key is masked, and model/reasoning live inline.
    await expect(settings.getByLabel('API key')).toHaveAttribute('placeholder', 'Configured (Encrypted)');
    await expect(settings.getByRole('button', { name: 'Remove key' })).toBeEnabled();
    await expect(settings.getByRole('heading', { name: 'Model & Reasoning' })).toBeVisible();
    await expect(settings.getByLabel('Reasoning')).toBeVisible();
  });

  test('filters the provider list by search and keeps Custom reachable', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByLabel('Search providers').fill('anth');
    await expect(settings.getByRole('button', { name: /Anthropic/ })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'OpenAI, Active' })).toHaveCount(0);
    // The custom-provider add button lives beside the search, outside the list.
    await expect(settings.getByRole('button', { name: 'Custom provider' })).toBeVisible();
  });

  test('gates model selection behind a key and hides the provider id for known providers', async ({ page }) => {
    const settings = await openSettings(page);

    // A known provider exposes no editable Provider ID and prompts for a key.
    await settings.locator('.settings-provider-row', { hasText: 'Anthropic' }).click();
    await expect(settings.getByLabel('Provider ID')).toHaveCount(0);
    await expect(settings.getByLabel('API key')).toHaveAttribute('placeholder', 'Paste API key');
    await expect(settings.getByLabel('Base URL')).toHaveAttribute('placeholder', 'https://api.anthropic.com');
    await expect(settings.getByLabel('Reasoning')).toHaveCount(0);

    await settings.getByLabel('API key').fill('sk-ant-test');
    await expect(settings.getByLabel('Reasoning')).toBeVisible();
  });

  test('shows a credential note instead of a key field for non-key providers', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.locator('.settings-provider-row', { hasText: 'Amazon Bedrock' }).click();
    // No misleading key/base-url fields for an AWS-credential provider.
    await expect(settings.getByLabel('API key')).toHaveCount(0);
    await expect(settings.getByLabel('Base URL')).toHaveCount(0);
    await expect(settings.getByText(/uses your AWS credentials/i)).toBeVisible();
    await expect(settings.getByRole('button', { name: /AWS credential setup/ })).toBeVisible();
  });

  test('lists the provider models in the model selector', async ({ page }) => {
    const settings = await openSettings(page);
    // OpenAI exposes several models through the Model selector.
    const model = settings.getByRole('combobox', { name: 'Model' });
    await expect(model).toBeVisible();
    await expect(model).toContainText('GPT-5.4');
    await expect(model).toContainText('GPT-5.4 Mini');
  });

  test('toggles API key visibility', async ({ page }) => {
    const settings = await openSettings(page);
    const key = settings.getByLabel('API key');
    await expect(key).toHaveAttribute('type', 'password');

    await settings.getByRole('button', { name: 'Show key' }).click();
    await expect(key).toHaveAttribute('type', 'text');

    await settings.getByRole('button', { name: 'Hide key' }).click();
    await expect(key).toHaveAttribute('type', 'password');
  });

  test('reveals connection fields only for a custom provider', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Custom provider' }).click();

    await settings.getByLabel('Provider ID').fill('my-proxy');
    await settings.getByLabel('API key').fill('sk-test');
    await settings.getByRole('textbox', { name: 'Model' }).fill('custom-model');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'my-proxy',
        modelId: 'custom-model',
        enabled: true,
      },
    });
  });

  test('saves the active provider model and reasoning', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByLabel('Reasoning').selectOption('high');
    await settings.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'openai',
        modelId: 'gpt-5.4',
        reasoningLevel: 'high',
        baseUrl: null,
        enabled: true,
      },
    });
  });
});

async function openSettings(page: Page): Promise<Locator> {
  await installElectronMock(page);
  await page.goto('/?surface=settings');
  const settings = page.locator('.settings-window');
  await expect(settings).toBeVisible();
  // The window shows a "Loading..." state until the async provider fetch
  // resolves; wait for the loaded content so assertions don't race it.
  await expect(settings.locator('.settings-provider-row').first()).toBeVisible();
  return settings;
}
