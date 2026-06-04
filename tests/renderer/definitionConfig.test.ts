import { describe, expect, test } from 'bun:test';
import type { NodeProjection } from '../../src/renderer/api/types';
import {
  definitionConfigItems,
  definitionKind,
  definitionOutlinerLabel,
} from '../../src/renderer/ui/definition/definitionConfig';
import { definitionConfigLabels } from '../../src/renderer/ui/definition/DefinitionConfigPanel';
import { getMessages } from '../../src/core/i18n';

// The pure registry takes localized labels; exercise the canonical English tree.
const labels = definitionConfigLabels(getMessages('en'));

function makeNode(overrides: Partial<NodeProjection>): NodeProjection {
  return {
    id: 'node',
    children: [],
    content: { text: 'Node', marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    locked: false,
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
    const withoutCheckbox = definitionConfigItems(makeNode({ type: 'tagDef' }), { showCheckbox: false }, labels).map((item) => item.key);
    const withCheckbox = definitionConfigItems(makeNode({ type: 'tagDef' }), { showCheckbox: true }, labels).map((item) => item.key);

    expect(withoutCheckbox).not.toContain('doneStateEnabled');
    expect(withCheckbox).toContain('doneStateEnabled');
  });

  test('reveals done-state mapping rows only when both checkbox and mapping are on', () => {
    const tag = makeNode({ type: 'tagDef' });
    const checkboxOnly = definitionConfigItems(tag, { showCheckbox: true, doneStateEnabled: false }, labels).map((item) => item.key);
    const mappingOn = definitionConfigItems(tag, { showCheckbox: true, doneStateEnabled: true }, labels).map((item) => item.key);

    expect(checkboxOnly).not.toContain('doneMapChecked');
    expect(checkboxOnly).not.toContain('doneMapUnchecked');
    expect(mappingOn).toContain('doneMapChecked');
    expect(mappingOn).toContain('doneMapUnchecked');
  });

  test('shows field type-specific rows without storing config as real children', () => {
    const fieldNode = makeNode({ type: 'fieldDef' });
    const plain = definitionConfigItems(fieldNode, { fieldType: 'plain' }, labels).map((item) => item.key);
    const options = definitionConfigItems(fieldNode, { fieldType: 'options' }, labels).map((item) => item.key);
    const optionsFromTag = definitionConfigItems(fieldNode, { fieldType: 'options_from_supertag' }, labels).map((item) => item.key);
    const number = definitionConfigItems(fieldNode, { fieldType: 'number' }, labels).map((item) => item.key);

    expect(plain).toContain('fieldType');
    expect(plain).toContain('autoInitialize');
    expect(plain).not.toContain('autocollectOptions');
    expect(options).toContain('autocollectOptions');
    expect(optionsFromTag).toContain('sourceSupertag');
    expect(number).toContain('minValue');
    expect(number).toContain('maxValue');
  });

  test('only field options and tags expose template outliner sections', () => {
    expect(definitionOutlinerLabel(makeNode({ type: 'tagDef' }), {}, labels.outliner)).toBe('Default content');
    expect(definitionOutlinerLabel(makeNode({ type: 'fieldDef' }), { fieldType: 'options' }, labels.outliner)).toBe('Pre-determined options');
    expect(definitionOutlinerLabel(makeNode({ type: 'fieldDef' }), { fieldType: 'plain' }, labels.outliner)).toBeNull();
  });
});
