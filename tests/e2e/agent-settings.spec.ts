import { expect, test, type Locator, type Page } from '@playwright/test';
import { commandCalls, installElectronMock } from './outlinerMock';

// Settings render in their own window (the ?surface=settings route), not an
// in-app modal. The Providers surface follows the macOS System Settings idiom: a
// floating category rail + a full-width inset grouped list (Connected / Available)
// with on-row status, and a per-provider config SHEET (opened by clicking a row)
// that hosts the credential, model & reasoning, base URL, async validate, and its
// own Cancel / Save. There is no permanent side detail pane, no global Save bar,
// no provider search, and no in-content Close button — the window is closed
// through native window chrome (traffic lights), like System Settings.
test.describe('agent settings window', () => {
  test('renders as a standalone window with a floating rail and native close', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // The category rail floats off the content base (its own elevated panel).
    await expect(settings.locator('.settings-rail')).toBeVisible();
    // Frameless window: a top drag strip stands in for the native title bar (the
    // OS traffic lights overlay it), so there is no separate title-bar row.
    await expect(settings.locator('.settings-drag-region')).toHaveCount(1);
    // No sheet is open at rest, and it owns the whole window — not a modal layered
    // over the app.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveCount(0);
    // Closing is delegated to native window chrome — there is no in-content button.
    await expect(settings.getByRole('button', { name: 'Close' })).toHaveCount(0);
  });

  test('groups providers by credential and reads status on each row', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('list', { name: 'Connected providers' })).toBeVisible();
    await expect(settings.getByRole('list', { name: 'Available providers' })).toBeVisible();
    // On-row status rides the row's accessible name (avatar + name + status).
    await expect(settings.getByRole('button', { name: 'OpenAI, Active' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Anthropic, Add key' })).toBeVisible();
  });

  test('opens the active provider config in a sheet with a saved key and base URL', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'OpenAI, Active' }).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: /OpenAI/ })).toBeVisible();
    // The saved credential is masked; the sheet configures only the connection
    // (key + base URL). Model & reasoning are chosen in the composer, not here.
    await expect(sheet.getByLabel('API key')).toHaveAttribute('placeholder', /Saved \(encrypted\)/);
    await expect(sheet.getByLabel('Base URL')).toBeVisible();
    await expect(sheet.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
    await expect(sheet.getByLabel('Reasoning')).toHaveCount(0);
    // A configured provider can be removed from its sheet.
    await expect(sheet.getByRole('button', { name: 'Remove provider' })).toBeVisible();
  });

  test('shows the row actions menu only when there is more than one action', async ({ page }) => {
    const settings = await openSettings(page);
    // The active, configured OpenAI has multiple actions → a ⋯ menu.
    await expect(settings.getByRole('button', { name: 'OpenAI actions' })).toBeVisible();
    // Unconfigured Anthropic's only action is "Configure", which is exactly what
    // clicking the row does — so no redundant ⋯ menu.
    await expect(settings.getByRole('button', { name: 'Anthropic actions' })).toHaveCount(0);
  });

  test('has no provider search and keeps the custom-provider add reachable', async ({ page }) => {
    const settings = await openSettings(page);
    // Native System Settings (Wi-Fi) has no list search; custom providers are added
    // from the last row of the Available list, not a floating control.
    await expect(settings.getByLabel('Search providers')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Add custom provider' })).toBeVisible();
    // The full list is always shown — both Anthropic and the active OpenAI.
    await expect(settings.getByRole('button', { name: /^Anthropic,/ })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'OpenAI, Active' })).toBeVisible();
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

  test('exposes the base URL inline, not behind an Advanced disclosure', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'OpenAI, Active' }).click();
    const sheet = page.getByRole('dialog');
    // Base URL is a plain row (the lone advanced setting), so there is no
    // "Advanced" disclosure to expand.
    await expect(sheet.getByLabel('Base URL')).toBeVisible();
    await expect(sheet.getByText('Advanced')).toHaveCount(0);
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
    await settings.getByRole('button', { name: 'Add custom provider' }).click();

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

  test('saves the connection and preserves the configured model', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'OpenAI, Active' }).click();
    const sheet = page.getByRole('dialog');
    // The sheet only edits the connection; saving must keep the existing model
    // (the composer owns model choice) rather than clearing it.
    await sheet.getByLabel('Base URL').fill('https://proxy.example.com/v1');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'openai',
        modelId: 'gpt-5.4',
        baseUrl: 'https://proxy.example.com/v1',
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
