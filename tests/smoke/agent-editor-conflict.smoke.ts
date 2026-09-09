import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { parse } from 'jsonc-parser';
import type { AgentEditorView } from '../../src/core/types';
import { openConfiguration } from './configurationHelpers';
import { closeSmokeApp, launchSmokeApp } from './electronApp';

for (const layer of ['user', 'project'] as const) {
  test(`Agent editor retries a ${layer} source conflict without losing the draft or unrelated bytes`, async ({}, testInfo) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'agent-'));
    mkdirSync(join(userDataDir, 'config'));
    writeFileSync(join(userDataDir, 'config/settings.jsonc'), '{"appearance":{"language":"en"}}');
    const smoke = await launchSmokeApp({ userDataDir });
    try {
      const page = await openConfiguration(smoke, 'agents');
      const view = await page.evaluate(() => window.lin!.invoke('agent_identity_catalog', {}) as Promise<AgentEditorView>);
      const path = view.sources.find((source) => source.layer === layer)!.path;
      // Both configuration layers must belong to this throwaway Electron instance.
      expect(path.startsWith(`${userDataDir}${sep}`)).toBe(true);
      mkdirSync(dirname(path), { recursive: true });
      const original = JSON.stringify({
        presentationOverrides: { main: { persona: 'Baseline' } },
        profiles: { default: { developerInstructions: 'Before', model: 'inherit' } },
      }, null, 2);
      writeFileSync(path, original);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const row = page.getByRole('list', { name: 'Built-in agents' });
      await expect(row).toContainText('Baseline');
      await row.getByRole('button').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: 'Apply to', exact: true }).selectOption(layer);
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Juniper');
      await dialog.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep my draft.');
      const save = dialog.getByRole('button', { name: 'Save', exact: true });

      const external = `${original.replace('Before', 'External instructions.')}\n// Keep this external comment.\n`;
      writeFileSync(path, external);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await save.click();
      await expect(dialog.getByRole('alert')).toContainText('Save again');
      await expect(dialog.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep my draft.');
      await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Juniper');
      expect(readFileSync(path, 'utf8')).toBe(external);
      await dialog.screenshot({ path: testInfo.outputPath(`agent-${layer}-conflict.png`) });

      // A second edit after the refresh must reject again, not silently overwrite.
      const newer = `${external}// Keep this later comment too.\n`;
      writeFileSync(path, newer);
      await save.click();
      await expect(save).toBeEnabled();
      await expect(dialog.getByRole('alert')).toContainText('Save again');
      expect(readFileSync(path, 'utf8')).toBe(newer);
      await save.click();
      await expect(dialog).toHaveCount(0);
      const saved = readFileSync(path, 'utf8');
      expect(saved).toContain('// Keep this external comment.');
      expect(saved).toContain('// Keep this later comment too.');
      expect(saved).toContain('"model": "inherit"');
      expect(parse(saved)).toMatchObject({
        presentationOverrides: { main: { persona: 'Juniper' } },
        profiles: { default: { developerInstructions: 'Keep my draft.', model: 'inherit' } },
      });
      await row.getByRole('button').first().click();
      await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep my draft.');
    } finally {
      await closeSmokeApp(smoke);
    }
  });
}
