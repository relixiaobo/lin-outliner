import { describe, expect, test } from 'bun:test';
import { AgentDerivedFileCache } from '../../src/main/agent/capabilities/agentFileIngestionCache';

describe('AgentDerivedFileCache', () => {
  test('evicts least recently used entries after the limit', () => {
    const cache = new AgentDerivedFileCache(2);

    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get<number>('a')).toBe(1);
    cache.set('c', 3);

    expect(cache.get<number>('b')).toBeUndefined();
    expect(cache.get<number>('a')).toBe(1);
    expect(cache.get<number>('c')).toBe(3);
  });

  test('clones object values and clears process state explicitly', () => {
    const cache = new AgentDerivedFileCache();
    const original = { text: 'converted', nested: { chars: 9 } };

    cache.set('doc', original);
    original.nested.chars = 0;
    const first = cache.get<typeof original>('doc')!;
    first.nested.chars = 1;

    expect(cache.get<typeof original>('doc')!.nested.chars).toBe(9);
    cache.clear();
    expect(cache.get('doc')).toBeUndefined();
  });
});
