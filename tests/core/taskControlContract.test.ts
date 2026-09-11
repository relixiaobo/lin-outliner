import { expect, test } from 'bun:test';
import { TASK_CONTROL_INPUT_SCHEMA, decodeTaskControlInput, decodeTaskControlToolInput } from '../../src/core/agent/taskContinuation';
import { providerToolSchemaFailure } from '../../src/core/agent/tools';
import { compileToolParameters } from '../../src/main/agent/runtime/kernel/exactToolArguments';
import { convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
import { convertTools } from '@earendil-works/pi-ai/api/google-shared';
import { stream as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { agentProviderPayload } from '../../src/main/agent/runtime/agentProviderPayload';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';
import type { Model } from '@earendil-works/pi-ai';

const reference = { turnId: 'turn', itemId: 'item' };
const requests = [
  { action: 'handoff', expected_revision: 0, readiness: [reference] },
  { action: 'acknowledge', event_id: 'event' },
  { action: 'start_watch', expected_revision: 0, request: reference },
  { action: 'revoke_watch', expected_revision: 0, watch_id: 'watch' },
].map((fields) => ({ task_id: 'task', operation_id: 'operation', ...fields }));
const corpus: unknown[] = [null, {}, { request: {} }];
for (const request of requests) {
  corpus.push({ request });
  for (const field of Object.keys(request)) {
    const missing = { ...request } as Record<string, unknown>;
    delete missing[field]; corpus.push({ request: missing });
  }
  for (const field of ['expected_revision', 'readiness', 'request', 'event_id', 'watch_id']) {
    if (!(field in request)) corpus.push({ request: { ...request, [field]: 'unexpected' } });
  }
  corpus.push({ request: { ...request, task_id: ' ' } }, { request: { ...request, operation_id: 'x'.repeat(257) } },
    { request, secret: 'must not be accepted' });
}
corpus.push({ request: { ...requests[0], readiness: [] } },
  { request: { ...requests[0], readiness: [{ ...reference, itemId: null }] } },
  { request: { ...requests[0], expected_revision: Number.MAX_SAFE_INTEGER + 1 } },
  { request: { ...requests[0], action: 'toString' } });
const accepts = (value: unknown) => { try { decodeTaskControlToolInput(value); return true; } catch { return false; } };
function assertParity(schema: unknown) {
  const validator = compileToolParameters(schema as never);
  for (const value of corpus) expect(validator.Check(value)).toBe(accepts(value));
  for (const request of requests) expect(validator.Check({ request })).toBe(true);
}
const tool = { name: 'task_control', description: 'Control an owned Task', parameters: TASK_CONTROL_INPUT_SCHEMA } as unknown as AgentTool;

test('Task action schema and exact decoder accept the same field language', () => {
  expect(providerToolSchemaFailure(TASK_CONTROL_INPUT_SCHEMA)).toBeNull();
  assertParity(TASK_CONTROL_INPUT_SCHEMA);
  expect(() => decodeTaskControlToolInput({ request: { ...requests[1], expected_revision: 0 } }))
    .toThrow('request/expected_revision: field is not allowed');
  try { decodeTaskControlToolInput({ request: { ...requests[1], 'private-secret': 'private-value' } }); }
  catch (error) {
    expect(String(error)).not.toContain('private-secret');
    expect(String(error)).not.toContain('private-value');
    expect(String(error)).toContain('Required and allowed fields: task_id, operation_id, action, event_id');
  }
});

test('every Task action preserves its stored digest representation regardless of input key order', () => {
  function reverseKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse()
      .map(([key, child]) => [key, reverseKeys(child)]));
    return value;
  }
  for (const request of requests) {
    // Fixtures retain the original decoder's field order, including references.
    const expected = JSON.stringify(request);
    expect(JSON.stringify(decodeTaskControlInput(reverseKeys(request)))).toBe(expected);
    expect(JSON.stringify(decodeTaskControlToolInput({ request: reverseKeys(request) }).request)).toBe(expected);
  }
});

test('actual OpenAI and Google converters preserve the action language', () => {
  for (const strict of [undefined, false]) {
    const converted = convertResponsesTools([tool], { strict })[0] as { parameters: unknown };
    assertParity(converted.parameters);
    const google = convertTools([tool], false, true)!;
    assertParity(google[0]!.functionDeclarations![0]!.parametersJsonSchema);
  }
});

test('actual Anthropic serialization and Host profile preserve the action language', async () => {
  const model: Model<'anthropic-messages'> = { id: 'claude-sonnet-test', name: 'test', provider: 'anthropic', api: 'anthropic-messages',
    baseUrl: 'https://example.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 };
  let captured: any;
  await streamAnthropic(model, { systemPrompt: 'Test', messages: [{ role: 'user', content: 'Test', timestamp: 1 }], tools: [tool] }, {
    client: { messages: { create: (payload: unknown) => ({ asResponse: async () => {
      captured = payload;
      return new Response('event: message_start\ndata: {"type":"message_start","message":{"id":"msg","type":"message","role":"assistant","content":[],"model":"claude-sonnet-test","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } }) } } as never,
    onPayload: (payload, target) => agentProviderPayload(payload, target, null, [tool]),
  }).result();
  assertParity(captured.tools[0].input_schema);
});


test('actual OpenAI Completions serialization preserves the action language', async () => {
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', provider: 'openai', api: 'openai-completions',
    baseUrl: 'https://example.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 };
  let captured: any;
  await streamCompletions(model, { messages: [{ role: 'user', content: 'Test', timestamp: 1 }], tools: [tool] }, {
    apiKey: 'fixture-key',
    onPayload: (payload) => { captured = payload; },
    fetch: async () => new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  }).result();
  assertParity(captured.tools[0].function.parameters);
});
