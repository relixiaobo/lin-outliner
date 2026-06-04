import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Exercises the provider-config-cleanup Part A reconcile: a keyless "junk" row
// (the shape the old main-pane save side effect produced) is pruned on load and an
// uncredentialed provider is never made active, while a credentialed provider
// survives and is auto-activated when none is active.

let currentUserData = '';
const encryptionAvailable = true;

const safeStorageMock = {
  isEncryptionAvailable: () => encryptionAvailable,
  encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
  decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
};

mock.module('electron', () => ({
  app: { getPath: () => currentUserData },
  safeStorage: safeStorageMock,
}));

// Mirror the credential suite: only the oauth subpath is faked; the real pi-ai
// (getProviders / getModels / getEnvApiKey) drives catalog + env lookups.
mock.module('@earendil-works/pi-ai/oauth', () => ({
  getOAuthApiKey: async () => null,
  getOAuthProvider: (id: string) =>
    ['anthropic', 'github-copilot', 'openai-codex'].includes(id) ? { id, name: id } : undefined,
}));

const {
  getProviderSettings,
  upsertProviderConfig,
  ensureProviderConfig,
  setProviderApiKey,
  persistOAuthCredential,
} = await import('../../src/main/agentSettings');

const providerPath = () => path.join(currentUserData, 'agent-providers.json');

interface OnDiskProvider {
  providerId: string;
  modelId: string;
  reasoningLevel: string;
  baseUrl?: string;
  enabled: boolean;
}

async function writeProviderFileRaw(file: {
  activeProviderId?: string;
  providers: OnDiskProvider[];
}) {
  await writeFile(providerPath(), `${JSON.stringify(file, null, 2)}\n`);
}

async function readProviderFileRaw(): Promise<{ activeProviderId?: string; providers: OnDiskProvider[] }> {
  return JSON.parse(await readFile(providerPath(), 'utf8'));
}

// Env keys for the providers under test must be ABSENT, or a row would resolve a
// credential from the ambient env and never be pruned. Snapshot + clear + restore.
const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  currentUserData = await mkdtemp(path.join(tmpdir(), 'lin-provider-reconcile-'));
  savedEnv = {};
  for (const name of ENV_KEYS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const name of ENV_KEYS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await rm(currentUserData, { recursive: true, force: true });
});

describe('provider settings reconcile (Part A)', () => {
  test('prunes a keyless junk row and clears the active pointer on load', async () => {
    // Exactly the bug shape found on disk: an uncredentialed catalog row that was
    // also set active, while it has no usable key.
    await writeProviderFileRaw({
      activeProviderId: 'openai',
      providers: [{ providerId: 'openai', modelId: 'gpt-5.5', reasoningLevel: 'off', enabled: true }],
    });

    const view = await getProviderSettings();
    expect(view.providers).toHaveLength(0);
    expect(view.activeProviderId).toBeUndefined();

    // The cleanup is persisted, not just filtered for the view.
    expect((await readProviderFileRaw()).providers).toHaveLength(0);
  });

  test('save-with-no-key creates no persisted row and never activates it', async () => {
    // The config window writes the key BEFORE the row; an upsert with no credential
    // (the user saved without entering a key) must not leave a keyless row behind.
    const view = await upsertProviderConfig({
      providerId: 'openai',
      modelId: 'gpt-4o',
      reasoningLevel: 'off',
      enabled: true,
    });
    expect(view.providers.find((p) => p.providerId === 'openai')).toBeUndefined();
    expect(view.activeProviderId).toBeUndefined();
  });

  test('a credentialed provider survives and becomes the active provider', async () => {
    // The reorder: credential first, then the row — the real config-window order.
    await setProviderApiKey('openai', 'sk-test');
    const view = await upsertProviderConfig({
      providerId: 'openai',
      modelId: 'gpt-4o',
      reasoningLevel: 'off',
      enabled: true,
    });
    const openai = view.providers.find((p) => p.providerId === 'openai');
    expect(openai).toBeDefined();
    expect(openai?.hasApiKey).toBe(true);
    expect(view.activeProviderId).toBe('openai');
  });

  test('oauth login (credential then ensureProviderConfig) activates the provider', async () => {
    await persistOAuthCredential('anthropic', { refresh: 'r', access: 'a', expires: 999 });
    await ensureProviderConfig('anthropic');

    const view = await getProviderSettings();
    const anthropic = view.providers.find((p) => p.providerId === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(view.activeProviderId).toBe('anthropic');
  });

  test('a keyless row with a local baseUrl is a legit connection and survives', async () => {
    await writeProviderFileRaw({
      providers: [
        { providerId: 'local-llm', modelId: 'my-model', reasoningLevel: 'off', baseUrl: 'http://localhost:1234/v1', enabled: true },
      ],
    });

    const view = await getProviderSettings();
    expect(view.providers.find((p) => p.providerId === 'local-llm')).toBeDefined();
    // No stored/env key → not auto-activated, but the row is kept.
    expect(view.activeProviderId).toBeUndefined();
  });

  test('a stale active pointer is repointed to the surviving credentialed provider', async () => {
    await setProviderApiKey('anthropic', 'sk-anthropic');
    await writeProviderFileRaw({
      activeProviderId: 'openai', // junk row, about to be pruned
      providers: [
        { providerId: 'openai', modelId: 'gpt-5.5', reasoningLevel: 'off', enabled: true },
        { providerId: 'anthropic', modelId: 'claude-haiku-4-5', reasoningLevel: 'off', enabled: true },
      ],
    });

    const view = await getProviderSettings();
    expect(view.providers.map((p) => p.providerId)).toEqual(['anthropic']);
    expect(view.activeProviderId).toBe('anthropic');
  });
});
