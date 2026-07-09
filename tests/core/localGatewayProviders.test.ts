import { describe, expect, test } from 'bun:test';
import {
  CC_SWITCH_LOCAL_BASE_URL,
  CC_SWITCH_LOCAL_PROVIDER_ID,
  LOCAL_GATEWAY_PROVIDER_REGISTRY,
  isExternalSecretProviderId,
  isLocalGatewayProviderId,
  isQuickEnableProviderId,
  isRefreshableLocalGatewayProviderId,
  localGatewayProviderDefinition,
} from '../../src/core/localGatewayProviders';

describe('local gateway provider registry', () => {
  test('describes the CC Switch gateway through one registry entry', () => {
    const provider = localGatewayProviderDefinition(CC_SWITCH_LOCAL_PROVIDER_ID);

    expect(LOCAL_GATEWAY_PROVIDER_REGISTRY.map((entry) => entry.providerId)).toEqual([CC_SWITCH_LOCAL_PROVIDER_ID]);
    expect(provider).toMatchObject({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      adapter: 'cc-switch-codex',
      name: 'CC Switch',
      defaultBaseUrl: CC_SWITCH_LOCAL_BASE_URL,
      defaultApi: 'openai-responses',
      externalSecret: true,
      quickEnableWhenDetected: true,
      refreshableModels: true,
    });
    expect(provider?.preferredCatalogProviders).toContain('openai-codex');
  });

  test('answers provider behavior predicates from the registry', () => {
    expect(isLocalGatewayProviderId(CC_SWITCH_LOCAL_PROVIDER_ID)).toBe(true);
    expect(isExternalSecretProviderId(CC_SWITCH_LOCAL_PROVIDER_ID)).toBe(true);
    expect(isQuickEnableProviderId(CC_SWITCH_LOCAL_PROVIDER_ID)).toBe(true);
    expect(isRefreshableLocalGatewayProviderId(CC_SWITCH_LOCAL_PROVIDER_ID)).toBe(true);

    expect(isLocalGatewayProviderId('openai')).toBe(false);
    expect(isExternalSecretProviderId('openai')).toBe(false);
    expect(isQuickEnableProviderId('openai')).toBe(false);
    expect(isRefreshableLocalGatewayProviderId('openai')).toBe(false);
  });
});
