import { describe, expect, test } from 'bun:test';
import type { ThreadConfigurationSummary } from '../../src/core/agent/protocol';
import type { AgentProviderRuntimeConfig } from '../../src/main/agent/capabilities/agentSettings';
import { resolveAgentExecutionSelection } from '../../src/main/agent/agentExecutionSelection';

const parent: ThreadConfigurationSummary = Object.freeze({
  modelProvider: 'openai',
  model: 'openai/gpt-parent',
  reasoningEffort: 'medium',
});

const providers: Record<string, AgentProviderRuntimeConfig> = {
  openai: { providerId: 'openai', enabled: true },
  anthropic: { providerId: 'anthropic', enabled: true },
};

describe('fresh Agent execution selection', () => {
  test('validates the inherited parent selection when no row is configured', async () => {
    const reads: Array<readonly [string, string | undefined]> = [];
    const validated: ThreadConfigurationSummary[] = [];
    await expect(resolveAgentExecutionSelection({
      selection: null,
      parent,
      getProviderRuntimeConfig: async (providerId, modelId) => {
        reads.push([providerId, modelId]);
        return providers.openai!;
      },
      validateSelection: (selection) => { validated.push(selection); },
    })).resolves.toEqual({ ...parent, fallback: null });
    expect(reads).toEqual([['openai', 'gpt-parent']]);
    expect(validated).toEqual([parent]);
  });

  test('rejects an unavailable inherited parent before admission', async () => {
    await expect(resolveAgentExecutionSelection({
      selection: null,
      parent,
      getProviderRuntimeConfig: async () => null,
      validateSelection: () => undefined,
    })).rejects.toThrow('Parent provider or model is unavailable: openai');
  });

  test('validates an explicit cross-provider model by its current catalog identity', async () => {
    const reads: Array<readonly [string, string | undefined]> = [];
    const validated: ThreadConfigurationSummary[] = [];
    const result = await resolveAgentExecutionSelection({
      selection: {
        modelProvider: 'anthropic',
        model: 'anthropic/claude-sonnet',
        reasoningEffort: 'high',
      },
      parent,
      getProviderRuntimeConfig: async (providerId, modelId) => {
        reads.push([providerId, modelId]);
        return providers[providerId] ?? null;
      },
      validateSelection: (selection) => { validated.push(selection); },
    });

    expect(result).toEqual({
      modelProvider: 'anthropic',
      model: 'anthropic/claude-sonnet',
      reasoningEffort: 'high',
      fallback: null,
    });
    expect(reads).toEqual([['anthropic', 'claude-sonnet']]);
    expect(validated).toEqual([{
      modelProvider: 'anthropic',
      model: 'anthropic/claude-sonnet',
      reasoningEffort: 'high',
    }]);
  });

  test.each([
    ['disabled provider', async () => null, () => undefined],
    ['missing catalog model', async (_providerId: string, modelId?: string) => (
      modelId === undefined ? providers.openai! : null
    ), () => undefined],
    ['unsupported reasoning', async (providerId: string) => providers[providerId] ?? null, () => {
      throw new Error('unsupported reasoning');
    }],
  ] as const)('falls back to the complete parent selection for %s', async (
    _case,
    requestedProvider,
    validateRequested,
  ) => {
    let validationCalls = 0;
    const result = await resolveAgentExecutionSelection({
      selection: {
        modelProvider: 'anthropic',
        model: 'anthropic/retired-model',
        reasoningEffort: 'xhigh',
      },
      parent,
      getProviderRuntimeConfig: async (providerId, modelId) => {
        if (providerId === parent.modelProvider) return providers.openai!;
        return requestedProvider(providerId, modelId);
      },
      validateSelection: (selection) => {
        validationCalls += 1;
        if (selection.modelProvider !== parent.modelProvider) validateRequested();
      },
    });

    expect(result).toEqual({
      ...parent,
      fallback: {
        requestedModelProvider: 'anthropic',
        requestedModel: 'anthropic/retired-model',
        requestedReasoningEffort: 'xhigh',
        reason: 'unavailable',
      },
    });
    expect(validationCalls).toBeGreaterThanOrEqual(1);
  });

  test('rejects when the parent fallback is unavailable', async () => {
    await expect(resolveAgentExecutionSelection({
      selection: { reasoningEffort: 'xhigh' },
      parent,
      getProviderRuntimeConfig: async () => null,
      validateSelection: () => undefined,
    })).rejects.toThrow('Parent provider or model is unavailable: openai');
  });
});
