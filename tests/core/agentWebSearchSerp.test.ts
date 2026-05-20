import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import type { WebSearchResult } from '../../src/main/agentWebTools';
import {
  extractGoogleSerp,
  googleSerpExtractorExpression,
} from '../../src/main/agentWebSearchSerp';

function runGoogleSerpExtractor(html: string): { htmlLength: number; results: WebSearchResult[] } {
  const { document } = parseHTML(html);
  return extractGoogleSerp(document, 10);
}

function runGoogleSerpExtractorExpression(html: string): { htmlLength: number; results: WebSearchResult[] } {
  const { document } = parseHTML(html);
  const run = new Function('document', `return ${googleSerpExtractorExpression(10)};`) as (
    document: Document,
  ) => { htmlLength: number; results: WebSearchResult[] };
  return run(document);
}

const SERP_HTML = [
  '<!doctype html><html><body><div id="search">',
  '<div class="g">',
  '<div><a href="/url?q=https%3A%2F%2Fexample.com%2Falpha"><h3>Alpha Result</h3></a></div>',
  '<div><span>example.com</span></div>',
  '<div><span>Alpha snippet with enough words and punctuation for the result.</span></div>',
  '</div>',
  '<div class="g">',
  '<div><a href="https://www.google.com/search?q=internal"><h3>Google Internal</h3></a></div>',
  '<div>Should not be returned.</div>',
  '</div>',
  '<div class="g">',
  '<div><a href="https://beta.example/docs"><h3>Beta Result</h3></a></div>',
  '<div><span>beta.example</span></div>',
  '<div>Beta snippet with a date in 2026 and enough detail.</div>',
  '</div>',
  '</div></body></html>',
].join('');

describe('Google SERP extraction', () => {
  test('extracts snippets from surrounding result blocks', () => {
    const payload = runGoogleSerpExtractor(SERP_HTML);

    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]).toMatchObject({
      title: 'Alpha Result',
      url: 'https://example.com/alpha',
      source: 'example.com',
    });
    expect(payload.results[0]!.snippet).toContain('Alpha snippet');
    expect(payload.results[0]!.snippet).not.toBe('');
    expect(payload.results[1]!.snippet).toContain('Beta snippet');
  });

  test('builds an executable browser expression from the pure extractor', () => {
    expect(runGoogleSerpExtractorExpression(SERP_HTML).results).toEqual(runGoogleSerpExtractor(SERP_HTML).results);
  });
});
