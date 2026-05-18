import {
  successEnvelope,
  type ToolEnvelope,
  type ToolMetrics,
} from './agentToolEnvelope';

export type WebToolHint =
  | {
      type: 'login_required';
      origin: string;
      detectedVia: 'url_redirect' | 'selector_match' | 'title_keyword' | 'http_401';
    }
  | { type: 'needs_browser'; reason: 'spa_shell' | 'cloudflare' | 'http_error' }
  | { type: 'search_blocked'; reason: 'captcha' | 'rate_limit' | 'unusual_traffic'; origin: string }
  | { type: 'redirected_host'; originalUrl: string; finalUrl: string; finalHost: string };

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
}

export interface WebSearchData {
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

export interface WebPageMetadata {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  siteName?: string;
  language?: string;
  headings?: string[];
  links?: Array<{ text: string; url: string }>;
}

export interface WebFetchMatch {
  index: number;
  start: number;
  end: number;
  snippetStart: number;
  snippetEnd: number;
  snippet: string;
}

export interface WebFetchData {
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

export interface FetchTextResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  statusText: string;
  contentType: string;
  byteLength: number;
  body: string;
  redirectedHostHint?: WebToolHint;
}

export interface NormalizedWebSearchParams {
  query: string;
  limit: number;
  effectiveQuery: string;
  searchUrl: string;
  site?: string;
  recencyDays?: number;
}

export interface NormalizedWebFetchParams {
  url: string;
  format: WebFetchData['format'];
  mode: WebFetchData['mode'];
  offset: number;
  maxChars: number;
  context: number;
  headLimit: number;
  matchOffset: number;
  caseInsensitive: boolean;
  query?: string;
}

export type WebParamResult<T> =
  | { ok: true; params: T }
  | { ok: false; code: 'invalid_args' | 'invalid_url'; message: string; instructions: string };

type ParamValueResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const WEB_FETCH_FORMATS = new Set<WebFetchData['format']>(['markdown', 'text', 'raw', 'metadata']);

export const FETCH_TIMEOUT_MS = 45_000;
export const MAX_FETCH_BYTES = 10 * 1024 * 1024;
export const DEFAULT_FETCH_CHARS = 30_000;
export const MAX_FETCH_CHARS = 100_000;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 20;

export function normalizeWebSearchParams(rawParams: unknown): WebParamResult<NormalizedWebSearchParams> {
  const input = recordParam(rawParams);
  if (!input) {
    return invalidParams('parameters must be an object', 'Call web_search again with an object containing query.');
  }

  const query = trimmedStringParam(input.query, 'query', 500, true);
  if (!query.ok) {
    return invalidParams(query.message, 'Call web_search again with a non-empty query.');
  }

  const limit = integerParam(input.limit, 'limit', 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  if (!limit.ok) return invalidParams(limit.message, 'Call web_search again with a numeric limit.');

  const site = normalizeOptionalSearchSite(input.site);
  if (!site.ok) return invalidParams(site.message, 'Call web_search again with a single host in site, or omit site.');

  const recencyDays = optionalIntegerParam(input.recency_days, 'recency_days', 1, 3650);
  if (!recencyDays.ok) {
    return invalidParams(recencyDays.message, 'Call web_search again with recency_days between 1 and 3650, or omit it.');
  }

  const effectiveQuery = buildEffectiveSearchQuery(query.value, site.value);
  return {
    ok: true,
    params: {
      query: query.value,
      limit: limit.value,
      effectiveQuery,
      searchUrl: buildGoogleSearchUrl(effectiveQuery),
      ...(site.value ? { site: site.value } : {}),
      ...(recencyDays.value !== undefined ? { recencyDays: recencyDays.value } : {}),
    },
  };
}

export function normalizeWebFetchParams(rawParams: unknown): WebParamResult<NormalizedWebFetchParams> {
  const input = recordParam(rawParams);
  if (!input) {
    return invalidParams('parameters must be an object', 'Call web_fetch again with an object containing url.');
  }

  const url = normalizeWebUrl(input.url);
  if (!url.ok) return url;

  const format = optionalFormatParam(input.format);
  if (!format.ok) {
    return invalidParams(format.message, 'Call web_fetch again with format markdown, text, raw, or metadata.');
  }

  const offset = integerParam(input.offset, 'offset', 0, Number.MAX_SAFE_INTEGER, 0);
  if (!offset.ok) return invalidParams(offset.message, 'Call web_fetch again with a non-negative numeric offset.');

  const maxChars = integerParam(input.max_chars, 'max_chars', 1, MAX_FETCH_CHARS, DEFAULT_FETCH_CHARS);
  if (!maxChars.ok) {
    return invalidParams(maxChars.message, `Call web_fetch again with max_chars between 1 and ${MAX_FETCH_CHARS}.`);
  }

  const query = trimmedStringParam(input.query, 'query', 500, false);
  if (!query.ok) return invalidParams(query.message, 'Call web_fetch again with a non-empty query, or omit query.');

  const context = integerParam(input.context, 'context', 0, 2000, 500);
  if (!context.ok) return invalidParams(context.message, 'Call web_fetch again with context between 0 and 2000.');

  const headLimit = integerParam(input.head_limit, 'head_limit', 1, 50, 10);
  if (!headLimit.ok) return invalidParams(headLimit.message, 'Call web_fetch again with head_limit between 1 and 50.');

  const matchOffset = integerParam(input.match_offset, 'match_offset', 0, Number.MAX_SAFE_INTEGER, 0);
  if (!matchOffset.ok) return invalidParams(matchOffset.message, 'Call web_fetch again with a non-negative match_offset.');

  const caseInsensitive = booleanParam(input.case_insensitive, 'case_insensitive', true);
  if (!caseInsensitive.ok) {
    return invalidParams(caseInsensitive.message, 'Call web_fetch again with case_insensitive as a boolean, or omit it.');
  }

  const mode: WebFetchData['mode'] = format.value === 'metadata'
    ? 'metadata'
    : query.value
      ? 'find'
      : 'read';

  return {
    ok: true,
    params: {
      url: url.params,
      format: format.value,
      mode,
      offset: offset.value,
      maxChars: maxChars.value,
      context: context.value,
      headLimit: headLimit.value,
      matchOffset: matchOffset.value,
      caseInsensitive: caseInsensitive.value,
      ...(query.value ? { query: query.value } : {}),
    },
  };
}

export function normalizeWebUrl(rawUrl: unknown): WebParamResult<string> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return invalidUrl('url is required');
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 2000) {
    return invalidUrl('url exceeds 2000 characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return invalidUrl(`invalid URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalidUrl(`unsupported scheme: ${parsed.protocol}`);
  }

  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:';
  }
  return { ok: true, params: parsed.toString() };
}

export function buildWebFetchSuccessEnvelope(
  fetched: FetchTextResult,
  params: NormalizedWebFetchParams,
  durationMs: number,
): ToolEnvelope<WebFetchData> {
  const metadata = extractMetadata(fetched.body, fetched.finalUrl);
  const warnings = fetched.redirectedHostHint ? ['The URL redirected to a different host.'] : undefined;

  if (params.mode === 'metadata') {
    return successEnvelope('web_fetch', baseFetchData(fetched, params, durationMs, {
      title: metadata.title,
      metadata,
      truncated: false,
      hint: fetched.redirectedHostHint,
    }), {
      warnings,
      metrics: webFetchMetrics(durationMs, fetched.byteLength),
    });
  }

  const extracted = extractContent(fetched.body, fetched.contentType, fetched.finalUrl, params.format);
  if (params.mode === 'find') {
    const found = findMatches(extracted, params);
    return successEnvelope('web_fetch', baseFetchData(fetched, params, durationMs, {
      title: metadata.title,
      metadata: partialMetadata(metadata),
      matches: found.matches,
      totalMatches: found.totalMatches,
      returnedMatches: found.matches.length,
      nextMatchOffset: found.nextMatchOffset,
      truncated: found.nextMatchOffset !== undefined,
      hint: fetched.redirectedHostHint,
    }), {
      instructions: found.matches.length === 0 ? 'Try a broader query or call web_fetch without query to read the page.' : undefined,
      warnings,
      metrics: webFetchMetrics(durationMs, fetched.byteLength, found.nextMatchOffset !== undefined),
    });
  }

  const page = sliceContent(extracted, params.offset, params.maxChars);
  return successEnvelope('web_fetch', baseFetchData(fetched, params, durationMs, {
    title: metadata.title,
    content: page.content,
    metadata: partialMetadata(metadata),
    totalChars: extracted.length,
    returnedChars: page.content.length,
    nextOffset: page.nextOffset,
    truncated: page.truncated,
    hint: fetched.redirectedHostHint,
  }), {
    instructions: page.nextOffset !== undefined ? `Call web_fetch with offset ${page.nextOffset} to continue reading.` : undefined,
    warnings,
    metrics: webFetchMetrics(durationMs, fetched.byteLength, page.truncated),
  });
}

export function extractContent(
  body: string,
  contentType: string,
  finalUrl: string,
  format: WebFetchData['format'],
): string {
  if (format === 'raw') return body;
  if (format === 'metadata') return '';
  if (!contentType.toLowerCase().includes('html')) {
    return body.trim();
  }
  return format === 'text'
    ? htmlToText(body)
    : htmlToMarkdown(body, finalUrl);
}

export function extractMetadata(html: string, finalUrl: string): WebPageMetadata {
  const language = matchFirst(html, /<html[^>]*\slang=["']?([^"'\s>]+)/i);
  const title = cleanText(matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '');
  const description = getMetaContent(html, 'description');
  const siteName = getMetaContent(html, 'og:site_name');
  const canonicalUrl = absolutizeUrl(getLinkHref(html, 'canonical') ?? '', finalUrl) || finalUrl;
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

export function findMatches(content: string, params: Pick<NormalizedWebFetchParams, 'query' | 'caseInsensitive' | 'context' | 'headLimit' | 'matchOffset'>): {
  matches: WebFetchMatch[];
  totalMatches: number;
  nextMatchOffset?: number;
} {
  const query = params.query ?? '';
  const haystack = params.caseInsensitive ? content.toLowerCase() : content;
  const needle = params.caseInsensitive ? query.toLowerCase() : query;
  const all: WebFetchMatch[] = [];

  let cursor = 0;
  while (needle && cursor <= haystack.length) {
    const start = haystack.indexOf(needle, cursor);
    if (start === -1) break;
    const end = start + needle.length;
    const snippetStart = Math.max(0, start - params.context);
    const snippetEnd = Math.min(content.length, end + params.context);
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

  const matches = all.slice(params.matchOffset, params.matchOffset + params.headLimit);
  const nextMatchOffset = params.matchOffset + matches.length < all.length
    ? params.matchOffset + matches.length
    : undefined;
  return { matches, totalMatches: all.length, nextMatchOffset };
}

export function sliceContent(content: string, offset: number, maxChars: number): {
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

export function buildEffectiveSearchQuery(query: string, site?: string): string {
  if (!site) return query;
  return `${query} site:${site}`;
}

export function buildGoogleSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query });
  return `https://www.google.com/search?${params.toString()}`;
}

function baseFetchData(
  fetched: FetchTextResult,
  params: NormalizedWebFetchParams,
  durationMs: number,
  data: Partial<WebFetchData> & Pick<WebFetchData, 'truncated'>,
): WebFetchData {
  return {
    url: fetched.requestedUrl,
    finalUrl: fetched.finalUrl,
    statusCode: fetched.statusCode,
    statusText: fetched.statusText,
    contentType: fetched.contentType,
    byteLength: fetched.byteLength,
    durationMs,
    mode: params.mode,
    format: params.format,
    ...data,
  };
}

function partialMetadata(metadata: WebPageMetadata): WebPageMetadata {
  return {
    title: metadata.title,
    canonicalUrl: metadata.canonicalUrl,
    siteName: metadata.siteName,
  };
}

function webFetchMetrics(durationMs: number, outputBytes: number, truncated?: boolean): ToolMetrics {
  return {
    durationMs,
    ...(truncated !== undefined ? { truncated } : {}),
    outputBytes,
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

function normalizeOptionalSearchSite(value: unknown): ParamValueResult<string | undefined> {
  const site = trimmedStringParam(value, 'site', 200, false);
  if (!site.ok) return site;
  if (!site.value) return { ok: true, value: undefined };

  const withoutOperator = site.value.replace(/^site:/i, '').trim();
  if (!withoutOperator) return { ok: false, message: 'site is required when provided' };

  let host = '';
  try {
    host = /^https?:\/\//i.test(withoutOperator)
      ? new URL(withoutOperator).host
      : withoutOperator.replace(/[/?#].*$/, '');
  } catch {
    return { ok: false, message: `invalid site host: ${site.value}` };
  }

  host = host.toLowerCase();
  if (!host || /\s/.test(host) || host.includes('site:')) {
    return { ok: false, message: `invalid site host: ${site.value}` };
  }
  return { ok: true, value: host };
}

function optionalFormatParam(value: unknown): ParamValueResult<WebFetchData['format']> {
  if (value === undefined) return { ok: true, value: 'markdown' };
  if (typeof value !== 'string') return { ok: false, message: 'format must be a string' };
  if (!WEB_FETCH_FORMATS.has(value as WebFetchData['format'])) {
    return { ok: false, message: `unsupported format: ${value}` };
  }
  return { ok: true, value: value as WebFetchData['format'] };
}

function trimmedStringParam(
  value: unknown,
  name: string,
  maxLength: number,
  required: true,
): ParamValueResult<string>;
function trimmedStringParam(
  value: unknown,
  name: string,
  maxLength: number,
  required: false,
): ParamValueResult<string | undefined>;
function trimmedStringParam(
  value: unknown,
  name: string,
  maxLength: number,
  required: boolean,
): ParamValueResult<string | undefined> {
  if (value === undefined) {
    return required
      ? { ok: false, message: `${name} is required` }
      : { ok: true, value: undefined };
  }
  if (typeof value !== 'string') return { ok: false, message: `${name} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: `${name} is required` };
  if (trimmed.length > maxLength) {
    return { ok: false, message: `${name} exceeds ${maxLength} characters` };
  }
  return { ok: true, value: trimmed };
}

function integerParam(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): ParamValueResult<number> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, message: `${name} must be a number` };
  }
  return { ok: true, value: Math.max(min, Math.min(max, Math.trunc(value))) };
}

function optionalIntegerParam(
  value: unknown,
  name: string,
  min: number,
  max: number,
): ParamValueResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, message: `${name} must be a number` };
  }
  return { ok: true, value: Math.max(min, Math.min(max, Math.trunc(value))) };
}

function booleanParam(value: unknown, name: string, fallback: boolean): ParamValueResult<boolean> {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'boolean') return { ok: false, message: `${name} must be a boolean` };
  return { ok: true, value };
}

function recordParam(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function invalidParams(message: string, instructions: string): WebParamResult<never> {
  return { ok: false, code: 'invalid_args', message, instructions };
}

function invalidUrl(message: string): WebParamResult<never> {
  return {
    ok: false,
    code: 'invalid_url',
    message,
    instructions: 'Call web_fetch again with an absolute http(s) URL.',
  };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
