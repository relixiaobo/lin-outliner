import type { ExtractedPageContent } from './agentWebFetchContent';
import type { FetchTextResult, NormalizedWebFetchParams, WebToolHint } from './agentWebTools';

export interface WebFetchFallbackDecision {
  shouldFallback: boolean;
  reason?: Extract<WebToolHint, { type: 'needs_browser' }>['reason'];
  detail?: string;
}

export function assessWebFetchFallback(
  fetched: FetchTextResult,
  params: NormalizedWebFetchParams,
  page: ExtractedPageContent,
): WebFetchFallbackDecision {
  if (params.format === 'raw') return noFallback();
  if (!isHtmlContentType(fetched.contentType)) return noFallback();

  const challenge = detectBrowserChallenge(fetched.body, fetched.finalUrl, page.metadata.title);
  // A challenge marker means the interstitial JS/HTML reached us instead of the
  // page, so the only correct move is to render it in the browser. The markers
  // are kept narrow (see detectBrowserChallenge) precisely so a full article that
  // merely embeds a Cloudflare beacon never lands here — gating on a content-
  // length threshold would instead silently keep a verbose challenge page whose
  // boilerplate clears the threshold.
  if (challenge) {
    return { shouldFallback: true, reason: challenge, detail: 'browser_challenge' };
  }

  const contentLength = normalizedTextLength(page.content);
  const visibleBodyLength = visibleHtmlTextLength(fetched.body);
  const shell = looksLikeDynamicHtmlShell(fetched.body);
  const hasMetadata = Boolean(
    page.metadata.title
    || page.metadata.description
    || page.metadata.headings?.length
    || page.metadata.links?.length,
  );

  if (params.mode === 'find' && params.query && shell && !contentIncludesQuery(page.content, params)) {
    return { shouldFallback: true, reason: 'spa_shell', detail: 'find_miss_on_shell' };
  }

  if (shell && contentLength < 1_000) {
    return { shouldFallback: true, reason: 'spa_shell', detail: 'low_content_shell' };
  }

  if (contentLength < 160 && visibleBodyLength < 300 && hasMetadata && looksScriptHeavy(fetched.body)) {
    return { shouldFallback: true, reason: 'spa_shell', detail: 'metadata_only_shell' };
  }

  if (contentLength === 0 && fetched.byteLength > 500 && looksScriptHeavy(fetched.body)) {
    return { shouldFallback: true, reason: 'spa_shell', detail: 'empty_script_heavy_html' };
  }

  return noFallback();
}

export function fallbackHint(reason: WebFetchFallbackDecision['reason']): WebToolHint | undefined {
  return reason ? { type: 'needs_browser', reason } : undefined;
}

export function shouldTryBrowserFallbackForHttpFailure(
  statusCode: number | undefined,
  hint: WebToolHint | undefined,
  format: NormalizedWebFetchParams['format'],
): boolean {
  if (format === 'raw') return false;
  if (!hint || hint.type !== 'needs_browser') return false;
  if (hint.reason === 'cloudflare' || hint.reason === 'spa_shell' || hint.reason === 'verification') return true;
  return statusCode === 403 || statusCode === 429 || statusCode === 503;
}

export function detectBrowserChallenge(
  html: string,
  finalUrl = '',
  title = '',
  text = '',
): Extract<WebToolHint, { type: 'needs_browser' }>['reason'] | null {
  const haystack = `${title}\n${text}\n${html}`.toLowerCase();
  if (!haystack) return null;
  const hasExplicitVerificationPhrase = haystack.includes('please wait for verification')
    || haystack.includes('please wait while we verify')
    || haystack.includes('verify you are a human')
    || haystack.includes('verify that you are a human')
    || haystack.includes('human verification')
    || haystack.includes('security verification');
  const hasDataDomeMarker = /\b(?:datadome|x-datadome)\b/.test(haystack);
  if (
    haystack.includes('cf-browser-verification')
    || haystack.includes('cf-chl-')
    || haystack.includes('cf_chl_')
    || haystack.includes('_cf_chl')
    || haystack.includes('checking your browser')
    || haystack.includes('just a moment')
    || haystack.includes('attention required')
    || haystack.includes('ddos protection')
    || haystack.includes('challenge-form')
    || haystack.includes('g-recaptcha')
    || haystack.includes('hcaptcha')
  ) {
    return 'cloudflare';
  }
  if (
    hasExplicitVerificationPhrase
    || (hasDataDomeMarker && (haystack.includes('verification') || haystack.includes('verify') || haystack.includes('captcha')))
  ) {
    return 'verification';
  }
  // NOTE: markers are deliberately narrow. A bare "cloudflare" substring, the
  // "challenge-platform" script path, and the "challenges.cloudflare.com" /
  // cloudflareinsights.com beacon hosts are NOT markers: those strings are
  // embedded in ordinary Cloudflare-fronted pages (Turnstile widgets, analytics)
  // and matching them flagged complete articles as challenges. The retained
  // `*cf_chl*` tokens and the visible interstitial phrases only appear on the
  // actual block page.

  try {
    const url = new URL(finalUrl);
    if (/challenge|captcha|cdn-cgi/i.test(url.pathname)) return 'cloudflare';
  } catch {
    // fall through
  }
  return null;
}

export function looksLikeDynamicHtmlShell(html: string): boolean {
  const lower = html.toLowerCase();
  const visibleLength = visibleHtmlTextLength(html);
  const rootMarker = /<[^>]+\bid=["'](?:root|app|__next|___gatsby|svelte|nuxt)["']/i.test(html);
  const hydrationMarker = lower.includes('__next_data__')
    || lower.includes('window.__nuxt__')
    || lower.includes('data-reactroot')
    || lower.includes('hydrateroot')
    || lower.includes('createroot(')
    || lower.includes('vite/client')
    || lower.includes('webpackjsonp');
  return (rootMarker && visibleLength < 1_000)
    || (hydrationMarker && visibleLength < 1_500)
    || (looksScriptHeavy(html) && visibleLength < 300);
}

// web_fetch follows redirects across hosts transparently (link shorteners,
// trackers, regional/mobile subdomains). When the landing host differs from the
// requested one, surface a non-fatal redirected_host hint + warning rather than
// failing — the content still comes back and finalUrl reflects the real page.
export function crossHostRedirectHint(
  startedUrl: string,
  finalUrl: string,
): Extract<WebToolHint, { type: 'redirected_host' }> | undefined {
  if (isPermittedWebFetchRedirect(startedUrl, finalUrl)) return undefined;
  return makeRedirectedHostHint(startedUrl, finalUrl);
}

// Single builder for the redirected_host hint shape so the soft-hint path
// (crossHostRedirectHint, attached to a successful cross-host landing) and the
// hard-failure path (a redirect refused for an invalid target) never
// drift in how they label finalHost.
export function makeRedirectedHostHint(
  originalUrl: string,
  finalUrl: string,
): Extract<WebToolHint, { type: 'redirected_host' }> {
  let finalHost = finalUrl;
  try {
    finalHost = new URL(finalUrl).host;
  } catch {
    // keep the raw URL as the host label when it cannot be parsed
  }
  return { type: 'redirected_host', originalUrl, finalUrl, finalHost };
}

// Decide whether a RAW network throw earns the single automatic retry. By the
// time this is reached the caller has already excluded HTTP responses (403/429/
// 5xx, Cloudflare — they arrive as WebToolFailure and route to the browser
// fallback) and aborts, so the input is a transport-level throw.
//
// Structured as a deterministic DENYLIST rather than a transient WHITELIST on
// purpose: Electron's session.fetch may reject with a Chromium 'net::ERR_*' code
// OR a generic WHATWG 'Failed to fetch', and a whitelist keyed on net:: codes
// would silently never fire under the generic shape (the retry feature would be
// dead in production while unit tests — which mock net:: strings — stay green).
// A denylist works under both shapes: it refuses exactly the faults that fail
// identically on a retry (DNS NXDOMAIN, refused connection, TLS/cert, unsafe/
// blocked port, bad scheme) and retries everything else once, bounded.
export function isTransientNetworkError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toUpperCase();
  return !/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_CERT|ERR_SSL|ERR_BAD_SSL|ERR_UNSAFE_PORT|ERR_DISALLOWED_URL_SCHEME|ERR_UNKNOWN_URL_SCHEME|ERR_BLOCKED_BY|ERR_INVALID_URL|ERR_INVALID_ARGUMENT|ENOTFOUND|ECONNREFUSED|EPROTO/.test(message);
}

// Approximate Chrome's default Referrer-Policy (strict-origin-when-cross-origin)
// for a redirect hop, so the request reads as a real browser navigation instead
// of leaking the full referrer path/query to a third party or over plaintext.
// Returns undefined when no Referer header should be sent.
export function webFetchRefererForHop(referrerUrl: string, currentUrl: string): string | undefined {
  let referrer: URL;
  let current: URL;
  try {
    referrer = new URL(referrerUrl);
    current = new URL(currentUrl);
  } catch {
    return undefined;
  }
  // Drop the Referer entirely on a secure→insecure downgrade (https→http).
  if (referrer.protocol === 'https:' && current.protocol === 'http:') return undefined;
  // Same origin keeps the full URL (minus fragment); a cross-origin hop sends
  // only the origin, exactly as Chrome does by default.
  if (referrer.origin === current.origin) {
    referrer.hash = '';
    return referrer.toString();
  }
  return `${referrer.origin}/`;
}

// Chrome's Sec-Fetch-Site degrades monotonically across a redirect chain: once
// the chain has crossed origin it stays 'cross-site' for every later hop, even if
// a subsequent hop lands back on an earlier origin. (Only same-origin/cross-site
// is modeled; the same-site tier needs a public-suffix list and is not worth one
// here.) `previous` is the value that applied to the hop we are redirecting FROM.
export function nextSecFetchSite(
  previous: 'same-origin' | 'cross-site' | undefined,
  fromUrl: string,
  toUrl: string,
): 'same-origin' | 'cross-site' {
  if (previous === 'cross-site') return 'cross-site';
  try {
    return new URL(fromUrl).origin === new URL(toUrl).origin ? 'same-origin' : 'cross-site';
  } catch {
    return 'cross-site';
  }
}

export function isPermittedWebFetchRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const original = new URL(originalUrl);
    const redirect = new URL(redirectUrl);
    if (redirect.protocol !== original.protocol) return false;
    if (redirect.port !== original.port) return false;
    if (redirect.username || redirect.password) return false;
    return stripWww(original.hostname) === stripWww(redirect.hostname);
  } catch {
    return false;
  }
}

export function browserFallbackLooksUseful(
  httpPage: ExtractedPageContent,
  browserPage: ExtractedPageContent,
  httpDecision: WebFetchFallbackDecision,
  browserDecision: WebFetchFallbackDecision,
  params: NormalizedWebFetchParams,
): boolean {
  const httpLength = normalizedTextLength(httpPage.content);
  const browserLength = normalizedTextLength(browserPage.content);
  if (params.mode === 'metadata') {
    return metadataScore(browserPage) > metadataScore(httpPage);
  }
  if (httpDecision.shouldFallback && !browserDecision.shouldFallback && browserLength >= 100) return true;
  if (browserLength >= Math.max(httpLength + 200, 400)) return true;
  if (params.mode === 'find' && params.query && contentIncludesQuery(browserPage.content, params)) return true;
  return false;
}

function noFallback(): WebFetchFallbackDecision {
  return { shouldFallback: false };
}

function isHtmlContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('html');
}

function looksScriptHeavy(html: string): boolean {
  const scriptCount = html.match(/<script\b/gi)?.length ?? 0;
  const visibleLength = visibleHtmlTextLength(html);
  return scriptCount >= 4 && visibleLength < 800;
}

function visibleHtmlTextLength(html: string): number {
  return normalizedTextLength(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<template[\s\S]*?<\/template>/gi, '')
      .replace(/<svg[\s\S]*?<\/svg>/gi, '')
      .replace(/<[^>]+>/g, ' '),
  );
}

function normalizedTextLength(value: string): number {
  return value.replace(/\s+/g, ' ').trim().length;
}

function contentIncludesQuery(content: string, params: Pick<NormalizedWebFetchParams, 'query' | 'caseInsensitive'>): boolean {
  const query = params.query ?? '';
  if (!query) return false;
  const haystack = params.caseInsensitive ? content.toLowerCase() : content;
  const needle = params.caseInsensitive ? query.toLowerCase() : query;
  return haystack.includes(needle);
}

function metadataScore(page: ExtractedPageContent): number {
  return Number(Boolean(page.metadata.title))
    + Number(Boolean(page.metadata.description))
    + (page.metadata.headings?.length ?? 0)
    + Math.min(5, page.metadata.links?.length ?? 0);
}

function stripWww(hostname: string): string {
  return hostname.replace(/^www\./i, '');
}
