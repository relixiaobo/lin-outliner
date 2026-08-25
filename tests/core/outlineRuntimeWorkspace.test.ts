import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import type { ProjectionResult, Selector } from '../../src/outline/contract/schemas';
import { decodeEventCursor, OutlineRuntimeWorkspace } from '../../src/outline/runtime';
import { OutlineRuntimeRouter } from '../../src/outline/runtime/server';
import { WorkspaceTransactionLog } from '../../src/outline/runtime/storage';

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('OutlineRuntimeWorkspace', () => {
  test('publishes a candidate only after the transaction record fsyncs', async () => {
    const root = await makeRoot();
    let workspace: OutlineRuntimeWorkspace | undefined;
    const store = new WorkspaceTransactionLog(root, {
      afterTransactionFsync: () => {
        expect(workspace?.projection().nodes.some((node) => node.content.text === 'Published after fsync')).toBe(false);
      },
    });
    workspace = await OutlineRuntimeWorkspace.open(root, { store, instanceId: 'runtime:publish-order' });

    const operation = await workspace.mutate(createRequest('Published after fsync'));

    expect(operation.revisionAfter).toBe(operation.revisionBefore + 1);
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Published after fsync')).toBe(true);
    expect((await store.operations()).map((entry) => entry.operationId)).toEqual([operation.operationId]);
  });

  test('keeps Runtime Operation history out of Core local undo persistence', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);

    await workspace.mutate(createRequest('Runtime-owned history'));

    const loaded = await workspace.store.load();
    expect(loaded.snapshot?.local.operationHistory).toEqual([]);
    expect(loaded.replay.every((entry) => (
      entry.local.operationHistoryUpserts.length === 0
      && entry.local.operationHistoryDeletes.length === 0
    ))).toBe(true);
    expect(loaded.operations).toHaveLength(1);
  });

  test('discards the candidate when recovery capacity rejects admission', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root, {
      storeOptions: { recoveryBudgetBytes: 1 },
    });
    const before = workspace.documentState();

    await expect(workspace.mutate(createRequest('Rejected candidate'))).rejects.toMatchObject({
      outlineError: { code: 'recovery_capacity_exceeded' },
    });

    expect(workspace.documentState()).toEqual(before);
    expect(await workspace.store.operations()).toEqual([]);
  });

  test('publishes resumable recovery-expiry Events during live maintenance', async () => {
    const root = await makeRoot();
    let nowMs = Date.parse('2035-01-01T00:00:00.000Z');
    const workspace = await OutlineRuntimeWorkspace.open(root, {
      instanceId: 'runtime:maintenance-live',
      now: () => new Date(nowMs),
      storeOptions: { minimumRetentionDays: 1, minimumRetentionOperations: 0 },
    });
    const operation = await workspace.mutate(createRequest('Expiring recovery'));
    const events: import('../../src/outline/contract').OutlineEvent[] = [];
    const unsubscribe = workspace.subscribe((event) => events.push(event));

    nowMs += 2 * 86_400_000;
    await workspace.maintain();
    unsubscribe();

    expect((await workspace.store.operation(operation.operationId))?.recovery.state).toBe('expired');
    expect(events).toEqual([expect.objectContaining({
      type: 'operation.recovery-expired',
      instanceId: workspace.instanceId,
      revision: workspace.revision(),
      recovery: {
        operationIds: [operation.operationId],
        recoveryPatchIds: [operation.recovery.recoveryPatchId],
      },
    })]);
    expect(decodeEventCursor(events[0]!.cursor, { instanceId: workspace.instanceId })).toMatchObject({
      sequence: events[0]!.sequence,
      revision: workspace.revision(),
    });
  });

  test('prunes eligible recovery at startup with the new Runtime identity', async () => {
    const root = await makeRoot();
    let nowMs = Date.parse('2036-01-01T00:00:00.000Z');
    const options = {
      now: () => new Date(nowMs),
      storeOptions: { minimumRetentionDays: 1, minimumRetentionOperations: 0 },
    };
    const first = await OutlineRuntimeWorkspace.open(root, { ...options, instanceId: 'runtime:startup-first' });
    const operation = await first.mutate(createRequest('Startup expiry'));
    const baseline = (await first.store.health()).transactionLog.eventSequence;

    nowMs += 2 * 86_400_000;
    const restarted = await OutlineRuntimeWorkspace.open(root, { ...options, instanceId: 'runtime:startup-second' });
    const [event] = await restarted.store.eventsAfter(baseline);

    expect((await restarted.store.operation(operation.operationId))?.recovery.state).toBe('expired');
    expect(event).toMatchObject({
      type: 'operation.recovery-expired',
      instanceId: 'runtime:startup-second',
      revision: restarted.revision(),
    });
    expect(decodeEventCursor(event!.cursor, { instanceId: restarted.instanceId })).not.toBeNull();
  });

  test('does not reverse a durable Operation when post-settlement compaction maintenance fails', async () => {
    const root = await makeRoot();
    let snapshotRenames = 0;
    const store = new WorkspaceTransactionLog(root, {
      compactionRecords: 1,
      afterSnapshotRename: () => {
        snapshotRenames += 1;
        if (snapshotRenames === 2) throw new Error('injected maintenance failure');
      },
    });
    const workspace = await OutlineRuntimeWorkspace.open(root, { store });

    const first = await workspace.mutate(createRequest('Committed before maintenance failure'));
    expect(first.kind).toBe('outline.operation');
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Committed before maintenance failure')).toBe(true);

    const second = await workspace.mutate(createRequest('Writable after maintenance reload'));
    expect(second.revisionBefore).toBe(first.revisionAfter);
    const restarted = await OutlineRuntimeWorkspace.open(root);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Committed before maintenance failure')).toBe(true);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Writable after maintenance reload')).toBe(true);
  });

  test('rejects an exact patch mismatch without changing live or durable state', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const before = workspace.documentState();

    await expect(workspace.mutate({
      ...createRequest('Mismatched candidate'),
      expectedPatchHash: '0'.repeat(64),
    })).rejects.toMatchObject({
      outlineError: { code: 'diff_mismatch' },
    });

    expect(workspace.documentState()).toEqual(before);
    expect(await workspace.store.operations()).toEqual([]);
  });

  test('keeps document revisions monotonic across Runtime restart', async () => {
    const root = await makeRoot();
    const firstRuntime = await OutlineRuntimeWorkspace.open(root, { instanceId: 'runtime:first' });
    const first = await firstRuntime.mutate(createRequest('Before restart'));

    const restarted = await OutlineRuntimeWorkspace.open(root, { instanceId: 'runtime:second' });
    expect(restarted.revision()).toBe(first.revisionAfter);
    const second = await restarted.mutate(createRequest('After restart'));

    expect(second.revisionBefore).toBe(first.revisionAfter);
    expect(second.revisionAfter).toBe(first.revisionAfter + 1);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Before restart')).toBe(true);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'After restart')).toBe(true);
  });

  test('returns the original Operation for an idempotent request without executing twice', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);
    let executions = 0;
    const request = createRequest('Idempotent row', {
      idempotencyKey: 'request:stable',
      idempotencyPayloadHash: 'a'.repeat(64),
      onExecute: () => { executions += 1; },
    });

    const first = await workspace.mutate(request);
    const retry = await workspace.mutate(request);

    expect(retry).toEqual(first);
    expect(executions).toBe(1);
    expect(await workspace.store.operations()).toHaveLength(1);
  });

  test('serializes concurrent mutations into one revision and Event sequence', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root, { instanceId: 'runtime:serialized' });

    const [first, second] = await Promise.all([
      workspace.mutate(createRequest('Concurrent first')),
      workspace.mutate(createRequest('Concurrent second')),
    ]);

    expect(first.revisionAfter).toBe(second.revisionBefore);
    expect((await workspace.store.eventsAfter(0)).map((event) => event.sequence)).toEqual([1, 2]);
    expect((await workspace.store.operations()).map((operation) => operation.operationId)).toEqual([
      first.operationId,
      second.operationId,
    ]);
  });

  test('persists guarded revert and revert-of-revert as new Operations', async () => {
    const root = await makeRoot();
    const nodeId = `node:${crypto.randomUUID()}`;
    const workspace = await OutlineRuntimeWorkspace.open(root, { instanceId: 'runtime:revert' });
    const created = await workspace.mutate(createRequest('Reversible row', { nodeId }));
    const createdState = workspace.documentState();

    const reverted = await workspace.revert(created.operationId, { origin: 'local-user' });
    expect(workspace.documentState().nodes[nodeId]).toBeUndefined();
    expect(reverted.revertsOperationId).toBe(created.operationId);
    const redone = await workspace.revert(reverted.operationId, { origin: 'local-user' });

    expect(workspace.documentState()).toEqual(createdState);
    expect(redone.revertsOperationId).toBe(reverted.operationId);
    const operations = await workspace.store.operations();
    expect(operations.map((operation) => operation.recovery.state)).toEqual([
      'reverted',
      'reverted',
      'available',
    ]);
    const restarted = await OutlineRuntimeWorkspace.open(root);
    expect(restarted.documentState()).toEqual(createdState);
  });

  test('reconstructs consecutive undo and redo history across Runtime restart', async () => {
    const root = await makeRoot();
    const firstNodeId = `node:${crypto.randomUUID()}`;
    const secondNodeId = `node:${crypto.randomUUID()}`;
    const workspace = await OutlineRuntimeWorkspace.open(root);
    await workspace.mutate(createRequest('First history row', { nodeId: firstNodeId }));
    await workspace.mutate(createRequest('Second history row', { nodeId: secondNodeId }));

    await workspace.undo({ origin: 'local-user' });
    expect(workspace.documentState().nodes[secondNodeId]).toBeUndefined();
    expect(workspace.documentState().nodes[firstNodeId]).toBeDefined();
    await workspace.undo({ origin: 'local-user' });
    expect(workspace.documentState().nodes[firstNodeId]).toBeUndefined();

    const restarted = await OutlineRuntimeWorkspace.open(root);
    await restarted.redo({ origin: 'local-user' });
    expect(restarted.documentState().nodes[firstNodeId]).toBeDefined();
    expect(restarted.documentState().nodes[secondNodeId]).toBeUndefined();
    await restarted.redo({ origin: 'local-user' });
    expect(restarted.documentState().nodes[secondNodeId]).toBeDefined();
    await expect(restarted.redo({ origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'not_found' },
    });

    const restartedAgain = await OutlineRuntimeWorkspace.open(root);
    await restartedAgain.undo({ origin: 'local-user' });
    expect(restartedAgain.documentState().nodes[firstNodeId]).toBeDefined();
    expect(restartedAgain.documentState().nodes[secondNodeId]).toBeUndefined();
  });

  test('scopes undo by origin and guards the selected Operation', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const userNodeId = `node:${crypto.randomUUID()}`;
    const agentNodeId = `node:${crypto.randomUUID()}`;
    const newestUserNodeId = `node:${crypto.randomUUID()}`;
    await workspace.mutate(createRequest('User row', { nodeId: userNodeId }));
    await workspace.mutate(createRequest('Agent row', { nodeId: agentNodeId }));
    await workspace.mutate(createRequest('Newest user row', { nodeId: newestUserNodeId }));
    await workspace.mutate(updateRequest(userNodeId, 'Edited by user'));
    const agentOperation = await workspace.mutate({
      ...updateRequest(agentNodeId, 'Edited by agent'),
      origin: 'built-in-agent',
    });
    const newestUserOperation = await workspace.mutate(updateRequest(newestUserNodeId, 'Edited newest by user'));

    const operationsBeforeConflict = await workspace.store.operations();
    await expect(workspace.undo({
      origin: 'built-in-agent',
      selectionOrigin: 'built-in-agent',
      expectOperationId: newestUserOperation.operationId,
    })).rejects.toMatchObject({
      outlineError: {
        code: 'stale_revision',
        details: {
          expectedOperationId: newestUserOperation.operationId,
          actualOperationId: agentOperation.operationId,
        },
      },
    });
    expect(await workspace.store.operations()).toEqual(operationsBeforeConflict);

    const agentUndo = await workspace.undo({
      origin: 'local-user',
      selectionOrigin: 'built-in-agent',
      expectOperationId: agentOperation.operationId,
    });
    expect(agentUndo.revertsOperationId).toBe(agentOperation.operationId);
    expect(workspace.documentState().nodes[agentNodeId]?.description).toBeUndefined();
    expect(workspace.documentState().nodes[userNodeId]?.description).toBe('Edited by user');
    expect(workspace.documentState().nodes[newestUserNodeId]?.description).toBe('Edited newest by user');

    const restarted = await OutlineRuntimeWorkspace.open(root);
    const agentRedo = await restarted.redo({
      origin: 'local-user',
      selectionOrigin: 'built-in-agent',
      expectOperationId: agentUndo.operationId,
    });
    expect(agentRedo.revertsOperationId).toBe(agentUndo.operationId);
    expect(restarted.documentState().nodes[agentNodeId]?.description).toBe('Edited by agent');
    expect(restarted.documentState().nodes[userNodeId]?.description).toBe('Edited by user');
    expect(restarted.documentState().nodes[newestUserNodeId]?.description).toBe('Edited newest by user');

    const globalRoot = await makeRoot();
    const globalWorkspace = await OutlineRuntimeWorkspace.open(globalRoot);
    const globalUserNodeId = `node:${crypto.randomUUID()}`;
    const globalAgentNodeId = `node:${crypto.randomUUID()}`;
    await globalWorkspace.mutate(createRequest('Global user row', { nodeId: globalUserNodeId }));
    await globalWorkspace.mutate(createRequest('Global agent row', { nodeId: globalAgentNodeId }));
    await globalWorkspace.mutate(updateRequest(globalUserNodeId, 'Global user edit'));
    const globalAgentOperation = await globalWorkspace.mutate({
      ...updateRequest(globalAgentNodeId, 'Global agent edit'),
      origin: 'built-in-agent',
    });

    const globalUndo = await globalWorkspace.undo({
      origin: 'local-user',
      selectionOrigin: 'all',
      expectOperationId: globalAgentOperation.operationId,
    });
    expect(globalUndo.revertsOperationId).toBe(globalAgentOperation.operationId);
    expect(globalWorkspace.documentState().nodes[globalAgentNodeId]?.description).toBeUndefined();
    expect(globalWorkspace.documentState().nodes[globalUserNodeId]?.description).toBe('Global user edit');
  });

  test('rejects revert when one affected after value changed and writes no recovery Operation', async () => {
    const root = await makeRoot();
    const nodeId = `node:${crypto.randomUUID()}`;
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const created = await workspace.mutate(createRequest('Conflict row', { nodeId }));
    await workspace.mutate(updateRequest(nodeId, 'Changed after original Operation'));

    await expect(workspace.revert(created.operationId, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: {
        code: 'revert_conflict',
        details: {
          conflictDiff: {
            kind: 'outline.revert-conflict-diff',
            operationId: created.operationId,
            currentRevision: workspace.revision(),
            changedPreconditions: [{
              id: nodeId,
              expectedAfterDigest: expect.any(String),
              actualDigest: canonicalSha256(workspace.documentState().nodes[nodeId]),
            }],
          },
        },
      },
    });

    expect(workspace.documentState().nodes[nodeId]?.description).toBe('Changed after original Operation');
    expect(await workspace.store.operations()).toHaveLength(2);
  });

  test('blocks the stale process after fsync-before-ack failure while restart publishes the committed state', async () => {
    const root = await makeRoot();
    let fail = true;
    const store = new WorkspaceTransactionLog(root, {
      afterTransactionFsync: () => {
        if (fail) {
          fail = false;
          throw new Error('injected acknowledgement crash');
        }
      },
    });
    const workspace = await OutlineRuntimeWorkspace.open(root, { store });

    await expect(workspace.mutate(createRequest('Committed without acknowledgement'))).rejects.toMatchObject({
      outlineError: { code: 'operation_settlement_unknown' },
    });
    expect(workspace.projection().nodes.some((node) => node.content.text === 'Committed without acknowledgement')).toBe(false);
    await expect(workspace.mutate(createRequest('Must not run on stale Core'))).rejects.toMatchObject({
      outlineError: { code: 'operation_settlement_unknown' },
    });

    const restarted = await OutlineRuntimeWorkspace.open(root);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Committed without acknowledgement')).toBe(true);
    expect(restarted.projection().nodes.some((node) => node.content.text === 'Must not run on stale Core')).toBe(false);
  });

  test('pages newest-first Operation history and filters trusted causation', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const first = await workspace.mutate({
      ...createRequest('Causation match'),
      origin: 'built-in-agent',
      causation: { threadId: 'thread:one', turnId: 'turn:one', itemId: 'item:one' },
    });
    const second = await workspace.mutate(createRequest('Newest Operation'));
    const router = new OutlineRuntimeRouter(workspace);

    const firstPage = await logPage(router, { limit: 1 });
    expect(firstPage.operations.map((operation) => operation.operationId)).toEqual([second.operationId]);
    expect(firstPage.cursor).toEqual(expect.any(String));
    const secondPage = await logPage(router, { limit: 1, cursor: firstPage.cursor });
    expect(secondPage.operations.map((operation) => operation.operationId)).toEqual([first.operationId]);
    expect(secondPage.cursor).toBeUndefined();

    const causal = await logPage(router, {
      threadId: 'thread:one',
      turnId: 'turn:one',
      itemId: 'item:one',
    });
    expect(causal.operations.map((operation) => operation.operationId)).toEqual([first.operationId]);
    await expect(logPage(router, {
      limit: 1,
      origin: 'local-user',
      cursor: firstPage.cursor,
    })).rejects.toMatchObject({ code: 'stale_revision' });
  });

  test('pages every affected Node ID from retained recovery data', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const operation = await workspace.mutate({
      origin: 'external-client',
      changeSetHash: canonicalSha256({ kind: 'bulk-create' }),
      diffHash: canonicalSha256({ kind: 'bulk-create-diff' }),
      summary: 'Created a large affected set.',
      execute: (core) => {
        const parentId = core.projection().todayId;
        for (let index = 0; index < 1_001; index += 1) {
          core.createNode(parentId, null, `Bulk ${index}`, `node:${crypto.randomUUID()}`);
        }
      },
    });
    expect(operation.affectedNodeIdsTruncated).toBe(true);
    expect(operation.affectedNodeIdsCursor).toEqual(expect.any(String));
    const router = new OutlineRuntimeRouter(workspace);

    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await logPage(router, {
        operationId: operation.operationId,
        limit: 400,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(...page.affectedNodeIds!.nodeIds);
      cursor = page.cursor;
    } while (cursor);
    expect(pages).toHaveLength(operation.affectedNodeCount);
    expect(canonicalSha256(pages)).toBe(operation.affectedNodeIdsHash);

    const resumed = await logPage(router, {
      operationId: operation.operationId,
      cursor: operation.affectedNodeIdsCursor,
    });
    expect(resumed.affectedNodeIds).toMatchObject({ offset: 1_000, totalCount: operation.affectedNodeCount });
    expect(resumed.affectedNodeIds?.nodeIds).toEqual(pages.slice(1_000));
  });

  test('derives bounded many defaults for every multi-target Runtime read selector', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const nodeIds = [`node:${crypto.randomUUID()}`, `node:${crypto.randomUUID()}`];
    const marker = `runtime-read-${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Create Runtime read fixtures'),
      execute: (core) => {
        const parentId = core.projection().todayId;
        core.createNode(parentId, null, `${marker} alpha`, nodeIds[0]);
        core.createNode(parentId, null, `${marker} beta`, nodeIds[1]);
      },
    });
    const searchId = `node:${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Create Runtime read Saved Search'),
      execute: (core) => {
        core.createSearchNode(core.projection().searchesId, null, {
          title: 'Bounded selector fixture',
          query: { kind: 'rule', op: 'STRING_MATCH', text: marker },
        }, undefined, searchId);
      },
    });
    const selectors: Array<{ selector: Selector; max: number }> = [
      { selector: { by: 'ids', ids: nodeIds }, max: 2 },
      {
        selector: {
          by: 'query',
          query: { kind: 'rule', op: 'STRING_MATCH', text: marker },
          limit: 10,
        },
        max: 10,
      },
      { selector: { by: 'search', id: searchId, limit: 10 }, max: 10 },
    ];
    const router = new OutlineRuntimeRouter(workspace);

    for (const command of ['show', 'export'] as const) {
      for (const { selector, max } of selectors) {
        const response = await router.handle({
          protocolVersion: 1,
          requestId: `request:${command}:${selector.by}`,
          command,
          input: { selector },
        }, { origin: 'local-user' });
        expect(response.ok).toBe(true);
        if (!response.ok) continue;
        const result = response.data as ProjectionResult;
        const resultIds = result.nodes.map((node) => (node as { id: string }).id);
        if (selector.by === 'ids') expect(resultIds).toEqual(nodeIds);
        else expect(new Set(resultIds)).toEqual(new Set(nodeIds));
        expect(result.projection.targets).toEqual({
          target: { selector, cardinality: 'many', max },
        });
      }
    }
  });

  test('accepts standalone read Projections and rejects conflicting duplicate selectors', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const firstId = `node:${crypto.randomUUID()}`;
    const secondId = `node:${crypto.randomUUID()}`;
    await workspace.mutate({
      ...createRequest('Create standalone Projection fixtures'),
      execute: (core) => {
        const parentId = core.projection().todayId;
        core.createNode(parentId, null, 'Standalone first', firstId);
        core.createNode(parentId, null, 'Standalone second', secondId);
      },
    });
    const router = new OutlineRuntimeRouter(workspace);
    const projection = {
      kind: 'summary' as const,
      targets: {
        target: {
          selector: { by: 'id' as const, id: firstId },
          cardinality: 'one' as const,
        },
      },
      page: { limit: 1 },
    };

    const standalone = await router.handle({
      protocolVersion: 1,
      requestId: 'request:standalone-projection',
      command: 'show',
      input: { projection },
    }, { origin: 'local-user' });
    expect(standalone.ok).toBe(true);
    if (standalone.ok) {
      expect((standalone.data as ProjectionResult).nodes).toEqual([
        expect.objectContaining({ id: firstId }),
      ]);
    }

    const conflicting = await router.handle({
      protocolVersion: 1,
      requestId: 'request:conflicting-projection',
      command: 'show',
      input: { selector: { by: 'id', id: secondId }, projection },
    }, { origin: 'local-user' });
    expect(conflicting).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        category: 'usage',
        message: 'show Selector conflicts with the Selector declared by --projection.',
      },
    });
  });

  test('rejects a handler result that violates the executable capability schema', async () => {
    const root = await makeRoot();
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const router = new OutlineRuntimeRouter(workspace);
    router.register('show', () => ({ nodes: 'not-an-array' }));

    const response = await router.handle({
      protocolVersion: 1,
      requestId: 'request:invalid-handler-result',
      command: 'show',
      input: { selector: { by: 'alias', alias: 'today' } },
    }, { origin: 'local-user' });
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'internal_error', category: 'internal' },
    });
  });
});

async function logPage(router: OutlineRuntimeRouter, input: Record<string, unknown>) {
  const response = await router.handle({
    protocolVersion: 1,
    requestId: `request:${crypto.randomUUID()}`,
    command: 'log',
    input,
  }, { origin: 'local-user' });
  if (!response.ok) throw response.error;
  return response.data as import('../../src/outline/contract').OperationLogPage;
}

interface CreateRequestOptions {
  readonly nodeId?: string;
  readonly idempotencyKey?: string;
  readonly idempotencyPayloadHash?: string;
  readonly onExecute?: () => void;
}

function createRequest(text: string, options: CreateRequestOptions = {}) {
  const payload = {
    kind: 'create',
    text,
    ...(options.nodeId ? { nodeId: options.nodeId } : {}),
  };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Created ${text}.`,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.idempotencyPayloadHash ? { idempotencyPayloadHash: options.idempotencyPayloadHash } : {}),
    execute: (core: Parameters<Parameters<OutlineRuntimeWorkspace['mutate']>[0]['execute']>[0]) => {
      options.onExecute?.();
      core.createNode(core.projection().todayId, null, text, options.nodeId);
    },
  };
}

function updateRequest(nodeId: string, description: string) {
  const payload = { kind: 'update', nodeId, description };
  return {
    origin: 'local-user' as const,
    changeSetHash: canonicalSha256(payload),
    diffHash: canonicalSha256({ ...payload, kind: 'diff' }),
    summary: `Updated ${nodeId}.`,
    execute: (core: Parameters<Parameters<OutlineRuntimeWorkspace['mutate']>[0]['execute']>[0]) => {
      core.updateNodeDescription(nodeId, description);
    },
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-outline-runtime-workspace-'));
  roots.push(root);
  return root;
}
