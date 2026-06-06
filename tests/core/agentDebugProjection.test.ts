import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentActor, AgentEvent } from '../../src/core/agentEventLog';
import { createAgentDebugPayloadEnvelope } from '../../src/main/agentDebug';
import { deriveAgentDebugProjectionFromEvents } from '../../src/main/agentDebugProjection';
import { AgentEventStore } from '../../src/main/agentEventStore';

const sessionId = 'debug-session-1';
const systemActor: AgentActor = { type: 'system' };
const agentActor: AgentActor = { type: 'agent', agentId: 'pi-mono' };

const usage = {
  input: 120,
  output: 30,
  cacheRead: 10,
  cacheWrite: 5,
  totalTokens: 165,
  cost: {
    input: 0.0012,
    output: 0.003,
    cacheRead: 0.0001,
    cacheWrite: 0.0002,
    total: 0.0045,
  },
};

async function withStore<T>(fn: (store: AgentEventStore) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-agent-debug-projection-'));
  try {
    return await fn(new AgentEventStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function base(seq: number, type: AgentEvent['type'], actor: AgentActor = systemActor) {
  return {
    v: 1 as const,
    eventId: `event-${seq}`,
    seq,
    sessionId,
    type,
    createdAt: 1_800_000_000_000 + seq,
    actor,
  };
}

describe('agent debug projection', () => {
  test('rebuilds debug history and totals from events and payload refs after restore', async () => {
    await withStore(async (store) => {
      const providerPayload = {
        system: 'You are Lin agent.',
        messages: [{ role: 'user', content: 'Summarize the restored session.' }],
        tools: [{ name: 'node_read', description: 'Read node context', input_schema: { type: 'object' } }],
      };
      const envelope = createAgentDebugPayloadEnvelope(providerPayload);
      const payloadRef = await store.writePayload(sessionId, {
        id: 'debug-payload-1',
        data: envelope.json,
        mimeType: 'application/json',
        role: 'debug',
        summary: 'Provider payload round 1',
      });
      const responseEnvelope = createAgentDebugPayloadEnvelope({
        status: 200,
        headers: { 'x-request-id': 'req-1' },
      });
      const responsePayloadRef = await store.writePayload(sessionId, {
        id: 'debug-response-1',
        data: responseEnvelope.json,
        mimeType: 'application/json',
        role: 'debug',
        summary: 'Provider response round 2',
      });

      await store.appendEvents(sessionId, [
        { ...base(1, 'session.created'), title: 'Restored debug session' },
        { ...base(2, 'run.started'), runId: 'run-1' },
        { ...base(3, 'payload.created'), payload: payloadRef },
        {
          ...base(4, 'debug.snapshot.created'),
          runId: 'run-1',
          debugId: 'debug-1',
          source: 'provider_payload',
          queryIndex: 1,
          turnIndex: 1,
          payloadRef,
          wire: { bytes: envelope.bytes, hash: envelope.hash },
          model: { id: 'gpt-test', provider: 'openai', api: 'responses', contextWindow: 128_000 },
        },
        { ...base(5, 'payload.created'), payload: responsePayloadRef },
        {
          ...base(6, 'debug.snapshot.created'),
          runId: 'run-1',
          debugId: 'debug-response-1',
          source: 'provider_response',
          queryIndex: 1,
          turnIndex: 2,
          payloadRef: responsePayloadRef,
          wire: { bytes: responseEnvelope.bytes, hash: responseEnvelope.hash },
          model: { id: 'gpt-test', provider: 'openai', api: 'responses', contextWindow: 128_000 },
        },
        {
          ...base(7, 'assistant_message.started', agentActor),
          runId: 'run-1',
          messageId: 'assistant-1',
          parentMessageId: null,
          providerId: 'openai',
          modelId: 'gpt-test',
          apiId: 'responses',
        },
        {
          ...base(8, 'assistant_message.completed', agentActor),
          runId: 'run-1',
          messageId: 'assistant-1',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Restored debug response.' }],
          usage,
        },
        { ...base(9, 'run.completed'), runId: 'run-1' },
      ]);

      const restoredStore = new AgentEventStore(store.paths(sessionId).rootDir);
      const projection = await deriveAgentDebugProjectionFromEvents({
        events: await restoredStore.readEvents(sessionId),
        readPayload: (payload) => restoredStore.readPayload(sessionId, payload),
        conversationId: sessionId,
      });

      expect(projection.history).toHaveLength(2);
      expect(projection.history[0]?.id).toBe('debug-1');
      expect(projection.history[0]?.conversationTitle).toBe('Restored debug session');
      expect(projection.history[0]?.status).toBe('completed');
      expect(projection.history[0]?.wire.json).toBeUndefined();
      expect(projection.history[0]?.messages[0]?.summary).toContain('Summarize the restored session');
      expect(projection.history[0]?.responseParts).toEqual([{ kind: 'text', body: 'Restored debug response.' }]);
      expect(projection.history[1]?.source).toBe('provider_response');
      expect(projection.history[1]?.status).toBe('completed');
      expect(projection.history[1]?.responseParts).toEqual([]);
      expect(projection.history[1]?.usage).toBeNull();
      expect(projection.totals).toMatchObject({
        queries: 1,
        rounds: 1,
        input: 120,
        output: 30,
        totalTokens: 165,
        costUsd: 0.0045,
      });
    });
  });
});
