import { expect, test } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

test.describe('agent settings dialog', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('uses modal focus behavior and restores focus on close', async ({ page }) => {
    const trigger = page.getByRole('button', { name: 'Agent settings' });
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Agent settings' });
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
    await page.getByRole('button', { name: 'Agent settings' }).click();

    const dialog = page.getByRole('dialog', { name: 'Agent settings' });
    const enabled = dialog.getByLabel('Enabled');
    const mark = dialog.locator('.agent-settings-checkbox .checkbox-mark');

    await expect(enabled).toBeChecked();
    await expect(mark).toHaveClass(/checked/);

    await dialog.getByText('Enabled').click();

    await expect(enabled).not.toBeChecked();
    await expect(mark).not.toHaveClass(/checked/);
  });

  test('groups provider, connection, and model settings', async ({ page }) => {
    await page.getByRole('button', { name: 'Agent settings' }).click();

    const dialog = page.getByRole('dialog', { name: 'Agent settings' });
    await expect(dialog.getByRole('heading', { name: 'Provider' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Connection' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Model behavior' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'OpenAI Active gpt-5.4' })).toBeVisible();
    await expect(dialog.getByLabel('API key')).toHaveAttribute('placeholder', 'Configured');
    await expect(dialog.getByRole('button', { name: 'Remove key' })).toBeEnabled();
  });

  test('saves grouped provider configuration', async ({ page }) => {
    await page.getByRole('button', { name: 'Agent settings' }).click();

    const dialog = page.getByRole('dialog', { name: 'Agent settings' });
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
});
