import { expect, test } from '@playwright/test';
import { existsSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp } from './electronApp';

// Per-clone userData isolation (CLAUDE.md A5 / stage 6): the host resolves
// userData from ELECTRON_USER_DATA_DIR before any service reads it, so each
// clone (and each smoke execution) keeps its own documents/Agent Threads/assets.
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

  test('persists a real document mutation into the isolated dir', async () => {
    const smoke = await launchSmokeApp();
    await smoke.window.locator('#root').waitFor();
    const userData = smoke.userDataDir;
    // The document store writes workspace.loro.json only on real document state;
    // init/load may persist generated system state, and mutations can be
    // coalesced. Its presence after a flushed mutation is a non-vacuous signal
    // that persistence ran into THIS dir (a bare readdir would be satisfied by
    // Chromium's own cache scaffolding).
    const workspaceFile = join(userData, 'workspace.loro.json');

    // Apply a real mutation through the same IPC command surface the renderer
    // uses (window.lin → 'lin:invoke' → documentService). The before-quit flush
    // below drains any coalesced document save under the workspace root.
    await smoke.window.evaluate(async () => {
      const lin = (window as unknown as { lin: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).lin;
      const snapshot = (await lin.invoke('get_projection')) as { projection: { rootId: string } };
      await lin.invoke('create_node', { parentId: snapshot.projection.rootId, text: 'smoke-persist' });
    });
    // before-quit flushes pending changes; the persisted state survives close.
    await closeSmokeApp(smoke, { keepUserData: true });
    let relaunched: Awaited<ReturnType<typeof launchSmokeApp>> | null = null;
    try {
      expect(existsSync(workspaceFile)).toBe(true);
      const sizeAfterClose = statSync(workspaceFile).size;
      expect(sizeAfterClose).toBeGreaterThan(0);

      relaunched = await launchSmokeApp({ userDataDir: userData });
      await relaunched.window.locator('#root').waitFor();
      const persisted = await relaunched.window.evaluate(async () => {
        const lin = (window as unknown as { lin: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).lin;
        const snapshot = (await lin.invoke('get_projection')) as {
          projection: { nodes: Array<{ content?: { text?: string } }> };
        };
        return snapshot.projection.nodes.some((node) => node.content?.text === 'smoke-persist');
      });
      expect(persisted).toBe(true);
      expect(statSync(workspaceFile).size).toBeGreaterThanOrEqual(sizeAfterClose);
    } finally {
      if (relaunched) {
        await closeSmokeApp(relaunched, { keepUserData: true });
      }
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
