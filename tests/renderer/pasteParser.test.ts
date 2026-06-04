import { describe, expect, test } from 'bun:test';
import {
  detectSingleLineUrl,
  isPlainSingleParagraph,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  parseOutlinerPaste,
} from '../../src/renderer/ui/interactions/pasteParser';

describe('parseInlineMarkdown', () => {
  test('maps every supported inline syntax to our mark kinds', () => {
    expect(parseInlineMarkdown('**bold**')).toEqual({
      text: 'bold',
      marks: [{ start: 0, end: 4, type: 'bold' }],
      inlineRefs: [],
    });
    expect(parseInlineMarkdown('*italic*')).toEqual({
      text: 'italic',
      marks: [{ start: 0, end: 6, type: 'italic' }],
      inlineRefs: [],
    });
    expect(parseInlineMarkdown('~~gone~~')).toEqual({
      text: 'gone',
      marks: [{ start: 0, end: 4, type: 'strike' }],
      inlineRefs: [],
    });
    expect(parseInlineMarkdown('==hot==')).toEqual({
      text: 'hot',
      marks: [{ start: 0, end: 3, type: 'highlight' }],
      inlineRefs: [],
    });
    expect(parseInlineMarkdown('`code`')).toEqual({
      text: 'code',
      marks: [{ start: 0, end: 4, type: 'code' }],
      inlineRefs: [],
    });
  });

  test('parses a link into a link mark carrying href', () => {
    expect(parseInlineMarkdown('[Anthropic](https://anthropic.com)')).toEqual({
      text: 'Anthropic',
      marks: [{ start: 0, end: 9, type: 'link', attrs: { href: 'https://anthropic.com' } }],
      inlineRefs: [],
    });
  });

  test('prefers bold over italic and tracks surrounding text offsets', () => {
    expect(parseInlineMarkdown('see **x** and *y*')).toEqual({
      text: 'see x and y',
      marks: [
        { start: 4, end: 5, type: 'bold' },
        { start: 10, end: 11, type: 'italic' },
      ],
      inlineRefs: [],
    });
  });

  test('leaves snake_case underscores untouched', () => {
    expect(parseInlineMarkdown('my_var_name')).toEqual({
      text: 'my_var_name',
      marks: [],
      inlineRefs: [],
    });
  });
});

describe('parseMarkdownBlocks', () => {
  test('turns a fenced block into a codeBlock node with language', () => {
    expect(parseMarkdownBlocks('```ts\nconst x = 1\nconst y = 2\n```')).toEqual([
      {
        content: { text: 'const x = 1\nconst y = 2', marks: [], inlineRefs: [] },
        children: [],
        type: 'codeBlock',
        codeLanguage: 'typescript',
      },
    ]);
  });

  test('treats a multi-word info string as a fence and uses the first token as the language', () => {
    expect(parseMarkdownBlocks('```tool node_create\n{\n  "ok": true\n}\n```')).toEqual([
      {
        content: { text: '{\n  "ok": true\n}', marks: [], inlineRefs: [] },
        children: [],
        type: 'codeBlock',
        codeLanguage: 'tool',
      },
    ]);
  });

  test('keeps consecutive multi-word fences paired so prose between them stays prose', () => {
    const pasted = [
      '```tool node_create',
      '{ "outline": "- A" }',
      '```',
      '',
      'Between the blocks.',
      '',
      '```python',
      'print("hi")',
      '```',
    ].join('\n');
    expect(parseMarkdownBlocks(pasted)).toEqual([
      {
        content: { text: '{ "outline": "- A" }', marks: [], inlineRefs: [] },
        children: [],
        type: 'codeBlock',
        codeLanguage: 'tool',
      },
      {
        content: { text: 'Between the blocks.', marks: [], inlineRefs: [] },
        children: [],
      },
      {
        content: { text: 'print("hi")', marks: [], inlineRefs: [] },
        children: [],
        type: 'codeBlock',
        codeLanguage: 'python',
      },
    ]);
  });

  test('nests an indented fenced block under its parent row', () => {
    expect(parseMarkdownBlocks('Parent\n  ```\n  code\n  ```')).toEqual([
      {
        content: { text: 'Parent', marks: [], inlineRefs: [] },
        children: [
          {
            content: { text: 'code', marks: [], inlineRefs: [] },
            children: [],
            type: 'codeBlock',
            codeLanguage: undefined,
          },
        ],
      },
    ]);
  });

  test('normalizes special bullet glyphs and +/) list markers into rows', () => {
    expect(parseMarkdownBlocks('▪ alpha\n‣ beta\n+ gamma\n1) delta')).toEqual([
      { content: { text: 'alpha', marks: [], inlineRefs: [] }, children: [] },
      { content: { text: 'beta', marks: [], inlineRefs: [] }, children: [] },
      { content: { text: 'gamma', marks: [], inlineRefs: [] }, children: [] },
      { content: { text: 'delta', marks: [], inlineRefs: [] }, children: [] },
    ]);
  });

  test('harvests #tags and field:: values, stripping them from the row text', () => {
    expect(parseMarkdownBlocks('Ship release #urgent #work status:: done priority:: high')).toEqual([
      {
        content: { text: 'Ship release', marks: [], inlineRefs: [] },
        children: [],
        tags: ['urgent', 'work'],
        fields: [
          { name: 'status', value: 'done' },
          { name: 'priority', value: 'high' },
        ],
      },
    ]);
  });

  test('stops a field value before a following #tag', () => {
    expect(parseMarkdownBlocks('Fix bug status:: done #later')).toEqual([
      {
        content: { text: 'Fix bug', marks: [], inlineRefs: [] },
        children: [],
        tags: ['later'],
        fields: [{ name: 'status', value: 'done' }],
      },
    ]);
  });

  test('leaves code/URL colons and mid-word hashes alone', () => {
    expect(parseMarkdownBlocks('run std::cout then visit http://x.com for C#9')).toEqual([
      { content: { text: 'run std::cout then visit http://x.com for C#9', marks: [], inlineRefs: [] }, children: [] },
    ]);
  });

  test('keeps heading marks alongside inline marks', () => {
    expect(parseMarkdownBlocks('## A **bold** title')).toEqual([
      {
        content: {
          text: 'A bold title',
          marks: [
            { start: 0, end: 12, type: 'headingMark' },
            { start: 2, end: 6, type: 'bold' },
          ],
          inlineRefs: [],
        },
        children: [],
      },
    ]);
  });
});

describe('detectSingleLineUrl', () => {
  test('accepts explicit protocols and bare www domains', () => {
    expect(detectSingleLineUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(detectSingleLineUrl('  http://a.b/c  ')).toBe('http://a.b/c');
    expect(detectSingleLineUrl('www.example.com')).toBe('https://www.example.com');
  });

  test('rejects ambiguous or multi-token text', () => {
    expect(detectSingleLineUrl('example.com')).toBeNull();
    expect(detectSingleLineUrl('see https://x.com now')).toBeNull();
    expect(detectSingleLineUrl('hello')).toBeNull();
  });
});

describe('isPlainSingleParagraph', () => {
  test('is true only for a single unmarked plain block', () => {
    expect(isPlainSingleParagraph(parseOutlinerPaste('just text'))).toBe(true);
    expect(isPlainSingleParagraph(parseOutlinerPaste('**bold**'))).toBe(false);
    expect(isPlainSingleParagraph(parseOutlinerPaste('line one\nline two'))).toBe(false);
    expect(isPlainSingleParagraph(parseOutlinerPaste('```\ncode\n```'))).toBe(false);
  });
});
