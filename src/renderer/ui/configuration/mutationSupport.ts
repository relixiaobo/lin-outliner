import type { AgentProviderConfigView, AgentProviderSettingsView, AgentCapabilitySettingsView } from '../../api/types';
import { serializeUnknownError } from '../../../core/errorObservability';
import { resolveUsableActiveProvider } from '../agent/providerCatalog';
import { PREFERRED_PROVIDER_ORDER } from '../agent/providerOrder';
export interface ProviderDraft { providerId: string; baseUrl: string; enabled: boolean }
export function resolveInitialProviderDraft(settings: AgentProviderSettingsView): ProviderDraft {
  const active = resolveUsableActiveProvider(settings);
  const existing = active ?? settings.providers[0];
  if (existing) return providerToDraft(existing);

  const preferredCatalog = PREFERRED_PROVIDER_ORDER
    .map((providerId) => settings.availableProviders.find((provider) => provider.providerId === providerId))
    .find(Boolean) ?? settings.availableProviders[0];
  return {
    providerId: preferredCatalog?.providerId ?? 'anthropic',
    baseUrl: '',
    enabled: true,
  };
}

export function resolveProviderDraftFor(settings: AgentProviderSettingsView, providerId: string): ProviderDraft {
  const existing = settings.providers.find((provider) => provider.providerId === providerId);
  if (existing) return providerToDraft(existing);
  return resolveInitialProviderDraft(settings);
}

export function emptyCapabilitySettings(): AgentCapabilitySettingsView {
  return { blocks: [], diagnostics: [] };
}

export function providerToDraft(provider: AgentProviderConfigView): ProviderDraft {
  return {
    providerId: provider.providerId,
    baseUrl: provider.baseUrl ?? '',
    enabled: provider.enabled,
  };
}

export function withMapValue<K, V>(current: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(current);
  next.set(key, value);
  return next;
}

export function withoutMapKey<K, V>(current: ReadonlyMap<K, V>, key: K): Map<K, V> {
  if (!current.has(key)) return current as Map<K, V>;
  const next = new Map(current);
  next.delete(key);
  return next;
}

export function removeCapabilityRule(settings: AgentCapabilitySettingsView, rule: string): AgentCapabilitySettingsView {
  return { ...settings, blocks: settings.blocks.filter((candidate) => candidate !== rule) };
}

export function restoreCapabilityRule(
  settings: AgentCapabilitySettingsView,
  originalOrder: readonly string[],
  rule: string,
): AgentCapabilitySettingsView {
  if (settings.blocks.includes(rule)) return settings;
  const blocks = [...settings.blocks];
  const originalIndex = originalOrder.indexOf(rule);
  const nextKnownRule = originalOrder
    .slice(originalIndex + 1)
    .find((candidate) => blocks.includes(candidate));
  const insertionIndex = nextKnownRule ? blocks.indexOf(nextKnownRule) : blocks.length;
  blocks.splice(insertionIndex, 0, rule);
  return { ...settings, blocks };
}

export function mergeProviderEnabledResult(
  current: AgentProviderSettingsView,
  response: AgentProviderSettingsView,
  providerId: string,
  enabled: boolean,
): AgentProviderSettingsView {
  const responseProvider = response.providers.find((provider) => provider.providerId === providerId);
  if (!responseProvider) return current;
  const index = current.providers.findIndex((provider) => provider.providerId === providerId);
  const providers = [...current.providers];
  if (index >= 0) providers[index] = responseProvider;
  else providers.push(responseProvider);
  return {
    ...current,
    providers,
    // Enabling never selects a provider. Disabling the active row does, however,
    // make main resolve a fallback, so only that targeted transition adopts the
    // response's active id instead of overwriting an unrelated concurrent choice.
    activeProviderId: !enabled && current.activeProviderId === providerId
      ? response.activeProviderId
      : current.activeProviderId,
  };
}

export function reportSettingsMutationError(code: string, key: string, error: unknown): void {
  window.lin?.reportRendererError?.({
    domain: 'persistence',
    severity: 'error',
    code,
    message: 'Failed to persist an immediate Settings mutation.',
    context: { key },
    error: serializeUnknownError(error),
  });
}

export async function reportAppliedRefreshFailure(
  onApplied: () => Promise<void>,
  code: string,
  key: string,
): Promise<void> {
  try {
    await onApplied();
  } catch (error) {
    // The write already committed. A secondary refresh failure must not roll the
    // control back and claim persistence failed.
    reportSettingsMutationError(code, key, error);
  }
}
