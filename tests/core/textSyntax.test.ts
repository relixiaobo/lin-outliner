import { describe, expect, test } from 'bun:test';
import {
  TAG_TOKEN,
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
    const names = ['office', '中文', 'multi word', 'abc', '112233', 'needs ] bracket', String.raw`path \ tag`, 'line\nbreak'];
    const formatted = names.map(formatTag);

    expect(formatted).toEqual([
      '#office',
      '#[[中文]]',
      '#[[multi word]]',
      '#[[abc]]',
      '#[[112233]]',
      String.raw`#[[needs \] bracket]]`,
      String.raw`#[[path \\ tag]]`,
      String.raw`#[[line\nbreak]]`,
    ]);
    expect(extractTags(formatted.join(' ')).tags).toEqual(names);
  });

  test('rejects empty tag names during formatting', () => {
    expect(() => formatTag('')).toThrow('Cannot format an empty tag name.');
    expect(() => formatTag('  ')).toThrow('Cannot format an empty tag name.');
  });

  test('does not let the exported tag matcher lastIndex affect helper scans', () => {
    TAG_TOKEN.lastIndex = 9;
    expect(extractTags('Ship #中文 [[#tag]]').tags).toEqual(['中文', 'tag']);
    TAG_TOKEN.lastIndex = 0;
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
