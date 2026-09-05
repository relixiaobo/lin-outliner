import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_FILE_PREFERENCES,
  filePreferencesPath,
  loadFilePreferences,
  updateFilePreferences,
  writeFilePreferences,
} from '../../src/main/configuration/filePreferences';
import { writeFilePreferencesStatus } from '../../src/main/configuration/status';

let userData = '';

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'tenon-file-prefs-'));
  await mkdir(path.dirname(filePreferencesPath(userData)), { recursive: true });
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('file-backed preferences', () => {
  test('returns defaults for a missing source', () => {
    const result = loadFilePreferences(userData);
    expect(result.sourceStatus).toBe('missing');
    expect(result.preferences).toEqual(DEFAULT_FILE_PREFERENCES);
    expect(result.sourceDigest).toBeNull();
  });

  test('retains the accepted digest when a later source is rejected', async () => {
    const accepted = '{ "appearance": { "theme": "dark" } }';
    await writeFile(filePreferencesPath(userData), accepted);
    const acceptedResult = loadFilePreferences(userData);
    await writeFile(filePreferencesPath(userData), '{ invalid');

    const rejected = loadFilePreferences(userData);
    expect(rejected.sourceStatus).toBe('rejected');
    expect(rejected.preferences.appearance.theme).toBe('dark');
    expect(rejected.acceptedDigest).toBe(acceptedResult.sourceDigest);
  });

  test('accepts JSONC comments and trailing commas', async () => {
    await writeFile(filePreferencesPath(userData), `{
      // Keep this comment when the syntax-tree writer is used.
      "appearance": { "theme": "dark", "language": "zh-Hans", },
      "agent": { "memory": { "enabled": false } },
    }`);
    const result = loadFilePreferences(userData);
    expect(result.sourceStatus).toBe('accepted');
    expect(result.preferences.appearance.theme).toBe('dark');
    expect(result.preferences.appearance.language).toBe('zh-Hans');
    expect(result.preferences.agent.memory.enabled).toBe(false);
    expect(result.preferences.agent.provider.maxRetryDelayMs).toBe(60_000);
  });

  test('rejects unknown keys without changing the source', async () => {
    const source = '{ "appearance": { "theme": "dark", "typo": true } }';
    await writeFile(filePreferencesPath(userData), source);
    const result = loadFilePreferences(userData);
    expect(result.sourceStatus).toBe('rejected');
    expect(result.sourceBytes).toBe(source);
    expect(result.preferences).toEqual(DEFAULT_FILE_PREFERENCES);
    expect(result.error).toContain('typo is not supported');
  });

  test('rejects duplicate keys and preserves comma-like string values', async () => {
    const duplicate = '{ "appearance": { "theme": "dark", "theme": "light" } }';
    await writeFile(filePreferencesPath(userData), duplicate);
    expect(loadFilePreferences(userData).sourceStatus).toBe('rejected');

    const valid = '{ "agent": { "skills": { "sources": [", }"] } } }';
    await writeFile(filePreferencesPath(userData), valid);
    const result = loadFilePreferences(userData);
    expect(result.sourceStatus).toBe('accepted');
    expect(result.preferences.agent.skills.sources).toEqual([', }']);
  });

  test('writes an atomic public source and reloads it', async () => {
    const next = {
      ...DEFAULT_FILE_PREFERENCES,
      appearance: { theme: 'light' as const, language: 'en' },
    };
    writeFilePreferences(userData, next);
    const raw = await readFile(filePreferencesPath(userData), 'utf8');
    expect(raw).toContain('"theme": "light"');
    expect(loadFilePreferences(userData).preferences.appearance).toEqual(next.appearance);
  });

  test('updates one field while preserving JSONC comments and unrelated keys', async () => {
    const source = `{
      // User-maintained settings should survive host writes.
      "appearance": { "theme": "system", "language": null },
      "agent": { "provider": { "cacheRetention": "short" } },
      "updates": { "checkAutomatically": false }
    }`;
    await writeFile(filePreferencesPath(userData), source);

    updateFilePreferences(userData, [{ path: ['appearance', 'theme'], value: 'dark' }]);

    const updated = await readFile(filePreferencesPath(userData), 'utf8');
    expect(updated).toContain('// User-maintained settings should survive host writes.');
    expect(updated).toContain('"checkAutomatically": false');
    expect(loadFilePreferences(userData).preferences.appearance.theme).toBe('dark');
  });

  test('does not overwrite a rejected source through field updates', async () => {
    const source = '{ "appearance": { "theme": "dark", "unsupported": true } }';
    await writeFile(filePreferencesPath(userData), source);

    expect(() => updateFilePreferences(userData, [{ path: ['appearance', 'theme'], value: 'light' }])).toThrow();
    expect(await readFile(filePreferencesPath(userData), 'utf8')).toBe(source);
  });

  test('creates settings from a missing source with a nested update', async () => {
    updateFilePreferences(userData, [{ path: ['appearance', 'theme'], value: 'dark' }]);

    expect(loadFilePreferences(userData).preferences.appearance.theme).toBe('dark');
  });

  test('accepts global Skill sources and tool disablement', async () => {
    await writeFile(filePreferencesPath(userData), JSON.stringify({
      agent: {
        skills: { sources: ['/tmp/skills'], disabled: ['configuration'] },
        tools: { disabled: ['bash'] },
      },
    }));
    const result = loadFilePreferences(userData);
    expect(result.preferences.agent.skills.sources).toEqual(['/tmp/skills']);
    expect(result.preferences.agent.skills.disabled).toEqual(['configuration']);
    expect(result.preferences.agent.tools.disabled).toEqual(['bash']);
  });

  test('writes bounded host status with the accepted source digest', async () => {
    const loaded = loadFilePreferences(userData);
    const status = writeFilePreferencesStatus(userData, 'host-test', loaded);
    expect(status.hostSessionId).toBe('host-test');
    expect(status.source.status).toBe('missing');
    expect(status.source.observedDigest).toBeNull();
    expect(await readFile(path.join(userData, 'config', 'status.json'), 'utf8')).toContain('host-test');
  });
});
