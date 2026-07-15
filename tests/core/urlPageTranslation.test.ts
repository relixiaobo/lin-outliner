import { describe, expect, test } from 'bun:test';
import {
  isTranslationLanguage,
  languageTagMatchesTranslationLanguage,
  TRANSLATION_LANGUAGES,
} from '../../src/core/translationLanguage';

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
});
