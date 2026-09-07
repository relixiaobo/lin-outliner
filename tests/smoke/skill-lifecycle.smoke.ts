import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from './electronApp';

test('real native Skill review has a narrow bridge, inert content, exact decisions and file-only availability', async ({}, testInfo) => {
  const userDataDir = await mkdtemp('/tmp/tenon-skill-review-');
  await mkdir(join(userDataDir, 'config'), { recursive: true });
  const config = '{"appearance":{"theme":"light"},"agent":{"skills":{"disabled":["lifecycle-smoke-demo"]}}}\n';
  await writeFile(join(userDataDir, 'config', 'settings.jsonc'), config);
  const app = await electron.launch({
    args: [join(REPO_ROOT, 'tests/smoke/fixtures/skill-lifecycle-entry.cjs')], cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_USER_DATA_DIR: userDataDir, ELECTRON_RENDERER_URL: '', VITE_DEV_SERVER_URL: '' },
  });
  try {
    const main = await app.firstWindow();
    await expect.poll(() => main.evaluate(() => window.lin?.startup.get())).toEqual({ status: 'ready' });
    const found = await main.evaluate(() => window.lin!.invoke('agent_managed_skill_discover', {
      sourceUrl: 'https://github.com/tenon-fixtures/skills',
    })) as any;
    expect(found.ok).toBe(true);
    const request = { operation: 'install', discoveryId: found.value.id,
      candidateId: found.value.candidates[0].id, expectedCommit: found.value.resolvedCommit };
    const pending = main.evaluate((request) => window.lin!.invoke('agent_skill_manage', { request }), request);
    const review = await app.waitForEvent('window');
    await expect(review.getByRole('heading', { name: 'Install lifecycle-smoke-demo' })).toBeVisible();
    expect(await review.evaluate(() => Object.keys(window.lin!))).toEqual([
      'skillReview', 'initialLanguage', 'onLanguageChanged', 'reportRendererError',
    ]);
    await expect(review.locator('pre')).toContainText('<script>untrusted()</script>');
    expect(await review.locator('script').evaluateAll((scripts) => scripts.some((script) => script.textContent?.includes('untrusted()')))).toBe(false);
    expect(await main.evaluate(() => window.lin!.skillReview.decide(true).then(() => 'forged', () => 'denied'))).toBe('denied');
    for (const theme of ['light', 'dark'] as const) {
      await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
      await review.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await expect(review.getByRole('button', { name: 'Install', exact: true })).toBeInViewport();
      await expect(review.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
      await assertNoHorizontalOverflow(review);
      await review.screenshot({ path: testInfo.outputPath(`skill-review-${theme}.png`) });
    }
    await app.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('skill-review'));
      child!.setSize(480, 500);
    });
    await expect(review.getByRole('button', { name: 'Install', exact: true })).toBeInViewport();
    await expect(review.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
    await assertNoHorizontalOverflow(review);
    await review.screenshot({ path: testInfo.outputPath('skill-review-compact.png') });
    await review.getByRole('button', { name: 'Install', exact: true }).click();
    const installed = await pending as any;
    expect(installed).toMatchObject({ ok: true, value: { committed: true, observed: { available: false }, runtimeRefresh: { state: 'applied' } } });
    expect(await readFile(join(userDataDir, 'config', 'settings.jsonc'), 'utf8')).toBe(config);
    const version = installed.value.version;
    const uninstall = { operation: 'uninstall', skillId: version.skillId,
      expectedRevision: version.revision, expectedActiveHash: version.contentHash };
    const cancelled = main.evaluate((request) => window.lin!.invoke('agent_skill_manage', { request }), uninstall);
    const cancelReview = await app.waitForEvent('window');
    await cancelReview.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await cancelled).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    const removed = main.evaluate((request) => window.lin!.invoke('agent_skill_manage', { request }), uninstall);
    const removalReview = await app.waitForEvent('window');
    await removalReview.getByRole('button', { name: 'Uninstall', exact: true }).click();
    expect(await removed).toMatchObject({ ok: true, value: { committed: true, version: null } });
    expect(await main.evaluate(() => window.lin!.invoke('agent_managed_skill_list'))).toMatchObject({ ok: true, value: [] });
  } finally {
    await app.close();
    // Immutable managed bundles may remain after an assertion failure. This tree
    // was minted by this test; make only its directories removable for cleanup.
    await writableDirectories(userDataDir);
    await rm(userDataDir, { recursive: true, force: true });
  }
});

async function assertNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.managed-skill-details dd, .confirm-dialog-title, pre').evaluateAll((elements) =>
    elements.every((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && element.scrollWidth <= element.clientWidth + 1;
    }))).toBe(true);
}

async function writableDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) await writableDirectories(join(directory, entry.name));
  }
}
