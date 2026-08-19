import { describe, expect, test } from 'bun:test';
import type { ThreadConfigurationSummary } from '../../src/core/agent/protocol';
import type { AgentProviderRuntimeConfig } from '../../src/main/agent/capabilities/agentSettings';
import {
  resolveRendererThreadStartDefaults,
  type RendererThreadStartDefaultsInput,
} from '../../src/main/agent/rendererThreadStartDefaults';

const remembered: ThreadConfigurationSummary = Object.freeze({
  modelProvider: 'anthropic',
  model: 'anthropic/claude-sonnet-4',
  reasoningEffort: 'high',
});

const anthropicProvider: AgentProviderRuntimeConfig = {
  providerId: 'anthropic',
  enabled: true,
};

const activeProvider: AgentProviderRuntimeConfig = {
  providerId: 'openai',
  enabled: true,
};

function defaultsInput(
  overrides: Partial<RendererThreadStartDefaultsInput> = {},
): RendererThreadStartDefaultsInput {
  return {
    request: {},
    remembered,
    cwd: '/tmp/agent-workdir',
    getProviderRuntimeConfig: async () => anthropicProvider,
    getActiveProviderRuntimeConfig: async () => activeProvider,
    validateRememberedSelection: () => undefined,
    ...overrides,
  };
}

describe('renderer Thread start defaults', () => {
  test('returns a validated remembered execution selection without resolving active provider', async () => {
    let activeProviderCalls = 0;
    const validated: string[] = [];

    const result = await resolveRendererThreadStartDefaults(defaultsInput({
      getActiveProviderRuntimeConfig: async () => {
        activeProviderCalls += 1;
        return activeProvider;
      },
      validateRememberedSelection: (selection, provider) => {
        validated.push(`${provider.providerId}:${selection.model}:${selection.reasoningEffort}`);
      },
    }));

    expect(result).toEqual({
      cwd: '/tmp/agent-workdir',
      executionSelection: remembered,
    });
    expect(validated).toEqual(['anthropic:anthropic/claude-sonnet-4:high']);
    expect(activeProviderCalls).toBe(0);
  });

  test('falls back to active provider when the remembered provider is unavailable', async () => {
    await expect(resolveRendererThreadStartDefaults(defaultsInput({
      getProviderRuntimeConfig: async () => null,
    }))).resolves.toEqual({
      modelProvider: 'openai',
      cwd: '/tmp/agent-workdir',
    });
  });

  test('falls back to active provider when remembered provider lookup rejects', async () => {
    await expect(resolveRendererThreadStartDefaults(defaultsInput({
      getProviderRuntimeConfig: async () => {
        throw new Error('provider store unavailable');
      },
    }))).resolves.toEqual({
      modelProvider: 'openai',
      cwd: '/tmp/agent-workdir',
    });
  });

  test('falls back to active provider when the remembered model is stale', async () => {
    await expect(resolveRendererThreadStartDefaults(defaultsInput({
      validateRememberedSelection: () => {
        throw new Error('model not found');
      },
    }))).resolves.toEqual({
      modelProvider: 'openai',
      cwd: '/tmp/agent-workdir',
    });
  });

  test('preserves an explicit Configuration Profile instead of applying memory', async () => {
    let rememberedProviderCalls = 0;

    const result = await resolveRendererThreadStartDefaults(defaultsInput({
      request: { configurationProfile: 'research' },
      getProviderRuntimeConfig: async () => {
        rememberedProviderCalls += 1;
        return anthropicProvider;
      },
    }));

    expect(result).toEqual({
      modelProvider: 'openai',
      cwd: '/tmp/agent-workdir',
    });
    expect(rememberedProviderCalls).toBe(0);
  });

  test('preserves an explicit provider without reading either provider default', async () => {
    let providerReads = 0;

    const result = await resolveRendererThreadStartDefaults(defaultsInput({
      request: { modelProvider: 'custom-provider' },
      getProviderRuntimeConfig: async () => {
        providerReads += 1;
        return anthropicProvider;
      },
      getActiveProviderRuntimeConfig: async () => {
        providerReads += 1;
        return activeProvider;
      },
    }));

    expect(result).toEqual({
      modelProvider: 'custom-provider',
      cwd: '/tmp/agent-workdir',
    });
    expect(providerReads).toBe(0);
  });

  test('reports missing configuration only after remembered fallback is exhausted', async () => {
    await expect(resolveRendererThreadStartDefaults(defaultsInput({
      getProviderRuntimeConfig: async () => null,
      getActiveProviderRuntimeConfig: async () => null,
    }))).rejects.toThrow('Configure an AI provider before starting a Thread.');
  });
});
