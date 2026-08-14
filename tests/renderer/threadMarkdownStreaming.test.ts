import { describe, expect, test } from 'bun:test';
import remend from 'remend';
import {
  createStreamingMarkdownBlockParser,
  splitMarkdownBlocks,
} from '../../src/renderer/agent/components/ThreadMarkdown';

describe('streaming Thread Markdown blocks', () => {
  test('matches a full repaired lex after every append across Markdown block shapes', () => {
    const sequences = [
      ['# Head', 'ing', '\n\nParagraph', ' continues', '.\n\n## Next'],
      ['```ts', '\nconst value = 42;', '\nconsole.log(value);', '\n```', '\n\nAfter.'],
      ['- first', '\n- second', '\n  - nested', '\n\nParagraph after list.'],
      ['> quoted', '\n> continuation', '\n\nOutside quote.'],
      ['| Name | Value |', '\n| --- | ---: |', '\n| alpha | 1 |', '\n\nAfter table.'],
      ['<div>', '\n<strong>HTML</strong>', '\n</div>', '\n\nAfter HTML.'],
      ['Use [the reference][ref].', '\n\nAnother paragraph.', '\n\n[ref]: https://example.test'],
      ['[ref]: https://example.test', '\n\nUse [ref].', '\n\nFinal paragraph.'],
      ['A footnote reference[^1].', '\n\n[^1]: Footnote body', '\n    continued.'],
      ['---', '\n\n**bold', '** and _emphasis', '_', '\n\nDone.'],
    ];

    for (const chunks of sequences) {
      const parser = createStreamingMarkdownBlockParser();
      let text = '';
      for (const chunk of chunks) {
        text += chunk;
        expect(parser.parse(text)).toEqual(splitMarkdownBlocks(remend(text)));
      }
    }
  });

  test('redistributes appended reference definitions through a full-lex fallback', () => {
    const parser = createStreamingMarkdownBlockParser();
    const beforeText = 'Use [the reference][ref].\n\nA second block.';
    const before = parser.parse(beforeText);
    const afterText = `${beforeText}\n\n[ref]: https://example.test/reference`;
    const after = parser.parse(afterText);

    expect(after).toEqual(splitMarkdownBlocks(remend(afterText)));
    expect(after[0]).not.toBe(before[0]);
    expect(after[0]).toContain('[ref]: https://example.test/reference');
  });

  test('falls back when token raws omit an ignored duplicate definition', () => {
    const parser = createStreamingMarkdownBlockParser();
    const chunks = [
      '\n\n[^n]: note',
      '\n\n[^n]: note',
      '\n\n<div>',
      '\n\n> q',
      '\n',
    ];
    let text = '';

    for (const chunk of chunks) {
      text += chunk;
      expect(parser.parse(text)).toEqual(splitMarkdownBlocks(remend(text)));
    }
  });

  test('keeps adjacent ambiguous blocks inside the reparsed tail', () => {
    const parser = createStreamingMarkdownBlockParser();
    const chunks = ['\n\n```ts', '\n```', '\n\n[ref]', '\nx', '\n|-|-|', '# H'];
    let text = '';

    for (const chunk of chunks) {
      text += chunk;
      expect(parser.parse(text)).toEqual(splitMarkdownBlocks(remend(text)));
    }
  });

  test('falls back correctly for edits, resets, and later appends', () => {
    const parser = createStreamingMarkdownBlockParser();
    parser.parse('# Original\n\nFirst paragraph.');

    const replacement = '# Replacement\n\nA [link](https://example.test).';
    expect(parser.parse(replacement)).toEqual(splitMarkdownBlocks(remend(replacement)));

    const appended = `${replacement}\n\n- one\n- two`;
    expect(parser.parse(appended)).toEqual(splitMarkdownBlocks(remend(appended)));

    parser.reset();
    expect(parser.parse(appended)).toEqual(splitMarkdownBlocks(remend(appended)));
  });
});
