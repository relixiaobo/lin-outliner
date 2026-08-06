import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OAuthCredential } from '@earendil-works/pi-ai';

// The persisted connection verdict, and specifically the narrowing that keeps it
// honest. `testProviderConnection` does not read a status code off a response —
// it INFERS one by matching the redacted error text (`errMsg.includes('401')`,
// `'unauthorized'`, `'forbidden'`). That is fine for a banner that disappears and
// thin for a verdict that persists: a 500 whose body happens to contain the word
// "unauthorized" would otherwise be written down, durably, as a rejected key.
//
// So only a confident 401/403 may say `rejected`; everything else — timeout,
// offline, 429, 5xx, or an unclassified failure — is `unreachable`, which the UI
// renders as a qualifier on a working state rather than an accusation about the
// credential.

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

const {
  deleteProviderConfig,
  deleteProviderApiKey,
  getProviderSettings,
  persistOAuthCredential,
  prepareProviderConnectionProbe,
  recordProviderConnectionCheck,
  setProviderApiKey,
  upsertProviderConfig,
} = await import('../../src/main/agent/capabilities/agentSettings');
const { piCredentialStore } = await import('../../src/main/piModels');

const ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  currentUserData = await mkdtemp(path.join(tmpdir(), 'lin-provider-check-'));
  savedEnv = {};
  for (const name of ENV_KEYS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(currentUserData, { recursive: true, force: true });
});

async function connectionCheck(providerId: string) {
  const settings = await getProviderSettings();
  return settings.providers.find((provider) => provider.providerId === providerId)?.connectionCheck;
}

describe('provider connection check', () => {
  test('is absent until something probes', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: true });
    expect(await connectionCheck('openai')).toBeUndefined();
  });

  test('a success is recorded as ok', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: true });
    await recordProviderConnectionCheck('openai', { success: true, message: 'Connection successful.' });
    expect((await connectionCheck('openai'))?.outcome).toBe('ok');
  });

  test('only a confident 401/403 is allowed to blame the credential', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: true });

    for (const statusCode of [401, 403]) {
      await recordProviderConnectionCheck('openai', { success: false, statusCode, message: 'Unauthorized' });
      expect((await connectionCheck('openai'))?.outcome).toBe('rejected');
    }

    // Everything else stays unreachable, including the case this narrowing exists
    // for: a server error whose text merely mentions authorization.
    for (const failure of [
      { success: false, statusCode: 500, message: 'Connection failed: 500 unauthorized upstream' },
      { success: false, statusCode: 429, message: 'Rate limited' },
      { success: false, statusCode: 404, message: 'Not Found (404)' },
      { success: false, message: 'Timeout: the request took longer than 8 seconds.' },
      { success: false, message: 'Connection failed: something unclassifiable' },
    ]) {
      await recordProviderConnectionCheck('openai', failure);
      expect((await connectionCheck('openai'))?.outcome).toBe('unreachable');
    }
  });

  test('a credential write clears the verdict, so a rotated key never inherits one', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: true });
    await recordProviderConnectionCheck('openai', { success: false, statusCode: 401 });
    expect((await connectionCheck('openai'))?.outcome).toBe('rejected');

    await recordProviderConnectionCheck('openai', null);
    expect(await connectionCheck('openai')).toBeUndefined();
  });

  test('changing the endpoint drops the verdict; enabling or disabling keeps it', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: true });
    await recordProviderConnectionCheck('openai', { success: true });

    // Same endpoint, different enabled flag: the verdict still describes what was
    // probed.
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: false });
    expect((await connectionCheck('openai'))?.outcome).toBe('ok');

    // A different endpoint is a different connection, so the old answer is stale
    // rather than merely old.
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', enabled: true });
    expect(await connectionCheck('openai')).toBeUndefined();
  });

  test('the automatic probe snapshot carries the stored custom endpoint', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', enabled: true });
    const probe = await prepareProviderConnectionProbe({ providerId: 'openai' });

    expect(probe.input).toEqual({
      providerId: 'openai',
      baseUrl: 'https://proxy.example.com/v1',
    });
    expect(probe.matchesStoredConnection).toBe(true);
  });

  test('endpoint and credential mutations advance the identity and clear the verdict', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', enabled: true });
    await recordProviderConnectionCheck('openai', { success: true });
    const initial = await prepareProviderConnectionProbe({ providerId: 'openai' });

    await setProviderApiKey('openai', 'stored-key');
    const afterKey = await prepareProviderConnectionProbe({ providerId: 'openai' });
    expect(afterKey.connectionGeneration).toBeGreaterThan(initial.connectionGeneration!);
    expect(await connectionCheck('openai')).toBeUndefined();

    await recordProviderConnectionCheck('openai', { success: true });
    await deleteProviderApiKey('openai');
    const afterDelete = await prepareProviderConnectionProbe({ providerId: 'openai' });
    expect(afterDelete.connectionGeneration).toBeGreaterThan(afterKey.connectionGeneration!);
    expect(await connectionCheck('openai')).toBeUndefined();

    await upsertProviderConfig({ providerId: 'anthropic', enabled: true });
    await recordProviderConnectionCheck('anthropic', { success: true });
    const beforeOAuth = await prepareProviderConnectionProbe({ providerId: 'anthropic' });
    await persistOAuthCredential('anthropic', { access: 'access', refresh: 'refresh', expires: 42 });
    const afterOAuth = await prepareProviderConnectionProbe({ providerId: 'anthropic' });
    expect(afterOAuth.connectionGeneration).toBeGreaterThan(beforeOAuth.connectionGeneration!);
    expect(await connectionCheck('anthropic')).toBeUndefined();
  });

  test('an OAuth access-token refresh keeps the verdict it says nothing about', async () => {
    await upsertProviderConfig({ providerId: 'anthropic', enabled: true });
    await persistOAuthCredential('anthropic', { access: 'access-1', refresh: 'refresh-1', expires: 1 });
    await recordProviderConnectionCheck('anthropic', { success: true });
    const connected = await prepareProviderConnectionProbe({ providerId: 'anthropic' });

    // Exactly what pi does on every automatic refresh — same login, new short-lived
    // access token — through the same `modify` hook it uses in production.
    await piCredentialStore().modify('anthropic', async (current) => ({
      ...(current as OAuthCredential),
      access: 'access-2',
      expires: 2,
    }));

    const afterRefresh = await prepareProviderConnectionProbe({ providerId: 'anthropic' });
    expect(afterRefresh.connectionGeneration).toBe(connected.connectionGeneration);
    expect((await connectionCheck('anthropic'))?.outcome).toBe('ok');
  });

  test('a different OAuth login through the same hook does clear the verdict', async () => {
    await upsertProviderConfig({ providerId: 'anthropic', enabled: true });
    await persistOAuthCredential('anthropic', { access: 'access-1', refresh: 'refresh-1', expires: 1 });
    await recordProviderConnectionCheck('anthropic', { success: true });
    const connected = await prepareProviderConnectionProbe({ providerId: 'anthropic' });

    await piCredentialStore().modify('anthropic', async () => ({
      type: 'oauth' as const,
      access: 'access-2',
      refresh: 'refresh-2',
      expires: 2,
    }));

    const afterLogin = await prepareProviderConnectionProbe({ providerId: 'anthropic' });
    expect(afterLogin.connectionGeneration).toBeGreaterThan(connected.connectionGeneration!);
    expect(await connectionCheck('anthropic')).toBeUndefined();
  });

  test('re-upserting the same row with no endpoint keeps the verdict', async () => {
    // What the list's enable switch sends. It used to fall through to the catalog's
    // default Base URL for a row that stores none, which main then read as a new
    // endpoint — so merely flipping the switch discarded a good verdict and wrote in
    // a URL the user never entered.
    await upsertProviderConfig({ providerId: 'openai', enabled: true });
    await recordProviderConnectionCheck('openai', { success: true });
    const connected = await prepareProviderConnectionProbe({ providerId: 'openai' });

    await upsertProviderConfig({ providerId: 'openai', baseUrl: null, enabled: false });
    const afterToggle = await prepareProviderConnectionProbe({ providerId: 'openai' });

    expect(afterToggle.connectionGeneration).toBe(connected.connectionGeneration);
    expect((await connectionCheck('openai'))?.outcome).toBe('ok');
    expect((await getProviderSettings()).providers.find((p) => p.providerId === 'openai')?.baseUrl)
      .toBeUndefined();
  });

  test('a probe from an older connection generation cannot overwrite the new row', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://old.example.com/v1', enabled: true });
    const oldProbe = await prepareProviderConnectionProbe({ providerId: 'openai' });

    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://new.example.com/v1', enabled: true });
    expect(await recordProviderConnectionCheck(
      'openai',
      { success: false, statusCode: 401 },
      oldProbe.connectionGeneration,
    )).toBe(false);
    expect(await connectionCheck('openai')).toBeUndefined();
  });

  test('a probe from a deleted row cannot overwrite a recreated provider', async () => {
    await upsertProviderConfig({ providerId: 'openai', enabled: true });
    const deletedProbe = await prepareProviderConnectionProbe({ providerId: 'openai' });

    await deleteProviderConfig('openai');
    await upsertProviderConfig({ providerId: 'openai', enabled: true });

    expect(await recordProviderConnectionCheck(
      'openai',
      { success: false, statusCode: 401 },
      deletedProbe.connectionGeneration,
    )).toBe(false);
    expect(await connectionCheck('openai')).toBeUndefined();
  });

  test('explicit tests persist only when endpoint and key match the stored connection', async () => {
    await upsertProviderConfig({ providerId: 'openai', baseUrl: 'https://proxy.example.com/v1', enabled: true });
    await setProviderApiKey('openai', 'stored-key');

    const stored = await prepareProviderConnectionProbe({
      providerId: 'openai',
      baseUrl: 'https://proxy.example.com/v1',
      apiKey: 'stored-key',
      baseUrlOverride: true,
      apiKeyOverride: true,
    });
    expect(stored.matchesStoredConnection).toBe(true);

    const unsavedEndpoint = await prepareProviderConnectionProbe({
      providerId: 'openai',
      baseUrl: 'https://other.example.com/v1',
      apiKey: 'stored-key',
      baseUrlOverride: true,
      apiKeyOverride: true,
    });
    expect(unsavedEndpoint.matchesStoredConnection).toBe(false);

    const unsavedKey = await prepareProviderConnectionProbe({
      providerId: 'openai',
      baseUrl: 'https://proxy.example.com/v1',
      apiKey: 'unsaved-key',
      baseUrlOverride: true,
      apiKeyOverride: true,
    });
    expect(unsavedKey.matchesStoredConnection).toBe(false);
  });

  test('clearing a Base URL tests the official endpoint instead of reusing the stored proxy', async () => {
    await upsertProviderConfig({ providerId: 'anthropic', baseUrl: 'https://proxy.example.com/v1', enabled: true });
    const probe = await prepareProviderConnectionProbe({
      providerId: 'anthropic',
      baseUrl: '',
      baseUrlOverride: true,
    });

    expect(probe.input).toEqual({ providerId: 'anthropic' });
    expect(probe.matchesStoredConnection).toBe(false);
  });

  test('recording against a provider with no row is a no-op, not a crash', async () => {
    expect(await recordProviderConnectionCheck('never-configured', { success: true })).toBe(false);
    expect(await connectionCheck('never-configured')).toBeUndefined();
  });
});
