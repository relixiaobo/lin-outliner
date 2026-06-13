import { describe, expect, test } from 'bun:test';
import {
  extractTags,
  formatTag,
  parseCheckboxMarker,
} from '../../src/core/textSyntax';

describe('text syntax helpers', () => {
  test('extracts canonical tag forms and excludes bare CSS hex colors', () => {
    expect(extractTags('Ship #中文 [[#tag]] #[[multi word]] #fff #fffff #fff-bug #office')).toEqual({
      tags: ['中文', 'tag', 'multi word', 'fffff', 'fff-bug', 'office'],
      rest: 'Ship #fff',
    });
  });

  test('formats tags so serialized names parse back to the same tag', () => {
    const names = ['office', '中文', 'multi word', 'abc', '112233'];
    const formatted = names.map(formatTag);

    expect(formatted).toEqual(['#office', '#[[中文]]', '#[[multi word]]', '#[[abc]]', '#[[112233]]']);
    expect(extractTags(formatted.join(' ')).tags).toEqual(names);
  });

  test('parses checkbox markers only when the marker is separated from body text', () => {
    expect(parseCheckboxMarker('[x] body')).toEqual({ checked: true, rest: 'body' });
    expect(parseCheckboxMarker('[X] body')).toEqual({ checked: true, rest: 'body' });
    expect(parseCheckboxMarker('[ ] body')).toEqual({ checked: false, rest: 'body' });
    expect(parseCheckboxMarker('[x]body')).toBeNull();
    expect(parseCheckboxMarker('[x]')).toBeNull();
    expect(parseCheckboxMarker('[x] ')).toBeNull();
  });
});
