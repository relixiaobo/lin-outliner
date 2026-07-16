import {
  successEnvelope,
  type ToolEnvelope,
  type ToolMetrics,
} from './agentToolEnvelope';
import {
  DEFAULT_FETCH_CHARS,
  DEFAULT_SEARCH_LIMIT,
  MAX_FETCH_CHARS,
  MAX_SEARCH_LIMIT,
} from './agentWebConstants';
import { extractPageContent, type ExtractedPageContent } from './agentWebFetchContent';

export {
  DEFAULT_FETCH_CHARS,
  DEFAULT_SEARCH_LIMIT,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  MAX_FETCH_CHARS,
  MAX_SEARCH_LIMIT,
  WEB_FETCH_BROWSER_TIMEOUT_MS,
  WEB_FETCH_CLIENT_HINT_PLATFORM,
  WEB_FETCH_CLIENT_HINT_UA,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_RENDER_SETTLE_MS,
  WEB_FETCH_RETRY_DELAY_MS,
  WEB_FETCH_USER_AGENT,
  WEB_SEARCH_RETRY_DELAY_MS,
  WEB_SEARCH_USER_AGENT,
} from './agentWebConstants';
export { extractContent, extractMetadata } from './agentWebFetchContent';

export type WebToolHint =
  | {
      type: 'login_required';
      origin: string;
      detectedVia: 'url_redirect' | 'selector_match' | 'title_keyword' | 'http_401';
    }
  | { type: 'needs_browser'; reason: 'spa_shell' | 'cloudflare' | 'verification' | 'http_error' }
  | { type: 'search_blocked'; reason: 'captcha' | 'rate_limit' | 'unusual_traffic'; origin: string }
  | { type: 'redirected_host'; originalUrl: string; finalUrl: string; finalHost: string };

export type WebSearchKind = 'web' | 'image';

export interface WebSearchResult {
  title: string;
  // For web results, the result page URL. For image results, the page the image
  // was found on (the citation/source page), not the image binary itself.
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string;
  // Image-result fields (kind === 'image'). imageUrl is the direct full-size
  // image to download with web_fetch; thumbnailUrl is a smaller preview.
  imageUrl?: string;
  thumbnailUrl?: string;
}

export interface WebSearchData {
  query: string;
  effectiveQuery: string;
  kind: WebSearchKind;
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
  binaryFile?: WebFetchBinaryFile;
  truncated: boolean;
  hint?: WebToolHint;
}

export interface WebFetchBinaryFile {
  filePath: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
}

export interface FetchTextResult {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  statusText: string;
  contentType: string;
  byteLength: number;
  body: string;
  binaryFile?: WebFetchBinaryFile;
  hint?: WebToolHint;
  redirectedHostHint?: WebToolHint;
}

export interface NormalizedWebSearchParams {
  query: string;
  kind: WebSearchKind;
  limit: number;
  // The query with any `site:` operator folded in. Each provider builds its own
  // results URL from this; there is no provider-specific URL in these
  // kind-agnostic params.
  effectiveQuery: string;
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

export function normalizeWebSearchParams(rawParams: unknown): WebParamResult<NormalizedWebSearchParams> {
  const input = recordParam(rawParams);
  if (!input) {
    return invalidParams('parameters must be an object', 'Call web_search again with an object containing query.');
  }

  const query = trimmedStringParam(input.query, 'query', 500, true);
  if (!query.ok) {
    return invalidParams(query.message, 'Call web_search again with a non-empty query.');
  }

  const kind = optionalSearchKindParam(input.kind);
  if (!kind.ok) {
    return invalidParams(kind.message, 'Call web_search again with kind "web" or "image", or omit kind.');
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
      kind: kind.value,
      limit: limit.value,
      effectiveQuery,
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
  if (parsed.username || parsed.password) {
    return invalidUrl('url must not include username or password credentials');
  }
  if (!parsed.hostname) return invalidUrl('url host is required');
  return { ok: true, params: parsed.toString() };
}

// Validate redirect and browser-fallback targets without changing their literal
// scheme or host. web_fetch is an unprivileged client: it carries no Tenon
// credentials, so loopback, private-network, and single-label hosts follow the
// same URL contract as public hosts.
export function isWebFetchUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  return Boolean(parsed.hostname);
}

export async function buildWebFetchSuccessEnvelope(
  fetched: FetchTextResult,
  params: NormalizedWebFetchParams,
  durationMs: number,
): Promise<ToolEnvelope<WebFetchData>> {
  const page = await extractFetchedPageContent(fetched, params);
  return buildWebFetchSuccessEnvelopeFromPage(fetched, params, durationMs, page);
}

export async function extractFetchedPageContent(
  fetched: FetchTextResult,
  params: Pick<NormalizedWebFetchParams, 'format'>,
): Promise<ExtractedPageContent> {
  return extractPageContent(fetched.body, fetched.contentType, fetched.finalUrl, params.format);
}

export function buildWebFetchSuccessEnvelopeFromPage(
  fetched: FetchTextResult,
  params: NormalizedWebFetchParams,
  durationMs: number,
  page: ExtractedPageContent,
): ToolEnvelope<WebFetchData> {
  const metadata = page.metadata;
  const warnings = fetched.redirectedHostHint ? ['The URL redirected to a different host.'] : undefined;
  // A success envelope carries at most one hint. A real fetch.hint (login wall /
  // needs_browser) outranks the redirected_host note: the host change is already
  // conveyed by the warning above plus data.finalUrl, so dropping its hint here
  // loses no signal, whereas dropping the login/browser hint would.
  const hint = fetched.hint ?? fetched.redirectedHostHint;

  if (fetched.binaryFile) {
    const content = [
      `Binary content saved to ${fetched.binaryFile.filePath}.`,
      'Use file_read on this path when you need to inspect supported files such as PDFs or images.',
    ].join(' ');
    return successEnvelope('web_fetch', baseFetchData(fetched, params, durationMs, {
      content: params.mode === 'metadata' ? undefined : content,
      metadata: params.mode === 'metadata' ? metadata : partialMetadata(metadata),
      binaryFile: fetched.binaryFile,
      matches: params.mode === 'find' ? [] : undefined,
      totalMatches: params.mode === 'find' ? 0 : undefined,
      returnedMatches: params.mode === 'find' ? 0 : undefined,
      truncated: false,
      hint,
    }), {
      instructions: 'Binary content was saved to disk. Use file_read with binaryFile.filePath for PDFs or images when details are needed.',
      warnings,
      metrics: webFetchMetrics(durationMs, fetched.byteLength),
    });
  }

  if (params.mode === 'metadata') {
    return successEnvelope('web_fetch', baseFetchData(fetched, params, durationMs, {
      title: metadata.title,
      metadata,
      truncated: false,
      hint,
    }), {
      warnings,
      metrics: webFetchMetrics(durationMs, fetched.byteLength),
    });
  }

  if (params.mode === 'find') {
    const found = findMatches(page.content, params);
    return successEnvelope('web_fetch', baseFetchData(fetched, params, durationMs, {
      title: metadata.title,
      metadata: partialMetadata(metadata),
      matches: found.matches,
      totalMatches: found.totalMatches,
      returnedMatches: found.matches.length,
      nextMatchOffset: found.nextMatchOffset,
      truncated: found.nextMatchOffset !== undefined,
      hint,
    }), {
      instructions: found.matches.length === 0 ? 'Try a broader query or call web_fetch without query to read the page.' : undefined,
      warnings,
      metrics: webFetchMetrics(durationMs, fetched.byteLength, found.nextMatchOffset !== undefined),
    });
  }

  const sliced = sliceContent(page.content, params.offset, params.maxChars);
  return successEnvelope('web_fetch', baseFetchData(fetched, params, durationMs, {
    title: metadata.title,
    content: sliced.content,
    metadata: partialMetadata(metadata),
    totalChars: page.content.length,
    returnedChars: sliced.content.length,
    nextOffset: sliced.nextOffset,
    truncated: sliced.truncated,
    hint,
  }), {
    instructions: sliced.nextOffset !== undefined ? `Call web_fetch with offset ${sliced.nextOffset} to continue reading.` : undefined,
    warnings,
    metrics: webFetchMetrics(durationMs, fetched.byteLength, sliced.truncated),
  });
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

// Model-visible projections. The full WebSearchData/WebFetchData stays on the
// envelope (details) for logs and the UI; the model only needs the result
// payload and pagination/recovery signals. Fields that echo the call arguments
// (query, url, format, mode), constant provider metadata, and telemetry
// (durationMs, byteLength, finalUrl) are dropped. See agentToolEnvelope's
// modelData parameter for how this projection is attached.
export function webSearchModelData(data: WebSearchData): unknown {
  const isImage = data.kind === 'image';
  const visible: Record<string, unknown> = {
    results: data.results.map((result) => ({
      title: result.title,
      url: result.url,
      // Web results always carry snippet (even ''), preserving a stable shape;
      // image results omit it (it is always empty for them).
      ...(isImage ? {} : { snippet: result.snippet }),
      // Image results carry the binary URL the model downloads with web_fetch;
      // without it the model cannot act on an image hit.
      ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
      ...(result.thumbnailUrl ? { thumbnailUrl: result.thumbnailUrl } : {}),
      ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    })),
  };
  if (isImage) visible.kind = 'image';
  if (data.truncated) {
    visible.truncated = true;
    if (data.totalResults !== undefined) visible.totalResults = data.totalResults;
  }
  if (data.hint) visible.hint = data.hint;
  return visible;
}

export function webFetchModelData(data: WebFetchData): unknown {
  const visible: Record<string, unknown> = {};
  if (data.title) visible.title = data.title;
  if (data.finalUrl && data.finalUrl !== data.url) visible.finalUrl = data.finalUrl;
  if (data.statusCode && data.statusCode !== 200) visible.statusCode = data.statusCode;

  if (data.binaryFile) {
    visible.binaryFile = { filePath: data.binaryFile.filePath, mimeType: data.binaryFile.mimeType };
    if (data.hint) visible.hint = data.hint;
    return visible;
  }

  if (data.mode === 'metadata') {
    if (data.metadata) visible.metadata = data.metadata;
  } else if (data.mode === 'find') {
    visible.matches = (data.matches ?? []).map((match) => ({ snippet: match.snippet }));
    visible.totalMatches = data.totalMatches ?? 0;
    if (data.nextMatchOffset !== undefined) visible.nextMatchOffset = data.nextMatchOffset;
  } else {
    if (data.content !== undefined) visible.content = data.content;
    if (data.truncated) {
      visible.truncated = true;
      if (data.totalChars !== undefined) visible.totalChars = data.totalChars;
      if (data.nextOffset !== undefined) visible.nextOffset = data.nextOffset;
    }
  }
  if (data.hint) visible.hint = data.hint;
  return visible;
}

export function buildEffectiveSearchQuery(query: string, site?: string): string {
  if (!site) return query;
  return `${query} site:${site}`;
}

export function buildGoogleSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query });
  return `https://www.google.com/search?${params.toString()}`;
}

export function buildBingImagesSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query });
  return `https://www.bing.com/images/search?${params.toString()}`;
}

// DuckDuckGo's no-JS HTML endpoint: server-rendered results that scrape cleanly
// and rarely gate, used as the secondary engine when Google is blocked or empty.
export function buildDuckDuckGoSearchUrl(query: string): string {
  const params = new URLSearchParams({ q: query });
  return `https://html.duckduckgo.com/html/?${params.toString()}`;
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

function optionalSearchKindParam(value: unknown): ParamValueResult<WebSearchKind> {
  if (value === undefined) return { ok: true, value: 'web' };
  if (typeof value !== 'string') return { ok: false, message: 'kind must be a string' };
  if (value !== 'web' && value !== 'image') {
    return { ok: false, message: `unsupported kind: ${value}` };
  }
  return { ok: true, value };
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
