import { describe, expect, test } from 'bun:test';
import { formatNodeReferenceMarker } from '../../src/core/referenceMarkup';
import { markdownReferenceMarkupToRichText, richTextToMarkdownReferenceMarkup } from '../../src/core/markdownRichText';

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
