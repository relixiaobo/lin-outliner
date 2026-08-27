import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core, type CoreTransactionPatch } from '../../src/core/core';
import { OutlineRuntimeWorkspace } from '../../src/outline/runtime/runtimeWorkspace';
import { WorkspaceTransactionLog } from '../../src/outline/runtime/storage';

let workspaceRoot = '';

describe('workspace today-node persistence', () => {
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = '';
  });

  test('the today node id is stable across a Runtime reopen with no mutations in between', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'outline-today-persist-'));
    const first = await openWorkspace(workspaceRoot);
    const todayId = first.projection().todayId;
    expect(todayId.startsWith('date:')).toBe(true);

    const second = await openWorkspace(workspaceRoot);
    expect(second.projection().todayId).toBe(todayId);
    expect(second.projection().nodes.some((node) => node.id === todayId)).toBe(true);
  });

  test('persists startup reconciliation before the first Runtime mutation depends on it', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'outline-today-reconcile-'));
    const seed = Core.new();
    const removedTodayId = seed.todayId();
    const removedToday = seed.state().nodes[removedTodayId]!;
    const removalPatch: CoreTransactionPatch = {
      revisionBefore: seed.revision(),
      revisionAfter: seed.revision() + 1,
      persistenceRevisionBefore: seed.persistenceRevision(),
      persistenceRevisionAfter: seed.persistenceRevision() + 1,
      systemChanged: false,
      nodes: [{ id: removedTodayId, before: null, after: removedToday }],
    };
    await seed.transaction('system', () => seed.applyRecoveryPatch(removalPatch));

    const store = new WorkspaceTransactionLog(workspaceRoot);
    await store.initialize(seed.serializeState());
    const first = await openWorkspace(workspaceRoot, { store });
    const reconciledTodayId = first.projection().todayId;
    expect(reconciledTodayId).not.toBe(removedTodayId);
    expect((await store.load()).replay).toEqual([]);

    await first.mutate({
      origin: 'local-user',
      changeSetHash: 'a'.repeat(64),
      diffHash: 'b'.repeat(64),
      summary: 'Created after startup reconciliation.',
      execute: (candidate) => {
        candidate.createNode(reconciledTodayId, null, 'After reconciliation');
      },
    });

    const reopened = await openWorkspace(workspaceRoot);
    expect(reopened.projection().todayId).toBe(reconciledTodayId);
    expect(reopened.projection().nodes).toContainEqual(expect.objectContaining({
      content: expect.objectContaining({ text: 'After reconciliation' }),
    }));
  });
});
type WorkspaceOpenOptions = NonNullable<Parameters<typeof OutlineRuntimeWorkspace.open>[1]>;

function openWorkspace(
  root: string,
  options: WorkspaceOpenOptions = {},
): Promise<OutlineRuntimeWorkspace> {
  return OutlineRuntimeWorkspace.open(root, {
    ...options,
    contentRoot: options.contentRoot ?? path.join(root, 'content'),
  });
}
