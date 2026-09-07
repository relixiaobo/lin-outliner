import { describe, expect, test } from 'bun:test';
import { tableFieldChoices, type TableFieldChoice } from '../../src/renderer/ui/outliner/OutlinerTableView';

function node(id: string, options: Record<string, unknown> = {}) {
  return {
    id,
    children: [],
    content: { text: '' },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    ...options,
  } as any;
}

describe('table field choices', () => {
  test('recomputes usage grouping when an existing field entry is added or removed', () => {
    const catalog: readonly TableFieldChoice[] = [
      { id: 'status', label: 'Status', group: 'custom' },
    ];
    const parent = node('parent', { children: ['record'] });
    const record = node('record', { children: [] });
    const byId = new Map<string, any>([['parent', parent], ['record', record]]);

    expect(tableFieldChoices(parent, byId, catalog)[0]?.group).toBe('custom');

    const entry = node('status-entry', {
      parentId: 'record',
      type: 'fieldEntry',
      fieldDefId: 'status',
    });
    record.children = ['status-entry'];
    byId.set('status-entry', entry);
    expect(tableFieldChoices(parent, byId, catalog)[0]?.group).toBe('used');

    parent.children = [];
    byId.delete('status-entry');
    expect(tableFieldChoices(parent, byId, catalog)[0]?.group).toBe('custom');
  });
});
