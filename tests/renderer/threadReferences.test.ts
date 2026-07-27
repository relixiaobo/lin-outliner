import { describe, expect, test } from 'bun:test';
import {
  threadNodeIdFromReferenceHref,
  threadNodeReferenceHref,
  threadNodeReferenceOpenOptionsFromClick,
} from '../../src/renderer/agent/threadReferences';

describe('Thread Node references', () => {
  test('round-trips Node IDs through the renderer-only href', () => {
    const nodeId = 'node/with spaces';
    expect(threadNodeIdFromReferenceHref(threadNodeReferenceHref(nodeId))).toBe(nodeId);
  });

  test('preserves the native new-pane modifier contract', () => {
    expect(threadNodeReferenceOpenOptionsFromClick({ metaKey: true, ctrlKey: false })).toEqual({ newPane: true });
    expect(threadNodeReferenceOpenOptionsFromClick({ metaKey: false, ctrlKey: true })).toEqual({ newPane: true });
    expect(threadNodeReferenceOpenOptionsFromClick({ metaKey: false, ctrlKey: false })).toEqual({ newPane: false });
  });
});
