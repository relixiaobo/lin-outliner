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
import { createNodeTools, type ChatSourceValidator, type OutlinerToolHost } from './agentNodeTools';
import { createLocalTools, scratchRootForWorkdir, type AgentLocalWorkspaceContext } from './agentLocalTools';
import { createSkillTool, type AgentSkillRuntime } from './agentSkills';
import { createAgentDelegationTools, type AgentDelegationRuntime } from './agentDelegation';
import { normalizeAgentToolNames } from './agentToolRules';
import { createPastChatsTool, type PastChatsToolRuntime } from './agentPastChatsTool';
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
  WEB_FETCH_CLIENT_HINT_PLATFORM,
  WEB_FETCH_CLIENT_HINT_UA,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_RENDER_SETTLE_MS,
  WEB_FETCH_RETRY_DELAY_MS,
  WEB_FETCH_USER_AGENT,
  WEB_SEARCH_RETRY_DELAY_MS,
  WEB_SEARCH_USER_AGENT,
  buildBingImagesSearchUrl,
  buildDuckDuckGoSearchUrl,
  buildGoogleSearchUrl,
  buildWebFetchSuccessEnvelopeFromPage,
  extractFetchedPageContent,
  isPublicWebFetchUrl,
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
  crossHostRedirectHint,
  detectBrowserChallenge,
  fallbackHint,
  isTransientNetworkError,
  makeRedirectedHostHint,
  nextSecFetchSite,
  shouldTryBrowserFallbackForHttpFailure,
  webFetchRefererForHop,
} from './agentWebFetchFallback';
import {
  BING_IMAGES_RESULT_SELECTOR,
  DUCKDUCKGO_RESULT_SELECTOR,
  bingImagesExtractorExpression,
  duckDuckGoSerpExtractorExpression,
  googleSerpExtractorExpression,
  isTransientSearchError,
  shouldFallbackToSecondaryEngine,
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
  pastChats?: PastChatsToolRuntime;
  askUserQuestion?: AgentAskUserQuestionRuntime;
  chatSourceValidator?: ChatSourceValidator;
  selfMaintenance?: AgentSelfMaintenanceRuntime;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
}

export function createAgentTools(outliner?: OutlinerToolHost, options: AgentToolsOptions = {}): AgentTool<any>[] {
  // Web-fetch binaries are scratch, not workspace output: prefer the workspace's resolved
  // scratch root, otherwise derive it through the single-source default (never re-deriving a
  // cwd fallback locally — that is the one polluting path F2 removes).
  const scratchRoot = options.localWorkspace?.scratchRoot
    ?? scratchRootForWorkdir(options.localFileRoot, undefined);
  const tools = [
    ...(outliner ? createNodeTools(outliner, {
      chatSourceValidator: options.chatSourceValidator,
      localFileRoot: options.localFileRoot,
    }) : []),
    ...createLocalTools({ localRoot: options.localFileRoot, workspace: options.localWorkspace, skillRuntime: options.skillRuntime }),
    createWebSearchTool(),
    createWebFetchTool(scratchRoot),
    ...(options.pastChats ? [createPastChatsTool(options.pastChats)] : []),
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

      // One rate-limit slot per web_search call (not per internal navigation):
      // the gate throttles how fast the agent fires searches, while the chain's
      // own retry + fallback run unthrottled within the call it already paid for.
      try {
        await waitForSearchRateLimit(signal);
      } catch {
        return agentToolResult(errorEnvelope('web_search', 'aborted', 'search aborted before it started', {
          metrics: { durationMs: elapsed(started) },
        }));
      }

      try {
        const search = await provider.run(params, signal);
        const durationMs = elapsed(started);
        // The outcome may come from a fallback engine, so trust its providerName
        // when present and only default to the kind's primary provider.
        const providerName = search.providerName ?? provider.providerName;
        if (search.kind === 'hint') {
          return webSearchToolResult(successEnvelope('web_search', {
            ...baseSearchData(params, providerName, durationMs, search.finalUrl),
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
              ...baseSearchData(params, providerName, durationMs, search.finalUrl),
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
          ...baseSearchData(params, providerName, durationMs, search.finalUrl),
          resultCount: results.length,
          totalResults: allResults.length,
          truncated,
          results,
        }, {
          instructions: searchInstructions(params.kind, results.length > 0),
          warnings: searchWarnings(params, providerName),
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

const DUCKDUCKGO_PROVIDER = 'duckduckgo_html';

// One descriptor per search kind: which provider runs it and how the normalized
// query maps onto the provider call. execute() stays kind-agnostic; per-kind copy
// lives in searchWarnings/searchInstructions so adding a kind touches one place.
// `web` retries Google on a transient fault, then falls back to DuckDuckGo;
// `image` retries Bing (it has no secondary engine).
const SEARCH_PROVIDERS: Record<WebSearchKind, SearchProvider> = {
  web: { providerName: 'google_serp', run: (params, signal) => runWebSearchWithFallback(params, signal) },
  image: {
    providerName: 'bing_images',
    run: (params, signal) => runSearchWithRetry(() => searchBingImages(params.effectiveQuery, signal), signal),
  },
};

// Run an engine attempt, retrying once after a short backoff on a transient nav
// fault (network drop / timeout). Blocks, extraction misses, bad queries, and
// aborts are returned as-is — retrying them just wastes a round trip.
async function runSearchWithRetry(
  attempt: () => Promise<SearchOutcome>,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const first = await attempt();
  if (signal?.aborted || first.kind !== 'error' || !isTransientSearchError(first.code)) return first;
  await delay(WEB_SEARCH_RETRY_DELAY_MS, signal);
  return attempt();
}

// Web search: Google (with one transient retry), then DuckDuckGo — itself
// retried once — when Google is blocked, empty, or failed recoverably. The
// DuckDuckGo outcome carries its own providerName so the envelope and the
// fallback warning reflect the real engine.
async function runWebSearchWithFallback(
  params: NormalizedWebSearchParams,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const google = await runSearchWithRetry(
    () => searchGoogle(buildGoogleSearchUrl(params.effectiveQuery), signal),
    signal,
  );
  if (signal?.aborted) return google;
  const summary = {
    kind: google.kind,
    resultCount: google.kind === 'ok' ? google.results.length : 0,
    ...(google.kind === 'error' ? { code: google.code } : {}),
  };
  if (!shouldFallbackToSecondaryEngine(summary)) return google;

  // Give the fallback the same one-shot transient retry the primary got.
  const duck = await runSearchWithRetry(
    () => searchDuckDuckGo(params.effectiveQuery, signal),
    signal,
  );
  // A DuckDuckGo page that loaded and parsed is authoritative even when empty:
  // returning it tells the agent "no hits — broaden the query" rather than a
  // misleading "retry / use a browser", and it is the only branch where a
  // fallback result is surfaced (so the fallback warning fires exactly here).
  if (duck.kind === 'ok') return duck;
  // The fallback did not yield results either. Surface the primary, user-intended
  // Google outcome — its hint/error is the more diagnostic signal and its
  // finalUrl points at the google.com SERP the user asked for — rather than
  // discarding it for DuckDuckGo's own failure.
  return google;
}

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

function searchWarnings(params: NormalizedWebSearchParams, providerName?: string): string[] | undefined {
  const warnings: string[] = [];
  if (providerName === DUCKDUCKGO_PROVIDER) {
    // The primary engine may have been blocked, empty, OR unparseable — do not
    // assert it was "unavailable", which could be false and mislead the agent.
    warnings.push('These results are from the DuckDuckGo fallback; the primary engine (Google) returned no usable results.');
  }
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
  try {
    return await fetchTextOnce(url, scratchRoot, signal);
  } catch (error) {
    if (signal?.aborted || !isRetriableFetchFailure(error)) throw error;
    await delay(WEB_FETCH_RETRY_DELAY_MS, signal);
    return await fetchTextOnce(url, scratchRoot, signal);
  }
}

function isRetriableFetchFailure(error: unknown): boolean {
  // An HTTP response (403/429/5xx, login wall, Cloudflare) surfaces as a
  // WebToolFailure, not a network throw: it is handled by the browser fallback,
  // never by a same-headers retry. A timeout/abort is also a WebToolFailure and
  // is not worth a second identical attempt.
  if (error instanceof WebToolFailure) return false;
  // An AbortError is the parent aborting, not a fault we own.
  if (error instanceof Error && error.name === 'AbortError') return false;
  // Only a recognized transient transport fault earns the one retry.
  return isTransientNetworkError(error);
}

async function fetchTextOnce(url: string, scratchRoot: string, signal?: AbortSignal): Promise<FetchTextResult> {
  const startedUrl = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort('parent_aborted');
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await fetchTextWithRedirects(startedUrl, startedUrl, controller.signal, scratchRoot);
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

// State carried across a redirect hop so request headers can mirror a real
// browser navigation: the referrer (the URL we are coming from) and the
// chain-monotonic Sec-Fetch-Site value for the hop being made.
interface WebFetchRedirectContext {
  referrerUrl: string;
  secFetchSite: 'same-origin' | 'cross-site';
}

async function fetchTextWithRedirects(
  currentUrl: string,
  startedUrl: string,
  signal: AbortSignal,
  scratchRoot: string,
  depth = 0,
  redirect?: WebFetchRedirectContext,
): Promise<FetchTextResult> {
  if (depth > WEB_FETCH_MAX_REDIRECTS) {
    throw new WebToolFailure('too_many_redirects', `too many redirects; exceeded ${WEB_FETCH_MAX_REDIRECTS}`);
  }

  const response = await electronSession.defaultSession.fetch(currentUrl, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: buildFetchHeaders(currentUrl, redirect),
  });

  if (HTTP_REDIRECT_STATUSES.has(response.status)) {
    const redirectUrl = resolveRedirectUrl(currentUrl, response.headers.get('location'));
    if (!redirectUrl) {
      throw new WebToolFailure('invalid_redirect', `HTTP ${response.status} redirect is missing a valid Location header`, {
        finalUrl: currentUrl,
        statusCode: response.status,
      });
    }
    // Follow redirects across hosts (shorteners, trackers, regional/mobile
    // subdomains), preserving the server's literal scheme — an http→https upgrade
    // here would break an http-only target. A redirect to a local/private host is
    // the one case we refuse (isPublicWebFetchUrl); a cross-host landing is
    // surfaced later as a non-fatal redirected_host hint, not a failure.
    if (!isPublicWebFetchUrl(redirectUrl)) {
      throw redirectedHostFailure(startedUrl, redirectUrl, response.status);
    }
    const secFetchSite = nextSecFetchSite(redirect?.secFetchSite, currentUrl, redirectUrl);
    return await fetchTextWithRedirects(redirectUrl, startedUrl, signal, scratchRoot, depth + 1, {
      referrerUrl: currentUrl,
      secFetchSite,
    });
  }

  const finalUrl = response.url || currentUrl;
  const redirectedHostHint = crossHostRedirectHint(startedUrl, finalUrl);
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status === 401) {
    const body = await readSmallErrorBody(response, contentType);
    const challenge = detectBrowserChallenge(body, finalUrl, response.statusText);
    if (challenge) {
      throw new WebToolFailure('http_error', `HTTP ${response.status} ${response.statusText || ''}`.trim(), {
        finalUrl,
        statusCode: response.status,
        hint: { type: 'needs_browser', reason: challenge },
      });
    }
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
      ...(redirectedHostHint ? { redirectedHostHint } : {}),
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
    ...(redirectedHostHint ? { redirectedHostHint } : {}),
  };
}

// Mirror the request headers a real Chrome navigation sends, computed per hop.
// On the first request (no referrer) it is a fresh top-level navigation:
// sec-fetch-site:none plus the user-gesture bit. On a redirect hop it carries a
// Referer (the previous URL) and a redirect-consistent sec-fetch-site, so the
// request never looks like an impossible brand-new top-level nav mid-chain.
function buildFetchHeaders(currentUrl: string, redirect?: WebFetchRedirectContext): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': WEB_FETCH_USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': WEB_FETCH_CLIENT_HINT_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': WEB_FETCH_CLIENT_HINT_PLATFORM,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'upgrade-insecure-requests': '1',
  };
  if (!redirect) {
    headers['sec-fetch-site'] = 'none';
    headers['sec-fetch-user'] = '?1';
    return headers;
  }
  // Referer follows Chrome's strict-origin-when-cross-origin default (origin-only
  // cross-origin, dropped on an https→http downgrade); sec-fetch-site is the
  // chain-monotonic value computed at redirect time.
  const referer = webFetchRefererForHop(redirect.referrerUrl, currentUrl);
  if (referer) headers.referer = referer;
  headers['sec-fetch-site'] = redirect.secFetchSite;
  return headers;
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
    hint: makeRedirectedHostHint(startedUrl, redirectUrl),
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
  // A blocked navigation must reject promptly: once we preventDefault it, no
  // did-finish-load fires, so navigateAndWait would otherwise hang to its
  // timeout. Racing this promise surfaces the refusal immediately.
  const blockedNavigationPromise = new Promise<never>((_resolve, reject) => {
    rejectBlockedNavigation = reject;
  });
  // Follow public cross-host navigation (shorteners, regional fronts) just like
  // the HTTP path, but refuse a hop to a local/private host — the one SSRF guard
  // kept even under the local-only, success-rate-first focus. A renderer can
  // navigate via 3xx, meta-refresh, or JS, none of which the HTTP-path redirect
  // check sees, so the guard lives here too.
  const blockNonPublicNavigation = (targetUrl: string, event: { preventDefault(): void }) => {
    if (isPublicWebFetchUrl(targetUrl)) return;
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
    blockNonPublicNavigation(event.url || redirectUrl, event);
  };
  const onWillNavigate = (
    event: ElectronEvent<WebContentsWillNavigateEventParams>,
    navigateUrl: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame) return;
    blockNonPublicNavigation(event.url || navigateUrl, event);
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
  // Render with the same real-browser identity as the HTTP path so challenge
  // pages clear; a public cross-host landing is surfaced as a non-fatal
  // redirected_host hint below.
  window.webContents.setUserAgent(WEB_FETCH_USER_AGENT);

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
    // Re-validate the landing URL: a navigation the guard never saw (e.g. a
    // same-tick replace) could still have parked us on a non-public host.
    if (!isPublicWebFetchUrl(finalUrl)) {
      throw redirectedHostFailure(url, finalUrl, 0);
    }
    const redirectedHostHint = crossHostRedirectHint(url, finalUrl);
    return {
      requestedUrl: url,
      finalUrl,
      statusCode: 200,
      statusText: 'OK',
      contentType: 'text/html; charset=utf-8',
      byteLength: Buffer.byteLength(payload.html, 'utf8'),
      body: payload.html,
      ...(redirectedHostHint ? { redirectedHostHint } : {}),
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
  | { kind: 'ok'; finalUrl: string; results: WebSearchResult[]; htmlBytes: number; providerName?: string }
  | { kind: 'hint'; finalUrl: string; hint: WebToolHint; providerName?: string }
  | { kind: 'error'; finalUrl?: string; code: string; message: string; providerName?: string };

// Owns the hidden-window lifecycle shared by every search kind: the off-screen
// BrowserWindow, abort wiring, and guaranteed teardown. The rate-limit gate is
// NOT here — it is acquired once per web_search call in execute(), so a single
// search's internal cascade (a transient retry, then the DuckDuckGo fallback)
// never self-throttles or burns the cross-call burst budget mid-call. Each
// provider supplies only its navigate-and-extract body.
async function withSearchWindow(
  signal: AbortSignal | undefined,
  run: (webContents: WebContents) => Promise<SearchOutcome>,
): Promise<SearchOutcome> {
  const window = createWebSearchWindow();
  // Render with a real Chrome desktop UA instead of Electron's default (which
  // advertises "Electron" + the app name) so engines serve the standard desktop
  // SERP the scrapers target and are marginally less likely to gate the session.
  window.webContents.setUserAgent(WEB_SEARCH_USER_AGENT);
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

interface ServerRenderedSerpSpec {
  searchUrl: string;
  // Single source of truth for the result anchor (also used as the readiness
  // gate) and the in-page extractor serialized from the pure SERP function.
  resultSelector: string;
  extractorExpression: string;
  emptyMessage: string;
  providerName?: string;
  // Bing lazy-loads image tiles and needs a nudge; DuckDuckGo's /html/ endpoint
  // is fully server-rendered, so it does not.
  scroll?: boolean;
}

// Shared scrape skeleton for a server-rendered SERP (Bing Images, DuckDuckGo
// /html/): navigate → wait for the result selector → on miss run the shared
// verification check (generic reCAPTCHA / Cloudflare / "Just a moment" markers
// surface as search_blocked, otherwise a needs_browser hint) → extract. Google
// is NOT routed through here — it needs the search-box dance. Keeping the two
// server-rendered engines on one skeleton stops their block/abort/timeout
// handling from drifting apart.
async function runServerRenderedSerp(
  spec: ServerRenderedSerpSpec,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const tag = spec.providerName ? { providerName: spec.providerName } : {};
  return withSearchWindow(signal, async (webContents) => {
    try {
      await navigateAndWait(webContents, spec.searchUrl, {
        timeoutMs: SEARCH_NAV_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      return {
        kind: 'error',
        code: classifyWebError(error),
        message: errorMessage(error),
        finalUrl: webContents.getURL() || spec.searchUrl,
        ...tag,
      };
    }

    const ready = await waitForSelector(webContents, spec.resultSelector, 8_000, signal);
    const finalUrl = webContents.getURL() || spec.searchUrl;
    if (!ready) {
      const hint = await detectSearchVerification(webContents, finalUrl);
      if (hint) return { kind: 'hint', finalUrl, hint, ...tag };
      return { kind: 'hint', finalUrl, hint: { type: 'needs_browser', reason: 'spa_shell' }, ...tag };
    }

    if (spec.scroll) await gentlyScrollSearchResults(webContents);
    const payload = await safeExecuteJs<{ htmlLength: number; results: WebSearchResult[] }>(
      webContents,
      spec.extractorExpression,
    );
    if (!payload) {
      return { kind: 'error', code: 'extraction_failed', message: spec.emptyMessage, finalUrl, ...tag };
    }
    return { kind: 'ok', finalUrl, results: payload.results, htmlBytes: payload.htmlLength, ...tag };
  });
}

// Image search navigates straight to the Bing Images results page: Bing exposes
// every result as `a.iusc[m]` JSON (full image / thumbnail / source page), so no
// search-box dance is needed and the markup is far more scrapable than Google
// Images.
async function searchBingImages(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  if (!query) {
    return { kind: 'error', code: 'invalid_args', message: 'missing search query' };
  }
  return runServerRenderedSerp({
    searchUrl: buildBingImagesSearchUrl(query),
    resultSelector: BING_IMAGES_RESULT_SELECTOR,
    extractorExpression: bingImagesExtractorExpression(),
    emptyMessage: 'could not extract Bing image results',
    scroll: true,
  }, signal);
}

// DuckDuckGo HTML-endpoint fallback for kind:"web". The /html/ page is
// server-rendered (no search-box dance, no scroll), so it loads the results
// directly. Its outcomes carry providerName so execute() reports the real engine.
async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  if (!query) {
    return { kind: 'error', code: 'invalid_args', message: 'missing search query', providerName: DUCKDUCKGO_PROVIDER };
  }
  return runServerRenderedSerp({
    searchUrl: buildDuckDuckGoSearchUrl(query),
    resultSelector: DUCKDUCKGO_RESULT_SELECTOR,
    extractorExpression: duckDuckGoSerpExtractorExpression(),
    emptyMessage: 'could not extract DuckDuckGo results',
    providerName: DUCKDUCKGO_PROVIDER,
  }, signal);
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
