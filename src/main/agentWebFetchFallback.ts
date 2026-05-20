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
  if (hint.reason === 'cloudflare' || hint.reason === 'spa_shell') return true;
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
  if (
    haystack.includes('cf-browser-verification')
    || haystack.includes('cf-chl-')
    || haystack.includes('cf_chl_')
    || haystack.includes('cloudflare')
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
