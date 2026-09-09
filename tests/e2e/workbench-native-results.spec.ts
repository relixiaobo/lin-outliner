import { expect, test } from '@playwright/test';
import { commandCalls, openMockedApp } from './outlinerMock';

for (const theme of ['light', 'dark'] as const) {
  test(`native Git output uses ordinary command details in ${theme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await openMockedApp(page);
    await page.evaluate(async () => {
      const target = window as Window & { lin: { agentCoreRequest: (method: string, input: object) => Promise<{ data: { id: string }[] }> };
        __LIN_E2E__: { emitAgentCoreNotification: (value: unknown) => void } };
      const threadId = (await target.lin.agentCoreRequest('thread/list', {})).data[0]!.id;
      const turnId = '01910000-0000-7000-8000-00000000de01';
      const itemId = '01910000-0000-7000-8000-00000000de02';
      const command = 'git diff --no-ext-diff --no-textconv -- src/selected.ts';
      target.__LIN_E2E__.emitAgentCoreNotification({ type: 'turn/completed', threadId, turnId, turn: {
        id: turnId, provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } }, itemsView: 'full',
        status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, error: null,
        items: [{ id: itemId, type: 'commandExecution', provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
          command, description: 'Inspect selected changes', cwd: '/workspace/review', processId: null, status: 'completed', commandActions: [],
          modelCall: { disposition: 'replayable', identity: { namespace: null, name: 'bash' }, providerName: 'bash', schemaDigest: '0'.repeat(64),
            arguments: { storage: 'inline', value: { command, cwd: '/workspace/review' } } },
          aggregatedOutput: JSON.stringify({ stdout: 'diff --git a/src/selected.ts b/src/selected.ts\n-old\n+reviewed', stderr: '' }),
          exitCode: 0, durationMs: 1 },
        { id: '01910000-0000-7000-8000-00000000de03', type: 'agentMessage',
          provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: '01910000-0000-7000-8000-00000000de03' },
          text: 'Selected changes inspected. The output records this command only.', phase: 'final_answer', memoryCitation: null }],
      } });
    });
    const before = (await commandCalls(page)).length;
    await page.getByRole('button', { name: /Worked for/ }).click();
    const row = page.locator('.thread-tool').filter({ hasText: 'Inspect selected changes' });
    const group = page.locator('.thread-tool-activity-toggle').last();
    if (!await row.isVisible() && await group.isVisible()) await group.click();
    await row.locator('.thread-tool-toggle').click();
    await expect(row).toContainText('+reviewed');
    await expect(row).toContainText('git diff --no-ext-diff --no-textconv');
    await expect(page.getByRole('button', { name: 'Copy commit request' })).toHaveCount(0);
    await expect(page.locator('.thread-git-review')).toHaveCount(0);
    expect((await commandCalls(page)).length).toBe(before);
    await row.screenshot({ path: testInfo.outputPath(`native-git-${theme}.png`) });
  });
}
