import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalSha256 } from '../../src/outline/contract/canonical';
import { OutlineRuntimeWorkspace } from '../../src/outline/runtime';
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

  test('rejects revert when one affected after value changed and writes no recovery Operation', async () => {
    const root = await makeRoot();
    const nodeId = `node:${crypto.randomUUID()}`;
    const workspace = await OutlineRuntimeWorkspace.open(root);
    const created = await workspace.mutate(createRequest('Conflict row', { nodeId }));
    await workspace.mutate(updateRequest(nodeId, 'Changed after original Operation'));

    await expect(workspace.revert(created.operationId, { origin: 'local-user' })).rejects.toMatchObject({
      outlineError: { code: 'revert_conflict' },
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
});

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
