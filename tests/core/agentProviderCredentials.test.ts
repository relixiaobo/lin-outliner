import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createAssistantMessageEventStream, createProvider, fauxAssistantMessage, fauxText, type OAuthCredential } from '@earendil-works/pi-ai';
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

type StoredOAuth = { refresh: string; access: string; expires: number };

// ── Mutable test controls, read by the module mocks below ──
let currentUserData = '';
let oauthRefreshImpl: (credential: OAuthCredential) => Promise<OAuthCredential> = async (credential) => credential;
let oauthToApiKeyImpl: (credential: OAuthCredential) => Promise<string> = async (credential) => credential.access;

mock.module('electron', () => ({
  app: { getPath: () => currentUserData },
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
  getProviderSecretStatus,
  persistOAuthCredential,
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
  piModels().deleteProvider(piCustomProviderId('openai'));
  await rm(currentUserData, { recursive: true, force: true });
});

describe('provider credential resolver', () => {
  test('stored api key resolves and reports as a stored key', async () => {
    await setProviderApiKey('openai', '  sk-test  ');
    expect(await getProviderApiKey('openai')).toBe('sk-test');
    expect(await getProviderSecretStatus('openai')).toEqual({ providerId: 'openai', hasApiKey: true });
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

  test('custom OpenAI-compatible provider registration updates when base URL changes', () => {
    ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'http://localhost:1234/v1', modelId: 'proxy-model' });
    ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', modelId: 'proxy-model' });

    const models = piModels().getModels(piCustomProviderId('openai'));
    expect(models.some((model) => model.id === 'proxy-model' && model.baseUrl === 'http://localhost:1234/v1')).toBe(true);
    expect(models.some((model) => model.id === 'proxy-model' && model.baseUrl === 'https://proxy.example.com/v1')).toBe(true);
  });

  test('custom OpenAI-compatible providers allow keyless local endpoints only', async () => {
    ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'http://localhost:1234/v1', modelId: 'local-model' });
    ensurePiCustomProvider({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', modelId: 'remote-model' });

    const localAuth = await piModels().getAuth(createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'local-model',
      baseUrl: 'http://localhost:1234/v1',
    }));
    expect(localAuth?.auth.apiKey).toBe('local-endpoint');

    const remoteAuth = await piModels().getAuth(createOpenAICompatibleModel({
      providerId: 'openai',
      modelId: 'remote-model',
      baseUrl: 'https://proxy.example.com/v1',
    }));
    expect(remoteAuth).toBeUndefined();
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
});
