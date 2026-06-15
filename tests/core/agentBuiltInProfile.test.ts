import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The settings-owned model/effort overlay for a built-in agent definition
// (provider-connection-model-ownership #256): built-in definitions are read-only
// code, so the user's model/effort choice for them lives in `builtInAgentProfiles`
// in agent-providers.json. This pins the round-trip + the clear/coerce semantics
// that the Settings → Agents Save relies on (the one path with no e2e coverage).

let currentUserData = '';

mock.module('electron', () => ({
  app: { getPath: () => currentUserData },
}));

// Mirror the provider-reconcile suite: only the oauth subpath is faked so importing
// agentSettings never reaches the network; the profile API itself is pure local fs.
mock.module('@earendil-works/pi-ai/oauth', () => ({
  getOAuthApiKey: async () => null,
  getOAuthProvider: (id: string) =>
    ['anthropic', 'github-copilot', 'openai-codex'].includes(id) ? { id, name: id } : undefined,
}));

const { getBuiltInAgentProfile, setBuiltInAgentProfile } = await import('../../src/main/agentSettings');

const providerPath = () => path.join(currentUserData, 'agent-providers.json');

async function readBuiltInProfiles(): Promise<Record<string, { model?: string; effort?: string }>> {
  const file = JSON.parse(await readFile(providerPath(), 'utf8')) as {
    builtInAgentProfiles?: Record<string, { model?: string; effort?: string }>;
  };
  return file.builtInAgentProfiles ?? {};
}

beforeEach(async () => {
  currentUserData = await mkdtemp(path.join(tmpdir(), 'lin-builtin-profile-'));
});

afterEach(async () => {
  await rm(currentUserData, { recursive: true, force: true });
});

describe('built-in agent profile overlay', () => {
  test('an unset agent returns an empty profile (falls back to the catalog default)', async () => {
    expect(await getBuiltInAgentProfile('assistant')).toEqual({});
  });

  test('round-trips a model + effort and persists them keyed by agentId', async () => {
    await setBuiltInAgentProfile('assistant', { model: 'openai/gpt-5.4', effort: 'high' });

    expect(await getBuiltInAgentProfile('assistant')).toEqual({ model: 'openai/gpt-5.4', effort: 'high' });
    expect(await readBuiltInProfiles()).toEqual({ assistant: { model: 'openai/gpt-5.4', effort: 'high' } });
  });

  test('separate agentIds keep independent overlays', async () => {
    await setBuiltInAgentProfile('assistant', { model: 'openai/gpt-5.4', effort: 'high' });
    await setBuiltInAgentProfile('researcher', { model: 'anthropic/claude', effort: 'low' });

    expect(await getBuiltInAgentProfile('assistant')).toEqual({ model: 'openai/gpt-5.4', effort: 'high' });
    expect(await getBuiltInAgentProfile('researcher')).toEqual({ model: 'anthropic/claude', effort: 'low' });
  });

  test('an empty/`inherit` model clears just the model field', async () => {
    await setBuiltInAgentProfile('assistant', { model: 'openai/gpt-5.4', effort: 'high' });

    await setBuiltInAgentProfile('assistant', { model: 'inherit', effort: 'high' });
    expect(await getBuiltInAgentProfile('assistant')).toEqual({ effort: 'high' });

    await setBuiltInAgentProfile('assistant', { model: '', effort: 'high' });
    expect(await getBuiltInAgentProfile('assistant')).toEqual({ effort: 'high' });
  });

  test('an unset/invalid effort is dropped, never persisted as a divergent value', async () => {
    // A bogus level is rejected outright …
    await setBuiltInAgentProfile('assistant', { model: 'openai/gpt-5.4', effort: 'turbo' });
    expect(await getBuiltInAgentProfile('assistant')).toEqual({ model: 'openai/gpt-5.4' });

    // … and a model-only update leaves no stale effort behind.
    await setBuiltInAgentProfile('assistant', { model: 'openai/gpt-5.4', effort: null });
    expect(await getBuiltInAgentProfile('assistant')).toEqual({ model: 'openai/gpt-5.4' });
  });

  test('clearing both fields removes the agent entry entirely', async () => {
    await setBuiltInAgentProfile('assistant', { model: 'openai/gpt-5.4', effort: 'high' });

    await setBuiltInAgentProfile('assistant', { model: null, effort: null });
    expect(await getBuiltInAgentProfile('assistant')).toEqual({});
    expect(await readBuiltInProfiles()).toEqual({});
  });
});
