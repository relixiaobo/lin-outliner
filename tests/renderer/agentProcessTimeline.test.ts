import { describe, expect, test } from 'bun:test';
import type { AgentRenderChildRunEntity } from '../../src/core/agentRenderProjection';
import type { AgentToolResultWithPayloads, ToolCall } from '../../src/core/agentTypes';
import { isToolCallRowActive } from '../../src/renderer/ui/agent/AgentProcessTimeline';
import type { AgentProcessSegmentBlock } from '../../src/renderer/ui/agent/agentProcessTypes';

type ToolCallBlock = Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }>;

function toolBlock(id: string, extra: Partial<ToolCallBlock> = {}): ToolCallBlock {
  const toolCall: ToolCall = { type: 'toolCall', id, name: 'web_search', arguments: {} };
  return { kind: 'toolCall', toolCall, ...extra };
}

const noResults: ReadonlyMap<string, AgentToolResultWithPayloads> = new Map();

describe('isToolCallRowActive', () => {
  test('parallel un-settled calls all stay active before any is in-flight', () => {
    // One assistant fans out three calls; the runtime has not populated
    // pendingToolCallIds yet (the lag frame). Every row must spin, not flash red —
    // the old single-call narrowing left all but the last rendering as failed.
    for (const id of ['call-a', 'call-b', 'call-c']) {
      expect(isToolCallRowActive(toolBlock(id), new Set(), noResults, undefined, true)).toBe(true);
    }
  });

  test('a call in the in-flight set is active regardless of turn state', () => {
    expect(isToolCallRowActive(toolBlock('call-a'), new Set(['call-a']), noResults, undefined, false)).toBe(true);
  });

  test('a settled outcome stops the spinner even mid-turn', () => {
    expect(isToolCallRowActive(toolBlock('call-a', { outcome: 'completed' }), new Set(), noResults, undefined, true)).toBe(false);
    expect(isToolCallRowActive(toolBlock('call-a', { outcome: 'failed' }), new Set(), noResults, undefined, true)).toBe(false);
  });

  test('a result or a child run settles the row', () => {
    const withResult = new Map<string, AgentToolResultWithPayloads>([['call-a', {} as AgentToolResultWithPayloads]]);
    expect(isToolCallRowActive(toolBlock('call-a'), new Set(), withResult, undefined, true)).toBe(false);
    expect(isToolCallRowActive(toolBlock('call-a'), new Set(), noResults, {} as AgentRenderChildRunEntity, true)).toBe(false);
  });

  test('once the turn settles, an unanswered call is no longer active', () => {
    // turnActive false ⇒ falls through to its real error/incomplete state, never an
    // eternal spinner.
    expect(isToolCallRowActive(toolBlock('call-a'), new Set(), noResults, undefined, false)).toBe(false);
  });
});
