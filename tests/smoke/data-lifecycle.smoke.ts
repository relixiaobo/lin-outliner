import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

test('scoped Agent Retry reloads durable restored execution authority before constructing producers', async () => {
  const userDataDir = await mkdtemp('/tmp/tenon-fence-retry-');
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir }); await ready(smoke);
    await closeSmokeApp(smoke, { keepUserData: true }); smoke = undefined;
    const generation = randomUUID(); const taskId = `task_${randomUUID()}`;
    await mkdir(join(userDataDir, 'data-lifecycle/restored-work'), { recursive: true });
    await writeFile(join(userDataDir, 'data-lifecycle/execution-fence.json'), JSON.stringify({ version: 1, generation, paused: true }));
    await writeFile(join(userDataDir, 'data-lifecycle/restored-work', `${generation}.json`), JSON.stringify({ version: 1, generation, entries: [{ kind: 'task', id: taskId }] }));
    const store = join(userDataDir, 'agent/memories.sqlite'); const retained = join(userDataDir, 'retained-memory');
    await rename(store, retained); await writeFile(store, 'Temporary damaged Memory Store');
    smoke = await launchSmokeApp({ userDataDir });
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toMatchObject({ capabilities: { outline: 'ready', agent: 'unavailable' } });
    await rm(store); await rename(retained, store);
    await smoke.window.locator('.startup-failure').getByRole('button', { name: 'Retry', exact: true }).click();
    await ready(smoke);
    const result = await smoke.window.evaluate(async (taskId) => {
      try { await window.lin!.agentCoreRequest('task/stop', { threadId: '018f0f24-7b2e-7a3f-8a4b-123456789abc', taskId }); return 'admitted'; }
      catch (error) { return String(error); }
    }, taskId);
    expect(result).toContain('no current process-control authority');
    expect(await smoke.window.evaluate(async () => (await window.lin!.dataLifecycle.request({ action: 'status' })).state.automaticExecutionPaused)).toBe(true);
  } finally {
    if (smoke) await closeSmokeApp(smoke, { keepUserData: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('opens the isolated versioned baseline and exposes verified backup controls in both themes', async ({}, testInfo) => {
  const userDataDir = await mkdtemp('/tmp/tenon-data-smoke-');
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir });
    await expect(smoke.window.locator('.workspace-canvas')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => smoke!.window.evaluate(async () => (await window.lin!.dataLifecycle.request({ action: 'status' })).state.phase), { timeout: 30_000 }).toBe('ready');
    const manifest = JSON.parse(await readFile(join(userDataDir, 'data-manifest.json'), 'utf8'));
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.identityReferences.workspaceId).toBeTruthy();
    await smoke.window.evaluate(() => window.lin!.openSettings({ destination: 'data' }));
    await expect.poll(() => smoke!.app.windows().find((page) => page.url().includes('settings'))?.url()).toBeTruthy();
    const page = smoke.app.windows().find((entry) => entry.url().includes('settings'))!;
    await expect(page.getByRole('heading', { name: 'Data backup and recovery', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create backup', exact: true })).toBeEnabled();
    await expect(page.getByText(/^Loading(?:\.\.\.|…)$/)).toHaveCount(0);
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, next) => { nativeTheme.themeSource = next; }, theme);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: testInfo.outputPath(`data-recovery-${theme}.png`), animations: 'disabled' });
    }
  } finally {
    if (smoke) await closeSmokeApp(smoke, { keepUserData: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('native backup and restore drain writers and preserve the selected checkpoint across restarts', async () => {
  test.setTimeout(120_000);
  const userDataDir = await mkdtemp('/tmp/tenon-data-roundtrip-');
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir });
    await ready(smoke);
    await createNote(smoke, 'Before verified backup');
    await requestRestart(smoke, { action: 'backup' }); smoke = undefined;
    smoke = await launchSmokeApp({ userDataDir }); await ready(smoke);
    const available = await smoke.window.evaluate(async () => (await window.lin!.dataLifecycle.request({ action: 'inspect' })).state);
    const backup = available.backups.find((entry) => entry.verified && entry.purpose === 'backup' && entry.fileCount > 0)!;
    expect(backup).toBeTruthy();
    await createNote(smoke, 'After verified backup');
    const revision = await smoke.window.evaluate(async () => (await window.lin!.dataLifecycle.request({ action: 'status' })).state.revision);
    await requestRestart(smoke, { action: 'restore', backupId: backup.id, revision }); smoke = undefined;
    smoke = await launchSmokeApp({ userDataDir }); await ready(smoke);
    const result = await smoke.window.evaluate(async () => {
      const count = async (text: string) => {
        const response = await window.lin!.outline.request({ requestId: crypto.randomUUID(), command: 'find', input: {
          mode: 'count', query: { kind: 'rule', op: 'STRING_MATCH', text },
        } });
        if (!response.ok) throw new Error(JSON.stringify(response.error));
        return (response.data as { count: number }).count;
      };
      return { before: await count('Before verified backup'), after: await count('After verified backup'),
        state: (await window.lin!.dataLifecycle.request({ action: 'status' })).state };
    });
    expect(result.before).toBe(1); expect(result.after).toBe(0);
    expect(result.state.automaticExecutionPaused).toBe(true);
    await expect(smoke.window.getByRole('heading', { name: 'Restored automatic work is paused', exact: true })).toBeVisible();
  } finally {
    if (smoke) await closeSmokeApp(smoke, { keepUserData: true });
    await rm(userDataDir, { recursive: true, force: true });
  }
});

async function ready(smoke: SmokeApp) {
  await expect.poll(() => smoke.window.evaluate(() => window.lin!.startup.get()), { timeout: 30_000 }).toMatchObject({
    status: 'ready', capabilities: { outline: 'ready', agent: 'ready' },
  });
  await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
}

async function createNote(smoke: SmokeApp, text: string) {
  await smoke.window.evaluate(async (text) => {
    const request = async (command: string, input: unknown) => {
      const response = await window.lin!.outline.request({ requestId: crypto.randomUUID(), command, input });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      return response.data;
    };
    const diff = await request('preview', { changeSet: { protocolVersion: 1, kind: 'outline.changeset', idempotencyKey: crypto.randomUUID(),
      operations: [{ op: 'create', placement: { kind: 'last', parent: { target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' } } },
        nodes: [{ content: { text, marks: [], inlineRefs: [] }, children: [] }] }] } });
    await request('apply', { diff });
  }, text);
}

async function requestRestart(smoke: SmokeApp, request: import('../../src/core/dataLifecycle').DataLifecycleRequest) {
  await smoke.app.evaluate(({ app, dialog }) => {
    // The harness launches the next real process itself so it retains control of
    // every throwaway instance. Production still exercises the normal quit path.
    app.relaunch = () => undefined;
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  const exit = new Promise<void>((resolve) => smoke.app.process().once('exit', () => resolve()));
  await smoke.window.evaluate((request) => { void window.lin!.dataLifecycle.request(request).catch(() => undefined); }, request);
  await exit;
}
