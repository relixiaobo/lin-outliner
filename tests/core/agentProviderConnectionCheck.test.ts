import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  getProviderSettings,
  recordProviderConnectionCheck,
  upsertProviderConfig,
} = await import('../../src/main/agent/capabilities/agentSettings');

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

  test('recording against a provider with no row is a no-op, not a crash', async () => {
    await recordProviderConnectionCheck('never-configured', { success: true });
    expect(await connectionCheck('never-configured')).toBeUndefined();
  });
});
