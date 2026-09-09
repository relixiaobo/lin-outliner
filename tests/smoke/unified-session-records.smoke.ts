import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp, REPO_ROOT, type SmokeApp } from './electronApp';

test('Electron rebuilds ordinary records and preserves Trajectory and Composer reference IPC', async () => {
  const userDataDir = await mkdtemp('/tmp/tenon-record-smoke-');
  execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], {
    cwd: REPO_ROOT,
  });
  const ids = JSON.parse(
    execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupThreads.ts'), userDataDir], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .at(-1)!,
  );
  const records = join(userDataDir, 'thread-records');
  // Source history survives a lost derived tree, including a quarantined source.
  await rm(records, { recursive: true, force: true });
  let smoke: SmokeApp | undefined;
  try {
    smoke = await launchSmokeApp({ userDataDir });
    await expect
      .poll(() => smoke!.window.evaluate(() => window.lin!.startup.get()))
      .toMatchObject({
        status: 'ready',
        capabilities: { outline: 'ready', agent: 'ready' },
      });
    const entry = join(records, ids.healthyId, 'record.md');
    await expect.poll(() => readFile(entry, 'utf8').catch(() => '')).toContain('Conversation record');
    const text = await readFile(entry, 'utf8');
    const link = /\]\((turns\/[^)]+)\)/.exec(text)![1]!;
    expect(await readFile(join(records, ids.healthyId, link), 'utf8')).toContain('Local fixture only');
    expect(await stat(join(records, ids.unreadableId, 'record.md')).catch(() => null)).toBeNull();
    const trajectory = await smoke.window.evaluate(
      (threadId) => window.lin!.agentCoreRequest('thread/trajectory/read', { threadId, limit: 100 }),
      ids.healthyId,
    );
    const input = trajectory.records.find((record) => record.kind === 'input');
    expect(input).toBeDefined();
    const detail = await smoke.window.evaluate(
      ({ threadId, recordId }) =>
        window.lin!.agentCoreRequest('thread/trajectory/detail/read', { threadId, recordId }),
      { threadId: ids.healthyId, recordId: input!.id },
    );
    expect(JSON.stringify(detail)).toContain('Local fixture only');
    const references = await smoke.window.evaluate(
      (currentThreadId) =>
        window.lin!.agentCoreRequest('thread/references/search', { currentThreadId, query: 'Healthy' }),
      ids.healthyId,
    );
    expect(references.data.map((reference) => reference.threadId)).toContain(ids.healthyId);
  } finally {
    if (smoke) await closeSmokeApp(smoke);
    else await rm(userDataDir, { recursive: true, force: true });
  }
});
