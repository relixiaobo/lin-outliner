import { describe, expect, test } from 'bun:test';
import { zstdDecompressSync } from 'node:zlib';
import { streamSimple as streamOpenAIResponses } from '@earendil-works/pi-ai/api/openai-responses';
import { streamSimple as streamOpenAICodexResponses } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { streamSimple as streamAzureOpenAIResponses } from '@earendil-works/pi-ai/api/azure-openai-responses';
import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import {
  applyCustomOpenAIResponsesPayloadProfile,
  customOpenAIResponsesFetchOption,
  isCustomOpenAIResponsesEndpoint,
} from '../../src/main/openAIResponsesCompat';

describe('OpenAI Responses compatibility profile', () => {
  const customResponsesModel = {
    api: 'openai-responses' as const,
    baseUrl: 'https://proxy.example.com/v1',
  };

  test('moves leading system/developer input into top-level instructions', () => {
    const payload = {
      model: 'gpt-5.5',
      input: [
        { role: 'developer', content: 'System prompt.' },
        { role: 'user', content: [{ type: 'input_text', text: 'Ping' }] },
      ],
      stream: true,
      store: false,
      tools: [{ type: 'function', name: 'probe' }],
    };

    expect(applyCustomOpenAIResponsesPayloadProfile(payload, customResponsesModel)).toEqual({
      model: 'gpt-5.5',
      instructions: 'System prompt.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Ping' }] },
      ],
      stream: true,
      store: false,
      text: { verbosity: 'low' },
      tool_choice: 'auto',
      parallel_tool_calls: true,
      tools: [{ type: 'function', name: 'probe', strict: false }],
    });
  });

  test('normalizes only missing and null function strict values across Responses APIs', () => {
    const parameters = {
      type: 'object',
      properties: { optional: { type: 'string' } },
      additionalProperties: false,
    };
    for (const api of [
      'openai-responses',
      'openai-codex-responses',
      'azure-openai-responses',
    ] as const) {
      const payload = {
        tools: [
          { type: 'function', name: 'missing', parameters },
          { type: 'function', name: 'null', parameters, strict: null },
          { type: 'function', name: 'false', parameters, strict: false },
          { type: 'function', name: 'true', parameters, strict: true },
          { type: 'web_search_preview', search_context_size: 'medium' },
          { type: 'custom', name: 'grammar', format: { type: 'grammar' } },
        ],
      };

      const result = applyCustomOpenAIResponsesPayloadProfile(payload, {
        api,
        baseUrl: api === 'openai-responses'
          ? 'https://api.openai.com/v1'
          : 'https://example.test/v1',
      });

      expect(result).toEqual({
        tools: [
          { type: 'function', name: 'missing', parameters, strict: false },
          { type: 'function', name: 'null', parameters, strict: false },
          { type: 'function', name: 'false', parameters, strict: false },
          { type: 'function', name: 'true', parameters, strict: true },
          { type: 'web_search_preview', search_context_size: 'medium' },
          { type: 'custom', name: 'grammar', format: { type: 'grammar' } },
        ],
      });
      const tools = (result as { tools: Array<Record<string, unknown>> }).tools;
      expect(tools[0]?.parameters).toBe(parameters);
      expect(tools[1]?.parameters).toBe(parameters);
    }
  });

  test('rejects an ambiguous function strict value before transport', () => {
    expect(() => applyCustomOpenAIResponsesPayloadProfile({
      tools: [{ type: 'function', name: 'broken', strict: 'false' }],
    }, {
      api: 'openai-codex-responses',
      baseUrl: 'https://example.test/v1',
    })).toThrow('Responses function tool "broken" has a non-boolean strict value.');
  });

  test('does not apply the function strict invariant outside Responses APIs', () => {
    const payload = {
      tools: [{ type: 'function', name: 'completion-tool' }],
    };

    expect(applyCustomOpenAIResponsesPayloadProfile(payload, {
      api: 'openai-completions',
      baseUrl: 'https://api.openai.com/v1',
    })).toBeUndefined();
    expect(payload.tools[0]).not.toHaveProperty('strict');
  });

  test('writes an explicit false into real pi-ai Responses POST bodies without rewriting schemas', async () => {
    const parameters = {
      type: 'object',
      properties: { optional: { type: 'string' } },
      additionalProperties: false,
    };
    const context: Context = {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Ping', timestamp: 1 }],
      tools: [{ name: 'probe', description: 'Probe', parameters: parameters as never }],
    };
    const codexToken = `e30.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' },
    })).toString('base64url')}.signature`;
    const cases: Array<{
      label: string;
      model: Model<Api>;
      stream: typeof streamOpenAIResponses;
      apiKey: string;
      options?: SimpleStreamOptions;
    }> = [
      {
        label: 'official OpenAI',
        model: responsesModel('openai-responses', 'openai', 'https://api.openai.com/v1'),
        stream: streamOpenAIResponses as typeof streamOpenAIResponses,
        apiKey: 'test-key',
      },
      {
        label: 'custom relay',
        model: responsesModel('openai-responses', 'relay', 'https://relay.example.test/v1'),
        stream: streamOpenAIResponses as typeof streamOpenAIResponses,
        apiKey: 'test-key',
      },
      {
        label: 'Codex',
        model: {
          ...responsesModel(
            'openai-codex-responses',
            'openai-codex',
            'https://chatgpt.com/backend-api/codex',
          ),
          compat: undefined,
        },
        stream: streamOpenAICodexResponses as unknown as typeof streamOpenAIResponses,
        apiKey: codexToken,
        options: { transport: 'sse' },
      },
      {
        label: 'Azure',
        model: responsesModel(
          'azure-openai-responses',
          'azure-openai-responses',
          'https://resource.openai.azure.com/openai/v1',
        ),
        stream: streamAzureOpenAIResponses as unknown as typeof streamOpenAIResponses,
        apiKey: 'test-key',
      },
    ];

    for (const entry of cases) {
      let requestBody = '';
      const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = decodeRequestBody(init?.body);
        return completedResponsesStream();
      }) as typeof globalThis.fetch;
      const stream = entry.stream(entry.model as never, context, {
        ...entry.options,
        apiKey: entry.apiKey,
        fetch,
        maxRetries: 0,
        onPayload: (payload, model) => applyCustomOpenAIResponsesPayloadProfile(payload, model),
      });
      for await (const _event of stream) { /* drain */ }

      const body = JSON.parse(requestBody) as { tools: Array<Record<string, unknown>> };
      expect(body.tools, entry.label).toEqual([{
        type: 'function',
        name: 'probe',
        description: 'Probe',
        parameters,
        strict: false,
      }]);
    }
  });

  test('preserves official OpenAI payloads', () => {
    const payload = {
      input: [{ role: 'developer', content: 'System prompt.' }],
      stream: true,
    };

    expect(applyCustomOpenAIResponsesPayloadProfile(payload, {
      api: 'openai-responses' as const,
      baseUrl: 'https://api.openai.com/v1',
    })).toBeUndefined();
  });

  test('sends the upstream model id for CC Switch source-scoped model aliases', () => {
    const payload = {
      model: 'cc-switch%3Acodex%3Aprovider-openai::gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Ping' }] }],
      stream: true,
    };

    expect(applyCustomOpenAIResponsesPayloadProfile(payload, {
      api: 'openai-responses' as const,
      baseUrl: 'https://registry.example.com/v1',
      id: 'cc-switch%3Acodex%3Aprovider-openai::gpt-5.5',
    })).toEqual({
      model: 'gpt-5.5',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Ping' }] }],
      stream: true,
      text: { verbosity: 'low' },
    });
  });

  test('decodes CC Switch model aliases for non-Responses OpenAI-compatible payloads', () => {
    const payload = {
      model: 'cc-switch%3Acodex%3Aprovider-openai::gpt-5.5',
      messages: [{ role: 'user', content: 'Ping' }],
      stream: true,
    };

    expect(applyCustomOpenAIResponsesPayloadProfile(payload, {
      api: 'openai-completions' as const,
      baseUrl: 'https://registry.example.com/v1',
      id: 'cc-switch%3Acodex%3Aprovider-openai::gpt-5.5',
    })).toEqual({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'Ping' }],
      stream: true,
    });
  });

  test('identifies only non-official OpenAI Responses endpoints', () => {
    expect(isCustomOpenAIResponsesEndpoint(customResponsesModel)).toBe(true);
    expect(isCustomOpenAIResponsesEndpoint({
      api: 'openai-responses' as const,
      baseUrl: 'https://api.openai.com/v1',
    })).toBe(false);
    expect(isCustomOpenAIResponsesEndpoint({
      api: 'openai-completions' as const,
      baseUrl: 'https://proxy.example.com/v1',
    })).toBe(false);
  });

  test('installs the resilient fetch only for custom Responses endpoints', () => {
    const fetch = (async () => new Response()) as typeof globalThis.fetch;
    let creations = 0;
    const createFetch = () => {
      creations += 1;
      return fetch;
    };

    expect(customOpenAIResponsesFetchOption(customResponsesModel, createFetch)).toEqual({ fetch });
    expect(customOpenAIResponsesFetchOption({
      api: 'openai-responses' as const,
      baseUrl: 'https://api.openai.com/v1',
    }, createFetch)).not.toHaveProperty('fetch');
    expect(customOpenAIResponsesFetchOption({
      api: 'openai-completions' as const,
      baseUrl: 'https://proxy.example.com/v1',
    }, createFetch)).not.toHaveProperty('fetch');
    expect(customOpenAIResponsesFetchOption({
      api: 'azure-openai-responses' as const,
      baseUrl: 'https://example.openai.azure.com/openai',
    }, createFetch)).not.toHaveProperty('fetch');
    expect(creations).toBe(1);
  });

});

function responsesModel(api: Api, provider: string, baseUrl: string): Model<Api> {
  return {
    id: 'responses-test',
    name: 'Responses Test',
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: { supportsStrictMode: false },
  };
}

function decodeRequestBody(body: BodyInit | null | undefined): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) {
    return Buffer.from(zstdDecompressSync(body)).toString('utf8');
  }
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
