import {
  BrowserWindow,
  session as electronSession,
  type Event as ElectronEvent,
  type WebContents,
  type WebContentsWillNavigateEventParams,
  type WebContentsWillRedirectEventParams,
} from 'electron';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createNodeTools, type OutlinerToolHost } from './agentNodeTools';
import { createLocalTools, scratchRootForWorkdir, type AgentLocalWorkspaceContext } from './agentLocalTools';
import { createSkillTool, type AgentSkillRuntime } from './agentSkills';
import { createAgentDelegationTools, type AgentDelegationRuntime } from './agentDelegation';
import { normalizeAgentToolNames } from './agentToolRules';
import { createRecallTool, type AgentRecallToolRuntime } from './agentRecallTool';
import { createAskUserQuestionTool, type AgentAskUserQuestionRuntime } from './agentAskUserQuestionTool';
import { createSelfMaintenanceTools, type AgentSelfMaintenanceRuntime } from './agentSelfMaintenanceTools';
import {
  agentToolResult,
  errorEnvelope,
  successEnvelope,
  type ToolEnvelope,
} from './agentToolEnvelope';
import {
  DEFAULT_FETCH_CHARS,
  DEFAULT_SEARCH_LIMIT,
  FETCH_TIMEOUT_MS,
  MAX_FETCH_BYTES,
  MAX_FETCH_CHARS,
  MAX_SEARCH_LIMIT,
  WEB_FETCH_BROWSER_TIMEOUT_MS,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_RENDER_SETTLE_MS,
  WEB_FETCH_USER_AGENT,
  buildBingImagesSearchUrl,
  buildWebFetchSuccessEnvelopeFromPage,
  extractFetchedPageContent,
  normalizeWebFetchParams,
  normalizeWebSearchParams,
  webFetchModelData,
  webSearchModelData,
  type FetchTextResult,
  type NormalizedWebFetchParams,
  type NormalizedWebSearchParams,
  type WebFetchBinaryFile,
  type WebFetchData,
  type WebSearchData,
  type WebSearchKind,
  type WebSearchResult,
  type WebToolHint,
} from './agentWebTools';
import {
  WEB_FETCH_CASE_INSENSITIVE_PARAMETER_DESCRIPTION,
  WEB_FETCH_CONTEXT_PARAMETER_DESCRIPTION,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_FORMAT_PARAMETER_DESCRIPTION,
  WEB_FETCH_HEAD_LIMIT_PARAMETER_DESCRIPTION,
  WEB_FETCH_MATCH_OFFSET_PARAMETER_DESCRIPTION,
  WEB_FETCH_MAX_CHARS_PARAMETER_DESCRIPTION,
  WEB_FETCH_OFFSET_PARAMETER_DESCRIPTION,
  WEB_FETCH_QUERY_PARAMETER_DESCRIPTION,
  WEB_FETCH_URL_PARAMETER_DESCRIPTION,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_KIND_PARAMETER_DESCRIPTION,
  WEB_SEARCH_LIMIT_PARAMETER_DESCRIPTION,
  WEB_SEARCH_QUERY_PARAMETER_DESCRIPTION,
  WEB_SEARCH_RECENCY_PARAMETER_DESCRIPTION,
  WEB_SEARCH_SITE_PARAMETER_DESCRIPTION,
} from './agentWebToolGuidance';
import {
  assessWebFetchFallback,
  browserFallbackLooksUseful,
  detectBrowserChallenge,
  fallbackHint,
  isPermittedWebFetchRedirect,
  shouldTryBrowserFallbackForHttpFailure,
} from './agentWebFetchFallback';
import {
  BING_IMAGES_RESULT_SELECTOR,
  bingImagesExtractorExpression,
  googleSerpExtractorExpression,
} from './agentWebSearchSerp';

const GOOGLE_SEARCH_HOME_URL = 'https://www.google.com/';
const GOOGLE_SEARCH_INPUT_SELECTOR = 'textarea[name="q"], input[name="q"]';
const GOOGLE_SEARCH_RESULT_SELECTOR = '#search, #rso';
const WEB_SEARCH_PARTITION = 'persist:web-search';
const SEARCH_NAV_TIMEOUT_MS = 60_000;
const SEARCH_RATE_INTERVAL_MS = 3_000;
const SEARCH_RATE_BURST = 2;
const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
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
      description: WEB_FETCH_URL_PARAMETER_DESCRIPTION,
    },
    format: {
      type: 'string',
      enum: ['markdown', 'text', 'raw', 'metadata'],
      description: WEB_FETCH_FORMAT_PARAMETER_DESCRIPTION,
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: WEB_FETCH_OFFSET_PARAMETER_DESCRIPTION,
    },
    max_chars: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_FETCH_CHARS,
      description: `${WEB_FETCH_MAX_CHARS_PARAMETER_DESCRIPTION} Default ${DEFAULT_FETCH_CHARS}, max ${MAX_FETCH_CHARS}.`,
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: WEB_FETCH_QUERY_PARAMETER_DESCRIPTION,
    },
    context: {
      type: 'integer',
      minimum: 0,
      maximum: 2000,
      description: `${WEB_FETCH_CONTEXT_PARAMETER_DESCRIPTION} Default 500.`,
    },
    head_limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: `${WEB_FETCH_HEAD_LIMIT_PARAMETER_DESCRIPTION} Default 10.`,
    },
    match_offset: {
      type: 'integer',
      minimum: 0,
      description: WEB_FETCH_MATCH_OFFSET_PARAMETER_DESCRIPTION,
    },
    case_insensitive: {
      type: 'boolean',
      description: WEB_FETCH_CASE_INSENSITIVE_PARAMETER_DESCRIPTION,
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
      description: WEB_SEARCH_QUERY_PARAMETER_DESCRIPTION,
    },
    kind: {
      type: 'string',
      enum: ['web', 'image'],
      description: WEB_SEARCH_KIND_PARAMETER_DESCRIPTION,
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      description: `${WEB_SEARCH_LIMIT_PARAMETER_DESCRIPTION} Default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}.`,
    },
    site: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: WEB_SEARCH_SITE_PARAMETER_DESCRIPTION,
    },
    recency_days: {
      type: 'integer',
      minimum: 1,
      maximum: 3650,
      description: WEB_SEARCH_RECENCY_PARAMETER_DESCRIPTION,
    },
  },
};

export type { ToolEnvelope } from './agentToolEnvelope';

export interface AgentToolsOptions {
  localFileRoot?: string;
  localWorkspace?: AgentLocalWorkspaceContext;
  skillRuntime?: AgentSkillRuntime;
  skillToolEnabled?: boolean;
  delegationRuntime?: AgentDelegationRuntime;
  recall?: AgentRecallToolRuntime;
  askUserQuestion?: AgentAskUserQuestionRuntime;
  selfMaintenance?: AgentSelfMaintenanceRuntime;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export function createAgentTools(outliner?: OutlinerToolHost, options: AgentToolsOptions = {}): AgentTool<any>[] {
  // Web-fetch binaries are scratch, not workspace output: prefer the workspace's resolved
  // scratch root, otherwise derive it through the single-source default (never re-deriving a
  // cwd fallback locally — that is the one polluting path F2 removes).
  const scratchRoot = options.localWorkspace?.scratchRoot
    ?? scratchRootForWorkdir(options.localFileRoot, undefined);
  const tools = [
    ...(outliner ? createNodeTools(outliner, { localFileRoot: options.localFileRoot }) : []),
    ...createLocalTools({ localRoot: options.localFileRoot, workspace: options.localWorkspace, skillRuntime: options.skillRuntime }),
    createWebSearchTool(),
    createWebFetchTool(scratchRoot),
    ...(options.recall ? [createRecallTool(options.recall)] : []),
    ...(options.askUserQuestion ? [createAskUserQuestionTool(options.askUserQuestion)] : []),
    ...(options.selfMaintenance ? createSelfMaintenanceTools(options.selfMaintenance) : []),
    ...(options.skillRuntime && options.skillToolEnabled !== false ? [createSkillTool(options.skillRuntime)] : []),
    ...(options.delegationRuntime ? createAgentDelegationTools(options.delegationRuntime) : []),
  ];
  return filterAgentTools(tools, options.allowedTools, options.disallowedTools);
}

function filterAgentTools(
  tools: AgentTool<any>[],
  allowedRules: readonly string[] | undefined,
  disallowedRules: readonly string[] | undefined,
): AgentTool<any>[] {
  const allowed = normalizeAgentToolNames(allowedRules);
  const disallowed = normalizeAgentToolNames(disallowedRules);
  return tools.filter((tool) => {
    const name = tool.name.toLowerCase();
    if (allowed && !allowed.includes('*') && !allowed.includes(name)) return false;
    if (disallowed?.includes('*') || disallowed?.includes(name)) return false;
    return true;
  });
}

function createWebFetchTool(scratchRoot: string): AgentTool<any, ToolEnvelope<WebFetchData>> {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description: WEB_FETCH_DESCRIPTION,
    parameters: WEB_FETCH_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown, signal) => {
      const started = Date.now();
      const normalized = normalizeWebFetchParams(rawParams);
      if (!normalized.ok) {
        return agentToolResult(errorEnvelope('web_fetch', normalized.code, normalized.message, {
          instructions: normalized.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const params = normalized.params;
      try {
        return webFetchToolResult(await fetchWebFetchEnvelope(params, started, scratchRoot, signal));
      } catch (error) {
        if (error instanceof WebToolFailure && error.hint) {
          return webFetchToolResult(webFetchHintEnvelope(params, error, started));
        }
        return agentToolResult(errorEnvelope('web_fetch', classifyWebError(error), errorMessage(error), {
          instructions: 'Retry once if this looks transient. If it still fails, use web_search for another source.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
    },
  };
}

function webFetchToolResult(envelope: ToolEnvelope<WebFetchData>) {
  return agentToolResult(envelope, envelope.data ? webFetchModelData(envelope.data) : undefined);
}

async function fetchWebFetchEnvelope(
  params: NormalizedWebFetchParams,
  started: number,
  scratchRoot: string,
  signal?: AbortSignal,
): Promise<ToolEnvelope<WebFetchData>> {
  try {
    const fetched = await fetchText(params.url, scratchRoot, signal);
    const page = await extractFetchedPageContent(fetched, params);
    const decision = assessWebFetchFallback(fetched, params, page);
    if (decision.shouldFallback) {
      const browserResult = await tryBrowserFallback(params, page, decision, signal);
      if (browserResult) {
        return buildWebFetchSuccessEnvelopeFromPage(
          browserResult.fetched,
          params,
          elapsed(started),
          browserResult.page,
        );
      }
      return buildWebFetchSuccessEnvelopeFromPage(
        withFetchHint(fetched, fallbackHint(decision.reason)),
        params,
        elapsed(started),
        page,
      );
    }
    return buildWebFetchSuccessEnvelopeFromPage(fetched, params, elapsed(started), page);
  } catch (error) {
    if (
      error instanceof WebToolFailure
      && shouldTryBrowserFallbackForHttpFailure(error.statusCode, error.hint, params.format)
    ) {
      try {
        const fetched = await fetchTextWithBrowser(params.url, signal);
        const page = await extractFetchedPageContent(fetched, params);
        const decision = assessWebFetchFallback(fetched, params, page);
        return buildWebFetchSuccessEnvelopeFromPage(
          decision.shouldFallback
            ? withFetchHint(fetched, fallbackHint(decision.reason))
            : fetched,
          params,
          elapsed(started),
          page,
        );
      } catch (browserError) {
        if (browserError instanceof WebToolFailure && browserError.hint) {
          throw browserError;
        }
      }
    }
    throw error;
  }
}

async function tryBrowserFallback(
  params: NormalizedWebFetchParams,
  httpPage: Awaited<ReturnType<typeof extractFetchedPageContent>>,
  httpDecision: ReturnType<typeof assessWebFetchFallback>,
  signal?: AbortSignal,
): Promise<{ fetched: FetchTextResult; page: Awaited<ReturnType<typeof extractFetchedPageContent>> } | null> {
  try {
    const browserFetched = await fetchTextWithBrowser(params.url, signal);
    const browserPage = await extractFetchedPageContent(browserFetched, params);
    const browserDecision = assessWebFetchFallback(browserFetched, params, browserPage);
    if (!browserFallbackLooksUseful(httpPage, browserPage, httpDecision, browserDecision, params)) {
      return null;
    }
    return {
      fetched: browserDecision.shouldFallback
        ? withFetchHint(browserFetched, fallbackHint(browserDecision.reason))
        : browserFetched,
      page: browserPage,
    };
  } catch {
    return null;
  }
}

function webFetchHintEnvelope(
  params: NormalizedWebFetchParams,
  error: WebToolFailure,
  started: number,
): ToolEnvelope<WebFetchData> {
  return successEnvelope('web_fetch', {
    url: params.url,
    finalUrl: error.finalUrl ?? params.url,
    statusCode: error.statusCode ?? 0,
    statusText: error.message,
    contentType: '',
    byteLength: 0,
    durationMs: elapsed(started),
    mode: params.mode,
    format: params.format,
    truncated: false,
    hint: error.hint,
  }, {
    instructions: error.hint?.type === 'login_required'
      ? 'Ask the user to sign in to this site, then retry web_fetch.'
      : error.hint?.type === 'redirected_host'
        ? 'Call web_fetch again with finalUrl if you trust and need the redirected host.'
        : 'Use another source with web_search, or retry after clearing site verification in a browser.',
    metrics: { durationMs: elapsed(started) },
  });
}

function withFetchHint(fetched: FetchTextResult, hint: WebToolHint | undefined): FetchTextResult {
  return hint ? { ...fetched, hint } : fetched;
}

function createWebSearchTool(): AgentTool<any, ToolEnvelope<WebSearchData>> {
  return {
    name: 'web_search',
    label: 'Web Search',
    description: WEB_SEARCH_DESCRIPTION,
    parameters: WEB_SEARCH_PARAMETERS,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawParams: unknown, signal) => {
      const started = Date.now();
      const normalized = normalizeWebSearchParams(rawParams);
      if (!normalized.ok) {
        return agentToolResult(errorEnvelope('web_search', normalized.code, normalized.message, {
          instructions: normalized.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }

      const params = normalized.params;
      const provider = SEARCH_PROVIDERS[params.kind];

      try {
        const search = await provider.run(params, signal);
        const durationMs = elapsed(started);
        if (search.kind === 'hint') {
          return webSearchToolResult(successEnvelope('web_search', {
            ...baseSearchData(params, provider.providerName, durationMs, search.finalUrl),
            resultCount: 0,
            truncated: false,
            hint: search.hint,
            results: [],
          }, {
            instructions: search.hint.type === 'search_blocked'
              ? 'Pause searches for a few minutes, ask the user to clear the search challenge, or use a direct URL with web_fetch.'
              : 'Try again, or use a direct URL with web_fetch if one is known.',
            metrics: { durationMs },
          }));
        }
        if (search.kind === 'error') {
          return webSearchToolResult(errorEnvelope('web_search', search.code, search.message, {
            data: {
              ...baseSearchData(params, provider.providerName, durationMs, search.finalUrl),
              resultCount: 0,
              truncated: false,
              results: [],
            } satisfies WebSearchData,
            instructions: 'Retry once if this looks transient. If it still fails, try a more specific query or direct URL.',
            metrics: { durationMs },
          }));
        }

        const allResults = search.results;
        const results = allResults.slice(0, params.limit);
        const truncated = allResults.length > results.length;

        return webSearchToolResult(successEnvelope('web_search', {
          ...baseSearchData(params, provider.providerName, durationMs, search.finalUrl),
          resultCount: results.length,
          totalResults: allResults.length,
          truncated,
          results,
        }, {
          instructions: searchInstructions(params.kind, results.length > 0),
          warnings: searchWarnings(params),
          metrics: { durationMs, truncated, outputBytes: search.htmlBytes },
        }));
      } catch (error) {
        return agentToolResult(errorEnvelope('web_search', classifyWebError(error), errorMessage(error), {
          instructions: 'Retry once if this looks transient. If it still fails, try a more specific query or direct URL.',
          metrics: { durationMs: elapsed(started) },
        }));
      }
    },
  };
}

function webSearchToolResult(envelope: ToolEnvelope<WebSearchData>) {
  return agentToolResult(envelope, envelope.data ? webSearchModelData(envelope.data) : undefined);
}

interface SearchProvider {
  providerName: string;
  run(params: NormalizedWebSearchParams, signal?: AbortSignal): Promise<SearchOutcome>;
}

// One descriptor per search kind: which provider runs it and how the normalized
// query maps onto the provider call. execute() stays kind-agnostic; per-kind copy
// lives in searchWarnings/searchInstructions so adding a kind touches one place.
const SEARCH_PROVIDERS: Record<WebSearchKind, SearchProvider> = {
  web: { providerName: 'google_serp', run: (params, signal) => searchGoogle(params.searchUrl, signal) },
  image: { providerName: 'bing_images', run: (params, signal) => searchBingImages(params.effectiveQuery, signal) },
};

// The invariant envelope fields shared by the hint / error / success branches —
// written once so adding or renaming a field cannot drift across the three.
function baseSearchData(
  params: NormalizedWebSearchParams,
  providerName: string,
  durationMs: number,
  finalUrl: string | undefined,
): Pick<WebSearchData, 'query' | 'effectiveQuery' | 'kind' | 'provider' | 'providerName' | 'finalUrl' | 'durationMs'> {
  return {
    query: params.query,
    effectiveQuery: params.effectiveQuery,
    kind: params.kind,
    provider: 'provider',
    providerName,
    finalUrl,
    durationMs,
  };
}

function searchWarnings(params: NormalizedWebSearchParams): string[] | undefined {
  const warnings: string[] = [];
  if (params.kind === 'image') {
    warnings.push('Image results may be copyright-protected. Treat them as drafts and confirm licensing with the user before final use.');
  }
  // recency_days is best-effort and not encoded into the provider URL, so always
  // flag it when set — including alongside the image warning.
  if (params.recencyDays) {
    warnings.push('recency_days is best-effort with the current search provider. Verify dates with web_fetch when freshness matters.');
  }
  return warnings.length ? warnings : undefined;
}

function searchInstructions(kind: WebSearchKind, hasResults: boolean): string | undefined {
  if (hasResults) {
    return kind === 'image'
      ? 'Download a chosen imageUrl with web_fetch (it saves a binaryFile), then file_read or embed it. Use thumbnailUrl to preview which image to pick.'
      : undefined;
  }
  return kind === 'image'
    ? 'Try a broader query, drop the site filter, or retry; if it keeps failing, search the web for a source page and use web_fetch.'
    : 'Try a broader query or remove site/recency constraints.';
}

async function fetchText(url: string, scratchRoot: string, signal?: AbortSignal): Promise<FetchTextResult> {
  const startedUrl = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort('parent_aborted');
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await fetchTextWithPermittedRedirects(startedUrl, startedUrl, controller.signal, scratchRoot);
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

async function fetchTextWithPermittedRedirects(
  currentUrl: string,
  startedUrl: string,
  signal: AbortSignal,
  scratchRoot: string,
  depth = 0,
): Promise<FetchTextResult> {
  if (depth > WEB_FETCH_MAX_REDIRECTS) {
    throw new WebToolFailure('too_many_redirects', `too many redirects; exceeded ${WEB_FETCH_MAX_REDIRECTS}`);
  }

  const response = await electronSession.defaultSession.fetch(currentUrl, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
      'user-agent': WEB_FETCH_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.4',
      'accept-language': 'en-US,en;q=0.9',
    },
  });

  if (HTTP_REDIRECT_STATUSES.has(response.status)) {
    const redirectUrl = resolveRedirectUrl(currentUrl, response.headers.get('location'));
    if (!redirectUrl) {
      throw new WebToolFailure('invalid_redirect', `HTTP ${response.status} redirect is missing a valid Location header`, {
        finalUrl: currentUrl,
        statusCode: response.status,
      });
    }
    if (isPermittedWebFetchRedirect(currentUrl, redirectUrl)) {
      return await fetchTextWithPermittedRedirects(redirectUrl, startedUrl, signal, scratchRoot, depth + 1);
    }
    throw redirectedHostFailure(startedUrl, redirectUrl, response.status);
  }

  const finalUrl = response.url || currentUrl;
  const contentType = response.headers.get('content-type') ?? '';
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
    const body = await readSmallErrorBody(response, contentType);
    const reason = detectBrowserChallenge(body, finalUrl, response.statusText) ?? 'http_error';
    throw new WebToolFailure('http_error', `HTTP ${response.status} ${response.statusText || ''}`.trim(), {
      finalUrl,
      statusCode: response.status,
      hint: { type: 'needs_browser', reason },
    });
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_FETCH_BYTES) {
    throw new WebToolFailure('response_too_large', `response exceeds ${MAX_FETCH_BYTES} bytes`);
  }

  const bytesResult = await readBoundedBytes(response, MAX_FETCH_BYTES);
  if (isBinaryContentType(contentType)) {
    const binaryFile = await persistWebFetchBinary(bytesResult.bytes, contentType, finalUrl, scratchRoot);
    return {
      requestedUrl: startedUrl,
      finalUrl,
      statusCode: response.status,
      statusText: response.statusText,
      contentType,
      byteLength: bytesResult.byteLength,
      body: '',
      binaryFile,
    };
  }
  const body = new TextDecoder('utf-8', { fatal: false }).decode(bytesResult.bytes);
  return {
    requestedUrl: startedUrl,
    finalUrl,
    statusCode: response.status,
    statusText: response.statusText,
    contentType,
    byteLength: bytesResult.byteLength,
    body,
  };
}

function resolveRedirectUrl(baseUrl: string, location: string | null): string | null {
  if (!location) return null;
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return null;
  }
}

function redirectedHostFailure(startedUrl: string, redirectUrl: string, statusCode: number): WebToolFailure {
  return new WebToolFailure('redirected_host', `redirected to a different host: ${redirectUrl}`, {
    finalUrl: redirectUrl,
    statusCode,
    hint: {
      type: 'redirected_host',
      originalUrl: startedUrl,
      finalUrl: redirectUrl,
      finalHost: hostOf(redirectUrl) ?? redirectUrl,
    },
  });
}

async function readSmallErrorBody(response: Response, contentType: string): Promise<string> {
  if (isBinaryContentType(contentType)) return '';
  try {
    return (await readBoundedText(response, Math.min(MAX_FETCH_BYTES, 512 * 1024))).text;
  } catch {
    return '';
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<{ text: string; bytes: number }> {
  const result = await readBoundedBytes(response, maxBytes);
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(result.bytes),
    bytes: result.byteLength,
  };
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; byteLength: number }> {
  if (!response.body) return { bytes: new Uint8Array(), byteLength: 0 };
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];

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
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, byteLength: total };
}

async function persistWebFetchBinary(
  bytes: Uint8Array,
  contentType: string,
  finalUrl: string,
  scratchRoot: string,
): Promise<WebFetchBinaryFile> {
  const mimeType = normalizeMimeType(contentType);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const extension = binaryExtension(mimeType, finalUrl);
  const filePath = path.join(webFetchOutputDir(scratchRoot), `webfetch-${Date.now()}-${randomUUID()}${extension}`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return {
    filePath,
    mimeType,
    byteLength: bytes.byteLength,
    sha256,
  };
}

function webFetchOutputDir(scratchRoot: string): string {
  return path.join(path.resolve(scratchRoot), 'agent-web-fetch');
}

function normalizeMimeType(contentType: string): string {
  const mimeType = contentType.split(';')[0]?.trim().toLowerCase();
  return mimeType || 'application/octet-stream';
}

function binaryExtension(mimeType: string, finalUrl: string): string {
  const urlExtension = extensionFromUrl(finalUrl);
  if (urlExtension) return urlExtension;
  switch (mimeType) {
    case 'application/pdf':
      return '.pdf';
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    case 'application/zip':
      return '.zip';
    case 'application/gzip':
      return '.gz';
    case 'application/x-tar':
      return '.tar';
    default:
      return '.bin';
  }
}

function extensionFromUrl(finalUrl: string): string {
  try {
    const ext = path.extname(new URL(finalUrl).pathname).toLowerCase();
    return /^[.][a-z0-9]{1,12}$/.test(ext) ? ext : '';
  } catch {
    return '';
  }
}

async function fetchTextWithBrowser(url: string, signal?: AbortSignal): Promise<FetchTextResult> {
  const window = createWebFetchWindow();
  let blockedNavigation: WebToolFailure | null = null;
  let rejectBlockedNavigation: ((failure: WebToolFailure) => void) | undefined;
  const blockedNavigationPromise = new Promise<never>((_resolve, reject) => {
    rejectBlockedNavigation = reject;
  });
  const blockCrossHostNavigation = (targetUrl: string, event: { preventDefault(): void }) => {
    if (isPermittedWebFetchRedirect(url, targetUrl)) return;
    blockedNavigation = redirectedHostFailure(url, targetUrl, 0);
    event.preventDefault();
    try {
      window.webContents.stop();
    } catch {
      // no-op
    }
    rejectBlockedNavigation?.(blockedNavigation);
  };
  const onWillRedirect = (
    event: ElectronEvent<WebContentsWillRedirectEventParams>,
    redirectUrl: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame) return;
    blockCrossHostNavigation(event.url || redirectUrl, event);
  };
  const onWillNavigate = (
    event: ElectronEvent<WebContentsWillNavigateEventParams>,
    navigateUrl: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame) return;
    blockCrossHostNavigation(event.url || navigateUrl, event);
  };
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
  window.webContents.on('will-redirect', onWillRedirect);
  window.webContents.on('will-navigate', onWillNavigate);

  try {
    await Promise.race([
      navigateAndWait(window.webContents, url, {
        timeoutMs: WEB_FETCH_BROWSER_TIMEOUT_MS,
        signal,
      }),
      blockedNavigationPromise,
    ]);
    if (blockedNavigation) throw blockedNavigation;
    await waitForRenderedPageSettled(window.webContents, signal);
    const payload = await safeExecuteJs<{ html: string; text: string; title: string }>(
      window.webContents,
      `({
        html: document.documentElement ? document.documentElement.outerHTML : "",
        text: document.body ? document.body.innerText : "",
        title: document.title || "",
      })`,
    );
    if (!payload?.html) {
      throw new WebToolFailure('extraction_failed', 'browser-rendered page did not expose HTML');
    }
    const finalUrl = window.webContents.getURL() || url;
    const finalHost = hostOf(finalUrl);
    const startedHost = hostOf(url);
    if (startedHost && finalHost && !isPermittedWebFetchRedirect(url, finalUrl)) {
      throw redirectedHostFailure(url, finalUrl, 0);
    }
    return {
      requestedUrl: url,
      finalUrl,
      statusCode: 200,
      statusText: 'OK',
      contentType: 'text/html; charset=utf-8',
      byteLength: Buffer.byteLength(payload.html, 'utf8'),
      body: payload.html,
    };
  } catch (error) {
    if (blockedNavigation) throw blockedNavigation;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    window.webContents.off('will-redirect', onWillRedirect);
    window.webContents.off('will-navigate', onWillNavigate);
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

async function waitForRenderedPageSettled(webContents: WebContents, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  let previousLength = -1;
  let stableTicks = 0;
  while (Date.now() - started < WEB_FETCH_RENDER_SETTLE_MS) {
    if (signal?.aborted) throw new WebToolFailure('aborted', 'request aborted');
    const state = await safeExecuteJs<{ readyState: string; textLength: number }>(
      webContents,
      `({
        readyState: document.readyState,
        textLength: document.body ? document.body.innerText.replace(/\\s+/g, " ").trim().length : 0,
      })`,
    );
    const textLength = state?.textLength ?? 0;
    const stable = previousLength >= 0 && Math.abs(textLength - previousLength) < 20;
    stableTicks = state?.readyState === 'complete' && stable ? stableTicks + 1 : 0;
    if (stableTicks >= 3 && (textLength > 0 || Date.now() - started > 1_000)) return;
    previousLength = textLength;
    await delay(250, signal);
  }
}

function createWebFetchWindow(): BrowserWindow {
  return new BrowserWindow({
    x: -20_000,
    y: -20_000,
    width: 1280,
    height: 900,
    show: false,
    title: 'Tenon Web Fetch',
    webPreferences: {
      session: electronSession.defaultSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

type SearchOutcome =
  | { kind: 'ok'; finalUrl: string; results: WebSearchResult[]; htmlBytes: number }
  | { kind: 'hint'; finalUrl: string; hint: WebToolHint }
  | { kind: 'error'; finalUrl?: string; code: string; message: string };

// Owns the hidden-window lifecycle shared by every search kind: the rate-limit
// gate, the off-screen BrowserWindow, abort wiring, and guaranteed teardown.
// Each provider supplies only its navigate-and-extract body.
async function withSearchWindow(
  signal: AbortSignal | undefined,
  run: (webContents: WebContents) => Promise<SearchOutcome>,
): Promise<SearchOutcome> {
  try {
    await waitForSearchRateLimit(signal);
  } catch {
    return { kind: 'error', code: 'rate_limited', message: 'search aborted while rate-limited' };
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
    return await run(window.webContents);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

async function searchGoogle(searchUrl: string, signal?: AbortSignal): Promise<SearchOutcome> {
  const query = googleQueryFromSearchUrl(searchUrl);
  if (!query) {
    return { kind: 'error', code: 'invalid_args', message: 'missing search query', finalUrl: searchUrl };
  }

  return withSearchWindow(signal, async (webContents) => {
    try {
      await navigateAndWait(webContents, GOOGLE_SEARCH_HOME_URL, {
        timeoutMs: SEARCH_NAV_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      return {
        kind: 'error',
        code: classifyWebError(error),
        message: errorMessage(error),
        finalUrl: webContents.getURL() || GOOGLE_SEARCH_HOME_URL,
      };
    }

    const inputReady = await waitForSelector(webContents, GOOGLE_SEARCH_INPUT_SELECTOR, 5_000, signal);
    if (!inputReady) {
      const finalUrl = webContents.getURL() || GOOGLE_SEARCH_HOME_URL;
      const hint = await detectSearchVerification(webContents, finalUrl);
      if (hint) return { kind: 'hint', finalUrl, hint };
      return { kind: 'error', code: 'extraction_failed', message: 'Google search input did not appear', finalUrl };
    }

    const submitted = await submitGoogleSearch(webContents, query);
    if (!submitted) {
      return {
        kind: 'error',
        code: 'extraction_failed',
        message: 'failed to submit Google search form',
        finalUrl: webContents.getURL() || GOOGLE_SEARCH_HOME_URL,
      };
    }

    const reachedResults = await waitForGoogleSearchOutcome(webContents, signal);
    const finalUrl = webContents.getURL() || searchUrl;
    const hint = await detectSearchVerification(webContents, finalUrl);
    if (hint) return { kind: 'hint', finalUrl, hint };
    if (!reachedResults) {
      return { kind: 'hint', finalUrl, hint: { type: 'needs_browser', reason: 'spa_shell' } };
    }

    await gentlyScrollSearchResults(webContents);
    const payload = await safeExecuteJs<{ htmlLength: number; results: WebSearchResult[] }>(
      webContents,
      googleSerpExtractorExpression(),
    );
    if (!payload) {
      return { kind: 'error', code: 'extraction_failed', message: 'could not extract Google results', finalUrl };
    }
    return { kind: 'ok', finalUrl, results: payload.results, htmlBytes: payload.htmlLength };
  });
}

// Image search navigates straight to the Bing Images results page: Bing exposes
// every result as `a.iusc[m]` JSON (full image / thumbnail / source page), so no
// search-box dance is needed and the markup is far more scrapable than Google
// Images. Shares verification detection so a Bing challenge surfaces as
// search_blocked rather than a misleading spa_shell hint.
async function searchBingImages(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  if (!query) {
    return { kind: 'error', code: 'invalid_args', message: 'missing search query' };
  }

  const searchUrl = buildBingImagesSearchUrl(query);
  return withSearchWindow(signal, async (webContents) => {
    try {
      await navigateAndWait(webContents, searchUrl, {
        timeoutMs: SEARCH_NAV_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      return {
        kind: 'error',
        code: classifyWebError(error),
        message: errorMessage(error),
        finalUrl: webContents.getURL() || searchUrl,
      };
    }

    const ready = await waitForSelector(webContents, BING_IMAGES_RESULT_SELECTOR, 8_000, signal);
    const finalUrl = webContents.getURL() || searchUrl;
    if (!ready) {
      const hint = await detectSearchVerification(webContents, finalUrl);
      if (hint) return { kind: 'hint', finalUrl, hint };
      return { kind: 'hint', finalUrl, hint: { type: 'needs_browser', reason: 'spa_shell' } };
    }

    await gentlyScrollSearchResults(webContents);
    const payload = await safeExecuteJs<{ htmlLength: number; results: WebSearchResult[] }>(
      webContents,
      bingImagesExtractorExpression(),
    );
    if (!payload) {
      return { kind: 'error', code: 'extraction_failed', message: 'could not extract Bing image results', finalUrl };
    }
    return { kind: 'ok', finalUrl, results: payload.results, htmlBytes: payload.htmlLength };
  });
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
    title: 'Tenon Web Search',
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
