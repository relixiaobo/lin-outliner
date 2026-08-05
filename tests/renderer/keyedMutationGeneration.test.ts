import { describe, expect, test } from 'bun:test';
import { beginKeyedMutation, isCurrentKeyedMutation } from '../../src/renderer/ui/keyedMutationGeneration';

describe('keyed mutation generation', () => {
  test('an unrelated mutation does not stale an in-flight rollback', () => {
    const generations = new Map<string, number>();
    const skill = beginKeyedMutation(generations, 'skill:writer');
    beginKeyedMutation(generations, 'capability:curl * | sh');

    expect(isCurrentKeyedMutation(generations, 'skill:writer', skill)).toBe(true);
  });

  test('a newer mutation for the same resource stales the old result', () => {
    const generations = new Map<string, number>();
    const first = beginKeyedMutation(generations, 'providers');
    const second = beginKeyedMutation(generations, 'providers');

    expect(isCurrentKeyedMutation(generations, 'providers', first)).toBe(false);
    expect(isCurrentKeyedMutation(generations, 'providers', second)).toBe(true);
  });
});
