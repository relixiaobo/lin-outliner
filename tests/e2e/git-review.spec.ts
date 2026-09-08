import { expect, test, type Page } from '@playwright/test';
import { clipboardText, commandCalls, openMockedApp } from './outlinerMock';

async function reviewFixture(page: Page, mode: 'capture' | 'preview' | 'non-git' = 'capture') {
  await openMockedApp(page);
  await page.evaluate(async (mode) => {
    const target = window as Window & { lin: { agentCoreRequest: (method: string, input: object) => Promise<{ data: { id: string }[] }> }; __LIN_E2E__: { emitAgentCoreNotification: (value: unknown) => void } };
    const threadId = (await target.lin.agentCoreRequest('thread/list', {})).data[0]!.id;
    const turnId = '01910000-0000-7000-8000-00000000de01'; const itemId = '01910000-0000-7000-8000-00000000de02';
    const operation = mode === 'preview' ? 'preview' : 'capture'; const command = `git-review ${operation} --input - --output json`;
    const baseline = { root: '/workspace/review', gitDirectory: '/workspace/review/.git', commonDirectory: '/workspace/review/.git', identity: 'd'.repeat(64), head: 'a'.repeat(40), ref: 'refs/heads/feature' };
    const evidence = { version: 1, operation, outcome: mode === 'preview' ? 'previewed' : 'reviewed', cwd: '/workspace/review', observedAt: 1,
      baseline: mode === 'non-git' ? null : baseline, paths: mode === 'preview' ? [] : [
        { path: 'src/selected.ts', status: ' M', previousPath: null, kind: 'file', bytes: 42, binary: false, diff: '-old\n+reviewed' },
        { path: 'assets/new.bin', status: '??', previousPath: null, kind: 'file', bytes: 128, binary: true, diff: '' },
      ], preview: mode === 'preview' ? { remote: 'origin', url: 'https://github.com/example/repo.git', branch: 'feature', upstream: 'origin/feature', remoteHead: null,
        commits: ['a'.repeat(40)], base: 'main', baseOid: 'b'.repeat(40), provider: 'github', repository: 'example/repo' } : null,
      commit: null, parent: null, pullRequest: null, message: 'Historical evidence requires live validation.', truncatedPaths: 0,
      review: { id: 'c'.repeat(64), schemaVersion: 1, byteLength: 100, kind: 'gitReviewEvidence', mimeType: 'application/vnd.tenon.agent-context+json' } };
    target.__LIN_E2E__.emitAgentCoreNotification({ type: 'turn/completed', threadId, turnId, turn: {
      id: turnId, provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } }, itemsView: 'full',
      status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, error: null,
      items: [{ id: itemId, type: 'commandExecution', provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
        command, description: 'Review selected changes', cwd: '/workspace/review', processId: null, status: 'completed', commandActions: [],
        modelCall: { disposition: 'replayable', identity: { namespace: null, name: 'bash' }, providerName: 'bash', schemaDigest: '0'.repeat(64), arguments: { storage: 'inline', value: { command, stdin: '{}' } } },
        aggregatedOutput: JSON.stringify({ stdout: JSON.stringify({ gitReview: evidence }), stderr: '' }), exitCode: 0, durationMs: 1 },
      { id: '01910000-0000-7000-8000-00000000de03', type: 'agentMessage', provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: '01910000-0000-7000-8000-00000000de03' }, text: 'Review ready.', phase: 'final_answer', memoryCitation: null }],
    } });
  }, mode);
  await page.getByRole('button', { name: /Worked for/ }).click();
  const row = page.locator('.thread-tool').filter({ hasText: 'Review selected changes' });
  const group = page.locator('.thread-tool-activity-toggle').last();
  if (!await row.isVisible() && await group.isVisible()) await group.click();
  await row.locator('.thread-tool-toggle').click();
  const panel = row.getByRole('region', { name: 'Git review' });
  await expect(panel).toBeVisible(); return panel;
}
for (const theme of ['light', 'dark'] as const) {
  test(`review selection copies an explicit commit request without executing it (${theme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    const panel = await reviewFixture(page);
    const before = (await commandCalls(page)).length;
    const copy = panel.getByRole('button', { name: 'Copy commit request' }); await expect(copy).toBeDisabled();
    await panel.getByRole('checkbox', { name: 'src/selected.ts' }).focus();
    await page.keyboard.press('Space');
    await expect(panel.getByRole('checkbox', { name: 'src/selected.ts' })).toBeChecked();
    await panel.getByRole('textbox', { name: 'Commit message' }).fill('Commit the reviewed change');
    await expect(copy).toBeEnabled(); await copy.click();
    await expect(panel.getByRole('status')).toContainText('Copied');
    const request = await clipboardText(page); expect(request).toContain('src/selected.ts'); expect(request).not.toContain('assets/new.bin'); expect(request).toContain('c'.repeat(64));
    expect((await commandCalls(page)).length).toBe(before);
    await panel.screenshot({ path: testInfo.outputPath(`git-review-${theme}.png`) });
  });
}
test('publication preview shows remote and range without publishing', async ({ page }) => {
  const panel = await reviewFixture(page, 'preview');
  await expect(panel).toContainText('https://github.com/example/repo.git'); await expect(panel).toContainText('feature → main');
  await expect(panel).toContainText('origin/feature'); await expect(panel).toContainText('b'.repeat(40));
  await expect(panel.getByRole('button')).toHaveCount(0);
});
test('non-Git file review has no commit controls', async ({ page }) => {
  const panel = await reviewFixture(page, 'non-git');
  await expect(panel).toContainText('File review only'); await expect(panel.getByRole('checkbox')).toHaveCount(0);
});
