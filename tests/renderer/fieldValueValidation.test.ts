import { describe, expect, test } from 'bun:test';
import { validateFieldValue } from '../../src/renderer/ui/fields/fieldValueValidation';

describe('validateFieldValue (non-blocking)', () => {
  test('empty value never warns', () => {
    expect(validateFieldValue('number', '', { min: 1, max: 5 })).toBeNull();
    expect(validateFieldValue('number', '   ', { min: 1 })).toBeNull();
  });

  test('non-numeric text in a number field warns', () => {
    expect(validateFieldValue('number', 'abc')).toBe('Value should be a number');
  });

  test('below minimum warns with the bound', () => {
    expect(validateFieldValue('number', '0', { min: 1 })).toBe('Value should be ≥ 1');
  });

  test('above maximum warns with the bound', () => {
    expect(validateFieldValue('number', '10', { max: 5 })).toBe('Value should be ≤ 5');
  });

  test('in-range value passes', () => {
    expect(validateFieldValue('number', '3', { min: 1, max: 5 })).toBeNull();
    expect(validateFieldValue('number', '3', {})).toBeNull();
  });

  test('boundaries are inclusive', () => {
    expect(validateFieldValue('number', '1', { min: 1, max: 5 })).toBeNull();
    expect(validateFieldValue('number', '5', { min: 1, max: 5 })).toBeNull();
  });

  test('non-number field types are not range-validated', () => {
    expect(validateFieldValue('plain', 'anything', { min: 1, max: 5 })).toBeNull();
    expect(validateFieldValue(undefined, '999', { max: 5 })).toBeNull();
  });
});
