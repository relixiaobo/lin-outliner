import { describe, expect, test } from 'bun:test';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { OAUTH_API_KEY_FALLBACK } from '../../src/renderer/ui/agent/providerOAuthCapabilities';

// Coverage guard (provider-config-cleanup Part D): the renderer presents a sign-in
// surface for every OAuth provider pi-ai ships. The settings UI keys that copy off
// these ids in `src/renderer/ui/agent/providerCatalog.tsx`:
//   - OAUTH_SIGN_IN[id]          → the sign-in hint / docs link
//   - PROVIDER_DISPLAY_NAMES[id] → the row + sheet label
// (providerCatalog.tsx pulls Vite `import.meta.glob` brand assets and so cannot be
// imported under bun; this list is mirrored here with that pointer instead.)
//
// If pi-ai adds another OAuth provider, this fails — a loud TODO to add its
// sign-in copy, rather than the new provider silently surfacing with no hint.
const PRESENTED_OAUTH_PROVIDERS = [
  'anthropic',
  'github-copilot',
  'kimi-coding',
  'openai-codex',
  'openrouter',
  'radius',
  'xai',
];

describe('oauth provider coverage', () => {
  test('every pi-ai OAuth provider is presented in the settings UI', () => {
    const actual = builtinModels().getProviders()
      .filter((provider) => provider.auth.oauth)
      .map((provider) => provider.id)
      .sort();
    expect(actual).toEqual([...PRESENTED_OAUTH_PROVIDERS].sort());
  });

  test('every OAuth provider with a pasteable key keeps the API-key fallback', () => {
    const actual = builtinModels().getProviders()
      .filter((provider) => provider.auth.oauth && provider.auth.apiKey)
      .map((provider) => provider.id)
      .filter((providerId) => providerId !== 'github-copilot')
      .sort();

    expect([...OAUTH_API_KEY_FALLBACK].sort()).toEqual(actual);
  });
});
