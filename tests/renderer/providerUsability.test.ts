import { describe, expect, test } from 'bun:test';
import type { AgentProviderSettingsView } from '../../src/renderer/api/types';
import { isProviderUsable, providerHasCredential, resolveUsableActiveProvider } from '../../src/renderer/ui/agent/providerUsability';

function settings(): AgentProviderSettingsView {
  return {
    activeProviderId: 'local-llm',
    providers: [
      {
        providerId: 'local-llm',
        baseUrl: 'http://localhost:1234/v1',
        enabled: true,
        hasApiKey: false,
        auth: { authKind: 'api-key', credentialed: false, hasStoredKey: false },
      },
    ],
    availableProviders: [],
    agent: {} as AgentProviderSettingsView['agent'],
    imageGeneration: {},
  };
}

describe('provider usability', () => {
  test('treats a keyless local OpenAI-compatible endpoint as usable', () => {
    const view = settings();
    const provider = view.providers[0]!;

    expect(providerHasCredential(provider, undefined)).toBe(true);
    expect(isProviderUsable(view, provider)).toBe(true);
    expect(resolveUsableActiveProvider(view)?.providerId).toBe('local-llm');
  });

  test('does not treat a keyless remote endpoint as credentialed', () => {
    const view = settings();
    const provider = {
      ...view.providers[0]!,
      baseUrl: 'https://proxy.example.com/v1',
    };

    expect(providerHasCredential(provider, undefined)).toBe(false);
  });

  test('treats a detected keyless catalog gateway as credentialed before it is configured', () => {
    expect(providerHasCredential(undefined, {
      providerId: 'cc-switch',
      authKind: 'api-key',
      credentialed: true,
      detected: true,
      hasEnvApiKey: false,
      envKeyNames: [],
      defaultBaseUrl: 'http://127.0.0.1:15721/v1',
      models: [],
    })).toBe(true);
  });

  test('does not treat a detected but stopped catalog gateway as credentialed', () => {
    expect(providerHasCredential(undefined, {
      providerId: 'cc-switch',
      authKind: 'api-key',
      credentialed: false,
      detected: true,
      hasEnvApiKey: false,
      envKeyNames: [],
      defaultBaseUrl: 'http://127.0.0.1:15721/v1',
      models: [],
    })).toBe(false);
  });

  test('does not treat a configured but stopped CC Switch local gateway as usable', () => {
    const view = settings();
    view.activeProviderId = 'cc-switch';
    view.providers = [{
      providerId: 'cc-switch',
      baseUrl: 'http://127.0.0.1:15721/v1',
      enabled: true,
      hasApiKey: false,
      auth: { authKind: 'api-key', credentialed: false, hasStoredKey: false },
    }];
    view.availableProviders = [{
      providerId: 'cc-switch',
      authKind: 'api-key',
      credentialed: false,
      detected: true,
      hasEnvApiKey: false,
      envKeyNames: [],
      defaultBaseUrl: 'http://127.0.0.1:15721/v1',
      models: [],
    }];

    const provider = view.providers[0]!;
    expect(providerHasCredential(provider, view.availableProviders[0])).toBe(false);
    expect(isProviderUsable(view, provider)).toBe(false);
    expect(resolveUsableActiveProvider(view)).toBeUndefined();
  });
});
