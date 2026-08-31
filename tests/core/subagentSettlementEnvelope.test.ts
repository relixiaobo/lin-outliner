import { describe, expect, test } from 'bun:test';
import type { ThreadResourceReference } from '../../src/core/agent/protocol';
import type {
  SubagentExecutionRecord,
  SubagentPendingNotification,
} from '../../src/main/agent/persistence/SubagentExecutionLedger';
import {
  projectSubagentHandoff,
  type SubagentSettlementEnvelopeCandidate,
} from '../../src/main/agent/thread/subagentSettlementEnvelope';

describe('SubagentHandoffProjector', () => {
  test('projects complete child text without execution diagnostics', () => {
    const result = projectSubagentHandoff({
      batchId: 'foreground-batch',
      origin: 'foreground',
      candidates: [candidate('A complete child answer.')],
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected a ready handoff.');
    expect(result.envelope.coverage).toMatchObject({ full: 1, excerpted: 0, omitted: 0 });
    expect(result.envelope.text).toContain('A complete child answer.');
    expect(result.envelope.text).not.toContain('/private/worktree');
    expect(result.envelope.text).not.toContain('duration');
    expect(result.envelope.text).not.toContain('tokens-used');
    expect(result.envelope.text).not.toContain('transcript-fallback');
  });

  test('projects only citations retained by an excerpt and adds an opaque transcript fallback', () => {
    const selectedRef = resourceRef('resource:00000000-0000-4000-8000-000000000001', 'selected.txt');
    const omittedRef = resourceRef('resource:00000000-0000-4000-8000-000000000002', 'omitted.txt');
    const transcriptRef = resourceRef(
      'resource:00000000-0000-4000-8000-000000000003',
      'delegated-transcript-agent-1-g1.md',
    );
    const output = [
      'Selected [[file:///workspace/selected.txt]]',
      'x'.repeat(6_000),
      'Omitted [[file:///workspace/omitted.txt]]',
      'x'.repeat(6_000),
      'Plain tail text.',
    ].join('\n');
    const result = projectSubagentHandoff({
      batchId: 'excerpt-batch',
      origin: 'foreground',
      candidates: [candidate(output, [
        { markerOrdinal: 0, status: 'available', resourceRef: selectedRef },
        { markerOrdinal: 1, status: 'available', resourceRef: omittedRef },
      ], transcriptRef)],
      maxTokens: 4_000,
      maxBytes: 2_000,
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected a ready handoff.');
    expect(result.envelope.coverage.excerpted).toBe(1);
    expect(result.envelope.text).toContain('<transcript-fallback');
    expect(result.envelope.text).toContain('availability="available"');
    expect(result.envelope.text).toContain('resource-name="delegated-transcript-agent-1-g1.md"');
    expect(result.envelope.text).not.toContain('/thread-transcripts/');
    expect(result.envelope.resourceRefs).toContainEqual(selectedRef);
    expect(result.envelope.resourceRefs).toContainEqual(transcriptRef);
    expect(result.envelope.resourceRefs).not.toContainEqual(omittedRef);
  });

  test('records omitted coverage when only the control frame fits', () => {
    const result = projectSubagentHandoff({
      batchId: 'omitted-batch',
      origin: 'background',
      candidates: [candidate('y'.repeat(8_000))],
      maxTokens: 600,
      maxBytes: 1_100,
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected a ready handoff.');
    expect(result.envelope.coverage.omitted).toBe(1);
    expect(result.envelope.text).toContain('disposition="omitted"');
    expect(result.envelope.text).toContain('<transcript-fallback');
    expect(result.envelope.text).toContain('availability="unavailable"');
    expect(result.envelope.text).not.toContain('resource-name=');
  });
});

function candidate(
  output: string,
  citations: SubagentSettlementEnvelopeCandidate['citations'] = [],
  transcriptFallbackRef?: ThreadResourceReference,
): SubagentSettlementEnvelopeCandidate {
  return {
    execution: {
      description: 'Inspect delegated work',
      tokensUsed: 987,
      worktree: { path: '/private/worktree' },
    } as unknown as SubagentExecutionRecord,
    notification: {
      agentId: 'agent-1',
      generation: 1,
      parentThreadId: 'parent-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 987,
      settlementCoverage: null,
      state: 'delivered',
      deliveryTurnId: null,
      deliveryClass: 'ordinary',
      eligibleAfterGeneration: null,
      batchId: null,
      coverageDisposition: null,
      omittedBytes: 0,
      omittedTokens: 0,
      createdAt: 1,
      deliveredAt: 1,
    } satisfies SubagentPendingNotification,
    output,
    citations,
    ...(transcriptFallbackRef ? { transcriptFallbackRef } : {}),
  };
}

function resourceRef(id: string, fileName: string): ThreadResourceReference {
  return {
    kind: 'resource',
    id,
    byteLength: 10,
    mediaType: 'text/plain',
    fileName,
  };
}
