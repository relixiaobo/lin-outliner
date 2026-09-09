import { expect, test } from '@playwright/test';
import { commandCalls, installElectronMock } from './outlinerMock';

test('saves the selected default model and displays it when Models is reopened', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=settings&destination=models');
  const select = page.getByRole('combobox', { name: 'Default text model', exact: true });
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('');
  for (const value of ['openai/gpt-5.4', 'openai/gpt-5.4-mini', '']) {
    await select.selectOption(value);
    await expect.poll(async () => (await commandCalls(page))
      .findLast((call) => call.cmd === 'agent_update_model_default')?.args)
      .toEqual({ defaultModel: value || null });
    await expect(select).toHaveValue(value);
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    await page.getByRole('tab', { name: 'Models', exact: true }).click();
    await expect(select).toHaveValue(value);
  }
});

test('queued default model changes retain each choice while a save is pending', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=settings&destination=models');
  const select = page.getByRole('combobox', { name: 'Default text model', exact: true });
  await expect(select).toBeEnabled();
  await page.evaluate(() => {
    const original = window.lin!.invoke;
    let first = true;
    window.lin!.invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'agent_update_model_default' && first) {
        first = false;
        await new Promise<void>((resolve) => { Object.assign(window, { releaseModelSave: resolve }); });
      }
      return original<T>(command, args);
    };
  });
  await select.selectOption('openai/gpt-5.4');
  await select.selectOption('openai/gpt-5.4-mini');
  await page.evaluate(() => (window as unknown as { releaseModelSave: () => void }).releaseModelSave());
  await expect.poll(async () => (await commandCalls(page))
    .filter((call) => call.cmd === 'agent_update_model_default').map((call) => call.args))
    .toEqual([{ defaultModel: 'openai/gpt-5.4' }, { defaultModel: 'openai/gpt-5.4-mini' }]);
  await expect(select).toHaveValue('openai/gpt-5.4-mini');
});

test('a failed default model save keeps the stored selection and allows retry', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=settings&destination=models');
  const select = page.getByRole('combobox', { name: 'Default text model', exact: true });
  await expect(select).toBeEnabled();
  await page.evaluate(() => {
    const original = window.lin!.invoke;
    let first = true;
    window.lin!.invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'agent_update_model_default' && first) {
        first = false;
        throw new Error('Unable to save default model');
      }
      return original<T>(command, args);
    };
  });
  await select.selectOption('openai/gpt-5.4');
  await expect(page.getByRole('alert')).toContainText('Unable to save default model');
  await expect(select).toHaveValue('');
  await select.selectOption('openai/gpt-5.4');
  await expect(select).toHaveValue('openai/gpt-5.4');
  await expect(page.getByRole('alert')).toHaveCount(0);
});
