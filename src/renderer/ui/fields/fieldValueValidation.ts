import type { FieldType } from '../../api/types';

export interface FieldValueConstraints {
  min?: number;
  max?: number;
}

/**
 * Non-blocking field-value validation (Tana / nodex parity). Returns a
 * human-readable warning when a value violates its field's constraints, or null
 * when it is acceptable. The value is never rejected — this only drives a visual
 * hint, so out-of-range numbers stay editable and stored.
 */
export function validateFieldValue(
  fieldType: FieldType | undefined,
  value: string,
  constraints: FieldValueConstraints = {},
): string | null {
  if (!value.trim()) return null;
  if (fieldType === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) return 'Value should be a number';
    if (constraints.min != null && num < constraints.min) return `Value should be ≥ ${constraints.min}`;
    if (constraints.max != null && num > constraints.max) return `Value should be ≤ ${constraints.max}`;
  }
  return null;
}
