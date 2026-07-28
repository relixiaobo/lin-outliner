import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Message, Model, Tool, UserMessage } from '@earendil-works/pi-ai';
import {
  decodeTurnDiagnosticsPayloadJson,
  encodeTurnDiagnosticsPayload,
} from '../../src/core/agent/codec';
import { TurnDiagnosticsCollector } from '../../src/main/agent/context/TurnDiagnostics';

const model = {
  id: 'test-model',
  name: 'Test Model',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://user:secret@example.test/v1?api_key=secret#fragment',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model<Api>;

describe('Turn diagnostics', () => {
  test('records stable construction, pooled message windows, provider parameters, and responses', () => {
    const imageBytes = Buffer.from('diagnostic image');
    const firstMessage: UserMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this image.' },
        { type: 'image', data: imageBytes.toString('base64'), mimeType: 'image/png' },
      ],
      timestamp: 10,
    };
    const secondMessage: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Continue.' }],
      timestamp: 20,
    };
    const collector = new TurnDiagnosticsCollector({
      contextEpochId: 'initial',
      cacheAffinity: 'a'.repeat(64),
      configuration: {
        profileName: 'default',
        developerInstructions: ['Keep terminology exact.'],
        model: model.id,
        reasoningEffort: 'medium',
        tools: ['alpha', 'zeta'],
        skills: ['review'],
        plugins: ['workspace'],
        mcpServers: ['docs'],
      },
      stablePrompt: {
        text: 'Base\n\nCapabilities\n\nIdentity',
        blocks: [
          { id: 'base', layer: 'L0', text: 'Base', fingerprint: digest('Base') },
          { id: 'tools', layer: 'L1', text: 'Capabilities', fingerprint: digest('Capabilities') },
          { id: 'identity', layer: 'L2', text: 'Identity', fingerprint: digest('Identity') },
        ],
        fingerprints: {
          l0: digest('Base'),
          l1: digest('Capabilities'),
          l2: digest('Identity'),
          complete: digest('Base\n\nCapabilities\n\nIdentity'),
        },
      },
      tools: [tool('alpha'), tool('zeta')],
      model,
      thinkingLevel: 'medium',
      providerOptions: {
        timeoutMs: 30_000,
        maxRetries: 2,
        maxRetryDelayMs: 10_000,
        cacheRetention: 'short',
      },
    });

    prepare(collector, [firstMessage], 0, 120);
    collector.captureProviderRequest({
      model: model.id,
      input: [firstMessage],
      temperature: 0.2,
      image_url: `data:image/png;base64,${imageBytes.toString('base64')}`,
      system: [{ text: 'Base', cache_control: { type: 'ephemeral' } }],
    });
    collector.captureTransportResponse({
      status: 202,
      headers: {
        'X-Request-ID': 'request-1',
        'set-cookie': 'private-cookie',
      },
    });
    collector.captureEvent({
      type: 'message_end',
      message: assistantMessage('First response'),
    } as AgentEvent);

    prepare(collector, [firstMessage, secondMessage], 1, 160);
    collector.captureProviderRequest({
      model: model.id,
      input: [firstMessage, secondMessage],
      temperature: 0.2,
    });

    const payload = collector.payload();
    expect(payload.stablePrompt?.blocks.map((block) => block.layer)).toEqual(['L0', 'L1', 'L2']);
    expect(payload.toolSchemas.map((entry) => entry.name)).toEqual(['alpha', 'zeta']);
    expect(payload.runtime).toMatchObject({
      provider: 'openai',
      model: 'test-model',
      endpoint: 'https://example.test/v1',
      transport: 'auto',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      cacheRetention: 'short',
    });
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[0]?.value).toMatchObject({
      content: [
        { type: 'text', text: 'Inspect this image.' },
        {
          type: 'image',
          data: {
            omitted: true,
            encoding: 'base64',
            byteLength: imageBytes.byteLength,
            sha256: digest(imageBytes),
          },
        },
      ],
    });
    expect(payload.providerCalls).toHaveLength(2);
    expect(payload.providerCalls[0]).toMatchObject({
      protectedFromMessageIndex: 0,
      estimatedInputTokens: 120,
      inputTokenLimit: 100_000,
      reservedOutputTokens: 8_192,
      commonPrefixMessageCount: 0,
      requestParameters: {
        model: 'test-model',
        input: { omitted: true, source: 'messageWindow', field: 'input' },
        temperature: 0.2,
        image_url: {
          omitted: true,
          encoding: 'data-url',
          mimeType: 'image/png',
          byteLength: imageBytes.byteLength,
          sha256: digest(imageBytes),
        },
      },
      cacheBreakpoints: ['$.system[0].cache_control'],
      transportResponse: {
        httpStatus: 202,
        requestId: 'request-1',
      },
      response: {
        stopReason: 'stop',
        errorMessage: null,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        value: { role: 'assistant', content: [{ type: 'text', text: 'First response' }] },
      },
    });
    expect(payload.providerCalls[0]?.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.providerCalls[1]).toMatchObject({
      protectedFromMessageIndex: 1,
      estimatedInputTokens: 160,
      commonPrefixMessageCount: 1,
      transportResponse: null,
      response: null,
    });
    expect(decodeTurnDiagnosticsPayloadJson(encodeTurnDiagnosticsPayload(payload))).toEqual(payload);
  });
});

function prepare(
  collector: TurnDiagnosticsCollector,
  messages: readonly Message[],
  protectedFromMessageIndex: number,
  estimatedInputTokens: number,
): void {
  collector.prepareProviderContext({
    messages,
    protectedFromMessageIndex,
    budget: {
      messages,
      estimatedInputTokens,
      inputTokenLimit: 100_000,
      reservedOutputTokens: 8_192,
    },
  });
}

function tool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  } as Tool;
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'openai',
    model: model.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 30,
  };
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
