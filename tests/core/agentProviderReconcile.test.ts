import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CC_SWITCH_LOCAL_PROVIDER_ID } from '../../src/core/localGatewayProviders';

// Exercises the provider-config-cleanup Part A startup reconcile: a keyless "junk"
// row (the shape the old main-pane save side effect produced) is pruned and an
// uncredentialed provider is never made active — WITHOUT ever deleting a row from a
// transient/ambient signal (the data-loss findings from the #100 review):
//   - unreadable secrets => prune nothing, write nothing
//   - managed (Bedrock/Vertex) + oauth rows are exempt; ambient env is never consulted

let currentUserData = '';

mock.module('electron', () => ({
  app: { getPath: () => currentUserData },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({ clearStorageData: async () => undefined }),
  },
}));

// Only the OAuth login subpath is faked; provider catalog/auth status comes from
// the real pi Models collection.
mock.module('@earendil-works/pi-ai/oauth', () => ({
  getOAuthProvider: (id: string) =>
    ['anthropic', 'github-copilot', 'openai-codex'].includes(id) ? { id, name: id } : undefined,
}));

const {
  getActiveProviderRuntimeConfig,
  getAgentRuntimeSettings,
  getProviderSettings,
  getProviderRuntimeConfig,
  reconcileProviderConfig,
  setActiveProvider,
  updateImageGenerationSettings,
  upsertProviderConfig,
  ensureProviderConfig,
  setProviderApiKey,
  persistOAuthCredential,
} = await import('../../src/main/agentSettings');

const providerPath = () => path.join(currentUserData, 'agent-providers.json');
const secretPath = () => path.join(currentUserData, 'agent-secrets.json');

interface OnDiskProvider {
  providerId: string;
  baseUrl?: string;
  enabled: boolean;
}

async function writeProviderFileRaw(file: {
  activeProviderId?: string;
  agent?: Record<string, unknown>;
  providers: OnDiskProvider[];
}) {
  await writeFile(providerPath(), `${JSON.stringify(file, null, 2)}\n`);
}

async function readProviderFileRaw(): Promise<{ activeProviderId?: string; providers: OnDiskProvider[] }> {
  return JSON.parse(await readFile(providerPath(), 'utf8'));
}

// Env keys for the providers under test must be ABSENT, or a row would resolve a
// credential from the ambient env. Snapshot + clear + restore.
const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'GOOGLE_CLOUD_API_KEY'];
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

describe('provider config startup reconcile (Part A)', () => {
  test('stores image generation defaults separately from provider connection rows', async () => {
    await updateImageGenerationSettings({ defaultModel: 'google/gemini-3.1-flash-image' });

    const view = await getProviderSettings();
    expect(view.imageGeneration.defaultModel).toBe('google/gemini-3.1-flash-image');
    expect(view.providers).toHaveLength(0);

    await updateImageGenerationSettings({ defaultModel: null });
    expect((await getProviderSettings()).imageGeneration.defaultModel).toBeUndefined();
  });

  test('prunes a keyless junk row and clears the active pointer', async () => {
    // Exactly the bug shape found on disk: an uncredentialed catalog row that was
    // also set active, while it has no usable key.
    await writeProviderFileRaw({
      activeProviderId: 'openai',
      providers: [{ providerId: 'openai', enabled: true }],
    });

    await reconcileProviderConfig();

    const view = await getProviderSettings();
    expect(view.providers).toHaveLength(0);
    expect(view.activeProviderId).toBeUndefined();
    // The cleanup is persisted, not just filtered for the view.
    expect((await readProviderFileRaw()).providers).toHaveLength(0);
  });

  test('a keyless upserted row is pruned and never activated', async () => {
    // An upsert with no credential leaves a keyless row (the read path no longer
    // self-heals); the next startup reconcile removes it instead of leaving a
    // removable-yet-keyless contradiction behind.
    await upsertProviderConfig({ providerId: 'openai', enabled: true });
    await reconcileProviderConfig();

    const view = await getProviderSettings();
    expect(view.providers.find((p) => p.providerId === 'openai')).toBeUndefined();
    expect(view.activeProviderId).toBeUndefined();
  });

  test('a credentialed provider survives and becomes the active provider', async () => {
    // The real config-window order: credential first, then the row.
    await setProviderApiKey('openai', 'sk-test');
    await upsertProviderConfig({ providerId: 'openai', enabled: true });
    await reconcileProviderConfig();

    const view = await getProviderSettings();
    const openai = view.providers.find((p) => p.providerId === 'openai');
    expect(openai).toBeDefined();
    expect(openai?.hasApiKey).toBe(true);
    expect(view.activeProviderId).toBe('openai');
  });

  test('disabling a provider keeps credentials but removes it from active/runtime candidates', async () => {
    await setProviderApiKey('openai', 'sk-openai');
    await setProviderApiKey('anthropic', 'sk-anthropic');
    await upsertProviderConfig({ providerId: 'openai', enabled: true });
    await upsertProviderConfig({ providerId: 'anthropic', enabled: true });
    await setActiveProvider('openai');

    await upsertProviderConfig({ providerId: 'openai', enabled: false });

    const view = await getProviderSettings();
    const openai = view.providers.find((p) => p.providerId === 'openai');
    expect(openai?.enabled).toBe(false);
    expect(openai?.hasApiKey).toBe(true);
    expect(view.activeProviderId).toBeUndefined();
    expect(await getActiveProviderRuntimeConfig()).toMatchObject({
      providerId: 'anthropic',
      enabled: true,
    });
  });

  test('resolves an explicit provider strictly without falling back to the active provider', async () => {
    await setProviderApiKey('openai', 'sk-openai');
    await setProviderApiKey('anthropic', 'sk-anthropic');
    await upsertProviderConfig({ providerId: 'openai', enabled: true });
    await upsertProviderConfig({ providerId: 'anthropic', enabled: true });
    await setActiveProvider('openai');

    expect(await getProviderRuntimeConfig('anthropic')).toMatchObject({
      providerId: 'anthropic',
      enabled: true,
    });
    const anthropicModel = (await getProviderSettings()).availableProviders
      .find((provider) => provider.providerId === 'anthropic')?.models[0]?.id;
    if (!anthropicModel) throw new Error('Missing Anthropic catalog model');
    expect(await getProviderRuntimeConfig('anthropic', anthropicModel)).toMatchObject({
      providerId: 'anthropic',
    });
    expect(await getProviderRuntimeConfig('anthropic', 'retired-model')).toBeNull();

    await upsertProviderConfig({ providerId: 'anthropic', enabled: false });
    expect(await getProviderRuntimeConfig('anthropic')).toBeNull();
    expect(await getActiveProviderRuntimeConfig()).toMatchObject({ providerId: 'openai' });
  });

  test('a disabled provider cannot be set active', async () => {
    await setProviderApiKey('openai', 'sk-openai');
    await upsertProviderConfig({ providerId: 'openai', enabled: false });

    await expect(setActiveProvider('openai')).rejects.toThrow('provider is disabled: openai');
    expect((await getProviderSettings()).activeProviderId).toBeUndefined();
  });

  test('oauth login (credential then ensureProviderConfig) reconciles to active', async () => {
    await persistOAuthCredential('anthropic', { refresh: 'r', access: 'a', expires: 999 });
    await ensureProviderConfig('anthropic');
    await reconcileProviderConfig();

    const view = await getProviderSettings();
    expect(view.providers.find((p) => p.providerId === 'anthropic')).toBeDefined();
    expect(view.activeProviderId).toBe('anthropic');
  });

  test('a keyless row with a local baseUrl is a legit connection and survives', async () => {
    await writeProviderFileRaw({
      providers: [
        { providerId: 'local-llm', baseUrl: 'http://localhost:1234/v1', enabled: true },
      ],
    });

    await reconcileProviderConfig();

    const view = await getProviderSettings();
    expect(view.providers.find((p) => p.providerId === 'local-llm')).toBeDefined();
    // No stored key -> not persisted as active, but the local endpoint is still
    // usable at runtime through the read-path fallback.
    expect(view.activeProviderId).toBeUndefined();
    expect(await getActiveProviderRuntimeConfig()).toMatchObject({
      providerId: 'local-llm',
      baseUrl: 'http://localhost:1234/v1',
      enabled: true,
    });
  });

  test('a CC Switch external-secret row survives startup reconcile', async () => {
    await writeProviderFileRaw({
      activeProviderId: CC_SWITCH_LOCAL_PROVIDER_ID,
      providers: [
        { providerId: CC_SWITCH_LOCAL_PROVIDER_ID, enabled: true },
      ],
    });

    await reconcileProviderConfig();

    expect((await readProviderFileRaw()).providers).toEqual([
      { providerId: CC_SWITCH_LOCAL_PROVIDER_ID, enabled: true },
    ]);
    expect((await readProviderFileRaw()).activeProviderId).toBe(CC_SWITCH_LOCAL_PROVIDER_ID);
  });

  test('a keyless row with a remote baseUrl survives reconcile but is not usable without auth', async () => {
    await writeProviderFileRaw({
      activeProviderId: 'my-proxy',
      providers: [
        { providerId: 'my-proxy', baseUrl: 'https://proxy.example.com/v1', enabled: true },
      ],
    });

    await reconcileProviderConfig();

    const view = await getProviderSettings();
    expect(view.providers.find((p) => p.providerId === 'my-proxy')).toBeDefined();
    expect(view.activeProviderId).toBe('my-proxy');
    expect(await getActiveProviderRuntimeConfig()).toBeNull();
    expect((await readProviderFileRaw()).providers).toEqual([
      { providerId: 'my-proxy', baseUrl: 'https://proxy.example.com/v1', enabled: true },
    ]);
  });

  test('a stale active pointer is repointed to the surviving credentialed provider', async () => {
    await setProviderApiKey('anthropic', 'sk-anthropic');
    await writeProviderFileRaw({
      activeProviderId: 'openai', // junk row, about to be pruned
      providers: [
        { providerId: 'openai', enabled: true },
        { providerId: 'anthropic', enabled: true },
      ],
    });

    await reconcileProviderConfig();

    const view = await getProviderSettings();
    expect(view.providers.map((p) => p.providerId)).toEqual(['anthropic']);
    expect(view.activeProviderId).toBe('anthropic');
  });

  test('unreadable secrets: prunes nothing and never rewrites the provider file', async () => {
    await writeFile(secretPath(), '{not-json');
    await writeProviderFileRaw({
      activeProviderId: 'openai',
      providers: [
        { providerId: 'openai', enabled: true }, // would-be junk
        { providerId: 'anthropic', enabled: true },
      ],
    });
    const before = await readFile(providerPath(), 'utf8');

    await reconcileProviderConfig();

    // Nothing pruned, file byte-for-byte untouched.
    expect(await readFile(providerPath(), 'utf8')).toBe(before);
    expect((await readProviderFileRaw()).providers.map((p) => p.providerId)).toEqual(['openai', 'anthropic']);
  });

  test('managed rows (Bedrock/Vertex) are exempt — never pruned without ambient env', async () => {
    // No AWS/GCP env present (cleared in beforeEach), so auth resolution finds nothing;
    // managed rows must still survive because their credential is always ambient.
    await writeProviderFileRaw({
      providers: [
        { providerId: 'amazon-bedrock', enabled: true },
        { providerId: 'google-vertex', enabled: true },
      ],
    });

    await reconcileProviderConfig();

    expect((await readProviderFileRaw()).providers.map((p) => p.providerId).sort()).toEqual([
      'amazon-bedrock',
      'google-vertex',
    ]);
  });
});
