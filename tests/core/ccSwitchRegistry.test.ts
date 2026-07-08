import { describe, expect, test } from 'bun:test';
import {
  buildCcSwitchRegistryFromRows,
  ccSwitchModelOptionId,
  ccSwitchRunnableSources,
  ccSwitchSourceApiKey,
  ccSwitchSourceRuntimeProviderId,
  parseCcSwitchModelOptionId,
  parseCcSwitchRuntimeProviderId,
} from '../../src/main/ccSwitchRegistry';

function registryRows(options: {
  apiFormat?: string;
  apiKey?: string;
  endpoint?: string | null;
  model?: string;
}) {
  return {
    providers: [{
      id: 'provider-1',
      app_type: 'codex',
      name: 'OpenAI',
      settings_config: JSON.stringify({
        auth: options.apiKey === undefined ? {} : { OPENAI_API_KEY: options.apiKey },
        model: options.model ?? 'gpt-5.5',
      }),
      meta: JSON.stringify({ apiFormat: options.apiFormat ?? 'openai_responses' }),
      is_current: 1,
      sort_index: 0,
    }],
    endpoints: options.endpoint === null ? [] : [{
      provider_id: 'provider-1',
      app_type: 'codex',
      url: options.endpoint ?? 'https://registry.example.com/v1',
      added_at: '2026-07-08T00:00:00.000Z',
    }],
    proxyConfigs: [{
      app_type: 'codex',
      listen_address: '127.0.0.1',
      listen_port: 15721,
      enabled: 1,
      proxy_enabled: 1,
    }],
  };
}

describe('CC Switch registry normalization', () => {
  test('classifies native Codex Responses rows as direct runnable sources', () => {
    const snapshot = buildCcSwitchRegistryFromRows(registryRows({ apiKey: 'registry-key' }));
    expect(snapshot.status).toBe('ready');
    const source = ccSwitchRunnableSources(snapshot)[0]!;
    expect(source).toMatchObject({
      appType: 'codex',
      providerId: 'provider-1',
      routeKind: 'direct',
      apiFormat: 'openai_responses',
      modelId: 'gpt-5.5',
    });
    expect(ccSwitchSourceApiKey(source)).toBe('registry-key');
  });

  test('extracts the selected model from CC Switch Codex TOML config rows', () => {
    const snapshot = buildCcSwitchRegistryFromRows({
      providers: [
        {
          id: 'default',
          app_type: 'codex',
          name: 'default',
          settings_config: JSON.stringify({
            auth: {
              OPENAI_API_KEY: {},
              auth_mode: 'chatgpt',
              tokens: { access_token: 'oauth-access-token', refresh_token: 'oauth-refresh-token' },
            },
            config: 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n',
          }),
          meta: JSON.stringify({}),
          is_current: 0,
          sort_index: 0,
        },
        {
          id: 'provider-openai',
          app_type: 'codex',
          name: 'OpenAI',
          settings_config: JSON.stringify({
            auth: { OPENAI_API_KEY: 'registry-key' },
            config: [
              'model_provider = "custom"',
              'model = "gpt-5.5"',
              'disable_response_storage = true',
              '',
              '[model_providers.custom]',
              'base_url = "https://registry.example.com/v1"',
            ].join('\n'),
          }),
          meta: JSON.stringify({ apiFormat: 'openai_responses' }),
          is_current: 1,
          sort_index: 1,
        },
      ],
      endpoints: [{
        provider_id: 'provider-openai',
        app_type: 'codex',
        url: 'https://registry.example.com/v1',
        added_at: '2026-07-08T00:00:00.000Z',
      }],
      proxyConfigs: [{
        app_type: 'codex',
        listen_address: '127.0.0.1',
        listen_port: 15721,
        enabled: 1,
        proxy_enabled: 1,
      }],
    });

    expect(snapshot.status).toBe('ready');
    expect(snapshot.statusMessage).toBeUndefined();
    expect(snapshot.sources.find((source) => source.providerId === 'default')).toMatchObject({
      routeKind: 'proxy-required',
      authKind: 'oauth',
    });
    const source = ccSwitchRunnableSources(snapshot)[0]!;
    expect(source).toMatchObject({
      providerId: 'provider-openai',
      routeKind: 'direct',
      modelId: 'gpt-5.5',
    });
    expect(ccSwitchSourceApiKey(source)).toBe('registry-key');
  });

  test('marks Codex Chat Completions rows as proxy-required', () => {
    const snapshot = buildCcSwitchRegistryFromRows(registryRows({
      apiFormat: 'openai_chat',
      apiKey: 'registry-key',
    }));
    expect(snapshot.status).toBe('proxy-required');
    expect(snapshot.sources[0]).toMatchObject({
      routeKind: 'proxy-required',
      disabledReason: expect.stringContaining('Chat Completions'),
    });
    expect(ccSwitchRunnableSources(snapshot)).toEqual([]);
  });

  test('marks rows without direct endpoints as proxy-required when proxy config exists', () => {
    const snapshot = buildCcSwitchRegistryFromRows(registryRows({
      apiKey: 'registry-key',
      endpoint: null,
    }));
    expect(snapshot.status).toBe('proxy-required');
    expect(snapshot.sources[0]?.routeKind).toBe('proxy-required');
  });

  test('round-trips runtime provider and model ids without secret material', () => {
    const snapshot = buildCcSwitchRegistryFromRows(registryRows({ apiKey: 'registry-key' }));
    const source = ccSwitchRunnableSources(snapshot)[0]!;
    const runtimeProviderId = ccSwitchSourceRuntimeProviderId(source);
    const modelId = ccSwitchModelOptionId(runtimeProviderId, 'gpt-5.5');
    expect(runtimeProviderId).toBe('cc-switch:codex:provider-1');
    expect(modelId).not.toContain('registry-key');
    expect(parseCcSwitchRuntimeProviderId(runtimeProviderId)).toEqual({
      appType: 'codex',
      providerId: 'provider-1',
    });
    expect(parseCcSwitchModelOptionId(modelId)).toEqual({
      sourceRuntimeProviderId: runtimeProviderId,
      modelId: 'gpt-5.5',
    });
  });
});
