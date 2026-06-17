import { describe, expect, test } from 'bun:test';
import {
  assessWebFetchFallback,
  browserFallbackLooksUseful,
  crossHostRedirectHint,
  detectBrowserChallenge,
  isPermittedWebFetchRedirect,
  isTransientNetworkError,
  looksLikeDynamicHtmlShell,
  makeRedirectedHostHint,
  nextSecFetchSite,
  webFetchRefererForHop,
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

  test('detects non-Cloudflare verification pages returned with HTTP 200', async () => {
    const html = '<html><head><title>Reddit - Please wait for verification</title></head><body>Reddit - Please wait for verification</body></html>';
    const params = expectParams(normalizeWebFetchParams({ url: 'https://www.reddit.com/r/example/comments/1/test/' }));
    const fetched = fetchedHtml(html);
    const page = await extractFetchedPageContent(fetched, params);

    expect(detectBrowserChallenge(html, fetched.finalUrl, 'Reddit - Please wait for verification')).toBe('verification');
    expect(assessWebFetchFallback(fetched, params, page)).toMatchObject({
      shouldFallback: true,
      reason: 'verification',
    });
  });

  test('detects DataDome verification markers', () => {
    const html = '<html><body><script>window.dd={cid:"x"}</script><div id="datadome">Please wait while we verify that you are a human</div></body></html>';

    expect(detectBrowserChallenge(html, 'https://www.reuters.com/article', 'Unauthorized')).toBe('verification');
  });

  test('does not flag a full article that merely embeds a Cloudflare beacon', async () => {
    const paragraph = 'This is a complete article paragraph with substantial readable body text that Defuddle keeps. ';
    const html = [
      '<!doctype html><html><head><title>Real Article</title>',
      // The kind of analytics/turnstile reference embedded on Cloudflare-fronted
      // sites — it must NOT be treated as a challenge on a full page.
      '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>',
      '</head><body><main><article><h1>Real Article</h1>',
      `<p>${paragraph.repeat(40)}</p>`,
      '</article></main></body></html>',
    ].join('');
    const params = expectParams(normalizeWebFetchParams({ url: 'https://example.com/article' }));
    const fetched = fetchedHtml(html);
    const page = await extractFetchedPageContent(fetched, params);

    // A bare "cloudflare" substring is no longer a challenge marker...
    expect(detectBrowserChallenge(html, fetched.finalUrl, 'Real Article')).toBeNull();
    // ...and even if markers appeared, a content-rich page must not fall back.
    expect(assessWebFetchFallback(fetched, params, page).shouldFallback).toBe(false);
  });

  test('does not treat the Cloudflare beacon host or challenge-platform path as a challenge', () => {
    // These strings appear in ordinary Cloudflare-fronted pages (Turnstile
    // widgets, analytics, the challenge-platform script bundle) and must NOT be
    // markers — matching them flagged complete articles as challenges.
    expect(detectBrowserChallenge('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>')).toBeNull();
    expect(detectBrowserChallenge('<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>')).toBeNull();
  });

  test('falls back on a verbose challenge page regardless of boilerplate length', async () => {
    const filler = 'Please wait while we verify that you are a human and not a robot. ';
    const html = [
      '<!doctype html><html><head><title>Just a moment...</title></head><body>',
      '<form id="challenge-form"></form>',
      `<noscript>${filler.repeat(60)}</noscript>`,
      '</body></html>',
    ].join('');
    const params = expectParams(normalizeWebFetchParams({ url: 'https://example.com/app' }));
    const fetched = fetchedHtml(html);
    const page = await extractFetchedPageContent(fetched, params);

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

  test('crossHostRedirectHint is undefined for same host, set for a different host', () => {
    expect(crossHostRedirectHint('https://example.com/a', 'https://example.com/b')).toBeUndefined();
    expect(crossHostRedirectHint('https://example.com/a', 'https://www.example.com/b')).toBeUndefined();

    expect(crossHostRedirectHint('https://t.co/x', 'https://www.wsj.com/article')).toEqual({
      type: 'redirected_host',
      originalUrl: 'https://t.co/x',
      finalUrl: 'https://www.wsj.com/article',
      finalHost: 'www.wsj.com',
    });
  });

  test('isTransientNetworkError denylists deterministic faults and retries the rest', () => {
    // Deterministic transport faults fail identically on a retry — never retried.
    expect(isTransientNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe(false);
    expect(isTransientNetworkError(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(false);
    expect(isTransientNetworkError(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe(false);
    expect(isTransientNetworkError(new Error('net::ERR_UNSAFE_PORT'))).toBe(false);
    expect(isTransientNetworkError(new Error('getaddrinfo ENOTFOUND host'))).toBe(false);
    // Transient drops are retried — under the Chromium net:: shape...
    expect(isTransientNetworkError(new Error('net::ERR_CONNECTION_RESET'))).toBe(true);
    expect(isTransientNetworkError(new Error('net::ERR_NETWORK_CHANGED'))).toBe(true);
    expect(isTransientNetworkError(new Error('read ECONNRESET'))).toBe(true);
    // ...AND under a generic WHATWG rejection shape, so the retry is not silently
    // dead if session.fetch does not surface a net:: code.
    expect(isTransientNetworkError(new Error('Failed to fetch'))).toBe(true);
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true);
  });

  test('webFetchRefererForHop matches Chrome strict-origin-when-cross-origin', () => {
    // Same origin → full URL minus fragment.
    expect(webFetchRefererForHop('https://a.com/p?q=1#frag', 'https://a.com/next'))
      .toBe('https://a.com/p?q=1');
    // Cross-origin → origin only (no path/query leak).
    expect(webFetchRefererForHop('https://a.com/secret/path?token=x', 'https://b.com/'))
      .toBe('https://a.com/');
    // https→http downgrade → no Referer at all.
    expect(webFetchRefererForHop('https://a.com/p', 'http://b.com/')).toBeUndefined();
    // http→http cross-origin still sends origin only.
    expect(webFetchRefererForHop('http://a.com/p', 'http://b.com/')).toBe('http://a.com/');
  });

  test('nextSecFetchSite degrades monotonically across a redirect chain', () => {
    // First hop from the initiator: immediate relationship.
    expect(nextSecFetchSite(undefined, 'https://a.com/', 'https://a.com/2')).toBe('same-origin');
    expect(nextSecFetchSite(undefined, 'https://a.com/', 'https://b.com/')).toBe('cross-site');
    // Once cross-site, a later same-origin hop stays cross-site (chain semantics).
    expect(nextSecFetchSite('cross-site', 'https://b.com/', 'https://b.com/2')).toBe('cross-site');
    // Same-origin stays same-origin until the chain actually crosses.
    expect(nextSecFetchSite('same-origin', 'https://a.com/', 'https://a.com/2')).toBe('same-origin');
    expect(nextSecFetchSite('same-origin', 'https://a.com/', 'https://b.com/')).toBe('cross-site');
  });

  test('makeRedirectedHostHint always labels finalHost from the landing URL', () => {
    expect(makeRedirectedHostHint('https://t.co/x', 'https://www.wsj.com/article')).toEqual({
      type: 'redirected_host',
      originalUrl: 'https://t.co/x',
      finalUrl: 'https://www.wsj.com/article',
      finalHost: 'www.wsj.com',
    });
    // An unparseable landing URL keeps the raw string as the host label.
    expect(makeRedirectedHostHint('https://t.co/x', 'not a url').finalHost).toBe('not a url');
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
