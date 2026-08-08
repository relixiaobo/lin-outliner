import { beforeEach, describe, expect, test } from 'bun:test';
import {
  consumeSubagentDrill,
  requestSubagentDrill,
  resetSubagentDrillIntents,
  subscribeSubagentDrill,
} from '../../src/renderer/agent/store/subagentDrillIntent';

beforeEach(() => resetSubagentDrillIntents());

describe('Subagent drill intents', () => {
  test('describes one navigation, not a state the row keeps', () => {
    requestSubagentDrill('child', ['child', 'grandchild']);

    expect(consumeSubagentDrill('child')).toEqual(['child', 'grandchild']);
    // Reopening the same row later must show that row's own child, not the
    // target of a request the reader already followed.
    expect(consumeSubagentDrill('child')).toBeNull();
  });

  test('reaches a container that is already open', () => {
    // The row may already be expanded when Details asks, and a request that
    // only a fresh mount could see would be dropped — and then hijack the next
    // time that row is opened for its own sake.
    let notified = 0;
    const stop = subscribeSubagentDrill(() => { notified += 1; });
    requestSubagentDrill('child', ['child', 'grandchild']);
    expect(notified).toBe(1);
    stop();

    requestSubagentDrill('child', ['child', 'other']);
    expect(notified).toBe(1);
  });

  test('leaves a row nobody asked about alone', () => {
    requestSubagentDrill('child', ['child', 'grandchild']);

    expect(consumeSubagentDrill('other-child')).toBeNull();
    expect(consumeSubagentDrill('child')).toEqual(['child', 'grandchild']);
  });
});
