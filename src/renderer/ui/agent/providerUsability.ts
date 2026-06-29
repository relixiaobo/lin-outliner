import type {
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
} from '../../api/types';
import { isLocalBaseUrl } from '../../../core/localEndpoint';

// Pure provider-usability predicates, kept free of any asset/icon import (no
// `import.meta.glob`) so they can be used in plain unit tests and lightweight
// components. `providerCatalog` re-exports these alongside its icon/avatar helpers.

export function providerHasCredential(
  provider: AgentProviderConfigView | undefined,
  catalog: AgentProviderOption | undefined,
): boolean {
  // `auth.credentialed` is main's authoritative signal (stored key, oauth login,
  // env key, or managed ambient). A local OpenAI-compatible endpoint can be
  // keyless. Fall back to the catalog env flag for a provider that has no view row
  // yet (not configured).
  return Boolean(provider?.auth?.credentialed)
    || isLocalBaseUrl(provider?.baseUrl)
    || Boolean(catalog?.hasEnvApiKey);
}

// The one "can this provider drive models right now?" predicate, shared by the
// chat panel (empty-state gating), the composer (send-guard), the agent profile
// model selector, and the settings views. `auth.credentialed` already generalizes
// across api-key / oauth / managed (main's authoritative signal), so there is no
// need for caller-specific copies.
export function isProviderUsable(
  settings: AgentProviderSettingsView,
  provider: AgentProviderConfigView,
): boolean {
  const catalog = settings.availableProviders.find((candidate) => candidate.providerId === provider.providerId);
  return provider.enabled && providerHasCredential(provider, catalog);
}

export function resolveUsableActiveProvider(
  settings: AgentProviderSettingsView,
): AgentProviderConfigView | undefined {
  return settings.activeProviderId
    ? settings.providers.find((provider) => provider.providerId === settings.activeProviderId && isProviderUsable(settings, provider))
      ?? settings.providers.find((provider) => isProviderUsable(settings, provider))
    : settings.providers.find((provider) => isProviderUsable(settings, provider));
}
