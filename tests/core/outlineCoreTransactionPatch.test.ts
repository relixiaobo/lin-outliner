import { describe, expect, test } from 'bun:test';
import { DOCUMENT_COMMANDS, RUNTIME_DOCUMENT_COMMANDS } from '../../src/core/commands';
import { Core, type CoreTransactionPatch } from '../../src/core/core';
import { plainText } from '../../src/core/types';

describe('Core transaction patches', () => {
  test('captures immutable complete before and after Nodes in sorted order', async () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    const createdId = `node:${crypto.randomUUID()}`;
    const { patch } = await core.transactionWithPatch('user', () => {
      core.createNode(parentId, null, 'Created', createdId);
      core.updateNodeDescription(createdId, 'Description');
    }, { operationId: 'op:create', command: 'create_node' });

    expect(patch.nodes.map((entry) => entry.id)).toEqual(
      [...patch.nodes.map((entry) => entry.id)].sort(),
    );
    expect(patch.nodes).toContainEqual(expect.objectContaining({
      id: createdId,
      before: null,
      after: expect.objectContaining({
        content: plainText('Created'),
        description: 'Description',
      }),
    }));
    expect(patch.revisionAfter).toBe(patch.revisionBefore + 1);
    expect(patch.persistenceRevisionAfter).toBe(patch.persistenceRevisionBefore + 1);
    expect(Object.isFrozen(patch)).toBe(true);
    expect(Object.isFrozen(patch.nodes)).toBe(true);
    expect(Object.isFrozen(patch.nodes.find((entry) => entry.id === createdId)?.after)).toBe(true);
  });

  test('retains the first before value across cooperative commit chunks', async () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    const nodes = Array.from({ length: 8 }, (_, index) => ({
      content: plainText(`Chunk ${index}`),
      children: [],
    }));

    const { patch } = await core.transactionWithPatch('agent', () =>
      core.createNodeTreeBatchesYieldingFocus([{ parentId, nodes }], {
        commitEveryNodes: 1,
        yieldEveryNodes: 1,
      }), { operationId: 'op:chunks', tool: 'outline' });

    const created = patch.nodes.filter((entry) => entry.before === null);
    expect(created).toHaveLength(nodes.length);
    expect(created.every((entry) => entry.after !== null)).toBe(true);
    expect(patch.nodes.find((entry) => entry.id === parentId)?.before?.children).not.toEqual(
      patch.nodes.find((entry) => entry.id === parentId)?.after?.children,
    );
  });

  test('rolls back every chunk after a late Change failure', async () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    let yields = 0;

    await expect(core.transactionWithPatch('agent', () =>
      core.createNodeTreeBatchesYieldingFocus([{
        parentId,
        nodes: Array.from({ length: 8 }, (_, index) => ({
          content: plainText(`Transient ${index}`),
          children: [],
        })),
      }], {
        commitEveryNodes: 1,
        yieldEveryNodes: 1,
        yield: async () => {
          yields += 1;
          if (yields === 5) throw new Error('late failure');
        },
      }), { operationId: 'op:late-failure', tool: 'outline' })).rejects.toThrow('late failure');

    expect(core.projection().nodes.some((node) => node.content.text.startsWith('Transient '))).toBe(false);
    expect(core.operationHistory({ action: 'list', origin: 'agent' }).items).toEqual([]);
  });

  test('applies a guarded trusted recovery patch for create update move and delete', async () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    const sourceId = `node:${crypto.randomUUID()}`;
    const destinationId = `node:${crypto.randomUUID()}`;
    const childId = `node:${crypto.randomUUID()}`;
    core.createNode(parentId, null, 'Source', sourceId);
    core.createNode(parentId, null, 'Destination', destinationId);
    core.createNode(sourceId, null, 'Child', childId);
    const before = core.state();

    const { patch } = await core.transactionWithPatch('user', () => {
      core.updateNodeDescription(sourceId, 'Changed');
      core.moveNode(childId, destinationId, 0);
      core.deleteNode(sourceId);
    }, { operationId: 'op:mixed', command: 'outline' });

    expect(core.state().nodes[sourceId]).toBeUndefined();
    expect(core.state().nodes[childId]?.parentId).toBe(destinationId);
    await core.transaction('system', () => core.applyRecoveryPatch(patch));
    const restored = core.state();
    expect(restored.nodes[sourceId]).toEqual(before.nodes[sourceId]);
    expect(restored.nodes[childId]).toEqual(before.nodes[childId]);
    expect(restored.nodes[destinationId]).toEqual(before.nodes[destinationId]);
  });

  test('captures and restores a permanent-delete subtree with every healed reference', async () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    const firstId = `node:${crypto.randomUUID()}`;
    const targetId = `node:${crypto.randomUUID()}`;
    const childId = `node:${crypto.randomUUID()}`;
    const lastId = `node:${crypto.randomUUID()}`;
    const referenceParentId = `node:${crypto.randomUUID()}`;
    const referenceId = `node:${crypto.randomUUID()}`;
    const inlineSourceId = `node:${crypto.randomUUID()}`;
    core.createNode(parentId, null, 'First', firstId);
    core.createNode(parentId, null, 'Target', targetId);
    core.createNode(targetId, null, 'Child', childId);
    core.createNode(parentId, null, 'Last', lastId);
    core.createNode(parentId, null, 'Reference parent', referenceParentId);
    core.createNode(referenceParentId, null, 'Reference source', referenceId);
    core.replaceNodeWithReference(referenceId, targetId);
    const treeReferenceId = core.state().nodes[referenceParentId]!.children.find((id) => (
      core.state().nodes[id]?.type === 'reference' && core.state().nodes[id]?.targetId === targetId
    ));
    expect(treeReferenceId).toBeDefined();
    core.createNode(parentId, null, 'Inline source', inlineSourceId);
    core.applyNodeTextPatch(inlineSourceId, {
      ops: [{
        type: 'replace',
        from: 0,
        to: 'Inline source'.length,
        content: {
          text: 'Inline source',
          marks: [],
          inlineRefs: [{ offset: 0, target: { kind: 'node', nodeId: targetId } }],
        },
      }],
    });
    const before = core.state();

    const { patch } = await core.transactionWithPatch('user', () => {
      core.deleteNode(targetId);
    }, { operationId: 'op:permanent-delete', command: 'delete_node' });

    expect(patch.nodes.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      parentId,
      targetId,
      childId,
      treeReferenceId!,
      inlineSourceId,
    ]));
    await core.transaction('system', () => core.applyRecoveryPatch(patch));
    expect(core.state()).toEqual(before);
    expect(core.state().nodes[parentId]!.children).toEqual(before.nodes[parentId]!.children);
  });

  test('makes a recovery transaction patch reversible for revert-of-revert', async () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    const targetId = `node:${crypto.randomUUID()}`;
    core.createNode(parentId, null, 'Original', targetId);

    const { patch: originalPatch } = await core.transactionWithPatch('user', () => {
      core.updateNodeDescription(targetId, 'Changed');
    }, { operationId: 'op:change', command: 'update_node' });
    const changed = core.state();
    const { patch: revertPatch } = await core.transactionWithPatch('system', () => {
      core.applyRecoveryPatch(originalPatch);
    }, { operationId: 'op:revert', command: 'apply_recovery_patch' });

    await core.transaction('system', () => core.applyRecoveryPatch(revertPatch));
    expect(core.state()).toEqual(changed);
  });

  test('rejects recovery when an affected after value changed', async () => {
    const core = Core.new();
    const parentId = core.projection().todayId;
    const targetId = `node:${crypto.randomUUID()}`;
    core.createNode(parentId, null, 'Original', targetId);
    const { patch } = await core.transactionWithPatch('user', () => {
      core.updateNodeDescription(targetId, 'Operation value');
    }, { operationId: 'op:update', command: 'outline' });
    core.updateNodeDescription(targetId, 'Concurrent value');

    await expect(core.transaction('system', () => core.applyRecoveryPatch(patch)))
      .rejects.toThrow(`recovery patch conflict at node: ${targetId}`);
    expect(core.state().nodes[targetId]?.description).toBe('Concurrent value');
  });

  test('rejects recovery patch application outside a trusted transaction', () => {
    const core = Core.new();
    const patch: CoreTransactionPatch = {
      revisionBefore: 0,
      revisionAfter: 0,
      persistenceRevisionBefore: 0,
      persistenceRevisionAfter: 0,
      systemChanged: false,
      nodes: [],
    };
    expect(() => core.applyRecoveryPatch(patch)).toThrow(
      'recovery commands require a trusted system transaction',
    );
    expect(RUNTIME_DOCUMENT_COMMANDS).toEqual(['apply_recovery_patch']);
    expect(DOCUMENT_COMMANDS).not.toContain('apply_recovery_patch' as never);
  });
});
