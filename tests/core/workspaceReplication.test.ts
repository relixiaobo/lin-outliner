import { describe, expect, test } from 'bun:test';
import { LoroDoc, VersionVector } from 'loro-crdt';
import { Core, type WorkspacePersistenceEnvelopeV3 } from '../../src/core/core';
import { plainText, replaceAllRichTextPatch } from '../../src/core/types';

function newInstallationId(): string {
  return crypto.randomUUID();
}

function focusedNodeId(outcome: ReturnType<Core['createNode']>): string {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function persisted(core: Core): WorkspacePersistenceEnvelopeV3 {
  return Core.deserializeState(core.serializeState());
}

function reload(core: Core): Core {
  const installationId = core.persistenceIdentity().installationId;
  return Core.fromState(persisted(core), { installationId });
}

function expectConverged(left: Core, right: Core): void {
  expect(left.state()).toEqual(right.state());
  expect(left.persistenceIdentity()).toMatchObject({
    workspaceId: right.persistenceIdentity().workspaceId,
    documentId: right.persistenceIdentity().documentId,
  });
  expect(versionEntries(left)).toEqual(versionEntries(right));
}

function versionEntries(core: Core): Array<[string, number]> {
  const version = VersionVector.decode(core.replicationVersionVector());
  try {
    return [...version.toJSON()].sort(([left], [right]) => left.localeCompare(right));
  } finally {
    version.free();
  }
}

describe('workspace replication persistence', () => {
  test('separates portable workspace state from fresh replica identities', () => {
    const source = Core.new({ installationId: newInstallationId() });
    const shared = source.exportSharedState();
    const left = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const right = Core.fromSharedState(shared, { installationId: newInstallationId() });

    expect(left.persistenceIdentity()).toMatchObject({
      workspaceId: shared.workspaceId,
      documentId: shared.documentId,
    });
    expect(right.persistenceIdentity()).toMatchObject({
      workspaceId: shared.workspaceId,
      documentId: shared.documentId,
    });
    expect(left.persistenceIdentity().replicaId).not.toBe(right.persistenceIdentity().replicaId);
    expect(left.persistenceIdentity().loroSessionPeerId).not.toBe(right.persistenceIdentity().loroSessionPeerId);
    expect(Object.keys(shared.document).sort()).toEqual(['exportMode', 'kind', 'schemaVersion', 'snapshot']);
    expect(shared.document.exportMode).toBe('snapshot');
    expect(left.requiresInitialPersist()).toBe(true);
    expect(right.requiresInitialPersist()).toBe(true);
  });

  test('keeps a replica on same-installation reload and replaces local state after a copied workspace load', () => {
    const installationId = newInstallationId();
    const original = Core.new({ installationId });
    focusedNodeId(original.createNode(original.projection().todayId, null, 'Local history'));
    const envelope = persisted(original);
    expect(envelope.local.operationHistory.length).toBeGreaterThan(0);

    const reloaded = Core.fromState(envelope, { installationId });
    expect(reloaded.persistenceIdentity()).toMatchObject({
      installationId,
      workspaceId: original.persistenceIdentity().workspaceId,
      documentId: original.persistenceIdentity().documentId,
      replicaId: original.persistenceIdentity().replicaId,
    });
    expect(reloaded.persistenceIdentity().loroSessionPeerId)
      .not.toBe(original.persistenceIdentity().loroSessionPeerId);
    expect(persisted(reloaded).local.operationHistory).toEqual(envelope.local.operationHistory);

    const copiedInstallationId = newInstallationId();
    const copied = Core.fromState(envelope, { installationId: copiedInstallationId });
    expect(copied.persistenceIdentity()).toMatchObject({
      installationId: copiedInstallationId,
      workspaceId: envelope.shared.workspaceId,
      documentId: envelope.shared.documentId,
    });
    expect(copied.persistenceIdentity().replicaId).not.toBe(envelope.local.replicaId);
    expect(copied.persistenceIdentity().loroSessionPeerId)
      .not.toBe(original.persistenceIdentity().loroSessionPeerId);
    expect(persisted(copied).local.operationHistory).toEqual([]);
    expect(copied.requiresInitialPersist()).toBe(true);
  });

  test('uses distinct session peers when a complete userData snapshot is cloned', () => {
    const installationId = newInstallationId();
    const original = Core.new({ installationId });
    const envelope = persisted(original);
    const left = Core.fromState(structuredClone(envelope), { installationId });
    const right = Core.fromState(structuredClone(envelope), { installationId });
    const baseVersion = left.replicationVersionVector();

    expect(left.persistenceIdentity().replicaId).toBe(right.persistenceIdentity().replicaId);
    expect(left.persistenceIdentity().loroSessionPeerId)
      .not.toBe(right.persistenceIdentity().loroSessionPeerId);

    const leftNodeId = focusedNodeId(left.createNode(left.projection().todayId, null, 'Left clone row'));
    const rightNodeId = focusedNodeId(right.createNode(right.projection().todayId, null, 'Right clone row'));
    const leftUpdate = left.exportReplicationUpdate(baseVersion);
    const rightUpdate = right.exportReplicationUpdate(baseVersion);
    left.applyReplicationUpdates([rightUpdate]);
    right.applyReplicationUpdates([leftUpdate]);

    expectConverged(left, right);
    expect(left.state().nodes[leftNodeId]?.content.text).toBe('Left clone row');
    expect(left.state().nodes[rightNodeId]?.content.text).toBe('Right clone row');
  });

  test('does not reuse operation ids after restoring an older workspace snapshot', () => {
    const installationId = newInstallationId();
    const writer = Core.new({ installationId });
    const staleEnvelope = persisted(writer);
    const receiver = Core.fromSharedState(staleEnvelope.shared, { installationId: newInstallationId() });
    const initialVersion = writer.replicationVersionVector();

    const firstNodeId = focusedNodeId(writer.createNode(writer.projection().todayId, null, 'Before restore'));
    receiver.applyReplicationUpdates([writer.exportReplicationUpdate(initialVersion)]);
    expect(receiver.state().nodes[firstNodeId]).toBeDefined();

    const restored = Core.fromState(staleEnvelope, { installationId });
    expect(restored.persistenceIdentity().loroSessionPeerId)
      .not.toBe(writer.persistenceIdentity().loroSessionPeerId);
    const restoredBase = restored.replicationVersionVector();
    const secondNodeId = focusedNodeId(restored.createNode(restored.projection().todayId, null, 'After restore'));
    const received = receiver.applyReplicationUpdates([restored.exportReplicationUpdate(restoredBase)]);

    expect(received.acceptedOperations).toBe(true);
    expect(receiver.state().nodes[secondNodeId]?.content.text).toBe('After restore');
    const restoredVersion = restored.replicationVersionVector();
    restored.applyReplicationUpdates([receiver.exportReplicationUpdate(restoredVersion)]);
    expectConverged(restored, receiver);
  });

  test('does not export operations from a transaction that later rolls back', async () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const shared = seed.exportSharedState();
    const source = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const target = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const baseVersion = source.replicationVersionVector();
    let rolledBackNodeId = '';

    await expect(source.transaction('user', async () => {
      rolledBackNodeId = focusedNodeId(source.createNode(source.projection().todayId, null, 'Rolled back'));
      const replicationCalls: Array<() => unknown> = [
        () => source.serializeState(),
        () => source.exportSharedState(),
        () => source.replicationVersionVector(),
        () => source.exportReplicationUpdate(baseVersion),
        () => source.applyReplicationUpdates([]),
      ];
      for (const call of replicationCalls) {
        expect(call).toThrow('cannot use replication APIs during an uncommitted mutation');
      }
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    expect(source.state().nodes[rolledBackNodeId]).toBeUndefined();
    target.applyReplicationUpdates([source.exportReplicationUpdate(baseVersion)]);
    expect(target.state().nodes[rolledBackNodeId]).toBeUndefined();
    expectConverged(source, target);
  });

  test('blocks replication while an async mutation has yielded', async () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const shared = seed.exportSharedState();
    const source = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const target = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const baseVersion = source.replicationVersionVector();
    let resumeMutation: (() => void) | undefined;
    let signalYield: (() => void) | undefined;
    const yielded = new Promise<void>((resolve) => { signalYield = resolve; });
    const mutation = source.createNodesFromTreeYielding(source.projection().todayId, [{
      content: plainText('Yielded row'),
      children: [],
    }], {
      yieldEveryNodes: 1,
      yield: () => new Promise<void>((resolve) => {
        resumeMutation = resolve;
        signalYield?.();
      }),
    });

    await yielded;
    try {
      expect(() => source.serializeState())
        .toThrow('cannot use replication APIs during an uncommitted mutation');
      expect(() => source.replicationVersionVector())
        .toThrow('cannot use replication APIs during an uncommitted mutation');
      expect(() => source.exportReplicationUpdate(baseVersion))
        .toThrow('cannot use replication APIs during an uncommitted mutation');
      expect(() => source.applyReplicationUpdates([]))
        .toThrow('cannot use replication APIs during an uncommitted mutation');
    } finally {
      resumeMutation?.();
    }

    const outcome = await mutation;
    const nodeId = focusedNodeId(outcome);
    target.applyReplicationUpdates([source.exportReplicationUpdate(baseVersion)]);
    expect(target.state().nodes[nodeId]?.content.text).toBe('Yielded row');
    expectConverged(source, target);
  });

  test('converges command-driven edits made concurrently by two offline replicas', () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const sharedNodeId = focusedNodeId(seed.createNode(seed.projection().todayId, null, 'Shared row'));
    const shared = seed.exportSharedState();
    const left = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const right = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const leftBase = left.replicationVersionVector();
    const rightBase = right.replicationVersionVector();

    left.updateNodeDescription(sharedNodeId, 'Description from left');
    const leftNodeId = focusedNodeId(left.createNode(left.projection().todayId, null, 'Left row'));
    right.applyNodeTextPatch(sharedNodeId, replaceAllRichTextPatch(plainText('Title from right')));
    const rightNodeId = focusedNodeId(right.createNode(right.projection().todayId, null, 'Right row'));

    const leftUpdate = left.exportReplicationUpdate(leftBase);
    const rightUpdate = right.exportReplicationUpdate(rightBase);
    left.applyReplicationUpdates([rightUpdate]);
    right.applyReplicationUpdates([leftUpdate]);

    expectConverged(left, right);
    expect(left.state().nodes[sharedNodeId]).toMatchObject({
      content: { text: 'Title from right' },
      description: 'Description from left',
    });
    expect(left.state().nodes[leftNodeId]?.content.text).toBe('Left row');
    expect(left.state().nodes[rightNodeId]?.content.text).toBe('Right row');
  });

  test('converges after ordered, reversed, duplicate, and paginated update delivery', () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const shared = seed.exportSharedState();
    const source = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const pages: Uint8Array[] = [];
    let cursor = source.replicationVersionVector();

    for (const title of ['Page one', 'Page two', 'Page three', 'Page four']) {
      focusedNodeId(source.createNode(source.projection().todayId, null, title));
      pages.push(source.exportReplicationUpdate(cursor));
      cursor = source.replicationVersionVector();
    }

    const ordered = Core.fromSharedState(shared, { installationId: newInstallationId() });
    ordered.applyReplicationUpdates(pages);

    const reversed = Core.fromSharedState(shared, { installationId: newInstallationId() });
    for (const page of pages.toReversed()) reversed.applyReplicationUpdates([page]);

    const duplicated = Core.fromSharedState(shared, { installationId: newInstallationId() });
    duplicated.applyReplicationUpdates(pages.flatMap((page) => [page, page]));
    const duplicateDelta = duplicated.applyReplicationUpdates(pages);
    expect(duplicateDelta).toEqual({
      revision: duplicated.revision(),
      changedNodeIds: [],
      requiresFullSearchRebuild: false,
      acceptedOperations: false,
      hasPendingUpdates: false,
      persistenceChanged: false,
    });

    const paginated = Core.fromSharedState(shared, { installationId: newInstallationId() });
    paginated.applyReplicationUpdates(pages.slice(0, 2));
    paginated.applyReplicationUpdates(pages.slice(2, 3));
    paginated.applyReplicationUpdates(pages.slice(3));

    for (const replica of [ordered, reversed, duplicated, paginated]) {
      expectConverged(source, replica);
    }
  });

  test('preserves redo when an imported update is a duplicate', () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const shared = seed.exportSharedState();
    const source = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const target = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const sourceVersion = source.replicationVersionVector();
    focusedNodeId(source.createNode(source.projection().todayId, null, 'Remote row'));
    const remoteUpdate = source.exportReplicationUpdate(sourceVersion);
    target.applyReplicationUpdates([remoteUpdate]);

    const localNodeId = focusedNodeId(target.createNode(target.projection().todayId, null, 'Redo row'));
    target.undo();
    expect(target.operationHistory({ action: 'list', origin: 'all' }).canRedo).toBe(true);

    const duplicate = target.applyReplicationUpdates([remoteUpdate]);
    expect(duplicate).toMatchObject({
      acceptedOperations: false,
      hasPendingUpdates: false,
      persistenceChanged: false,
      changedNodeIds: [],
    });
    expect(target.operationHistory({ action: 'list', origin: 'all' }).canRedo).toBe(true);
    target.redo();
    expect(target.state().nodes[localNodeId]?.content.text).toBe('Redo row');
  });

  test('marks accepted losing operations as persistence changes', () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const sharedNodeId = focusedNodeId(seed.createNode(seed.projection().todayId, null, 'Shared row'));
    const shared = seed.exportSharedState();
    const left = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const right = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const leftBase = left.replicationVersionVector();
    const rightBase = right.replicationVersionVector();

    left.updateNodeDescription(sharedNodeId, 'Left description');
    right.updateNodeDescription(sharedNodeId, 'Right description');
    const intoLeft = left.applyReplicationUpdates([right.exportReplicationUpdate(rightBase)]);
    const intoRight = right.applyReplicationUpdates([left.exportReplicationUpdate(leftBase)]);
    const losingImport = [intoLeft, intoRight].find((result) => result.changedNodeIds.length === 0);

    expect(losingImport).toMatchObject({
      acceptedOperations: true,
      hasPendingUpdates: false,
      persistenceChanged: true,
      changedNodeIds: [],
      requiresFullSearchRebuild: false,
    });
    expectConverged(left, right);
  });

  test('persists dependency-pending updates across reload', () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const shared = seed.exportSharedState();
    const source = Core.fromSharedState(shared, { installationId: newInstallationId() });
    let cursor = source.replicationVersionVector();
    const firstNodeId = focusedNodeId(source.createNode(source.projection().todayId, null, 'First page'));
    const firstPage = source.exportReplicationUpdate(cursor);
    cursor = source.replicationVersionVector();
    const secondNodeId = focusedNodeId(source.createNode(source.projection().todayId, null, 'Second page'));
    const secondPage = source.exportReplicationUpdate(cursor);

    const target = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const pendingResult = target.applyReplicationUpdates([secondPage]);
    expect(pendingResult).toMatchObject({
      acceptedOperations: false,
      hasPendingUpdates: true,
      persistenceChanged: true,
      changedNodeIds: [],
    });
    expect(target.applyReplicationUpdates([secondPage])).toMatchObject({
      acceptedOperations: false,
      hasPendingUpdates: true,
      persistenceChanged: false,
      changedNodeIds: [],
    });

    const unrelated = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const unrelatedBase = unrelated.replicationVersionVector();
    focusedNodeId(unrelated.createNode(unrelated.projection().todayId, null, 'Unrelated page'));
    const unrelatedUpdate = unrelated.exportReplicationUpdate(unrelatedBase);
    expect(target.applyReplicationUpdates([unrelatedUpdate])).toMatchObject({
      acceptedOperations: true,
      hasPendingUpdates: true,
      persistenceChanged: true,
    });
    source.applyReplicationUpdates([unrelatedUpdate]);
    const pendingEnvelope = persisted(target);
    expect(pendingEnvelope.local.loroPendingUpdates).toHaveLength(1);

    const restored = Core.fromState(pendingEnvelope, {
      installationId: target.persistenceIdentity().installationId,
    });
    expect(persisted(restored).local.loroPendingUpdates).toHaveLength(1);
    const resolved = restored.applyReplicationUpdates([firstPage]);
    expect(resolved.acceptedOperations).toBe(true);
    expect(resolved.hasPendingUpdates).toBe(false);
    expect(resolved.persistenceChanged).toBe(true);
    expect(persisted(restored).local.loroPendingUpdates).toEqual([]);
    expect(restored.state().nodes[firstNodeId]?.content.text).toBe('First page');
    expect(restored.state().nodes[secondNodeId]?.content.text).toBe('Second page');
    expectConverged(source, restored);
  });

  test('does not echo imported updates through the local-update subscription', () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const shared = seed.exportSharedState();
    const source = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const target = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const targetLocalUpdates: Uint8Array[] = [];
    const unsubscribe = target.subscribeLocalUpdates((update) => targetLocalUpdates.push(update));
    const cursor = source.replicationVersionVector();

    const remoteNodeId = focusedNodeId(source.createNode(source.projection().todayId, null, 'Remote row'));
    const delta = target.applyReplicationUpdates([source.exportReplicationUpdate(cursor)]);
    expect(delta.changedNodeIds).toContain(remoteNodeId);
    expect(delta.requiresFullSearchRebuild).toBe(true);
    expect(targetLocalUpdates).toEqual([]);

    focusedNodeId(target.createNode(target.projection().todayId, null, 'Local row'));
    expect(targetLocalUpdates).toHaveLength(1);
    unsubscribe();
  });

  test('restarts both replicas with fresh peers and continues converging', () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const shared = seed.exportSharedState();
    const left = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const right = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const initialVersion = left.replicationVersionVector();

    focusedNodeId(left.createNode(left.projection().todayId, null, 'Before restart'));
    right.applyReplicationUpdates([left.exportReplicationUpdate(initialVersion)]);
    expectConverged(left, right);

    const leftPeerId = left.persistenceIdentity().loroSessionPeerId;
    const rightPeerId = right.persistenceIdentity().loroSessionPeerId;
    const restartedLeft = reload(left);
    const restartedRight = reload(right);
    expect(restartedLeft.persistenceIdentity().loroSessionPeerId).not.toBe(leftPeerId);
    expect(restartedRight.persistenceIdentity().loroSessionPeerId).not.toBe(rightPeerId);
    const leftVersion = restartedLeft.replicationVersionVector();
    const rightVersion = restartedRight.replicationVersionVector();

    focusedNodeId(restartedLeft.createNode(restartedLeft.projection().todayId, null, 'Left after restart'));
    focusedNodeId(restartedRight.createNode(restartedRight.projection().todayId, null, 'Right after restart'));
    const leftUpdate = restartedLeft.exportReplicationUpdate(leftVersion);
    const rightUpdate = restartedRight.exportReplicationUpdate(rightVersion);
    restartedLeft.applyReplicationUpdates([rightUpdate]);
    restartedRight.applyReplicationUpdates([leftUpdate]);

    expectConverged(restartedLeft, restartedRight);
  });

  test('imports an already-normalized snapshot only once during reload', () => {
    const core = Core.new({ installationId: newInstallationId() });
    focusedNodeId(core.createNode(core.projection().todayId, null, 'Persisted row'));
    const envelope = persisted(core);
    const originalImport = LoroDoc.prototype.import;
    let importCount = 0;
    LoroDoc.prototype.import = function importSnapshot(update: Uint8Array) {
      importCount += 1;
      return originalImport.call(this, update);
    };
    try {
      const restored = Core.fromState(envelope, {
        installationId: core.persistenceIdentity().installationId,
      });
      expect(restored.state()).toEqual(core.state());
      expect(importCount).toBe(1);
    } finally {
      LoroDoc.prototype.import = originalImport;
    }
  });

  test('strictly rejects the retired v2 format and malformed v3 local state', () => {
    const core = Core.new({ installationId: newInstallationId() });
    const envelope = persisted(core);
    const retired = {
      kind: 'loro-document',
      schemaVersion: 2,
      snapshot: envelope.shared.document.snapshot,
      peerId: core.persistenceIdentity().loroSessionPeerId,
      operationHistory: [],
    };
    expect(() => Core.deserializeState(JSON.stringify(retired))).toThrow('invalid Tenon workspace state');

    const malformedPendingUpdates = structuredClone(envelope);
    malformedPendingUpdates.local.loroPendingUpdates = [42 as unknown as string];
    expect(() => Core.deserializeState(JSON.stringify(malformedPendingUpdates)))
      .toThrow('invalid local workspace replica state');

    const malformedHistory = structuredClone(envelope) as WorkspacePersistenceEnvelopeV3;
    malformedHistory.local.operationHistory = [{
      operationId: 'op:test',
      origin: 'user',
      action: 'test',
      summary: 'Malformed node ids.',
      affectedNodeIds: [1],
      createdAt: new Date().toISOString(),
    } as unknown as WorkspacePersistenceEnvelopeV3['local']['operationHistory'][number]];
    expect(() => Core.deserializeState(JSON.stringify(malformedHistory))).toThrow('invalid local workspace replica state');
  });
});
