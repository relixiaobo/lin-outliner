import { BrowserWindow, session as electronSession, type WebContents } from 'electron';
import type { AgentTool, AfterToolCallResult } from '@earendil-works/pi-agent-core';
import { createNodeTools, type OutlinerToolHost } from './agentNodeTools';
import {
  TOOL_RESULT_VERSION,
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';

type WebToolHint =
  | {
      type: 'login_required';
      origin: string;
      detectedVia: 'url_redirect' | 'selector_match' | 'title_keyword' | 'http_401';
    }
  | { type: 'needs_browser'; reason: 'spa_shell' | 'cloudflare' | 'http_error' }
  | { type: 'search_blocked'; reason: 'captcha' | 'rate_limit' | 'unusual_traffic'; origin: string }
  | { type: 'redirected_host'; originalUrl: string; finalUrl: string; finalHost: string };

interface WebSearchParams {
  query: string;
  limit?: number;
  site?: string;
  recency_days?: number;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
}

interface WebSearchData {
  query: string;
  effectiveQuery: string;
  provider: 'provider';
  providerName: string;
  finalUrl?: string;
  resultCount: number;
  totalResults?: number;
  truncated: boolean;
  durationMs?: number;
  hint?: WebToolHint;
  results: WebSearchResult[];
}

interface WebFetchParams {
  url: string;
  format?: 'markdown' | 'text' | 'raw' | 'metadata';
  offset?: number;
  max_chars?: number;
  query?: string;
  context?: number;
  head_limit?: number;
  match_offset?: number;
  case_insensitive?: boolean;
}

interface WebPageMetadata {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  siteName?: string;
  language?: string;
  headings?: string[];
  links?: Array<{ text: string; url: string }>;
}

interface WebFetchMatch {
  index: number;
  start: number;
  end: number;
  snippetStart: number;
  snippetEnd: number;
  snippet: string;
}

interface WebFetchData {
  url: string;
  finalUrl: string;
  statusCode: number;
  statusText?: string;
  contentType?: string;
  byteLength?: number;
  durationMs?: number;
  mode: 'read' | 'find' | 'metadata';
  format: 'markdown' | 'text' | 'raw' | 'metadata';
  title?: string;
  content?: string;
  metadata?: WebPageMetadata;
  totalChars?: number;
  returnedChars?: number;
  nextOffset?: number;
  matches?: WebFetchMatch[];
  totalMatches?: number;
  returnedMatches?: number;
  nextMatchOffset?: number;
  truncated: boolean;
  hint?: WebToolHint;
}

interface FetchTextResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  statusText: string;
  contentType: string;
  byteLength: number;
  body: string;
  redirectedHostHint?: WebToolHint;
}

const FETCH_TIMEOUT_MS = 45_000;
const MAX_FETCH_BYTES = 10 * 1024 * 1024;
const DEFAULT_FETCH_CHARS = 30_000;
const MAX_FETCH_CHARS = 100_000;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;
const GOOGLE_SEARCH_HOME_URL = 'https://www.google.com/';
const GOOGLE_SEARCH_INPUT_SELECTOR = 'textarea[name="q"], input[name="q"]';
const GOOGLE_SEARCH_RESULT_SELECTOR = '#search, #rso';
const WEB_SEARCH_PARTITION = 'persist:web-search';
const SEARCH_NAV_TIMEOUT_MS = 60_000;
const SEARCH_RATE_INTERVAL_MS = 3_000;
const SEARCH_RATE_BURST = 2;
let recentSearchStarts: number[] = [];

const WEB_FETCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: 'Absolute http(s) URL to fetch. http:// URLs are upgraded to https://.',
    },
    format: {
      type: 'string',
      enum: ['markdown', 'text', 'raw', 'metadata'],
      description: 'Output format. Default markdown.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Character offset for read mode. Default 0.',
    },
    max_chars: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_FETCH_CHARS,
      description: 'Maximum characters returned in read mode. Default 30000.',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'When set, return matching snippets instead of the full page.',
    },
    context: {
      type: 'integer',
      minimum: 0,
      maximum: 2000,
      description: 'Characters before and after each query match. Default 500.',
    },
    head_limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum matches returned in find mode. Default 10.',
    },
    match_offset: {
      type: 'integer',
      minimum: 0,
      description: 'Number of matches to skip in find mode. Default 0.',
    },
    case_insensitive: {
      type: 'boolean',
      description: 'Case-insensitive find mode. Default true.',
    },
  },
};

const WEB_SEARCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Search query. Natural language and search operators are allowed.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      description: 'Maximum results to return. Default 10, max 20.',
    },
    site: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Optional single host to scope the search to, appended as site:<host>.',
    },
    recency_days: {
      type: 'integer',
      minimum: 1,
      maximum: 3650,
      description: 'Optional freshness hint. The current provider treats this as best effort.',
    },
  },
};

export type { ToolEnvelope } from './agentToolEnvelope';

export function createAgentTools(outliner?: OutlinerToolHost): AgentTool<any>[] {
  return [
    ...(outliner ? createNodeTools(outliner) : []),
    createWebSearchTool(),
    createWebFetchTool(),
  ];
}

export function toolEnvelopeAfterToolCall(details: unknown, isError: boolean): AfterToolCallResult | undefined {
  if (isError || !isToolEnvelope(details)) return undefined;
  if (details.ok) return undefined;
  return { isError: true };
}

export function isToolEnvelope(value: unknown): value is ToolEnvelope {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; ok?: unknown; tool?: unknown; status?: unknown };
  return candidate.version === TOOL_RESULT_VERSION
    && typeof candidate.ok === 'boolean'
    && typeof candidate.tool === 'string'
    && typeof candidate.status === 'string';
}

function createWebFetchTool(): AgentTool<any, ToolEnvelope<WebFetchData>> {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description: [
      'Fetch and read a known URL. Returns extracted content directly, not a secondary-model summary.',
      'Use query/context/head_limit for find mode on large pages. Use offset/max_chars to page read mode.',
      'Use format="metadata" when you only need page title, description, headings, and links.',
      'Do not use this when you need to search for a URL first; use web_search.',
    ].join('\n'),
    parameters: WEB_FETCH_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown, signal) => {
      const params = rawParams as WebFetchParams;
      const started = Date.now();
      const validation = validateWebUrl(params.url);
      if (!validation.ok) {
        return agentToolResult(errorEnvelope('web_fetch', 'invalid_url', validation.message, {
          nextStep: 'Call web_fetch again with an absolute http(s) URL.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      try {
        const fetched = await fetchText(validation.url, signal);
        const format = params.format ?? 'markdown';
        const metadata = extractMetadata(fetched.body, fetched.finalUrl);
        const extracted = extractContent(fetched.body, fetched.contentType, fetched.finalUrl, format);
        const mode: WebFetchData['mode'] = format === 'metadata'
          ? 'metadata'
          : params.query
            ? 'find'
            : 'read';

        const warnings = fetched.redirectedHostHint ? ['The URL redirected to a different host.'] : undefined;
        if (mode === 'metadata') {
          return agentToolResult(successEnvelope('web_fetch', {
            url: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            statusCode: fetched.statusCode,
            statusText: fetched.statusText,
            contentType: fetched.contentType,
            byteLength: fetched.byteLength,
            durationMs: elapsed(started),
            mode,
            format,
            title: metadata.title,
            metadata,
            truncated: false,
            hint: fetched.redirectedHostHint,
          }, { warnings, metrics: { durationMs: elapsed(started), outputBytes: fetched.byteLength } }));
        }

        if (params.query) {
          const found = findMatches(extracted, params);
          return agentToolResult(successEnvelope('web_fetch', {
            url: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            statusCode: fetched.statusCode,
            statusText: fetched.statusText,
            contentType: fetched.contentType,
            byteLength: fetched.byteLength,
            durationMs: elapsed(started),
            mode,
            format,
            title: metadata.title,
            metadata: { title: metadata.title, canonicalUrl: metadata.canonicalUrl, siteName: metadata.siteName },
            matches: found.matches,
            totalMatches: found.totalMatches,
            returnedMatches: found.matches.length,
            nextMatchOffset: found.nextMatchOffset,
            truncated: found.nextMatchOffset !== undefined,
            hint: fetched.redirectedHostHint,
          }, {
            nextStep: found.matches.length === 0 ? 'Try a broader query or call web_fetch without query to read the page.' : undefined,
            warnings,
            metrics: { durationMs: elapsed(started), truncated: found.nextMatchOffset !== undefined, outputBytes: fetched.byteLength },
          }));
        }

        const offset = clampInteger(params.offset, 0, Number.MAX_SAFE_INTEGER, 0);
        const maxChars = clampInteger(params.max_chars, 1, MAX_FETCH_CHARS, DEFAULT_FETCH_CHARS);
        const page = sliceContent(extracted, offset, maxChars);
        return agentToolResult(successEnvelope('web_fetch', {
          url: fetched.requestedUrl,
          finalUrl: fetched.finalUrl,
          statusCode: fetched.statusCode,
          statusText: fetched.statusText,
          contentType: fetched.contentType,
          byteLength: fetched.byteLength,
          durationMs: elapsed(started),
          mode,
          format,
          title: metadata.title,
          content: page.content,
          metadata: { title: metadata.title, canonicalUrl: metadata.canonicalUrl, siteName: metadata.siteName },
          totalChars: extracted.length,
          returnedChars: page.content.length,
          nextOffset: page.nextOffset,
          truncated: page.truncated,
          hint: fetched.redirectedHostHint,
        }, {
          nextStep: page.nextOffset !== undefined ? `Call web_fetch with offset ${page.nextOffset} to continue reading.` : undefined,
          warnings,
          metrics: { durationMs: elapsed(started), truncated: page.truncated, outputBytes: fetched.byteLength },
        }));
      } catch (error) {
        if (error instanceof WebToolFailure && error.hint) {
          const format = params.format ?? 'markdown';
          const mode: WebFetchData['mode'] = format === 'metadata'
            ? 'metadata'
            : params.query
              ? 'find'
              : 'read';
          return agentToolResult(successEnvelope('web_fetch', {
            url: validation.url,
            finalUrl: error.finalUrl ?? validation.url,
            statusCode: error.statusCode ?? 0,
            statusText: error.message,
            contentType: '',
            byteLength: 0,
            durationMs: elapsed(started),
            mode,
            format,
            truncated: false,
            hint: error.hint,
          }, {
            nextStep: error.hint.type === 'login_required'
              ? 'Ask the user to sign in to this site, then retry web_fetch.'
              : 'Use a browser-backed reader path when available, or try another source with web_search.',
            metrics: { durationMs: elapsed(started) },
          }));
        }
        return agentToolResult(errorEnvelope('web_fetch', classifyWebError(error), errorMessage(error), {
          nextStep: 'Retry once if this looks transient. If it still fails, use web_search for another source.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
    },
  };
}

function createWebSearchTool(): AgentTool<any, ToolEnvelope<WebSearchData>> {
  return {
    name: 'web_search',
    label: 'Web Search',
    description: [
      'Search the web for current external information. Use this when you do not already have a specific URL.',
      'Returns source URLs, titles, and snippets. Use web_fetch on a result URL when more detail is needed.',
      'Use site for one-host searches. Use recency_days only as a freshness hint.',
    ].join('\n'),
    parameters: WEB_SEARCH_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown, signal) => {
      const params = rawParams as WebSearchParams;
      const started = Date.now();
      const query = params.query.trim();
      if (!query) {
        return agentToolResult(errorEnvelope('web_search', 'invalid_args', 'query is required', {
          nextStep: 'Call web_search again with a non-empty query.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const limit = clampInteger(params.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
      const effectiveQuery = buildEffectiveSearchQuery(query, params.site);
      const searchUrl = buildGoogleSearchUrl(effectiveQuery);

      try {
        const search = await searchGoogle(searchUrl, signal);
        if (search.kind === 'hint') {
          return agentToolResult(successEnvelope('web_search', {
            query,
            effectiveQuery,
            provider: 'provider',
            providerName: 'google_serp',
            finalUrl: search.finalUrl,
            resultCount: 0,
            truncated: false,
            durationMs: elapsed(started),
            hint: search.hint,
            results: [],
          }, {
            nextStep: search.hint.type === 'search_blocked'
              ? 'Pause searches for a few minutes, ask the user to clear the search challenge, or use a direct URL with web_fetch.'
              : 'Try again, or use a direct URL with web_fetch if one is known.',
            metrics: { durationMs: elapsed(started) },
          }));
        }
        if (search.kind === 'error') {
          return agentToolResult(errorEnvelope('web_search', search.code, search.message, {
            data: {
              query,
              effectiveQuery,
              provider: 'provider',
              providerName: 'google_serp',
              finalUrl: search.finalUrl,
              resultCount: 0,
              truncated: false,
              durationMs: elapsed(started),
              results: [],
            } satisfies WebSearchData,
            nextStep: 'Retry once if this looks transient. If it still fails, try a more specific query or direct URL.',
            metrics: { durationMs: elapsed(started) },
          }));
        }

        const allResults = search.results;
        const results = allResults.slice(0, limit);
        const truncated = allResults.length > results.length;
        const warnings = params.recency_days
          ? ['recency_days is best-effort with the current search provider. Verify dates with web_fetch when freshness matters.']
          : undefined;

        return agentToolResult(successEnvelope('web_search', {
          query,
          effectiveQuery,
          provider: 'provider',
          providerName: 'google_serp',
          finalUrl: search.finalUrl,
          resultCount: results.length,
          totalResults: allResults.length,
          truncated,
          durationMs: elapsed(started),
          results,
        }, {
          nextStep: results.length === 0 ? 'Try a broader query or remove site/recency constraints.' : undefined,
          warnings,
          metrics: { durationMs: elapsed(started), truncated, outputBytes: search.htmlBytes },
        }));
      } catch (error) {
        return agentToolResult(errorEnvelope('web_search', classifyWebError(error), errorMessage(error), {
          nextStep: 'Retry once if this looks transient. If it still fails, try a more specific query or direct URL.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
    },
  };
}

interface ValidUrl {
  ok: true;
  url: string;
}

interface InvalidUrl {
  ok: false;
  message: string;
}

function validateWebUrl(raw: string): ValidUrl | InvalidUrl {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, message: 'url is required' };
  }
  if (raw.length > 2000) {
    return { ok: false, message: 'url exceeds 2000 characters' };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: `invalid URL: ${raw}` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: `unsupported scheme: ${parsed.protocol}` };
  }

  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  }
  return { ok: true, url: parsed.toString() };
}

async function fetchText(url: string, signal?: AbortSignal): Promise<FetchTextResult> {
  const startedUrl = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort('parent_aborted');
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await electronSession.defaultSession.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Lin Outliner/0.1 web_fetch',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.4',
        'accept-language': 'en-US,en;q=0.9',
      },
    });

    const finalUrl = response.url || url;
    if (response.status === 401) {
      throw new WebToolFailure('http_401', `authentication required for ${originOf(finalUrl)}`, {
        finalUrl,
        statusCode: response.status,
        hint: {
          type: 'login_required',
          origin: originOf(finalUrl),
          detectedVia: 'http_401',
        },
      });
    }
    if (!response.ok) {
      throw new WebToolFailure('http_error', `HTTP ${response.status} ${response.statusText || ''}`.trim(), {
        finalUrl,
        statusCode: response.status,
        hint: { type: 'needs_browser', reason: 'http_error' },
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (isBinaryContentType(contentType)) {
      throw new WebToolFailure('binary_unsupported', `binary content is not supported: ${contentType}`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_BYTES) {
      throw new WebToolFailure('response_too_large', `response exceeds ${MAX_FETCH_BYTES} bytes`);
    }

    const bodyResult = await readBoundedText(response, MAX_FETCH_BYTES);
    const startedHost = hostOf(startedUrl);
    const finalHost = hostOf(finalUrl);
    const redirectedHostHint = startedHost && finalHost && startedHost !== finalHost
      ? {
          type: 'redirected_host' as const,
          originalUrl: startedUrl,
          finalUrl,
          finalHost,
        }
      : undefined;

    return {
      requestedUrl: startedUrl,
      finalUrl,
      statusCode: response.status,
      statusText: response.statusText,
      contentType,
      byteLength: bodyResult.bytes,
      body: bodyResult.text,
      redirectedHostHint,
    };
  } catch (error) {
    if (error instanceof WebToolFailure) throw error;
    if (controller.signal.aborted) {
      const reason = controller.signal.reason === 'timeout'
        ? `timed out after ${FETCH_TIMEOUT_MS}ms`
        : 'request aborted';
      throw new WebToolFailure(controller.signal.reason === 'timeout' ? 'timeout' : 'aborted', reason);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!response.body) return { text: '', bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // no-op
      }
      throw new WebToolFailure('response_too_large', `response exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { text, bytes: total };
}

function extractContent(body: string, contentType: string, finalUrl: string, format: WebFetchData['format']): string {
  if (format === 'raw') return body;
  if (format === 'metadata') return '';
  if (!contentType.toLowerCase().includes('html')) {
    return body.trim();
  }
  return format === 'text'
    ? htmlToText(body)
    : htmlToMarkdown(body, finalUrl);
}

function extractMetadata(html: string, finalUrl: string): WebPageMetadata {
  const language = matchFirst(html, /<html[^>]*\slang=["']?([^"'\s>]+)/i);
  const title = cleanText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '');
  const description = getMetaContent(html, 'description');
  const siteName = getMetaContent(html, 'og:site_name');
  const canonicalUrl = getLinkHref(html, 'canonical') ?? finalUrl;
  const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => cleanText(stripTags(match[2] ?? '')))
    .filter(Boolean)
    .slice(0, 30);
  const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      text: cleanText(stripTags(match[2] ?? '')),
      url: absolutizeUrl(decodeHtml(match[1] ?? ''), finalUrl),
    }))
    .filter((link) => link.text && link.url)
    .slice(0, 80);

  return {
    title: title || undefined,
    description: description || undefined,
    canonicalUrl,
    siteName: siteName || undefined,
    language: language || undefined,
    headings,
    links,
  };
}

function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_match, code) => `\n\n\`\`\`\n${decodeHtml(stripTags(code))}\n\`\`\`\n\n`)
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_match, value) => `\n\n# ${cleanText(stripTags(value))}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_match, value) => `\n\n## ${cleanText(stripTags(value))}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_match, value) => `\n\n### ${cleanText(stripTags(value))}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, value) => `\n- ${cleanText(stripTags(value))}`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
      const textLabel = cleanText(stripTags(label));
      const url = absolutizeUrl(decodeHtml(href), baseUrl);
      if (!textLabel) return '';
      return url ? `[${textLabel}](${url})` : textLabel;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|blockquote|tr|table|ul|ol)>/gi, '\n\n');

  text = stripTags(text);
  return cleanMarkdown(decodeHtml(text));
}

function htmlToText(html: string): string {
  return cleanText(decodeHtml(stripTags(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|blockquote|tr|li)>/gi, '\n'),
  )));
}

function findMatches(content: string, params: WebFetchParams): {
  matches: WebFetchMatch[];
  totalMatches: number;
  nextMatchOffset?: number;
} {
  const query = params.query ?? '';
  const caseInsensitive = params.case_insensitive ?? true;
  const contextChars = clampInteger(params.context, 0, 2000, 500);
  const headLimit = clampInteger(params.head_limit, 1, 50, 10);
  const matchOffset = clampInteger(params.match_offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const haystack = caseInsensitive ? content.toLowerCase() : content;
  const needle = caseInsensitive ? query.toLowerCase() : query;
  const all: WebFetchMatch[] = [];

  let cursor = 0;
  while (needle && cursor <= haystack.length) {
    const start = haystack.indexOf(needle, cursor);
    if (start === -1) break;
    const end = start + needle.length;
    const snippetStart = Math.max(0, start - contextChars);
    const snippetEnd = Math.min(content.length, end + contextChars);
    all.push({
      index: all.length,
      start,
      end,
      snippetStart,
      snippetEnd,
      snippet: content.slice(snippetStart, snippetEnd),
    });
    cursor = end;
  }

  const matches = all.slice(matchOffset, matchOffset + headLimit);
  const nextMatchOffset = matchOffset + matches.length < all.length
    ? matchOffset + matches.length
    : undefined;
  return { matches, totalMatches: all.length, nextMatchOffset };
}

function sliceContent(content: string, offset: number, maxChars: number): {
  content: string;
  truncated: boolean;
  nextOffset?: number;
} {
  const start = Math.min(offset, content.length);
  const sliced = content.slice(start, start + maxChars);
  const nextOffset = start + sliced.length < content.length ? start + sliced.length : undefined;
  return {
    content: sliced,
    truncated: nextOffset !== undefined,
    nextOffset,
  };
}

function buildEffectiveSearchQuery(query: string, site?: string): string {
  const trimmedSite = site?.trim();
  if (!trimmedSite) return query;
  const host = trimmedSite.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host) return query;
  return `${query} site:${host}`;
}

function buildGoogleSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query });
  return `https://www.google.com/search?${params.toString()}`;
}

type GoogleSearchOutcome =
  | { kind: 'ok'; finalUrl: string; results: WebSearchResult[]; htmlBytes: number }
  | { kind: 'hint'; finalUrl: string; hint: WebToolHint }
  | { kind: 'error'; finalUrl?: string; code: string; message: string };

async function searchGoogle(searchUrl: string, signal?: AbortSignal): Promise<GoogleSearchOutcome> {
  const query = googleQueryFromSearchUrl(searchUrl);
  if (!query) {
    return { kind: 'error', code: 'invalid_args', message: 'missing search query', finalUrl: searchUrl };
  }

  try {
    await waitForSearchRateLimit(signal);
  } catch {
    return { kind: 'error', code: 'rate_limited', message: 'search aborted while rate-limited', finalUrl: searchUrl };
  }

  const window = createWebSearchWindow();
  const onAbort = () => {
    try {
      if (!window.isDestroyed()) {
        window.webContents.stop();
        window.destroy();
      }
    } catch {
      // no-op
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      await navigateAndWait(window.webContents, GOOGLE_SEARCH_HOME_URL, {
        timeoutMs: SEARCH_NAV_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      return {
        kind: 'error',
        code: classifyWebError(error),
        message: errorMessage(error),
        finalUrl: window.webContents.getURL() || GOOGLE_SEARCH_HOME_URL,
      };
    }

    const inputReady = await waitForSelector(window.webContents, GOOGLE_SEARCH_INPUT_SELECTOR, 5_000, signal);
    if (!inputReady) {
      const finalUrl = window.webContents.getURL() || GOOGLE_SEARCH_HOME_URL;
      const hint = await detectSearchVerification(window.webContents, finalUrl);
      if (hint) return { kind: 'hint', finalUrl, hint };
      return { kind: 'error', code: 'extraction_failed', message: 'Google search input did not appear', finalUrl };
    }

    const submitted = await submitGoogleSearch(window.webContents, query);
    if (!submitted) {
      return {
        kind: 'error',
        code: 'extraction_failed',
        message: 'failed to submit Google search form',
        finalUrl: window.webContents.getURL() || GOOGLE_SEARCH_HOME_URL,
      };
    }

    const reachedResults = await waitForGoogleSearchOutcome(window.webContents, signal);
    const finalUrl = window.webContents.getURL() || searchUrl;
    const hint = await detectSearchVerification(window.webContents, finalUrl);
    if (hint) return { kind: 'hint', finalUrl, hint };
    if (!reachedResults) {
      return {
        kind: 'hint',
        finalUrl,
        hint: { type: 'needs_browser', reason: 'spa_shell' },
      };
    }

    await gentlyScrollSearchResults(window.webContents);
    const payload = await safeExecuteJs<{ htmlLength: number; results: WebSearchResult[] }>(
      window.webContents,
      googleSerpExtractorExpression(),
    );
    if (!payload) {
      return { kind: 'error', code: 'extraction_failed', message: 'could not extract Google results', finalUrl };
    }
    return {
      kind: 'ok',
      finalUrl,
      results: payload.results,
      htmlBytes: payload.htmlLength,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

async function waitForSearchRateLimit(signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  recentSearchStarts = recentSearchStarts.filter((timestamp) => now - timestamp < SEARCH_RATE_INTERVAL_MS);
  if (recentSearchStarts.length >= SEARCH_RATE_BURST) {
    const waitMs = SEARCH_RATE_INTERVAL_MS - (now - recentSearchStarts[0]);
    await delay(Math.max(0, waitMs), signal);
  }
  recentSearchStarts.push(Date.now());
}

function createWebSearchWindow(): BrowserWindow {
  return new BrowserWindow({
    x: -20_000,
    y: -20_000,
    width: 1280,
    height: 900,
    show: false,
    title: 'Lin Outliner Web Search',
    webPreferences: {
      session: electronSession.fromPartition(WEB_SEARCH_PARTITION),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

function googleQueryFromSearchUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('q');
  } catch {
    return null;
  }
}

async function waitForSelector(
  webContents: WebContents,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) return false;
    const found = await safeExecuteJs<boolean>(
      webContents,
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    );
    if (found) return true;
    await delay(100, signal);
  }
  return false;
}

async function submitGoogleSearch(webContents: WebContents, query: string): Promise<boolean> {
  return await safeExecuteJs<boolean>(
    webContents,
    `
      (() => {
        const input = document.querySelector(${JSON.stringify(GOOGLE_SEARCH_INPUT_SELECTOR)});
        if (!input) return false;
        input.focus();
        input.value = ${JSON.stringify(query)};
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(query)} }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const form = input.closest("form");
        if (form) {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
          return true;
        }
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        return true;
      })()
    `,
  ) === true;
}

async function waitForGoogleSearchOutcome(webContents: WebContents, signal?: AbortSignal): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < SEARCH_NAV_TIMEOUT_MS) {
    if (signal?.aborted) return false;
    const state = await safeExecuteJs<{ hasResults: boolean; verification: boolean }>(
      webContents,
      `
        (() => ({
          hasResults: Boolean(document.querySelector(${JSON.stringify(GOOGLE_SEARCH_RESULT_SELECTOR)})),
          verification: Boolean(
            document.querySelector("#captcha, [id*='captcha'], [class*='captcha'], #challenge-form") ||
            document.body?.innerText?.includes("Our systems have detected unusual traffic") ||
            document.body?.innerText?.includes("automated queries") ||
            document.title?.includes("Just a moment")
          ),
        }))()
      `,
    );
    if (state?.hasResults) return true;
    if (state?.verification || looksLikeSearchVerificationChallenge('', webContents.getURL())) return false;
    await delay(250, signal);
  }
  return false;
}

async function detectSearchVerification(webContents: WebContents, finalUrl: string): Promise<WebToolHint | null> {
  const payload = await safeExecuteJs<{ title: string; html: string; text: string }>(
    webContents,
    `({
      title: document.title || "",
      html: document.documentElement ? document.documentElement.outerHTML : "",
      text: document.body ? document.body.innerText : "",
    })`,
  );
  const html = payload?.html ?? '';
  const text = payload?.text ?? '';
  const title = payload?.title ?? '';
  if (!looksLikeSearchVerificationChallenge(html, finalUrl, title, text)) return null;
  if (text.includes('unusual traffic') || text.includes('automated queries')) {
    return { type: 'search_blocked', reason: 'unusual_traffic', origin: originOf(finalUrl) };
  }
  return { type: 'search_blocked', reason: 'captcha', origin: originOf(finalUrl) };
}

async function gentlyScrollSearchResults(webContents: WebContents): Promise<void> {
  await safeExecuteJs<void>(
    webContents,
    `
      new Promise((resolve) => {
        const step = Math.max(400, Math.floor(window.innerHeight * 0.75));
        let count = 0;
        const tick = () => {
          window.scrollTo({ top: window.scrollY + step, behavior: "smooth" });
          count += 1;
          if (count >= 2) setTimeout(resolve, 250);
          else setTimeout(tick, 350);
        };
        tick();
      })
    `,
  );
}

function googleSerpExtractorExpression(): string {
  return `
    (() => {
      const root = document.querySelector("#search") || document.querySelector("#rso") || document;
      const seen = new Set();
      const results = [];
      const normalizeHref = (href) => {
        if (!href) return null;
        try {
          const url = new URL(href, "https://www.google.com");
          if (url.pathname === "/url") {
            return url.searchParams.get("q") || url.searchParams.get("url");
          }
          if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
        } catch {
          return null;
        }
        return null;
      };
      const textOf = (node) => (node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim();
      for (const h3 of Array.from(root.querySelectorAll("h3"))) {
        if (results.length >= ${MAX_SEARCH_LIMIT}) break;
        const anchor = h3.closest("a");
        const url = normalizeHref(anchor?.getAttribute("href"));
        if (!url || seen.has(url)) continue;
        try {
          const parsed = new URL(url);
          if (/(^|\\.)google\\.[a-z.]+$/i.test(parsed.hostname)) continue;
          if (/(googleusercontent|webcache\\.googleusercontent|translate\\.google)/i.test(parsed.hostname)) continue;
        } catch {
          continue;
        }
        const title = textOf(h3);
        if (!title) continue;
        const container = anchor.closest("div");
        const fullText = textOf(container);
        const anchorText = textOf(anchor);
        const remaining = anchorText && fullText.startsWith(anchorText)
          ? fullText.slice(anchorText.length).trim()
          : fullText;
        seen.add(url);
        results.push({
          title,
          url,
          snippet: remaining.length > 400 ? remaining.slice(0, 400).trim() + "..." : remaining,
          source: (() => {
            try { return new URL(url).host; } catch { return undefined; }
          })(),
        });
      }
      return {
        htmlLength: document.documentElement?.outerHTML?.length || 0,
        results,
      };
    })()
  `;
}

function looksLikeSearchVerificationChallenge(html: string, finalUrl: string, title = '', text = ''): boolean {
  try {
    const url = new URL(finalUrl);
    if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname.startsWith('/sorry')) {
      return true;
    }
  } catch {
    // fall through to text sniffing
  }
  const haystack = `${title}\n${text}\n${html}`;
  return haystack.includes('automated queries')
    || haystack.includes('Our systems have detected unusual traffic')
    || haystack.includes('To continue, please type the characters below')
    || haystack.includes('g-recaptcha')
    || haystack.includes('www.google.com/recaptcha')
    || haystack.includes('id="captcha"')
    || haystack.includes('cf-browser-verification')
    || haystack.includes('id="challenge-form"')
    || title.includes('Just a moment');
}

interface NavigateAndWaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

function navigateAndWait(webContents: WebContents, url: string, options: NavigateAndWaitOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      webContents.off('did-finish-load', onLoad);
      webContents.off('did-fail-load', onFail);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const onLoad = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onFail = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || settled) return;
      if (errorCode === -3) return;
      settled = true;
      cleanup();
      reject(new WebToolFailure('navigation_failed', `navigation failed: ${errorCode} ${errorDescription}`));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new WebToolFailure('aborted', 'navigation aborted'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new WebToolFailure('timeout', `navigation timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    webContents.on('did-finish-load', onLoad);
    webContents.on('did-fail-load', onFail);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    webContents.loadURL(url).catch((error: unknown) => {
      if (settled) return;
      if (isSupersededNavigationError(error)) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function isSupersededNavigationError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === -3 || code === 'ERR_ABORTED') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ERR_ABORTED') || message.includes('(-3)');
}

async function safeExecuteJs<T>(webContents: WebContents, expression: string): Promise<T | null> {
  try {
    return await webContents.executeJavaScript(expression) as T;
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WebToolFailure('aborted', 'request aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new WebToolFailure('aborted', 'request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isBinaryContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  if (!value) return false;
  if (value.startsWith('text/')) return false;
  if (value.includes('html') || value.includes('json') || value.includes('xml')) return false;
  if (value.includes('javascript') || value.includes('ecmascript')) return false;
  return true;
}

function getMetaContent(html: string, name: string): string | undefined {
  const escaped = escapeRegExp(name);
  const byName = matchFirst(
    html,
    new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*content=["']([^"']*)["'][^>]*>`, 'i'),
  );
  if (byName) return cleanText(byName);
  return undefined;
}

function getLinkHref(html: string, rel: string): string | undefined {
  const escaped = escapeRegExp(rel);
  return matchFirst(
    html,
    new RegExp(`<link\\b(?=[^>]*rel=["'][^"']*${escaped}[^"']*["'])[^>]*href=["']([^"']+)["'][^>]*>`, 'i'),
  );
}

function matchFirst(input: string, pattern: RegExp): string | undefined {
  return input.match(pattern)?.[1];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, ' ');
}

function cleanText(value: string): string {
  return decodeHtml(value).replace(/\s+/g, ' ').trim();
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const radix = body[1]?.toLowerCase() === 'x' ? 16 : 10;
      const raw = radix === 16 ? body.slice(2) : body.slice(1);
      const codePoint = Number.parseInt(raw, radix);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

function absolutizeUrl(url: string, baseUrl: string): string {
  if (!url || url.startsWith('#') || url.startsWith('javascript:') || url.startsWith('mailto:')) return '';
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return '';
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function elapsed(started: number): number {
  return Math.max(0, Date.now() - started);
}

function classifyWebError(error: unknown): string {
  if (error instanceof WebToolFailure) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'network_error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class WebToolFailure extends Error {
  readonly finalUrl?: string;
  readonly statusCode?: number;
  readonly hint?: WebToolHint;

  constructor(
    readonly code: string,
    message: string,
    details: { finalUrl?: string; statusCode?: number; hint?: WebToolHint } = {},
  ) {
    super(message);
    this.name = 'WebToolFailure';
    this.finalUrl = details.finalUrl;
    this.statusCode = details.statusCode;
    this.hint = details.hint;
  }
}
