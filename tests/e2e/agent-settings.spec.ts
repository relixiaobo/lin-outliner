import { expect, test, type Locator, type Page } from '@playwright/test';
import { clipboardText, commandCalls, installElectronMock } from './outlinerMock';

// Settings render in their own window (the ?surface=settings route). The Providers
// surface follows the macOS System Settings idiom: a floating category rail + a
// constrained inset grouped list (Configured / Add Providers). Clicking most
// providers opens connection config in its OWN native window — a modal child of settings
// (?surface=provider-config), NOT an in-renderer modal — the way System Settings
// opens a real attached dialog. The list window has no provider search and no
// in-content Close button (closed through native window chrome).
test.describe('agent settings window', () => {
  test('shows native window chrome before provider settings finish loading', async ({ page }) => {
    await installElectronMock(page, { providerSettingsDelayMs: 1_000 });
    await page.goto('/?surface=settings');

    const settings = page.locator('.settings-window');
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(settings.locator('.settings-rail')).toBeVisible();
    await expect(settings.locator('.settings-content')).toHaveAttribute('aria-busy', 'true');
    await expect(settings.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
    await expect(settings.locator('.agent-settings-empty', { hasText: 'Loading' })).toHaveCount(0);
  });

  test('renders as a standalone window with a floating rail and native close', async ({ page }) => {
    const settings = await openSettings(page);
    await expect(settings.getByRole('heading', { name: 'Settings' })).toBeVisible();
    // The category rail floats off the content base (its own elevated panel).
    await expect(settings.locator('.settings-rail')).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
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

  test('navigates categories and pages with the back / forward toolbar arrows', async ({ page }) => {
    const settings = await openSettings(page);
    const back = settings.getByRole('button', { name: 'Back' });
    const forward = settings.getByRole('button', { name: 'Forward' });
    // At rest (General, no history) both arrows are inert, like System Settings.
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();

    await settings.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(settings.getByRole('list', { name: 'Agent access' })).toBeVisible();
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    await back.click();
    await expect(settings.getByRole('list', { name: 'Diagnostics' })).toBeVisible();
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();

    await forward.click();
    await expect(settings.getByRole('list', { name: 'Agent access' })).toBeVisible();
    await expect(forward).toBeDisabled();

    // The arrows now walk into pages too, which is the reason they stopped being
    // permanently-disabled chrome: with one route type they could only ever
    // duplicate the rail beside them.
    await settings.getByRole('button', { name: /^Model services/ }).click();
    await expect(settings.getByRole('list', { name: 'Providers to add' })).toBeVisible();
    await expect(settings.getByRole('heading', { name: 'Model services' })).toBeVisible();
    await back.click();
    await expect(settings.getByRole('list', { name: 'Agent access' })).toBeVisible();
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

  // The Memory group raised a red alert on every run until the mock grew the
  // memory channels: an unhandled invoke throws, MemorySettingsGroup catches it
  // into the shared alert, and its 5s poll re-fired it forever. Nothing asserted
  // the pane was error-free, so it went unnoticed — including by the
  // design-system probes, which photograph it and pass regardless. The wait
  // covers the poll, so a regression cannot hide in the gap before it fires.
  // Memory lives in Agent now, so that is where this belongs.
  test('renders the Agent pane without raising an error', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(settings.getByRole('list', { name: 'Memory' })).toBeVisible();
    await expect(settings.getByRole('alert')).toHaveCount(0);
    await page.waitForTimeout(5_500);
    await expect(settings.getByRole('alert')).toHaveCount(0);
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

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`shows passive diagnostics actions in General settings in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      const settings = await openSettings(page);
      await settings.getByRole('button', { name: 'General', exact: true }).click();
      await expect(settings.getByRole('list', { name: 'Diagnostics' })).toBeVisible();
      const revealButton = settings.getByRole('button', { name: 'Reveal' });
      const exportButton = settings.getByRole('button', { name: 'Export…' });
      await expect(revealButton).toBeVisible();
      await expect(exportButton).toBeVisible();
      for (const [button, rowText] of [[revealButton, 'Diagnostics log'], [exportButton, 'Diagnostics export']] as const) {
        const row = settings.locator('.inset-row', { hasText: rowText });
        const rowBox = await row.boundingBox();
        const buttonBox = await button.boundingBox();
        expect(rowBox).not.toBeNull();
        expect(buttonBox).not.toBeNull();
        expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
      }
    });
  }

  // The pending-acceptance case that stood here could never have run against the
  // shipped app: `ratified` was hardcoded true, so the chip and the Accept button
  // it asserted were unreachable in the product and existed only for the mock. The
  // trust model is deleted; what a project Skill's row still owes the user is its
  // source and a working toggle.
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`keeps a workspace skill row readable in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      const settings = await openSettings(page);
      await openSkillsPage(settings);

      const row = settings.locator('.inset-row', { hasText: '/workspace-review' });
      await expect(row).toBeVisible();
      await expect(row.locator('.settings-chip', { hasText: 'project' })).toBeVisible();
      await expect(row.getByRole('button', { name: /Accept/ })).toHaveCount(0);

      const toggle = row.getByRole('switch');
      await expect(toggle).toBeVisible();
      const rowBox = await row.boundingBox();
      const toggleBox = await toggle.boundingBox();
      expect(rowBox).not.toBeNull();
      expect(toggleBox).not.toBeNull();
      expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
    });
  }

  test('defaults to Full Access with truthful host and credential scope', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: 'Agent', exact: true }).click();
    const filesystemRow = settings.locator('.inset-row', { hasText: 'Filesystem' }).first();
    await expect(filesystemRow.locator('.inset-row-trailing')).toHaveText('Full Access');
    // The boundary is a footnote under the row it explains, not a group of its
    // own: a section header over a row whose label named something you cannot set
    // and whose sublabel was a paragraph.
    await expect(settings.getByRole('list', { name: 'System boundary' })).toHaveCount(0);
    await expect(settings.getByText(/whatever your macOS account reaches/)).toBeVisible();
    await expect(settings.getByText(/including Tenon.s own data and stored provider credentials/)).toBeVisible();
    await expect(settings.getByRole('list', { name: 'Your blocks' })).toContainText('No explicit blocks.');
    await expect(settings.getByText('Restricted', { exact: true })).toHaveCount(0);
    await expect(settings.getByRole('button', { name: /Choose Folder/ })).toHaveCount(0);

    // What this guarded was that the boundary prose stays readable rather than
    // getting squeezed into a column. It is a footnote now, so that is what gets
    // measured.
    const footnoteWidth = await settings.locator('.inset-group-footnote').first().evaluate(
      (note) => note.getBoundingClientRect().width,
    );
    expect(footnoteWidth).toBeGreaterThanOrEqual(300);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`keeps the Full Access status contained without overlap in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      const settings = await openSettings(page);
      await settings.getByRole('button', { name: 'Agent', exact: true }).click();
      const row = settings.locator('.inset-row', { hasText: 'Filesystem' }).first();
      const status = row.locator('.inset-row-trailing');
      await expect(status).toHaveText('Full Access');

      const metrics = await row.evaluate((element) => {
        const rowBox = element.getBoundingClientRect();
        const statusBox = element.querySelector<HTMLElement>('.inset-row-trailing')?.getBoundingClientRect();
        const sublabelBox = element.querySelector<HTMLElement>('.inset-row-sublabel')?.getBoundingClientRect();
        if (!statusBox || !sublabelBox) return null;
        const overlaps = !(
          sublabelBox.right <= statusBox.left
          || statusBox.right <= sublabelBox.left
          || sublabelBox.bottom <= statusBox.top
          || statusBox.bottom <= sublabelBox.top
        );
        return {
          contained: statusBox.left >= rowBox.left && statusBox.right <= rowBox.right,
          overlaps,
        };
      });
      expect(metrics).toEqual({ contained: true, overlaps: false });
    });
  }

  test('removes user block rules through the Security pane', async ({ page }) => {
    const settings = await openSettings(page, '', {
      capabilityBlocks: ['Command(git push origin main)', 'Action(git.publish_remote)'],
    });
    await settings.getByRole('button', { name: 'Agent', exact: true }).click();
    const blocks = settings.getByRole('list', { name: 'Your blocks' });
    await expect(blocks).toContainText('Command(git push origin main)');

    // Removal commits on the row. There is no footer Save anywhere in this window
    // any more: the drafts it collected are gone, and with them the footer that
    // appeared per-category while the draft it committed was global.
    await blocks.locator('.inset-row', { hasText: 'Command(git push origin main)' }).getByRole('button', { name: 'Remove' }).click();
    await expect(blocks).not.toContainText('Command(git push origin main)');
    await expect(blocks).toContainText('Action(git.publish_remote)');
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);

    await expect.poll(async () => {
      const updateCall = (await commandCalls(page)).find((call) => call.cmd === 'agent_apply_capability_settings_patch');
      return updateCall?.args.patch;
    }).toEqual({
      removeBlocks: ['Command(git push origin main)'],
    });
  });


  test('groups providers by configuration state and reads status on each row', async ({ page }) => {
    const settings = await openSettings(page);
    await openServicesPage(settings);
    const configured = settings.getByRole('list', { name: 'Configured providers' });
    await expect(configured).toBeVisible();
    await expect(settings.getByRole('list', { name: 'Providers to add' })).toBeVisible();
    await expect(configured).toContainText('CC Switch');
    // On-row status rides the row's accessible name (avatar + name + status).
    // "Add key" and "Needs key" collapsed into one state: they differed only by
    // whether a config row had been materialized, which is not a fact about the
    // user's situation.
    await expect(settings.getByRole('button', { name: 'OpenAI, Active' })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Anthropic, Needs key' })).toBeVisible();
    // And the status is now readable, not only announced: until this pane shared
    // one status model with the config window, which connection was Active was
    // visible in that window and nowhere else.
    await expect(configured.getByText('Active')).toBeVisible();
  });

  test('shows the row actions menu only when there is more than one action', async ({ page }) => {
    const settings = await openSettings(page);
    await openServicesPage(settings);
    // The active, configured OpenAI has multiple actions → a ⋯ menu.
    await expect(settings.getByRole('button', { name: 'OpenAI actions' })).toBeVisible();
    // Unconfigured Anthropic's only action is "Configure", which is exactly what
    // clicking the row does — so no redundant ⋯ menu.
    await expect(settings.getByRole('button', { name: 'Anthropic actions' })).toHaveCount(0);
  });

  test('toggles a configured provider without removing the connection row', async ({ page }) => {
    const settings = await openSettings(page);
    await openServicesPage(settings);
    const openaiSwitch = settings.getByRole('switch', { name: 'Enable or disable OpenAI' });
    await expect(openaiSwitch).toHaveAttribute('aria-checked', 'true');

    await openaiSwitch.click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'openai',
        enabled: false,
      },
    });
    await expect(openaiSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(settings.getByRole('button', { name: 'OpenAI, Disabled' })).toBeVisible();
    await expect(settings.getByText('Provider disabled')).toBeVisible();

    await openaiSwitch.click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'openai',
        enabled: true,
      },
    });
    await expect(openaiSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(settings.getByText('Provider enabled')).toBeVisible();
  });

  test('enables detected CC Switch directly from the provider list', async ({ page }) => {
    const settings = await openSettings(page);
    await openServicesPage(settings);
    const ccSwitch = settings.getByRole('switch', { name: 'Enable or disable CC Switch' });
    await expect(ccSwitch).toHaveAttribute('aria-checked', 'false');

    await ccSwitch.click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'cc-switch',
        baseUrl: 'https://registry.example.com/v1',
        enabled: true,
      },
    });
    await expect(settings.getByRole('button', { name: 'CC Switch, Ready' })).toBeVisible();
    await expect(settings.getByRole('switch', { name: 'Enable or disable CC Switch' })).toHaveAttribute('aria-checked', 'true');
  });

  test('refreshes enabled CC Switch models from the provider row', async ({ page }) => {
    const settings = await openSettings(page);
    await openServicesPage(settings);
    await settings.getByRole('switch', { name: 'Enable or disable CC Switch' }).click();
    await expect(settings.getByRole('button', { name: 'CC Switch, Ready' })).toBeVisible();

    await settings.getByRole('button', { name: 'CC Switch actions' }).click();
    await page.getByRole('menuitem', { name: 'Refresh models' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_refresh_provider_models')?.args;
    }).toMatchObject({ providerId: 'cc-switch' });
    await expect(settings.getByText('Provider models refreshed')).toBeVisible();
  });

  test('opens a provider config window when its row is clicked (not an in-app modal)', async ({ page }) => {
    const settings = await openSettings(page);
    await openServicesPage(settings);
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
    await openServicesPage(settings);
    // The lone "Configure" action is a real trailing button (the macOS Wi-Fi
    // "Connect" idiom), revealed on row hover — not just decorative hint text.
    await settings.getByRole('button', { name: 'Anthropic, Needs key' }).hover();
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
    await openServicesPage(settings);
    // Native System Settings (Wi-Fi) has no list search; custom providers are added
    // from the last row of the add-provider list, which opens the config window in
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

test.describe('provider config windows', () => {
  // The skeleton used to draw an API-key field and a base URL unconditionally,
  // then resolve into something else entirely: a managed-credential provider has
  // no key field at all, and an OAuth provider resolves to a sign-in surface. It
  // showed people a form that vanished. Which shape is right is not knowable
  // until the settings land, so it names the provider and waits.
  test('does not guess the form shape before provider settings load', async ({ page }) => {
    await installElectronMock(page, { providerSettingsDelayMs: 1_000 });
    await page.goto('/?surface=provider-config&provider=openai&mode=configure');

    const config = page.locator('.provider-config-window');
    await expect(config).toBeVisible();
    await expect(config).toHaveAttribute('aria-busy', 'true');
    await expect(config.getByRole('heading', { name: 'OpenAI' })).toBeVisible();
    await expect(config.getByLabel('API key')).toHaveCount(0);
    await expect(config.getByLabel('Base URL')).toHaveCount(0);
    // A way out exists throughout; a Save that cannot yet know what it would
    // commit does not.
    await expect(config.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(config.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(config.locator('.agent-settings-empty', { hasText: 'Loading' })).toHaveCount(0);

    // And it resolves into the real form rather than staying a shell.
    await expect(config.getByLabel('API key')).toBeVisible();
  });

  test('renders the saved connection — connection only, no model/reasoning controls', async ({ page }) => {
    const config = await openProviderConfig(page, 'openai');
    await expect(config.getByRole('heading', { name: /OpenAI/ })).toBeVisible();
    await expect(config.getByLabel('API key')).toHaveAttribute('placeholder', 'sk*****************');
    await expect(config.getByLabel('Base URL')).toBeVisible();
    // Model and effort moved to the Configuration Profile; neither control lives here now.
    await expect(config.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
    await expect(config.getByRole('combobox', { name: 'Thinking level' })).toHaveCount(0);
    // A configured provider can be removed from its window.
    await expect(config.getByRole('button', { name: 'Remove provider' })).toBeVisible();
  });

  test('reveals and copies a saved API key on explicit user action', async ({ page }) => {
    const config = await openProviderConfig(page, 'openai');
    const keyField = config.getByLabel('API key');
    await expect(keyField).toHaveValue('');
    await expect(keyField).toHaveAttribute('placeholder', 'sk*****************');

    await config.getByRole('button', { name: 'Show key' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'lin:get-provider-api-key')?.args;
    }).toMatchObject({ providerId: 'openai' });
    await expect(keyField).toHaveAttribute('type', 'text');
    await expect(keyField).toHaveValue('sk-openai-saved');

    await config.getByRole('button', { name: 'Copy key' }).click();
    await expect.poll(() => clipboardText(page)).toBe('sk-openai-saved');
    await expect(config.getByText('Key copied')).toBeVisible();

    await config.getByRole('button', { name: 'Hide key' }).click();
    await expect(keyField).toHaveValue('');
  });

  test('enters a credential and saves the connection', async ({ page }) => {
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
    }).toMatchObject({
      provider: {
        providerId: 'anthropic',
        enabled: true,
      },
    });
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
    await expect(config.getByLabel('Base URL')).toBeVisible();
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
    await config.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: { providerId: 'my-proxy', enabled: true },
    });
  });

  test('saves the connection with a base URL override', async ({ page }) => {
    const config = await openProviderConfig(page, 'openai');
    await config.getByLabel('Base URL').fill('http://localhost:1234/v1');
    await config.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'openai',
        baseUrl: 'http://localhost:1234/v1',
        enabled: true,
      },
    });
  });
});

/** Agent → Model services. Providers stopped being a rail category. */
async function openServicesPage(settings: Locator): Promise<void> {
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await settings.getByRole('button', { name: /^Model services/ }).click();
  await expect(settings.getByRole('list', { name: 'Providers to add' })).toBeVisible();
}

/** Agent → Skills. */
async function openSkillsPage(settings: Locator): Promise<void> {
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await settings.getByRole('button', { name: /^Skills/ }).click();
}

async function openSettings(page: Page, extraQuery = '', options: Parameters<typeof installElectronMock>[1] = {}): Promise<Locator> {
  await installElectronMock(page, options);
  await page.goto(`/?surface=settings${extraQuery}`);
  const settings = page.locator('.settings-window');
  await expect(settings).toBeVisible();
  // Wait for the provider-backed rows when a spec needs loaded settings data.
  // Window chrome and category navigation render before this fetch resolves.
  await expect(settings.locator('.settings-content')).not.toHaveAttribute('aria-busy', 'true');
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
