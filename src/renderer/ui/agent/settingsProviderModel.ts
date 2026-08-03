import type {
  AgentProviderCapabilityModelOption,
  AgentProviderOption,
  AgentProviderSettingsView,
} from '../../api/types';
import type { Messages } from '../../../core/i18n';
import { composeProviderQualifiedModel } from '../../../core/agentModelId';
import {
  isLocalGatewayProviderId,
  isQuickEnableProviderId,
  isRefreshableLocalGatewayProviderId,
} from '../../../core/localGatewayProviders';
import { providerHasCredential, resolveUsableActiveProvider } from './providerCatalog';
import { formatProviderName } from './providerNames';
import { preferredProviderIndex } from './providerOrder';

export interface ProviderChoice {
  providerId: string;
  configured: boolean;
  active: boolean;
  enabled: boolean;
  hasCredential: boolean;
  detected?: boolean;
  connectionStatus?: AgentProviderOption['connectionStatus'];
  connectionStatusMessage?: string;
  quickEnable?: boolean;
  defaultBaseUrl?: string;
  canRefreshModels?: boolean;
}

export interface ProviderRowHandlers {
  onConfigure: (id: string) => void;
  onActivate: (id: string) => void;
  onRefreshModels: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onMenuOpenChange: (id: string, open: boolean) => void;
}

export interface ImageModelChoice {
  value: string;
  label: string;
}

export interface ImageModelGroup {
  providerId: string;
  label: string;
  models: ImageModelChoice[];
}

export function buildProviderChoices(
  settings: AgentProviderSettingsView,
  draftProviderId: string,
  catalog: Map<string, AgentProviderOption>,
): ProviderChoice[] {
  const activeProviderId = resolveUsableActiveProvider(settings)?.providerId ?? '';
  const choices = new Map<string, ProviderChoice>();

  for (const provider of settings.providers) {
    const providerCatalog = catalog.get(provider.providerId);
    choices.set(provider.providerId, {
      providerId: provider.providerId,
      configured: true,
      active: provider.providerId === activeProviderId,
      enabled: provider.enabled,
      hasCredential: providerHasCredential(provider, providerCatalog),
      detected: providerCatalog?.detected,
      connectionStatus: providerCatalog?.connectionStatus,
      connectionStatusMessage: providerCatalog?.connectionStatusMessage,
      defaultBaseUrl: providerCatalog?.defaultBaseUrl,
      canRefreshModels: isRefreshableLocalGatewayProviderId(provider.providerId) && provider.enabled,
    });
  }

  for (const provider of settings.availableProviders) {
    if (choices.has(provider.providerId)) continue;
    const quickEnable = isQuickEnableProviderId(provider.providerId) && Boolean(provider.detected && provider.defaultBaseUrl && provider.credentialed);
    choices.set(provider.providerId, {
      providerId: provider.providerId,
      configured: false,
      active: provider.providerId === activeProviderId,
      enabled: !quickEnable,
      hasCredential: providerHasCredential(undefined, provider),
      detected: provider.detected,
      connectionStatus: provider.connectionStatus,
      connectionStatusMessage: provider.connectionStatusMessage,
      quickEnable,
      defaultBaseUrl: provider.defaultBaseUrl,
    });
  }

  if (draftProviderId && !choices.has(draftProviderId)) {
    const providerCatalog = catalog.get(draftProviderId);
    const quickEnable = isQuickEnableProviderId(draftProviderId) && Boolean(providerCatalog?.detected && providerCatalog.defaultBaseUrl && providerCatalog.credentialed);
    choices.set(draftProviderId, {
      providerId: draftProviderId,
      configured: false,
      active: draftProviderId === activeProviderId,
      enabled: !quickEnable,
      hasCredential: providerHasCredential(undefined, providerCatalog),
      detected: providerCatalog?.detected,
      connectionStatus: providerCatalog?.connectionStatus,
      connectionStatusMessage: providerCatalog?.connectionStatusMessage,
      quickEnable,
      defaultBaseUrl: providerCatalog?.defaultBaseUrl,
    });
  }

  return [...choices.values()].sort(compareProviderChoices);
}

export function buildImageModelMenu(
  settings: AgentProviderSettingsView,
  catalog: Map<string, AgentProviderOption>,
): { groups: ImageModelGroup[]; defaultUnavailable: boolean } {
  const groups: ImageModelGroup[] = [];
  const values = new Set<string>();
  for (const provider of settings.providers) {
    if (!provider.enabled) continue;
    const providerOption = catalog.get(provider.providerId);
    if (!providerHasCredential(provider, providerOption)) continue;
    const models = imageGenerationModelsForProvider(providerOption)
      .map((model) => {
        const value = composeProviderQualifiedModel(model.providerId || provider.providerId, model.id);
        values.add(value);
        return {
          value,
          label: model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id,
        };
      });
    if (models.length > 0) {
      groups.push({
        providerId: provider.providerId,
        label: formatProviderName(provider.providerId),
        models,
      });
    }
  }
  const defaultModel = settings.imageGeneration.defaultModel ?? '';
  return {
    groups,
    defaultUnavailable: Boolean(defaultModel && !values.has(defaultModel)),
  };
}

function imageGenerationModelsForProvider(provider: AgentProviderOption | undefined): AgentProviderCapabilityModelOption[] {
  return provider?.capabilities?.find((capability) => capability.kind === 'image_generation')?.models ?? [];
}

function compareProviderChoices(left: ProviderChoice, right: ProviderChoice): number {
  const leftReady = left.enabled && left.hasCredential;
  const rightReady = right.enabled && right.hasCredential;
  if (left.active !== right.active) return left.active ? -1 : 1;
  if (leftReady !== rightReady) return leftReady ? -1 : 1;
  if (left.configured !== right.configured) return left.configured ? -1 : 1;
  const leftPreferred = preferredProviderIndex(left.providerId);
  const rightPreferred = preferredProviderIndex(right.providerId);
  if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
  return formatProviderName(left.providerId).localeCompare(formatProviderName(right.providerId), undefined, {
    sensitivity: 'base',
  });
}

// Module-level helper (can't call useT) — the caller passes `t` in.
export function providerStatusLabel(provider: ProviderChoice, t: Messages): string {
  const s = t.settings.providers.status;
  if (provider.connectionStatus === 'proxy-required') return s.proxyRequired;
  if (provider.connectionStatus === 'unsupported') return s.unsupported;
  if (provider.connectionStatus === 'not-detected') return s.notDetected;
  if (!provider.configured && provider.detected) return s.detected;
  if (!provider.configured) return provider.hasCredential ? s.ready : s.addKey;
  if (!provider.enabled) return s.disabled;
  if (isLocalGatewayProviderId(provider.providerId) && !provider.hasCredential) return s.unavailable;
  if (!provider.hasCredential) return s.needsKey;
  return provider.active ? s.active : s.ready;
}

