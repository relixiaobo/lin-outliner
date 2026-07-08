import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  type Credential,
  type OAuthCredential,
} from '@earendil-works/pi-ai';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createOpenAICompatibleModel,
  ensurePiCustomProvider,
  piCustomProviderId,
  piModels,
  piProviders,
  piStreamSimple,
} from '../../src/main/piModels';
import {
  CC_SWITCH_LOCAL_PROVIDER_ID,
} from '../../src/core/localGatewayProviders';
import {
  buildCcSwitchRegistryFromRows,
  setCcSwitchRegistryReaderForTests,
} from '../../src/main/ccSwitchRegistry';

type StoredOAuth = { refresh: string; access: string; expires: number };

// ── Mutable test controls, read by the module mocks below ──
let currentUserData = '';
let oauthRefreshImpl: (credential: OAuthCredential) => Promise<OAuthCredential> = async (credential) => credential;
let oauthToApiKeyImpl: (credential: OAuthCredential) => Promise<string> = async (credential) => credential.access;

mock.module('electron', () => ({
  app: {
    getPath: () => currentUserData,
    getVersion: () => 'test',
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({
      clearStorageData: async () => undefined,
    }),
  },
  safeStorage: {
    isEncryptionAvailable: () => { throw new Error('safeStorage should not be used'); },
    encryptString: () => { throw new Error('safeStorage should not be used'); },
    decryptString: () => { throw new Error('safeStorage should not be used'); },
  },
}));

mock.module('@earendil-works/pi-ai/oauth', () => ({
  getOAuthProvider: (id: string) =>
    ['anthropic', 'github-copilot', 'openai-codex'].includes(id) ? { id, name: id } : undefined,
}));

const {
  setProviderApiKey,
  deleteProviderApiKey,
  getProviderApiKey,
  getProviderSettings,
  getProviderSecretStatus,
  getActiveProviderRuntimeConfig,
  getStoredProviderApiKey,
  providerStreamOptionsFromRuntimeSettings,
  persistOAuthCredential,
  rankedModels,
  refreshProviderModels,
  testProviderConnection,
  upsertProviderConfig,
} = await import('../../src/main/agentSettings');

const secretPath = () => path.join(currentUserData, 'agent-secrets.json');

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  currentUserData = await mkdtemp(path.join(tmpdir(), 'lin-oauth-creds-'));
  oauthRefreshImpl = async (credential) => credential;
  oauthToApiKeyImpl = async (credential) => credential.access;
  piModels().setProvider(createProvider({
    id: 'anthropic',
    name: 'Anthropic',
    auth: {
      oauth: {
        name: 'Anthropic OAuth',
        login: async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: 999 }),
        refresh: (credential) => oauthRefreshImpl(credential),
        toAuth: async (credential) => ({ apiKey: await oauthToApiKeyImpl(credential) }),
      },
    },
    models: [{
      id: 'claude-test',
      name: 'Claude Test',
      api: 'anthropic-messages',
      provider: 'anthropic',
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' },
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    }],
    api: {
      stream: () => { throw new Error('stream should not be called'); },
      streamSimple: () => { throw new Error('streamSimple should not be called'); },
    },
  }));
});

afterEach(async () => {
  setCcSwitchRegistryReaderForTests(null);
  piModels().deleteProvider(piCustomProviderId('openai'));
  piModels().deleteProvider(piCustomProviderId(CC_SWITCH_LOCAL_PROVIDER_ID));
  piModels().deleteProvider('env-api-key-test');
  await rm(currentUserData, { recursive: true, force: true });
});

function mockFetchJson(body: unknown, options: { status?: number } = {}): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function installCcSwitchRegistry(options: {
  providerId?: string;
  providerName?: string;
  apiFormat?: string;
  apiKey?: string;
  endpoint?: string | null;
  model?: string;
  modelCatalog?: unknown;
  isCurrent?: boolean;
}) {
  const providerId = options.providerId ?? 'provider-openai';
  const settingsConfig = {
    auth: options.apiKey === undefined ? {} : { OPENAI_API_KEY: options.apiKey },
    model: options.model ?? 'gpt-5.5',
    modelCatalog: options.modelCatalog,
  };
  const snapshot = buildCcSwitchRegistryFromRows({
    dbPath: path.join(currentUserData, '.cc-switch', 'cc-switch.db'),
    providers: [{
      id: providerId,
      app_type: 'codex',
      name: options.providerName ?? 'OpenAI',
      settings_config: JSON.stringify(settingsConfig),
      meta: JSON.stringify({ apiFormat: options.apiFormat ?? 'openai_responses' }),
      is_current: options.isCurrent ?? true,
      sort_index: 0,
    }],
    endpoints: options.endpoint === null ? [] : [{
      provider_id: providerId,
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
  });
  setCcSwitchRegistryReaderForTests(async () => snapshot);
  return snapshot;
}

describe('provider credential resolver', () => {
  test('provider settings preserve model-specific effort levels and display labels', async () => {
    const view = await getProviderSettings();
    const model = view.availableProviders
      .find((candidate) => candidate.providerId === 'anthropic')
      ?.models.find((candidate) => candidate.id === 'claude-test');
    expect(model?.supportedThinkingLevels).toEqual(['low', 'high']);
    expect(model?.thinkingLevelLabels).toEqual({ low: 'LOW', high: 'HIGH' });
  });

  test('discovers a direct CC Switch registry provider without exposing its key', async () => {
    installCcSwitchRegistry({ apiKey: 'registry-key' });
    const view = await getProviderSettings();
    const provider = view.availableProviders.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    expect(provider).toMatchObject({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      credentialed: true,
      detected: true,
      connectionStatus: 'ready',
      defaultBaseUrl: 'https://registry.example.com/v1',
    });
    expect(provider?.models[0]?.name).toBe('Codex / OpenAI / GPT 5.5');

    await upsertProviderConfig({ providerId: CC_SWITCH_LOCAL_PROVIDER_ID, enabled: true });
    const runtime = await getActiveProviderRuntimeConfig();
    expect(runtime).toMatchObject({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      api: 'openai-responses',
    });
    expect(runtime?.baseUrl).toBeUndefined();
    expect(runtime?.modelId).toContain('cc-switch%3Acodex%3Aprovider-openai');
    expect(await getProviderApiKey(CC_SWITCH_LOCAL_PROVIDER_ID)).toBeUndefined();
    expect(await getStoredProviderApiKey(CC_SWITCH_LOCAL_PROVIDER_ID)).toEqual({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      apiKey: undefined,
    });

    const model = rankedModels(CC_SWITCH_LOCAL_PROVIDER_ID)[0];
    expect(model?.id).toBe(runtime?.modelId);
    const resolved = model ? await piModels().getAuth(model) : undefined;
    expect(resolved?.auth.apiKey).toBe('registry-key');
    expect(resolved?.source).toBe('CC Switch registry');
  });

  test('refreshes CC Switch registry models from provider model catalog without probing /models', async () => {
    installCcSwitchRegistry({
      apiKey: 'registry-key',
      modelCatalog: {
        models: [
          { slug: 'deepseek-v4-flash', display_name: 'DeepSeek Flash', context_window: 1000000 },
          { slug: 'claude-fable-5', display_name: 'Claude Fable 5', context_window: 200000 },
        ],
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('refresh must not probe /models for registry-backed CC Switch');
    }) as typeof fetch;
    try {
      const view = await refreshProviderModels(CC_SWITCH_LOCAL_PROVIDER_ID);
      const provider = view.availableProviders.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
      expect(provider?.models.map((model) => model.name)).toEqual([
        'Codex / OpenAI / Claude Fable 5',
        'Codex / OpenAI / DeepSeek Flash',
      ]);
      expect(provider?.models.find((model) => model.name === 'Codex / OpenAI / DeepSeek Flash')?.contextWindow).toBe(1000000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps a CC Switch registry source without an API key visible but unusable', async () => {
    installCcSwitchRegistry({ apiKey: undefined });
    const view = await upsertProviderConfig({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      enabled: true,
    });
    const provider = view.providers.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    const catalog = view.availableProviders.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    expect(provider?.auth.credentialed).toBe(false);
    expect(catalog?.connectionStatus).toBe('unsupported');
    expect(await getActiveProviderRuntimeConfig()).toBeNull();
  });

  test('does not expose a runnable CC Switch provider when the registry database is missing', async () => {
    const view = await upsertProviderConfig({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      enabled: true,
    });
    const provider = view.providers.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    const catalog = view.availableProviders.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    expect(provider?.auth.credentialed).toBe(false);
    expect(catalog).toMatchObject({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      credentialed: false,
      detected: false,
      connectionStatus: 'not-detected',
    });
    expect(await getActiveProviderRuntimeConfig()).toBeNull();
  });

  test('marks CC Switch Chat Completions providers as proxy-required', async () => {
    installCcSwitchRegistry({ apiFormat: 'openai_chat', apiKey: 'registry-key' });
    const view = await upsertProviderConfig({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      enabled: true,
    });
    const provider = view.providers.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    const catalog = view.availableProviders.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    expect(provider?.auth.credentialed).toBe(false);
    expect(catalog).toMatchObject({
      providerId: CC_SWITCH_LOCAL_PROVIDER_ID,
      credentialed: false,
      detected: true,
      connectionStatus: 'proxy-required',
    });
    expect(catalog?.connectionStatusMessage).toContain('Chat Completions');
    expect(catalog?.models).toEqual([]);
    expect(await getActiveProviderRuntimeConfig()).toBeNull();
    const refreshed = await refreshProviderModels(CC_SWITCH_LOCAL_PROVIDER_ID);
    expect(refreshed.availableProviders.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID)).toMatchObject({
      connectionStatus: 'proxy-required',
    });
  });

  test('stored api key resolves and reports as a stored key', async () => {
    await setProviderApiKey('openai', '  sk-test  ');
    expect(await getProviderApiKey('openai')).toBe('sk-test');
    expect(await getProviderSecretStatus('openai')).toEqual({ providerId: 'openai', hasApiKey: true });
    expect(await getStoredProviderApiKey('openai')).toEqual({ providerId: 'openai', apiKey: 'sk-test' });
  });

  test('clearing the key field removes a stored key but never an oauth login', async () => {
    await setProviderApiKey('openai', 'sk-test');
    await setProviderApiKey('openai', '');
    expect(await getProviderApiKey('openai')).toBeUndefined();

    await persistOAuthCredential('anthropic', { refresh: 'r', access: 'a', expires: 10 });
    await setProviderApiKey('anthropic', ''); // clearing the (empty) key field
    await deleteProviderApiKey('anthropic'); // explicit key delete
    // The oauth login must survive both key-clearing paths — proven by the
    // resolver still reaching the oauth branch.
    oauthToApiKeyImpl = async () => 'oauth-key';
    expect(await getProviderApiKey('anthropic')).toBe('oauth-key');
    expect(await getProviderSecretStatus('anthropic')).toEqual({ providerId: 'anthropic', hasApiKey: false });
    expect(await getStoredProviderApiKey('anthropic')).toEqual({ providerId: 'anthropic', apiKey: undefined });
  });

  test('oauth credential auto-refreshes and persists the rotated tokens', async () => {
    await persistOAuthCredential('anthropic', { refresh: 'r0', access: 'a0', expires: 1 });
    oauthRefreshImpl = async () => ({ type: 'oauth', refresh: 'r1', access: 'a1', expires: 999 });
    oauthToApiKeyImpl = async () => 'fresh-key';
    expect(await getProviderApiKey('anthropic')).toBe('fresh-key');

    // A second resolve must receive the PERSISTED rotated creds, not the originals.
    let seen: OAuthCredential | undefined;
    oauthToApiKeyImpl = async (credential) => {
      seen = credential;
      return 'fresh-key-2';
    };
    expect(await getProviderApiKey('anthropic')).toBe('fresh-key-2');
    expect(seen).toEqual({ type: 'oauth', refresh: 'r1', access: 'a1', expires: 999 });
  });

  test('concurrent oauth refreshes share the persisted post-refresh credential', async () => {
    await persistOAuthCredential('anthropic', { refresh: 'r0', access: 'a0', expires: 1 });
    let refreshCount = 0;
    oauthRefreshImpl = async () => {
      refreshCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { type: 'oauth', refresh: 'r1', access: 'a1', expires: Date.now() + 60_000 };
    };
    oauthToApiKeyImpl = async (credential) => credential.access;

    await expect(Promise.all([
      getProviderApiKey('anthropic'),
      getProviderApiKey('anthropic'),
    ])).resolves.toEqual(['a1', 'a1']);
    expect(refreshCount).toBe(1);
  });

  test('resolves only concrete api-key auth when nothing is stored', async () => {
    const saved = { openai: process.env.OPENAI_API_KEY, aws: process.env.AWS_PROFILE };
    try {
      process.env.OPENAI_API_KEY = 'env-key';
      process.env.AWS_PROFILE = 'test-profile';
      expect(await getProviderApiKey('openai')).toBe('env-key');
      expect(await getStoredProviderApiKey('openai')).toEqual({ providerId: 'openai', apiKey: undefined });
      expect(await getProviderApiKey('amazon-bedrock')).toBeUndefined();
      expect(await getProviderApiKey('definitely-not-a-provider')).toBeUndefined();
    } finally {
      restoreEnv('OPENAI_API_KEY', saved.openai);
      restoreEnv('AWS_PROFILE', saved.aws);
    }
  });

  test('does not flatten Cloudflare AI Gateway auth into an api-key override', async () => {
    const saved = {
      key: process.env.CLOUDFLARE_API_KEY,
      account: process.env.CLOUDFLARE_ACCOUNT_ID,
      gateway: process.env.CLOUDFLARE_GATEWAY_ID,
    };
    try {
      process.env.CLOUDFLARE_API_KEY = 'cf-key';
      process.env.CLOUDFLARE_ACCOUNT_ID = 'cf-account';
      process.env.CLOUDFLARE_GATEWAY_ID = 'cf-gateway';

      const model = piModels().getModels('cloudflare-ai-gateway')[0];
      if (!model) throw new Error('Missing Cloudflare AI Gateway test model');

      const auth = await piModels().getAuth(model);
      expect(auth?.auth.apiKey).toBeUndefined();
      expect(auth?.auth.headers).toMatchObject({ 'cf-aig-authorization': 'Bearer cf-key' });
      expect(auth?.auth.baseUrl).toContain('cf-account');
      expect(auth?.auth.baseUrl).toContain('cf-gateway');
      expect(await getProviderApiKey('cloudflare-ai-gateway')).toBeUndefined();
    } finally {
      restoreEnv('CLOUDFLARE_API_KEY', saved.key);
      restoreEnv('CLOUDFLARE_ACCOUNT_ID', saved.account);
      restoreEnv('CLOUDFLARE_GATEWAY_ID', saved.gateway);
    }
  });

  test('custom OpenAI-compatible providers use an internal pi provider without replacing catalog providers', async () => {
    await setProviderApiKey('openai', 'stored-openai-key');
    ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', modelId: 'proxy-model' });

    const internalProviderId = piCustomProviderId('openai');
    expect(internalProviderId).not.toBe('openai');
    expect(piModels().getProvider('openai')).toBeDefined();
    expect(piModels().getProvider(internalProviderId)).toBeDefined();
    expect(piProviders()).toContain('openai');
    expect(piProviders()).not.toContain(internalProviderId);

    const model = createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'proxy-model',
      baseUrl: 'https://proxy.example.com/v1',
    });
    expect(model.provider).toBe(internalProviderId);

    const auth = await piModels().getAuth(model);
    expect(auth?.auth.apiKey).toBe('stored-openai-key');
  });

  test('custom OpenAI-compatible providers inherit external auth without external base URL', async () => {
    const savedOpenAIKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = 'env-openai-key';
      ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', modelId: 'proxy-model' });

      const model = createOpenAICompatibleModel({
        providerId: 'openai',
        modelId: 'proxy-model',
        baseUrl: 'https://proxy.example.com/v1',
      });
      const auth = await piModels().getAuth(model);
      expect(auth?.auth.apiKey).toBe('env-openai-key');
      expect(auth?.auth.baseUrl).toBeUndefined();
    } finally {
      restoreEnv('OPENAI_API_KEY', savedOpenAIKey);
    }
  });

  test('custom OpenAI-compatible catalog models preserve their native API adapter', () => {
    const catalogModel = piModels().getModel('openai', 'gpt-5.5');
    expect(catalogModel).toBeDefined();
    expect(catalogModel?.api).toBe('openai-responses');

    const model = createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      baseUrl: 'https://proxy.example.com/v1',
      catalogModel,
    });

    expect(model.provider).toBe(piCustomProviderId('openai'));
    expect(model.api).toBe('openai-responses');
    expect(model.baseUrl).toBe('https://proxy.example.com/v1');
    expect(model.contextWindow).toBe(catalogModel?.contextWindow);
    expect(model.maxTokens).toBe(catalogModel?.maxTokens);
    expect(model.reasoning).toBe(true);
  });

  test('custom Responses endpoints keep configured provider prompt cache affinity', () => {
    const catalogModel = piModels().getModel('openai', 'gpt-5.5');
    const runtimeSettings = {
      providerTimeoutMs: null,
      providerMaxRetries: null,
      providerMaxRetryDelayMs: 60_000,
      providerCacheRetention: 'short' as const,
    };

    expect(providerStreamOptionsFromRuntimeSettings(runtimeSettings, createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      baseUrl: 'https://proxy.example.com/v1',
      catalogModel,
    }))).toMatchObject({ cacheRetention: 'short' });

    expect(providerStreamOptionsFromRuntimeSettings(runtimeSettings, {
      ...catalogModel!,
      baseUrl: 'https://api.openai.com/v1',
    })).toMatchObject({ cacheRetention: 'short' });

    expect(providerStreamOptionsFromRuntimeSettings(undefined, createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      baseUrl: 'https://proxy.example.com/v1',
      catalogModel,
    }))).not.toHaveProperty('cacheRetention');
  });

  test('custom OpenAI-compatible unknown models fall back to chat completions', () => {
    const model = createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'proxy-only-model',
      baseUrl: 'https://proxy.example.com/v1',
    });

    expect(model.provider).toBe(piCustomProviderId('openai'));
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://proxy.example.com/v1');
  });

  test('custom OpenAI-compatible provider registration replaces stale base URLs for a model id', () => {
    ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'http://localhost:1234/v1', modelId: 'proxy-model' });
    ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', modelId: 'proxy-model' });
    ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'http://localhost:1234/v1', modelId: 'proxy-model' });

    const models = piModels().getModels(piCustomProviderId('openai'));
    expect(models.filter((model) => model.id === 'proxy-model').map((model) => model.baseUrl)).toEqual([
      'http://localhost:1234/v1',
    ]);
    expect(piModels().getProvider(piCustomProviderId('openai'))?.baseUrl).toBe('http://localhost:1234/v1');
  });

  test('local endpoints use a stored key but never the ambient env key', async () => {
    const savedOpenAIKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = 'env-openai-key';
      ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'http://localhost:1234/v1', modelId: 'local-model' });
      const model = createOpenAICompatibleModel({
        providerId: 'openai',
        modelId: 'local-model',
        baseUrl: 'http://localhost:1234/v1',
      });

      // No stored key: a local endpoint falls back to the inert sentinel and never
      // forwards the ambient OPENAI_API_KEY to localhost.
      expect((await piModels().getAuth(model))?.auth.apiKey).toBe('local-endpoint');

      // A deliberately-stored key wins (e.g. a local proxy fronted by a master key).
      await setProviderApiKey('openai', 'stored-openai-key');
      expect((await piModels().getAuth(model))?.auth.apiKey).toBe('stored-openai-key');
    } finally {
      restoreEnv('OPENAI_API_KEY', savedOpenAIKey);
    }
  });

  test('custom OpenAI-compatible providers reject keyless remote endpoints', async () => {
    const savedOpenAIKey = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', modelId: 'remote-model' });

      const remoteAuth = await piModels().getAuth(createOpenAICompatibleModel({
        providerId: 'openai',
        modelId: 'remote-model',
        baseUrl: 'https://proxy.example.com/v1',
      }));
      expect(remoteAuth).toBeUndefined();
    } finally {
      restoreEnv('OPENAI_API_KEY', savedOpenAIKey);
    }
  });

  test('custom OpenAI-compatible streams dispatch through the internal provider and report the external provider id', async () => {
    const seenModels: Array<{ provider: string; api: string; baseUrl?: string }> = [];
    piModels().setProvider(createProvider({
      id: piCustomProviderId('openai'),
      name: 'OpenAI proxy',
      auth: {
        apiKey: {
          name: 'OpenAI proxy API key',
          resolve: async ({ credential }) => credential?.key
            ? { auth: { apiKey: credential.key }, source: 'request override' }
            : undefined,
        },
      },
      models: [createOpenAICompatibleModel({
        providerId: 'openai',
        modelId: 'gpt-5.1',
        baseUrl: 'https://proxy.example.com/v1',
      })],
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: (model) => {
          seenModels.push({ provider: model.provider, api: model.api, baseUrl: model.baseUrl });
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const message = {
              ...fauxAssistantMessage(fauxText('Custom endpoint routed.')),
              api: model.api,
              provider: model.provider,
              model: model.id,
            };
            stream.push({ type: 'start', partial: { ...message, content: [] } });
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end(message);
          });
          return stream;
        },
      },
    }));

    const result = await piStreamSimple(createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'gpt-5.1',
      baseUrl: 'https://proxy.example.com/v1',
    }), {
      messages: [{ role: 'user', content: 'Ping', timestamp: Date.now() }],
    }, { apiKey: 'test-key' }).result();

    expect(seenModels).toEqual([{
      provider: piCustomProviderId('openai'),
      api: 'openai-completions',
      baseUrl: 'https://proxy.example.com/v1',
    }]);
    expect(result.provider).toBe('openai');
    expect(result.api).toBe('openai-completions');
    expect(result.model).toBe('gpt-5.1');
  });

  test('custom endpoint connection probes accept Codex model catalogs and preserve the discovered catalog model API', async () => {
    const restoreFetch = mockFetchJson({ models: [{ slug: 'gpt-5.5' }] });
    const seenModels: Array<{ provider: string; api: string; id: string; baseUrl?: string }> = [];
    const seenOptions: Array<{ cacheRetention?: string }> = [];
    const seenPayloads: unknown[] = [];
    try {
      piModels().setProvider(createProvider({
        id: piCustomProviderId('openai'),
        name: 'OpenAI proxy',
        auth: {
          apiKey: {
            name: 'OpenAI proxy API key',
            resolve: async ({ credential }) => credential?.key
              ? { auth: { apiKey: credential.key }, source: 'request override' }
              : undefined,
          },
        },
        models: [createOpenAICompatibleModel({
          providerId: 'openai',
          modelId: 'gpt-5.5',
          baseUrl: 'https://proxy.example.com/v1',
          catalogModel: piModels().getModel('openai', 'gpt-5.5'),
        })],
        api: {
          stream: () => { throw new Error('stream should not be called'); },
          streamSimple: (model, _context, options) => {
            seenModels.push({ provider: model.provider, api: model.api, id: model.id, baseUrl: model.baseUrl });
            seenOptions.push({ cacheRetention: options?.cacheRetention });
            const stream = createAssistantMessageEventStream();
            queueMicrotask(async () => {
              const payload = await options?.onPayload?.({
                input: [
                  { role: 'developer', content: 'Connection probe system prompt.' },
                  { role: 'user', content: [{ type: 'input_text', text: 'Ping' }] },
                ],
                tools: [{ type: 'function', name: 'probe' }],
              }, model) ?? null;
              seenPayloads.push(payload);
              const message = {
                ...fauxAssistantMessage(fauxText('Connection probe routed.')),
                api: model.api,
                provider: model.provider,
                model: model.id,
              };
              stream.push({ type: 'start', partial: { ...message, content: [] } });
              stream.push({ type: 'done', reason: 'stop', message });
              stream.end(message);
            });
            return stream;
          },
        },
      }));

      await expect(testProviderConnection({
        providerId: 'openai',
        baseUrl: 'https://proxy.example.com/v1',
        apiKey: 'test-key',
      })).resolves.toMatchObject({ success: true });

      expect(seenModels).toEqual([{
        provider: piCustomProviderId('openai'),
        api: 'openai-responses',
        id: 'gpt-5.5',
        baseUrl: 'https://proxy.example.com/v1',
      }]);
      expect(seenOptions).toEqual([{ cacheRetention: 'short' }]);
      expect(seenPayloads).toEqual([{
        instructions: 'Connection probe system prompt.',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Ping' }] },
        ],
        text: { verbosity: 'low' },
        tool_choice: 'auto',
        parallel_tool_calls: true,
        tools: [{ type: 'function', name: 'probe' }],
      }]);
    } finally {
      restoreFetch();
    }
  });

  test('resolver never throws — returns undefined on failure', async () => {
    await persistOAuthCredential('anthropic', { refresh: 'r', access: 'a', expires: 1 });
    oauthRefreshImpl = async () => {
      throw new Error('network down');
    };
    expect(await getProviderApiKey('anthropic')).toBeUndefined();
  });

  test('serializes concurrent writes so cross-provider updates are not lost', async () => {
    // Without per-path serialization each writer read the same empty map and the
    // last write would drop the others. The lock makes them merge.
    await Promise.all([
      setProviderApiKey('openai', 'sk-openai'),
      persistOAuthCredential('anthropic', { refresh: 'r', access: 'a', expires: 5 }),
      setProviderApiKey('groq', 'sk-groq'),
    ]);
    expect(await getProviderApiKey('openai')).toBe('sk-openai');
    expect(await getProviderApiKey('groq')).toBe('sk-groq');
    // The anthropic oauth login survived the concurrent api-key writes.
    oauthToApiKeyImpl = async () => 'oauth-k';
    expect(await getProviderApiKey('anthropic')).toBe('oauth-k');
  });
});

describe('secret file at rest', () => {
  test('persists and round-trips secrets as chmod-600 plaintext', async () => {
    await setProviderApiKey('openai', 'sk-secret');
    expect(await getProviderApiKey('openai')).toBe('sk-secret');

    const raw = await readFile(secretPath(), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "credentials": {');
    const onDisk = JSON.parse(raw) as { enc?: string; credentials?: Record<string, unknown> };
    expect(onDisk.enc).toBeUndefined();
    expect(onDisk.credentials?.openai).toEqual({ type: 'api_key', key: 'sk-secret' });
    if (process.platform !== 'win32') {
      expect((await stat(secretPath())).mode & 0o777).toBe(0o600);
    }
  });

  test('stale encrypted envelopes are ignored and overwritten by the next save', async () => {
    await writeFile(secretPath(), `${JSON.stringify({ enc: 'old-safe-storage-blob' }, null, 2)}\n`);

    expect(await getProviderApiKey('openai')).toBeUndefined();
    await setProviderApiKey('openai', 'sk-new');

    const onDisk = JSON.parse(await readFile(secretPath(), 'utf8')) as { enc?: string; credentials?: Record<string, unknown> };
    expect(onDisk.enc).toBeUndefined();
    expect(onDisk.credentials?.openai).toEqual({ type: 'api_key', key: 'sk-new' });
  });

  test('preserves pi api-key credential env across credential-store round trips', async () => {
    piModels().setProvider(createProvider({
      id: 'env-api-key-test',
      name: 'Env API key test',
      auth: {
        apiKey: {
          name: 'Env API key test',
          resolve: async ({ credential }) => credential
            ? { auth: { apiKey: credential.key }, env: credential.env, source: 'stored credential' }
            : undefined,
        },
      },
      models: [{
        id: 'env-model',
        name: 'Env Model',
        api: 'openai-completions',
        provider: 'env-api-key-test',
        baseUrl: '',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }],
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: () => { throw new Error('streamSimple should not be called'); },
      },
    }));

    const store = piModels() as unknown as {
      credentials: {
        modify(
          providerId: string,
          fn: (current: Credential | undefined) => Promise<Credential | undefined>,
        ): Promise<Credential | undefined>;
      };
    };
    await store.credentials.modify('env-api-key-test', async () => ({
      type: 'api_key',
      key: 'sk-env',
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gateway' },
    }));

    const onDisk = JSON.parse(await readFile(secretPath(), 'utf8')) as { credentials?: Record<string, unknown> };
    expect(onDisk.credentials?.['env-api-key-test']).toEqual({
      type: 'api_key',
      key: 'sk-env',
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gateway' },
    });

    const auth = await piModels().getAuth(piModels().getModels('env-api-key-test')[0]!);
    expect(auth).toEqual({
      auth: { apiKey: 'sk-env' },
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gateway' },
      source: 'stored credential',
    });
  });
});
