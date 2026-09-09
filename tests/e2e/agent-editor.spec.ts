import { expect, test } from '@playwright/test';
import { getMessages } from '../../src/core/i18n';
import { installElectronMock } from './outlinerMock';

for (const locale of ['en', 'zh-Hans'] as const) {
  for (const colorScheme of ['light', 'dark'] as const) {
    for (const scale of ['100%', '200%']) {
      test(`Agent editor keeps actions reachable with long catalogs in ${locale}, ${colorScheme}, ${scale}`, async ({ page }, testInfo) => {
        await installElectronMock(page, { initialLanguage: locale });
        await page.setViewportSize({ width: 680, height: 720 });
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce', contrast: scale === '200%' ? 'more' : 'no-preference' });
        await page.goto('/?surface=settings&destination=agents');
        await page.evaluate((fontScale) => {
          document.documentElement.style.setProperty('--font-scale', fontScale);
          const original = window.lin!.invoke;
          window.lin!.invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
            const result = await original<T>(command, args);
            if (command !== 'agent_identity_catalog') return result;
            const view = result as unknown as { capabilities: { tools: { key: string; description: string }[] } };
            view.capabilities.tools = Array.from({ length: 30 }, (_, index) => ({ key: `custom_tool_${index}`, description: `Tool ${index}` }));
            return result;
          };
        }, scale);
        const copy = getMessages(locale).settings.agents;
        // Refresh the projection after installing the large-catalog fixture.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => page.evaluate(async () => (await window.lin!.invoke<{ capabilities: { tools: unknown[] } }>('agent_identity_catalog')).capabilities.tools.length)).toBe(30);
        await page.getByRole('list', { name: copy.builtInAriaLabel }).getByRole('button', { name: copy.editAction, exact: true }).click();
        const dialog = page.getByRole('dialog');
        const save = dialog.getByRole('button', { name: copy.save, exact: true });
        await expect(save).toBeInViewport();
        await expect(dialog.getByRole('checkbox')).toHaveCount(0);
        await expect(dialog.getByRole('combobox', { name: copy.skills, exact: true })).toHaveValue('default');
        await dialog.screenshot({ path: testInfo.outputPath('default.png') });
        await dialog.getByRole('combobox', { name: copy.tools, exact: true }).selectOption('custom');
        await expect(dialog.getByRole('checkbox')).toHaveCount(30);
        await dialog.getByRole('checkbox', { name: 'custom_tool_29', exact: true }).scrollIntoViewIfNeeded();
        await expect(save).toBeInViewport();
        const search = dialog.getByRole('searchbox', { name: copy.searchCapabilities({ name: copy.tools }) });
        await search.fill('custom_tool_29');
        await search.press('Enter');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('checkbox')).toHaveCount(1);
        const overflow = await dialog.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
        expect(overflow).toBe(false);
        await expect(save).toBeInViewport();
        await dialog.screenshot({ path: testInfo.outputPath('custom.png') });
      });
    }
  }
}

test('Agent Save owns pending input and preserves a rejected draft', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=settings&destination=agents');
  await page.getByRole('list', { name: 'Built-in agents' }).getByRole('button', { name: 'Edit…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Juniper');
  await page.evaluate(() => {
    const original = window.lin!.invoke;
    const state = window as unknown as { failAgentSave: () => void; agentSaveCount: number };
    state.agentSaveCount = 0;
    window.lin!.invoke = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'agent_write_profile' && ++state.agentSaveCount === 1) {
        await new Promise<void>((_resolve, reject) => { state.failAgentSave = () => reject(new Error('Unable to save agent')); });
      }
      return original<T>(command, args);
    };
  });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.locator('.confirm-dialog-backdrop').click({ position: { x: 2, y: 2 } });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as unknown as { failAgentSave: () => void }).failAgentSave());
  await expect(dialog.getByRole('alert')).toHaveText('Unable to save agent');
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Juniper');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { agentSaveCount: number }).agentSaveCount)).toBe(2);
});
