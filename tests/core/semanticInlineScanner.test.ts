import { describe, expect, test } from 'bun:test';
import {
  scanMarkdownInline,
  scanRichTextInline,
} from '../../src/core/semanticIngest/inlineScanner';

describe('semantic inline scanner', () => {
  test('keeps non-canonical Markdown delimiters as literal text', () => {
    expect(scanMarkdownInline(
      '__init__ _private_ ~draft~',
      { metadata: 'none', linkifyBareUrls: true, references: true },
    ).content).toEqual({
      text: '__init__ _private_ ~draft~',
      marks: [],
      inlineRefs: [],
    });
  });

  test('links bare URLs while keeping protected link and code ranges intact', () => {
    expect(scanMarkdownInline(
      'Visit https://example.com/docs, [site #literal](https://linked.example) and `https://code.example #code` #work',
      { metadata: 'tags', linkifyBareUrls: true, references: true },
    )).toEqual({
      source: 'Visit https://example.com/docs, [site #literal](https://linked.example) and `https://code.example #code`',
      content: {
        text: 'Visit https://example.com/docs, site #literal and https://code.example #code',
        marks: [
          { start: 6, end: 30, type: 'link', attrs: { href: 'https://example.com/docs' } },
          { start: 32, end: 45, type: 'link', attrs: { href: 'https://linked.example' } },
          { start: 50, end: 76, type: 'code' },
        ],
        inlineRefs: [],
      },
      fields: [],
      tags: [{ name: 'work', source: { start: 105, end: 110 } }],
    });
  });

  test('protects link metadata nested inside canonical style marks', () => {
    expect(scanMarkdownInline(
      '*See **[site #literal](https://example.com)** now* #work',
      { metadata: 'tags', linkifyBareUrls: true, references: true },
    )).toEqual({
      source: '*See **[site #literal](https://example.com)** now*',
      content: {
        text: 'See site #literal now',
        marks: [
          { start: 0, end: 21, type: 'italic' },
          { start: 4, end: 17, type: 'bold' },
          { start: 4, end: 17, type: 'link', attrs: { href: 'https://example.com' } },
        ],
        inlineRefs: [],
      },
      fields: [],
      tags: [{ name: 'work', source: { start: 51, end: 56 } }],
    });
  });

  test('keeps unclosed canonical marks literal through the Marked fallback', () => {
    expect(scanMarkdownInline(
      'Keep **open and ==hot',
      { metadata: 'none', linkifyBareUrls: true, references: true },
    ).content).toEqual({
      text: 'Keep **open and ==hot',
      marks: [],
      inlineRefs: [],
    });
  });

  test('linkifies a bare URL inside an existing rich-text mark without dropping either mark', () => {
    const text = 'https://example.com';

    expect(scanRichTextInline({
      text,
      marks: [{ start: 0, end: text.length, type: 'bold' }],
      inlineRefs: [],
    }, {
      metadata: 'none',
      linkifyBareUrls: true,
      references: true,
    }).content).toEqual({
      text,
      marks: [
        { start: 0, end: text.length, type: 'bold' },
        { start: 0, end: text.length, type: 'link', attrs: { href: text } },
      ],
      inlineRefs: [],
    });
  });

  test('parses an explicit Markdown link with balanced destination parentheses', () => {
    const source = '[site](https://example.com/a_(b))';

    expect(scanMarkdownInline(source, {
      metadata: 'tags-and-fields',
      linkifyBareUrls: true,
      references: true,
    })).toEqual({
      source,
      content: {
        text: 'site',
        marks: [{
          start: 0,
          end: 4,
          type: 'link',
          attrs: { href: 'https://example.com/a_(b)' },
        }],
        inlineRefs: [],
      },
      fields: [],
      tags: [],
    });
  });

  test('uses existing rich-text marks as protected ranges and remaps offsets', () => {
    expect(scanRichTextInline({
      text: 'See #linked then #work status:: done',
      marks: [{ start: 4, end: 11, type: 'link', attrs: { href: 'https://example.com' } }],
      inlineRefs: [],
    }, { metadata: 'tags-and-fields', linkifyBareUrls: true })).toEqual({
      content: {
        text: 'See #linked then',
        marks: [{ start: 4, end: 11, type: 'link', attrs: { href: 'https://example.com' } }],
        inlineRefs: [],
      },
      fields: [{ name: 'status', value: 'done', source: { start: 23, end: 36 } }],
      tags: [{ name: 'work', source: { start: 17, end: 22 } }],
    });
  });

  test('keeps escaped semantic tokens literal', () => {
    expect(scanMarkdownInline(
      String.raw`Literal \#tag status\:: value \[x] \%%search%%`,
      { metadata: 'tags-and-fields', linkifyBareUrls: true, references: true },
    )).toEqual({
      source: String.raw`Literal \#tag status\:: value \[x] \%%search%%`,
      content: {
        text: 'Literal #tag status:: value [x] %%search%%',
        marks: [],
        inlineRefs: [],
      },
      fields: [],
      tags: [],
    });
  });

  test('protects rich-text references and escaped tokens while remapping metadata', () => {
    const scanned = scanRichTextInline({
      text: String.raw`See \#escaped [[node:Label #literal^node-a]] #work`,
      marks: [],
      inlineRefs: [],
    }, { metadata: 'tags-and-fields', linkifyBareUrls: true });

    expect(scanned.content).toEqual({
      text: 'See #escaped [[node:Label #literal^node-a]]',
      marks: [],
      inlineRefs: [],
    });
    expect(scanned.tags.map((tag) => tag.name)).toEqual(['work']);
    expect(scanned.fields).toEqual([]);
  });

  test('does not materialize references inside code and remaps multiple reference offsets', () => {
    const scanned = scanMarkdownInline(
      '`[[node:Code^node-code]]` [[node:One^node-one]] / [[node:Two^node-two]]',
      { metadata: 'tags', linkifyBareUrls: true, references: true },
    );

    expect(scanned.content).toEqual({
      text: '[[node:Code^node-code]]  / ',
      marks: [{ start: 0, end: 23, type: 'code' }],
      inlineRefs: [
        { offset: 24, target: { kind: 'node', nodeId: 'node-one' }, displayName: 'One' },
        { offset: 27, target: { kind: 'node', nodeId: 'node-two' }, displayName: 'Two' },
      ],
    });
  });

  test('protects metadata inside multi-backtick code spans', () => {
    expect(scanMarkdownInline(
      '``#literal status:: open ` tick`` #work',
      { metadata: 'tags-and-fields', linkifyBareUrls: true, references: true },
    )).toEqual({
      source: '``#literal status:: open ` tick``',
      content: {
        text: '#literal status:: open ` tick',
        marks: [{ start: 0, end: 29, type: 'code' }],
        inlineRefs: [],
      },
      fields: [],
      tags: [{ name: 'work', source: { start: 34, end: 39 } }],
    });
  });

  test('merges equivalent marks after materializing inline references', () => {
    expect(scanMarkdownInline(
      '**a[[node:Alpha^node-alpha]]b**',
      { metadata: 'none', linkifyBareUrls: true, references: true },
    ).content).toEqual({
      text: 'ab',
      marks: [{ start: 0, end: 2, type: 'bold' }],
      inlineRefs: [{ offset: 1, target: { kind: 'node', nodeId: 'node-alpha' }, displayName: 'Alpha' }],
    });
  });

  test('keeps malformed Markdown and trailing URL delimiters within linear-time bounds', () => {
    const unmatchedBrackets = '['.repeat(32_000);
    let startedAt = performance.now();
    expect(scanMarkdownInline(
      unmatchedBrackets,
      { metadata: 'none', linkifyBareUrls: false, references: false },
    ).content.text).toBe(unmatchedBrackets);
    const bracketElapsedMs = performance.now() - startedAt;

    const nestedInvalidLinks = `${'[x]('.repeat(4_000)}bad title${')'.repeat(4_000)}`;
    startedAt = performance.now();
    expect(scanMarkdownInline(
      nestedInvalidLinks,
      { metadata: 'none', linkifyBareUrls: false, references: false },
    ).content.text).toBe(nestedInvalidLinks);
    const invalidLinkElapsedMs = performance.now() - startedAt;

    const escapedBacktickRuns = '\\``x'.repeat(16_000);
    startedAt = performance.now();
    expect(scanMarkdownInline(
      escapedBacktickRuns,
      { metadata: 'none', linkifyBareUrls: false, references: false },
    ).content.text).toBe('``x'.repeat(16_000));
    const escapedBacktickElapsedMs = performance.now() - startedAt;

    const longUrl = `https://example.com/${'a'.repeat(16_000)}${')'.repeat(16_000)}`;
    startedAt = performance.now();
    const scannedUrl = scanMarkdownInline(
      longUrl,
      { metadata: 'none', linkifyBareUrls: true, references: false },
    ).content;
    const urlElapsedMs = performance.now() - startedAt;

    expect(scannedUrl.marks).toEqual([{
      start: 0,
      end: 16_020,
      type: 'link',
      attrs: { href: `https://example.com/${'a'.repeat(16_000)}` },
    }]);
    expect(bracketElapsedMs).toBeLessThan(1_000);
    expect(invalidLinkElapsedMs).toBeLessThan(1_000);
    expect(escapedBacktickElapsedMs).toBeLessThan(1_000);
    expect(urlElapsedMs).toBeLessThan(1_000);
  });

  test('keeps nested Markdown links recoverable without recursive parsing', () => {
    const nested = scanMarkdownInline(
      '[outer [inner](https://i.test) tail](https://o.test)',
      { metadata: 'none', linkifyBareUrls: false, references: false },
    ).content;
    expect(nested).toEqual({
      text: '[outer inner tail](https://o.test)',
      marks: [{ start: 7, end: 12, type: 'link', attrs: { href: 'https://i.test' } }],
      inlineRefs: [],
    });

    const depth = 2_000;
    const prefix = '[x '.repeat(depth);
    const suffix = '](o)'.repeat(depth);
    const source = `${prefix}[inner](i)${suffix}`;
    const startedAt = performance.now();
    const parsed = scanMarkdownInline(
      source,
      { metadata: 'none', linkifyBareUrls: false, references: false },
    ).content;
    const elapsedMs = performance.now() - startedAt;

    expect(parsed).toEqual({
      text: `${prefix}inner${suffix}`,
      marks: [{ start: prefix.length, end: prefix.length + 5, type: 'link', attrs: { href: 'i' } }],
      inlineRefs: [],
    });
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test('materializes rich-text references while preserving existing refs and protected marks', () => {
    const marker = '[[node:One^node-one]]';
    const text = `${marker} tail`;
    const scanned = scanRichTextInline({
      text,
      marks: [],
      inlineRefs: [
        {
          offset: 0,
          target: { kind: 'node', nodeId: 'node-prefix' },
          displayName: 'Prefix',
        },
        {
          offset: text.length,
          target: { kind: 'node', nodeId: 'node-existing' },
          displayName: 'Existing',
        },
      ],
    }, {
      metadata: 'none',
      linkifyBareUrls: true,
      references: true,
    });

    expect(scanned.content).toEqual({
      text: ' tail',
      marks: [],
      inlineRefs: [
        { offset: 0, target: { kind: 'node', nodeId: 'node-prefix' }, displayName: 'Prefix' },
        { offset: 0, target: { kind: 'node', nodeId: 'node-one' }, displayName: 'One' },
        { offset: 5, target: { kind: 'node', nodeId: 'node-existing' }, displayName: 'Existing' },
      ],
    });

    const linked = '[[node:Linked^node-linked]]';
    const code = '[[node:Code^node-code]]';
    const protectedText = `${linked} ${code}`;
    expect(scanRichTextInline({
      text: protectedText,
      marks: [
        { start: 0, end: linked.length, type: 'link', attrs: { href: 'https://example.com' } },
        { start: linked.length + 1, end: protectedText.length, type: 'code' },
      ],
      inlineRefs: [],
    }, { metadata: 'none', references: true }).content).toEqual({
      text: protectedText,
      marks: [
        { start: 0, end: linked.length, type: 'link', attrs: { href: 'https://example.com' } },
        { start: linked.length + 1, end: protectedText.length, type: 'code' },
      ],
      inlineRefs: [],
    });
  });

  test('excludes sentence punctuation while preserving balanced URL delimiters', () => {
    const scanned = scanMarkdownInline(
      'See https://example.com/a_(b)). Then www.example.com\u3002',
      { metadata: 'none', linkifyBareUrls: true, references: false },
    );

    expect(scanned.content.marks).toEqual([
      { start: 4, end: 29, type: 'link', attrs: { href: 'https://example.com/a_(b)' } },
      { start: 37, end: 52, type: 'link', attrs: { href: 'https://www.example.com' } },
    ]);
  });

  test('honors canonical URL escapes in Markdown and rich text', () => {
    expect(scanMarkdownInline(
      String.raw`Keep https\://example.com and www\.example.com literal`,
      { metadata: 'none', linkifyBareUrls: true, references: true },
    ).content).toEqual({
      text: 'Keep https://example.com and www.example.com literal',
      marks: [],
      inlineRefs: [],
    });
    expect(scanRichTextInline({
      text: String.raw`Keep https\://example.com and www\.example.com literal`,
      marks: [],
      inlineRefs: [],
    }, { metadata: 'tags-and-fields', linkifyBareUrls: true }).content).toEqual({
      text: 'Keep https://example.com and www.example.com literal',
      marks: [],
      inlineRefs: [],
    });
  });

  test('requires a token boundary and a complete www domain', () => {
    const scanned = scanMarkdownInline(
      'Keep foohttps://embedded.example and www.example literal; link www.example.com.',
      { metadata: 'none', linkifyBareUrls: true, references: false },
    );

    expect(scanned.content.marks).toEqual([
      { start: 63, end: 78, type: 'link', attrs: { href: 'https://www.example.com' } },
    ]);
  });
});
