import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import type { CommandOutcome } from '../../src/core/types';
import { buildConfigIndex } from '../../src/core/configProjection';
import { defConfigNodeId } from '../../src/core/types';
import { TAG_CONFIG_KEYS } from '../../src/core/configSchema';

function mustFocus(outcome: CommandOutcome): string {
  if (!outcome.focus) throw new Error('expected focus');
  return outcome.focus.nodeId;
}

function fieldDefOf(core: Core, templateEntryId: string): string {
  const id = core.state().nodes[templateEntryId]?.fieldDefId;
  if (!id) throw new Error('expected a fieldDefId on the template entry');
  return id;
}

describe('config-as-nodes value mechanism (Stage 4)', () => {
  test('reconcile materializes the fixed defConfig row set, idempotently', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('event'));

    core.reconcileConfigSubtree(tagId);
    const rows = () => Object.values(core.state().nodes).filter((n) => n.type === 'defConfig' && n.parentId === tagId);
    expect(rows().length).toBe(TAG_CONFIG_KEYS.length);
    for (const key of TAG_CONFIG_KEYS) {
      expect(core.state().nodes[defConfigNodeId(tagId, key)]?.configKey).toBe(key);
    }

    core.reconcileConfigSubtree(tagId);
    expect(rows().length).toBe(TAG_CONFIG_KEYS.length);
  });

  test('tag config round-trips through setConfigValue + accessor', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('event'));
    const otherTag = mustFocus(core.createTag('place'));

    core.setConfigValue(tagId, { kind: 'scalar', configKey: 'showCheckbox', text: 'true' });
    core.setConfigValue(tagId, { kind: 'scalar', configKey: 'color', text: '#aabbcc' });
    core.setConfigValue(tagId, { kind: 'ref', configKey: 'extends', targetId: otherTag });

    const tag = buildConfigIndex(core.state()).tag(tagId);
    expect(tag?.showCheckbox).toBe(true);
    expect(tag?.doneStateEnabled).toBe(false);
    expect(tag?.color).toBe('#aabbcc');
    expect(tag?.extends).toBe(otherTag);
    expect(tag?.childSupertag).toBeUndefined();
  });

  test('field config round-trips: enum / scalar / enumList', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('event'));
    const fieldDefId = fieldDefOf(core, mustFocus(core.createFieldDef(tagId, 'Priority', 'plain')));

    core.setConfigValue(fieldDefId, { kind: 'enum', configKey: 'fieldType', value: 'number' });
    core.setConfigValue(fieldDefId, { kind: 'scalar', configKey: 'minValue', text: '1' });
    core.setConfigValue(fieldDefId, { kind: 'scalar', configKey: 'maxValue', text: '10' });
    core.setConfigValue(fieldDefId, { kind: 'enum', configKey: 'cardinality', value: 'list' });
    core.setConfigValue(fieldDefId, { kind: 'enumList', configKey: 'autoInitialize', values: ['current_date', 'ancestor_day_node'] });

    const field = buildConfigIndex(core.state()).field(fieldDefId);
    expect(field?.fieldType).toBe('number');
    expect(field?.cardinality).toBe('list');
    expect(field?.minValue).toBe(1);
    expect(field?.maxValue).toBe(10);
    expect(field?.autoInitialize).toEqual(['current_date', 'ancestor_day_node']);
    expect(field?.nullable).toBe(false);
    expect(field?.hideField).toBe('never');
  });

  test('setting a value replaces the prior one (single cardinality)', () => {
    const core = Core.new();
    const fieldDefId = fieldDefOf(core, mustFocus(core.createFieldDef(mustFocus(core.createTag('t')), 'f', 'plain')));

    core.setConfigValue(fieldDefId, { kind: 'enum', configKey: 'fieldType', value: 'number' });
    core.setConfigValue(fieldDefId, { kind: 'enum', configKey: 'fieldType', value: 'date' });
    expect(buildConfigIndex(core.state()).field(fieldDefId)?.fieldType).toBe('date');

    const rowId = defConfigNodeId(fieldDefId, 'fieldType');
    const valueChildren = core.state().nodes[rowId]?.children ?? [];
    expect(valueChildren.length).toBe(1);
  });

  test('a null/empty payload clears the value', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('event'));
    core.setConfigValue(tagId, { kind: 'scalar', configKey: 'color', text: '#aabbcc' });
    expect(buildConfigIndex(core.state()).tag(tagId)?.color).toBe('#aabbcc');
    core.setConfigValue(tagId, { kind: 'scalar', configKey: 'color', text: null });
    expect(buildConfigIndex(core.state()).tag(tagId)?.color).toBeUndefined();
  });

  test('setConfigValue validates domain, kind, enum value, and definition', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('event'));

    // invalid color text
    expect(() => core.setConfigValue(tagId, { kind: 'scalar', configKey: 'color', text: 'red' })).toThrow();
    // wrong kind for the key (color is scalar, not ref)
    expect(() => core.setConfigValue(tagId, { kind: 'ref', configKey: 'color', targetId: tagId })).toThrow();
    // a field-only key cannot be set on a tag definition
    expect(() => core.setConfigValue(tagId, { kind: 'enum', configKey: 'fieldType', value: 'number' })).toThrow();

    const fieldDefId = fieldDefOf(core, mustFocus(core.createFieldDef(tagId, 'f', 'plain')));
    expect(() => core.setConfigValue(fieldDefId, { kind: 'enum', configKey: 'fieldType', value: 'bogus' })).toThrow();
  });

  test('config-value references carry config/enum refRole and stay out of backlinks', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('event'));
    const otherTag = mustFocus(core.createTag('place'));
    const fieldDefId = fieldDefOf(core, mustFocus(core.createFieldDef(tagId, 'f', 'plain')));

    core.setConfigValue(tagId, { kind: 'ref', configKey: 'extends', targetId: otherTag });
    core.setConfigValue(fieldDefId, { kind: 'enum', configKey: 'fieldType', value: 'number' });

    const refs = Object.values(core.state().nodes).filter((n) => n.type === 'reference');
    const configRef = refs.find((n) => n.targetId === otherTag);
    expect(configRef?.refRole).toBe('config');
    const enumRef = refs.find((n) => n.refRole === 'enum');
    expect(enumRef).toBeDefined();

    // config/enum references must not count as backlinks of their targets.
    expect(core.backlinks(otherTag).length).toBe(0);
  });

  test('config rows are structurally locked against user commands', () => {
    const core = Core.new();
    const tagId = mustFocus(core.createTag('event'));
    core.reconcileConfigSubtree(tagId);
    const rowId = defConfigNodeId(tagId, 'color');
    expect(() => core.deleteNode(rowId)).toThrow();
    expect(() => core.createNode(rowId, null, 'x')).toThrow();
  });
});
