import { expect, test } from '@playwright/test';
import { readdirSync, realpathSync, rmSync } from 'node:fs';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

// Per-clone userData isolation (CLAUDE.md A5 / stage 6): the host resolves
// userData from ELECTRON_USER_DATA_DIR before any service reads it, so each
// clone (and each smoke run) keeps its own documents/agent sessions/assets.
// These tests pin that contract against the built host.
const realpath = (p: string) => realpathSync(p);

test.describe('userData isolation', () => {
  test('honors ELECTRON_USER_DATA_DIR', async () => {
    const smoke = await launchSmokeApp();
    try {
      const userData = await smoke.app.evaluate(({ app }) => app.getPath('userData'));
      // tmpdir on macOS is symlinked (/var → /private/var); compare real paths.
      expect(realpath(userData)).toBe(realpath(smoke.userDataDir));
    } finally {
      await closeSmokeApp(smoke);
    }
  });

  test('persists into the isolated dir, not a shared location', async () => {
    const smoke = await launchSmokeApp();
    await smoke.window.locator('#root').waitFor();
    const userData = smoke.userDataDir;
    // before-quit flushes pending document changes; closing exercises that path.
    await closeSmokeApp(smoke, { keepUserData: true });
    try {
      // The host wrote its document/event state into the isolated dir.
      expect(readdirSync(userData).length).toBeGreaterThan(0);
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('two instances use independent userData dirs', async () => {
    const a = await launchSmokeApp();
    const b = await launchSmokeApp();
    try {
      const [pathA, pathB] = await Promise.all([
        a.app.evaluate(({ app }) => app.getPath('userData')),
        b.app.evaluate(({ app }) => app.getPath('userData')),
      ]);
      expect(realpath(pathA)).not.toBe(realpath(pathB));
      expect(realpath(pathA)).toBe(realpath(a.userDataDir));
      expect(realpath(pathB)).toBe(realpath(b.userDataDir));
    } finally {
      await closeSmokeApp(a);
      await closeSmokeApp(b);
    }
  });
});
