import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp, REPO_ROOT, type SmokeApp } from './electronApp';

for (const store of ['memories', 'state', 'goals', 'resource_references', 'delegation', 'automations']) {
  test(`a ${store} constructor failure preserves notes and releases the failed owner before Retry`, async ({}, testInfo) => {
    const userDataDir = await mkdtemp('/tmp/tenon-fault-');
    execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], { cwd: REPO_ROOT });
    await mkdir(join(userDataDir, 'agent'), { recursive: true });
    const brokenPath = join(userDataDir, 'agent', `${store}.sqlite`);
    const brokenBytes = 'Disposable invalid SQLite fixture';
    await writeFile(brokenPath, brokenBytes);
    // Error display and Copy details must not need a writable diagnostic directory.
    if (store === 'memories') await writeFile(join(userDataDir, 'diagnostics'), 'Unavailable diagnostics fixture');
    let smoke: SmokeApp | undefined;
    try {
      smoke = await launchSmokeApp({ userDataDir });
      await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
      const failure = smoke.window.locator('.startup-failure');
      await expect(failure).toContainText('Unable to start Agent services');
      await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toMatchObject({
        status: 'failed', capabilities: { outline: 'ready', agent: 'unavailable' },
        issues: [{ domain: 'agent', category: 'invalid-data' }],
      });
      expect(await readFile(brokenPath, 'utf8')).toBe(brokenBytes);
      // The production constructors must not leave an unreachable SQLite handle open.
      const opened = spawnSync('lsof', ['-a', '-p', String(smoke.app.process().pid), '-F', 'n', '--', brokenPath], { encoding: 'utf8' });
      expect(opened.stdout.trim()).toBe('');
      const handles = spawnSync('lsof', ['-a', '-p', String(smoke.app.process().pid), '-F', 'n'], { encoding: 'utf8' }).stdout;
      expect(handles.split('\n').filter((line) => line.startsWith(`n${userDataDir}/agent/`) && /\.sqlite(?:-|$)/.test(line))).toEqual([]);
      await expect(smoke.window.evaluate(async () => {
        try { await window.lin!.agentCoreRequest('thread/start', { modelProvider: 'openai' }); return 'admitted'; }
        catch { return 'blocked'; }
      })).resolves.toBe('blocked');
      await failure.getByRole('button', { name: 'Copy details', exact: true }).click();
      expect(await smoke.app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Capability: agent');
      let canvas: import('@playwright/test').ElementHandle<HTMLElement | SVGElement> | null = null;
      if (store === 'memories') {
        canvas = await smoke.window.locator('.workspace-canvas').elementHandle();
        await smoke.window.evaluate(async () => {
          const request = async (command: string, input: unknown) => {
            const result = await window.lin!.outline.request({ requestId: crypto.randomUUID(), command, input });
            if (!result.ok) throw new Error(JSON.stringify(result.error));
            return result.data;
          };
          const diff = await request('preview', { changeSet: {
            protocolVersion: 1, kind: 'outline.changeset', idempotencyKey: crypto.randomUUID(),
            operations: [{ op: 'create', placement: { kind: 'last', parent: { target: {
              selector: { by: 'alias', alias: 'today' }, cardinality: 'one' } } }, nodes: [{
              id: `node:${crypto.randomUUID()}`, content: { text: 'Notes saved while Agent is unavailable', marks: [], inlineRefs: [] }, children: [],
            }] }],
          } });
          await request('apply', { diff });
        });
        await expect(smoke.window.locator('.workspace-canvas')).toContainText('Notes saved while Agent is unavailable');
        for (const theme of ['light', 'dark'] as const) {
          await smoke.app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, theme);
          await smoke.window.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
          await expect.poll(() => smoke!.window.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
          await smoke.window.waitForTimeout(250);
          await smoke.window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await smoke.window.screenshot({ path: testInfo.outputPath(`agent-failure-${theme}.png`) });
        }
        await failure.getByRole('button', { name: 'Continue with notes', exact: true }).click();
        await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
        await smoke.window.getByRole('button', { name: 'Startup issues', exact: true }).click();
        await expect(failure).toBeVisible();
      }
      // Repair this disposable fixture only; Retry itself has no deletion operation.
      await rm(brokenPath);
      await failure.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get()), { timeout: 20_000 })
        .toMatchObject({ status: 'ready', capabilities: { outline: 'ready', agent: 'ready' }, issues: [] });
      await expect(failure).toHaveCount(0);
      if (canvas) {
        expect(await canvas.evaluate((element) => element.isConnected)).toBe(true);
        await expect(smoke.window.locator('.workspace-canvas')).toContainText('Notes saved while Agent is unavailable');
        await closeSmokeApp(smoke, { keepUserData: true });
        smoke = await launchSmokeApp({ userDataDir });
        await expect(smoke.window.locator('.workspace-canvas')).toContainText('Notes saved while Agent is unavailable');
      }
      await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
    } finally {
      if (smoke && smoke.app.windows().length) await closeSmokeApp(smoke);
      else await rm(userDataDir, { recursive: true, force: true });
    }
  });
}

test('an explicit snapshot version mismatch reaches the shell without altering the source', async () => {
  const userDataDir = await mkdtemp('/tmp/tenon-version-');
  execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], { cwd: REPO_ROOT });
  const snapshotPath = join(userDataDir, 'outline-runtime/workspace/outline.snapshot.json');
  const original = await readFile(snapshotPath, 'utf8');
  const snapshot = JSON.parse(original);
  const expected = snapshot.storageVersion;
  snapshot.storageVersion = expected + 1;
  const altered = JSON.stringify(snapshot);
  await writeFile(snapshotPath, altered);
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir });
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get()), { timeout: 10_000 }).toMatchObject({
      capabilities: { outline: 'unavailable', agent: 'unavailable' },
      issues: [{ domain: 'outline', category: 'version-mismatch', format: { found: expected + 1, expected } }],
    });
    expect(await readFile(snapshotPath, 'utf8')).toBe(altered);
    await writeFile(snapshotPath, original);
    await smoke.window.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
  } finally {
    if (smoke && smoke.app.windows().length) await closeSmokeApp(smoke);
    else await rm(userDataDir, { recursive: true, force: true });
  }
});

test('history quarantine names its source and descendants while healthy conversations remain usable', async () => {
  const userDataDir = await mkdtemp('/tmp/tenon-thread-');
  execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], { cwd: REPO_ROOT });
  const ids = JSON.parse(execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupThreads.ts'), userDataDir], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().split('\n').at(-1)!);
  const rolloutPath = join(userDataDir, 'agent/rollouts', `${ids.unreadableId}.jsonl`);
  const bytes = await readFile(rolloutPath);
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir });
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toMatchObject({
      status: 'ready', capabilities: { outline: 'ready', agent: 'ready' },
      issues: [{ threadId: ids.unreadableId, retryable: false }],
    });
    const state = await smoke.window.evaluate(() => window.lin!.startup.get());
    expect(state.threads).toEqual(expect.arrayContaining([
      { threadId: ids.unreadableId, sourceThreadId: ids.unreadableId },
      { threadId: ids.childId, sourceThreadId: ids.unreadableId },
    ]));
    const failure = smoke.window.locator('.startup-failure');
    await expect(failure).toContainText(ids.unreadableId);
    await expect(failure).toContainText(ids.childId);
    await expect(failure.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    expect(await readFile(rolloutPath)).toEqual(bytes);
    const healthy = await smoke.window.evaluate((threadId) => window.lin!.agentCoreRequest('thread/read', { threadId, includeTurns: true }), ids.healthyId);
    expect(healthy.thread.name).toBe('Healthy conversation');
    await failure.getByRole('button', { name: 'Continue with notes', exact: true }).click();
    await expect(failure).toHaveCount(0);
    await smoke.window.locator('.thread-dock-title-button').first().click();
    await expect(smoke.window.locator('.thread-list')).toContainText('History could not be read');
    await smoke.window.locator('.thread-list-select').filter({ hasText: 'Unreadable conversation' }).click();
    await expect(smoke.window.locator('.startup-failure')).toBeVisible();
  } finally {
    if (smoke && smoke.app.windows().length) await closeSmokeApp(smoke);
    else await rm(userDataDir, { recursive: true, force: true });
  }
});

test('configuration observation fails independently and source inspection uses its native owner', async () => {
  const userDataDir = await mkdtemp('/tmp/tenon-config-');
  execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], { cwd: REPO_ROOT });
  const statusPath = join(userDataDir, 'config/status.json');
  await mkdir(statusPath, { recursive: true });
  const sourcePath = join(userDataDir, 'config/settings.jsonc');
  const bytes = '{}\n';
  await writeFile(sourcePath, bytes);
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir });
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toMatchObject({
      status: 'failed', capabilities: { outline: 'ready', agent: 'ready' },
      issues: [{ domain: 'configuration', source: 'preferences', actions: ['copy-details', 'open-source'] }],
    });
    await smoke.app.evaluate(({ shell }) => {
      // Observe the native destination without opening the user's external editor.
      shell.openPath = async (path) => { (globalThis as typeof globalThis & { openedSource?: string }).openedSource = path; return ''; };
    });
    await smoke.window.getByRole('button', { name: 'Open configuration file', exact: true }).click();
    expect(await smoke.app.evaluate(() => (globalThis as typeof globalThis & { openedSource?: string }).openedSource)).toBe(sourcePath);
    expect(await readFile(sourcePath, 'utf8')).toBe(bytes);
    await expect(smoke.window.evaluate(async () => {
      try { await window.lin!.startup.issueAction('unobserved', 'open-source'); return 'opened'; }
      catch { return 'rejected'; }
    })).resolves.toBe('rejected');
    await writeFile(sourcePath, JSON.stringify({ appearance: { theme: 'dark' }, agent: { memory: { enabled: false } } }));
    await rm(statusPath, { recursive: true });
    await smoke.window.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toMatchObject({ status: 'ready', issues: [] });
    expect(await smoke.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
    expect(await smoke.window.evaluate(() => window.lin!.invoke('memory_inspect', { request: { operation: 'status' } })))
      .toMatchObject({ status: { featureMode: 'disabled' } });
    expect(JSON.parse(await readFile(statusPath, 'utf8'))).toMatchObject({
      application: { status: 'applied' },
      effective: { appearance: { theme: 'dark' }, agent: { memoryEnabled: false } },
    });
    await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
  } finally {
    if (smoke && smoke.app.windows().length) await closeSmokeApp(smoke);
    else await rm(userDataDir, { recursive: true, force: true });
  }
});

test('startup issues preserve healthy conversation drafts and notifications while hidden', async ({}, testInfo) => {
  const userDataDir = await mkdtemp('/tmp/tenon-draft-');
  execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], { cwd: REPO_ROOT });
  await mkdir(join(userDataDir, 'config/status.json'), { recursive: true });
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir });
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toMatchObject({
      status: 'failed', capabilities: { outline: 'ready', agent: 'ready' },
    });
    await smoke.window.evaluate(() => window.lin!.agentCoreRequest('thread/start', {
      name: 'Draft conversation', modelProvider: 'openai',
    }));
    const failure = smoke.window.locator('.startup-failure');
    await failure.getByRole('button', { name: 'Continue with notes', exact: true }).click();
    await smoke.window.locator('.thread-dock-title-button').first().click();
    await smoke.window.locator('.thread-list-select').filter({ hasText: 'Draft conversation' }).click();
    const editor = smoke.window.locator('.thread-composer-editor [contenteditable="true"]');
    await editor.fill('Keep this unsent draft while inspecting startup issues.');
    const originalEditor = await editor.elementHandle();
    // The chrome toggle collapses the conversation and then opens its retained issue.
    const toggle = smoke.window.getByRole('button', { name: 'Startup issues', exact: true });
    await toggle.click();
    await toggle.click();
    await expect(failure).toBeVisible();
    expect.soft(await originalEditor!.evaluate((element) => element.isConnected)).toBe(true);
    await smoke.window.evaluate(() => window.lin!.agentCoreRequest('thread/start', {
      name: 'Arrived while inspecting an issue', modelProvider: 'openai',
    }));
    await failure.getByRole('button', { name: 'Continue with notes', exact: true }).click();
    await expect.soft(editor).toContainText('Keep this unsent draft while inspecting startup issues.');
    await smoke.window.locator('.thread-dock-title-button').first().click();
    await expect(smoke.window.locator('.thread-list')).toContainText('Arrived while inspecting an issue');
    await smoke.window.keyboard.press('Escape');
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, theme);
      await smoke.window.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await smoke.window.waitForTimeout(250);
      await smoke.window.screenshot({ path: testInfo.outputPath(`retained-draft-${theme}.png`) });
    }
  } finally {
    if (smoke && smoke.app.windows().length) await closeSmokeApp(smoke);
    else await rm(userDataDir, { recursive: true, force: true });
  }
});
