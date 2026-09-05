import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAgentScratchRoot } from '../../src/main/agent/capabilities/agentLocalRoot';
import { threadTranscriptRoot } from '../../src/main/agent/thread/ThreadTranscriptArtifact';
import { closeSmokeApp, launchSmokeApp, REPO_ROOT, type SmokeApp } from './electronApp';

async function workspaceFixture() {
  const userDataDir = await mkdtemp('/tmp/tenon-startup-');
  execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], { cwd: REPO_ROOT });
  const snapshotPath = join(userDataDir, 'outline-runtime/workspace/outline.snapshot.json');
  return { userDataDir, snapshotPath, snapshot: await readFile(snapshotPath) };
}

async function cleanup(smoke: SmokeApp | undefined, userDataDir: string) {
  if (smoke && smoke.app.windows().length > 0) await closeSmokeApp(smoke);
  else await rm(userDataDir, { recursive: true, force: true });
}

async function holdFileRead(filePath: string) {
  const content = await readFile(filePath);
  const held = `${filePath}.held`;
  await rename(filePath, held);
  execFileSync('mkfifo', [filePath]);
  let released = false;
  let release: Promise<void> | undefined;
  const releaseRead = () => release ??= new Promise<void>((resolve, reject) => {
    const writer = createWriteStream(filePath);
    writer.on('error', reject);
    writer.on('open', () => {
      void rename(held, filePath).then(() => {
        released = true;
        writer.end(content);
      }, reject);
    });
    writer.on('finish', resolve);
  });
  return { releaseRead, isReleased: () => released };
}

test('the native window paints while the document snapshot read is still blocked', async () => {
  const fixture = await workspaceFixture();
  const { releaseRead, isReleased } = await holdFileRead(fixture.snapshotPath);
  // Also release a regressed build so a failed assertion cannot strand Runtime.
  const deadline = setTimeout(() => { void releaseRead(); }, 12_000);
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir: fixture.userDataDir });
    await expect(smoke.window.locator('.app-startup-shell')).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => smoke!.app.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows().some((window) => /index\.html/.test(window.webContents.getURL()) && window.isVisible())
    ))).toBe(true);
    expect(isReleased()).toBe(false);
    expect(await smoke.window.evaluate(() => window.lin!.startup.get())).toEqual({ status: 'starting' });
    let agentSettled = false;
    const earlyAgent = smoke.window.evaluate(() => window.lin!.agentCoreRequest('thread/list', {}))
      .then(() => { agentSettled = true; return 'completed'; }, () => 'failed');
    await smoke.window.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(agentSettled).toBe(false);
    await releaseRead();
    expect(await earlyAgent).toBe('completed');
    await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toEqual({ status: 'ready' });
  } finally {
    clearTimeout(deadline);
    await releaseRead();
    await cleanup(smoke, fixture.userDataDir);
  }
});

test('a document startup failure persists and Retry recovers in the same window', async ({}, testInfo) => {
  const fixture = await workspaceFixture();
  await writeFile(fixture.snapshotPath, 'invalid snapshot fixture');
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir: fixture.userDataDir });
    const failure = smoke.window.getByRole('alert');
    await expect(failure).toContainText('Unable to open your workspace', { timeout: 30_000 });
    await smoke.window.waitForTimeout(6_500);
    await expect(failure).toBeVisible();
    await expect(failure.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ nativeTheme }, mode) => { nativeTheme.themeSource = mode; }, theme);
      await smoke.window.emulateMedia({ colorScheme: theme });
      await expect.poll(() => smoke!.window.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
        .toBe(theme === 'dark');
      await smoke.window.waitForTimeout(200);
      await smoke.window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await smoke.window.screenshot({ path: testInfo.outputPath(`startup-failure-${theme}.png`) });
    }
    await smoke.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => /index\.html/.test(candidate.webContents.getURL()));
      window?.setSize(760, 560);
    });
    await expect(failure.getByRole('button', { name: 'Quit', exact: true })).toBeInViewport();
    await expect(failure.getByRole('button', { name: 'Retry', exact: true })).toBeInViewport();
    await smoke.window.screenshot({ path: testInfo.outputPath('startup-failure-minimum.png') });
    await writeFile(fixture.snapshotPath, fixture.snapshot);
    await failure.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(failure).toHaveCount(0);
    await expect(smoke.window.locator('.workspace-canvas')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toEqual({ status: 'ready' });
  } finally {
    await cleanup(smoke, fixture.userDataDir);
  }
});

test('Retry restores existing conversations after the document opens before Agent startup fails', async () => {
  const fixture = await workspaceFixture();
  let smoke: SmokeApp | undefined;
  let releaseRead: (() => Promise<void>) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir: fixture.userDataDir });
    const existingThreadId = await smoke.window.evaluate(async (cwd) => {
      const { thread } = await window.lin!.agentCoreRequest('thread/start', {
        name: 'Recovered conversation', modelProvider: 'openai', cwd,
      });
      return thread.id;
    }, fixture.userDataDir);
    await closeSmokeApp(smoke, { keepUserData: true });
    smoke = undefined;

    const transcriptRoot = threadTranscriptRoot(fixture.userDataDir);
    await mkdir(transcriptRoot, { recursive: true });
    const exclusionsPath = join(transcriptRoot, 'excluded.txt');
    await writeFile(exclusionsPath, '');
    const held = await holdFileRead(exclusionsPath);
    releaseRead = held.releaseRead;
    const uploadsPath = join(resolveAgentScratchRoot({ userDataPath: fixture.userDataDir }), 'uploads');
    await rm(uploadsPath, { recursive: true, force: true });
    await writeFile(uploadsPath, 'Injected Agent startup conflict');
    deadline = setTimeout(() => { void held.releaseRead(); }, 20_000);

    smoke = await launchSmokeApp({ userDataDir: fixture.userDataDir });
    await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
    await expect(smoke.window.locator('.thread-empty-copy')).toHaveCount(1);
    await smoke.window.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(held.isReleased()).toBe(false);
    expect(await smoke.window.evaluate(() => window.lin!.startup.get())).toEqual({ status: 'starting' });
    await releaseRead();
    const failure = smoke.window.locator('.startup-failure');
    await expect(failure).toContainText('EEXIST');
    expect(await smoke.window.evaluate(() => window.lin!.startup.get())).toMatchObject({
      status: 'failed', step: 'agent',
    });

    await rm(uploadsPath);
    await failure.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => smoke!.window.evaluate(() => window.lin!.startup.get())).toEqual({ status: 'ready' });
    await expect(smoke.window.locator('.workspace-canvas')).toBeVisible();
    await expect(smoke.window.locator('.thread-dock-title')).toHaveText('Recovered conversation');
    await expect(smoke.window.locator('.thread-dock-error')).toHaveCount(0);
    const threads = await smoke.window.evaluate(() => window.lin!.agentCoreRequest('thread/list', {}));
    expect(threads.data.map((thread) => thread.id)).toContain(existingThreadId);
  } finally {
    clearTimeout(deadline);
    await releaseRead?.();
    await cleanup(smoke, fixture.userDataDir);
  }
});

test('Quit exits from a persistent document startup failure', async () => {
  const fixture = await workspaceFixture();
  await writeFile(fixture.snapshotPath, 'invalid snapshot fixture');
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir: fixture.userDataDir });
    const failure = smoke.window.getByRole('alert');
    await expect(failure).toContainText('Unable to open your workspace', { timeout: 30_000 });
    const closed = smoke.app.waitForEvent('close');
    await failure.getByRole('button', { name: 'Quit', exact: true }).click();
    await closed;
  } finally {
    await cleanup(smoke, fixture.userDataDir);
  }
});
