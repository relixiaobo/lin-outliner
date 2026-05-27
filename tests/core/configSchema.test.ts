import { describe, expect, test } from 'bun:test';
import {
  CONFIG_SCHEMA,
  TAG_CONFIG_KEYS,
  FIELD_CONFIG_KEYS,
  isInternalConfigNode,
  refRoleCountsAsBacklink,
  numberCodec,
  boolCodec,
  colorCodec,
  allSystemOptionNodeIds,
  ENUM_DOMAINS,
} from '../../src/core/configSchema';
import { systemOptionNodeId } from '../../src/core/types';

describe('config schema (Stage 0 definitions)', () => {
  test('isInternalConfigNode flags defConfig + systemOption only', () => {
    expect(isInternalConfigNode({ type: 'defConfig' })).toBe(true);
    expect(isInternalConfigNode({ type: 'systemOption' })).toBe(true);
    expect(isInternalConfigNode({ type: 'fieldDef' })).toBe(false);
    expect(isInternalConfigNode({ type: 'reference' })).toBe(false);
    expect(isInternalConfigNode({})).toBe(false);
  });

  test('backlink allowlist: link/fieldValue in, config/enum/system out', () => {
    expect(refRoleCountsAsBacklink({ type: 'reference', refRole: 'link' })).toBe(true);
    expect(refRoleCountsAsBacklink({ type: 'reference', refRole: 'fieldValue' })).toBe(true);
    expect(refRoleCountsAsBacklink({ type: 'reference' })).toBe(true); // legacy ⇒ link
    expect(refRoleCountsAsBacklink({ type: 'reference', refRole: 'config' })).toBe(false);
    expect(refRoleCountsAsBacklink({ type: 'reference', refRole: 'enum' })).toBe(false);
    expect(refRoleCountsAsBacklink({ type: 'fieldEntry' })).toBe(false); // not a reference
  });

  test('scalar codecs round-trip and reject invalid text', () => {
    expect(numberCodec.decode('42')).toBe(42);
    expect(numberCodec.decode('   ')).toBeUndefined();
    expect(numberCodec.decode('abc')).toBeUndefined();
    expect(numberCodec.encode(42)).toBe('42');
    expect(numberCodec.validate(Number.NaN)).not.toBeNull();

    expect(boolCodec.decode('true')).toBe(true);
    expect(boolCodec.decode('FALSE')).toBe(false);
    expect(boolCodec.decode('maybe')).toBeUndefined();
    expect(boolCodec.encode(false)).toBe('false');

    // Color is a free token: hex or a named palette key both pass through;
    // only blank text is "unset". Resolution to RGB happens at render time.
    expect(colorCodec.decode('#7C9ABC')).toBe('#7C9ABC');
    expect(colorCodec.decode('red')).toBe('red');
    expect(colorCodec.decode('   ')).toBeUndefined();
    expect(colorCodec.validate('anything')).toBeNull();
  });

  test('registry covers tag + field knobs with visibleWhen gating', () => {
    expect(TAG_CONFIG_KEYS).toContain('color');
    expect(FIELD_CONFIG_KEYS).toContain('fieldType');
    expect(CONFIG_SCHEMA.doneStateEnabled.visibleWhen?.({ showCheckbox: true })).toBe(true);
    expect(CONFIG_SCHEMA.doneStateEnabled.visibleWhen?.({ showCheckbox: false })).toBe(false);
    expect(CONFIG_SCHEMA.minValue.visibleWhen?.({ fieldType: 'number' })).toBe(true);
    expect(CONFIG_SCHEMA.minValue.visibleWhen?.({ fieldType: 'date' })).toBe(false);
  });

  test('system option ids are stable + derived, never random', () => {
    const ids = allSystemOptionNodeIds();
    expect(ids).toContain(systemOptionNodeId(ENUM_DOMAINS.fieldType.subtreeId, 'number'));
    expect(ids).toContain(systemOptionNodeId(ENUM_DOMAINS.hideField.subtreeId, 'always'));
    expect(allSystemOptionNodeIds()).toEqual(ids); // deterministic
  });
});
