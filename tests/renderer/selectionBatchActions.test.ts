import { describe, expect, test } from 'bun:test';
import type { NodeId, NodeProjection } from '../../src/core/types';
import {
  buildSelectableRows,
  selectableRowForId,
} from '../../src/renderer/state/selectableRows';
import {
  idsAllowedForDuplicate,
  idsAllowedForMoveTo,
  idsAllowedForStructuralBatch,
  idsAllowedForStructuralIndentBatch,
  idsAllowedForStructuralOutdentBatch,
  idsEnabledForSelectionAction,
  planSelectionDelete,
  runSelectionDelete,
  runSelectionDuplicate,
  runSelectionMove,
  selectableRowMap,
} from '../../src/renderer/ui/interactions/selectionBatchActions';
import { commandRunnerNoop } from '../../src/renderer/ui/shared';

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
    toolbarVisible: false,
    filterValues: [],
    ...patch,
  } as NodeProjection;
}

function byIdOf(nodes: NodeProjection[]): Map<NodeId, NodeProjection> {
  return new Map(nodes.map((n) => [n.id, n]));
}

describe('selection batch action policy', () => {
  test('allows field value indentation but keeps external structural movement blocked', () => {
    const byId = byIdOf([
      node('root', { children: ['body', 'entry'] }),
      node('body', { parentId: 'root' }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['value'] }),
      node('value', { parentId: 'entry' }),
    ]);
    const rowsById = selectableRowMap(buildSelectableRows('root', byId, { expanded: new Set() }));
    const ids = ['body', 'value'];

    expect(idsEnabledForSelectionAction({
      ids,
      action: 'move',
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(['body', 'value']);
    expect(idsAllowedForStructuralBatch({
      ids,
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(['body']);
    expect(idsAllowedForStructuralIndentBatch({
      ids,
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(['body', 'value']);
    expect(idsAllowedForMoveTo({
      ids,
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(['body']);
  });

  test('keeps a direct nested field entry inside its owning field boundary', () => {
    const byId = byIdOf([
      node('root', { children: ['entry'] }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['value', 'nested-entry'] }),
      node('value', { parentId: 'entry' }),
      node('nested-entry', { parentId: 'entry', type: 'fieldEntry' }),
    ]);
    const rowsById = selectableRowMap(buildSelectableRows('root', byId, { expanded: new Set() }));
    const ids = ['nested-entry'];

    expect(rowsById.get('nested-entry')?.kind).toBe('fieldValue');
    expect(idsAllowedForStructuralBatch({
      ids,
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual([]);
    expect(idsAllowedForStructuralIndentBatch({
      ids,
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(ids);
    expect(idsAllowedForStructuralOutdentBatch({
      ids,
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual([]);
    expect(idsAllowedForMoveTo({
      ids,
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual([]);
  });

  test('blocks structural outdent at the panel root boundary', () => {
    const byId = byIdOf([
      node('root', { children: ['top', 'entry'] }),
      node('top', { parentId: 'root', children: ['child'] }),
      node('child', { parentId: 'top' }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['value'] }),
      node('value', { parentId: 'entry', children: ['nested'] }),
      node('nested', { parentId: 'value' }),
    ]);
    const rowsById = selectableRowMap(buildSelectableRows('root', byId, {
      expanded: new Set(['top', 'value']),
    }));

    expect(idsAllowedForStructuralBatch({
      ids: ['top', 'child', 'value', 'nested'],
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(['top', 'child', 'nested']);
    expect(idsAllowedForStructuralIndentBatch({
      ids: ['top', 'child', 'value', 'nested'],
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(['top', 'child', 'value', 'nested']);
    expect(idsAllowedForStructuralOutdentBatch({
      ids: ['top', 'child', 'value', 'nested'],
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(['child', 'nested']);
  });

  test('allows only clone-safe field values for duplicate commands', () => {
    const byId = byIdOf([
      node('root', { children: ['entry'] }),
      node('target'),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['plain', 'ref'] }),
      node('plain', { parentId: 'entry' }),
      node('ref', { parentId: 'entry', type: 'reference', targetId: 'target' }),
    ]);
    const rowsById = selectableRowMap(buildSelectableRows('root', byId, { expanded: new Set() }));

    expect(idsAllowedForDuplicate({
      ids: ['plain', 'ref'],
      panelRootId: 'root',
      byId,
      rowMap: rowsById,
    })).toEqual(['plain']);
  });

  test('filters synthetic system values out of every mutable action', () => {
    const sysrefId = 'sysref:entry:target';
    const byId = byIdOf([
      node('entry', { type: 'fieldEntry', children: [sysrefId] }),
      node('target'),
      node(sysrefId, {
        parentId: 'entry',
        type: 'reference',
        targetId: 'target',
        locked: true,
      }),
    ]);
    const row = selectableRowForId(sysrefId, 'root', byId);
    expect(row?.kind).toBe('syntheticSystemValue');

    for (const action of ['delete', 'move', 'duplicate', 'tag', 'checkbox'] as const) {
      expect(idsEnabledForSelectionAction({
        ids: [sysrefId],
        action,
        panelRootId: 'root',
        byId,
      })).toEqual([]);
    }
  });

  test('hard-deletes locked ref-click references without affecting field value references', () => {
    const byId = byIdOf([
      node('root', { children: ['locked-ref', 'entry'] }),
      node('target'),
      node('locked-ref', {
        parentId: 'root',
        type: 'reference',
        targetId: 'target',
        locked: true,
      }),
      node('entry', { parentId: 'root', type: 'fieldEntry', children: ['field-ref'] }),
      node('field-ref', {
        parentId: 'entry',
        type: 'reference',
        targetId: 'target',
      }),
    ]);
    const rowMap = selectableRowMap(buildSelectableRows('root', byId, { expanded: new Set() }));

    expect(planSelectionDelete({
      ids: ['locked-ref'],
      hardDeleteSingleReferenceId: 'locked-ref',
      panelRootId: 'root',
      byId,
      rowMap,
    })).toEqual({
      hardDeleteId: 'locked-ref',
      trashIds: [],
      fieldValueIds: [],
    });

    expect(planSelectionDelete({
      ids: ['field-ref'],
      hardDeleteSingleReferenceId: 'field-ref',
      panelRootId: 'root',
      byId,
      rowMap,
    })).toEqual({
      hardDeleteId: null,
      trashIds: [],
      fieldValueIds: ['field-ref'],
    });
  });

  test('returns a renderer no-op for empty or disabled command batches', async () => {
    const byId = byIdOf([
      node('root', { children: ['value'] }),
      node('value', { parentId: 'root', type: 'reference', locked: true }),
    ]);
    const rowMap = selectableRowMap(buildSelectableRows('root', byId, { expanded: new Set() }));

    expect(await runSelectionDelete({
      ids: [],
      panelRootId: 'root',
      byId,
      rowMap,
    })).toBe(commandRunnerNoop());
    expect(await runSelectionDuplicate({
      ids: ['value'],
      panelRootId: 'root',
      byId,
      rowMap,
    })).toBe(commandRunnerNoop());
    expect(await runSelectionMove({
      ids: [],
      direction: 'up',
      panelRootId: 'root',
      byId,
      rowMap,
    })).toBe(commandRunnerNoop());
  });
});
