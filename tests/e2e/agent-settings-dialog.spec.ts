import { expect, test, type Locator, type Page } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

test.describe('agent settings dialog', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('uses modal focus behavior and restores focus on close', async ({ page }) => {
    const { dialog, trigger } = await openSettings(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('separates providers and agent behaviour into categories', async ({ page }) => {
    const { dialog } = await openSettings(page);
    // Providers category is the default and lists connectable providers.
    await expect(dialog.getByRole('heading', { name: 'Providers' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'OpenAI, Active' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Anthropic/ })).toBeVisible();
    // The selected provider's detail pane carries the status badge and key field.
    await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', 'Configured');
    await expect(dialog.getByRole('button', { name: 'Remove key' })).toBeEnabled();
    // Model / reasoning / permission live under the Agent category, not Providers.
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toHaveCount(0);

    await gotoCategory(dialog, 'Agent');
    await expect(dialog.getByRole('heading', { name: 'Model' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Behavior' })).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toBeVisible();
    await expect(dialog.getByLabel('Permission mode')).toBeVisible();
  });

  test('uses the shared checkbox mark for provider enablement', async ({ page }) => {
    const { dialog } = await openSettings(page);
    const enabled = dialog.getByLabel('Enabled');
    const enabledLabel = enabled.locator('xpath=..');
    const mark = enabledLabel.locator('.checkbox-mark');

    await expect(enabled).toBeChecked();
    await expect(mark).toHaveClass(/checked/);
    await expect(mark).toHaveCSS('width', '16px');
    await expect(mark).toHaveCSS('height', '16px');
    await expect(mark).toHaveCSS('border-radius', '3px');

    await enabledLabel.click();

    await expect(enabled).not.toBeChecked();
    await expect(mark).not.toHaveClass(/checked/);
  });

  test('gates model selection behind a key and hides the provider id for known providers', async ({ page }) => {
    const { dialog } = await openSettings(page);

    // A known provider exposes no editable Provider ID — but Base URL is offered
    // as an optional override, defaulted to the provider's endpoint.
    await dialog.locator('.settings-provider-row', { hasText: 'Anthropic' }).click();
    await expect(dialog.getByLabel('Provider ID')).toHaveCount(0);
    await expect(dialog.getByLabel('Base URL')).toHaveAttribute('placeholder', 'https://api.anthropic.com');
    await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', 'Paste key');

    await gotoCategory(dialog, 'Agent');
    await expect(dialog.getByText('Add an API key in Providers before choosing a model.')).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toHaveCount(0);

    await gotoCategory(dialog, 'Providers');
    await dialog.getByLabel('API key').fill('sk-ant-test');
    await gotoCategory(dialog, 'Agent');
    await expect(dialog.getByRole('combobox', { name: 'Model' })).toBeVisible();
  });

  test('filters the provider list by search and keeps Custom reachable', async ({ page }) => {
    const { dialog } = await openSettings(page);
    await dialog.getByLabel('Search providers').fill('anth');
    await expect(dialog.getByRole('button', { name: /Anthropic/ })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'OpenAI, Active' })).toHaveCount(0);
    // The custom entry is pinned outside the filtered list.
    await expect(dialog.getByRole('button', { name: /Custom provider/ })).toBeVisible();
  });

  test('toggles API key visibility', async ({ page }) => {
    const { dialog } = await openSettings(page);
    const key = dialog.getByLabel('API key');
    await expect(key).toHaveAttribute('type', 'password');

    await dialog.getByRole('button', { name: 'Show key' }).click();
    await expect(key).toHaveAttribute('type', 'text');

    await dialog.getByRole('button', { name: 'Hide key' }).click();
    await expect(key).toHaveAttribute('type', 'password');
  });

  test('reveals connection fields only for a custom provider', async ({ page }) => {
    const { dialog } = await openSettings(page);
    await dialog.locator('.settings-provider-row', { hasText: 'Custom' }).click();

    await dialog.getByLabel('Provider ID').fill('my-proxy');
    await dialog.getByLabel('Base URL').fill('https://example.test/v1');
    await dialog.getByLabel('API key').fill('sk-test');

    await gotoCategory(dialog, 'Agent');
    await dialog.getByRole('textbox', { name: 'Model' }).fill('custom-model');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'my-proxy',
        modelId: 'custom-model',
        baseUrl: 'https://example.test/v1',
        enabled: true,
      },
    });
  });

  test('saves the active provider model and reasoning', async ({ page }) => {
    const { dialog } = await openSettings(page);
    await gotoCategory(dialog, 'Agent');
    await dialog.getByLabel('Reasoning').selectOption('high');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

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

  test('saves agent behavior settings', async ({ page }) => {
    const { dialog } = await openSettings(page);
    await gotoCategory(dialog, 'Agent');
    await dialog.getByLabel('Permission mode').selectOption('restricted');
    await dialog.getByText('Automatic skills').click();
    await dialog.getByText('Slash skills').click();
    await dialog.getByText('Compact command').click();
    await dialog.getByLabel('Additional skill directories').fill('~/skills, .agents/team-skills');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_update_runtime_settings')?.args;
    }).toMatchObject({
      settings: {
        permissionMode: 'restricted',
        automaticSkillsEnabled: false,
        slashSkillsEnabled: false,
        compactEnabled: false,
        additionalSkillDirectories: ['~/skills', '.agents/team-skills'],
      },
    });
  });
});

async function gotoCategory(dialog: Locator, name: 'Providers' | 'Agent') {
  await dialog.locator('.settings-nav-item', { hasText: name }).click();
}

async function openSettings(page: Page) {
  const trigger = page.locator('.top-chrome-right').getByRole('button', { name: 'More', exact: true });
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}
