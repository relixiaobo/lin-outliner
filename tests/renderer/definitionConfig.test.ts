import { describe, expect, test } from 'bun:test';
import type { NodeProjection } from '../../src/renderer/api/types';
import {
  definitionConfigItems,
  definitionKind,
  definitionOutlinerLabel,
} from '../../src/renderer/ui/definition/definitionConfig';

function makeNode(overrides: Partial<NodeProjection>): NodeProjection {
  return {
    id: 'node',
    children: [],
    content: { text: 'Node', marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
    showCheckbox: false,
    doneStateEnabled: false,
    autocollectOptions: false,
    autoCollected: false,
    toolbarVisible: false,
    filterValues: [],
    ...overrides,
  };
}

describe('definition config registry', () => {
  test('keeps definition type detection explicit', () => {
    expect(definitionKind(makeNode({ type: 'tagDef' }))).toBe('tag');
    expect(definitionKind(makeNode({ type: 'fieldDef' }))).toBe('field');
    expect(definitionKind(makeNode({}))).toBeNull();
  });

  test('shows tag done mapping only after checkbox is enabled', () => {
    const withoutCheckbox = definitionConfigItems(makeNode({ type: 'tagDef' })).map((item) => item.key);
    const withCheckbox = definitionConfigItems(makeNode({ type: 'tagDef', showCheckbox: true })).map((item) => item.key);

    expect(withoutCheckbox).not.toContain('doneStateEnabled');
    expect(withCheckbox).toContain('doneStateEnabled');
  });

  test('shows field type-specific rows without storing config as real children', () => {
    const plain = definitionConfigItems(makeNode({ type: 'fieldDef', fieldType: 'plain' })).map((item) => item.key);
    const options = definitionConfigItems(makeNode({ type: 'fieldDef', fieldType: 'options' })).map((item) => item.key);
    const optionsFromTag = definitionConfigItems(makeNode({
      type: 'fieldDef',
      fieldType: 'options_from_supertag',
    })).map((item) => item.key);
    const number = definitionConfigItems(makeNode({ type: 'fieldDef', fieldType: 'number' })).map((item) => item.key);

    expect(plain).not.toContain('autocollectOptions');
    expect(options).toContain('autocollectOptions');
    expect(optionsFromTag).toContain('sourceSupertag');
    expect(number).toContain('minValue');
    expect(number).toContain('maxValue');
  });

  test('only field options and tags expose template outliner sections', () => {
    expect(definitionOutlinerLabel(makeNode({ type: 'tagDef' }))).toBe('Default content');
    expect(definitionOutlinerLabel(makeNode({ type: 'fieldDef', fieldType: 'options' }))).toBe('Pre-determined options');
    expect(definitionOutlinerLabel(makeNode({ type: 'fieldDef', fieldType: 'plain' }))).toBeNull();
  });
});
