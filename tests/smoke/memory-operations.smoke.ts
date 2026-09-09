import { expect, test, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openConfiguration } from './configurationHelpers';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

test('real Memory transport, file application, native review target, navigation and durable Reset', async ({}, testInfo) => {
  const userDataDir = await mkdtemp('/tmp/tenon-memory-smoke-');
  await mkdir(join(userDataDir, 'config'));
  const config = join(userDataDir, 'config/settings.jsonc');
  await writeFile(config, '// Memory smoke fixture\n{"appearance":{"language":"en","theme":"light"}}\n');
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir });
    const { app, window: main } = smoke;
    await expect.poll(() => main.evaluate(() => window.lin!.startup.get())).toEqual({ status: 'ready' });
    await main.evaluate(() => {
      (window as any).memoryEvents = 0;
      window.lin!.onMemoryChanged(() => { (window as any).memoryEvents++; });
    });
    await main.evaluate(() => window.lin!.invoke('memory_enabled_update', { enabled: false }));
    await expect.poll(() => main.evaluate(() => window.lin!.invoke('memory_inspect', { request: { operation: 'status' } }))).toMatchObject({ status: { featureMode: 'disabled' } });
    const saved = await readFile(config, 'utf8');
    expect(saved).toContain('// Memory smoke fixture');
    expect(saved).toContain('"enabled": false');
    await writeFile(config, '// External Agent file edit\n{"appearance":{"language":"en","theme":"light"},"agent":{"memory":{"enabled":true}}}\n');
    await expect.poll(() => main.evaluate(() => window.lin!.invoke('memory_inspect', { request: { operation: 'status' } }))).toMatchObject({ status: { featureMode: 'enabled' } });
    expect(await main.evaluate(() => (window as any).memoryEvents)).toBeGreaterThan(0);

    for (const command of ['memory_settings_get', 'memory_feature_mode_set', 'memory_reset']) {
      expect(await main.evaluate((command) => window.lin!.invoke(command, { mode: 'disabled' }).then(() => 'accepted', () => 'rejected'), command)).toBe('rejected');
    }
    expect(await main.evaluate(() => window.lin!.invoke('memory_manage', { request: { operation: 'reset', approved: true } }).then(() => 'accepted', () => 'rejected'))).toBe('rejected');
    const models = await openConfiguration(smoke, 'models');
    await models.evaluate(() => window.lin!.openProviderConfig({ providerId: 'fixture', mode: 'custom' }));
    await expect.poll(() => app.windows().find((page) => page.url().includes('provider=fixture'))?.url()).toBeTruthy();
    const provider = app.windows().find((page) => page.url().includes('provider=fixture'))!;
    await provider.waitForLoadState('domcontentloaded');
    expect(await provider.evaluate(() => window.lin!.invoke('memory_inspect', { request: { operation: 'status' } }).then(() => 'accepted', () => 'rejected'))).toBe('rejected');
    const providerClosed = provider.waitForEvent('close');
    await provider.evaluate(() => { void window.lin!.closeProviderConfig(); }).catch((error) => {
      if (!provider.isClosed()) throw error;
    });
    await providerClosed;
    await models.close();

    const ids = await seedMemory(main);
    const opened = await main.evaluate(() => window.lin!.invoke('memory_manage', { request: { operation: 'open' } }));
    expect(opened).toMatchObject({ operation: 'open', navigation: 'opened' });
    await main.evaluate(() => window.lin!.openSettings({ destination: 'memory' }));
    await expect.poll(() => app.windows().find((page) => page.url().includes('destination=memory'))?.url()).toBeTruthy();
    const settings = app.windows().find((page) => page.url().includes('destination=memory'))!;
    await expect(settings.getByRole('list', { name: 'Memory', exact: true })).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await settings.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await settings.getByRole('button', { name: 'Reset Memory', exact: true }).scrollIntoViewIfNeeded();
      expect(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await settings.screenshot({ path: testInfo.outputPath(`memory-${theme}.png`) });
    }
    // Stub only the OS decision boundary; all preload, Host, Memory and Runtime work is real.
    await app.evaluate(({ dialog }) => {
      (globalThis as any).memoryReviewResponse = 1;
      (globalThis as any).memoryReviews = [];
      dialog.showMessageBox = (async (_parent: unknown, options: unknown) => {
        (globalThis as any).memoryReviews.push(options);
        return { response: (globalThis as any).memoryReviewResponse, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await settings.getByRole('button', { name: 'Reset Memory', exact: true }).focus();
    await settings.keyboard.press('Enter');
    await expect(settings.getByRole('alert')).toContainText('cancelled');
    expect(await hasText(main, 'Memory ordinary descendant')).toBe(true);
    const review = await app.evaluate(() => {
      const value = (globalThis as any).memoryReviews.at(-1);
      return { type: value.type, detail: value.detail, defaultId: value.defaultId, cancelId: value.cancelId };
    });
    expect(review).toEqual({ type: 'warning', detail: 'Memory sections: 1. Notes to delete: 2, including 1 ordinary notes.', defaultId: 1, cancelId: 1 });
    await app.evaluate(() => { (globalThis as any).memoryReviewResponse = 0; });
    await settings.getByRole('button', { name: 'Reset Memory', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('Memory reset.');
    expect(await hasText(main, 'Memory ordinary descendant')).toBe(false);
    expect(await hasText(main, 'Memory outside survivor')).toBe(true);
    expect(await main.evaluate(() => window.lin!.invoke('memory_inspect', { request: { operation: 'status' } }))).toMatchObject({ status: { resetEpoch: 1 } });
    expect(ids.container).toMatch(/^node:/);
  } finally {
    if (smoke) await closeSmokeApp(smoke, { keepUserData: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

async function seedMemory(page: Page) {
  return page.evaluate(async () => {
    const request = async (command: string, input: unknown) => {
      const result = await window.lin!.outline.request({ requestId: `memory:${crypto.randomUUID()}`, command, input });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data;
    };
    const container = `node:${crypto.randomUUID()}`;
    const child = `node:${crypto.randomUUID()}`;
    const outside = `node:${crypto.randomUUID()}`;
    const content = (text: string) => ({ text, marks: [], inlineRefs: [] });
    const diff = await request('preview', { changeSet: {
      protocolVersion: 1, kind: 'outline.changeset', idempotencyKey: `memory:${crypto.randomUUID()}`,
      operations: [{ op: 'create', placement: { kind: 'last', parent: { target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' } } },
        nodes: [
          { id: container, content: content('Memory canonical fixture'), tags: ['tag:d-memory'], children: [
            { id: child, content: content('Memory ordinary descendant'), children: [] },
          ] },
          { id: outside, content: content('Memory outside survivor'), children: [] },
        ] }],
    } });
    await request('apply', { diff });
    return { container, child, outside };
  });
}
async function hasText(page: Page, text: string): Promise<boolean> {
  return page.evaluate(async (text) => {
    const target = { selector: { by: 'query', query: { kind: 'rule', op: 'STRING_MATCH', text }, order: 'document', limit: 10 }, cardinality: 'many', max: 10 };
    const result = await window.lin!.outline.request({ requestId: `memory:${crypto.randomUUID()}`, command: 'find',
      input: { target, projection: { kind: 'summary', targets: { target }, page: { limit: 10 } } } });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const data = result.data as { nodes: unknown[] };
    return data.nodes.length > 0;
  }, text);
}
