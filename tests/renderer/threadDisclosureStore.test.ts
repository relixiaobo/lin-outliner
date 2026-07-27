import { beforeEach, describe, expect, test } from 'bun:test';
import {
  resetThreadDisclosureStore,
  setThreadDisclosureOverride,
  subscribeThreadDisclosure,
  threadDisclosureSnapshot,
} from '../../src/renderer/agent/store/threadDisclosureStore';

beforeEach(() => resetThreadDisclosureStore());

describe('Thread disclosure store', () => {
  test('records stable per-Thread overrides', () => {
    const before = threadDisclosureSnapshot('thread-1');
    expect(before['reasoning:item-1']).toBeUndefined();

    setThreadDisclosureOverride('thread-1', 'reasoning:item-1', true);
    const after = threadDisclosureSnapshot('thread-1');
    expect(after['reasoning:item-1']).toBe(true);
    expect(after).not.toBe(before);

    setThreadDisclosureOverride('thread-1', 'reasoning:item-1', true);
    expect(threadDisclosureSnapshot('thread-1')).toBe(after);
    expect(threadDisclosureSnapshot('thread-2')['reasoning:item-1']).toBeUndefined();
  });

  test('notifies only the owning Thread on a real change', () => {
    let ownerCalls = 0;
    let otherCalls = 0;
    const unsubscribeOwner = subscribeThreadDisclosure('thread-1', () => { ownerCalls += 1; });
    const unsubscribeOther = subscribeThreadDisclosure('thread-2', () => { otherCalls += 1; });

    setThreadDisclosureOverride('thread-1', 'tools:item-1', true);
    setThreadDisclosureOverride('thread-1', 'tools:item-1', true);
    expect(ownerCalls).toBe(1);
    expect(otherCalls).toBe(0);

    unsubscribeOwner();
    unsubscribeOther();
    setThreadDisclosureOverride('thread-1', 'tools:item-1', false);
    expect(ownerCalls).toBe(1);
  });
});
