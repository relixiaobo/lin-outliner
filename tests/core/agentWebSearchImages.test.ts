import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import type { WebSearchResult } from '../../src/main/agentWebTools';
import {
  bingImagesExtractorExpression,
  extractBingImages,
} from '../../src/main/agentWebSearchSerp';

function runBingImagesExtractor(html: string, max = 10): { htmlLength: number; results: WebSearchResult[] } {
  const { document } = parseHTML(html);
  return extractBingImages(document, max);
}

function runBingImagesExtractorExpression(html: string): { htmlLength: number; results: WebSearchResult[] } {
  const { document } = parseHTML(html);
  const run = new Function('document', `return ${bingImagesExtractorExpression(10)};`) as (
    document: Document,
  ) => { htmlLength: number; results: WebSearchResult[] };
  return run(document);
}

// Bing Images encodes each result as `a.iusc[m]` carrying a JSON blob. Authored
// with single-quoted attributes so the embedded JSON double-quotes survive the
// linkedom parse the way they do in a real page.
function iusc(meta: Record<string, unknown>): string {
  const m = JSON.stringify(meta).replace(/'/g, '&#39;');
  return [
    '<li class="iuscp">',
    `<a class="iusc" m='${m}' aria-label="${String(meta.t ?? '')}"><img alt="inner alt"/></a>`,
    '</li>',
  ].join('');
}

const IMAGES_HTML = [
  '<!doctype html><html><body><div id="mmComponent_images_1">',
  '<ul>',
  iusc({
    murl: 'https://cdn.example.com/photos/aurora-full.jpg',
    turl: 'https://tse.example.com/th?id=aurora',
    purl: 'https://example.com/aurora-article',
    t: 'Aurora over the fjord',
  }),
  // Duplicate full-image url — must be deduped.
  iusc({
    murl: 'https://cdn.example.com/photos/aurora-full.jpg',
    turl: 'https://tse.example.com/th?id=aurora-dup',
    purl: 'https://other.example/dup',
    t: 'Aurora duplicate',
  }),
  // Missing murl — must be skipped.
  iusc({
    turl: 'https://tse.example.com/th?id=nomurl',
    purl: 'https://example.com/no-image',
    t: 'No media url',
  }),
  // Non-http murl — must be skipped.
  iusc({
    murl: 'data:image/png;base64,AAAA',
    purl: 'https://example.com/data-uri',
    t: 'Data URI',
  }),
  iusc({
    murl: 'https://images.beta.test/banner.png',
    turl: 'https://tse.example.com/th?id=banner',
    purl: 'https://beta.test/blog/banner',
    t: 'Beta banner',
  }),
  '</ul></div></body></html>',
].join('');

describe('Bing Images extraction', () => {
  test('extracts image fields from iusc JSON blobs', () => {
    const payload = runBingImagesExtractor(IMAGES_HTML);

    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]).toMatchObject({
      title: 'Aurora over the fjord',
      url: 'https://example.com/aurora-article',
      imageUrl: 'https://cdn.example.com/photos/aurora-full.jpg',
      thumbnailUrl: 'https://tse.example.com/th?id=aurora',
      source: 'example.com',
    });
    expect(payload.results[0]!.snippet).toBe('');
    expect(payload.results[1]).toMatchObject({
      title: 'Beta banner',
      url: 'https://beta.test/blog/banner',
      imageUrl: 'https://images.beta.test/banner.png',
      source: 'beta.test',
    });
    // Dimensions are not scraped from Bing (no reliable source) → always omitted.
    expect(payload.results[0]!.width).toBeUndefined();
    expect(payload.results[1]!.height).toBeUndefined();
  });

  test('skips a JSON null payload without aborting the whole extraction', () => {
    const html = [
      '<!doctype html><html><body><ul>',
      // A `m='null'` blob must be skipped, not throw out of the in-page extractor.
      '<li class="iuscp"><a class="iusc" m=\'null\'></a></li>',
      iusc({
        murl: 'https://cdn.example.com/after-null.jpg',
        turl: 'https://tse.example.com/th?id=after',
        purl: 'https://example.com/after-null',
        t: 'Survives the null',
      }),
      '</ul></body></html>',
    ].join('');
    const payload = runBingImagesExtractor(html);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]!.imageUrl).toBe('https://cdn.example.com/after-null.jpg');
  });

  test('honors the result limit', () => {
    expect(runBingImagesExtractor(IMAGES_HTML, 1).results).toHaveLength(1);
  });

  test('builds an executable browser expression from the pure extractor', () => {
    expect(runBingImagesExtractorExpression(IMAGES_HTML).results).toEqual(
      runBingImagesExtractor(IMAGES_HTML).results,
    );
  });
});
