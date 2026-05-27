import { describe, expect, test } from 'bun:test';
import { isKnownCodeLanguage } from '../../src/renderer/ui/editor/shikiHighlighter';

describe('isKnownCodeLanguage', () => {
  test('accepts real Shiki grammars, including ones outside the picker list', () => {
    expect(isKnownCodeLanguage('python')).toBe(true);
    expect(isKnownCodeLanguage('kotlin')).toBe(true);
  });

  test('accepts known aliases via normalization', () => {
    expect(isKnownCodeLanguage('py')).toBe(true);
    expect(isKnownCodeLanguage('TS')).toBe(true);
  });

  test('rejects fence info strings that are not languages so they fall back to Plain text', () => {
    expect(isKnownCodeLanguage('tool')).toBe(false);
    expect(isKnownCodeLanguage('tool-error')).toBe(false);
    expect(isKnownCodeLanguage('tool-result')).toBe(false);
  });

  test('treats empty / plain text as not a highlightable language', () => {
    expect(isKnownCodeLanguage('')).toBe(false);
    expect(isKnownCodeLanguage(null)).toBe(false);
    expect(isKnownCodeLanguage('text')).toBe(false);
  });
});
