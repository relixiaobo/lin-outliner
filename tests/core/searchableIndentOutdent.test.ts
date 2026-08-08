// Step 11, the ratified addition (PM, 2026-08-08).
//
// The three prerequisites the ratification named, each asserted here:
//   1. a surface-exposure rule, so they never leak into the anchored menu;
//   2. an attested `selectionRootId`, because main cannot recover which pane
//      root the user chose — the same node appears under several;
//   3. the shipped keyboard behaviour — selection restoration and expansion
//      adjustment — which a command-only effect does not preserve.
//
// Nested and transcluded panes are covered, because "one level out" means
// something different in each.

import { describe, expect, test } from 'bun:test';
import { planFor, resolveFamily } from '../../src/core/actions/registry';
import { nodeObjectForRow, nodeSelectionObject } from '../../src/core/actions/objects';
import type {
  ActionInvocation,
  ActionProjection,
  ActionResolveContext,
  ObjectRef,
  SurfaceObject,
} from '../../src/core/actions/types';
import { Core } from '../../src/core/core';
import type { NodeId, NodeProjection } from '../../src/core/types';

let refCounter = 0;
const mint = () => `ref-${++refCounter}` as ObjectRef;

function projectionOf(core: Core): ActionProjection {
  const projection = core.projection();
  const byId = new Map<NodeId, NodeProjection>();
  for (const node of projection.nodes) byId.set(node.id, node);
  return {
    byId,
    trashId: projection.trashId,
    todayId: projection.todayId,
    libraryId: projection.libraryId,
    schemaId: projection.schemaId,
    searchesId: projection.searchesId,
  };
}

function contextFor(
  core: Core,
  objects: readonly SurfaceObject[],
  view?: ActionInvocation['view'],
): ActionResolveContext {
  const byRef = new Map(objects.map((object) => [object.objectRef, object]));
  return {
    projection: projectionOf(core),
    invocation: {
      fixedObjects: objects,
      argumentGenerations: [],
      draftText: '',
      ...(view ? { view } : {}),
    },
    objectFor: (ref) => byRef.get(ref) ?? null,
    untitled: 'Untitled',
  };
}

function nodeObject(core: Core, rowId: NodeId) {
  return nodeObjectForRow(rowId, projectionOf(core).byId, mint);
}

function viewFact(subject: SurfaceObject, selectionRootId: NodeId | null) {
  return [{
    objectRef: subject.objectRef,
    panelId: 'panel-0',
    visualRowId: 'row',
    rowExpanded: false,
    ...(selectionRootId ? { selectionRootId } : {}),
  }];
}

describe('Outdent needs an attested pane root', () => {
  test('is ABSENT without one — not rejected', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const parent = core.createNode(today, null, 'Parent').focus!.nodeId;
    const child = core.createNode(parent, null, 'Child').focus!.nodeId;
    const subject = nodeObject(core, child);

    // No view fact at all: the action is defined relative to a pane that is not
    // there, so it produces no row rather than a disabled one.
    expect(resolveFamily(contextFor(core, [subject]), 'outdent', subject)).toEqual([]);
    // Indent needs no pane root and is unaffected.
    expect(resolveFamily(contextFor(core, [subject]), 'indent', subject)).toHaveLength(1);
  });

  test('a row already at the pane root cannot outdent out of the pane', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const parent = core.createNode(today, null, 'Parent').focus!.nodeId;
    const child = core.createNode(parent, null, 'Child').focus!.nodeId;
    const subject = nodeObject(core, child);

    // Viewing the PARENT as the pane root: the child is a top-level row there,
    // so there is nowhere to outdent to.
    const atRoot = contextFor(core, [subject], viewFact(subject, parent));
    const rejected = resolveFamily(atRoot, 'outdent', subject)[0]!;
    expect(rejected.evaluation.status).toBe('rejected');
    expect(planFor(atRoot, 'outdent', subject, {})).toBeNull();

    // Viewing Today as the pane root: the same node CAN move out one level.
    const fromToday = contextFor(core, [subject], viewFact(subject, today));
    expect(resolveFamily(fromToday, 'outdent', subject)[0]!.evaluation.status).toBe('applicable');
  });

  test('a transcluded pane root gives the same node a different answer', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const target = core.createNode(today, null, 'Target').focus!.nodeId;
    const nested = core.createNode(target, null, 'Nested').focus!.nodeId;
    const host = core.createNode(today, null, 'Host').focus!.nodeId;
    core.addReference(host, target, null);
    const subject = nodeObject(core, nested);

    // Rooted AT the transcluded target, the nested row is top-level: no outdent.
    const inTransclusion = contextFor(core, [subject], viewFact(subject, target));
    expect(resolveFamily(inTransclusion, 'outdent', subject)[0]!.evaluation.status)
      .toBe('rejected');
    // Rooted at Today, the same node has somewhere to go.
    const wide = contextFor(core, [subject], viewFact(subject, today));
    expect(resolveFamily(wide, 'outdent', subject)[0]!.evaluation.status).toBe('applicable');
  });
});

describe('the plans keep the shipped keyboard behaviour', () => {
  test('indent expands its target BEFORE the command, and restores the selection', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = core.createNode(today, null, 'First').focus!.nodeId;
    const second = core.createNode(today, null, 'Second').focus!.nodeId;
    const subject = nodeObject(core, second);
    const context = contextFor(core, [subject], viewFact(subject, today));

    const plan = planFor(context, 'indent', subject, {})!;
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'outlineIntent', 'outlineIntent', 'outlineIntent', 'command',
    ]);
    // The target is the previous sibling, expanded BEFORE the move so the row
    // does not vanish behind a collapsed parent for a frame.
    const expand = plan.steps[1] as { intent: { kind: string; nodeIds: string[] } };
    expect(expand.intent).toEqual({ kind: 'expand', nodeIds: [first] });
    const restore = plan.steps[2] as { intent: { kind: string; selectedIds: string[] } };
    expect(restore.intent.kind).toBe('restoreSelection');
    expect(restore.intent.selectedIds).toEqual([second]);
    // The caret is the surface's, not the command's — the shipped path passes
    // `applyFocus: false` for exactly this reason.
    expect(plan.focus).toBe('surfaceOwned');
  });

  test('outdent collapses the emptied parent AFTER the command', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const parent = core.createNode(today, null, 'Parent').focus!.nodeId;
    const only = core.createNode(parent, null, 'Only child').focus!.nodeId;
    const subject = nodeObject(core, only);
    const context = contextFor(core, [subject], viewFact(subject, today));

    const plan = planFor(context, 'outdent', subject, {})!;
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'outlineIntent', 'outlineIntent', 'command', 'outlineIntent',
    ]);
    // Collapsing BEFORE would hide the row for a frame and then show it again
    // one level out; by the time this runs the parent is genuinely empty.
    const collapse = plan.steps[3] as { intent: { kind: string; nodeIds: string[] } };
    expect(collapse.intent).toEqual({ kind: 'collapse', nodeIds: [parent] });
  });

  test('a parent that keeps a child is not collapsed', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const parent = core.createNode(today, null, 'Parent').focus!.nodeId;
    const moving = core.createNode(parent, null, 'Moving').focus!.nodeId;
    core.createNode(parent, null, 'Staying');
    const subject = nodeObject(core, moving);
    const context = contextFor(core, [subject], viewFact(subject, today));

    const plan = planFor(context, 'outdent', subject, {})!;
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'outlineIntent', 'outlineIntent', 'command',
    ]);
  });

  test('a contiguous selection indents as a RUN, under the row before it', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const anchor = core.createNode(today, null, 'Anchor').focus!.nodeId;
    const first = core.createNode(today, null, 'First').focus!.nodeId;
    const second = core.createNode(today, null, 'Second').focus!.nodeId;
    const byId = projectionOf(core).byId;
    const members = [first, second].map((id) => nodeObjectForRow(id, byId, mint));
    const selection = nodeSelectionObject(members, mint);
    const context = contextFor(core, [members[0]!, selection], viewFact(selection, today));

    const plan = planFor(context, 'indent', selection, {})!;
    const command = plan.steps.at(-1) as { args: { nodeIds: string[] } };
    // Both move: walking back from `Second` reaches `Anchor`, which is outside
    // the selection — so the whole run nests under it and keeps its shape.
    expect(command.args.nodeIds).toEqual([first, second]);
    // And the expansion target is that external row, not a member of the run.
    const expand = plan.steps[1] as { intent: { nodeIds: string[] } };
    expect(expand.intent.nodeIds).toEqual([anchor]);
  });

  test('a run with nothing before it cannot indent at all', () => {
    const core = Core.new();
    const today = core.projection().todayId;
    const first = core.createNode(today, null, 'First').focus!.nodeId;
    const second = core.createNode(today, null, 'Second').focus!.nodeId;
    const byId = projectionOf(core).byId;
    const members = [first, second].map((id) => nodeObjectForRow(id, byId, mint));
    const selection = nodeSelectionObject(members, mint);
    const context = contextFor(core, [members[0]!, selection], viewFact(selection, today));

    // `First` is the first row under Today, so the run has no external previous
    // sibling to nest under — the action is rejected rather than half-applied.
    expect(resolveFamily(context, 'indent', selection)[0]!.evaluation.status).toBe('rejected');
    expect(planFor(context, 'indent', selection, {})).toBeNull();
  });
});
