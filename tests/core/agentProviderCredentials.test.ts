import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type StoredOAuth = { refresh: string; access: string; expires: number };

// ── Mutable test controls, read by the module mocks below ──
let currentUserData = '';
let encryptionAvailable = true;
// getOAuthApiKey impl, overridden per test. Mirrors pi-ai's signature:
// (providerId, { [id]: creds }) => { newCredentials, apiKey } | null
let oauthApiKeyImpl: (
  providerId: string,
  creds: Record<string, StoredOAuth>,
) => Promise<{ newCredentials: StoredOAuth; apiKey: string } | null> = async () => null;

// A reversible fake of Electron safeStorage so the encrypted-at-rest path can be
// exercised (file-alone run); in the shared suite the plaintext branch is fine.
const safeStorageMock = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
};

mock.module('electron', () => ({
  app: { getPath: () => currentUserData },
  safeStorage: safeStorageMock,
}));

// Only the oauth subpath is mocked (no other suite imports it, so this can't
// leak into tests that use the real pi-ai). The env / managed fallback is
// exercised through real process.env + the real getEnvApiKey instead.
mock.module('@earendil-works/pi-ai/oauth', () => ({
  getOAuthApiKey: (providerId: string, creds: Record<string, StoredOAuth>) => oauthApiKeyImpl(providerId, creds),
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
  encryptionAvailable = true;
  oauthApiKeyImpl = async () => null;
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
    oauthApiKeyImpl = async () => ({ newCredentials: { refresh: 'r', access: 'a', expires: 10 }, apiKey: 'oauth-key' });
    expect(await getProviderApiKey('anthropic')).toBe('oauth-key');
    expect(await getProviderSecretStatus('anthropic')).toEqual({ providerId: 'anthropic', hasApiKey: false });
  });

  test('oauth credential auto-refreshes and persists the rotated tokens', async () => {
    await persistOAuthCredential('anthropic', { refresh: 'r0', access: 'a0', expires: 1 });
    oauthApiKeyImpl = async () => ({
      newCredentials: { refresh: 'r1', access: 'a1', expires: 999 },
      apiKey: 'fresh-key',
    });
    expect(await getProviderApiKey('anthropic')).toBe('fresh-key');

    // A second resolve must receive the PERSISTED rotated creds, not the originals.
    let seen: StoredOAuth | undefined;
    oauthApiKeyImpl = async (_id, creds) => {
      seen = creds.anthropic;
      return { newCredentials: creds.anthropic, apiKey: 'fresh-key-2' };
    };
    expect(await getProviderApiKey('anthropic')).toBe('fresh-key-2');
    expect(seen).toEqual({ refresh: 'r1', access: 'a1', expires: 999 });
  });

  test('falls back to env / managed sentinel when nothing is stored', async () => {
    const saved = { openai: process.env.OPENAI_API_KEY, aws: process.env.AWS_PROFILE };
    try {
      process.env.OPENAI_API_KEY = 'env-key';
      process.env.AWS_PROFILE = 'test-profile';
      // Real getEnvApiKey: explicit env key for openai, ambient sentinel for bedrock.
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
    oauthApiKeyImpl = async () => {
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
    oauthApiKeyImpl = async () => ({ newCredentials: { refresh: 'r', access: 'a', expires: 5 }, apiKey: 'oauth-k' });
    expect(await getProviderApiKey('anthropic')).toBe('oauth-k');
  });
});

describe('secret file at rest', () => {
  test('persists and round-trips secrets without exposing them in plaintext', async () => {
    await setProviderApiKey('openai', 'sk-secret');
    expect(await getProviderApiKey('openai')).toBe('sk-secret');

    const raw = await readFile(secretPath(), 'utf8');
    const onDisk = JSON.parse(raw) as { enc?: string; credentials?: Record<string, unknown> };
    if (typeof onDisk.enc === 'string') {
      // safeStorage path: the raw blob must not expose the secret.
      expect(raw).not.toContain('sk-secret');
    } else {
      // chmod-600 plaintext fallback (safeStorage unavailable).
      expect(onDisk.credentials?.openai).toEqual({ type: 'api_key', key: 'sk-secret' });
    }
  });

  test('refuses to overwrite an encrypted blob it cannot read (no silent data loss)', async () => {
    await persistOAuthCredential('anthropic', { refresh: 'r', access: 'a', expires: 10 });
    const onDisk = JSON.parse(await readFile(secretPath(), 'utf8')) as { enc?: string };
    if (typeof onDisk.enc !== 'string') return; // only meaningful on the encrypted path
    const before = await readFile(secretPath(), 'utf8');

    // A later launch with the keychain locked / key rotated.
    encryptionAvailable = false;
    // Reads degrade to "no credential" rather than crashing the UI…
    expect(await getProviderApiKey('anthropic')).toBeUndefined();
    // …and a write REFUSES rather than clobbering the unreadable blob.
    await expect(setProviderApiKey('openai', 'sk-new')).rejects.toThrow();
    expect(await readFile(secretPath(), 'utf8')).toBe(before);

    // Once the keychain is back, the original credential is intact.
    encryptionAvailable = true;
    oauthApiKeyImpl = async () => ({ newCredentials: { refresh: 'r', access: 'a', expires: 10 }, apiKey: 'k' });
    expect(await getProviderApiKey('anthropic')).toBe('k');
  });
});
