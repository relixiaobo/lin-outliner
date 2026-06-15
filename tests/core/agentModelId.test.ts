import { describe, expect, test } from 'bun:test';
import { composeProviderQualifiedModel, parseProviderQualifiedModel } from '../../src/core/agentModelId';

// Known providers for the `:`-qualifier disambiguation. A real Bedrock model id
// ('amazon.nova-lite-v1:0') is NOT a provider, so its bare colon must not split.
const known = (id: string) => ['openai', 'anthropic', 'amazon-bedrock', 'google-vertex'].includes(id);

describe('parseProviderQualifiedModel', () => {
  test('splits the canonical `providerId/modelId` form on the first slash', () => {
    expect(parseProviderQualifiedModel('openai/gpt-5.4', known)).toEqual({ providerId: 'openai', modelId: 'gpt-5.4' });
  });

  test('keeps later slashes in the model id (vendor/model catalog ids)', () => {
    expect(parseProviderQualifiedModel('openai/deepseek-ai/DeepSeek-V3', known)).toEqual({
      providerId: 'openai',
      modelId: 'deepseek-ai/DeepSeek-V3',
    });
  });

  test('round-trips a slash-qualified Bedrock model id whose model id contains a colon', () => {
    const composed = composeProviderQualifiedModel('amazon-bedrock', 'amazon.nova-lite-v1:0');
    expect(composed).toBe('amazon-bedrock/amazon.nova-lite-v1:0');
    expect(parseProviderQualifiedModel(composed, known)).toEqual({
      providerId: 'amazon-bedrock',
      modelId: 'amazon.nova-lite-v1:0',
    });
  });

  test('splits a `:` qualifier ONLY when the prefix is a known provider', () => {
    expect(parseProviderQualifiedModel('openai:gpt-5.4', known)).toEqual({ providerId: 'openai', modelId: 'gpt-5.4' });
  });

  test('does NOT split a bare colon-bearing model id whose prefix is not a known provider', () => {
    // Bedrock/Vertex/Ollama bare ids — the regression this guards against.
    expect(parseProviderQualifiedModel('amazon.nova-lite-v1:0', known)).toBeNull();
    expect(parseProviderQualifiedModel('qwen2:7b', known)).toBeNull();
  });

  test('returns null for a bare id with no qualifier', () => {
    expect(parseProviderQualifiedModel('gpt-5.4', known)).toBeNull();
    expect(parseProviderQualifiedModel('', known)).toBeNull();
  });
});

describe('composeProviderQualifiedModel', () => {
  test('qualifies with a slash; empty model id yields empty string; bare when no provider', () => {
    expect(composeProviderQualifiedModel('openai', 'gpt-5.4')).toBe('openai/gpt-5.4');
    expect(composeProviderQualifiedModel('openai', '  ')).toBe('');
    expect(composeProviderQualifiedModel('', 'gpt-5.4')).toBe('gpt-5.4');
  });
});
