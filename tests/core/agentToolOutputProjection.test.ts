import { describe, expect, test } from 'bun:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import type {
  ContextEvidenceThreadItem,
  ThreadContextPayload,
  ThreadContextPayloadReference,
  ThreadItem,
  ThreadItemOutputReference,
  Turn,
} from '../../src/core/agent/protocol';
import { freezePendingToolOutputProjections } from '../../src/main/agent/context/ToolOutputProjection';
import { uuidV7 } from '../../src/main/agent/uuid';

const model = {
  id: 'projection-test',
  name: 'Projection Test',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://example.test',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 2_000,
  maxTokens: 200,
} as Model<Api>;

describe('tool-output projection freezing', () => {
  test('starts a fresh full-output budget after context reset', async () => {
    const priorOutput = outputReference('a', 1_600);
    const currentOutput = outputReference('b', 800);
    const priorPayload = {
      schemaVersion: 1 as const,
      kind: 'toolOutputProjection' as const,
      outputRef: priorOutput,
      projection: { type: 'full' as const },
    };
    const priorPayloadRef = contextReference('c', priorPayload.kind);
    const priorEvidence = evidence('prior-projection', priorPayloadRef, priorOutput);
    const priorTurn = turn('prior-turn', [priorEvidence]);
    const resetId = uuidV7();
    const resetTurn = turn('reset-turn', [{
      type: 'contextReset',
      id: resetId,
      provenance: provenance(resetId, 'reset-turn'),
      clearedThrough: { turnId: priorTurn.id, itemId: priorEvidence.id },
    }]);
    const currentTurn = turn('current-turn', [completedTool('current-tool', currentOutput)]);
    const published: ThreadContextPayload[] = [];

    await freezePendingToolOutputProjections({
      turns: [priorTurn, resetTurn, currentTurn],
      model,
      readContext: async (ref) => ref.id === priorPayloadRef.id ? priorPayload : null,
      persist: async (payload) => {
        published.push(payload);
        return evidence(
          `published-${published.length}`,
          contextReference('d', payload.kind),
          payload.outputRef,
        );
      },
    });

    expect(published).toEqual([expect.objectContaining({
      kind: 'toolOutputProjection',
      outputRef: currentOutput,
      projection: { type: 'full' },
    })]);
  });
});

function turn(seed: string, items: readonly ThreadItem[]): Turn {
  const id = uuidV7();
  return {
    id,
    items,
    itemsView: 'full',
    provenance: { originThreadId: provenanceThreadId(), originTurnId: id, trigger: { kind: 'user' } },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: model.id,
      reasoningEffort: 'medium',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    },
    startedAt: seed.length,
    completedAt: seed.length + 1,
    durationMs: 1,
  };
}

function completedTool(id: string, outputRef: ThreadItemOutputReference): ThreadItem {
  return {
    type: 'dynamicToolCall',
    id,
    provenance: provenance(id, 'current-turn'),
    namespace: null,
    tool: 'file_read',
    arguments: { file_path: '/workspace/current.txt' },
    status: 'completed',
    outputRef,
    contentItems: [{ type: 'text', text: 'Current output' }],
    success: true,
    durationMs: 1,
  };
}

function evidence(
  id: string,
  payloadRef: ThreadContextPayloadReference,
  outputRef: ThreadItemOutputReference,
): ContextEvidenceThreadItem {
  return {
    type: 'contextEvidence',
    id,
    provenance: provenance(id, 'prior-turn'),
    kind: 'toolOutputProjection',
    payloadRef,
    summary: 'Frozen output',
    contextRefs: [],
    resourceRefs: [],
    outputRefs: [outputRef],
  };
}

function outputReference(seed: string, byteLength: number): ThreadItemOutputReference {
  return {
    id: seed.repeat(64),
    mimeType: 'text/plain',
    byteLength,
    summary: `${seed} output`,
  };
}

function contextReference(
  seed: string,
  kind: ThreadContextPayloadReference['kind'],
): ThreadContextPayloadReference {
  return {
    id: seed.repeat(64),
    mimeType: 'application/vnd.tenon.agent-context+json',
    byteLength: 100,
    schemaVersion: 1,
    kind,
  };
}

function provenance(itemId: string, turnSeed: string) {
  return {
    originThreadId: provenanceThreadId(),
    originTurnId: uuidV7(turnSeed.length),
    originItemId: itemId,
  };
}

function provenanceThreadId() {
  return uuidV7(1);
}
