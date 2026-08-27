import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import {
  LIBRARY_ID,
  WORKSPACE_ID,
  plainText,
  replaceAllRichTextPatch,
  type DocumentProjection,
  type NodeProjection,
  type ProjectionUpdate,
} from '../../src/core/types';
import { DocumentReadModel } from '../../src/outline/runtime/documentReadModel';

function mustFocus(outcome: { focus?: { nodeId: string } }): string {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function deltaFromCore(core: Core): ProjectionUpdate {
  const delta = core.revisionDelta();
  const presentNodes = core.projectionNodesByIds(delta.changedNodeIds);
  const presentById = new Map(presentNodes.map((node) => [node.id, node]));
  return {
    kind: 'delta',
    revision: core.revision(),
    todayId: core.todayId(),
    changedNodes: presentNodes,
    removedIds: delta.changedNodeIds.filter((nodeId) => !presentById.has(nodeId)),
  };
}

function fakeNode(id: string): NodeProjection {
  return {
    id,
    content: plainText(id),
    children: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

function fakeProjection(nodes: NodeProjection[]): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'b',
    libraryId: 'library',
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'b',
    nodes,
  };
}

function searchIds(model: DocumentReadModel, query: string): string[] {
  return model.textIndex.search(query).map((hit) => hit.id);
}

function applyCoreDelta(model: DocumentReadModel, core: Core): void {
  expect(model.applyUpdate(deltaFromCore(core))).toBe(true);
}

describe('DocumentReadModel', () => {
  test('builds an index-compatible view from a projection', () => {
    const core = Core.new();
    const projection = core.projection();
    const model = DocumentReadModel.fromProjection(core.revision(), projection);

    expect(model.revision).toBe(core.revision());
    expect(model.projection).not.toBe(projection);
    expect(model.projection.nodes).not.toBe(projection.nodes);
    expect(model.projection.workspaceId).toBe(projection.workspaceId);
    expect(model.projection.todayId).toBe(projection.todayId);
    expect([...model.nodes.keys()].sort()).toEqual(projection.nodes.map((node) => node.id).sort());
    expect(model.node(LIBRARY_ID)).toBe(model.nodes.get(LIBRARY_ID));
    expect(model.nodes.get(WORKSPACE_ID)).toBeDefined();
  });

  test('applies contiguous deltas while preserving unchanged node identity', () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());
    const todayId = model.projection.todayId;
    const unchangedBefore = model.node(WORKSPACE_ID);

    const createdId = mustFocus(core.createNode(todayId, null, 'First'));
    expect(model.applyUpdate(deltaFromCore(core))).toBe(true);
    expect(model.revision).toBe(core.revision());
    expect(model.node(createdId)?.content.text).toBe('First');
    expect(model.node(WORKSPACE_ID)).toBe(unchangedBefore);

    const createdBefore = model.node(createdId);
    core.applyNodeTextPatch(createdId, replaceAllRichTextPatch(plainText('Renamed')));
    expect(model.applyUpdate(deltaFromCore(core))).toBe(true);
    expect(model.node(createdId)?.content.text).toBe('Renamed');
    expect(model.node(createdId)).not.toBe(createdBefore);
    expect(model.node(WORKSPACE_ID)).toBe(unchangedBefore);
  });

  test('updates text search in place without rebuilding the Node map or index', () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());
    const nodes = model.nodes;
    const index = model.textIndex;
    const nodeId = mustFocus(core.createNode(model.projection.todayId, null, 'Alpha project'));

    applyCoreDelta(model, core);
    expect(model.nodes).toBe(nodes);
    expect(model.textIndex).toBe(index);
    expect(searchIds(model, 'alpha')).toContain(nodeId);

    core.applyNodeTextPatch(nodeId, replaceAllRichTextPatch(plainText('Gamma project')));
    applyCoreDelta(model, core);
    expect(model.nodes).toBe(nodes);
    expect(model.textIndex).toBe(index);
    expect(searchIds(model, 'gamma')).toContain(nodeId);
    expect(searchIds(model, 'alpha')).not.toContain(nodeId);
  });

  test('refreshes tag, field, and reference dependents when their labels change', () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());
    const ownerId = mustFocus(core.createNode(model.projection.todayId, null, 'Dependency owner'));
    applyCoreDelta(model, core);

    const tagId = mustFocus(core.createTag('Original tag label'));
    applyCoreDelta(model, core);
    core.applyTag(ownerId, tagId);
    applyCoreDelta(model, core);

    const fieldEntryId = mustFocus(core.createInlineField(ownerId, null, 'Original field label', 'plain'));
    applyCoreDelta(model, core);
    const fieldDefId = model.node(fieldEntryId)?.fieldDefId;
    expect(fieldDefId).toBeDefined();

    const referenceTargetId = mustFocus(core.createNode(model.projection.todayId, null, 'Original reference label'));
    applyCoreDelta(model, core);
    core.addReference(fieldEntryId, referenceTargetId, null);
    applyCoreDelta(model, core);

    core.applyNodeTextPatch(tagId, replaceAllRichTextPatch(plainText('Renamed tag label')));
    applyCoreDelta(model, core);
    core.applyNodeTextPatch(fieldDefId!, replaceAllRichTextPatch(plainText('Renamed field label')));
    applyCoreDelta(model, core);
    core.applyNodeTextPatch(referenceTargetId, replaceAllRichTextPatch(plainText('Renamed reference label')));
    applyCoreDelta(model, core);

    expect(searchIds(model, 'renamed tag label')).toContain(ownerId);
    expect(searchIds(model, 'renamed field label')).toContain(ownerId);
    expect(searchIds(model, 'renamed reference label')).toContain(ownerId);
    expect(searchIds(model, 'original tag label')).not.toContain(ownerId);
    expect(searchIds(model, 'original field label')).not.toContain(ownerId);
    expect(searchIds(model, 'original reference label')).not.toContain(ownerId);
  });

  test('removes and restores every searchable descendant when a subtree crosses Trash', () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());
    const parentId = mustFocus(core.createNode(model.projection.todayId, null, 'Trash parent needle'));
    applyCoreDelta(model, core);
    const childId = mustFocus(core.createNode(parentId, null, 'Trash child needle'));
    applyCoreDelta(model, core);

    core.trashNode(parentId);
    applyCoreDelta(model, core);
    expect(searchIds(model, 'trash parent needle')).not.toContain(parentId);
    expect(searchIds(model, 'trash child needle')).not.toContain(childId);

    core.restoreNode(parentId);
    applyCoreDelta(model, core);
    expect(searchIds(model, 'trash parent needle')).toContain(parentId);
    expect(searchIds(model, 'trash child needle')).toContain(childId);
  });

  test('publishes one complete generation after a yielding bulk refresh', async () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());
    const revisionBefore = model.revision;
    const index = model.textIndex;
    const createdIds: string[] = [];
    await core.transaction('agent', () => {
      for (let item = 0; item < 300; item += 1) {
        createdIds.push(mustFocus(core.createNode(
          model.projection.todayId,
          null,
          `Cooperative index needle ${item}`,
        )));
      }
    });
    let yields = 0;

    expect(await model.applyUpdateYielding(deltaFromCore(core), {
      yieldEveryNodes: 25,
      yield: async () => {
        yields += 1;
        expect(model.revision).toBe(revisionBefore);
        expect(searchIds(model, 'cooperative index needle 299')).not.toContain(createdIds.at(-1)!);
      },
    })).toBe(true);

    expect(yields).toBeGreaterThan(0);
    expect(model.revision).toBe(core.revision());
    expect(model.textIndex).toBe(index);
    expect(searchIds(model, 'cooperative index needle 299')).toContain(createdIds.at(-1)!);
  });

  test('keeps delta-added nodes in full-projection id order', () => {
    const model = DocumentReadModel.fromProjection(0, fakeProjection([
      fakeNode('b'),
      fakeNode('d'),
    ]));

    expect(model.applyUpdate({
      kind: 'delta',
      revision: 1,
      todayId: 'a',
      changedNodes: [fakeNode('e'), fakeNode('a'), fakeNode('c')],
      removedIds: [],
    })).toBe(true);

    expect(model.projection.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([...model.nodes.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('removes deleted nodes from both map and projection array', () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());
    const nodeId = mustFocus(core.createNode(model.projection.todayId, null, 'Temporary'));
    expect(model.applyUpdate(deltaFromCore(core))).toBe(true);
    expect(model.nodes.has(nodeId)).toBe(true);

    core.deleteNode(nodeId);
    const update = deltaFromCore(core);
    expect(update.kind).toBe('delta');
    expect(update.removedIds).toContain(nodeId);
    expect(model.applyUpdate(update)).toBe(true);
    expect(model.nodes.has(nodeId)).toBe(false);
    expect(model.projection.nodes.some((node) => node.id === nodeId)).toBe(false);
  });

  test('treats duplicate deltas as idempotent', () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());
    const nodeId = mustFocus(core.createNode(model.projection.todayId, null, 'Once'));
    const update = deltaFromCore(core);

    expect(model.applyUpdate(update)).toBe(true);
    const lengthAfterFirstApply = model.projection.nodes.length;
    expect(model.applyUpdate(update)).toBe(true);
    expect(model.projection.nodes.length).toBe(lengthAfterFirstApply);
    expect(model.nodes.get(nodeId)?.content.text).toBe('Once');
  });

  test('rejects discontinuous deltas so the owner can reseed', () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());

    core.createNode(model.projection.todayId, null, 'First');
    core.createNode(model.projection.todayId, null, 'Second');

    expect(model.applyUpdate(deltaFromCore(core))).toBe(false);
    expect(model.revision).toBe(0);
  });

  test('full updates reseed the view', () => {
    const core = Core.new();
    const model = DocumentReadModel.fromProjection(core.revision(), core.projection());
    const nodeId = mustFocus(core.createNode(model.projection.todayId, null, 'Full'));
    const projection = core.projection();

    expect(model.applyUpdate({ kind: 'full', revision: core.revision(), projection })).toBe(true);
    expect(model.revision).toBe(core.revision());
    expect(model.node(nodeId)?.content.text).toBe('Full');
    expect(model.projection.nodes).not.toBe(projection.nodes);
  });
});
