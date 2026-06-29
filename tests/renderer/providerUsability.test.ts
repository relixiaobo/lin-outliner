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
});
