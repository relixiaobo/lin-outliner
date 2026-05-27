import { describe, expect, test } from 'bun:test';
import { buildOutlinerRows } from '../../src/renderer/ui/outliner/row-model';

const makeNode = (id: string, text: string, overrides: Record<string, unknown> = {}) => ({
  id,
  children: [],
  content: { text, marks: [], inlineRefs: [] },
  tags: [],
  createdAt: 0,
  updatedAt: 0,
  locked: false,
  autoCollected: false,
  ...overrides,
});

describe('config-as-nodes: outliner excludes internal config nodes', () => {
  test('defConfig and systemOption children are not ordinary rows', () => {
    const parent = makeNode('tag', '#Task', {
      type: 'tagDef',
      children: ['cfg-color', 'opt', 'content'],
    });
    const cfg = makeNode('cfg-color', '', { type: 'defConfig', parentId: 'tag', configKey: 'color' });
    const opt = makeNode('opt', 'number', { type: 'systemOption', parentId: 'tag' });
    const content = makeNode('content', 'Default content', { parentId: 'tag' });
    const byId = new Map<string, any>([
      ['tag', parent],
      ['cfg-color', cfg],
      ['opt', opt],
      ['content', content],
    ]);

    expect(buildOutlinerRows(parent as any, byId)).toEqual([{ id: 'content', type: 'content' }]);
  });
});
