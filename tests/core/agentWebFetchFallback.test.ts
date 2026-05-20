import { describe, expect, test } from 'bun:test';
import {
  assessWebFetchFallback,
  browserFallbackLooksUseful,
  detectBrowserChallenge,
  isPermittedWebFetchRedirect,
  looksLikeDynamicHtmlShell,
} from '../../src/main/agentWebFetchFallback';
import {
  extractFetchedPageContent,
  normalizeWebFetchParams,
  type FetchTextResult,
  type WebParamResult,
} from '../../src/main/agentWebTools';

function expectParams<T>(result: WebParamResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.params;
}

function fetchedHtml(body: string): FetchTextResult {
  return {
    requestedUrl: 'https://example.com/app',
    finalUrl: 'https://example.com/app',
    statusCode: 200,
    statusText: 'OK',
    contentType: 'text/html; charset=utf-8',
    byteLength: Buffer.byteLength(body, 'utf8'),
    body,
  };
}

describe('agent web fetch fallback heuristics', () => {
  test('does not fallback for ordinary static article HTML', async () => {
    const html = [
      '<!doctype html><html><head><title>Article</title></head><body>',
      '<main><article><h1>Article</h1>',
      '<p>Alpha beta gamma content with enough readable body text for extraction.</p>',
      '<p>Second paragraph with stable static information and direct links.</p>',
      '</article></main>',
      '</body></html>',
    ].join('');
    const params = expectParams(normalizeWebFetchParams({ url: 'https://example.com/app' }));
    const fetched = fetchedHtml(html);
    const page = await extractFetchedPageContent(fetched, params);

    expect(assessWebFetchFallback(fetched, params, page).shouldFallback).toBe(false);
  });

  test('falls back for low-content SPA shells', async () => {
    const html = [
      '<!doctype html><html><head><title>Dynamic App</title></head><body>',
      '<div id="root"></div>',
      '<script src="/assets/runtime.js"></script>',
      '<script>window.__NEXT_DATA__ = {"props":{}};</script>',
      '<script>hydrateRoot(document.getElementById("root"), app);</script>',
      '</body></html>',
    ].join('');
    const params = expectParams(normalizeWebFetchParams({ url: 'https://example.com/app' }));
    const fetched = fetchedHtml(html);
    const page = await extractFetchedPageContent(fetched, params);
    const decision = assessWebFetchFallback(fetched, params, page);

    expect(looksLikeDynamicHtmlShell(html)).toBe(true);
    expect(decision).toMatchObject({ shouldFallback: true, reason: 'spa_shell' });
  });

  test('falls back for find misses on SPA shells only', async () => {
    const html = [
      '<!doctype html><html><head><title>Searchable App</title></head><body>',
      '<div id="app">Loading</div>',
      '<script src="/assets/app.js"></script><script src="/assets/vendor.js"></script>',
      '<script>createRoot(document.getElementById("app"));</script>',
      '</body></html>',
    ].join('');
    const params = expectParams(normalizeWebFetchParams({
      url: 'https://example.com/app',
      query: 'invoice',
    }));
    const fetched = fetchedHtml(html);
    const page = await extractFetchedPageContent(fetched, params);

    expect(assessWebFetchFallback(fetched, params, page)).toMatchObject({
      shouldFallback: true,
      reason: 'spa_shell',
    });
  });

  test('detects browser verification challenges', async () => {
    const html = '<html><head><title>Just a moment...</title></head><body><form id="challenge-form"></form><script>cf_chl_123=1</script></body></html>';
    const params = expectParams(normalizeWebFetchParams({ url: 'https://example.com/app' }));
    const fetched = fetchedHtml(html);
    const page = await extractFetchedPageContent(fetched, params);

    expect(detectBrowserChallenge(html, fetched.finalUrl, 'Just a moment...')).toBe('cloudflare');
    expect(assessWebFetchFallback(fetched, params, page)).toMatchObject({
      shouldFallback: true,
      reason: 'cloudflare',
    });
  });

  test('allows only same host or www redirects', () => {
    expect(isPermittedWebFetchRedirect('https://example.com/a', 'https://www.example.com/b')).toBe(true);
    expect(isPermittedWebFetchRedirect('https://www.example.com/a', 'https://example.com/b')).toBe(true);
    expect(isPermittedWebFetchRedirect('https://example.com/a', 'https://evil.example.net/b')).toBe(false);
    expect(isPermittedWebFetchRedirect('https://example.com/a', 'http://example.com/b')).toBe(false);
  });

  test('uses browser fallback only when it improves extracted content', async () => {
    const params = expectParams(normalizeWebFetchParams({ url: 'https://example.com/app' }));
    const shellFetched = fetchedHtml('<html><body><div id="root"></div><script src="/app.js"></script><script>hydrateRoot()</script></body></html>');
    const renderedFetched = fetchedHtml([
      '<html><body><main><h1>Rendered</h1>',
      '<p>Invoice details and a useful rendered body with enough content to read.</p>',
      '<p>The browser-rendered version includes customer names, totals, due dates,',
      'payment status, and audit history that were absent from the initial shell.</p>',
      '</main></body></html>',
    ].join(''));
    const shellPage = await extractFetchedPageContent(shellFetched, params);
    const renderedPage = await extractFetchedPageContent(renderedFetched, params);
    const shellDecision = assessWebFetchFallback(shellFetched, params, shellPage);
    const renderedDecision = assessWebFetchFallback(renderedFetched, params, renderedPage);

    expect(browserFallbackLooksUseful(shellPage, renderedPage, shellDecision, renderedDecision, params)).toBe(true);
  });
});
