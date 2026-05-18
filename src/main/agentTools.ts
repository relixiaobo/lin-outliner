import { BrowserWindow, session as electronSession, type WebContents } from 'electron';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createNodeTools, type OutlinerToolHost } from './agentNodeTools';
import { createLocalTools } from './agentLocalTools';
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
  buildWebFetchSuccessEnvelope,
  normalizeWebFetchParams,
  normalizeWebSearchParams,
  type FetchTextResult,
  type WebFetchData,
  type WebSearchData,
  type WebSearchResult,
  type WebToolHint,
} from './agentWebTools';

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
      description: 'The absolute http(s) URL to read. Use web_search first if you do not know the URL. http:// URLs are upgraded to https://.',
    },
    format: {
      type: 'string',
      enum: ['markdown', 'text', 'raw', 'metadata'],
      description: 'Output format. Defaults to markdown. Use metadata when you only need title, description, headings, and links.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: 'Character offset for read mode. Use nextOffset from a previous web_fetch result to continue reading. Default 0.',
    },
    max_chars: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_FETCH_CHARS,
      description: `Maximum characters returned in read mode. Default ${DEFAULT_FETCH_CHARS}, max ${MAX_FETCH_CHARS}.`,
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'When set, use find mode and return matching snippets from this page instead of the full page.',
    },
    context: {
      type: 'integer',
      minimum: 0,
      maximum: 2000,
      description: 'Characters before and after each query match in find mode. Default 500.',
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
      description: 'Skip the first N matches in find mode. Use nextMatchOffset from a previous result to continue. Default 0.',
    },
    case_insensitive: {
      type: 'boolean',
      description: 'Case-insensitive matching in find mode. Default true.',
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
      description: 'The web search query. Natural language and search operators are allowed. Include relevant dates, names, or locations when freshness matters.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      description: `Maximum search results to return. Default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}.`,
    },
    site: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Optional single host to scope the search to. Do not include "site:"; the tool adds it.',
    },
    recency_days: {
      type: 'integer',
      minimum: 1,
      maximum: 3650,
      description: 'Optional freshness hint in days. Treat as best effort and verify dates by fetching sources when freshness matters.',
    },
  },
};

export type { ToolEnvelope } from './agentToolEnvelope';

export interface AgentToolsOptions {
  localFileRoot?: string;
}

export function createAgentTools(outliner?: OutlinerToolHost, options: AgentToolsOptions = {}): AgentTool<any>[] {
  return [
    ...(outliner ? createNodeTools(outliner) : []),
    ...createLocalTools({ localRoot: options.localFileRoot }),
    createWebSearchTool(),
    createWebFetchTool(),
  ];
}

function createWebFetchTool(): AgentTool<any, ToolEnvelope<WebFetchData>> {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description: [
      'Reads a known URL and returns extracted page content directly, not a secondary-model summary.',
      'Use this when you already have a source URL. Use web_search first when you need to discover sources.',
      'Use query/context/head_limit for find mode on large pages. Use offset/max_chars and nextOffset to page through read mode.',
      'Use format="metadata" when you only need page title, description, headings, and links.',
      'If the page requires login or blocks automated fetches, ask the user to sign in or use another source.',
    ].join('\n'),
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
        const fetched = await fetchText(params.url, signal);
        return agentToolResult(buildWebFetchSuccessEnvelope(fetched, params, elapsed(started)));
      } catch (error) {
        if (error instanceof WebToolFailure && error.hint) {
          return agentToolResult(successEnvelope('web_fetch', {
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
            instructions: error.hint.type === 'login_required'
              ? 'Ask the user to sign in to this site, then retry web_fetch.'
              : 'Use a browser-backed reader path when available, or try another source with web_search.',
            metrics: { durationMs: elapsed(started) },
          }));
        }
        return agentToolResult(errorEnvelope('web_fetch', classifyWebError(error), errorMessage(error), {
          instructions: 'Retry once if this looks transient. If it still fails, use web_search for another source.',
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
      'Searches the web for current external information and source URLs.',
      'Use this when you do not already have a specific URL, or when local knowledge may be stale.',
      'Returns URLs, titles, and snippets. Use web_fetch on result URLs when you need evidence, details, or exact dates.',
      'Use site for one-host searches. Use recency_days only as a freshness hint and verify dates with fetched sources.',
    ].join('\n'),
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
      const { query, effectiveQuery, limit, searchUrl } = params;

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
            instructions: search.hint.type === 'search_blocked'
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
            instructions: 'Retry once if this looks transient. If it still fails, try a more specific query or direct URL.',
            metrics: { durationMs: elapsed(started) },
          }));
        }

        const allResults = search.results;
        const results = allResults.slice(0, limit);
        const truncated = allResults.length > results.length;
        const warnings = params.recencyDays
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
          instructions: results.length === 0 ? 'Try a broader query or remove site/recency constraints.' : undefined,
          warnings,
          metrics: { durationMs: elapsed(started), truncated, outputBytes: search.htmlBytes },
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
