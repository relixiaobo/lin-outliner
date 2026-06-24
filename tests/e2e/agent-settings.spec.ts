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
    await settings.getByRole('button', { name: /^Security/ }).click();
    await expect(settings.getByRole('list', { name: 'Default' })).toBeVisible();
    await expect(back).toBeEnabled();
    await expect(forward).toBeDisabled();

    // Back returns to Providers and arms forward.
    await back.click();
    await expect(settings.getByRole('list', { name: 'Available providers' })).toBeVisible();
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();

    // Forward replays the visit.
    await forward.click();
    await expect(settings.getByRole('list', { name: 'Default' })).toBeVisible();
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

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`shows workspace skill pending acceptance without overlap in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      const settings = await openSettings(page);
      await settings.getByRole('button', { name: 'Skills', exact: true }).click();

      const row = settings.locator('.inset-row', { hasText: '/workspace-review' });
      await expect(row).toBeVisible();
      await expect(row.locator('.settings-chip', { hasText: 'project' })).toBeVisible();
      const workspaceChip = row.locator('.settings-chip', { hasText: 'Workspace · not accepted' });
      await expect(workspaceChip).toBeVisible();
      const acceptButton = row.getByRole('button', { name: 'Accept workspace-review for automatic use' });
      await expect(acceptButton).toBeVisible();

      const rowBox = await row.boundingBox();
      const chipBox = await workspaceChip.boundingBox();
      const buttonBox = await acceptButton.boundingBox();
      expect(rowBox).not.toBeNull();
      expect(chipBox).not.toBeNull();
      expect(buttonBox).not.toBeNull();
      expect(chipBox!.x + chipBox!.width).toBeLessThan(buttonBox!.x);
      expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
    });
  }

  test('shows delegated-operator permissions without mode or exception controls', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: /^Security/ }).click();
    await expect(settings.getByRole('list', { name: 'Default' })).toContainText('Delegated operator');
    await expect(settings.getByText("Credential exfiltration, permission or secret self-modification, payment actions, and host destruction can't be changed here.")).toBeVisible();
    await expect(settings.getByRole('radio', { name: 'Full Access' })).toHaveCount(0);
    await expect(settings.getByText('Add an exception')).toHaveCount(0);
    await expect(settings.locator('.settings-permissions-section .select-popup-input')).toHaveCount(0);
    await expect(settings.getByRole('list', { name: 'User blocks' })).toContainText('No user blocks yet.');
    await expect(settings.getByRole('list', { name: 'Soft-block exceptions' })).toContainText('No soft-block exceptions yet.');
    await expect(settings.getByRole('list', { name: 'File boundaries' })).toContainText('No handed folders or legacy grants yet.');

    const modeRowMetrics = await settings.locator('.settings-permission-mode-row').evaluate((row) => {
      const sublabel = row.querySelector<HTMLElement>('.inset-row-sublabel');
      if (!sublabel) {
        return null;
      }
      const sublabelBox = sublabel.getBoundingClientRect();
      return {
        sublabelHeight: sublabelBox.height,
        sublabelWidth: sublabelBox.width,
      };
    });
    expect(modeRowMetrics).not.toBeNull();
    expect(modeRowMetrics!.sublabelWidth).toBeGreaterThanOrEqual(300);
    expect(modeRowMetrics!.sublabelHeight).toBeLessThan(48);
  });

  test('removes user block rules through the Security pane', async ({ page }) => {
    const settings = await openSettings(page, '', {
      permissionBlocks: ['Command(git push origin main)', 'Action(git.publish_remote)'],
      permissionSoftBlockAllows: ['Command(eval "echo ok")'],
    });
    await settings.getByRole('button', { name: /^Security/ }).click();
    const blocks = settings.getByRole('list', { name: 'User blocks' });
    await expect(blocks).toContainText('Command(git push origin main)');

    await blocks.locator('.inset-row', { hasText: 'Command(git push origin main)' }).getByRole('button', { name: 'Remove' }).click();
    await expect(blocks).not.toContainText('Command(git push origin main)');
    await expect(blocks).toContainText('Action(git.publish_remote)');

    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => {
      const updateCall = (await commandCalls(page)).find((call) => call.cmd === 'agent_update_tool_permission_settings');
      return updateCall?.args.settings;
    }).toEqual({
      grants: [],
      blocks: ['Action(git.publish_remote)'],
      softBlockAllows: ['Command(eval "echo ok")'],
    });
  });

  test('hands a folder to Tenon as a remembered scope grant', async ({ page }) => {
    const settings = await openSettings(page, '', {
      permissionGrants: ['Scope(read:/tmp/project)'],
    });
    await settings.getByRole('button', { name: /^Security/ }).click();

    const boundaries = settings.getByRole('list', { name: 'File boundaries' });
    await boundaries.getByRole('button', { name: 'Choose Folder…' }).click();

    await expect(boundaries).toContainText('Scope(read:/tmp/project)');
    await expect(boundaries).toContainText('Scope(write:/mock/handoff-folder)');
    await expect(settings.getByText('Folder handed to Tenon: /mock/handoff-folder')).toBeVisible();
    await expect.poll(async () => {
      const pickCall = (await commandCalls(page)).find((call) => call.cmd === 'agent_pick_scope_folder');
      const settings = pickCall?.args.settings as { grants?: string[]; blocks?: string[]; softBlockAllows?: string[] } | undefined;
      return settings ? {
        grants: settings.grants,
        blocks: settings.blocks,
        softBlockAllows: settings.softBlockAllows,
      } : undefined;
    }).toEqual({ grants: ['Scope(read:/tmp/project)'], blocks: [], softBlockAllows: [] });
  });

  test('shows ignored legacy permission rules as diagnostics', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: /^Security/ }).click();
    const ignoredRules = settings.getByRole('list', { name: 'Ignored JSON rules' });
    await expect(ignoredRules).toBeVisible();
    await expect(ignoredRules.locator('.inset-row', { hasText: 'Action(file.read.outside_allowed_file_area)' })).toContainText('unsupported_grant');
  });

  test('opens agent config from the Agent Profiles list', async ({ page }) => {
    const settings = await openSettings(page);
    const back = settings.getByRole('button', { name: 'Back' });
    const forward = settings.getByRole('button', { name: 'Forward' });
    await settings.getByRole('button', { name: 'Agent Profiles', exact: true }).click();
    await expect(settings.locator('.settings-toolbar-title')).toHaveText('Agent Profiles');
    await expect(settings.getByRole('list', { name: 'Agent profiles' })).toBeVisible();
    await expect(settings.locator('.agent-editor')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Neva' })).toBeVisible();
    await expect(settings.getByRole('switch', { name: 'Toggle assistant' })).toHaveCount(0);
    await expect(settings.getByRole('switch', { name: 'Toggle self' })).toBeVisible();

    await settings.getByRole('button', { name: 'Neva' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_agent_config')?.args;
    }).toMatchObject({ agentId: 'built-in:tenon:assistant' });

    await settings.getByRole('button', { name: 'self', exact: true }).click();
    await expect(settings.locator('.settings-toolbar-title')).toHaveText('Agent Profiles');
    await expect(settings.locator('.agent-editor')).toHaveCount(0);
    await expect(forward).toBeDisabled();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_agent_config')?.args;
    }).toMatchObject({ agentId: 'user:mock:self' });
  });

  test('opens the built-in Tenon agent config: editable Neva profile with Save and no Delete', async ({ page }) => {
    const config = await openAgentConfig(page, 'built-in%3Atenon%3Aassistant');
    // Both the window title and the editor header read "Edit Neva".
    await expect(config.getByRole('heading', { name: 'Edit Neva' }).first()).toBeVisible();
    await expect(config.getByText('Default Tenon assistant profile.')).toBeVisible();
    await expect(config.getByLabel('Name')).toHaveValue('Neva');
    // The one-Neva invariant removed the create surface, so Neva stays fully editable
    // (Provider/model included) and the profile gets a real Save — never a Delete or a
    // Duplicate, both of which would imply a second agent.
    await expect(config.getByLabel('Provider')).toBeEnabled();
    await expect(config.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(config.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await expect(config.getByRole('button', { name: 'Duplicate to my agents' })).toHaveCount(0);
  });

  test('agent profile settings deep links resolve to the Agent Profiles list', async ({ page }) => {
    const settings = await openSettings(page, '&agent=user%3Amock%3Aself');
    await expect(settings.locator('.settings-toolbar-title')).toHaveText('Agent Profiles');
    await expect(settings.locator('.agent-editor')).toHaveCount(0);
    await expect(settings.getByRole('list', { name: 'Agent profiles' })).toBeVisible();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_agent_config')?.args;
    }).toMatchObject({ agentId: 'user:mock:self' });
  });

  test('settings deep links treat agent=create as an ordinary agent id', async ({ page }) => {
    const settings = await openSettings(page, '&category=agents&agent=create');
    await expect(settings.locator('.settings-toolbar-title')).toHaveText('Agent Profiles');
    await expect(settings.locator('.agent-editor')).toHaveCount(0);
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_agent_config')?.args;
    }).toMatchObject({ agentId: 'create' });
  });

  test('lets users view Dream controls and run Dream from Memory settings', async ({ page }) => {
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: /^Memory/ }).click();

    const dreamControls = settings.getByRole('list', { name: 'Dream controls' });
    await expect(dreamControls).toBeVisible();
    await expect(dreamControls).toContainText('Schedule');
    await expect(dreamControls).toContainText('Run Dream now');
    await dreamControls.getByRole('button', { name: 'Run' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_run_dream_now')?.args;
    }).toMatchObject({ limit: 50 });
    await expect(settings.getByText('Dream completed')).toBeVisible();
    await expect(settings.getByRole('list', { name: 'Dream history' })).toBeVisible();
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

test.describe('agent and Channel config windows', () => {
  test('renders the agent config as a titled child window with fixed actions', async ({ page }) => {
    const config = await openAgentConfig(page, 'user%3Amock%3Aself');
    // Both the window title and the editor header read "Edit self".
    await expect(config.getByRole('heading', { name: 'Edit self' }).first()).toBeVisible();
    await expect(config.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(config.getByRole('button', { name: 'Save', exact: true })).toBeVisible();

    const actions = await config.locator('.agent-editor-actions').evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        position: computed.position,
        bottom: computed.bottom,
        left: computed.left,
        right: computed.right,
      };
    });
    expect(actions.position).toBe('fixed');
    expect(Number.parseFloat(actions.bottom)).toBeGreaterThan(0);
    expect(Number.parseFloat(actions.left)).toBeGreaterThan(0);
    expect(Number.parseFloat(actions.right)).toBeGreaterThan(0);
  });

  test('renders the Channel config as a titled child window with fixed actions', async ({ page }) => {
    const config = await openChannelConfig(page, 'lin-agent-channel-planning');
    await expect(config.getByRole('heading', { name: 'Channel settings' })).toBeVisible();
    await expect(config.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(config.getByRole('button', { name: 'Save settings' })).toBeVisible();
    await expect(config.locator('.settings-sheet-avatar .settings-sheet-icon-avatar')).toBeVisible();

    const actions = await config.locator('.settings-sheet-actions').evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        position: computed.position,
        bottom: computed.bottom,
        left: computed.left,
        right: computed.right,
      };
    });
    expect(actions.position).toBe('fixed');
    expect(Number.parseFloat(actions.bottom)).toBeGreaterThan(0);
    expect(Number.parseFloat(actions.left)).toBeGreaterThan(0);
    expect(Number.parseFloat(actions.right)).toBeGreaterThan(0);
  });

  test('uses design-system controls inside the Channel config window', async ({ page }) => {
    const config = await openChannelConfig(page, '', 'create');
    await expect(config.locator('.channel-config-seed.settings-sheet-row-input')).toBeVisible();
    // The one-Neva collapse removed the member roster, so the window is name + seed
    // only — no raw checkboxes, just design-system controls.
    await expect(config.locator('input[type="checkbox"]:not(.agent-settings-checkbox input)')).toHaveCount(0);

    const shadows = await config.locator('.settings-sheet-actions').evaluate((element) => {
      const token = getComputedStyle(document.documentElement).getPropertyValue('--overlay-shadow-level-1').trim();
      const probe = document.createElement('div');
      probe.style.boxShadow = token;
      document.body.appendChild(probe);
      const normalizedToken = getComputedStyle(probe).boxShadow;
      probe.remove();
      return {
        footer: getComputedStyle(element).boxShadow,
        token: normalizedToken,
      };
    });
    expect(shadows.footer).toBe(shadows.token);
  });

});

// The per-provider config window (?surface=provider-config) — a standalone surface
// (in the app, a modal child window). It is connection-only: credentials + endpoint.
// Model and effort now live on the agent profile, never here, so this window has no
// Model or Thinking-level control.
test.describe('provider config window', () => {
  test('renders the saved connection — connection only, no model/reasoning controls', async ({ page }) => {
    const config = await openProviderConfig(page, 'openai');
    await expect(config.getByRole('heading', { name: /OpenAI/ })).toBeVisible();
    await expect(config.getByLabel('API key')).toHaveAttribute('placeholder', /Saved \(encrypted\)/);
    await expect(config.getByLabel('Base URL')).toBeVisible();
    // Model and effort moved to the agent profile — neither control lives here now.
    await expect(config.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
    await expect(config.getByRole('combobox', { name: 'Thinking level' })).toHaveCount(0);
    // A configured provider can be removed from its window.
    await expect(config.getByRole('button', { name: 'Remove provider' })).toBeVisible();
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
    await config.getByLabel('Base URL').fill('https://proxy.example.com/v1');
    await config.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'openai',
        baseUrl: 'https://proxy.example.com/v1',
        enabled: true,
      },
    });
  });
});

async function openSettings(page: Page, extraQuery = '', options: Parameters<typeof installElectronMock>[1] = {}): Promise<Locator> {
  await installElectronMock(page, options);
  await page.goto(`/?surface=settings${extraQuery}`);
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

async function openAgentConfig(
  page: Page,
  agent: string,
  options: Parameters<typeof installElectronMock>[1] = {},
): Promise<Locator> {
  await installElectronMock(page, options);
  await page.goto(`/?surface=agent-config&agent=${agent}`);
  const config = page.locator('.agent-config-window');
  await expect(config).toBeVisible();
  await expect(config.locator('.agent-editor-actions')).toBeVisible();
  return config;
}

async function openChannelConfig(page: Page, conversation: string, mode = 'configure'): Promise<Locator> {
  await installElectronMock(page);
  await page.goto(`/?surface=channel-config&conversation=${conversation}&mode=${mode}`);
  const config = page.locator('.channel-config-window');
  await expect(config).toBeVisible();
  await expect(config.locator('.settings-sheet-actions')).toBeVisible();
  return config;
}
