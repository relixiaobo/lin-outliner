import { createHash } from 'node:crypto';
import { OutlineContractError, outlineError } from './errors';

export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  return encodeCanonical(value, active, '$');
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalChangeSetHash(value: unknown): string {
  return canonicalSha256(value);
}

export function canonicalDiffHash<T extends Readonly<Record<string, unknown>>>(diff: T): string {
  const { diffHash: _ignored, ...hashable } = diff;
  return canonicalSha256(hashable);
}

function encodeCanonical(value: unknown, active: Set<object>, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidCanonicalValue(path, 'numbers must be finite');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') {
    throw invalidCanonicalValue(path, `unsupported value type: ${typeof value}`);
  }
  if (active.has(value)) throw invalidCanonicalValue(path, 'cyclic values are not supported');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => encodeCanonical(entry, active, `${path}[${index}]`)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidCanonicalValue(path, 'only plain JSON objects are supported');
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key], active, `${path}.${key}`)}`);
    return `{${entries.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

function invalidCanonicalValue(path: string, reason: string): OutlineContractError {
  return new OutlineContractError(outlineError(
    'invalid_input',
    'usage',
    `Cannot encode canonical JSON at ${path}: ${reason}.`,
  ));
}
