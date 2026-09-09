import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

for (const theme of ['light', 'dark'] as const) {
  test('Task detail distinguishes requested policy and actual isolation (' + theme + ')', async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    await page.evaluate(async () => {
      const target = window as Window & { lin: { agentCoreRequest: (method: string, input: object) => Promise<{ data: { id: string }[] }> };
        __LIN_E2E__: { emitAgentCoreNotification: (value: unknown) => void } };
      const threadId = (await target.lin.agentCoreRequest('thread/list', {})).data[0]!.id;
      const cwd = '/workspace/isolated-worktree';
      target.__LIN_E2E__.emitAgentCoreNotification({ type: 'toolTask/changed', threadId, task: {
        taskId: 'task-isolation-proof', ownerThreadId: threadId, sourceTurnId: '01910000-0000-7000-8000-00000000ee01',
        sourceItemId: '01910000-0000-7000-8000-00000000ee02', producer: 'bash', description: 'Check project isolation',
        state: 'succeeded', deliveryState: 'delivered', progress: null, exitCode: 0, signal: null, outcomeReason: 'exit_zero', error: null,
        detailState: 'available', artifacts: [], artifactWarnings: [], outputBytes: 10, detailBytes: 10, storagePressure: null,
        startedAt: Date.now() - 5000, completedAt: Date.now(), deliveryTurnId: null,
        executionContext: { addressRef: 'a'.repeat(64), policyRef: 'b'.repeat(64), snapshotRef: 'c'.repeat(64),
          address: { requestedCwd: cwd, cwd, targets: [], targetMode: 'follow', coverage: 'cwd-only',
            scopes: [{ key: cwd, directory: cwd, worktree: null, gitDirectory: null }] },
          policy: { capability: 'full-access', isolation: 'macos-write-sandbox', mutation: true, writablePaths: [cwd] },
          snapshot: { seriesId: 'test', capturedAt: 1, generation: 0, predecessorRef: null, discovery: 'pending', degradation: null, facts: [] } },
        isolation: { requested: 'macos-write-sandbox', state: 'sandboxed', platform: 'darwin', backend: 'macos-sandbox-exec',
          dependency: 'available', network: 'unrestricted', writablePaths: [cwd], protectedGitObjectStores: [], profileDigest: 'd'.repeat(64), reason: null },
      } });
    });
    await page.locator('.thread-work-strip-pill').click();
    await page.locator('.thread-work-strip-open').click();
    const detail = page.locator('.thread-tool-task-detail');
    await expect(detail).toContainText('macOS write sandbox active');
    await expect(detail).toContainText('Unrestricted by the process sandbox');
    await expect(detail).toContainText('/workspace/isolated-worktree');
    await expect(detail).toContainText('Mock background output');
    await detail.screenshot({ path: testInfo.outputPath('process-isolation-' + theme + '.png') });
  });
}
