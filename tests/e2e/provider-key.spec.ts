import { expect, test } from '@playwright/test';
import { clipboardText, commandCalls, installElectronMock } from './outlinerMock';

const savedKey = `sk-ant-${'x'.repeat(96)}abcd`;

for (const colorScheme of ['light', 'dark'] as const) {
  test(`long saved keys keep both ends, exact length and inset controls in ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 520, height: 368 });
    await page.emulateMedia({ colorScheme });
    await installElectronMock(page, { savedProviderApiKeys: { openai: savedKey } });
    await page.goto('/?surface=provider-config&provider=openai');
    const field = page.getByLabel('API key');
    const preview = page.locator('.settings-sheet-key-preview');
    await expect(preview).toHaveText(`sk-a${'•'.repeat(99)}abcd`);
    await expect(page.getByText('107 characters', { exact: true })).toBeVisible();
    await expect(field).toHaveValue('');
    expect((await commandCalls(page)).filter((call) => call.cmd === 'lin:get-provider-api-key').every((call) => call.args?.mode === 'preview')).toBe(true);
    for (const scale of ['100%', '200%']) {
      await page.evaluate((value) => document.documentElement.style.setProperty('--font-scale', value), scale);
      const input = (await field.boundingBox())!;
      const actions = (await page.locator('.settings-sheet-key-controls').boundingBox())!;
      expect(actions.x).toBeGreaterThan(input.x);
      expect(actions.x + actions.width).toBeLessThan(input.x + input.width);
      expect(actions.y).toBeGreaterThanOrEqual(input.y);
      expect(actions.y + actions.height).toBeLessThanOrEqual(input.y + input.height);
      const tail = (await preview.locator('span').last().boundingBox())!;
      expect(tail.x + tail.width).toBeLessThanOrEqual(actions.x);
      expect(await page.locator('.settings-sheet-body').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`saved-key-${colorScheme}-${scale}.png`) });
    }
    await field.focus();
    await field.press('Tab');
    await expect(page.getByRole('button', { name: 'Show key', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue(savedKey);
    await page.getByRole('button', { name: 'Hide key', exact: true }).click();
    await expect(field).toHaveValue('');
    await page.getByRole('button', { name: 'Copy key', exact: true }).click();
    await expect.poll(() => clipboardText(page)).toBe(savedKey);
    await expect(page.getByText('Key copied')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByText('Advanced', { exact: true }).click();
    await page.getByLabel('Base URL').fill('https://proxy.example.com/v1');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await commandCalls(page)).some((call) => call.cmd === 'agent_set_provider_api_key')).toBe(false);
  });
}

test('a revealed saved key can be replaced directly and the mask never becomes the draft', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=provider-config&provider=openai');
  const field = page.getByLabel('API key');
  await page.getByRole('button', { name: 'Show key', exact: true }).click();
  await expect(field).toHaveValue('sk-openai-saved');
  await field.fill('sk-replacement-key');
  await expect(page.getByText('18 characters', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide key', exact: true }).click();
  await expect(page.locator('.settings-sheet-key-preview')).toHaveText('sk-r••••••••••-key');
  await page.getByRole('button', { name: 'Copy key', exact: true }).click();
  await expect.poll(() => clipboardText(page)).toBe('sk-replacement-key');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await commandCalls(page)).findLast((call) => call.cmd === 'agent_set_provider_api_key')?.args)
    .toMatchObject({ providerId: 'openai', apiKey: 'sk-replacement-key' });
});

test('clearing the displayed key retains the saved credential without enabling Save', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=provider-config&provider=openai');
  await page.getByRole('button', { name: 'Show key', exact: true }).click();
  await expect(page.getByLabel('API key')).toHaveValue('sk-openai-saved');
  await page.getByLabel('API key').fill('');
  await expect(page.locator('.settings-sheet-key-preview')).toHaveText('sk-•••••••••ved');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect((await commandCalls(page)).some((call) => call.cmd === 'agent_set_provider_api_key')).toBe(false);
});

test('a failed preview falls back to saved-key text without reading or changing the credential', async ({ page }) => {
  await installElectronMock(page);
  await page.addInitScript(() => {
    const original = window.lin!.getProviderApiKey;
    window.lin!.getProviderApiKey = async (providerId, mode) => {
      if (mode === 'preview') throw new Error('Preview unavailable');
      return original(providerId, mode);
    };
  });
  await page.goto('/?surface=provider-config&provider=openai');
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', 'Saved key');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect((await commandCalls(page)).some((call) => call.cmd === 'lin:get-provider-api-key')).toBe(false);
  await page.getByRole('button', { name: 'Show key', exact: true }).click();
  await expect(page.getByLabel('API key')).toHaveValue('sk-openai-saved');
  await expect(page.getByText('15 characters', { exact: true })).toBeVisible();
});
