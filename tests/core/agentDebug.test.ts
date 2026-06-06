import { describe, expect, test } from 'bun:test';
import { createAgentDebugPayloadEnvelope, createAgentDebugSnapshot } from '../../src/main/agentDebug';
import type { AgentPayloadRef } from '../../src/core/agentEventLog';

const payloadRef: AgentPayloadRef = {
  kind: 'payload_ref',
  id: 'debug-payload-1',
  storage: 'file',
  mimeType: 'application/json',
  byteLength: 128,
  sha256: 'debug-sha',
  role: 'debug',
  summary: 'Provider payload round 1',
};

const model = {
  id: 'gpt-test',
  name: 'GPT Test',
  api: 'openai-completions',
  provider: 'openai',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
} as const;

describe('agent debug payloads', () => {
  test('keeps raw provider JSON behind a payload ref in debug snapshots', () => {
    const payload = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'Summarize current outline.' }],
      apiKey: 'secret-value',
    };
    const envelope = createAgentDebugPayloadEnvelope(payload);
    const snapshot = createAgentDebugSnapshot({
      payload,
      wirePayload: envelope,
      wirePayloadRef: payloadRef,
      model,
      queryIndex: 1,
      conversationId: 'session-1',
      conversationTitle: 'conversation',
      source: 'provider_payload',
      turnIndex: 1,
    });

    expect(snapshot.wire.json).toBeUndefined();
    expect(snapshot.wire.payloadRef).toEqual(payloadRef);
    expect(snapshot.wire.bytes).toBe(envelope.bytes);
    expect(snapshot.wire.hash).toBe(envelope.hash);
    expect(envelope.json).toContain('[redacted]');
    expect(snapshot.messages[0]?.summary).toContain('Summarize current outline.');
  });

  test('keeps fallback runtime snapshots self-contained', () => {
    const snapshot = createAgentDebugSnapshot({
      payload: { messages: [{ role: 'user', content: 'Hello' }] },
      model,
      queryIndex: 0,
      conversationId: 'session-1',
      conversationTitle: 'conversation',
      source: 'runtime_state',
      turnIndex: 0,
    });

    expect(snapshot.wire.json).toContain('Hello');
    expect(snapshot.wire.payloadRef).toBeUndefined();
  });

  test('can recreate event-derived snapshots with stable identity and capture time', () => {
    const snapshot = createAgentDebugSnapshot({
      id: 'debug-event-1',
      capturedAt: 1_800_000_000_000,
      payload: { messages: [{ role: 'user', content: 'Hello' }] },
      model,
      queryIndex: 2,
      conversationId: 'session-1',
      conversationTitle: 'conversation',
      source: 'provider_payload',
      status: 'completed',
      turnIndex: 3,
    });

    expect(snapshot.id).toBe('debug-event-1');
    expect(snapshot.capturedAt).toBe(1_800_000_000_000);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.queryIndex).toBe(2);
    expect(snapshot.turnIndex).toBe(3);
  });
});
