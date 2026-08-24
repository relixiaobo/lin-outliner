import { describe, expect, test } from 'bun:test';
import {
  classifyComposerPaste,
  MAX_AUTOMATIC_PASTE_UTF16_UNITS,
  MAX_COMPOSER_INLINE_ATOMS,
  MAX_COMPOSER_UTF16_UNITS,
  MAX_INLINE_PASTE_BREAKS,
  MAX_INLINE_PASTE_UTF8_BYTES,
  measureComposerText,
} from '../../src/renderer/agent/composerPasteAdmission';

const EMPTY = { inlineAtoms: 0, utf16Units: 0 };

describe('composer paste admission', () => {
  test('keeps a fitting paste editable and normalizes CRLF metrics', () => {
    expect(measureComposerText('first\r\nsecond\rthird')).toEqual({
      inlineAtoms: 2,
      utf16Units: 18,
    });
    expect(classifyComposerPaste({
      current: EMPTY,
      incomingText: 'first\r\nsecond',
      selected: EMPTY,
    }).outcome).toBe('inline');
  });

  test('converts a paste at the UTF-8 byte threshold or over the line-break threshold', () => {
    expect(classifyComposerPaste({
      current: EMPTY,
      incomingText: 'x'.repeat(MAX_INLINE_PASTE_UTF8_BYTES - 1),
      selected: EMPTY,
    }).outcome).toBe('inline');
    expect(classifyComposerPaste({
      current: EMPTY,
      incomingText: 'x'.repeat(MAX_INLINE_PASTE_UTF8_BYTES),
      selected: EMPTY,
    }).outcome).toBe('attach');
    expect(classifyComposerPaste({
      current: EMPTY,
      incomingText: '\u754c'.repeat(Math.ceil(MAX_INLINE_PASTE_UTF8_BYTES / 3)),
      selected: EMPTY,
    }).outcome).toBe('attach');
    expect(classifyComposerPaste({
      current: EMPTY,
      incomingText: '\n'.repeat(MAX_INLINE_PASTE_BREAKS + 1),
      selected: EMPTY,
    }).outcome).toBe('attach');
  });

  test('rejects repeated small pastes at the aggregate budget', () => {
    expect(classifyComposerPaste({
      current: { inlineAtoms: 0, utf16Units: MAX_COMPOSER_UTF16_UNITS },
      incomingText: 'x',
      selected: EMPTY,
    }).outcome).toBe('reject-draft-budget');
    expect(classifyComposerPaste({
      current: { inlineAtoms: MAX_COMPOSER_INLINE_ATOMS, utf16Units: MAX_COMPOSER_INLINE_ATOMS },
      incomingText: '\n',
      selected: EMPTY,
    }).outcome).toBe('reject-draft-budget');
  });

  test('uses the replacement projection rather than the pre-paste document size', () => {
    expect(classifyComposerPaste({
      current: { inlineAtoms: 0, utf16Units: MAX_COMPOSER_UTF16_UNITS },
      incomingText: 'replacement',
      selected: { inlineAtoms: 0, utf16Units: 32 },
    }).outcome).toBe('inline');
  });

  test('rejects above-ceiling text before projected measurement', () => {
    const result = classifyComposerPaste({
      current: EMPTY,
      incomingText: 'x'.repeat(MAX_AUTOMATIC_PASTE_UTF16_UNITS + 1),
      selected: EMPTY,
    });
    expect(result.outcome).toBe('reject-ceiling');
    expect(result.projected).toBeNull();
  });
});
