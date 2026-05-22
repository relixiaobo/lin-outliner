import { expect, test } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

test.describe('agent settings dialog', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('uses modal focus behavior and restores focus on close', async ({ page }) => {
    const { dialog, trigger } = await openAgentSettings(page);
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

  test('uses the shared checkbox mark for provider enablement', async ({ page }) => {
    const { dialog } = await openAgentSettings(page);
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

  test('groups provider, connection, and model settings', async ({ page }) => {
    const { dialog } = await openAgentSettings(page);
    await expect(dialog.getByRole('heading', { name: 'Provider' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Connection' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Model behavior' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Agent behavior' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'OpenAI Active gpt-5.4' })).toBeVisible();
    await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', 'Configured');
    await expect(dialog.getByRole('button', { name: 'Remove key' })).toBeEnabled();
  });

  test('only exposes model controls after the selected provider has a key', async ({ page }) => {
    const { dialog } = await openAgentSettings(page);
    await expect(dialog.getByRole('button', { name: /Anthropic/ })).toHaveCount(0);

    await dialog.getByLabel('Provider ID').fill('anthropic');

    await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', 'Paste key');
    await expect(dialog.getByLabel('Model ID')).toHaveCount(0);
    await expect(dialog.getByText('Add an API key for this provider before choosing a model.')).toBeVisible();

    await dialog.getByLabel('API key').fill('sk-ant-test');
    await expect(dialog.getByLabel('Model ID')).toBeVisible();
  });

  test('saves grouped provider configuration', async ({ page }) => {
    const { dialog } = await openAgentSettings(page);
    await dialog.getByLabel('Base URL').fill('https://example.test/v1');
    await dialog.getByLabel('Reasoning').selectOption('high');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => {
      const calls = await commandCalls(page);
      return calls.findLast((call) => call.cmd === 'agent_upsert_provider_config')?.args;
    }).toMatchObject({
      provider: {
        providerId: 'openai',
        modelId: 'gpt-5.4',
        reasoningLevel: 'high',
        baseUrl: 'https://example.test/v1',
        enabled: true,
      },
    });
  });

  test('saves agent behavior settings', async ({ page }) => {
    const { dialog } = await openAgentSettings(page);
    await dialog.getByLabel('Permission mode').selectOption('restricted');
    await dialog.getByText('Automatic skills').click();
    await dialog.getByText('Slash skills').click();
    await dialog.getByText('Compact command').click();
    await dialog.getByLabel('Additional skill directories').fill('~/skills, .agents/team-skills');
    await dialog.getByRole('button', { name: 'Save' }).click();

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

async function openAgentSettings(page: import('@playwright/test').Page) {
  const trigger = page.locator('.top-chrome-right').getByRole('button', { name: 'More', exact: true });
  await trigger.click();
  await page.getByRole('menuitem', { name: 'Provider settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}
