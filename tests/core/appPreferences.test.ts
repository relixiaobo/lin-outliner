import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let userData = '';

mock.module('electron', () => ({
  app: { getPath: () => userData },
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
  loadAppPreferences,
  resetAppPreferencesForTests,
  saveLastAgentThreadConfiguration,
  saveLanguagePreference,
  saveThemePreference,
  saveTranslationLanguagePreference,
  saveUrlPageTranslationPreferences,
} = await import('../../src/main/appPreferences');

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'tenon-prefs-'));
  resetAppPreferencesForTests();
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('app preferences persistence', () => {
  test('keeps sync reads and sync atomic writes byte-compatible', async () => {
    saveThemePreference('dark');
    saveLanguagePreference('zh-Hans');
    saveTranslationLanguagePreference('ja');
    saveUrlPageTranslationPreferences({
      translationModel: 'openai/gpt-4.1-mini',
      autoTranslateEpubs: true,
      autoTranslateUrls: true,
    });

    const raw = await readFile(path.join(userData, 'app-preferences.json'), 'utf8');
    expect(raw).toBe('{"theme":"dark","language":"zh-Hans","translationLanguage":"ja","translationModel":"openai/gpt-4.1-mini","autoTranslateUrls":true,"autoTranslateEpubs":true,"lastAgentThreadConfiguration":null}');
    expect(loadAppPreferences()).toEqual({
      theme: 'dark',
      language: 'zh-Hans',
      translationLanguage: 'ja',
      translationModel: 'openai/gpt-4.1-mini',
      autoTranslateUrls: true,
      autoTranslateEpubs: true,
      lastAgentThreadConfiguration: null,
    });
  });

  test('persists the last Agent Thread execution selection', () => {
    const selection = {
      modelProvider: 'anthropic',
      model: 'anthropic/claude-sonnet-4',
      reasoningEffort: 'high',
    } as const;

    saveLastAgentThreadConfiguration(selection);
    resetAppPreferencesForTests();

    expect(loadAppPreferences().lastAgentThreadConfiguration).toEqual(selection);
  });

  test('ignores an invalid persisted Agent Thread execution selection', async () => {
    await writeFile(
      path.join(userData, 'app-preferences.json'),
      JSON.stringify({
        theme: 'system',
        language: null,
        translationLanguage: null,
        lastAgentThreadConfiguration: {
          modelProvider: 'openai',
          model: 'openai/gpt-5',
          reasoningEffort: 'turbo',
        },
      }),
    );
    resetAppPreferencesForTests();

    expect(loadAppPreferences().lastAgentThreadConfiguration).toBeNull();
  });

  test('defaults older files to Follow Agent with automatic translation off', async () => {
    await writeFile(
      path.join(userData, 'app-preferences.json'),
      '{"theme":"system","language":null,"translationLanguage":null}',
    );
    resetAppPreferencesForTests();

    expect(loadAppPreferences()).toMatchObject({
      translationModel: null,
      autoTranslateUrls: false,
      autoTranslateEpubs: false,
    });
  });
});
