import { describe, expect, test } from 'bun:test';
import { VersionVector } from 'loro-crdt';
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
    expect(left.persistenceIdentity().loroPeerId).not.toBe(right.persistenceIdentity().loroPeerId);
    expect(Object.keys(shared.document).sort()).toEqual(['kind', 'schemaVersion', 'snapshot']);
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
    expect(reloaded.persistenceIdentity()).toEqual(original.persistenceIdentity());
    expect(persisted(reloaded).local.operationHistory).toEqual(envelope.local.operationHistory);

    const copiedInstallationId = newInstallationId();
    const copied = Core.fromState(envelope, { installationId: copiedInstallationId });
    expect(copied.persistenceIdentity()).toMatchObject({
      installationId: copiedInstallationId,
      workspaceId: envelope.shared.workspaceId,
      documentId: envelope.shared.documentId,
    });
    expect(copied.persistenceIdentity().replicaId).not.toBe(envelope.local.replicaId);
    expect(copied.persistenceIdentity().loroPeerId).not.toBe(envelope.local.loroPeerId);
    expect(persisted(copied).local.operationHistory).toEqual([]);
    expect(copied.requiresInitialPersist()).toBe(true);
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
    });

    const paginated = Core.fromSharedState(shared, { installationId: newInstallationId() });
    paginated.applyReplicationUpdates(pages.slice(0, 2));
    paginated.applyReplicationUpdates(pages.slice(2, 3));
    paginated.applyReplicationUpdates(pages.slice(3));

    for (const replica of [ordered, reversed, duplicated, paginated]) {
      expectConverged(source, replica);
    }
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

  test('restarts both replicas, keeps their peers, and continues converging', () => {
    const seed = Core.new({ installationId: newInstallationId() });
    const shared = seed.exportSharedState();
    const left = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const right = Core.fromSharedState(shared, { installationId: newInstallationId() });
    const initialVersion = left.replicationVersionVector();

    focusedNodeId(left.createNode(left.projection().todayId, null, 'Before restart'));
    right.applyReplicationUpdates([left.exportReplicationUpdate(initialVersion)]);
    expectConverged(left, right);

    const leftPeerId = left.persistenceIdentity().loroPeerId;
    const rightPeerId = right.persistenceIdentity().loroPeerId;
    const restartedLeft = reload(left);
    const restartedRight = reload(right);
    expect(restartedLeft.persistenceIdentity().loroPeerId).toBe(leftPeerId);
    expect(restartedRight.persistenceIdentity().loroPeerId).toBe(rightPeerId);
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

  test('strictly rejects the retired v2 format and malformed v3 local state', () => {
    const core = Core.new({ installationId: newInstallationId() });
    const envelope = persisted(core);
    const retired = {
      kind: 'loro-document',
      schemaVersion: 2,
      snapshot: envelope.shared.document.snapshot,
      peerId: envelope.local.loroPeerId,
      operationHistory: [],
    };
    expect(() => Core.deserializeState(JSON.stringify(retired))).toThrow('invalid Tenon workspace state');

    const mismatchedPeer = structuredClone(envelope);
    mismatchedPeer.local.loroPeerId = mismatchedPeer.local.loroPeerId === '0' ? '1' : '0';
    expect(() => Core.deserializeState(JSON.stringify(mismatchedPeer))).toThrow('invalid local workspace replica state');

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
