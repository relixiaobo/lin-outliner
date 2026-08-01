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
