import { describe, expect, test } from 'bun:test';
import {
  resolveAgentModelOverride,
  validateAgentModelSelection,
} from '../../src/main/agent/capabilities/agentModelResolution';

const customOpenAiProvider = {
  providerId: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  enabled: true,
};

describe('Agent model selection ownership', () => {
  test('rejects a known provider qualifier that escapes the selected provider', () => {
    expect(() => validateAgentModelSelection(
      'anthropic:claude-sonnet-4',
      'off',
      customOpenAiProvider,
    )).toThrow('does not match the selected provider openai');
    expect(() => resolveAgentModelOverride(
      'anthropic:claude-sonnet-4',
      customOpenAiProvider,
    )).toThrow('does not match the selected provider openai');
  });

  test('accepts matching qualifiers and bare colon-bearing model ids', () => {
    expect(() => validateAgentModelSelection(
      'openai:local-model',
      'off',
      customOpenAiProvider,
    )).not.toThrow();
    expect(() => validateAgentModelSelection(
      'qwen2:7b',
      'off',
      customOpenAiProvider,
    )).not.toThrow();
  });
});
