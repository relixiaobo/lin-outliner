import { describe, expect, test } from 'bun:test';
import { formatNodeReferenceMarker } from '../../src/core/referenceMarkup';
import { markdownReferenceMarkupToRichText, richTextToMarkdownReferenceMarkup } from '../../src/core/markdownRichText';
import type { RichText, TextMark, TextMarkKind } from '../../src/core/types';

describe('markdown rich text outline bridge', () => {
  test('parses inline markdown marks while preserving node reference markers', () => {
    const marker = formatNodeReferenceMarker('Alpha', 'node-alpha');

    expect(markdownReferenceMarkupToRichText(`See **bold** and ${marker}`)).toEqual({
      text: 'See bold and ',
      marks: [{ start: 4, end: 8, type: 'bold' }],
      inlineRefs: [{
        offset: 13,
        target: { kind: 'node', nodeId: 'node-alpha' },
        displayName: 'Alpha',
      }],
    });
  });

  test('serializes marks and zero-width inline references back to outline text', () => {
    expect(richTextToMarkdownReferenceMarkup({
      text: 'See bold and ',
      marks: [{ start: 4, end: 8, type: 'bold' }],
      inlineRefs: [{
        offset: 13,
        target: { kind: 'node', nodeId: 'node-alpha' },
        displayName: 'Alpha',
      }],
    })).toBe(`See **bold** and ${formatNodeReferenceMarker('Alpha', 'node-alpha')}`);
  });

  test('does not duplicate stored inline reference display text', () => {
    expect(richTextToMarkdownReferenceMarkup({
      text: 'See Alpha',
      marks: [],
      inlineRefs: [{
        offset: 4,
        target: { kind: 'node', nodeId: 'node-alpha' },
        displayName: 'Alpha',
      }],
    })).toBe(`See ${formatNodeReferenceMarker('Alpha', 'node-alpha')}`);
  });

  test('drops marks that only cover stored inline reference display text', () => {
    const marker = formatNodeReferenceMarker('Alpha', 'node-alpha');

    expect(richTextToMarkdownReferenceMarkup({
      text: 'See Alpha',
      marks: [{ start: 4, end: 9, type: 'bold' }],
      inlineRefs: [{
        offset: 4,
        target: { kind: 'node', nodeId: 'node-alpha' },
        displayName: 'Alpha',
      }],
    })).toBe(`See ${marker}`);
  });

  test('clips marks around skipped inline reference display text', () => {
    const marker = formatNodeReferenceMarker('Alpha', 'node-alpha');

    expect(richTextToMarkdownReferenceMarkup({
      text: 'See Alpha today',
      marks: [{ start: 0, end: 15, type: 'bold' }],
      inlineRefs: [{
        offset: 4,
        target: { kind: 'node', nodeId: 'node-alpha' },
        displayName: 'Alpha',
      }],
    })).toBe(`**See **${marker}** today**`);
  });

  test('round-trips grammar-significant literal text without creating semantics', () => {
    const content = {
      text: String.raw`Literal #tag Status:: value [x] %%search%% **stars** [[node:fake^id]] C:\path https://example.com www.example.com`,
      marks: [],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('round-trips literal alternate Markdown delimiters without creating marks', () => {
    const content = {
      text: '__init__ _private_ ~draft~',
      marks: [],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('round-trips protected code text without interpreting its grammar or URLs', () => {
    const text = String.raw`#tag Status:: https://example.com C:\path`;
    const content = {
      text,
      marks: [{ start: 0, end: text.length, type: 'code' as const }],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('pairs code spans by backtick run length and keeps backslashes literal', () => {
    expect(markdownReferenceMarkupToRichText('`C:\\`')).toEqual({
      text: 'C:\\',
      marks: [{ start: 0, end: 3, type: 'code' }],
      inlineRefs: [],
    });
    expect(markdownReferenceMarkupToRichText('``')).toEqual({
      text: '``',
      marks: [],
      inlineRefs: [],
    });
    expect(markdownReferenceMarkupToRichText('``open')).toEqual({
      text: '``open',
      marks: [],
      inlineRefs: [],
    });

    const content = {
      text: 'code ` tick',
      marks: [{ start: 0, end: 11, type: 'code' as const }],
      inlineRefs: [],
    };
    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(serialized).toBe('``code ` tick``');
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('round-trips escaped backticks adjacent to canonical code spans', () => {
    const marker = '[[node:Alpha^node-alpha]]';
    const cases: RichText[] = [
      { text: '`a', marks: [{ start: 1, end: 2, type: 'code' }], inlineRefs: [] },
      { text: 'a`', marks: [{ start: 0, end: 1, type: 'code' }], inlineRefs: [] },
      { text: '`a', marks: [{ start: 0, end: 2, type: 'code' }], inlineRefs: [] },
      { text: 'a`', marks: [{ start: 0, end: 2, type: 'code' }], inlineRefs: [] },
      { text: '`a`', marks: [{ start: 0, end: 3, type: 'code' }], inlineRefs: [] },
      { text: '``', marks: [{ start: 0, end: 2, type: 'code' }], inlineRefs: [] },
      { text: ' ` ', marks: [{ start: 0, end: 3, type: 'code' }], inlineRefs: [] },
      { text: '   ', marks: [{ start: 0, end: 3, type: 'code' }], inlineRefs: [] },
      {
        text: '`abcdefgh`',
        marks: [
          { start: 0, end: 8, type: 'code' },
          { start: 2, end: 10, type: 'bold' },
        ],
        inlineRefs: [],
      },
      {
        text: '`abcdefgh`',
        marks: [
          { start: 0, end: 10, type: 'code' },
          { start: 2, end: 8, type: 'highlight' },
        ],
        inlineRefs: [],
      },
      {
        text: `\`${marker}`,
        marks: [{ start: 1, end: marker.length + 1, type: 'code' }],
        inlineRefs: [],
      },
    ];

    const failures = cases.flatMap((content) => {
      const serialized = richTextToMarkdownReferenceMarkup(content);
      const parsed = markdownReferenceMarkupToRichText(serialized);
      return JSON.stringify(parsed) === JSON.stringify(content)
        ? []
        : [{ content, serialized, parsed }];
    });
    expect(failures).toEqual([]);
  });

  test('materializes bare URLs as link marks without double-linking protected ranges', () => {
    expect(markdownReferenceMarkupToRichText(
      'Visit https://example.com/docs, [site](https://linked.example), and `https://code.example`.',
    )).toEqual({
      text: 'Visit https://example.com/docs, site, and https://code.example.',
      marks: [
        { start: 6, end: 30, type: 'link', attrs: { href: 'https://example.com/docs' } },
        { start: 32, end: 36, type: 'link', attrs: { href: 'https://linked.example' } },
        { start: 42, end: 62, type: 'code' },
      ],
      inlineRefs: [],
    });
  });

  test('keeps explicit bare-URL link serialization readable and reversible', () => {
    const content = {
      text: 'https://example.com',
      marks: [{
        start: 0,
        end: 19,
        type: 'link' as const,
        attrs: { href: 'https://example.com' },
      }],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(serialized).toBe('[https://example.com](https://example.com)');
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('round-trips a bare URL covered by an overlapping Markdown mark', () => {
    const parsed = markdownReferenceMarkupToRichText('**https://example.com**');
    expect(parsed).toEqual({
      text: 'https://example.com',
      marks: [
        { start: 0, end: 19, type: 'bold' },
        { start: 0, end: 19, type: 'link', attrs: { href: 'https://example.com' } },
      ],
      inlineRefs: [],
    });

    const serialized = richTextToMarkdownReferenceMarkup(parsed);
    expect(serialized).toBe('**[https://example.com](https://example.com)**');
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(parsed);
  });

  test('round-trips crossing Markdown mark ranges by closing and reopening marks', () => {
    const content = {
      text: 'See https://example.com',
      marks: [
        { start: 0, end: 9, type: 'bold' as const },
        {
          start: 4,
          end: 23,
          type: 'link' as const,
          attrs: { href: 'https://example.com' },
        },
      ],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(serialized).toBe('**See [https](https://example.com)**[://example.com](https://example.com)');
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('round-trips crossing bold and italic ranges without ambiguous star delimiters', () => {
    const content = {
      text: 'abcdefghij',
      marks: [
        { start: 0, end: 6, type: 'bold' as const },
        { start: 3, end: 10, type: 'italic' as const },
      ],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(serialized).toBe('**abc*****def**ghij*');
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('round-trips crossing ranges for every supported pair of Markdown mark types', () => {
    const markTypes: TextMarkKind[] = ['bold', 'italic', 'strike', 'highlight', 'link', 'code'];
    const failures: Array<{
      first: TextMarkKind;
      second: TextMarkKind;
      serialized: string;
      parsed: ReturnType<typeof markdownReferenceMarkupToRichText>;
    }> = [];
    for (const first of markTypes) {
      for (const second of markTypes) {
        if (first === second) continue;
        const mark = (type: TextMarkKind, start: number, end: number): TextMark => ({
          start,
          end,
          type,
          ...(type === 'link' ? { attrs: { href: 'https://example.test' } } : {}),
        });
        const content = {
          text: 'abcdefghij',
          marks: [mark(first, 0, 6), mark(second, 3, 10)],
          inlineRefs: [],
        };
        const serialized = richTextToMarkdownReferenceMarkup(content);
        const parsed = markdownReferenceMarkupToRichText(serialized);
        if (JSON.stringify(parsed) !== JSON.stringify(content)) {
          failures.push({ first, second, serialized, parsed });
        }
      }
    }

    expect(failures).toEqual([]);
  });

  test('round-trips canonical serialization with three simultaneously active marks', () => {
    const source = '*See **https**://example.com*';
    const parsed = markdownReferenceMarkupToRichText(source);
    const serialized = richTextToMarkdownReferenceMarkup(parsed);

    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(parsed);
  });

  test('round-trips three or more distinct Markdown mark types across nested and crossing ranges', () => {
    const markTypes: TextMarkKind[] = ['bold', 'italic', 'strike', 'highlight', 'link', 'code'];
    const rangePatterns = [
      [[0, 10], [2, 10], [2, 6]],
      [[0, 10], [2, 8], [4, 6]],
      [[0, 6], [2, 8], [4, 10]],
      [[0, 10], [0, 8], [2, 8]],
      [[0, 10], [2, 8], [4, 8]],
      [[0, 10], [2, 10], [2, 8], [4, 6]],
      [[0, 10], [1, 9], [2, 8], [3, 7]],
      [[0, 7], [1, 8], [2, 9], [3, 10]],
      [[0, 10], [0, 10], [0, 10], [0, 10]],
      [[0, 10], [2, 8], [2, 8], [4, 6]],
      [[0, 10], [1, 10], [2, 9], [3, 8], [4, 7]],
      [[0, 10], [1, 10], [2, 9], [3, 8], [4, 7], [5, 6]],
    ] as const satisfies ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
    const nestingRank = (type: TextMarkKind): number => markTypes.indexOf(type);
    const failures: Array<{
      types: TextMarkKind[];
      ranges: typeof rangePatterns[number];
      serialized: string;
      parsed: ReturnType<typeof markdownReferenceMarkupToRichText>;
    }> = [];
    for (const ranges of rangePatterns) {
      const visit = (types: TextMarkKind[]): void => {
        if (types.length < ranges.length) {
          for (const type of markTypes) {
            if (!types.includes(type)) visit([...types, type]);
          }
          return;
        }
        const marks = types.map((type, index): TextMark => ({
          start: ranges[index]![0],
          end: ranges[index]![1],
          type,
          ...(type === 'link' ? { attrs: { href: 'https://example.test' } } : {}),
        })).sort((left, right) => (
          left.start - right.start
          || right.end - left.end
          || nestingRank(left.type) - nestingRank(right.type)
        ));
        const content = { text: 'abcdefghij', marks, inlineRefs: [] };
        const serialized = richTextToMarkdownReferenceMarkup(content);
        const parsed = markdownReferenceMarkupToRichText(serialized);
        if (JSON.stringify(parsed) !== JSON.stringify(content) && failures.length < 10) {
          failures.push({ types, ranges, serialized, parsed });
        }
      };
      visit([]);
    }

    expect(failures).toEqual([]);
  });

  test('keeps repeated bold-italic segments within a bounded parse time', () => {
    const source = Array.from({ length: 40 }, () => '***a*** x').join(' ');
    const startedAt = performance.now();
    const parsed = markdownReferenceMarkupToRichText(source);
    const elapsedMs = performance.now() - startedAt;

    expect(parsed.marks).toHaveLength(80);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test('round-trips link destinations with balanced parentheses', () => {
    const content = {
      text: 'https://example.com/a_(b)',
      marks: [{
        start: 0,
        end: 25,
        type: 'link' as const,
        attrs: { href: 'https://example.com/a_(b)' },
      }],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(serialized).toBe(String.raw`[https://example.com/a_(b)](https://example.com/a_\(b\))`);
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('keeps optional Markdown link titles out of the href', () => {
    expect(markdownReferenceMarkupToRichText('[site](https://example.com "Docs")')).toEqual({
      text: 'site',
      marks: [{ start: 0, end: 4, type: 'link', attrs: { href: 'https://example.com' } }],
      inlineRefs: [],
    });
    expect(markdownReferenceMarkupToRichText('[site](https://example.com "Docs (archived)")')).toEqual({
      text: 'site',
      marks: [{ start: 0, end: 4, type: 'link', attrs: { href: 'https://example.com' } }],
      inlineRefs: [],
    });
    expect(markdownReferenceMarkupToRichText('[site](https://example.com (Archived))')).toEqual({
      text: 'site',
      marks: [{ start: 0, end: 4, type: 'link', attrs: { href: 'https://example.com' } }],
      inlineRefs: [],
    });
    expect(markdownReferenceMarkupToRichText('[x](url "unclosed) [site](https://example.com)')).toEqual({
      text: '[x](url "unclosed) site',
      marks: [{ start: 19, end: 23, type: 'link', attrs: { href: 'https://example.com' } }],
      inlineRefs: [],
    });
    expect(markdownReferenceMarkupToRichText('[x](bad [site](https://example.com))')).toEqual({
      text: '[x](bad site)',
      marks: [{ start: 8, end: 12, type: 'link', attrs: { href: 'https://example.com' } }],
      inlineRefs: [],
    });
  });

  test('round-trips escaped closing parentheses and backslashes in link destinations', () => {
    const content = {
      text: 'download',
      marks: [{
        start: 0,
        end: 8,
        type: 'link' as const,
        attrs: { href: String.raw`https://example.com/a_\folder_)` },
      }],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(serialized).toBe(String.raw`[download](https://example.com/a_\\folder_\))`);
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });

  test('round-trips semantic escape characters in Markdown link labels', () => {
    const text = String.raw`site #literal *stars* C:\path`;
    const content = {
      text,
      marks: [{
        start: 0,
        end: text.length,
        type: 'link' as const,
        attrs: { href: 'https://example.com' },
      }],
      inlineRefs: [],
    };

    const serialized = richTextToMarkdownReferenceMarkup(content);
    expect(serialized).toBe(String.raw`[site \#literal \*stars\* C:\\path](https://example.com)`);
    expect(markdownReferenceMarkupToRichText(serialized)).toEqual(content);
  });
});
