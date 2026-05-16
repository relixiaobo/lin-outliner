import { describe, expect, test } from 'bun:test';
import { insertTextIntoControlValue } from '../../src/renderer/ui/focus/textControlFocus';

describe('focus text control helpers', () => {
  test('inserts pending text at the current control selection', () => {
    expect(insertTextIntoControlValue({
      value: '你好 world',
      selectionStart: 3,
      selectionEnd: 8,
      text: '世界',
    })).toEqual({
      value: '你好 世界',
      cursor: 5,
    });
  });

  test('falls back to appending when a control has no selection range', () => {
    expect(insertTextIntoControlValue({
      value: 'Field',
      selectionStart: null,
      selectionEnd: null,
      text: '值',
    })).toEqual({
      value: 'Field值',
      cursor: 6,
    });
  });
});
