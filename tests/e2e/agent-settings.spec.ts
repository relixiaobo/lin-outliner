import { expect, test, type Locator, type Page } from '@playwright/test';
import { clipboardText, commandCalls, installElectronMock } from './outlinerMock';

// Domain editors share one Settings window and keep their own state.
test.describe('configuration panes', () => {
  test('searches and records shortcuts in the dedicated editor', async ({ page }) => {
    const settings = await openSettings(page, '&destination=shortcuts');
    await expect(settings.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible();
    await expect(settings.getByRole('switch')).toHaveCount(0);
    await expect(settings.locator('.settings-chip, .inset-row-code')).toHaveCount(0);
    await expect(settings.getByRole('list', { name: 'System-wide' })).toBeVisible();

    const search = settings.locator('.configuration-toolbar').getByRole('searchbox', { name: 'Search shortcuts' });
    await search.fill('translation');
    await expect(settings.getByText('Toggle page translation', { exact: true })).toBeVisible();
    await expect(settings.getByText('Open page in new pane', { exact: true })).toHaveCount(0);

    await search.fill('global.open_page_in_pane');
    await expect(settings.getByText('Open page in new pane', { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Change CommandOrControl+M', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add an alternate for Open page in new pane' }).click();
    await page.keyboard.press('Control+P');
    await expect(settings.getByRole('button', { name: 'Change Control+P' })).toBeVisible();

    for (const shortcut of ['Control+P', 'CommandOrControl+M']) {
      const key = settings.getByRole('button', { name: `Change ${shortcut}`, exact: true });
      await key.dblclick();
      await key.press('Backspace');
    }
    const empty = settings.getByRole('button', { name: 'Set shortcut for Open page in new pane', exact: true });
    await expect(empty).toHaveText('None');
    await empty.dblclick();
    await empty.press('Control+Alt+K');
    await expect(settings.getByRole('button', { name: 'Change Control+Alt+K', exact: true })).toBeVisible();
    await expect(settings.getByRole('checkbox')).toHaveCount(0);
    await expect(settings.locator('.settings-shortcut-row .settings-row-menu-trigger')).toHaveCount(0);
  });

  test('shortcut toolbar follows the active pane and retains its local filter', async ({ page }) => {
    const settings = await openSettings(page, '&destination=shortcuts');
    const toolbar = settings.locator('.configuration-toolbar');
    const localSearch = toolbar.getByRole('searchbox', { name: 'Search shortcuts' });
    await expect(localSearch).toBeVisible();
    await expect(settings.getByRole('tabpanel', { name: 'Keyboard Shortcuts', exact: true }).getByRole('searchbox')).toHaveCount(0);
    await expect(settings.locator('.settings-toolbar-actions')).toHaveCSS('-webkit-app-region', 'no-drag');
    await expect(toolbar.getByRole('button', { name: 'Shortcut options' })).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Open Keybindings File' })).toHaveCount(0);
    await localSearch.fill('translation');
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    await expect(toolbar.getByRole('searchbox')).toHaveCount(0);
    await expect(toolbar.locator('.settings-row-menu-trigger')).toHaveCount(0);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await settings.getByRole('tab', { name: 'Keyboard Shortcuts', exact: true }).click();
    await expect(localSearch).toHaveValue('translation');
    await expect(settings.getByText('Open page in new pane', { exact: true })).toHaveCount(0);
    await localSearch.press('Control+f');
    const globalSearch = settings.getByRole('searchbox', { name: 'Search Settings', exact: true });
    await expect(globalSearch).toBeFocused();
    await globalSearch.fill('appearance');
    await expect(toolbar.getByRole('searchbox')).toHaveCount(0);
    await globalSearch.press('Escape');
    await expect(localSearch).toHaveValue('translation');
    await expect(globalSearch).toBeFocused();
  });

  test('leaving the shortcut recorder releases keys to the current pane', async ({ page }) => {
    const settings = await openSettings(page, '&destination=shortcuts');
    await settings.getByRole('button', { name: 'Change CommandOrControl+M', exact: true }).dblclick();
    await expect(settings.locator('.settings-shortcut-key.is-recording')).toBeFocused();
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    await settings.getByRole('searchbox', { name: 'Search Settings' }).fill('appearance');
    await expect(settings.getByRole('searchbox', { name: 'Search Settings' })).toHaveValue('appearance');
    await settings.getByRole('tab', { name: 'Keyboard Shortcuts', exact: true }).click();
    await expect(settings.locator('.settings-shortcut-key.is-recording')).toHaveCount(0);
    await expect(settings.getByRole('button', { name: 'Change CommandOrControl+M', exact: true })).toBeVisible();
  });

  test('shortcut text requires deliberate editing and supports keyboard activation', async ({ page }) => {
    const settings = await openSettings(page, '&destination=shortcuts');
    const shortcut = settings.getByRole('button', { name: 'Change CommandOrControl+M', exact: true });
    await expect(shortcut).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(shortcut).toHaveCSS('box-shadow', 'none');
    await shortcut.click();
    await expect(settings.locator('.settings-shortcut-key.is-recording')).toHaveCount(0);
    for (const activation of ['Enter', 'Space']) {
      await shortcut.press(activation);
      await expect(shortcut).toHaveClass(/is-recording/);
      await expect(shortcut).toBeFocused();
      await shortcut.press('Escape');
      await expect(settings.locator('.settings-shortcut-key.is-recording')).toHaveCount(0);
    }
    await shortcut.dblclick();
    await expect(shortcut).toHaveClass(/is-recording/);
    await shortcut.press('Control+Alt+J');
    await expect(settings.getByRole('button', { name: 'Change Control+Alt+J', exact: true })).toBeVisible();
    await expect(settings.locator('.settings-shortcut-key.is-recording')).toHaveCount(0);
    const changed = settings.getByRole('button', { name: 'Change Control+Alt+J', exact: true });
    await changed.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Reset Open page in new pane', exact: true }).click();
    await expect(shortcut).toBeVisible();
    await shortcut.dblclick();
    await shortcut.press('Tab');
    await expect(settings.locator('.settings-shortcut-key.is-recording')).toHaveCount(0);
    await expect(shortcut).toBeVisible();
  });

  for (const [colorScheme, width] of [['light', 560], ['dark', 900]] as const) {
    test(`keeps the shortcut editor contained at ${width}px in ${colorScheme} mode`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 720 });
      const settings = await openSettings(page, '&destination=shortcuts');
      await expect(settings.getByRole('list', { name: 'Application' })).toBeVisible();
      expect(await settings.locator('.configuration-content:visible').evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      )).toBe(true);
      await settings.screenshot({ path: testInfo.outputPath(`keyboard-shortcuts-${colorScheme}-${width}.png`) });
    });
  }

  // Runs against the real bundled CHANGELOG.md, so this is the case that would
  // catch the convention breaking in the file itself — the mocked build is 0.1.0
  // and that section must carry a note. Asserted structurally: the note's wording
  // is main-agent-owned prose, and pinning the `main` e2e signal to it would turn
  // the run red for an editorial change in a file this PR does not own.
  test('shows the release note in user language and copies the running version information', async ({ page }) => {
    const settings = await openSettings(page, '&destination=about');

    await expect(settings.getByRole('heading', { name: 'About' })).toBeVisible();
    await expect(settings.getByText('Version 0.1.0', { exact: true })).toBeVisible();
    // The group names the running version; the changelog's own `Unreleased` /
    // development-train vocabulary never reaches the pane.
    const whatsNew = settings.getByRole('list', { name: 'What’s new in 0.1.0' });
    await expect(whatsNew).toBeVisible();
    await expect(settings.getByText('Unreleased')).toHaveCount(0);
    await expect(settings.locator('select')).toHaveCount(0);

    // The note reads inline — nothing to expand, and no engineering category.
    const note = whatsNew.locator('.settings-about-release-note');
    await expect(note).toBeVisible();
    expect((await note.innerText()).trim().length).toBeGreaterThan(0);
    await expect(whatsNew.getByRole('button', { expanded: false })).toHaveCount(0);
    await expect(whatsNew.getByRole('heading', { name: 'Added' })).toHaveCount(0);
    await expect(whatsNew.getByRole('heading', { name: 'Fixed' })).toHaveCount(0);
    await expect(whatsNew.getByRole('heading', { name: 'Internal' })).toHaveCount(0);

    // The full ledger is one link away, pinned to the tag this build shipped as.
    await whatsNew.getByRole('button', { name: 'Full changelog' }).click();
    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'open_external_url')?.args;
    }).toMatchObject({ url: expect.stringContaining('/blob/v0.1.0/CHANGELOG.md#') });

    await settings.getByRole('button', { name: 'Copy version info' }).click();
    await expect.poll(() => clipboardText(page)).toContain('Tenon 0.1.0\ndarwin arm64');
  });



  test('keeps scrolled content below the fixed toolbar chrome', async ({ page }) => {
    const settings = await openSettings(page);
    const toolbarBox = await settings.locator('.configuration-toolbar').boundingBox();
    const contentBox = await settings.locator('.configuration-content:visible').boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(contentBox!.y).toBeGreaterThanOrEqual(toolbarBox!.y + toolbarBox!.height);

    await settings.locator('.configuration-content:visible').evaluate((element) => {
      element.scrollTop = 240;
    });
    const scrolledContentBox = await settings.locator('.configuration-content:visible').boundingBox();
    expect(scrolledContentBox!.y).toBeCloseTo(contentBox!.y, 1);
  });

  // The Memory group raised a red alert on every run until the mock grew the
  // memory channels: an unhandled invoke throws, MemoryManager catches it
  // into the shared alert, and its 5s poll re-fired it forever. Nothing asserted
  // the pane was error-free, so it went unnoticed — including by the
  // design-system probes, which photograph it and pass regardless. The wait
  // covers the poll, so a regression cannot hide in the gap before it fires.
  // Memory lives in Agent now, so that is where this belongs.


  test('opens the conversation Agent editor from its deep link', async ({ page }) => {
    const settings = await openSettings(page, '&destination=agents');
    const agents = settings.getByRole('list', { name: 'Built-in agents' });

    await expect(agents.getByText('Aspen')).toBeVisible();
    await expect(agents.getByText('The agent you talk to')).toBeVisible();
    await agents.getByRole('button', { name: 'Edit…', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Instructions' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible();
    const colours = dialog.getByRole('radiogroup', { name: 'Colour' });
    const current = colours.locator('[aria-checked="true"]');
    await current.focus();
    const before = await current.getAttribute('aria-label');
    await page.keyboard.press('ArrowRight');
    await expect(current).toBeFocused();
    expect(await current.getAttribute('aria-label')).not.toBe(before);
    await page.keyboard.press('ArrowLeft');
    await expect(current).toHaveAttribute('aria-label', before!);
  });

  test('the conversation agent owns its standing instructions and the ceiling', async ({ page }) => {
    const settings = await openSettings(page, '&destination=agents');

    await settings.getByRole('button', { name: /Aspen/ }).click();
    const dialog = page.getByRole('dialog');
    // No type, no "use it for": there is one of it and the reader is talking to
    // it. What it has is standing instructions and the capability ceiling.
    await expect(dialog.getByRole('textbox', { name: 'Instructions' })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Type' })).toHaveCount(0);
    await expect(dialog.getByText('the ceiling for every agent')).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'How this agent runs' })).toHaveCount(0);

    await dialog.getByRole('textbox', { name: 'Instructions' }).fill('Always answer in Chinese.');
    // Clicking the row, which is what a user does: the native box is visually
    // hidden behind the styled mark and the whole label is the target.
    await dialog.locator('.agent-capability-item', { hasText: 'bash' }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await settings.getByRole('button', { name: /Aspen/ }).click();
    const reopened = page.getByRole('dialog');
    // Round-trips: what was written is what the editor seeds from next time.
    await expect(reopened.getByRole('textbox', { name: 'Instructions' }))
      .toHaveValue('Always answer in Chinese.');
    await expect(reopened.getByRole('checkbox', { name: 'bash' })).not.toBeChecked();
    await expect(reopened.getByRole('checkbox', { name: 'file_read' })).toBeChecked();
  });

  for (const colorScheme of ['light', 'dark'] as const) {
  }



  for (const colorScheme of ['light', 'dark'] as const) {
    test(`shows passive diagnostics actions in Advanced settings in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      const settings = await openSettings(page);
      await settings.page().goto('/?surface=settings&destination=diagnostics');
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

  // A project Skill row exposes its source and enable state without inventing an
  // approval step that does not exist in the runtime.
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
    await settings.page().goto('/?surface=settings&destination=access');
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
      await settings.page().goto('/?surface=settings&destination=access');
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
    await settings.page().goto('/?surface=settings&destination=access');
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
    await expect(openaiSwitch).toBeChecked();

    await openaiSwitch.click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'openai',
        enabled: false,
      },
      probeConnection: false,
    });
    await expect(openaiSwitch).not.toBeChecked();
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
      probeConnection: false,
    });
    await expect(openaiSwitch).toBeChecked();
    await expect(settings.getByText('Provider enabled')).toBeVisible();
  });

  test('settles an accepted provider operation while another pane is visible and preserves scroll', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 480 });
    const settings = await openSettings(page);
    await expect(settings.getByRole('switch', { name: 'Enable or disable OpenAI' })).toBeChecked();
    await page.evaluate(() => {
      const original = window.lin!.invoke;
      window.lin!.invoke = async (command, args) => {
        if (command === 'agent_upsert_provider_config') await new Promise<void>((resolve) => { (window as any).__releaseProviderWrite = resolve; });
        return original(command, args);
      };
    });
    await settings.getByRole('switch', { name: 'Enable or disable OpenAI' }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseProviderWrite)).toBe('function');
    const content = page.locator('#settings-pane-models');
    const scroll = await content.evaluate((element) => { element.scrollTop = 240; return element.scrollTop; });
    expect(scroll).toBeGreaterThan(0);
    await settings.getByRole('tab', { name: 'General', exact: true }).click();
    await expect(settings.getByRole('switch', { name: 'Enable or disable OpenAI' })).toHaveCount(0);
    await page.evaluate(() => (window as any).__releaseProviderWrite());
    await expect.poll(async () => (await commandCalls(page)).some((call) => call.cmd === 'agent_upsert_provider_config')).toBe(true);
    await settings.getByRole('tab', { name: 'Models', exact: true }).click();
    expect(await content.evaluate((element) => element.scrollTop)).toBe(scroll);
    await expect(settings.getByRole('switch', { name: 'Enable or disable OpenAI' })).not.toBeChecked();
    await expect(settings.getByText('Provider disabled')).toBeVisible();
  });

  test('enables detected CC Switch directly from the provider list', async ({ page }) => {
    const settings = await openSettings(page);
    await openServicesPage(settings);
    const ccSwitch = settings.getByRole('switch', { name: 'Enable or disable CC Switch' });
    await expect(ccSwitch).not.toBeChecked();

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
      probeConnection: false,
    });
    await expect(settings.getByRole('button', { name: 'CC Switch, Ready' })).toBeVisible();
    await expect(settings.getByRole('switch', { name: 'Enable or disable CC Switch' })).toBeChecked();
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
      probeConnection: true,
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
      probeConnection: true,
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
      probeConnection: true,
    });
  });
});

async function openServicesPage(settings: Locator): Promise<void> {
  await settings.page().goto('/?surface=settings&destination=models');
  await expect(settings.getByRole('list', { name: 'Providers to add' })).toBeVisible();
}
async function openSkillsPage(settings: Locator): Promise<void> {
  await settings.page().goto('/?surface=settings&destination=skills');
}

async function openSettings(page: Page, extraQuery = '', options: Parameters<typeof installElectronMock>[1] = {}): Promise<Locator> {
  await installElectronMock(page, options);
  await page.goto(`/?surface=${extraQuery.includes('destination=about') ? 'about' : 'settings'}${extraQuery || '&destination=models'}`);
  const settings = page.locator('.configuration-window');
  await expect(settings).toBeVisible();
  // Wait for the provider-backed rows when a spec needs loaded settings data.
  // Window chrome and category navigation render before this fetch resolves.
  await expect(settings.getByRole('listitem').first()).toBeVisible();
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
