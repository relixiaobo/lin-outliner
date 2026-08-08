import { beforeEach, describe, expect, test } from 'bun:test';
import {
  consumeSubagentDrill,
  requestSubagentDrill,
  resetSubagentDrillIntents,
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

  test('leaves a row nobody asked about alone', () => {
    requestSubagentDrill('child', ['child', 'grandchild']);

    expect(consumeSubagentDrill('other-child')).toBeNull();
    expect(consumeSubagentDrill('child')).toEqual(['child', 'grandchild']);
  });
});
