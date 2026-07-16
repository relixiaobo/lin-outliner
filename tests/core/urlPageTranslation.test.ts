import { describe, expect, test } from 'bun:test';
import {
  isTranslationLanguage,
  isValidLanguageTag,
  languageTagMatchesTranslationLanguage,
  TRANSLATION_LANGUAGES,
} from '../../src/core/translationLanguage';
import {
  isUrlPageTranslationModel,
  isUrlPageTranslationPreferences,
} from '../../src/core/urlPageTranslation';

describe('URL page translation languages', () => {
  test('exposes a broad, unique catalog of common target languages', () => {
    expect(TRANSLATION_LANGUAGES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(TRANSLATION_LANGUAGES.map((language) => language.code)).size)
      .toBe(TRANSLATION_LANGUAGES.length);
    expect(isTranslationLanguage('ja')).toBe(true);
    expect(isTranslationLanguage('not-a-language')).toBe(false);
  });

  test('matches declared language variants without conflating Chinese scripts', () => {
    expect(languageTagMatchesTranslationLanguage('EN-US', 'en')).toBe(true);
    expect(languageTagMatchesTranslationLanguage('pt-BR', 'pt')).toBe(true);
    expect(languageTagMatchesTranslationLanguage('zh-CN', 'zh-Hans')).toBe(true);
    expect(languageTagMatchesTranslationLanguage('zh-TW', 'zh-Hans')).toBe(false);
    expect(languageTagMatchesTranslationLanguage('zh-Hant-HK', 'zh-Hant')).toBe(true);
  });

  test('accepts common legacy language aliases', () => {
    expect(languageTagMatchesTranslationLanguage('no-NO', 'nb')).toBe(true);
    expect(languageTagMatchesTranslationLanguage('tl-PH', 'fil')).toBe(true);
    expect(languageTagMatchesTranslationLanguage('iw-IL', 'he')).toBe(true);
    expect(languageTagMatchesTranslationLanguage(null, 'en')).toBe(false);
  });

  test('accepts only non-empty structurally valid top-level language tags', () => {
    expect(isValidLanguageTag('en-US')).toBe(true);
    expect(isValidLanguageTag('zh-Hant-HK')).toBe(true);
    expect(isValidLanguageTag('')).toBe(false);
    expect(isValidLanguageTag('not_a_language')).toBe(false);
  });
});

describe('URL page translation preferences', () => {
  test('accepts only provider-qualified explicit models', () => {
    expect(isUrlPageTranslationModel('openai/gpt-4.1-mini')).toBe(true);
    expect(isUrlPageTranslationModel('gpt-4.1-mini')).toBe(false);
    expect(isUrlPageTranslationPreferences({
      translationModel: null,
      autoTranslateEpubs: false,
      autoTranslateUrls: false,
    })).toBe(true);
    expect(isUrlPageTranslationPreferences({
      translationModel: null,
      autoTranslateUrls: false,
    })).toBe(false);
  });
});
