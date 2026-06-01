import { expect, test, type Locator, type Page } from '@playwright/test';
import { commandCalls, installElectronMock } from './outlinerMock';

// Settings render in their own window (the ?surface=settings route), not an
// in-app modal. The Providers surface follows the macOS System Settings idiom: a
// category sidebar + a full-width inset grouped list (Connected / Available) with
// on-row status, and a per-provider config SHEET (opened by clicking a row) that
// hosts the credential, model & reasoning, async validate, and its own Cancel /
// Save. There is no permanent side detail pane and no global Save bar.
test.describe('agent settings window', () => {
  test('renders as a standalone window and closes through the host', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // No sheet is open at rest, and it owns the whole window — not a modal layered
    // over the app.
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

  test('groups providers by credential and reads status on each row', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('list', { name: 'Connected providers' })).toBeVisible();
    await expect(settings.getByRole('list', { name: 'Available providers' })).toBeVisible();
    // On-row status rides the row's accessible name (avatar + name + status).
    await expect(settings.getByRole('button', { name: 'OpenAI, Active' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Anthropic, Add key' })).toBeVisible();
  });

  test('opens the active provider config in a sheet with model, reasoning and a saved key', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'OpenAI, Active' }).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: /OpenAI/ })).toBeVisible();
    // The saved credential is masked; model & reasoning are configured inline.
    await expect(sheet.getByLabel('API key')).toHaveAttribute('placeholder', /Saved \(encrypted\)/);
    await expect(sheet.getByRole('combobox', { name: 'Model' })).toBeVisible();
    await expect(sheet.getByLabel('Reasoning')).toBeVisible();
    // A configured provider can be removed from its sheet.
    await expect(sheet.getByRole('button', { name: 'Remove provider' })).toBeVisible();
  });

  test('filters the provider list by search and keeps Custom reachable', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByLabel('Search providers').fill('anth');
    await expect(settings.getByRole('button', { name: /^Anthropic,/ })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'OpenAI, Active' })).toHaveCount(0);
    // The custom-provider add button lives beside the search, outside the list.
    await expect(settings.getByRole('button', { name: 'Custom provider' })).toBeVisible();
  });

  test('enters a credential through the provider sheet and saves the config', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Anthropic, Add key' }).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: /Anthropic/ })).toBeVisible();
    await expect(sheet.getByLabel('API key')).toHaveAttribute('placeholder', 'Paste API key');

    await sheet.getByLabel('API key').fill('sk-ant-test');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();

    // Save commits both the provider config and the credential.
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_set_provider_api_key')?.args;
    }).toMatchObject({ providerId: 'anthropic', apiKey: 'sk-ant-test' });
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({ provider: { providerId: 'anthropic', enabled: true } });
    // The sheet closes on save.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('validates a key asynchronously in the sheet and can be cancelled', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Anthropic, Add key' }).click();
    const sheet = page.getByRole('dialog');

    // A good key validates to success; a "bad" key reports failure — neither saves
    // (validate is a separate, non-blocking step).
    await sheet.getByLabel('API key').fill('sk-good');
    await sheet.getByRole('button', { name: 'Validate' }).click();
    await expect(sheet.getByText(/Connection successful/)).toBeVisible();

    await sheet.getByLabel('API key').fill('sk-bad');
    await sheet.getByRole('button', { name: 'Validate' }).click();
    await expect(sheet.getByText(/Invalid API key/)).toBeVisible();

    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'agent_set_provider_api_key')).toBe(false);
  });

  test('shows a credential note instead of a key field for non-key providers', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: /^Amazon Bedrock,/ }).click();
    const sheet = page.getByRole('dialog');
    // No misleading key field for an AWS-credential provider; the note explains it.
    await expect(sheet.getByLabel('API key')).toHaveCount(0);
    await expect(sheet.getByText(/uses your AWS credentials/i)).toBeVisible();
    await expect(sheet.getByRole('button', { name: /AWS credential setup/ })).toBeVisible();
  });

  test('lists the provider models in the sheet model selector', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'OpenAI, Active' }).click();
    const model = page.getByRole('dialog').getByRole('combobox', { name: 'Model' });
    await expect(model).toBeVisible();
    await expect(model).toContainText('GPT-5.4');
    await expect(model).toContainText('GPT-5.4 Mini');
  });

  test('toggles API key visibility in the sheet', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Anthropic, Add key' }).click();
    const sheet = page.getByRole('dialog');
    const key = sheet.getByLabel('API key');
    await expect(key).toHaveAttribute('type', 'password');

    await sheet.getByRole('button', { name: 'Show key' }).click();
    await expect(key).toHaveAttribute('type', 'text');

    await sheet.getByRole('button', { name: 'Hide key' }).click();
    await expect(key).toHaveAttribute('type', 'password');
  });

  test('creates a custom provider through the sheet', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Custom provider' }).click();

    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('Provider ID').fill('my-proxy');
    await sheet.getByLabel('API key').fill('sk-test');
    await sheet.getByRole('textbox', { name: 'Model' }).fill('custom-model');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();

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

  test('saves a changed model and reasoning from the provider sheet', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'OpenAI, Active' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('Reasoning').selectOption('high');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();

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
  await expect(settings.locator('.inset-row').first()).toBeVisible();
  return settings;
}
