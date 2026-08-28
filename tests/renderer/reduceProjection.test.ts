import { describe, expect, test } from 'bun:test';
import { TAG_DAY_ID, type DocumentProjection, type NodeId, type NodeProjection, type ProjectionUpdate } from '../../src/core/types';
import {
  fieldSlotsForIndex,
  reduceProjection,
  reduceUiStateForProjectionUpdate,
  type UiState,
} from '../../src/renderer/state/document';
import { hiddenFieldKey } from '../../src/renderer/state/outlinerRows';
import { fieldSlotId } from '../../src/core/fieldSlots';

function node(id: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text: id, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}

// Minimal envelope; only `nodes` and `todayId` move under the projection store.
function envelope(nodes: NodeProjection[], todayId: NodeId = 'root'): DocumentProjection {
  return {
    workspaceId: 'ws',
    rootId: 'root',
    libraryId: 'lib',
    dailyNotesId: 'daily',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId,
    nodes,
  };
}

// root > a > b > c, plus sibling a2 under root.
function tree(): NodeProjection[] {
  return [
    node('root', { children: ['a', 'a2'] }),
    node('a', { parentId: 'root', children: ['b'] }),
    node('a2', { parentId: 'root' }),
    node('b', { parentId: 'a', children: ['c'] }),
    node('c', { parentId: 'b' }),
  ];
}

function full(revision: number, nodes: NodeProjection[]): ProjectionUpdate {
  return { kind: 'full', revision, projection: envelope(nodes) };
}

function seed(revision = 1) {
  const state = reduceProjection(null, full(revision, tree()));
  if (!state) throw new Error('seed full update must produce a state');
  return state;
}

function uiState(patch: Partial<UiState> = {}): UiState {
  return {
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    selectedId: null,
    selectedIds: new Set(),
    selectionAnchorId: null,
    selectionRootId: null,
    selectionSource: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceConversion: null,
    trailingDraftPlacement: null,
    pendingStructuralChanges: [],
    pendingNodePatches: new Map(),
    pendingRemovalIds: new Set(),
    expanded: new Set(),
    expandedHiddenFields: new Set(),
    editingDescriptionId: null,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
    ...patch,
  };
}

function applyAcceptedUiUpdate(
  state: UiState,
  previous: ReturnType<typeof seed>,
  update: ProjectionUpdate,
): UiState {
  const next = reduceProjection(previous, update);
  if (!next) throw new Error('test update must be accepted');
  return reduceUiStateForProjectionUpdate(state, previous.index, next.index, update);
}

describe('reduceProjection — full update', () => {
  test('seeds byId, revision, and a revision counter per node', () => {
    const state = seed(7);
    expect(state.revision).toBe(7);
    expect([...state.index.byId.keys()].sort()).toEqual(['a', 'a2', 'b', 'c', 'root']);
    expect(state.index.renderRev.get('c')).toBe(1);
    expect(state.index.renderRev.get('root')).toBe(1);
  });

  test('seeds the day-note count index from the full projection', () => {
    const state = reduceProjection(null, full(7, [
      node('root'),
      node(TAG_DAY_ID, { type: 'tagDef', content: { text: 'day', marks: [], inlineRefs: [] } }),
      node('day', { parentId: 'root', tags: [TAG_DAY_ID], content: { text: '2026-05-20', marks: [], inlineRefs: [] }, children: ['a', 'b'] }),
    ]));
    expect(state?.index.dayNoteCounts.countsByDate.get('2026-05-20')).toBe(2);
  });

  test('a later full update rebuilds from scratch and bumps every counter', () => {
    const first = seed(1);
    const second = reduceProjection(first, full(2, tree()))!;
    expect(second.revision).toBe(2);
    // Every node is "affected" on a full rebuild, so each counter advances.
    expect(second.index.renderRev.get('c')).toBe(2);
    expect(second.index.renderRev.get('a2')).toBe(2);
  });
});

describe('reduceProjection — delta content edit', () => {
  test('replaces only the changed node object and keeps others by reference', () => {
    const prev = seed(1);
    const previousC = prev.index.byId.get('c');
    const editedC = node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedC],
      removedIds: [],
    })!;

    expect(next.revision).toBe(2);
    expect(next.index.byId).not.toBe(prev.index.byId);
    expect(next.index.projection.nodes).not.toBe(prev.index.projection.nodes);
    expect(next.index.byId.get('c')!.content.text).toBe('edited');
    expect(prev.index.byId.get('c')).toBe(previousC);
    expect(prev.index.projection.nodes.find((candidate) => candidate.id === 'c')).toBe(previousC);
    expect(next.index.projection.nodes.find((candidate) => candidate.id === 'c')).toBe(editedC);
    // Unchanged nodes keep object identity — the stable-reference foundation memo relies on.
    expect(next.index.byId.get('a2')).toBe(prev.index.byId.get('a2'));
    expect(next.index.byId.get('root')).toBe(prev.index.byId.get('root'));
  });

  test('does not iterate the previous byId snapshot while folding a content delta', () => {
    const prev = seed(1);
    const fail = () => {
      throw new Error('previous byId must not be fully iterated');
    };
    Object.defineProperties(prev.index.byId, {
      [Symbol.iterator]: { value: fail },
      entries: { value: fail },
      keys: { value: fail },
      values: { value: fail },
      forEach: { value: fail },
    });

    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } })],
      removedIds: [],
    })!;

    expect(next.index.byId.get('c')!.content.text).toBe('edited');
    expect(next.index.renderRev.get('root')).toBe(2);
    expect(next.index.dayNoteCounts).toBe(prev.index.dayNoteCounts);
  });

  test('bumps the changed node and its structural ancestors only', () => {
    const prev = seed(1);
    const editedC = node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedC],
      removedIds: [],
    })!;

    expect(next.index.renderRev.get('c')).toBe(2);
    expect(next.index.renderRev.get('b')).toBe(2);
    expect(next.index.renderRev.get('a')).toBe(2);
    expect(next.index.renderRev.get('root')).toBe(2);
    expect(next.index.renderRev.get('a2')).toBe(1); // untouched sibling stays put
  });
});

describe('reduceProjection — delta structural change', () => {
  test('adds a new node carried in the change set', () => {
    const prev = seed(1);
    const newD = node('d', { parentId: 'b' });
    const editedB = node('b', { parentId: 'a', children: ['c', 'd'] });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedB, newD],
      removedIds: [],
    })!;

    expect(next.index.byId.get('d')).toBeDefined();
    expect(next.index.byId.get('b')!.children).toEqual(['c', 'd']);
    expect(next.index.projection.nodes.some((n) => n.id === 'd')).toBe(true);
  });

  test('exposes delta projection nodes through normal array reads without materializing the store', () => {
    const prev = seed(1);
    const editedC = node('c', { parentId: 'b', content: { text: 'edited', marks: [], inlineRefs: [] } });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedC],
      removedIds: [],
    })!;

    expect(Array.isArray(next.index.projection.nodes)).toBe(true);
    expect(next.index.projection.nodes.length).toBe(prev.index.projection.nodes.length);
    expect(next.index.projection.nodes[4]).toBe(editedC);
    expect([...next.index.projection.nodes].map((candidate) => candidate.id)).toEqual(['root', 'a', 'a2', 'b', 'c']);
    expect(next.index.projection.nodes.filter((candidate) => candidate.id.startsWith('a')).map((candidate) => candidate.id)).toEqual(['a', 'a2']);
    expect(next.index.projection.nodes.find((candidate) => candidate.id === 'c')).toBe(editedC);
  });

  test('deletes exactly the removed ids and carries todayId', () => {
    const prev = seed(1);
    const editedA = node('a', { parentId: 'root', children: [] }); // lost child b
    // Core enumerates the WHOLE removed subtree (`loro.deleteNode` touches every
    // descendant), so `removedIds` lists both b and c — the reducer deletes exactly
    // that set rather than walking the stale tree (which would wrongly drop a child
    // that the same revision moved out of b; see projectionDeltaIntegration merge).
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'a2',
      changedNodes: [editedA],
      removedIds: ['b', 'c'],
    })!;

    expect(next.index.byId.has('b')).toBe(false);
    expect(next.index.byId.has('c')).toBe(false);
    expect(next.index.byId.has('a')).toBe(true);
    expect(next.index.projection.todayId).toBe('a2');
    expect(next.index.projection.nodes.some((n) => n.id === 'c')).toBe(false);
  });

  test('patches day-note counts from projection deltas', () => {
    const prev = reduceProjection(null, full(1, [
      node('root', { children: ['day'] }),
      node(TAG_DAY_ID, { type: 'tagDef', content: { text: 'day', marks: [], inlineRefs: [] } }),
      node('day', { parentId: 'root', tags: [TAG_DAY_ID], content: { text: '2026-05-20', marks: [], inlineRefs: [] }, children: ['a'] }),
      node('a', { parentId: 'day' }),
    ]));
    expect(prev).not.toBeNull();
    const editedDay = node('day', {
      parentId: 'root',
      tags: [TAG_DAY_ID],
      content: { text: '2026-05-20', marks: [], inlineRefs: [] },
      children: ['a', 'b'],
    });
    const newChild = node('b', { parentId: 'day' });

    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedDay, newChild],
      removedIds: [],
    });

    expect(next?.index.dayNoteCounts).not.toBe(prev!.index.dayNoteCounts);
    expect(next?.index.dayNoteCounts.countsByDate.get('2026-05-20')).toBe(2);
  });

  test('a survivor moved out of a removed node is kept (removedIds-only delete)', () => {
    const prev = seed(1);
    // b is removed, but its child c was re-parented under a2 in the same revision —
    // so c arrives in changedNodes, not removedIds. Deleting only removedIds keeps c.
    const editedA = node('a', { parentId: 'root', children: [] });
    const movedC = node('c', { parentId: 'a2' });
    const editedA2 = node('a2', { parentId: 'root', children: ['c'] });
    const next = reduceProjection(prev, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [editedA, movedC, editedA2],
      removedIds: ['b'],
    })!;

    expect(next.index.byId.has('b')).toBe(false);
    expect(next.index.byId.has('c')).toBe(true);
    expect(next.index.byId.get('c')!.parentId).toBe('a2');
  });

  test('a same-revision full reseed is a no-op', () => {
    const prev = seed(5);
    // Folding a refresh snapshot at the held revision must not churn renderRev
    // (it would invalidate every memo).
    const same = reduceProjection(prev, { kind: 'full', revision: 5, projection: prev.index.projection });
    expect(same).toBe(prev);
  });
});

describe('reduceProjection — revision discipline', () => {
  test('an already-applied revision returns the previous state unchanged', () => {
    const prev = seed(5);
    const dup = reduceProjection(prev, {
      kind: 'delta',
      revision: 5, // dual-channel duplicate (command reply + event)
      todayId: 'root',
      changedNodes: [node('c', { parentId: 'b', content: { text: 'x', marks: [], inlineRefs: [] } })],
      removedIds: [],
    });
    expect(dup).toBe(prev); // same object — no rebuild, no counter churn
  });

  test('a revision gap returns null to signal the caller must resync', () => {
    const prev = seed(1);
    const gapped = reduceProjection(prev, {
      kind: 'delta',
      revision: 3, // skipped revision 2
      todayId: 'root',
      changedNodes: [],
      removedIds: [],
    });
    expect(gapped).toBeNull();
  });

  test('a delta with no base state returns null (must resync)', () => {
    const orphan = reduceProjection(null, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [],
      removedIds: [],
    });
    expect(orphan).toBeNull();
  });
});

describe('reduceProjection — field slot semantic revisions', () => {
  test('invalidates cached slots when an unchanged owner crosses Trash through an ancestor', () => {
    const root = node('root', { children: ['parent', 'schema', 'trash'] });
    const parent = node('parent', { parentId: 'root', children: ['owner'] });
    const owner = node('owner', {
      parentId: 'parent',
      children: ['entry'],
      tags: ['tag'],
    });
    const entry = node('entry', {
      parentId: 'owner',
      type: 'fieldEntry',
      fieldDefId: 'field',
      children: ['value'],
    });
    const value = node('value', { parentId: 'entry' });
    const schema = node('schema', { parentId: 'root', children: ['tag', 'field'] });
    const tag = node('tag', {
      parentId: 'schema',
      type: 'tagDef',
      children: ['template'],
    });
    const template = node('template', {
      parentId: 'tag',
      type: 'fieldEntry',
      fieldDefId: 'field',
    });
    const field = node('field', { parentId: 'schema', type: 'fieldDef' });
    const trash = node('trash', { parentId: 'root' });
    const initial = reduceProjection(null, full(1, [
      root, parent, owner, entry, value, schema, tag, template, field, trash,
    ]))!;
    const slotId = fieldSlotId('owner', 'field');
    expect(fieldSlotsForIndex(initial.index, 'owner').map((slot) => slot.id)).toEqual([slotId]);

    const trashed = reduceProjection(initial, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [
        { ...root, children: ['schema', 'trash'], updatedAt: 2 },
        { ...trash, children: ['parent'], updatedAt: 2 },
        { ...parent, parentId: 'trash', trashedFromParentId: 'root', updatedAt: 2 },
      ],
      removedIds: [],
    })!;
    expect(trashed.index.byId.get('owner')).toBe(owner);
    expect(fieldSlotsForIndex(trashed.index, 'owner')).toEqual([]);

    const restored = reduceProjection(trashed, {
      kind: 'delta',
      revision: 3,
      todayId: 'root',
      changedNodes: [
        { ...root, children: ['parent', 'schema', 'trash'], updatedAt: 3 },
        { ...trash, children: [], updatedAt: 3 },
        { ...parent, parentId: 'root', trashedFromParentId: undefined, updatedAt: 3 },
      ],
      removedIds: [],
    })!;
    expect(restored.index.byId.get('owner')).toBe(owner);
    expect(fieldSlotsForIndex(restored.index, 'owner').map((slot) => slot.id)).toEqual([slotId]);
  });

  test('bumps the tag-definition revision only when slot shape changes', () => {
    const root = node('root', { children: ['schema', 'trash'] });
    const schema = node('schema', {
      parentId: 'root',
      children: ['tag', 'base-a', 'base-b', 'field-a', 'field-b'],
    });
    const tag = node('tag', {
      parentId: 'schema',
      type: 'tagDef',
      children: ['template', 'extends-row'],
    });
    const template = node('template', {
      parentId: 'tag',
      type: 'fieldEntry',
      fieldDefId: 'field-a',
      children: ['default-value'],
    });
    const defaultValue = node('default-value', { parentId: 'template' });
    const extendsRow = node('extends-row', {
      parentId: 'tag',
      type: 'defConfig',
      configKey: 'extends',
      children: ['extends-ref'],
    });
    const extendsRef = node('extends-ref', {
      parentId: 'extends-row',
      type: 'reference',
      targetId: 'base-a',
    });
    const baseA = node('base-a', { parentId: 'schema', type: 'tagDef' });
    const baseB = node('base-b', { parentId: 'schema', type: 'tagDef' });
    const fieldA = node('field-a', {
      parentId: 'schema',
      type: 'fieldDef',
      children: ['option'],
    });
    const fieldB = node('field-b', { parentId: 'schema', type: 'fieldDef' });
    const option = node('option', { parentId: 'field-a', type: 'systemOption' });
    const trash = node('trash', { parentId: 'root' });
    let state = reduceProjection(null, full(1, [
      root,
      schema,
      tag,
      template,
      defaultValue,
      extendsRow,
      extendsRef,
      baseA,
      baseB,
      fieldA,
      fieldB,
      option,
      trash,
    ]))!;
    const initialRevision = state.index.semanticRevisions.tagDefinitions;
    const initialTagCandidateCacheKey = state.index.tagCandidateCacheKey;

    state = reduceProjection(state, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [{
        ...tag,
        content: { ...tag.content, text: 'Renamed tag' },
        updatedAt: 2,
      }],
      removedIds: [],
    })!;
    expect(state.index.semanticRevisions.tagDefinitions).toBe(initialRevision);
    expect(state.index.tagCandidateCacheKey).not.toBe(initialTagCandidateCacheKey);

    state = reduceProjection(state, {
      kind: 'delta',
      revision: 3,
      todayId: 'root',
      changedNodes: [{
        ...defaultValue,
        content: { ...defaultValue.content, text: 'New default' },
        updatedAt: 3,
      }],
      removedIds: [],
    })!;
    expect(state.index.semanticRevisions.tagDefinitions).toBe(initialRevision);

    state = reduceProjection(state, {
      kind: 'delta',
      revision: 4,
      todayId: 'root',
      changedNodes: [{
        ...option,
        content: { ...option.content, text: 'Renamed option' },
        updatedAt: 4,
      }],
      removedIds: [],
    })!;
    expect(state.index.semanticRevisions.tagDefinitions).toBe(initialRevision);

    state = reduceProjection(state, {
      kind: 'delta',
      revision: 5,
      todayId: 'root',
      changedNodes: [{ ...extendsRef, targetId: 'base-b', updatedAt: 5 }],
      removedIds: [],
    })!;
    expect(state.index.semanticRevisions.tagDefinitions).toBe(initialRevision + 1);

    state = reduceProjection(state, {
      kind: 'delta',
      revision: 6,
      todayId: 'root',
      changedNodes: [{ ...template, fieldDefId: 'field-b', updatedAt: 6 }],
      removedIds: [],
    })!;
    expect(state.index.semanticRevisions.tagDefinitions).toBe(initialRevision + 2);

    state = reduceProjection(state, {
      kind: 'delta',
      revision: 7,
      todayId: 'root',
      changedNodes: [
        { ...schema, children: ['tag', 'base-a', 'base-b', 'field-a'], updatedAt: 7 },
        { ...trash, children: ['field-b'], updatedAt: 7 },
        { ...fieldB, parentId: 'trash', trashedFromParentId: 'schema', updatedAt: 7 },
      ],
      removedIds: [],
    })!;
    expect(state.index.semanticRevisions.tagDefinitions).toBe(initialRevision + 3);
  });
});

describe('reduceUiStateForProjectionUpdate', () => {
  test('prunes a virtual field slot when a tag change removes it without removing nodes', () => {
    const slotId = fieldSlotId('owner', 'field');
    const previous = reduceProjection(null, full(1, [
      node('root', { children: ['owner', 'schema'] }),
      node('owner', { parentId: 'root', tags: ['tag'] }),
      node('schema', { parentId: 'root', children: ['tag', 'field'] }),
      node('tag', { parentId: 'schema', type: 'tagDef', children: ['template-entry'] }),
      node('template-entry', { parentId: 'tag', type: 'fieldEntry', fieldDefId: 'field' }),
      node('field', { parentId: 'schema', type: 'fieldDef' }),
    ]));
    if (!previous) throw new Error('field-slot seed must produce a state');
    const target = { nodeId: slotId, parentId: 'owner', panelId: 'panel-1', surface: 'field-name' as const };
    const state = uiState({
      focusedId: slotId,
      focusedParentId: 'owner',
      focusedPanelId: 'panel-1',
      focusSurface: 'field-name',
      selectedId: slotId,
      selectedIds: new Set([slotId]),
      selectionAnchorId: slotId,
      selectionRootId: 'root',
      selectionSource: 'global',
      focusRequest: { target, placement: { kind: 'end' } },
      pendingInputChar: { target, char: 'x' },
      trailingDraftPlacement: { parentId: slotId, afterId: null, panelId: 'panel-1' },
      expanded: new Set([slotId]),
      expandedHiddenFields: new Set([hiddenFieldKey('owner', slotId)]),
      batchTagSelectorOpen: true,
    });

    const next = applyAcceptedUiUpdate(state, previous, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('owner', { parentId: 'root', tags: [] })],
      removedIds: [],
    });

    expect(next.focusedId).toBeNull();
    expect(next.focusRequest).toBeNull();
    expect(next.pendingInputChar).toBeNull();
    expect(next.trailingDraftPlacement).toBeNull();
    expect(next.selectedId).toBeNull();
    expect(next.selectedIds).toEqual(new Set());
    expect(next.selectionAnchorId).toBeNull();
    expect(next.selectionRootId).toBe('root');
    expect(next.selectionSource).toBeNull();
    expect(next.expanded).toEqual(new Set());
    expect(next.expandedHiddenFields).toEqual(new Set());
    expect(next.batchTagSelectorOpen).toBe(false);
  });

  test('keeps a table-only field edit target that was never a projected slot', () => {
    const slotId = fieldSlotId('owner', 'field');
    const previous = reduceProjection(null, full(1, [
      node('root', { children: ['owner', 'other', 'schema'] }),
      node('owner', { parentId: 'root' }),
      node('other', { parentId: 'root' }),
      node('schema', { parentId: 'root', children: ['field'] }),
      node('field', { parentId: 'schema', type: 'fieldDef' }),
    ]));
    if (!previous) throw new Error('table-slot seed must produce a state');
    const target = { nodeId: slotId, parentId: slotId, panelId: 'panel-1', surface: 'trailing' as const };
    const state = uiState({
      focusedId: slotId,
      focusedParentId: slotId,
      focusedPanelId: 'panel-1',
      focusSurface: 'trailing',
      focusRequest: { target, placement: { kind: 'end' } },
      pendingInputChar: { target, char: 'x' },
    });

    const next = applyAcceptedUiUpdate(state, previous, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('other', {
        parentId: 'root',
        content: { text: 'Changed', marks: [], inlineRefs: [] },
      })],
      removedIds: [],
    });

    expect(next).toBe(state);
  });

  test('prunes removed focus, selection, expansion, and deferred state at the delta boundary', () => {
    const previous = seed(1);
    const focusTarget = { nodeId: 'c', parentId: 'b', panelId: 'panel-1', surface: 'row' as const };
    const state = uiState({
      focusedId: 'c',
      focusedParentId: 'b',
      focusedPanelId: 'panel-1',
      focusSurface: 'row',
      selectedId: 'c',
      selectedIds: new Set(['a', 'b', 'c']),
      selectionAnchorId: 'b',
      selectionRootId: 'b',
      selectionSource: 'global',
      focusRequest: { target: focusTarget, placement: { kind: 'end' } },
      pendingInputChar: { target: focusTarget, char: 'x' },
      pendingReferenceConversion: { nodeId: 'a', parentId: 'root', targetId: 'c' },
      trailingDraftPlacement: { parentId: 'c', afterId: null, panelId: 'panel-1' },
      expanded: new Set(['a', 'b', 'c']),
      editingDescriptionId: 'c',
      toolbarDropdownRequest: { nodeId: 'c', section: 'sort', nonce: 1 },
    });

    const next = applyAcceptedUiUpdate(state, previous, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('a', { parentId: 'root' })],
      removedIds: ['b', 'c'],
    });

    expect(next.focusedId).toBeNull();
    expect(next.focusedParentId).toBeNull();
    expect(next.focusedPanelId).toBeNull();
    expect(next.focusSurface).toBeNull();
    expect(next.focusRequest).toBeNull();
    expect(next.pendingInputChar).toBeNull();
    expect(next.trailingDraftPlacement).toBeNull();
    expect(next.selectedId).toBe('a');
    expect(next.selectedIds).toEqual(new Set(['a']));
    expect(next.selectionAnchorId).toBe('a');
    expect(next.selectionRootId).toBeNull();
    expect(next.selectionSource).toBe('global');
    expect(next.pendingReferenceConversion).toBeNull();
    expect(next.expanded).toEqual(new Set(['a']));
    expect(next.editingDescriptionId).toBeNull();
    expect(next.toolbarDropdownRequest).toBeNull();
  });

  test('clears parked requests that target a removed row without dropping surviving focus', () => {
    const previous = seed(1);
    const removedTarget = { nodeId: 'c', parentId: 'b', panelId: 'panel-1', surface: 'row' as const };
    const state = uiState({
      focusedId: 'a',
      focusedParentId: 'root',
      focusedPanelId: 'panel-1',
      focusSurface: 'row',
      selectedId: 'a',
      selectedIds: new Set(['a']),
      focusRequest: { target: removedTarget, placement: { kind: 'end' } },
      pendingInputChar: { target: removedTarget, char: 'x' },
      pendingReferenceConversion: { nodeId: 'a', parentId: 'root', targetId: 'c' },
      trailingDraftPlacement: { parentId: 'a', afterId: 'b', panelId: 'panel-1' },
    });

    const next = applyAcceptedUiUpdate(state, previous, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('a', { parentId: 'root' })],
      removedIds: ['b', 'c'],
    });

    expect(next.focusedId).toBe('a');
    expect(next.focusedParentId).toBe('root');
    expect(next.focusedPanelId).toBe('panel-1');
    expect(next.focusSurface).toBe('row');
    expect(next.focusRequest).toBeNull();
    expect(next.pendingInputChar).toBeNull();
    expect(next.pendingReferenceConversion).toBeNull();
    expect(next.trailingDraftPlacement).toBeNull();
  });

  test('clears the shared focus family when a surviving row loses its focus parent', () => {
    const previous = seed(1);
    const focusTarget = { nodeId: 'c', parentId: 'b', panelId: 'panel-1', surface: 'row' as const };
    const state = uiState({
      focusedId: 'c',
      focusedParentId: 'b',
      focusedPanelId: 'panel-1',
      focusSurface: 'row',
      selectedId: 'c',
      selectedIds: new Set(['c']),
      focusRequest: { target: focusTarget, placement: { kind: 'end' } },
      pendingInputChar: { target: focusTarget, char: 'x' },
      trailingDraftPlacement: { parentId: 'b', afterId: 'c', panelId: 'panel-1' },
    });

    const next = applyAcceptedUiUpdate(state, previous, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [
        node('a', { parentId: 'root' }),
        node('a2', { parentId: 'root', children: ['c'] }),
        node('c', { parentId: 'a2' }),
      ],
      removedIds: ['b'],
    });

    expect(next.focusedId).toBeNull();
    expect(next.focusedParentId).toBeNull();
    expect(next.focusedPanelId).toBeNull();
    expect(next.focusSurface).toBeNull();
    expect(next.focusRequest).toBeNull();
    expect(next.pendingInputChar).toBeNull();
    expect(next.trailingDraftPlacement).toBeNull();
    expect(next.selectedIds).toEqual(new Set(['c']));
  });

  test('derives removals from an accepted full reseed', () => {
    const previous = seed(1);
    const state = uiState({
      focusedId: 'c',
      focusedParentId: 'b',
      selectedId: 'c',
      selectedIds: new Set(['a', 'c']),
      selectionAnchorId: 'c',
      expanded: new Set(['a', 'b', 'c']),
      editingDescriptionId: 'c',
    });

    const next = applyAcceptedUiUpdate(state, previous, full(3, [
      node('root', { children: ['a', 'a2'] }),
      node('a', { parentId: 'root' }),
      node('a2', { parentId: 'root' }),
    ]));

    expect(next.focusedId).toBeNull();
    expect(next.selectedId).toBe('a');
    expect(next.selectedIds).toEqual(new Set(['a']));
    expect(next.selectionAnchorId).toBe('a');
    expect(next.expanded).toEqual(new Set(['a']));
    expect(next.editingDescriptionId).toBeNull();
  });

  test('prunes hidden-field expansion and closes batch UI with the final selection', () => {
    const fieldId = 'field-entry';
    const previous = reduceProjection(null, full(1, [
      node('root', { children: [fieldId] }),
      node(fieldId, { type: 'fieldEntry', parentId: 'root' }),
    ]));
    if (!previous) throw new Error('field seed must produce a state');
    const state = uiState({
      selectedId: fieldId,
      selectedIds: new Set([fieldId]),
      selectionAnchorId: fieldId,
      selectionRootId: 'root',
      selectionSource: 'ref-click',
      expanded: new Set([fieldId]),
      expandedHiddenFields: new Set([hiddenFieldKey('root', fieldId)]),
      editingDescriptionId: fieldId,
      batchTagSelectorOpen: true,
      toolbarDropdownRequest: { nodeId: fieldId, section: 'display', nonce: 1 },
    });

    const next = applyAcceptedUiUpdate(state, previous, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('root')],
      removedIds: [fieldId],
    });

    expect(next.selectedId).toBeNull();
    expect(next.selectedIds).toEqual(new Set());
    expect(next.selectionAnchorId).toBeNull();
    expect(next.selectionRootId).toBe('root');
    expect(next.selectionSource).toBeNull();
    expect(next.expanded).toEqual(new Set());
    expect(next.expandedHiddenFields).toEqual(new Set());
    expect(next.editingDescriptionId).toBeNull();
    expect(next.batchTagSelectorOpen).toBe(false);
    expect(next.toolbarDropdownRequest).toBeNull();
  });

  test('keeps the state and set identities when removed nodes are not represented', () => {
    const previous = seed(1);
    const state = uiState({
      selectedId: 'a',
      selectedIds: new Set(['a']),
      selectionAnchorId: 'a',
      selectionRootId: 'root',
      expanded: new Set(['a']),
      expandedHiddenFields: new Set(['root:unrelated-field']),
    });

    const next = applyAcceptedUiUpdate(state, previous, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('a', { parentId: 'root' })],
      removedIds: ['b', 'c'],
    });

    expect(next).toBe(state);
    expect(next.selectedIds).toBe(state.selectedIds);
    expect(next.expanded).toBe(state.expanded);
    expect(next.expandedHiddenFields).toBe(state.expandedHiddenFields);
  });

  test('chooses the final surviving selection without materializing the Set', () => {
    const previous = seed(1);
    const state = uiState({
      selectedId: 'c',
      selectedIds: new Set(['a', 'a2', 'c']),
      selectionAnchorId: 'c',
      selectionRootId: 'root',
      selectionSource: 'global',
    });

    const next = applyAcceptedUiUpdate(state, previous, {
      kind: 'delta',
      revision: 2,
      todayId: 'root',
      changedNodes: [node('b', { parentId: 'a' })],
      removedIds: ['c'],
    });

    expect(next.selectedId).toBe('a2');
    expect(next.selectedIds).toEqual(new Set(['a', 'a2']));
    expect(next.selectionAnchorId).toBe('a2');
    expect(next.selectionRootId).toBe('root');
    expect(next.selectionSource).toBe('global');
  });
});
