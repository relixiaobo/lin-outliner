import { describe, expect, test } from 'bun:test';
import { zstdDecompressSync } from 'node:zlib';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import { stream as streamAnthropicMessages } from '@earendil-works/pi-ai/api/anthropic-messages';
import { convertMessages as convertGoogleMessages } from '@earendil-works/pi-ai/api/google-shared';
import { streamSimple as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { decodeTurn } from '../../src/core/agent/codec';
import type { ModelProviderToolCall, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { CanonicalContextProjector } from '../../src/main/agent/context/ContextProjector';
import { portableProviderToolCallId } from '../../src/core/agent/providerToolCallIdentity';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

const SOURCE_MODEL = model('openai-responses', 'openai', 'gpt-source');
const ANTHROPIC_MODEL = model('anthropic-messages', 'anthropic', 'claude-target');
const ANTHROPIC_SOURCE_MODEL = model('anthropic-messages', 'anthropic', 'claude-source');
const OPENAI_MODEL = model('openai-responses', 'openai', 'gpt-target');
const GOOGLE_MODEL = model('google-generative-ai', 'google', 'gemini-3-flash');
const TURN_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abe';
const THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abc';
const FIRST_ITEM_ID = '018f0f24-7b2e-7a3f-8a4b-123456789ac1';
const SECOND_ITEM_ID = '018f0f24-7b2e-7a3f-8a4b-123456789ac2';

describe('provider tool-call identity projection', () => {
  test('materializes collision-safe pairs through the real Anthropic serializer', async () => {
    const turn = toolTurn([
      commandItem(FIRST_ITEM_ID, providerCall(SOURCE_MODEL, 'abc|def'), 'first'),
      commandItem(SECOND_ITEM_ID, providerCall(SOURCE_MODEL, 'abc/def'), 'second'),
    ]);
    const messages = await new CanonicalContextProjector(ANTHROPIC_MODEL, projectionResources())
      .projectTurns([turn]);
    const captured: unknown[] = [];
    const client = {
      messages: {
        create: (payload: unknown) => ({
          asResponse: async () => {
            captured.push(payload);
            return anthropicTextResponse('done', ANTHROPIC_MODEL.id);
          },
        }),
      },
    };

    await streamAnthropicMessages(ANTHROPIC_MODEL as Model<'anthropic-messages'>, {
      systemPrompt: 'Test',
      messages,
      tools: [],
    }, { client: client as never }).result();

    const payloadMessages = (captured[0] as { messages: Array<{ content: unknown }> }).messages;
    const blocks = payloadMessages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    const callIds = blocks.flatMap((block) => (
      isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : []
    ));
    const resultIds = blocks.flatMap((block) => (
      isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string'
        ? [block.tool_use_id]
        : []
    ));

    expect(callIds).toEqual([
      portableProviderToolCallId(FIRST_ITEM_ID),
      portableProviderToolCallId(SECOND_ITEM_ID),
    ]);
    expect(resultIds).toEqual(callIds);
    expect(new Set(callIds).size).toBe(2);
    expect(JSON.stringify(captured)).not.toContain('abc_def');
  });

  test('materializes portable pairs through the real OpenAI Responses serializer', async () => {
    const sourceIds = [`anthropic-${'a'.repeat(80)}`, `anthropic-${'a'.repeat(79)}b`];
    const turn = toolTurn([
      commandItem(FIRST_ITEM_ID, providerCall(ANTHROPIC_SOURCE_MODEL, sourceIds[0]!), 'first'),
      commandItem(SECOND_ITEM_ID, providerCall(ANTHROPIC_SOURCE_MODEL, sourceIds[1]!), 'second'),
    ]);
    const messages = await new CanonicalContextProjector(OPENAI_MODEL, projectionResources())
      .projectTurns([turn]);
    let requestBody = '';
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = decodeRequestBody(init?.body);
      return completedResponsesStream();
    }) as typeof globalThis.fetch;

    const response = streamOpenAIResponses(OPENAI_MODEL as Model<'openai-responses'>, {
      systemPrompt: 'Test',
      messages,
      tools: [],
    }, { apiKey: 'test-key', fetch, maxRetries: 0 });
    for await (const _event of response) { /* drain */ }

    const body = JSON.parse(requestBody) as { input: Array<Record<string, unknown>> };
    const callIds = body.input.flatMap((entry) => (
      entry.type === 'function_call' && typeof entry.call_id === 'string' ? [entry.call_id] : []
    ));
    const resultIds = body.input.flatMap((entry) => (
      entry.type === 'function_call_output' && typeof entry.call_id === 'string' ? [entry.call_id] : []
    ));
    expect(callIds).toEqual([
      portableProviderToolCallId(FIRST_ITEM_ID),
      portableProviderToolCallId(SECOND_ITEM_ID),
    ]);
    expect(resultIds).toEqual(callIds);
    expect(new Set(callIds).size).toBe(2);
    expect(JSON.stringify(body)).not.toContain(sourceIds[0]!);
    expect(JSON.stringify(body)).not.toContain(sourceIds[1]!);
  });

  test('preserves a Google tool signature after restart and removes it for another model', async () => {
    const signature = 'dGVzdC1zaWduYXR1cmU=';
    const turn = toolTurn([
      commandItem(FIRST_ITEM_ID, providerCall(GOOGLE_MODEL, 'google-call', signature), 'signed'),
    ]);
    const restarted = decodeTurn(JSON.parse(JSON.stringify(turn)));
    const sameModelMessages = await new CanonicalContextProjector(GOOGLE_MODEL, projectionResources())
      .projectTurns([restarted]);
    const googleContents = convertGoogleMessages(GOOGLE_MODEL as Model<'google-generative-ai'>, {
      systemPrompt: 'Test',
      messages: sameModelMessages,
      tools: [],
    });
    const functionCallPart = googleContents.flatMap((content) => content.parts ?? [])
      .find((part) => part.functionCall);

    expect(functionCallPart).toMatchObject({ thoughtSignature: signature });
    const crossModelMessages = await new CanonicalContextProjector(ANTHROPIC_MODEL, projectionResources())
      .projectTurns([restarted]);
    expect(JSON.stringify(crossModelMessages)).not.toContain(signature);
    expect(JSON.stringify(crossModelMessages)).toContain(portableProviderToolCallId(FIRST_ITEM_ID));
  });
});

function commandItem(
  id: string,
  source: ModelProviderToolCall,
  output: string,
): Extract<ThreadItem, { readonly type: 'commandExecution' }> {
  return {
    type: 'commandExecution',
    id,
    provenance: { originThreadId: THREAD_ID, originTurnId: TURN_ID, originItemId: id },
    command: 'pwd',
    description: null,
    cwd: '/workspace',
    processId: null,
    status: 'completed',
    commandActions: [],
    aggregatedOutput: output,
    exitCode: 0,
    durationMs: 1,
    outputRef: null,
    resourceRefs: [],
    modelCall: replayableModelCall('bash', { command: 'pwd' }, source),
  };
}

function toolTurn(items: ThreadItem[]): Turn {
  return {
    id: TURN_ID,
    items: [
      {
        type: 'userMessage',
        id: '018f0f24-7b2e-7a3f-8a4b-123456789ac0',
        provenance: {
          originThreadId: THREAD_ID,
          originTurnId: TURN_ID,
          originItemId: '018f0f24-7b2e-7a3f-8a4b-123456789ac0',
        },
        author: { kind: 'reader' },
        clientId: null,
        acceptedAt: 1,
        content: [{ type: 'text', text: 'Run tools' }],
      },
      ...items,
    ],
    itemsView: 'full',
    provenance: {
      originThreadId: THREAD_ID,
      originTurnId: TURN_ID,
      trigger: { kind: 'user' },
    },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: SOURCE_MODEL.provider,
      model: SOURCE_MODEL.id,
      reasoningEffort: 'medium',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
      diagnosticsRef: null,
    },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function providerCall(
  source: Model<Api>,
  id: string,
  thoughtSignature: string | null = null,
): ModelProviderToolCall {
  return {
    id,
    api: source.api,
    provider: source.provider,
    model: source.id,
    thoughtSignature,
  };
}

function model<TApi extends Api>(api: TApi, provider: string, id: string): Model<TApi> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl: 'https://example.test',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function projectionResources() {
  return {
    readContext: async () => null,
    readInternalText: async () => null,
    readOutput: async () => null,
    readResource: async () => null,
    resolveResourceObservationPath: async () => null,
    resolveImageArtifactPath: async () => null,
  };
}

function anthropicTextResponse(text: string, modelId: string): Response {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: modelId,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
    ['content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }],
    ['content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  const body = events.map(([event, data]) => (
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  )).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function decodeRequestBody(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(zstdDecompressSync(body)).toString('utf8');
  throw new Error(`Unexpected request body: ${Object.prototype.toString.call(body)}`);
}

function completedResponsesStream(): Response {
  return new Response([
    'data: {"type":"response.completed","response":',
    '{"id":"response-test","status":"completed","output":[],',
    '"usage":{"input_tokens":1,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
  ].join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
