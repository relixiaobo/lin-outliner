import type { FieldType } from '../../api/types';
import { parseDateFieldValue } from '../../api/types';

export interface FieldValueConstraints {
  min?: number;
  max?: number;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Non-blocking field-value validation. Returns a human-readable warning when a
 * value does not match its field's expected shape, or null when it is
 * acceptable. The value is never rejected — this only drives a row-end hint, so
 * an out-of-range number or a half-typed url stays editable and stored. This is
 * the additive "validation layer" every typed field value (number / url / email
 * / date) shares; the field type still edits as a plain node row.
 */
export function validateFieldValue(
  fieldType: FieldType | undefined,
  value: string,
  constraints: FieldValueConstraints = {},
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (fieldType === 'number') {
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return 'Value should be a number';
    if (constraints.min != null && num < constraints.min) return `Value should be ≥ ${constraints.min}`;
    if (constraints.max != null && num > constraints.max) return `Value should be ≤ ${constraints.max}`;
  }
  if (fieldType === 'url' && !looksLikeUrl(trimmed)) return 'Value should be a URL';
  if (fieldType === 'email' && !EMAIL_PATTERN.test(trimmed)) return 'Value should be an email';
  if (fieldType === 'date' && !parseDateFieldValue(trimmed)) return 'Value should be a date';
  return null;
}

function looksLikeUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (/^https?:\/\/\S+$/i.test(value)) return true;
  // Allow a scheme-less host like `example.com/path` — lenient on purpose, so
  // the hint only fires on input that is clearly not a url.
  return /^[^\s/]+\.[^\s/]+/.test(value);
}

/**
 * The external target a well-formed url / email field value opens to, or null
 * when the value is not openable. Drives the additive link affordance on a
 * url / email value row. A scheme-less url is opened over https; an email over
 * mailto.
 */
export function fieldValueOpenHref(fieldType: FieldType | undefined, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (fieldType === 'url') {
    if (!looksLikeUrl(trimmed)) return null;
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  if (fieldType === 'email') {
    if (!EMAIL_PATTERN.test(trimmed)) return null;
    return `mailto:${trimmed}`;
  }
  return null;
}
