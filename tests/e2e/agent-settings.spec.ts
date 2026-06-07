import { expect, test, type Locator, type Page } from '@playwright/test';
import { commandCalls, installElectronMock } from './outlinerMock';

// Settings render in their own window (the ?surface=settings route). The Providers
// surface follows the macOS System Settings idiom: a floating category rail + a
// constrained inset grouped list (Connected / Available). Clicking a provider opens
// its connection config in its OWN native window — a modal child of settings
// (?surface=provider-config), NOT an in-renderer modal — the way System Settings
// opens a real attached dialog. The list window has no provider search and no
// in-content Close button (closed through native window chrome).
test.describe('agent settings window', () => {
  test('renders as a standalone window with a floating rail and native close', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // The category rail floats off the content base (its own elevated panel).
    await expect(settings.locator('.settings-rail')).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Providers', exact: true })).toBeVisible();
    await expect(settings.locator('.settings-nav-hint')).toHaveCount(0);
    // Frameless window: a top drag strip stands in for the native title bar (the
    // OS traffic lights overlay it), so there is no separate title-bar row.
    await expect(settings.locator('.settings-drag-region')).toHaveCount(1);
    // The config is a separate native window, so the list never layers a modal.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveCount(0);
    // Closing is delegated to native window chrome — there is no in-content button.
    await expect(settings.getByRole('button', { name: 'Close' })).toHaveCount(0);
  });

  test('navigates categories with the back / forward toolbar arrows', async ({ page }) => {
    const settings = await openSettings(page);
    const back = settings.getByRole('button', { name: 'Back' });
    const forward = settings.getByRole('button', { name: 'Forward' });
    // At rest (Providers, no history) both arrows are inert, like System Settings.
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();

    // Visiting another category records history, so back becomes available. The
    // toolbar title names the pane; assert the content by its grouped inset list,
    // symmetric with the Providers check below.
    await settings.getByRole('button', { name: /^Permissions/ }).click();
    await expect(settings.getByRole('list', { name: 'Common actions' })).toBeVisible();
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    // Back returns to Providers and arms forward.
    await back.click();
    await expect(settings.getByRole('list', { name: 'Available providers' })).toBeVisible();
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();

    // Forward replays the visit.
    await forward.click();
    await expect(settings.getByRole('list', { name: 'Common actions' })).toBeVisible();
    await expect(forward).toBeDisabled();
  });

  test('keeps scrolled content below the fixed toolbar chrome', async ({ page }) => {
    const settings = await openSettings(page);
    const toolbarBox = await settings.locator('.settings-toolbar').boundingBox();
    const contentBox = await settings.locator('.settings-content').boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(contentBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height);

    await settings.locator('.settings-content').evaluate((element) => {
      element.scrollTop = 240;
    });
    const scrolledContentBox = await settings.locator('.settings-content').boundingBox();
    expect(scrolledContentBox!.y).toBeCloseTo(contentBox!.y, 1);
  });

  test('uses a flat settings pop-up button for select controls', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'General', exact: true }).click();
    const popup = settings.locator('.select-popup-input').first();
    await expect(popup).toBeVisible();
    const restingStyle = await popup.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        backgroundColor: computed.backgroundColor,
        borderWidth: computed.borderTopWidth,
        boxShadow: computed.boxShadow,
      };
    });
    expect(restingStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(restingStyle.borderWidth).toBe('0px');
    expect(restingStyle.boxShadow).toBe('none');

    await popup.hover();
    await expect.poll(async () => {
      return popup.evaluate((element) => getComputedStyle(element).backgroundColor);
    }).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('keeps permission decision pop-ups aligned through the last row', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: /^Permissions/ }).click();
    const content = settings.locator('.settings-content');
    const popups = settings.locator('.settings-permissions-section .select-popup-input');
    await expect(popups).toHaveCount(10);

    const firstBox = await popups.first().boundingBox();
    const lastBox = await popups.last().boundingBox();
    expect(firstBox).not.toBeNull();
    expect(lastBox).not.toBeNull();
    expect(lastBox!.width).toBeCloseTo(firstBox!.width, 1);

    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const contentBox = await content.boundingBox();
    const scrolledLastBox = await popups.last().boundingBox();
    expect(contentBox).not.toBeNull();
    expect(scrolledLastBox).not.toBeNull();
    expect(scrolledLastBox!.y + scrolledLastBox!.height).toBeLessThan(contentBox!.y + contentBox!.height - 6);
  });

  test('opens agent profile details as a drill-down settings page', async ({ page }) => {
    const settings = await openSettings(page);
    const back = settings.getByRole('button', { name: 'Back' });
    const forward = settings.getByRole('button', { name: 'Forward' });
    await settings.getByRole('button', { name: 'Agent Profiles', exact: true }).click();
    await expect(settings.locator('.settings-toolbar-title')).toHaveText('Agent Profiles');
    await expect(settings.getByRole('list', { name: 'Agent profiles' })).toBeVisible();
    await expect(settings.locator('.agent-profile-detail-card')).toHaveCount(0);
    await expect(settings.getByRole('switch', { name: 'Toggle general' })).toHaveCount(0);

    await settings.getByRole('button', { name: 'general', exact: true }).click();
    await expect(settings.locator('.settings-toolbar-title')).toHaveText('general');
    await expect(settings.locator('.agent-profile-detail-card')).toBeVisible();
    await expect(settings.getByRole('list', { name: 'Agent profiles' })).toHaveCount(0);
    await expect(settings.getByRole('switch', { name: 'Toggle general' })).toBeVisible();
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await back.click();
    await expect(settings.locator('.settings-toolbar-title')).toHaveText('Agent Profiles');
    await expect(settings.getByRole('list', { name: 'Agent profiles' })).toBeVisible();
    await expect(settings.locator('.agent-profile-detail-card')).toHaveCount(0);
    await expect(forward).toBeEnabled();

    await forward.click();
    await expect(settings.locator('.settings-toolbar-title')).toHaveText('general');
    await expect(settings.locator('.agent-profile-detail-card')).toBeVisible();
  });

  test('lets users view, edit, and forget agent memory entries', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: /^Memory/ }).click();

    await expect(settings.getByRole('list', { name: 'Remembered facts' })).toBeVisible();
    await expect(settings.getByText('Prefer concise, direct implementation notes')).toBeVisible();
    await expect(settings.getByText('Use the old session vocabulary')).toBeVisible();
    await expect(settings.getByText('Active')).toBeVisible();
    await expect(settings.getByText('Forgotten')).toBeVisible();

    await settings.getByRole('button', { name: 'Edit memory' }).click();
    const editor = settings.getByLabel('Memory fact');
    await expect(editor).toBeVisible();
    await editor.fill('Prefer concise, direct implementation notes with explicit verification.');
    await settings.getByRole('button', { name: 'Save memory' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_update_memory')?.args;
    }).toMatchObject({
      memoryId: 'memory-active',
      fact: 'Prefer concise, direct implementation notes with explicit verification.',
    });
    await expect(settings.getByText('Memory updated')).toBeVisible();
    await expect(settings.getByText('Prefer concise, direct implementation notes with explicit verification.')).toBeVisible();

    await settings.getByRole('button', { name: 'Forget memory' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_forget_memory')?.args;
    }).toMatchObject({ memoryId: 'memory-active' });
    await expect(settings.getByText('Memory forgotten')).toBeVisible();
    await expect(settings.locator('.settings-chip', { hasText: 'Forgotten' })).toHaveCount(2);
    await expect(settings.getByRole('button', { name: 'Edit memory' })).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Forget memory' })).toHaveCount(0);
  });

  test('groups providers by credential and reads status on each row', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('list', { name: 'Connected providers' })).toBeVisible();
    await expect(settings.getByRole('list', { name: 'Available providers' })).toBeVisible();
    // On-row status rides the row's accessible name (avatar + name + status).
    await expect(settings.getByRole('button', { name: 'OpenAI, Active' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Anthropic, Add key' })).toBeVisible();
  });

  test('shows the row actions menu only when there is more than one action', async ({ page }) => {
    const settings = await openSettings(page);
    // The active, configured OpenAI has multiple actions → a ⋯ menu.
    await expect(settings.getByRole('button', { name: 'OpenAI actions' })).toBeVisible();
    // Unconfigured Anthropic's only action is "Configure", which is exactly what
    // clicking the row does — so no redundant ⋯ menu.
    await expect(settings.getByRole('button', { name: 'Anthropic actions' })).toHaveCount(0);
  });

  test('opens a provider config window when its row is clicked (not an in-app modal)', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'OpenAI, Active' }).click();
    // Clicking a row asks the main process to open the native config window — it
    // does NOT layer a dialog inside the settings window.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_provider_config')?.args;
    }).toMatchObject({ providerId: 'openai', mode: 'configure' });
  });

  test('a single-action row exposes a Configure button that opens the config window', async ({ page }) => {
    const settings = await openSettings(page);
    // The lone "Configure" action is a real trailing button (the macOS Wi-Fi
    // "Connect" idiom), revealed on row hover — not just decorative hint text.
    await settings.getByRole('button', { name: 'Anthropic, Add key' }).hover();
    const configure = settings.getByRole('button', { name: 'Configure Anthropic' });
    await expect(configure).toBeVisible();
    await configure.click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_provider_config')?.args;
    }).toMatchObject({ providerId: 'anthropic', mode: 'configure' });
  });

  test('has no provider search and opens the custom-provider window from the last row', async ({ page }) => {
    const settings = await openSettings(page);
    // Native System Settings (Wi-Fi) has no list search; custom providers are added
    // from the last row of the Available list, which opens the config window in
    // custom mode.
    await expect(settings.getByLabel('Search providers')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: /^Anthropic,/ })).toBeVisible();
    await settings.getByRole('button', { name: 'Add custom provider' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_provider_config')?.args;
    }).toMatchObject({ providerId: '', mode: 'custom' });
  });
});

// The per-provider config window (?surface=provider-config) — a standalone surface
// (in the app, a modal child window). It hosts only the CONNECTION: the credential
// (key / managed note) and base URL, plus an async validate. Model & reasoning are
// chosen in the composer, not here.
test.describe('provider config window', () => {
  test('renders the saved connection (masked key + base URL), without model or reasoning', async ({ page }) => {
    const config = await openProviderConfig(page, 'openai');
    await expect(config.getByRole('heading', { name: /OpenAI/ })).toBeVisible();
    await expect(config.getByLabel('API key')).toHaveAttribute('placeholder', /Saved \(encrypted\)/);
    await expect(config.getByLabel('Base URL')).toBeVisible();
    await expect(config.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
    await expect(config.getByLabel('Reasoning')).toHaveCount(0);
    // A configured provider can be removed from its window.
    await expect(config.getByRole('button', { name: 'Remove provider' })).toBeVisible();
  });

  test('enters a credential and saves the config', async ({ page }) => {
    const config = await openProviderConfig(page, 'anthropic');
    await expect(config.getByRole('heading', { name: /Anthropic/ })).toBeVisible();
    await expect(config.getByLabel('API key')).toHaveAttribute('placeholder', 'Paste API key');

    await config.getByLabel('API key').fill('sk-ant-test');
    await config.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_set_provider_api_key')?.args;
    }).toMatchObject({ providerId: 'anthropic', apiKey: 'sk-ant-test' });
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({ provider: { providerId: 'anthropic', enabled: true } });
  });

  test('validates a key asynchronously and never saves on validate', async ({ page }) => {
    const config = await openProviderConfig(page, 'anthropic');
    await config.getByLabel('API key').fill('sk-good');
    await config.getByRole('button', { name: 'Validate' }).click();
    await expect(config.getByText(/Connection successful/)).toBeVisible();

    await config.getByLabel('API key').fill('sk-bad');
    await config.getByRole('button', { name: 'Validate' }).click();
    await expect(config.getByText(/Invalid API key/)).toBeVisible();

    const calls = await commandCalls(page);
    expect(calls.some((call) => call.cmd === 'agent_set_provider_api_key')).toBe(false);
  });

  test('shows a credential note instead of a key field for non-key providers', async ({ page }) => {
    const config = await openProviderConfig(page, 'amazon-bedrock');
    await expect(config.getByLabel('API key')).toHaveCount(0);
    await expect(config.getByText(/uses your AWS credentials/i)).toBeVisible();
    await expect(config.getByRole('button', { name: /AWS credential setup/ })).toBeVisible();
  });

  test('exposes the base URL inline, not behind an Advanced disclosure', async ({ page }) => {
    const config = await openProviderConfig(page, 'openai');
    await expect(config.getByLabel('Base URL')).toBeVisible();
    await expect(config.getByText('Advanced')).toHaveCount(0);
  });

  test('toggles API key visibility', async ({ page }) => {
    const config = await openProviderConfig(page, 'anthropic');
    const key = config.getByLabel('API key');
    await expect(key).toHaveAttribute('type', 'password');

    await config.getByRole('button', { name: 'Show key' }).click();
    await expect(key).toHaveAttribute('type', 'text');

    await config.getByRole('button', { name: 'Hide key' }).click();
    await expect(key).toHaveAttribute('type', 'password');
  });

  test('creates a custom provider', async ({ page }) => {
    const config = await openProviderConfig(page, '', 'custom');
    await config.getByLabel('Provider ID').fill('my-proxy');
    await config.getByLabel('API key').fill('sk-test');
    await config.getByRole('textbox', { name: 'Model' }).fill('custom-model');
    await config.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: { providerId: 'my-proxy', modelId: 'custom-model', enabled: true },
    });
  });

  test('saves the connection and preserves the configured model', async ({ page }) => {
    const config = await openProviderConfig(page, 'openai');
    // The window only edits the connection; saving must keep the existing model
    // (the composer owns model choice) rather than clearing it.
    await config.getByLabel('Base URL').fill('https://proxy.example.com/v1');
    await config.getByRole('button', { name: 'Save', exact: true }).click();

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

async function openProviderConfig(page: Page, provider: string, mode = 'configure'): Promise<Locator> {
  await installElectronMock(page);
  await page.goto(`/?surface=provider-config&provider=${provider}&mode=${mode}`);
  const config = page.locator('.provider-config-window');
  await expect(config).toBeVisible();
  // Wait for the form (after the provider-settings fetch resolves) before asserting.
  await expect(config.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  return config;
}
