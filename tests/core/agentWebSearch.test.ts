import { describe, expect, test } from 'bun:test';
import { createHttpWebSearch } from '../../src/main/agent/capabilities/agentWebSearch';
import { SEARCH_MCP_ENDPOINTS, searchMcpProvider, type SearchHttpFetch } from '../../src/main/agent/capabilities/agentWebSearchMcp';
import { normalizeWebSearchParams, webSearchModelData, type NormalizedWebSearchParams } from '../../src/main/agent/capabilities/agentWebTools';
import { modelToolContract } from '../../src/core/agent/tools';
import { compileToolParameters } from '../../src/main/agent/runtime/kernel/exactToolArguments';

const params = (extra: Record<string, unknown> = {}): NormalizedWebSearchParams => {
  const normalized = normalizeWebSearchParams({ query: 'Electron session fetch', limit: 5, ...extra });
  if (!normalized.ok) throw new Error(normalized.message);
  return normalized.params;
};
const hit = (url = 'https://www.electronjs.org/docs/latest/api/session') => ({
  title: 'Electron session', url, excerpts: ['Session.fetch uses the Chromium network stack.'], publish_date: '2026-09-09',
});
const request = (init: RequestInit) => JSON.parse(init.body as string);
const reply = (init: RequestInit, result: unknown) => Response.json({ jsonrpc: '2.0', id: request(init).id, result });
const hits = (init: RequestInit, items: unknown[] = [hit()]) => reply(init, { structuredContent: { results: items } });
const exaText = 'Title: Electron session\nURL: https://www.electronjs.org/docs/latest/api/session\nPublished: 2026-09-09\nAuthor: N/A\nHighlights:\nChromium fetch documentation.\n\n---\n\nTitle: Electron net\nURL: https://www.electronjs.org/docs/latest/api/net\nPublished: N/A\nText: Network documentation.';
const exa = (init: RequestInit) => reply(init, { content: [{ type: 'text', text: exaText }] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('HTTP search provider contract', () => {
  test('uses one anonymous fixed-endpoint POST and returns structured discovery records', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const search = createHttpWebSearch({ fetch: async (url, init) => {
      calls.push({ url, init });
      return hits(init);
    } });
    const outcome = await search(params());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SEARCH_MCP_ENDPOINTS.parallel);
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(new Headers(calls[0].init.headers).has('authorization')).toBe(false);
    expect(request(calls[0].init)).toMatchObject({ method: 'tools/call', params: {
      name: 'web_search', arguments: { objective: 'Electron session fetch', search_queries: ['Electron session fetch'] },
    } });
    expect(outcome).toMatchObject({ kind: 'ok', providerName: 'parallel', results: [{
      title: 'Electron session', snippet: 'Session.fetch uses the Chromium network stack.', publishedAt: '2026-09-09',
    }] });
  });

  test('preserves the full long objective and encodes site and freshness hints', async () => {
    let sent: ReturnType<typeof request>;
    const search = createHttpWebSearch({ now: () => Date.parse('2026-09-09T12:00:00Z'), fetch: async (_url, init) => {
      sent = request(init);
      return hits(init);
    } });
    await search(params({ query: 'long query '.repeat(30), site: 'electronjs.org', recency_days: 2 }));
    expect(sent.params.arguments.objective).toContain('site:electronjs.org after:2026-09-07');
    expect(sent.params.arguments.objective).toStartWith('long query '.repeat(30).trim());
    expect(Array.from(sent.params.arguments.search_queries[0]).length).toBeLessThanOrEqual(200);
  });

  test('falls back once to Exa and retains both attempts without leaking a provider error', async () => {
    const calls: string[] = [];
    const search = createHttpWebSearch({ fetch: async (url, init) => {
      calls.push(url);
      if (url === SEARCH_MCP_ENDPOINTS.parallel) throw new Error('secret=do-not-echo');
      return exa(init);
    } });
    const outcome = await search(params());
    expect(calls).toEqual([SEARCH_MCP_ENDPOINTS.parallel, SEARCH_MCP_ENDPOINTS.exa]);
    expect(outcome).toMatchObject({ kind: 'ok', providerName: 'exa', attempts: [
      { providerName: 'parallel', code: 'network_error', status: 'error' },
      { providerName: 'exa', status: 'success' },
    ], results: [{ title: 'Electron session', snippet: 'Chromium fetch documentation.' }, { title: 'Electron net', snippet: 'Network documentation.' }] });
    expect(JSON.stringify(outcome)).not.toContain('do-not-echo');
  });

  test('decodes SSE multiline data and ignores notifications and unrelated response IDs', async () => {
    const fetch: SearchHttpFetch = async (_url, init) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id: request(init).id, result: { content: [{ type: 'text', text: exaText }] } });
      return new Response([
        ': heartbeat', '',
        'event: message', 'data: {"jsonrpc":"2.0","method":"notifications/progress"}', '',
        'data: {"jsonrpc":"2.0","id":"wrong-id","error":{"message":"quota exceeded"}}', '',
        'event: message', `data: ${payload.slice(0, payload.indexOf(',') + 1)}`,
        `data: ${payload.slice(payload.indexOf(',') + 1)}`, '', '',
      ].join('\r\n'), { headers: { 'content-type': 'text/event-stream' } });
    };
    const outcome = await searchMcpProvider(fetch, 'exa', params(), new AbortController().signal, Date.now());
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[1].publishedAt).toBeUndefined();
  });

  test('accepts JSON text payloads and authoritative Exa empty text', async () => {
    const jsonText = await searchMcpProvider(async (_url, init) => reply(init, { content: [
      { type: 'text', text: JSON.stringify({ results: [hit()] }) },
    ] }), 'parallel', params(), new AbortController().signal, Date.now());
    expect(jsonText.results).toHaveLength(1);
    const empty = await searchMcpProvider(async (_url, init) => reply(init, { content: [
      { type: 'text', text: 'No search results found.' },
    ] }), 'exa', params(), new AbortController().signal, Date.now());
    expect(empty.results).toEqual([]);
  });

  test.each([
    ['RPC error', (init: RequestInit) => Response.json({ id: request(init).id, error: { message: 'upstream failure' } }), 'provider_error'],
    ['tool error', (init: RequestInit) => reply(init, { isError: true, content: [{ type: 'text', text: 'rate limit exceeded' }] }), 'rate_limited'],
    ['wrong ID', () => Response.json({ id: 'wrong-id', result: { structuredContent: { results: [] } } }), 'invalid_response'],
    ['invalid JSON', () => new Response('<html>Challenge</html>'), 'invalid_response'],
    ['missing results', (init: RequestInit) => reply(init, { structuredContent: {} }), 'invalid_response'],
    ['malformed results', (init: RequestInit) => hits(init, [null, { url: 'javascript:alert(1)', title: 'Invalid' }]), 'invalid_response'],
    ['arbitrary text', (init: RequestInit) => reply(init, { content: [{ type: 'text', text: 'Please perform another action.' }] }), 'invalid_response'],
  ])('rejects %s instead of reporting an empty success', async (_name, fetch, code) => {
    await expect(searchMcpProvider(async (_url, init) => fetch(init), 'parallel', params(), new AbortController().signal, Date.now()))
      .rejects.toMatchObject({ code });
  });

  test('validates URLs, deduplicates, and applies the site boundary to usable results', async () => {
    const outcome = await searchMcpProvider(async (_url, init) => hits(init, [
      hit('javascript:alert(1)'), hit('https://user:secret@electronjs.org/'),
      hit('https://outside.test/'), hit('https://electronjs.org/docs#one'), hit('https://electronjs.org/docs#two'),
      hit('https://www.electronjs.org/api'), hit('https://electronjs.org.evil.test/'),
    ]), 'parallel', params({ site: 'electronjs.org' }), new AbortController().signal, Date.now());
    expect(outcome.results.map((entry) => entry.url)).toEqual(['https://electronjs.org/docs', 'https://www.electronjs.org/api']);
  });

  test('bounds large escaped records and keeps complete URLs in the existing model projection', async () => {
    const outcome = await searchMcpProvider(async (_url, init) => hits(init, Array.from({ length: 20 }, (_, index) => ({
      title: '\u0000'.repeat(350), url: `https://example.com/${index}/${'x'.repeat(2000)}`,
      excerpts: ['\u0001'.repeat(1700)],
    }))), 'parallel', params({ limit: 20 }), new AbortController().signal, Date.now());
    expect(outcome.truncated).toBe(true);
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(outcome.results))).toBeLessThanOrEqual(64 * 1024);
    const projected = webSearchModelData({ ...params(), provider: 'provider', providerName: 'parallel',
      resultCount: outcome.results.length, truncated: true, results: outcome.results,
      attempts: [{ providerName: 'parallel', status: 'success', durationMs: 100 }], cached: true,
    });
    expect(JSON.stringify(projected)).not.toContain('attempts');
    expect(JSON.stringify(projected)).not.toContain('cached');
    expect((projected as { results: Array<{ url: string }> }).results[0].url).toEndWith('x'.repeat(2000));
    const schema = modelToolContract('web_search')!.outputSchema!;
    expect(compileToolParameters(schema as never).Check(projected)).toBe(true);
  });

  test('cancels an oversized response stream', async () => {
    let cancelled = false;
    const fetch: SearchHttpFetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(513 * 1024)); },
      cancel() { cancelled = true; },
    }));
    await expect(searchMcpProvider(fetch, 'parallel', params(), new AbortController().signal, Date.now()))
      .rejects.toMatchObject({ code: 'response_too_large' });
    expect(cancelled).toBe(true);
  });

  test('keeps optional credentials in provider-specific headers', async () => {
    const observed: Array<{ url: string; headers: Headers; body: string }> = [];
    const search = createHttpWebSearch({ apiKeys: { parallel: 'test-parallel-key', exa: 'test-exa-key' }, fetch: async (url, init) => {
      observed.push({ url, headers: new Headers(init.headers), body: init.body as string });
      return url === SEARCH_MCP_ENDPOINTS.parallel ? new Response('', { status: 401 }) : exa(init);
    } });
    await search(params());
    expect(observed[0].headers.get('authorization')).toBe('Bearer test-parallel-key');
    expect(observed[1].headers.get('x-api-key')).toBe('test-exa-key');
    expect(observed[1].headers.has('authorization')).toBe(false);
    for (const entry of observed) expect(entry.url + entry.body).not.toContain('-key');
  });
});

describe('HTTP search lifecycle', () => {
  test('returns empty only when both providers returned valid empty results', async () => {
    const empty = createHttpWebSearch({ fetch: async (_url, init) => hits(init, []) });
    expect(await empty(params())).toMatchObject({ kind: 'ok', results: [], attempts: [{ status: 'empty' }, { status: 'empty' }] });
    for (const failingProvider of [SEARCH_MCP_ENDPOINTS.parallel, SEARCH_MCP_ENDPOINTS.exa]) {
      const mixed = createHttpWebSearch({ fetch: async (url, init) => url === failingProvider
        ? new Response('', { status: 503 }) : hits(init, []) });
      expect(await mixed(params())).toMatchObject({ kind: 'error', code: 'search_unavailable' });
    }
  });

  test('honors rate-limit cooldown across different queries and retries after it expires', async () => {
    let clock = Date.parse('2026-09-09T12:00:00Z');
    const calls: string[] = [];
    const search = createHttpWebSearch({ now: () => clock, fetch: async (url, init) => {
      calls.push(url);
      return url === SEARCH_MCP_ENDPOINTS.parallel ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : exa(init);
    } });
    await search(params());
    expect(await search(params({ query: 'different query' }))).toMatchObject({ kind: 'ok', attempts: [
      { providerName: 'parallel', status: 'skipped', code: 'rate_limited' }, { providerName: 'exa', status: 'success' },
    ] });
    expect(calls.filter((url) => url === SEARCH_MCP_ENDPOINTS.parallel)).toHaveLength(1);
    clock += 60_001;
    await search(params({ query: 'third query' }));
    expect(calls.filter((url) => url === SEARCH_MCP_ENDPOINTS.parallel)).toHaveLength(2);
  });

  test('caches success briefly, isolates caller mutations and keys, and expires it', async () => {
    let clock = Date.parse('2026-09-09T12:00:00Z');
    let calls = 0;
    const search = createHttpWebSearch({ now: () => clock, fetch: async (_url, init) => { calls++; return hits(init); } });
    const first = await search(params());
    if (first.kind === 'ok') first.results[0].title = 'Caller mutation';
    expect(await search(params())).toMatchObject({ cached: true, results: [{ title: 'Electron session' }] });
    expect(calls).toBe(1);
    await search(params({ limit: 3 }));
    await search(params({ site: 'electronjs.org' }));
    await search(params({ recency_days: 1 }));
    expect(calls).toBe(4);
    clock += 60_001;
    expect((await search(params())).cached).not.toBe(true);
    expect(calls).toBe(5);
  });

  test('keeps separate client credentials and enforces bounded cache retention', async () => {
    let calls = 0;
    const fetch: SearchHttpFetch = async (_url, init) => { calls++; return hits(init); };
    const first = createHttpWebSearch({ fetch, apiKeys: { parallel: 'first' } });
    const second = createHttpWebSearch({ fetch, apiKeys: { parallel: 'second' } });
    await first(params()); await second(params());
    expect(calls).toBe(2);
    for (let index = 0; index < 65; index++) await first(params({ query: `query ${index}` }));
    await first(params());
    expect(calls).toBe(68);
  });

  test('coalesces identical calls while one caller cancels independently', async () => {
    const gate = deferred<void>();
    let calls = 0;
    let transportSignal: AbortSignal | undefined;
    const search = createHttpWebSearch({ fetch: async (_url, init) => {
      calls++; transportSignal = init.signal!;
      await gate.promise; return hits(init);
    } });
    const controller = new AbortController();
    const first = search(params(), controller.signal);
    const second = search(params());
    controller.abort();
    expect(await first).toMatchObject({ kind: 'error', code: 'aborted' });
    expect(transportSignal?.aborted).toBe(false);
    gate.resolve();
    expect(await second).toMatchObject({ kind: 'ok' });
    expect(calls).toBe(1);
  });

  test('aborts orphaned work, does not fallback or cache it, and allows a fresh call', async () => {
    const gate = deferred<void>();
    const requests: RequestInit[] = [];
    const search = createHttpWebSearch({ fetch: async (_url, init) => {
      requests.push(init);
      if (requests.length === 1) await gate.promise;
      return hits(init);
    } });
    const controller = new AbortController();
    const first = search(params(), controller.signal);
    controller.abort();
    expect(await first).toMatchObject({ code: 'aborted' });
    expect(requests[0].signal?.aborted).toBe(true);
    expect(await search(params())).toMatchObject({ kind: 'ok' });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toHaveLength(2);
  });

  test('an already cancelled caller sends no request', async () => {
    let calls = 0;
    const search = createHttpWebSearch({ fetch: async (_url, init) => { calls++; return hits(init); } });
    const controller = new AbortController(); controller.abort();
    expect(await search(params(), controller.signal)).toMatchObject({ code: 'aborted' });
    expect(calls).toBe(0);
  });

  test('deadline includes a stalled response body and leaves time for fallback', async () => {
    let cancelled = false;
    const search = createHttpWebSearch({ timeoutMs: 100, attemptTimeoutMs: 15, fetch: async (url, init) => {
      if (url === SEARCH_MCP_ENDPOINTS.exa) return exa(init);
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    } });
    const outcome = await search(params());
    expect(outcome).toMatchObject({ kind: 'ok', providerName: 'exa', attempts: [{ code: 'timeout' }, { status: 'success' }] });
    expect(cancelled).toBe(true);
  });

  test('the total deadline bounds both stalled providers without retrying either', async () => {
    const calls: string[] = [];
    const cancelled: string[] = [];
    const search = createHttpWebSearch({ timeoutMs: 30, attemptTimeoutMs: 20, fetch: async (url) => {
      calls.push(url);
      return new Response(new ReadableStream({ cancel() { cancelled.push(url); } }));
    } });
    const started = Date.now();
    expect(await search(params())).toMatchObject({ kind: 'error', code: 'search_unavailable' });
    expect(Date.now() - started).toBeLessThan(200);
    expect(calls).toEqual([SEARCH_MCP_ENDPOINTS.parallel, SEARCH_MCP_ENDPOINTS.exa]);
    expect(cancelled).toEqual(calls);
    expect(await search(params({ query: 'rewritten query' }))).toMatchObject({ kind: 'error', attempts: [
      { status: 'skipped', code: 'timeout' }, { status: 'skipped', code: 'timeout' },
    ] });
    expect(calls).toHaveLength(2);
  });
});
