import { describe, expect, test } from 'bun:test';
import type { AgentProviderOption, AgentProviderSettingsView } from '../../src/core/types';
import { buildProviderChoices } from '../../src/renderer/ui/agent/settingsProviderModel';

function settings(enabled = true): AgentProviderSettingsView {
  return {
    providers: [{
      providerId: 'radius',
      enabled,
      hasApiKey: true,
      auth: { authKind: 'oauth', credentialed: true, hasStoredKey: true },
    }],
    availableProviders: [],
    agent: {} as AgentProviderSettingsView['agent'],
    imageGeneration: {},
  };
}

function dynamicCatalog(): AgentProviderOption {
  return {
    providerId: 'radius',
    authKind: 'oauth',
    hasEnvApiKey: false,
    envKeyNames: [],
    modelsRefreshable: true,
    capabilities: [],
    models: [],
  };
}

describe('provider settings model', () => {
  test('shows refresh for an enabled dynamic provider without inventing an empty capability row', () => {
    const catalog = dynamicCatalog();
    const choices = buildProviderChoices(settings(), '', new Map([[catalog.providerId, catalog]]));
    expect(choices[0]).toMatchObject({ providerId: 'radius', canRefreshModels: true });
  });

  test('hides refresh while the dynamic provider is disabled', () => {
    const catalog = dynamicCatalog();
    const choices = buildProviderChoices(settings(false), '', new Map([[catalog.providerId, catalog]]));
    expect(choices[0]).toMatchObject({ providerId: 'radius', canRefreshModels: false });
  });
});
