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
});
