import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createProvider, type OAuthCredential } from '@earendil-works/pi-ai';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { piModels } from '../../src/main/piModels';

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

  test('falls back to env / managed sentinel when nothing is stored', async () => {
    const saved = { openai: process.env.OPENAI_API_KEY, aws: process.env.AWS_PROFILE };
    try {
      process.env.OPENAI_API_KEY = 'env-key';
      process.env.AWS_PROFILE = 'test-profile';
      // Real pi auth resolution: explicit env key for openai, ambient sentinel for bedrock.
      expect(await getProviderApiKey('openai')).toBe('env-key');
      expect(await getProviderApiKey('amazon-bedrock')).toBe('<authenticated>');
      expect(await getProviderApiKey('definitely-not-a-provider')).toBeUndefined();
    } finally {
      restoreEnv('OPENAI_API_KEY', saved.openai);
      restoreEnv('AWS_PROFILE', saved.aws);
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
});
