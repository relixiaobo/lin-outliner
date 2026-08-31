import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { decodeThreadContextPayload } from '../../src/core/agent/codec';
import { boundedToolArgumentsForDisplay } from '../../src/core/agent/modelCallHistory';
import type {
  JsonValue,
  ThreadInternalTextPayloadReference,
  ToolCallArgumentsContextPayload,
} from '../../src/core/agent/protocol';
import {
  factorLargeTextArguments,
  projectLargeTextArgumentsForDisplay,
  rehydrateLargeTextArguments,
  selectLargeTextArguments,
} from '../../src/main/agent/runtime/largeTextArguments';
import type { AgentToolLargeTextArguments } from '../../src/main/agent/runtime/kernel/types';

describe('large-text tool arguments', () => {
  test('factors plural nested paths and rehydrates exact values with shared content references', async () => {
    const value = {
      request: {
        body: 'NUL:\0 slash:\\ Unicode:界 delimiter:EOF\n',
        nested: [{ text: 'NUL:\0 slash:\\ Unicode:界 delimiter:EOF\n' }],
      },
      mode: 'exact',
    } as const;
    const selected = selectLargeTextArguments(value, contract(['/request/body', '/request/nested/0/text']));
    const shared = reference(selected[0]!.value);
    const factored = factorLargeTextArguments(value, selected, [shared, shared]);

    expect(factored.payload).toEqual({
      schemaVersion: 1,
      kind: 'toolCallArguments',
      value: { request: { body: null, nested: [{ text: null }] }, mode: 'exact' },
      bindings: [
        { kind: 'internalText', path: '/request/body', ref: shared },
        { kind: 'internalText', path: '/request/nested/0/text', ref: shared },
      ],
    });
    expect(factored.internalTextRefs).toEqual([shared]);
    expect(await rehydrateLargeTextArguments(
      factored.payload,
      factored.internalTextRefs,
      async () => selected[0]!.value,
    )).toEqual(value);
  });

  test('rejects non-canonical, duplicate, reordered, non-string, and excessive bindings', () => {
    const value = { a: 'a', b: 'b', array: ['zero'] } as const;
    expect(() => selectLargeTextArguments(value, contract(['a']))).toThrow('canonical RFC 6901');
    expect(() => selectLargeTextArguments(value, contract(['/a~2b']))).toThrow('canonical RFC 6901');
    expect(() => selectLargeTextArguments(value, contract(['/array/01']))).toThrow('resolve to a string');
    expect(() => selectLargeTextArguments(value, contract(['/a', '/a']))).toThrow('unique');
    expect(() => selectLargeTextArguments(value, contract(['/b', '/a']))).toThrow('canonical path order');
    expect(() => selectLargeTextArguments({ a: 1 }, contract(['/a']))).toThrow('resolve to a string');

    const maximum = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [key(index), 'x'])) as JsonValue;
    const maximumPaths = Array.from({ length: 256 }, (_, index) => `/${key(index)}`);
    expect(selectLargeTextArguments(maximum, contract(maximumPaths, 256))).toHaveLength(256);
    const overflow = { ...(maximum as Record<string, JsonValue>), [key(256)]: 'x' };
    expect(() => selectLargeTextArguments(
      overflow,
      contract([...maximumPaths, `/${key(256)}`], 256),
    )).toThrow('binding count');
  });

  test('enforces well-formed Unicode and per-binding plus aggregate logical byte limits', () => {
    expect(() => selectLargeTextArguments({ text: '\ud800' }, contract(['/text']))).toThrow('well-formed Unicode');
    expect(() => selectLargeTextArguments({ text: '\udc00' }, contract(['/text']))).toThrow('well-formed Unicode');
    expect(() => selectLargeTextArguments(
      { text: '界' },
      contract(['/text'], 1, 3, 2),
    )).toThrow('byte limit');
    expect(() => selectLargeTextArguments(
      { a: 'same', b: 'same' },
      contract(['/a', '/b'], 2, 7),
    )).toThrow('aggregate limit');
    expect(selectLargeTextArguments(
      { a: 'same', b: 'same' },
      contract(['/a', '/b'], 2, 8),
    )).toHaveLength(2);
  });

  test('round-trips the canonical pointer for an empty object key through the payload codec', async () => {
    const value = { '': 'empty-key text', sibling: true } as const;
    const selected = selectLargeTextArguments(value, contract(['/']));
    const factored = factorLargeTextArguments(value, selected, [reference(value[''])]);
    const decoded = decodeThreadContextPayload(factored.payload);

    expect(decoded.kind).toBe('toolCallArguments');
    if (decoded.kind !== 'toolCallArguments') throw new Error('Expected tool-call arguments');
    expect(await rehydrateLargeTextArguments(decoded, factored.internalTextRefs, async () => value['']))
      .toEqual(value);
  });

  test('rejects overlapping, missing, extra, reordered, skeleton-mismatched, and corrupt stored dependencies', async () => {
    const a = reference('a');
    const b = reference('b');
    const valid: ToolCallArgumentsContextPayload = {
      schemaVersion: 1,
      kind: 'toolCallArguments',
      value: { a: null, b: null },
      bindings: [
        { kind: 'internalText', path: '/a', ref: a },
        { kind: 'internalText', path: '/b', ref: b },
      ],
    };
    expect(await rehydrateLargeTextArguments(valid, [a, b], async (ref) => ref.id === a.id ? 'a' : 'b'))
      .toEqual({ a: 'a', b: 'b' });
    expect(await rehydrateLargeTextArguments(valid, [a], async () => 'a')).toBeNull();
    expect(await rehydrateLargeTextArguments(valid, [a, b, reference('extra')], async () => 'a')).toBeNull();
    expect(await rehydrateLargeTextArguments(
      { ...valid, bindings: [...valid.bindings].reverse() },
      [a, b],
      async () => 'a',
    )).toBeNull();
    expect(await rehydrateLargeTextArguments(
      { ...valid, value: { a: 'not-null', b: null } },
      [a, b],
      async (ref) => ref.id === a.id ? 'a' : 'b',
    )).toBeNull();
    expect(await rehydrateLargeTextArguments(valid, [a, b], async () => 'corrupt')).toBeNull();
    expect(await rehydrateLargeTextArguments({
      ...valid,
      value: { a: null },
      bindings: [
        { kind: 'internalText', path: '/a', ref: a },
        { kind: 'internalText', path: '/a/child', ref: b },
      ],
    }, [a, b], async () => 'a')).toBeNull();
  });

  test('projects the same bounded presentation without constructing the complete bound value', async () => {
    const value = { before: 'plain', stdin: '界\\"\n'.repeat(20_000), after: [1, true, null] } as const;
    const selected = selectLargeTextArguments(value, contract(['/stdin']));
    const factored = factorLargeTextArguments(value, selected, [reference(value.stdin)]);
    let largestPrefixRequest = 0;
    const projected = await projectLargeTextArgumentsForDisplay(
      factored.payload,
      factored.internalTextRefs,
      async (_ref, maxPrefixChars) => {
        largestPrefixRequest = Math.max(largestPrefixRequest, maxPrefixChars);
        return projection(value.stdin, maxPrefixChars);
      },
    );

    expect(projected).toEqual(boundedToolArgumentsForDisplay(value));
    expect(JSON.stringify(projected, null, 2).length).toBeLessThanOrEqual(32_000);
    expect(largestPrefixRequest).toBe(32_001);

    const small = { stdin: 'literal input', nested: { ok: true } } as const;
    const smallSelected = selectLargeTextArguments(small, contract(['/stdin']));
    const smallFactored = factorLargeTextArguments(small, smallSelected, [reference(small.stdin)]);
    expect(await projectLargeTextArgumentsForDisplay(
      smallFactored.payload,
      smallFactored.internalTextRefs,
      async (_ref, maxPrefixChars) => projection(small.stdin, maxPrefixChars),
    )).toEqual(small);
  });
});

function contract(
  paths: readonly string[],
  maxBindings = Math.max(1, paths.length),
  maxAggregateBytes = 64 * 1024 * 1024,
  maxBytes = 64 * 1024 * 1024,
): AgentToolLargeTextArguments {
  return {
    maxBindings,
    maxAggregateBytes,
    select: () => paths.map((path) => ({
      kind: 'internalText',
      path,
      maxBytes,
      historyPolicy: 'secretScanText',
    })),
  };
}

function reference(text: string): ThreadInternalTextPayloadReference {
  const bytes = Buffer.from(text, 'utf8');
  return {
    id: createHash('sha256').update(bytes).digest('hex'),
    encoding: 'utf-8',
    byteLength: bytes.byteLength,
  };
}

function projection(text: string, maxPrefixChars: number) {
  return {
    textPrefix: text.slice(0, maxPrefixChars),
    textChars: text.length,
    jsonStringChars: JSON.stringify(text).length,
  };
}

function key(index: number): string {
  return `field${String(index).padStart(3, '0')}`;
}
