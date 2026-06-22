import { beforeEach, describe, expect, test } from 'bun:test';
import {
  disclosureSnapshot,
  resetDisclosureStore,
  setDisclosureOverride,
  subscribeDisclosure,
} from '../../src/renderer/ui/agent/agentDisclosureStore';

beforeEach(() => resetDisclosureStore());

describe('agent disclosure store', () => {
  test('records and reads back a per-conversation override', () => {
    expect(disclosureSnapshot('c1').fold).toBeUndefined();
    setDisclosureOverride('c1', 'fold', true);
    expect(disclosureSnapshot('c1').fold).toBe(true);
    setDisclosureOverride('c1', 'fold', false);
    expect(disclosureSnapshot('c1').fold).toBe(false);
  });

  test('snapshot reference is stable until a real change (useSyncExternalStore contract)', () => {
    const before = disclosureSnapshot('c1');
    // No change → identical reference, so useSyncExternalStore does not loop.
    expect(disclosureSnapshot('c1')).toBe(before);
    setDisclosureOverride('c1', 'fold', true);
    expect(disclosureSnapshot('c1')).not.toBe(before);
    const after = disclosureSnapshot('c1');
    // Writing the SAME value is a no-op → reference unchanged.
    setDisclosureOverride('c1', 'fold', true);
    expect(disclosureSnapshot('c1')).toBe(after);
  });

  test('conversations are isolated', () => {
    setDisclosureOverride('c1', 'fold', true);
    expect(disclosureSnapshot('c2').fold).toBeUndefined();
  });

  test('notifies subscribers on a real change only, and stops after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeDisclosure('c1', () => { calls += 1; });
    setDisclosureOverride('c1', 'fold', true);
    expect(calls).toBe(1);
    setDisclosureOverride('c1', 'fold', true); // no-op, no notify
    expect(calls).toBe(1);
    unsubscribe();
    setDisclosureOverride('c1', 'fold', false);
    expect(calls).toBe(1);
  });
});
