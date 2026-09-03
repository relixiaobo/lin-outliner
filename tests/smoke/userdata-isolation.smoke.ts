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
    const workspaceRoot = join(userData, 'outline-runtime', 'workspace');
    const snapshotFile = join(workspaceRoot, 'outline.snapshot.json');
    const transactionFile = join(workspaceRoot, 'outline.transactions.jsonl');

    // Apply a real mutation through the same typed Outline IPC surface used by
    // the renderer. The before-quit flush below drains the accepted transaction.
    await smoke.window.evaluate(async () => {
      const outline = (window as unknown as {
        lin: { outline: { request: (request: unknown) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }> } };
      }).lin.outline;
      const request = async (command: string, input: unknown) => {
        const response = await outline.request({ requestId: `smoke:${crypto.randomUUID()}`, command, input });
        if (!response.ok) throw new Error(response.error?.message ?? `Outline ${command} failed`);
        return response.data;
      };
      const diff = await request('preview', {
        changeSet: {
          protocolVersion: 1,
          kind: 'outline.changeset',
          idempotencyKey: `smoke:${crypto.randomUUID()}`,
          operations: [{
            op: 'create',
            placement: {
              kind: 'last',
              parent: { target: { selector: { by: 'alias', alias: 'today' }, cardinality: 'one' } },
            },
            nodes: [{ content: { text: 'smoke-persist', marks: [], inlineRefs: [] }, children: [] }],
          }],
        },
      });
      await request('apply', { diff });
    });
    // before-quit flushes pending changes; the persisted state survives close.
    await closeSmokeApp(smoke, { keepUserData: true });
    await waitForRuntimeRelease(userData);
    let relaunched: Awaited<ReturnType<typeof launchSmokeApp>> | null = null;
    try {
      expect(existsSync(snapshotFile)).toBe(true);
      expect(existsSync(transactionFile)).toBe(true);
      const transactionSizeAfterClose = statSync(transactionFile).size;
      expect(statSync(snapshotFile).size).toBeGreaterThan(0);
      expect(transactionSizeAfterClose).toBeGreaterThan(0);

      relaunched = await launchSmokeApp({ userDataDir: userData });
      await relaunched.window.locator('#root').waitFor();
      const persisted = await relaunched.window.evaluate(async () => {
        const outline = (window as unknown as {
          lin: { outline: { request: (request: unknown) => Promise<{ ok: boolean; data?: unknown; error?: unknown }> } };
        }).lin.outline;
        const target = {
          selector: {
            by: 'query',
            query: { kind: 'rule', op: 'STRING_MATCH', text: 'smoke-persist' },
            order: 'document',
            limit: 10,
          },
          cardinality: 'many',
          max: 10,
        };
        const response = await outline.request({
          requestId: `smoke:${crypto.randomUUID()}`,
          command: 'find',
          input: {
            target,
            projection: { kind: 'summary', targets: { target }, page: { limit: 10 } },
          },
        });
        return response;
      });
      expect(persisted).toEqual(expect.objectContaining({ ok: true, data: expect.anything() }));
      expect(JSON.stringify(persisted.data)).toContain('smoke-persist');
      expect(statSync(transactionFile).size).toBeGreaterThanOrEqual(transactionSizeAfterClose);
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

async function waitForRuntimeRelease(userData: string): Promise<void> {
  const runtimeRoot = join(userData, 'outline-runtime');
  const descriptor = join(runtimeRoot, 'runtime.json');
  const writerLock = join(runtimeRoot, 'writer.lock');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!existsSync(descriptor) && !existsSync(writerLock)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Outline Runtime descriptor or writer lock remained after desktop quit.');
}
