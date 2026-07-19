import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { LIBRARY_ID, WORKSPACE_ID, plainText, replaceAllRichTextPatch, type ProjectionUpdate } from '../../src/core/types';
import { indexProjection } from '../../src/main/agentNodeToolProjection';
import { DocumentReadModel } from '../../src/main/documentReadModel';

function mustFocus(outcome: { focus?: { nodeId: string } }): string {
  expect(outcome.focus).toBeDefined();
  return outcome.focus!.nodeId;
}

function deltaFromCore(core: Core): ProjectionUpdate {
  const delta = core.revisionDelta();
  const present = core.projectionNodesFor(delta.changedNodeIds);
  return {
    kind: 'delta',
    revision: core.revision(),
    todayId: core.todayId(),
    changedNodes: [...present.values()],
    removedIds: delta.changedNodeIds.filter((nodeId) => !present.has(nodeId)),
  };
}

describe('DocumentReadModel', () => {
  test('builds an index-compatible view from a projection', () => {
    const core = Core.new();
    const projection = core.projection();
    const model = DocumentReadModel.fromProjection(core.revision(), projection);
    const expected = indexProjection(projection);

    expect(model.revision).toBe(core.revision());
    expect(model.projection).not.toBe(projection);
    expect(model.projection.nodes).not.toBe(projection.nodes);
    expect(model.projection.workspaceId).toBe(projection.workspaceId);
    expect(model.projection.todayId).toBe(projection.todayId);
    expect([...model.nodes.keys()].sort()).toEqual([...expected.nodes.keys()].sort());
    expect(model.node(LIBRARY_ID)).toBe(expected.nodes.get(LIBRARY_ID));
    expect(model.asProjectionIndex().nodes.get(WORKSPACE_ID)).toBe(expected.nodes.get(WORKSPACE_ID));
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
