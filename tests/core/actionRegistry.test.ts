// AC-04 / AC-05 / AC-07 / AC-08 — the catalog, node routing, object-set
// filtering, bound effect plans and explicit-state convergence.

import { describe, expect, test } from 'bun:test';
import { ACTION_BINDINGS, readBoundValue } from '../../src/core/actions/bindings';
import {
  ACTION_SUBJECT_KINDS,
  ACTION_SURFACES,
  planFor,
  resolveActionsForObjectSet,
  resolveFamily,
} from '../../src/core/actions/registry';
import {
  canonicalSurfaceId,
  contentTargetId,
  nodeObjectForRow,
  nodeSelectionObject,
} from '../../src/core/actions/objects';
import { ACTION_IDS } from '../../src/core/actions/types';
import type {
  ActionInvocation,
  ActionProjection,
  ActionResolveContext,
  NodeObject,
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
  overrides: Partial<ActionInvocation> = {},
): ActionResolveContext {
  const projection = projectionOf(core);
  const invocation: ActionInvocation = {
    fixedObjects: objects,
    argumentGenerations: [],
    draftText: '',
    ...overrides,
  };
  const byRef = new Map(objects.map((object) => [object.objectRef, object]));
  for (const object of objects) {
    if (object.kind === 'nodeSelection') {
      for (const node of object.nodes) byRef.set(node.objectRef, node);
    }
  }
  return {
    projection,
    invocation,
    objectFor: (ref) => byRef.get(ref) ?? null,
    untitled: 'Untitled',
  };
}

function newDocument(): { core: Core; today: NodeId } {
  const core = Core.new();
  return { core, today: core.projection().todayId };
}

describe('the action catalog', () => {
  test('contains exactly the 19 families, and none of the retired ids', () => {
    expect([...ACTION_IDS].sort()).toEqual([
      'addTag', 'capture', 'copy', 'create', 'deleteForever', 'duplicate',
      'editDescription', 'editViewSection', 'emptyTrash', 'move',
      'openInSplitPane', 'open', 'remove', 'restore', 'sendToAgent',
      'setDone', 'setPinned', 'setViewMode', 'setViewToolbarVisible',
    ].sort());
    expect(ACTION_IDS).toHaveLength(19);
    const ids = new Set<string>(ACTION_IDS);
    for (const retired of ['moveToTrash', 'go', 'navigate', 'toggleDone', 'togglePin', 'run']) {
      expect(ids.has(retired)).toBe(false);
    }
  });

  test('`mainList` is never a valid action surface', () => {
    for (const actionId of ACTION_IDS) {
      expect(ACTION_SURFACES[actionId]).not.toContain('mainList' as never);
      expect(ACTION_SURFACES[actionId].length).toBeGreaterThan(0);
    }
  });

  test('selection-capable families accept a selection; node-only families do not', () => {
    for (const actionId of ['duplicate', 'move', 'setDone', 'addTag', 'remove', 'deleteForever'] as const) {
      expect(ACTION_SUBJECT_KINDS[actionId]).toContain('nodeSelection');
    }
    for (const actionId of [
      'openInSplitPane', 'setPinned', 'sendToAgent', 'setViewMode',
      'setViewToolbarVisible', 'editViewSection', 'editDescription', 'copy',
      'restore', 'emptyTrash',
    ] as const) {
      expect(ACTION_SUBJECT_KINDS[actionId]).not.toContain('nodeSelection');
    }
  });
});

describe('node facet routing', () => {
  test('a reference row acts structurally on itself and semantically on its target', () => {
    const { core, today } = newDocument();
    const target = core.createNode(today, null, 'Target').focus!.nodeId;
    const host = core.createNode(today, null, 'Host').focus!.nodeId;
    const reference = core.addReference(host, target, null).focus!.nodeId;
    const projection = projectionOf(core);

    const object = nodeObjectForRow(reference, projection.byId, mint);
    expect(object.row).toEqual({ by: 'id', nodeId: reference });
    expect(object.content).toEqual({ by: 'id', nodeId: target });
    expect(object.canonicalSurface).toEqual({ by: 'id', nodeId: target });
  });

  test('a field row activates its definition while acting structurally on the entry', () => {
    const { core, today } = newDocument();
    const owner = core.createNode(today, null, 'Owner').focus!.nodeId;
    const entryId = core.createInlineField(owner, 'Status', 'todo').focus!.nodeId;
    const projection = projectionOf(core);
    const entry = projection.byId.get(entryId)!;
    expect(entry.type).toBe('fieldEntry');
    expect(entry.fieldDefId).toBeTruthy();
    // Row and content are the ENTRY; the canonical surface is the definition,
    // which is the shipped drill-down/pin target for a field row.
    expect(contentTargetId(entryId, projection.byId)).toBe(entryId);
    expect(canonicalSurfaceId(entryId, projection.byId)).toBe(entry.fieldDefId!);
  });
});

describe('object-set filtering', () => {
  test('a selection resolves selection families once and node families once', () => {
    const { core, today } = newDocument();
    const first = core.createNode(today, null, 'Alpha').focus!.nodeId;
    const second = core.createNode(today, null, 'Beta').focus!.nodeId;
    const projection = projectionOf(core);
    const anchor = nodeObjectForRow(first, projection.byId, mint);
    const members: NodeObject[] = [anchor, nodeObjectForRow(second, projection.byId, mint)];
    const selection = nodeSelectionObject(members, mint);
    const context = contextFor(core, [anchor, selection]);

    const actions = resolveActionsForObjectSet(context, [anchor, selection]);
    const duplicates = actions.filter((action) => action.actionId === 'duplicate');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.subjectRef).toBe(selection.objectRef);

    const splits = actions.filter((action) => action.actionId === 'openInSplitPane');
    expect(splits).toHaveLength(1);
    expect(splits[0]!.subjectRef).toBe(anchor.objectRef);
  });

  test('pin and the view families are ABSENT without their attested facts', () => {
    const { core, today } = newDocument();
    const nodeId = core.createNode(today, null, 'Alpha').focus!.nodeId;
    const projection = projectionOf(core);
    const anchor = nodeObjectForRow(nodeId, projection.byId, mint);
    const bare = resolveActionsForObjectSet(contextFor(core, [anchor]), [anchor]);
    expect(bare.some((action) => action.actionId === 'setPinned')).toBe(false);
    expect(bare.some((action) => action.actionId === 'setViewToolbarVisible')).toBe(false);
    expect(bare.some((action) => action.actionId === 'editViewSection')).toBe(false);
    // Open in split pane consumes neither attested part, so it stays available.
    expect(bare.some((action) => action.actionId === 'openInSplitPane')).toBe(true);
    expect(bare.some((action) => action.actionId === 'setViewMode')).toBe(true);

    const withFacts = resolveActionsForObjectSet(
      contextFor(core, [anchor], {
        view: [{ objectRef: anchor.objectRef, panelId: 'p', visualRowId: nodeId, rowExpanded: true }],
        workspace: [{ objectRef: anchor.objectRef, isPinned: false }],
      }),
      [anchor],
    );
    expect(withFacts.some((action) => action.actionId === 'setPinned')).toBe(true);
    expect(withFacts.some((action) => action.actionId === 'editViewSection')).toBe(true);
  });

  test('a view fact without a workspace fact still builds the view-section effect', () => {
    const { core, today } = newDocument();
    const nodeId = core.createNode(today, null, 'Alpha').focus!.nodeId;
    const projection = projectionOf(core);
    const anchor = nodeObjectForRow(nodeId, projection.byId, mint);
    const context = contextFor(core, [anchor], {
      view: [{ objectRef: anchor.objectRef, panelId: 'p', visualRowId: nodeId, rowExpanded: false }],
    });
    const plan = planFor(context, 'editViewSection', anchor, { section: 'filter' });
    expect(plan?.steps.map((step) => step.kind)).toEqual(['command', 'reveal', 'reveal']);
  });
});

describe('explicit-state convergence', () => {
  function selectionOf(core: Core, ids: readonly NodeId[]) {
    const projection = projectionOf(core);
    const members = ids.map((id) => nodeObjectForRow(id, projection.byId, mint));
    const selection = nodeSelectionObject(members, mint);
    return { selection, context: contextFor(core, [members[0]!, selection]) };
  }

  test('a mixed selection presents both setters; each changes only what differs', () => {
    const { core, today } = newDocument();
    const notDone = core.createNode(today, null, 'Alpha').focus!.nodeId;
    const done = core.createNode(today, null, 'Beta').focus!.nodeId;
    core.toggleDone(done);
    const { selection, context } = selectionOf(core, [notDone, done]);

    const variants = resolveFamily(context, 'setDone', selection);
    expect(variants).toHaveLength(2);

    const markDone = planFor(context, 'setDone', selection, { done: true });
    expect(markDone?.steps).toEqual([
      { on: 'main', kind: 'command', command: 'toggle_done', args: { nodeId: notDone } },
    ]);
    const markNotDone = planFor(context, 'setDone', selection, { done: false });
    expect(markNotDone?.steps).toEqual([
      { on: 'main', kind: 'command', command: 'toggle_done', args: { nodeId: done } },
    ]);
  });

  test('a homogeneous selection presents only the state-changing variant', () => {
    const { core, today } = newDocument();
    const first = core.createNode(today, null, 'Alpha').focus!.nodeId;
    const second = core.createNode(today, null, 'Beta').focus!.nodeId;
    const { selection, context } = selectionOf(core, [first, second]);

    const variants = resolveFamily(context, 'setDone', selection);
    expect(variants).toHaveLength(1);
    expect((variants[0]!.binding as { arguments: { done: boolean } }).arguments.done).toBe(true);
    // Two changing nodes keep the shipped batch command.
    expect(planFor(context, 'setDone', selection, { done: true })?.steps).toEqual([
      { on: 'main', kind: 'command', command: 'batch_toggle_done', args: { nodeIds: [first, second] } },
    ]);
  });
});

describe('effect plans and result binding', () => {
  test('open(Today) ensures the day node and navigates to what it returned', () => {
    const { core } = newDocument();
    const projection = projectionOf(core);
    const todayObject: SurfaceObject = {
      kind: 'node',
      objectRef: mint(),
      row: { by: 'system', key: 'today' },
      content: { by: 'system', key: 'today' },
      canonicalSurface: { by: 'system', key: 'today' },
    };
    void projection;
    const context = contextFor(core, [todayObject]);
    const plan = planFor(context, 'open', todayObject, {});
    expect(plan?.steps[0]).toMatchObject({ command: 'ensure_date_node', bindAs: 'today' });
    expect(plan?.steps[1]).toMatchObject({
      kind: 'navigate',
      nodeId: { fromStep: 'today', field: 'focusNodeId' },
    });
    expect(plan?.completion).toBe('stayAtDestination');
  });

  test('the bindable value is extracted through the descriptor path, not a special case', () => {
    expect(ACTION_BINDINGS.produces.ensure_date_node.focusNodeId).toEqual(['focus', 'nodeId']);
    expect(readBoundValue('ensure_date_node', 'focusNodeId', { focus: { nodeId: 'n1' } })).toBe('n1');
    expect(readBoundValue('create_tag', 'focusNodeId', { focus: undefined })).toBeNull();
    // A result carrying the flat shape an executor might ASSUME must not resolve.
    expect(readBoundValue('create_capture', 'focusNodeId', { focusNodeId: 'n1' })).toBeNull();
  });

  test('remove partitions by row policy and keeps the shipped step order', () => {
    const { core, today } = newDocument();
    const first = core.createNode(today, null, 'Alpha').focus!.nodeId;
    const second = core.createNode(today, null, 'Beta').focus!.nodeId;
    const projection = projectionOf(core);
    const members = [first, second].map((id) => nodeObjectForRow(id, projection.byId, mint));
    const selection = nodeSelectionObject(members, mint);
    const context = contextFor(core, [members[0]!, selection]);

    const presentation = resolveFamily(context, 'remove', selection)[0]!;
    expect(presentation.names.en).toBe('2 nodes: Move to Trash');
    expect(planFor(context, 'remove', selection, {})?.steps).toEqual([
      { on: 'main', kind: 'command', command: 'batch_trash_nodes', args: { nodeIds: [first, second] } },
    ]);
  });

  test('copy resolves its text in core, including the untitled fallback', () => {
    const { core, today } = newDocument();
    const empty = core.createNode(today, null, '').focus!.nodeId;
    const projection = projectionOf(core);
    const anchor = nodeObjectForRow(empty, projection.byId, mint);
    const context = contextFor(core, [anchor]);
    expect(planFor(context, 'copy', anchor, { representation: 'text' })?.steps).toEqual([
      { on: 'main', kind: 'clipboard', text: 'Untitled' },
    ]);
    expect(planFor(context, 'copy', anchor, { representation: 'nodeId' })?.steps).toEqual([
      { on: 'main', kind: 'clipboard', text: empty },
    ]);
  });

  test('the toolbar setter binds the desired state and reveals only when showing', () => {
    const { core, today } = newDocument();
    const nodeId = core.createNode(today, null, 'Board').focus!.nodeId;
    core.setViewToolbarVisible(nodeId, true);
    const projection = projectionOf(core);
    const anchor = nodeObjectForRow(nodeId, projection.byId, mint);

    // persisted true + row collapsed -> writes true, reveal only (D1's row 2).
    const collapsed = contextFor(core, [anchor], {
      view: [{ objectRef: anchor.objectRef, panelId: 'p', visualRowId: nodeId, rowExpanded: false }],
    });
    const showing = resolveFamily(collapsed, 'setViewToolbarVisible', anchor)[0]!;
    expect((showing.binding as { arguments: { visible: boolean } }).arguments.visible).toBe(true);
    expect(planFor(collapsed, 'setViewToolbarVisible', anchor, { visible: true })?.steps.map((s) => s.kind))
      .toEqual(['command', 'reveal']);

    // persisted true + row expanded -> writes false, hides.
    const expanded = contextFor(core, [anchor], {
      view: [{ objectRef: anchor.objectRef, panelId: 'p', visualRowId: nodeId, rowExpanded: true }],
    });
    const hiding = resolveFamily(expanded, 'setViewToolbarVisible', anchor)[0]!;
    expect((hiding.binding as { arguments: { visible: boolean } }).arguments.visible).toBe(false);
    expect(planFor(expanded, 'setViewToolbarVisible', anchor, { visible: false })?.steps.map((s) => s.kind))
      .toEqual(['command']);
  });
});
