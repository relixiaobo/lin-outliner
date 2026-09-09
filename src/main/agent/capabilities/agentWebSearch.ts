import {
  SEARCH_MCP_ENDPOINTS,
  SearchMcpError,
  searchMcpProvider,
  type SearchHttpFetch,
  type SearchMcpProvider,
} from './agentWebSearchMcp';
import type { NormalizedWebSearchParams, WebSearchAttempt, WebSearchOutcome } from './agentWebTools';

export const WEB_SEARCH_HTTP_PARTITION = 'web-search-http';
const PROVIDERS: readonly SearchMcpProvider[] = ['parallel', 'exa'];
const CACHE_TTL_MS = 60_000;
const CACHE_SIZE = 64;

interface SearchOptions {
  fetch: SearchHttpFetch;
  apiKeys?: Partial<Record<SearchMcpProvider, string>>;
  now?: () => number;
  timeoutMs?: number;
  attemptTimeoutMs?: number;
}

interface PendingSearch {
  controller: AbortController;
  promise: Promise<WebSearchOutcome>;
  subscribers: number;
  settled: boolean;
}

/** Owns search policy; the injected transport keeps Electron out of this module. */
export function createHttpWebSearch(options: SearchOptions) {
  const now = options.now ?? Date.now;
  // Configuration is fixed for this client, so caches never cross credentials.
  const apiKeys = { ...options.apiKeys };
  const cache = new Map<string, { expiresAt: number; outcome: WebSearchOutcome }>();
  const pending = new Map<string, PendingSearch>();
  const cooldown = new Map<SearchMcpProvider, { until: number; code: string }>();

  async function run(params: NormalizedWebSearchParams, signal: AbortSignal): Promise<WebSearchOutcome> {
    const deadline = now() + (options.timeoutMs ?? 20_000);
    const attempts: WebSearchAttempt[] = [];
    let lastEmpty: WebSearchOutcome | undefined;
    for (const provider of PROVIDERS) {
      if (signal.aborted) return aborted();
      const suspended = cooldown.get(provider);
      if (suspended && suspended.until > now()) {
        attempts.push({ providerName: provider, status: 'skipped', code: suspended.code, durationMs: 0 });
        continue;
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        attempts.push({ providerName: provider, status: 'skipped', code: 'timeout', durationMs: 0 });
        continue;
      }
      const started = now();
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, Math.min(remainingMs, options.attemptTimeoutMs ?? 10_000));
      try {
        const result = await searchMcpProvider(options.fetch, provider, params, controller.signal, now(), apiKeys[provider]);
        if (signal.aborted) return aborted();
        if (controller.signal.aborted) throw new SearchMcpError('timeout');
        cooldown.delete(provider);
        attempts.push({ providerName: provider, status: result.results.length ? 'success' : 'empty', durationMs: now() - started });
        const outcome: WebSearchOutcome = {
          kind: 'ok', providerName: provider, finalUrl: SEARCH_MCP_ENDPOINTS[provider], ...result, attempts,
        };
        if (result.results.length) return outcome;
        lastEmpty = outcome;
      } catch (error) {
        if (signal.aborted) return aborted();
        const code = controller.signal.aborted ? 'timeout' : error instanceof SearchMcpError ? error.code : 'network_error';
        const pause = error instanceof SearchMcpError ? error.retryAfterMs : undefined;
        cooldown.set(provider, { until: now() + Math.max(30_000, Math.min(pause ?? 30_000, 300_000)), code });
        attempts.push({ providerName: provider, status: 'error', code, durationMs: now() - started });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
      }
    }
    if (lastEmpty && attempts.every((attempt) => attempt.status === 'empty')) return lastEmpty;
    return {
      kind: 'error', code: 'search_unavailable', providerName: attempts.at(-1)?.providerName,
      message: `Search providers unavailable: ${attempts.map((attempt) => `${attempt.providerName} (${attempt.code ?? attempt.status})`).join(', ')}.`,
      instructions: 'Search providers failed or are cooling down. Use web_fetch if a source URL is known, or retry later; changing the query will not fix provider availability.',
      attempts,
    };
  }

  return async (params: NormalizedWebSearchParams, signal?: AbortSignal): Promise<WebSearchOutcome> => {
    if (signal?.aborted) return aborted();
    const key = JSON.stringify([params.effectiveQuery, params.limit, params.site, params.recencyDays,
      params.recencyDays ? new Date(now()).toISOString().slice(0, 10) : null]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return structuredClone({ ...cached.outcome, cached: true });
    cache.delete(key);
    let job = pending.get(key);
    if (!job) {
      const controller = new AbortController();
      const promise = run(params, controller.signal).then((outcome) => {
        if (!controller.signal.aborted && outcome.kind === 'ok' && outcome.results.length) {
          for (const [cacheKey, entry] of cache) if (entry.expiresAt <= now()) cache.delete(cacheKey);
          cache.set(key, { expiresAt: now() + CACHE_TTL_MS, outcome });
          if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
        }
        return outcome;
      }).finally(() => {
        created.settled = true;
        if (pending.get(key) === created) pending.delete(key);
      });
      const created: PendingSearch = { controller, promise, subscribers: 0, settled: false };
      pending.set(key, created);
      job = created;
    }
    return subscribe(job, signal, () => {
      if (pending.get(key) === job) pending.delete(key);
    });
  };
}

function subscribe(job: PendingSearch, signal: AbortSignal | undefined, remove: () => void): Promise<WebSearchOutcome> {
  job.subscribers++;
  return new Promise((resolve, reject) => {
    let done = false;
    const release = (): boolean => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      job.subscribers--;
      if (!job.settled && job.subscribers === 0) {
        remove();
        job.controller.abort();
      }
      return true;
    };
    const onAbort = () => { if (release()) resolve(aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    job.promise.then(
      (outcome) => { if (release()) resolve(structuredClone(outcome)); },
      (error) => { if (release()) reject(error); },
    );
  });
}

function aborted(): WebSearchOutcome {
  return { kind: 'error', code: 'aborted', message: 'Search cancelled.' };
}
