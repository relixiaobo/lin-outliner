export const CC_SWITCH_LOCAL_PROVIDER_ID = 'cc-switch';
export const CC_SWITCH_LOCAL_PROVIDER_NAME = 'CC Switch';
export const CC_SWITCH_LOCAL_BASE_URL = 'http://127.0.0.1:15721/v1';
export const CC_SWITCH_LOCAL_HEALTH_URL = 'http://127.0.0.1:15721/health';
export const CC_SWITCH_LOCAL_DEFAULT_MODEL_ID = 'gpt-5.4';

export type LocalGatewayOpenAICompatibleApiId = 'openai-completions' | 'openai-responses';
export type LocalGatewayProviderAdapter = 'cc-switch-codex';

export interface LocalGatewayProviderDefinition {
  providerId: string;
  adapter: LocalGatewayProviderAdapter;
  name: string;
  defaultBaseUrl: string;
  defaultHealthUrl: string;
  defaultModelId: string;
  defaultApi: LocalGatewayOpenAICompatibleApiId;
  descriptionKey?: 'ccSwitchLocalGateway';
  externalSecret: boolean;
  quickEnableWhenDetected: boolean;
  refreshableModels: boolean;
  preferredCatalogProviders: readonly string[];
}

export const LOCAL_GATEWAY_PROVIDER_REGISTRY: readonly LocalGatewayProviderDefinition[] = [{
  providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
  adapter: 'cc-switch-codex',
  name: CC_SWITCH_LOCAL_PROVIDER_NAME,
  defaultBaseUrl: CC_SWITCH_LOCAL_BASE_URL,
  defaultHealthUrl: CC_SWITCH_LOCAL_HEALTH_URL,
  defaultModelId: CC_SWITCH_LOCAL_DEFAULT_MODEL_ID,
  defaultApi: 'openai-responses',
  descriptionKey: 'ccSwitchLocalGateway',
  externalSecret: true,
  quickEnableWhenDetected: true,
  refreshableModels: true,
  preferredCatalogProviders: ['openai-codex', 'openai'],
}];

const LOCAL_GATEWAY_PROVIDER_BY_ID = new Map(
  LOCAL_GATEWAY_PROVIDER_REGISTRY.map((provider) => [provider.providerId, provider]),
);

export function localGatewayProviderDefinition(providerId: string): LocalGatewayProviderDefinition | undefined {
  return LOCAL_GATEWAY_PROVIDER_BY_ID.get(providerId);
}

export function isLocalGatewayProviderId(providerId: string): boolean {
  return LOCAL_GATEWAY_PROVIDER_BY_ID.has(providerId);
}

export function isExternalSecretProviderId(providerId: string): boolean {
  return Boolean(localGatewayProviderDefinition(providerId)?.externalSecret);
}

export function isQuickEnableProviderId(providerId: string): boolean {
  return Boolean(localGatewayProviderDefinition(providerId)?.quickEnableWhenDetected);
}

export function isRefreshableLocalGatewayProviderId(providerId: string): boolean {
  return Boolean(localGatewayProviderDefinition(providerId)?.refreshableModels);
}
