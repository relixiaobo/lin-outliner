import { describe, expect, test } from 'bun:test';
import {
  applyCustomOpenAIResponsesPayloadProfile,
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
      tools: [{ type: 'function', name: 'probe' }],
    });
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

});
