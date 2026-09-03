import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createAssistantMessageEventStream,
  createProvider,
  fauxAssistantMessage,
  fauxText,
  type Credential,
  type OAuthCredential,
} from '@earendil-works/pi-ai';
import { cloudflareAIGatewayAuth } from '@earendil-works/pi-ai/providers/cloudflare-auth';
import { cloudflareStreams } from '@earendil-works/pi-ai/providers/cloudflare-stream';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createOpenAICompatibleModel,
  ensurePiCustomProvider,
  piCompleteSimple,
  piCredentialStore,
  piCustomProviderId,
  piModels,
  piProviders,
  piRefreshProviderModels,
  piRequestApiKeyOverride,
  piResolveAuthApiKey,
  piStreamSimple,
  registerLocalGatewayRuntimeModels,
  resetPiDynamicModelsRestoreForTests,
} from '../../src/main/piModels';
import {
  CC_SWITCH_LOCAL_PROVIDER_ID,
} from '../../src/core/localGatewayProviders';
import {
  buildCcSwitchRegistryFromRows,
  parseCcSwitchModelOptionId,
  setCcSwitchRegistryReaderForTests,
} from '../../src/main/ccSwitchRegistry';
import { withFileWriteLock } from '../../src/main/jsonFileStore';

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

const {
  setProviderApiKey,
  deleteProviderApiKey,
  getProviderApiKey,
  getProviderSettings,
  getProviderRuntimeConfig,
  getProviderSecretStatus,
  getActiveProviderRuntimeConfig,
  getStoredProviderApiKey,
  providerStreamOptionsFromRuntimeSettings,
  persistOAuthCredential,
  rankedModels,
  refreshProviderModels,
  testProviderConnection,
  upsertProviderConfig,
} = await import('../../src/main/agent/capabilities/agentSettings');

const { resolveProviderModel } = await import('../../src/main/agent/capabilities/agentModelResolution');

const secretPath = () => path.join(currentUserData, 'agent-secrets.json');
const builtinRadiusProvider = piModels().getProvider('radius');
const builtinLocalGatewayProvider = piModels().getProvider(CC_SWITCH_LOCAL_PROVIDER_ID);

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
      thinkingLevelMap: { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH', xhigh: 'XHIGH', max: 'MAX' },
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
  if (builtinRadiusProvider) piModels().setProvider(builtinRadiusProvider);
  if (builtinLocalGatewayProvider) piModels().setProvider(builtinLocalGatewayProvider);
  piModels().deleteProvider(piCustomProviderId('openai'));
  piModels().deleteProvider(piCustomProviderId('openai', 'http://localhost:1234/v1'));
  piModels().deleteProvider(piCustomProviderId(CC_SWITCH_LOCAL_PROVIDER_ID));
  piModels().deleteProvider('env-api-key-test');
  piModels().deleteProvider('startup-dynamic-test');
  piModels().deleteProvider('dynamic-catalog-test');
  piModels().deleteProvider('dynamic-catalog-peer-test');
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

async function waitForMissingFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(filePath);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for temporary file cleanup: ${filePath}`);
}

function radiusGatewayConfig() {
  return {
    baseUrl: 'https://runtime.radius.example.test',
    models: [{
      id: 'radius-probe-model',
      name: 'Radius Probe Model',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    }],
  };
}

function installRadiusConnectionProbeProvider() {
  let liveRefreshes = 0;
  piModels().setProvider(createProvider({
    id: 'radius',
    name: 'Radius',
    auth: {
      apiKey: {
        name: 'Radius key',
        resolve: async ({ credential }) => credential?.key
          ? { auth: { apiKey: credential.key }, source: 'stored credential' }
          : undefined,
      },
    },
    models: [],
    fetchModels: async () => {
      liveRefreshes += 1;
      throw new Error('connection validation must not refresh the live provider');
    },
    api: {
      stream: () => { throw new Error('stream should not be called'); },
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const message = {
            ...fauxAssistantMessage(fauxText('Radius connection routed.')),
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
  return () => liveRefreshes;
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
  test('restores a persisted dynamic catalog before runtime model resolution', async () => {
    const providerId = 'startup-dynamic-test';
    const model = {
      id: 'startup-model',
      name: 'Startup Model',
      api: 'openai-completions' as const,
      provider: providerId,
      baseUrl: 'https://startup.example.test/v1',
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
    let networkRefreshes = 0;
    piModels().setProvider(createProvider({
      id: providerId,
      name: 'Startup Dynamic Test',
      auth: {
        apiKey: {
          name: 'Startup key',
          resolve: async ({ credential }) => credential?.key
            ? { auth: { apiKey: credential.key }, source: 'stored credential' }
            : undefined,
        },
      },
      models: [],
      fetchModels: async () => {
        networkRefreshes += 1;
        return [];
      },
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: () => { throw new Error('streamSimple should not be called'); },
      },
    }));
    await Promise.all([
      writeFile(path.join(currentUserData, 'agent-providers.json'), JSON.stringify({
        activeProviderId: providerId,
        providers: [{ providerId, enabled: true }],
      })),
      writeFile(secretPath(), JSON.stringify({
        credentials: { [providerId]: { type: 'api_key', key: 'startup-key' } },
      })),
      writeFile(path.join(currentUserData, 'agent-model-catalogs.json'), JSON.stringify({
        catalogs: { [providerId]: { models: [model] } },
      })),
    ]);

    resetPiDynamicModelsRestoreForTests();
    await expect(getProviderRuntimeConfig(providerId, model.id)).resolves.toMatchObject({ providerId });
    expect(piModels().getModel(providerId, model.id)).toEqual(model);
    expect(networkRefreshes).toBe(0);
  });

  // The model list the renderer receives is ordered by `providerModelOptions`;
  // an unpinned Thread runs whatever `resolveProviderModel` picks. The picker
  // presents the head of that list as "always newest", so the two heads must be
  // the same model. Pinning this in main is the point: the renderer only reads
  // index 0, so a renderer-side assertion would compare an array to itself and
  // stay green through exactly the drift that makes the UI name a model that
  // does not run.
  test('the head of the renderer model list is the model an unpinned Thread runs', async () => {
    const providerId = 'parity-test';
    const model = (id: string) => ({
      id,
      name: id,
      api: 'anthropic-messages' as const,
      provider: providerId,
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    });
    // Deliberately unranked on the way in, so the assertion proves a sort ran.
    piModels().setProvider(createProvider({
      id: providerId,
      name: 'Parity Test',
      models: [model('paritytest-3-9'), model('paritytest-4-10'), model('paritytest-4-5')],
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: () => { throw new Error('streamSimple should not be called'); },
      },
    }));
    try {
      const view = await getProviderSettings();
      const rendererHead = view.availableProviders
        .find((candidate) => candidate.providerId === providerId)
        ?.models[0];
      expect(rendererHead?.id).toBe('paritytest-4-10');
      expect(resolveProviderModel({ providerId }).id).toBe(rendererHead?.id);
    } finally {
      piModels().deleteProvider(providerId);
    }
  });

  test('provider settings preserve model-specific effort levels and display labels', async () => {
    const view = await getProviderSettings();
    const model = view.availableProviders
      .find((candidate) => candidate.providerId === 'anthropic')
      ?.models.find((candidate) => candidate.id === 'claude-test');
    expect(model?.supportedThinkingLevels).toEqual(['low', 'high', 'xhigh', 'max']);
    expect(model?.thinkingLevelLabels).toEqual({ low: 'LOW', high: 'HIGH', xhigh: 'XHIGH', max: 'MAX' });
  });

  test('saving an API key refreshes and persists only real dynamic capabilities', async () => {
    const providerId = 'dynamic-catalog-test';
    let refreshCount = 0;
    let refreshCredential: Credential | undefined;
    const dynamicModel = {
      id: 'dynamic-model',
      name: 'Dynamic Model',
      api: 'openai-completions' as const,
      provider: providerId,
      baseUrl: 'https://dynamic.example.test/v1',
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
    const createDynamicCatalogProvider = () => createProvider({
      id: providerId,
      name: 'Dynamic Catalog Test',
      auth: {
        apiKey: {
          name: 'Dynamic catalog key',
          resolve: async ({ credential }) => credential?.key
            ? { auth: { apiKey: credential.key }, source: 'stored credential' }
            : undefined,
        },
      },
      models: [],
      fetchModels: async ({ credential }) => {
        refreshCount += 1;
        refreshCredential = credential;
        return [dynamicModel];
      },
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: () => { throw new Error('streamSimple should not be called'); },
      },
    });
    piModels().setProvider(createDynamicCatalogProvider());

    try {
      const uncredentialed = await getProviderSettings();
      expect(uncredentialed.availableProviders.find((provider) => provider.providerId === providerId)).toMatchObject({
        modelsRefreshable: true,
        capabilities: [],
        models: [],
      });

      await setProviderApiKey(providerId, 'dynamic-key');
      expect(refreshCount).toBe(1);
      expect(refreshCredential).toEqual({ type: 'api_key', key: 'dynamic-key' });

      const configured = await upsertProviderConfig({ providerId, enabled: true });
      expect(configured.availableProviders.find((provider) => provider.providerId === providerId)).toMatchObject({
        modelsRefreshable: true,
        capabilities: [{ kind: 'language', refreshable: true }],
        models: [{ id: 'dynamic-model', name: 'Dynamic Model' }],
      });

      piModels().setProvider(createDynamicCatalogProvider());
      expect(piModels().getModels(providerId)).toEqual([]);
      await piModels().refresh({ allowNetwork: false });
      expect(refreshCount).toBe(1);
      expect(piModels().getModels(providerId)).toEqual([dynamicModel]);
    } finally {
      piModels().deleteProvider(providerId);
    }
  });

  test('saving an API key succeeds when dynamic catalog warming fails', async () => {
    const providerId = 'dynamic-catalog-test';
    let refreshCount = 0;
    piModels().setProvider(createProvider({
      id: providerId,
      name: 'Offline Dynamic Catalog Test',
      auth: {
        apiKey: {
          name: 'Offline dynamic catalog key',
          resolve: async ({ credential }) => credential?.key
            ? { auth: { apiKey: credential.key }, source: 'stored credential' }
            : undefined,
        },
      },
      models: [],
      fetchModels: async () => {
        refreshCount += 1;
        throw new Error('catalog endpoint is offline');
      },
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: () => { throw new Error('streamSimple should not be called'); },
      },
    }));

    try {
      await expect(setProviderApiKey(providerId, 'persisted-key')).resolves.toEqual({
        providerId,
        hasApiKey: true,
      });
      expect(refreshCount).toBe(1);
      await expect(getStoredProviderApiKey(providerId)).resolves.toEqual({
        providerId,
        apiKey: 'persisted-key',
      });
      await expect(piRefreshProviderModels(providerId)).rejects.toThrow('catalog endpoint is offline');
      expect(refreshCount).toBe(2);
    } finally {
      piModels().deleteProvider(providerId);
    }
  });

  test('refreshing one dynamic provider does not fan out to its peers', async () => {
    const counts = new Map<string, number>();
    const dynamicProvider = (providerId: string) => createProvider({
      id: providerId,
      name: providerId,
      auth: {
        apiKey: {
          name: `${providerId} key`,
          resolve: async ({ credential }) => credential?.key
            ? { auth: { apiKey: credential.key }, source: 'stored credential' }
            : undefined,
        },
      },
      models: [],
      fetchModels: async () => {
        counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
        return [{
          id: `${providerId}-model`,
          name: `${providerId} model`,
          api: 'openai-completions' as const,
          provider: providerId,
          baseUrl: `https://${providerId}.example.test/v1`,
          reasoning: false,
          input: ['text' as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        }];
      },
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: () => { throw new Error('streamSimple should not be called'); },
      },
    });
    const target = 'dynamic-catalog-test';
    const peer = 'dynamic-catalog-peer-test';
    piModels().setProvider(dynamicProvider(target));
    piModels().setProvider(dynamicProvider(peer));

    await setProviderApiKey(target, 'target-key');
    await setProviderApiKey(peer, 'peer-key');
    expect(Object.fromEntries(counts)).toEqual({ [target]: 1, [peer]: 1 });

    await refreshProviderModels(target);
    expect(Object.fromEntries(counts)).toEqual({ [target]: 2, [peer]: 1 });
  });

  test('a newer dynamic catalog refresh supersedes an older late result', async () => {
    const providerId = 'dynamic-catalog-test';
    const catalogPath = path.join(currentUserData, 'agent-model-catalogs.json');
    const catalogModel = (id: string) => ({
      id,
      name: id,
      api: 'openai-completions' as const,
      provider: providerId,
      baseUrl: 'https://dynamic.example.test/v1',
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    });
    let attempts = 0;
    let markFirstFetched: (() => void) | undefined;
    let markLockHeld: (() => void) | undefined;
    let releaseWriteLock: (() => void) | undefined;
    const firstFetched = new Promise<void>((resolve) => { markFirstFetched = resolve; });
    const lockHeld = new Promise<void>((resolve) => { markLockHeld = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWriteLock = resolve; });
    await writeFile(secretPath(), JSON.stringify({
      credentials: { [providerId]: { type: 'api_key', key: 'dynamic-key' } },
    }));
    await writeFile(catalogPath, JSON.stringify({ catalogs: {} }));
    piModels().setProvider(createProvider({
      id: providerId,
      name: 'Dynamic Catalog Test',
      auth: {
        apiKey: {
          name: 'Dynamic catalog key',
          resolve: async ({ credential }) => credential?.key
            ? { auth: { apiKey: credential.key }, source: 'stored credential' }
            : undefined,
        },
      },
      models: [catalogModel('current-model')],
      fetchModels: async () => {
        attempts += 1;
        if (attempts === 1) {
          markFirstFetched?.();
          return [catalogModel('stale-model')];
        }
        throw new Error('newer catalog refresh failed');
      },
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: () => { throw new Error('streamSimple should not be called'); },
      },
    }));

    const blockedWrite = withFileWriteLock(catalogPath, async () => {
      markLockHeld?.();
      await writeGate;
    });
    await lockHeld;
    const staleRefresh = piRefreshProviderModels(providerId);
    await firstFetched;
    expect(await Promise.race([
      staleRefresh.then(() => 'settled', () => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])).toBe('pending');
    try {
      await expect(piRefreshProviderModels(providerId)).rejects.toThrow('newer catalog refresh failed');
      await staleRefresh;
    } finally {
      releaseWriteLock?.();
      await blockedWrite;
    }

    expect(piModels().getModels(providerId).map((model) => model.id)).toEqual(['current-model']);
    const persisted = JSON.parse(await readFile(
      catalogPath,
      'utf8',
    )) as { catalogs: Record<string, { models: Array<{ id: string }> }> };
    expect(persisted.catalogs[providerId]).toBeUndefined();
  });

  test('a superseded catalog write cannot commit after its temporary write starts', async () => {
    const providerId = 'dynamic-catalog-test';
    const catalogPath = path.join(currentUserData, 'agent-model-catalogs.json');
    const catalogModel = (id: string, name = id) => ({
      id,
      name,
      api: 'openai-completions' as const,
      provider: providerId,
      baseUrl: 'https://dynamic.example.test/v1',
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    });
    let attempts = 0;
    await writeFile(secretPath(), JSON.stringify({
      credentials: { [providerId]: { type: 'api_key', key: 'dynamic-key' } },
    }));
    await writeFile(catalogPath, JSON.stringify({ catalogs: {} }));
    piModels().setProvider(createProvider({
      id: providerId,
      name: 'Dynamic Catalog Commit Test',
      auth: {
        apiKey: {
          name: 'Dynamic catalog key',
          resolve: async ({ credential }) => credential?.key
            ? { auth: { apiKey: credential.key }, source: 'stored credential' }
            : undefined,
        },
      },
      models: [catalogModel('current-model')],
      fetchModels: async () => {
        attempts += 1;
        if (attempts === 1) {
          return [catalogModel('stale-model', 'x'.repeat(32 * 1024 * 1024))];
        }
        throw new Error('newer catalog refresh failed');
      },
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: () => { throw new Error('streamSimple should not be called'); },
      },
    }));

    let newerRefresh: Promise<void> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let catalogWatcher: ReturnType<typeof watch> | undefined;
    const temporaryWriteStarted = new Promise<string>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('catalog temporary write did not start')), 5000);
      const catalogFileName = path.basename(catalogPath);
      catalogWatcher = watch(currentUserData, (_event, fileName) => {
        const observed = fileName?.toString();
        if (newerRefresh || !observed?.startsWith(`${catalogFileName}.`) || !observed.endsWith('.tmp')) return;
        newerRefresh = piRefreshProviderModels(providerId);
        resolve(path.join(currentUserData, observed));
      });
      catalogWatcher.unref();
    });

    const staleRefresh = piRefreshProviderModels(providerId);
    try {
      const temporaryPath = await temporaryWriteStarted;
      await expect(newerRefresh).rejects.toThrow('newer catalog refresh failed');
      await staleRefresh;
      await waitForMissingFile(temporaryPath);
    } finally {
      if (timeout) clearTimeout(timeout);
      catalogWatcher?.close();
    }

    expect(piModels().getModels(providerId).map((model) => model.id)).toEqual(['current-model']);
    const persisted = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      catalogs: Record<string, { models: Array<{ id: string }> }>;
    };
    expect(persisted.catalogs[providerId]).toBeUndefined();
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
    expect(model ? await piResolveAuthApiKey(model) : undefined).toBe('registry-key');
  });

  test('reports an unconfigured local gateway as missing auth until a request override exists', async () => {
    const model = {
      id: 'unconfigured-gateway-model',
      name: 'Unconfigured gateway model',
      api: 'openai-responses' as const,
      provider: CC_SWITCH_LOCAL_PROVIDER_ID,
      baseUrl: 'https://unconfigured-gateway.example.test/v1',
      reasoning: true,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
    registerLocalGatewayRuntimeModels(CC_SWITCH_LOCAL_PROVIDER_ID, [model]);

    await expect(piModels().getAuth(model)).resolves.toBeUndefined();
    await expect(piModels().checkAuth(CC_SWITCH_LOCAL_PROVIDER_ID)).resolves.toBeUndefined();
    await expect(piRequestApiKeyOverride(model)).resolves.toBeUndefined();
  });

  test('passes the selected CC Switch source key to the connection probe request', async () => {
    installCcSwitchRegistry({ apiKey: 'registry-key' });
    await getProviderSettings();
    const originalFetch = globalThis.fetch;
    let authorization: string | null = null;
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      authorization = request.headers.get('authorization');
      return new Response(JSON.stringify({ error: { message: 'Probe stopped after auth capture.' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await expect(testProviderConnection({ providerId: CC_SWITCH_LOCAL_PROVIDER_ID })).resolves.toMatchObject({
        success: false,
        statusCode: 401,
      });
      expect(authorization).toBe('Bearer registry-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test('sorts CC Switch models by upstream model id instead of source-scoped alias numbers', async () => {
    const snapshot = buildCcSwitchRegistryFromRows({
      providers: [
        {
          id: '99999999-9999-4999-9999-999999999999',
          app_type: 'codex',
          name: 'High UUID',
          settings_config: JSON.stringify({
            auth: { OPENAI_API_KEY: 'registry-key-1' },
            model: 'gpt-5.4',
          }),
          meta: JSON.stringify({ apiFormat: 'openai_responses' }),
          is_current: 0,
          sort_index: 0,
        },
        {
          id: '00000000-0000-4000-8000-000000000000',
          app_type: 'codex',
          name: 'Low UUID',
          settings_config: JSON.stringify({
            auth: { OPENAI_API_KEY: 'registry-key-2' },
            model: 'gpt-5.5',
          }),
          meta: JSON.stringify({ apiFormat: 'openai_responses' }),
          is_current: 0,
          sort_index: 1,
        },
      ],
      endpoints: [
        {
          provider_id: '99999999-9999-4999-9999-999999999999',
          app_type: 'codex',
          url: 'https://registry-one.example.com/v1',
          added_at: '2026-07-08T00:00:00.000Z',
        },
        {
          provider_id: '00000000-0000-4000-8000-000000000000',
          app_type: 'codex',
          url: 'https://registry-two.example.com/v1',
          added_at: '2026-07-08T00:00:00.000Z',
        },
      ],
      proxyConfigs: [],
    });
    setCcSwitchRegistryReaderForTests(async () => snapshot);

    const view = await getProviderSettings();
    const provider = view.availableProviders.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    expect(provider?.models.map((model) => parseCcSwitchModelOptionId(model.id)?.modelId)).toEqual([
      'gpt-5.5',
      'gpt-5.4',
    ]);
    expect(parseCcSwitchModelOptionId(rankedModels(CC_SWITCH_LOCAL_PROVIDER_ID)[0]!.id)?.modelId).toBe('gpt-5.5');
  });

  test('keeps the current CC Switch source ahead of non-current sources', async () => {
    const snapshot = buildCcSwitchRegistryFromRows({
      providers: [
        {
          id: 'current-source',
          app_type: 'codex',
          name: 'Current Source',
          settings_config: JSON.stringify({
            auth: { OPENAI_API_KEY: 'registry-key-1' },
            model: 'gpt-5.4',
          }),
          meta: JSON.stringify({ apiFormat: 'openai_responses' }),
          is_current: 1,
          sort_index: 0,
        },
        {
          id: 'newer-non-current-source',
          app_type: 'codex',
          name: 'Newer Non-current Source',
          settings_config: JSON.stringify({
            auth: { OPENAI_API_KEY: 'registry-key-2' },
            model: 'gpt-5.5',
          }),
          meta: JSON.stringify({ apiFormat: 'openai_responses' }),
          is_current: 0,
          sort_index: 1,
        },
      ],
      endpoints: [
        {
          provider_id: 'current-source',
          app_type: 'codex',
          url: 'https://current.example.com/v1',
          added_at: '2026-07-08T00:00:00.000Z',
        },
        {
          provider_id: 'newer-non-current-source',
          app_type: 'codex',
          url: 'https://newer.example.com/v1',
          added_at: '2026-07-08T00:00:00.000Z',
        },
      ],
      proxyConfigs: [],
    });
    setCcSwitchRegistryReaderForTests(async () => snapshot);

    const view = await getProviderSettings();
    const provider = view.availableProviders.find((candidate) => candidate.providerId === CC_SWITCH_LOCAL_PROVIDER_ID);
    expect(provider?.models.map((model) => parseCcSwitchModelOptionId(model.id)?.modelId)).toEqual([
      'gpt-5.4',
      'gpt-5.5',
    ]);
    expect(parseCcSwitchModelOptionId(rankedModels(CC_SWITCH_LOCAL_PROVIDER_ID)[0]!.id)?.modelId).toBe('gpt-5.4');
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

  test('credential store lists non-secret provider metadata', async () => {
    await setProviderApiKey('openai', 'sk-secret');
    await persistOAuthCredential('anthropic', { refresh: 'refresh-secret', access: 'access-secret', expires: 999 });

    expect([...(await piCredentialStore().list())].sort((left, right) => left.providerId.localeCompare(right.providerId))).toEqual([
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai', type: 'api_key' },
    ]);
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

  test('lets provider-owned OAuth auth preserve its credential-specific base URL', async () => {
    const model = {
      id: 'copilot-enterprise-model',
      name: 'Copilot Enterprise Model',
      api: 'openai-completions' as const,
      provider: 'github-copilot-test',
      baseUrl: 'https://api.individual.example.test',
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
    const dispatched: Array<{ apiKey?: string; baseUrl: string }> = [];
    piModels().setProvider(createProvider({
      id: model.provider,
      name: 'GitHub Copilot Test',
      auth: {
        oauth: {
          name: 'GitHub Copilot OAuth',
          login: async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 60_000 }),
          refresh: async (credential) => credential,
          toAuth: async (credential) => ({
            apiKey: credential.access,
            baseUrl: 'https://api.enterprise.example.test',
          }),
        },
      },
      models: [model],
      api: {
        stream: () => { throw new Error('stream should not be called'); },
        streamSimple: (requestModel, _context, options) => {
          dispatched.push({ apiKey: options?.apiKey, baseUrl: requestModel.baseUrl });
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const message = {
              ...fauxAssistantMessage(fauxText('Enterprise routed.')),
              api: requestModel.api,
              provider: requestModel.provider,
              model: requestModel.id,
            };
            stream.push({ type: 'start', partial: { ...message, content: [] } });
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end(message);
          });
          return stream;
        },
      },
    }));
    try {
      await persistOAuthCredential(model.provider, {
        refresh: 'enterprise-refresh',
        access: 'enterprise-access',
        expires: Date.now() + 60_000,
      });

      await expect(piResolveAuthApiKey(model)).resolves.toBe('enterprise-access');
      await expect(piRequestApiKeyOverride(model)).resolves.toBeUndefined();
      await piCompleteSimple(model, {
        messages: [{ role: 'user', content: 'Ping', timestamp: Date.now() }],
      });
      expect(dispatched).toEqual([{
        apiKey: 'enterprise-access',
        baseUrl: 'https://api.enterprise.example.test',
      }]);
    } finally {
      piModels().deleteProvider(model.provider);
    }
  });

  test('concurrent oauth refreshes share the persisted post-refresh credential', async () => {
    await persistOAuthCredential('anthropic', { refresh: 'r0', access: 'a0', expires: 1 });
    let refreshCount = 0;
    oauthRefreshImpl = async () => {
      refreshCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { type: 'oauth', refresh: 'r1', access: 'a1', expires: Date.now() + 10 * 60_000 };
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

      const originalProvider = piModels().getProvider('cloudflare-ai-gateway');
      const model = originalProvider?.getModels()[0];
      if (!model) throw new Error('Missing Cloudflare AI Gateway test model');

      const dispatched: Array<{
        baseUrl: string;
        env?: Record<string, string>;
        headers?: Record<string, string | null>;
      }> = [];
      piModels().setProvider(createProvider({
        id: 'cloudflare-ai-gateway',
        name: 'Cloudflare AI Gateway',
        auth: { apiKey: cloudflareAIGatewayAuth() },
        models: [model],
        api: cloudflareStreams({
          stream: () => { throw new Error('stream should not be called'); },
          streamSimple: (requestModel, _context, options) => {
            dispatched.push({
              baseUrl: requestModel.baseUrl,
              env: options?.env,
              headers: options?.headers,
            });
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
              const message = {
                ...fauxAssistantMessage(fauxText('Cloudflare routed.')),
                api: requestModel.api,
                provider: requestModel.provider,
                model: requestModel.id,
              };
              stream.push({ type: 'start', partial: { ...message, content: [] } });
              stream.push({ type: 'done', reason: 'stop', message });
              stream.end(message);
            });
            return stream;
          },
        }),
      }));

      try {
        const auth = await piModels().getAuth(model);
        expect(auth?.auth.apiKey).toBeUndefined();
        expect(auth?.auth.headers).toMatchObject({ 'cf-aig-authorization': 'Bearer cf-key' });
        expect(auth?.env).toEqual({
          CLOUDFLARE_ACCOUNT_ID: 'cf-account',
          CLOUDFLARE_GATEWAY_ID: 'cf-gateway',
        });

        await piModels().completeSimple(model, {
          messages: [{ role: 'user', content: 'Ping', timestamp: Date.now() }],
        });
        expect(dispatched).toEqual([{
          baseUrl: expect.stringContaining('/cf-account/cf-gateway/'),
          env: {
            CLOUDFLARE_ACCOUNT_ID: 'cf-account',
            CLOUDFLARE_GATEWAY_ID: 'cf-gateway',
          },
          headers: expect.objectContaining({ 'cf-aig-authorization': 'Bearer cf-key' }),
        }]);
        expect(await getProviderApiKey('cloudflare-ai-gateway')).toBeUndefined();
      } finally {
        if (originalProvider) piModels().setProvider(originalProvider);
      }
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

  test('a local connection probe cannot leave a remote custom endpoint on the local sentinel', async () => {
    const savedOpenAIKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = 'env-openai-key';
      ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', modelId: 'proxy-model' });
      ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'http://localhost:1234/v1', modelId: 'proxy-model' });

      const remoteModel = createOpenAICompatibleModel({
        providerId: 'openai',
        modelId: 'proxy-model',
        baseUrl: 'https://proxy.example.com/v1',
      });
      const localModel = createOpenAICompatibleModel({
        providerId: 'openai',
        modelId: 'proxy-model',
        baseUrl: 'http://localhost:1234/v1',
      });

      expect(remoteModel.provider).toBe(piCustomProviderId('openai'));
      expect(localModel.provider).toBe(piCustomProviderId('openai', localModel.baseUrl));
      expect((await piModels().getAuth(remoteModel))?.auth.apiKey).toBe('env-openai-key');
      expect((await piModels().getAuth(localModel))?.auth.apiKey).toBe('local-endpoint');
    } finally {
      restoreEnv('OPENAI_API_KEY', savedOpenAIKey);
    }
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
        tools: [{ type: 'function', name: 'probe', strict: false }],
      }]);
    } finally {
      restoreFetch();
    }
  });

  test('validates an empty dynamic catalog with a previously stored API key', async () => {
    const liveRefreshes = installRadiusConnectionProbeProvider();
    await writeFile(secretPath(), JSON.stringify({
      credentials: { radius: { type: 'api_key', key: 'stored-radius-key' } },
    }));
    const restoreFetch = mockFetchJson(radiusGatewayConfig());
    try {
      await expect(testProviderConnection({ providerId: 'radius' })).resolves.toMatchObject({
        success: true,
        message: 'Connection successful.',
      });
      expect(liveRefreshes()).toBe(0);
      expect(piModels().getModels('radius')).toEqual([]);
    } finally {
      restoreFetch();
    }
  });

  test('testing an unsaved dynamic-provider key leaves live and durable catalogs untouched', async () => {
    const liveRefreshes = installRadiusConnectionProbeProvider();
    const restoreFetch = mockFetchJson(radiusGatewayConfig());
    try {
      await expect(testProviderConnection({
        providerId: 'radius',
        apiKey: 'unsaved-radius-key',
      })).resolves.toMatchObject({ success: true });
      expect(liveRefreshes()).toBe(0);
      expect(piModels().getModels('radius')).toEqual([]);
      await expect(stat(path.join(currentUserData, 'agent-model-catalogs.json'))).rejects.toThrow();
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
