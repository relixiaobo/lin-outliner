import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * `disabledSkills` is keyed by name over EVERY source, so its length scales with
 * how many Skills a user has rather than with anything they configure. It shared
 * a 20-entry cap with `additionalSkillDirectories`, which silently dropped the
 * 21st disable: the settings write reported success, the reload came back
 * without the entry, the row snapped back on, and the Skill stayed
 * model-invocable despite an explicit off.
 */

let currentUserData = '';

mock.module('electron', () => ({
  app: { getPath: () => currentUserData },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: { fromPartition: () => ({ clearStorageData: async () => undefined }) },
  safeStorage: { isEncryptionAvailable: () => false },
}));

beforeEach(async () => {
  currentUserData = await mkdtemp(path.join(tmpdir(), 'lin-runtime-settings-'));
});

afterEach(async () => {
  await rm(currentUserData, { recursive: true, force: true });
});

async function settingsModule() {
  return import('../../src/main/agent/capabilities/agentSettings');
}

describe('agent runtime settings limits', () => {
  test('keeps delegation experimental and internal-only by default', async () => {
    const { getAgentDelegationConfiguration } = await settingsModule();
    const configuration = await getAgentDelegationConfiguration();

    expect(configuration.settings).toEqual({
      enabled: false,
      defaultRunnerId: 'internal',
      maxConcurrentGlobal: 8,
      maxConcurrentThread: 4,
      maxQueuedGlobal: 32,
      maxQueuedThread: 8,
      runners: {
        internal: {
          enabled: true,
          model: null,
          effort: null,
          maximumAccess: 'workspace-write',
          timeoutMs: 3_600_000,
          maxConcurrent: 4,
          pool: 'agent-provider',
          maxConcurrentPool: 4,
        },
      },
    });
    expect(configuration.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  test('deep-merges delegation updates and changes revision only with effective policy', async () => {
    const {
      delegationConfigurationRevision,
      getAgentDelegationConfiguration,
      updateAgentRuntimeSettings,
    } = await settingsModule();
    const initial = await getAgentDelegationConfiguration();

    await updateAgentRuntimeSettings({
      delegation: {
        enabled: true,
        runners: { internal: { model: 'openai/gpt-test' } },
      },
    });
    await updateAgentRuntimeSettings({
      delegation: {
        runners: { internal: { effort: 'medium' } },
      },
    });

    const updated = await getAgentDelegationConfiguration();
    expect(updated.settings.enabled).toBe(true);
    expect(updated.settings.runners.internal).toMatchObject({
      model: 'openai/gpt-test',
      effort: 'medium',
      timeoutMs: 3_600_000,
    });
    expect(updated.revision).not.toBe(initial.revision);
    expect(delegationConfigurationRevision(structuredClone(updated.settings))).toBe(updated.revision);
  });

  test('normalizes unsafe delegation settings without enabling unknown Runners', async () => {
    const { getAgentRuntimeSettings } = await settingsModule();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(currentUserData, 'agent-providers.json'), `${JSON.stringify({
      agent: {
        delegation: {
          enabled: 'yes',
          defaultRunnerId: '../claude',
          maxConcurrentGlobal: 65,
          maxConcurrentThread: 64,
          maxQueuedGlobal: 1_025,
          maxQueuedThread: 129,
          runners: {
            '../claude': { enabled: true },
            claude: {
              enabled: true,
              model: '  claude/model  ',
              effort: 'impossible',
              maximumAccess: 'full-disk',
              timeoutMs: 1,
              maxConcurrent: 0,
              pool: '../shared',
              maxConcurrentPool: 0,
            },
          },
        },
      },
      providers: [],
    }, null, 2)}\n`);

    const delegation = (await getAgentRuntimeSettings()).delegation;
    expect(delegation.enabled).toBe(false);
    expect(delegation.defaultRunnerId).toBe('internal');
    expect(delegation.maxConcurrentGlobal).toBe(8);
    expect(delegation.maxConcurrentThread).toBe(64);
    expect(delegation.maxQueuedGlobal).toBe(32);
    expect(delegation.maxQueuedThread).toBe(8);
    expect(delegation.runners['../claude']).toBeUndefined();
    expect(delegation.runners.claude).toEqual({
      enabled: true,
      model: 'claude/model',
      effort: null,
      maximumAccess: 'read-only',
      timeoutMs: 3_600_000,
      maxConcurrent: 4,
      pool: 'claude',
      maxConcurrentPool: 4,
    });
    expect(delegation.runners.internal?.enabled).toBe(true);
  });

  test('keeps far more than twenty disabled skills', async () => {
    const { getAgentRuntimeSettings, updateAgentRuntimeSettings } = await settingsModule();
    const names = Array.from({ length: 120 }, (_, index) => `skill-${index}`);

    await updateAgentRuntimeSettings({ disabledSkills: names });

    expect((await getAgentRuntimeSettings()).disabledSkills).toEqual(names);
  });

  test('keeps a disable appended past the twentieth entry', async () => {
    const { getAgentRuntimeSettings, updateAgentRuntimeSettings } = await settingsModule();
    const existing = Array.from({ length: 20 }, (_, index) => `skill-${index}`);
    await updateAgentRuntimeSettings({ disabledSkills: existing });

    // The library appends the newly disabled name at the end, which is exactly
    // the position a 20-entry cap discarded.
    await updateAgentRuntimeSettings({ disabledSkills: [...existing, 'twenty-first'] });

    expect((await getAgentRuntimeSettings()).disabledSkills).toContain('twenty-first');
  });

  test('still bounds the directories the loader has to scan', async () => {
    const { getAgentRuntimeSettings, updateAgentRuntimeSettings } = await settingsModule();
    const directories = Array.from({ length: 40 }, (_, index) => `/tmp/skills-${index}`);

    await updateAgentRuntimeSettings({ additionalSkillDirectories: directories });

    // Each bound directory is scanned on every registry refresh, so this list
    // stays deliberately small — unlike disabledSkills.
    expect((await getAgentRuntimeSettings()).additionalSkillDirectories).toHaveLength(20);
  });

  test('a partial update leaves the other lists intact', async () => {
    const { getAgentRuntimeSettings, updateAgentRuntimeSettings } = await settingsModule();
    await updateAgentRuntimeSettings({
      additionalSkillDirectories: ['/tmp/skills'],
      disabledSkills: ['alpha'],
    });

    await updateAgentRuntimeSettings({ disabledSkills: ['alpha', 'beta'] });

    const settings = await getAgentRuntimeSettings();
    expect(settings.additionalSkillDirectories).toEqual(['/tmp/skills']);
    expect(settings.disabledSkills).toEqual(['alpha', 'beta']);
  });
});
