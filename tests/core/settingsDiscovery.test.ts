import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editPreference, readPreferencesView } from '../../src/main/configuration/discovery';
import { loadFilePreferences, updateFilePreferences } from '../../src/main/configuration/filePreferences';
import { writeFilePreferencesStatus } from '../../src/main/configuration/status';
import { PreferencesApplication } from '../../src/main/configuration/application';
import { DEFAULT_FILE_PREFERENCES } from '../../src/core/filePreferences';
import { PREFERENCE_DEFINITIONS, preferenceDefault, preferenceSchema, validatePreference } from '../../src/core/settingsDefinitions';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function source(bytes?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tenon-settings-')); dirs.push(dir);
  mkdirSync(join(dir, 'config'));
  if (bytes !== undefined) writeFileSync(join(dir, 'config/settings.jsonc'), bytes);
  return dir;
}

describe('preference source discovery', () => {
  test('explicit defaults are modified and Reset preserves comments and unrelated overrides', () => {
    const dir = source('{\n // keep this\n "appearance": {"theme":"system"}, "updates":{"checkAutomatically":false}\n}');
    const view = readPreferencesView(dir, 'host');
    expect(view.entries.find((entry) => entry.id === 'appearance.theme')?.modified).toBe(true);
    editPreference(dir, { id: 'appearance.theme', operation: 'reset', expectedDigest: view.source.digest });
    expect(readFileSync(join(dir, 'config/settings.jsonc'), 'utf8')).toContain('// keep this');
    const after = readPreferencesView(dir, 'host');
    expect(after.entries.find((entry) => entry.id === 'appearance.theme')).toMatchObject({ value: 'system', modified: false });
    expect(after.entries.find((entry) => entry.id === 'updates.checkAutomatically')).toMatchObject({ value: false, modified: true });
  });
  test('stale and malformed edits leave the current bytes untouched', () => {
    const dir = source('{}'); const digest = readPreferencesView(dir, 'host').source.digest;
    const path = join(dir, 'config/settings.jsonc'); writeFileSync(path, '{"appearance":{"theme":"dark"}}');
    expect(() => editPreference(dir, { id: 'appearance.theme', operation: 'set', value: 'light', expectedDigest: digest })).toThrow('changed');
    writeFileSync(path, '{broken');
    expect(() => editPreference(dir, { id: 'appearance.theme', operation: 'reset', expectedDigest: readPreferencesView(dir, 'host').source.digest })).toThrow('rejected');
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
  test('deleting the source returns defaults without attributing the old accepted digest', () => {
    const dir = source('{"appearance":{"theme":"dark"}}'); readPreferencesView(dir, 'host');
    rmSync(join(dir, 'config/settings.jsonc'));
    const view = readPreferencesView(dir, 'host');
    expect(view.source).toMatchObject({ status: 'missing', digest: null, acceptedDigest: null });
    expect(view.entries.find((entry) => entry.id === 'appearance.theme')).toMatchObject({ value: 'system', modified: false });
  });
  test('the same scalar definitions validate defaults, schemas and structural writes', () => {
    for (const definition of PREFERENCE_DEFINITIONS) {
      expect(() => validatePreference(definition, preferenceDefault(definition.id))).not.toThrow();
      expect(preferenceSchema(definition)).toMatchObject({ default: preferenceDefault(definition.id) });
    }
    const dir = source('{}');
    expect(() => updateFilePreferences(dir, [{ path: ['agent', 'provider', 'maxRetries'], value: -1 }])).toThrow();
    expect(() => updateFilePreferences(dir, [{ path: ['agent', 'delegation', 'maxConcurrentGlobal'], value: 65 }])).toThrow();
    expect(() => updateFilePreferences(dir, [{ path: ['agent', 'provider', 'timeoutMs'], value: 0 }])).toThrow();
    expect(readFileSync(join(dir, 'config/settings.jsonc'), 'utf8')).toBe('{}');
  });
  test('one application failure retains only that owner and status from another Host cannot prove application', async () => {
    const dir = source('{"appearance":{"theme":"dark"},"agent":{"memory":{"enabled":false}}}');
    const loaded = loadFilePreferences(dir); const owner = new PreferencesApplication();
    await owner.apply(loaded.preferences, loaded.sourceDigest, { memory: () => { throw new Error('Memory unavailable'); } }, () => undefined);
    expect(owner.effective.appearance.theme).toBe('dark');
    expect(owner.effective.agent.memory.enabled).toBe(DEFAULT_FILE_PREFERENCES.agent.memory.enabled);
    expect(owner.states.memory?.status).toBe('failed');
    writeFilePreferencesStatus(dir, 'previous', loaded, { effective: owner.effective, domains: owner.states, applicationStatus: 'failed' });
    expect(readPreferencesView(dir, 'next').application.status).toBe('pending');
    writeFileSync(join(dir, 'config/status.json'), JSON.stringify({ hostSessionId: 'previous', application: { status: 'applied' } }));
    const view = readPreferencesView(dir, 'previous');
    expect(view.application.status).toBe('failed');
    expect(view.entries.find((entry) => entry.id === 'agent.memory.enabled')).toMatchObject({ value: false, effectiveValue: true, application: { status: 'failed' } });
  });
});
