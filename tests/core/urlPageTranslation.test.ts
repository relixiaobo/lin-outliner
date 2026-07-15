import { describe, expect, test } from 'bun:test';
import { resolveUrlPageTranslationTargetLocale } from '../../src/core/urlPageTranslation';

describe('URL page translation target locale', () => {
  test('uses Simplified Chinese for an English page when the UI is English', () => {
    expect(resolveUrlPageTranslationTargetLocale('en', 'en')).toBe('zh-Hans');
    expect(resolveUrlPageTranslationTargetLocale('en', 'EN-US')).toBe('zh-Hans');
  });

  test('uses English for a Chinese page when the UI is Simplified Chinese', () => {
    expect(resolveUrlPageTranslationTargetLocale('zh-Hans', 'zh-CN')).toBe('en');
    expect(resolveUrlPageTranslationTargetLocale('zh-Hans', 'zh-Hans')).toBe('en');
  });

  test('keeps the UI locale for other or undeclared page languages', () => {
    expect(resolveUrlPageTranslationTargetLocale('zh-Hans', 'ja-JP')).toBe('zh-Hans');
    expect(resolveUrlPageTranslationTargetLocale('en', '')).toBe('en');
    expect(resolveUrlPageTranslationTargetLocale('en', null)).toBe('en');
  });
});
