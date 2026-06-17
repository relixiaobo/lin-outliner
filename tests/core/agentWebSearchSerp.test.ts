import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import type { WebSearchResult } from '../../src/main/agentWebTools';
import {
  duckDuckGoSerpExtractorExpression,
  extractDuckDuckGoSerp,
  extractGoogleSerp,
  googleSerpExtractorExpression,
  isTransientSearchError,
  shouldFallbackToSecondaryEngine,
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

function runDuckDuckGoExtractor(html: string): { htmlLength: number; results: WebSearchResult[] } {
  const { document } = parseHTML(html);
  return extractDuckDuckGoSerp(document, 10);
}

// DuckDuckGo's /html/ endpoint wraps each organic hit's target in a
// //duckduckgo.com/l/?uddg=<encoded> redirector; ads carry the `result--ad` class.
const DDG_HTML = [
  '<!doctype html><html><body>',
  '<div class="result result--ad results_links_deep">',
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fads.example.com%2Fbuy">Sponsored</a>',
  '<a class="result__snippet">Ad snippet that should be skipped.</a>',
  '</div>',
  '<div class="result results_links results_links_deep web-result">',
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha&rut=abc">Alpha Result</a>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Alpha snippet with enough detail to read.</a>',
  '</div>',
  '<div class="result results_links web-result">',
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbeta.example%2Fdocs">Beta Result</a>',
  '<a class="result__snippet">Beta snippet about the topic.</a>',
  '</div>',
  '</body></html>',
].join('');

describe('DuckDuckGo SERP extraction', () => {
  test('decodes uddg targets, keeps snippets, and skips sponsored rows', () => {
    const payload = runDuckDuckGoExtractor(DDG_HTML);

    expect(payload.results).toHaveLength(2);
    expect(payload.results.map((r) => r.url)).toEqual([
      'https://example.com/alpha',
      'https://beta.example/docs',
    ]);
    expect(payload.results[0]).toMatchObject({ title: 'Alpha Result', source: 'example.com' });
    expect(payload.results[0]!.snippet).toContain('Alpha snippet');
    // The ad row's target must never surface.
    expect(payload.results.some((r) => r.url.includes('ads.example.com'))).toBe(false);
  });

  test('builds an executable browser expression from the pure extractor', () => {
    const { document } = parseHTML(DDG_HTML);
    const run = new Function('document', `return ${duckDuckGoSerpExtractorExpression(10)};`) as (
      document: Document,
    ) => { results: WebSearchResult[] };
    expect(run(document).results).toEqual(runDuckDuckGoExtractor(DDG_HTML).results);
  });

  test('skips a sponsored row whose ad marker rides an outer wrapper, not the nearest .result', () => {
    const html = [
      '<!doctype html><html><body>',
      // The ad class sits on a wrapper ABOVE the nearest `.result` — the previous
      // nearest-.result-className check would have missed it and leaked the ad.
      '<div class="result--ad results_links_deep"><div class="result web-result">',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fads.example.com%2Fbuy">Sponsored</a>',
      '<a class="result__snippet">Ad snippet that should be skipped.</a>',
      '</div></div>',
      '<div class="result web-result">',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Forganic">Organic Result</a>',
      '<a class="result__snippet">Organic snippet with enough detail to read.</a>',
      '</div>',
      '</body></html>',
    ].join('');
    const payload = runDuckDuckGoExtractor(html);

    expect(payload.results.map((r) => r.url)).toEqual(['https://example.com/organic']);
    expect(payload.results.some((r) => r.url.includes('ads.example.com'))).toBe(false);
  });
});

describe('web search fallback decision helpers', () => {
  test('shouldFallbackToSecondaryEngine triggers on empty/blocked/recoverable, not on bad-query or abort', () => {
    expect(shouldFallbackToSecondaryEngine({ kind: 'ok', resultCount: 0 })).toBe(true);
    expect(shouldFallbackToSecondaryEngine({ kind: 'ok', resultCount: 3 })).toBe(false);
    expect(shouldFallbackToSecondaryEngine({ kind: 'hint', resultCount: 0 })).toBe(true);
    expect(shouldFallbackToSecondaryEngine({ kind: 'error', resultCount: 0, code: 'extraction_failed' })).toBe(true);
    expect(shouldFallbackToSecondaryEngine({ kind: 'error', resultCount: 0, code: 'network_error' })).toBe(true);
    expect(shouldFallbackToSecondaryEngine({ kind: 'error', resultCount: 0, code: 'invalid_args' })).toBe(false);
    expect(shouldFallbackToSecondaryEngine({ kind: 'error', resultCount: 0, code: 'aborted' })).toBe(false);
  });

  test('isTransientSearchError retries nav faults, including the dominant navigation_failed', () => {
    // navigation_failed is what a mid-flight network/DNS blip actually produces
    // (did-fail-load); network_error is only the rarer loadURL race. Both, plus a
    // nav timeout, are transient against the fixed reputable search hosts.
    expect(isTransientSearchError('navigation_failed')).toBe(true);
    expect(isTransientSearchError('network_error')).toBe(true);
    expect(isTransientSearchError('timeout')).toBe(true);
    // Deterministic / non-transient outcomes are not retried.
    expect(isTransientSearchError('extraction_failed')).toBe(false);
    expect(isTransientSearchError('rate_limited')).toBe(false);
    expect(isTransientSearchError('aborted')).toBe(false);
    expect(isTransientSearchError('invalid_args')).toBe(false);
  });
});
