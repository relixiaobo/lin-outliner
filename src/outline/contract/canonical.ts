import { createHash } from 'node:crypto';
import { OutlineContractError, outlineError } from './errors';

export function canonicalJson(value: unknown): string {
  return [...canonicalJsonChunks(value)].join('');
}

export function canonicalSha256(value: unknown): string {
  const hash = createHash('sha256');
  for (const chunk of canonicalJsonChunks(value)) hash.update(chunk);
  return hash.digest('hex');
}

export function canonicalChangeSetHash(value: unknown): string {
  return canonicalSha256(value);
}

export function canonicalDiffHash<T extends Readonly<Record<string, unknown>>>(diff: T): string {
  const { diffHash: _ignored, ...hashable } = diff;
  return canonicalSha256(hashable);
}

export function canonicalJsonChunks(value: unknown): Generator<string> {
  return encodeCanonical(value);
}

const CANONICAL_CHUNK_LENGTH = 64 * 1024;

type CanonicalTask =
  | { readonly kind: 'value'; readonly value: unknown; readonly path: string }
  | { readonly kind: 'text'; readonly text: string; readonly offset: number }
  | { readonly kind: 'array'; readonly value: readonly unknown[]; readonly index: number; readonly path: string }
  | {
    readonly kind: 'object';
    readonly value: Record<string, unknown>;
    readonly keys: readonly string[];
    readonly index: number;
    readonly path: string;
  };

function* encodeCanonical(value: unknown): Generator<string> {
  const active = new Set<object>();
  const tasks: CanonicalTask[] = [{ kind: 'value', value, path: '$' }];
  let parts: string[] = [];
  let length = 0;
  const append = (text: string) => {
    parts.push(text);
    length += text.length;
  };

  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === 'text') {
      const end = Math.min(task.text.length, task.offset + CANONICAL_CHUNK_LENGTH - length);
      append(task.text.slice(task.offset, end));
      if (end < task.text.length) tasks.push({ ...task, offset: end });
    } else if (task.kind === 'array') {
      if (task.index === task.value.length) {
        append(']');
        active.delete(task.value);
      } else {
        if (task.index > 0) append(',');
        tasks.push({ ...task, index: task.index + 1 });
        tasks.push({ kind: 'value', value: task.value[task.index], path: `${task.path}[${task.index}]` });
      }
    } else if (task.kind === 'object') {
      if (task.index === task.keys.length) {
        append('}');
        active.delete(task.value);
      } else {
        const key = task.keys[task.index]!;
        if (task.index > 0) append(',');
        tasks.push({ ...task, index: task.index + 1 });
        tasks.push({ kind: 'value', value: task.value[key], path: `${task.path}.${key}` });
        tasks.push({ kind: 'text', text: `${JSON.stringify(key)}:`, offset: 0 });
      }
    } else if (task.value === null) {
      append('null');
    } else if (typeof task.value === 'string' || typeof task.value === 'boolean') {
      tasks.push({ kind: 'text', text: JSON.stringify(task.value), offset: 0 });
    } else if (typeof task.value === 'number') {
      if (!Number.isFinite(task.value)) throw invalidCanonicalValue(task.path, 'numbers must be finite');
      append(JSON.stringify(Object.is(task.value, -0) ? 0 : task.value));
    } else if (typeof task.value !== 'object') {
      throw invalidCanonicalValue(task.path, `unsupported value type: ${typeof task.value}`);
    } else {
      if (active.has(task.value)) throw invalidCanonicalValue(task.path, 'cyclic values are not supported');
      active.add(task.value);
      if (Array.isArray(task.value)) {
        append('[');
        tasks.push({ kind: 'array', value: task.value, index: 0, path: task.path });
      } else {
        const prototype = Object.getPrototypeOf(task.value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw invalidCanonicalValue(task.path, 'only plain JSON objects are supported');
        }
        const record = task.value as Record<string, unknown>;
        append('{');
        tasks.push({ kind: 'object', value: record, keys: Object.keys(record).sort(), index: 0, path: task.path });
      }
    }

    if (length >= CANONICAL_CHUNK_LENGTH) {
      yield parts.join('');
      parts = [];
      length = 0;
    }
  }
  if (length > 0) yield parts.join('');
}

function invalidCanonicalValue(path: string, reason: string): OutlineContractError {
  return new OutlineContractError(outlineError(
    'invalid_input',
    'usage',
    `Cannot encode canonical JSON at ${path}: ${reason}.`,
  ));
}
