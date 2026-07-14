import { describe, expect, test } from 'bun:test';
import { inferFieldTypeFromValues, validateFieldValuesForType } from '../../src/core/fieldResolution';

describe('field value type resolution', () => {
  test('node references remain values under a plain field', () => {
    const references = [
      { text: 'Alpha', targetId: 'alpha' },
      { text: 'Beta', targetId: 'beta' },
    ];

    expect(inferFieldTypeFromValues(references)).toBe('plain');
    expect(validateFieldValuesForType('Related', 'plain', references)).toEqual({ ok: true });
  });

  test('plain fields accept mixed text and node-reference values', () => {
    const values = [
      { text: 'Context' },
      { text: 'Alpha', targetId: 'alpha' },
    ];

    expect(inferFieldTypeFromValues(values)).toBe('plain');
    expect(validateFieldValuesForType('Notes', 'plain', values)).toEqual({ ok: true });
  });

  test('scalar field types still reject node-reference values', () => {
    const result = validateFieldValuesForType('Score', 'number', [{ text: 'Alpha', targetId: 'alpha' }]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.instructions).toContain('plain field');
  });
});
