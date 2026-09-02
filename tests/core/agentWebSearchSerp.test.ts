import { describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import {
  admitGoogleRedirectTarget,
  duckDuckGoSerpExtractorExpression,
  extractDuckDuckGoSerp,
  extractGoogleSerp,
  googleSerpExtractorExpression,
  isGoogleRedirectCandidateUrl,
  isTransientSearchError,
  selectSearchOutcomeIndex,
  shouldFallbackToSecondaryEngine,
} from '../../src/main/agent/capabilities/agentWebSearchSerp';

function runGoogleSerpExtractor(html: string): ReturnType<typeof extractGoogleSerp> {
  const { document } = parseHTML(html);
  return extractGoogleSerp(document, 10);
}

function runGoogleSerpExtractorExpression(html: string): ReturnType<typeof extractGoogleSerp> {
  const { document } = parseHTML(html);
  const run = new Function('document', `return ${googleSerpExtractorExpression(10)};`) as (
    document: Document,
  ) => ReturnType<typeof extractGoogleSerp>;
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

    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates[0]).toMatchObject({
      title: 'Alpha Result',
      url: 'https://example.com/alpha',
      source: 'example.com',
    });
    expect(payload.candidates[0]!.snippet).toContain('Alpha snippet');
    expect(payload.candidates[0]!.snippet).not.toBe('');
    expect(payload.candidates[1]!.snippet).toContain('Beta snippet');
    expect(payload.candidateCount).toBe(3);
  });

  test('builds an executable browser expression from the pure extractor', () => {
    expect(runGoogleSerpExtractorExpression(SERP_HTML).candidates).toEqual(runGoogleSerpExtractor(SERP_HTML).candidates);
  });

  test('preserves opaque Google redirects in result order', () => {
    const html = [
      '<!doctype html><html><body><div id="search">',
      '<div><a href="/goto?url=opaque-signed-token"><h3>Current Result</h3></a>',
      '<span>example.com</span><p>A real visible result whose target is opaque.</p></div>',
      '<div><a href="https://direct.example/docs"><h3>Direct Result</h3></a>',
      '<p>A directly readable result after the opaque result.</p></div>',
      '</div></body></html>',
    ].join('');

    const payload = runGoogleSerpExtractor(html);
    expect(payload.candidateCount).toBe(2);
    expect(payload.candidates.map((candidate) => candidate.title)).toEqual(['Current Result', 'Direct Result']);
    expect(payload.candidates[0]).toMatchObject({
      kind: 'google_redirect',
      redirectUrl: 'https://www.google.com/goto?url=opaque-signed-token',
    });
    expect(payload.candidates[1]).toMatchObject({ kind: 'direct', url: 'https://direct.example/docs' });
  });

  test('admits only bounded Google candidates and first-hop external http targets', () => {
    const candidate = 'https://www.google.com/goto?url=opaque-token';
    expect(isGoogleRedirectCandidateUrl(candidate)).toBe(true);
    expect(isGoogleRedirectCandidateUrl('http://www.google.com/goto?url=opaque-token')).toBe(false);
    expect(isGoogleRedirectCandidateUrl('https://google.com/goto?url=opaque-token')).toBe(false);
    expect(isGoogleRedirectCandidateUrl('https://user:secret@www.google.com/goto?url=opaque-token')).toBe(false);
    expect(isGoogleRedirectCandidateUrl('https://www.google.com/search?url=opaque-token')).toBe(false);
    expect(admitGoogleRedirectTarget(candidate, 'https://example.com/docs#section')).toBe('https://example.com/docs');
    expect(admitGoogleRedirectTarget(candidate, 'http://example.com/docs')).toBe('http://example.com/docs');
    expect(admitGoogleRedirectTarget(candidate, 'https://accounts.google.com/login')).toBeNull();
    expect(admitGoogleRedirectTarget(candidate, 'https://translate.google/page')).toBeNull();
    expect(admitGoogleRedirectTarget(candidate, 'https://user:secret@example.com/docs')).toBeNull();
    expect(admitGoogleRedirectTarget(candidate, 'file:///etc/passwd')).toBeNull();
    expect(admitGoogleRedirectTarget('https://evil.example/goto?url=x', 'https://example.com')).toBeNull();
  });
});

function runDuckDuckGoExtractor(html: string): ReturnType<typeof extractDuckDuckGoSerp> {
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
    expect(payload.candidateCount).toBe(3);
  });

  test('builds an executable browser expression from the pure extractor', () => {
    const { document } = parseHTML(DDG_HTML);
    const run = new Function('document', `return ${duckDuckGoSerpExtractorExpression(10)};`) as (
      document: Document,
    ) => ReturnType<typeof extractDuckDuckGoSerp>;
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

  test('selectSearchOutcomeIndex prefers results, then truthful empty, then diagnostics', () => {
    expect(selectSearchOutcomeIndex([
      { kind: 'error', resultCount: 0, code: 'extraction_failed' },
      { kind: 'ok', resultCount: 4 },
    ])).toBe(1);
    expect(selectSearchOutcomeIndex([
      { kind: 'ok', resultCount: 0 },
      { kind: 'ok', resultCount: 0 },
    ])).toBe(1);
    expect(selectSearchOutcomeIndex([
      { kind: 'hint', resultCount: 0 },
      { kind: 'ok', resultCount: 0 },
    ])).toBe(0);
    expect(selectSearchOutcomeIndex([])).toBe(-1);
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
