import { describe, expect, test } from 'bun:test';
import { insertTextIntoControlValue } from '../../src/renderer/ui/focus/textControlFocus';
import {
  focusElementForRequest,
  focusIsUnclaimed,
} from '../../src/renderer/ui/focus/focusRequestDom';

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

describe('focus request DOM ownership', () => {
  test('claims a connected element only after it becomes active', () => {
    const ownerDocument = { activeElement: null as HTMLElement | null };
    const input = {
      isConnected: true,
      ownerDocument,
      focus: () => {
        ownerDocument.activeElement = input as unknown as HTMLElement;
      },
    } as unknown as HTMLElement;

    expect(focusElementForRequest(input)).toBe(true);
    expect(ownerDocument.activeElement).toBe(input);

    Object.defineProperty(input, 'isConnected', { value: false });
    expect(focusElementForRequest(input)).toBe(false);
  });

  test('treats only null and the document body as unclaimed focus', () => {
    const body = {} as HTMLElement;
    const input = {} as HTMLElement;
    expect(focusIsUnclaimed(null, body)).toBe(true);
    expect(focusIsUnclaimed(body, body)).toBe(true);
    expect(focusIsUnclaimed(input, body)).toBe(false);
  });
});
