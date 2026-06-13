import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let userData = '';

mock.module('electron', () => ({
  app: { getPath: () => userData },
}));

const {
  flushAppPreferenceWrites,
  loadAppPreferences,
  resetAppPreferencesForTests,
  saveLanguagePreference,
  saveOsNotificationsPreference,
  saveThemePreference,
} = await import('../../src/main/appPreferences');

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'tenon-prefs-'));
  resetAppPreferencesForTests();
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('app preferences persistence', () => {
  test('keeps sync reads and async atomic writes byte-compatible', async () => {
    saveThemePreference('dark');
    saveLanguagePreference('zh-Hans');
    saveOsNotificationsPreference(true);
    await flushAppPreferenceWrites();

    const raw = await readFile(path.join(userData, 'app-preferences.json'), 'utf8');
    expect(raw).toBe('{"theme":"dark","language":"zh-Hans","osNotificationsEnabled":true}');
    expect(loadAppPreferences()).toEqual({
      theme: 'dark',
      language: 'zh-Hans',
      osNotificationsEnabled: true,
    });
  });
});
