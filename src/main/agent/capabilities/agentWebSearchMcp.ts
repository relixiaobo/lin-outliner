import { randomUUID } from 'node:crypto';
import { MAX_SEARCH_LIMIT } from './agentWebConstants';
import type { NormalizedWebSearchParams, WebSearchResult } from './agentWebTools';

export const SEARCH_MCP_ENDPOINTS = {
  parallel: 'https://search.parallel.ai/mcp',
  exa: 'https://mcp.exa.ai/mcp',
} as const;

export type SearchMcpProvider = keyof typeof SEARCH_MCP_ENDPOINTS;
export type SearchHttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export class SearchMcpError extends Error {
  constructor(readonly code: string, readonly retryAfterMs?: number) {
    super(code);
  }
}

const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_RESULTS_BYTES = 64 * 1024;

export async function searchMcpProvider(
  fetch: SearchHttpFetch,
  provider: SearchMcpProvider,
  params: NormalizedWebSearchParams,
  signal: AbortSignal,
  now: number,
  apiKey?: string,
): Promise<{ results: WebSearchResult[]; truncated: boolean; responseBytes: number }> {
  signal.throwIfAborted();
  const id = randomUUID();
  const query = params.effectiveQuery + (params.recencyDays
    ? ` after:${new Date(now - params.recencyDays * 86_400_000).toISOString().slice(0, 10)}`
    : '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'User-Agent': 'Tenon-WebSearch/1.0',
  };
  if (apiKey) {
    if (provider === 'parallel') headers.Authorization = `Bearer ${apiKey}`;
    else headers['x-api-key'] = apiKey;
  }

  // These hosted endpoints accept direct tools/call, as used by OpenCode.
  // Keep provider-specific arguments here rather than exposing MCP to the Agent.
  const response = await fetch(SEARCH_MCP_ENDPOINTS[provider], {
    method: 'POST',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    headers,
    signal,
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: provider === 'parallel'
        ? { name: 'web_search', arguments: {
            objective: query,
            // Parallel bounds keyword queries to 200 chars; the objective keeps
            // the complete query, including site and freshness hints.
            search_queries: [Array.from(query).slice(0, 200).join('')],
            session_id: id,
          } }
        : { name: 'web_search_exa', arguments: {
            query, numResults: params.limit, type: 'fast',
            livecrawl: 'fallback', contextMaxCharacters: 10_000,
          } },
    }),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const code = response.status === 429 ? 'rate_limited'
      : response.status === 401 || response.status === 403 ? 'access_denied' : 'http_error';
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter === null ? undefined : /^\d+$/.test(retryAfter)
      ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    throw new SearchMcpError(code, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
  }
  const body = await readResponse(response, signal);
  const result = decodeMcpResult(body, id);
  const records = searchRecords(result, provider);
  return { ...normalizeResults(records, params.site), responseBytes: Buffer.byteLength(body) };
}

async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new SearchMcpError('invalid_response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new SearchMcpError('response_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function decodeMcpResult(body: string, id: string): Record<string, unknown> {
  const trimmed = body.trim();
  const messages = trimmed.startsWith('{') || trimmed.startsWith('[')
    ? [parseJson(trimmed)].flat()
    : body.split(/\r?\n\r?\n/).map((event) => parseJson(event.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n'))).flat();
  const envelope = messages.map(record).find((message) => message?.id === id
    && ('result' in message || 'error' in message));
  if (!envelope) throw new SearchMcpError('invalid_response');
  const result = record(envelope.result);
  if ('error' in envelope || result?.isError === true) {
    // Classify provider text, but never echo untrusted instructions or secrets
    // from an upstream error into Tenon's error message.
    const errorText = JSON.stringify(envelope.error ?? result);
    throw new SearchMcpError(/rate.?limit|too many requests|quota exceeded/i.test(errorText)
      ? 'rate_limited' : 'provider_error');
  }
  if (!result) throw new SearchMcpError('invalid_response');
  return result;
}

function searchRecords(result: Record<string, unknown>, provider: SearchMcpProvider): unknown[] {
  const structured = record(result.structuredContent);
  if (structured) {
    if (!Array.isArray(structured.results)) throw new SearchMcpError('invalid_response');
    return structured.results;
  }
  const texts = Array.isArray(result.content) ? result.content.flatMap((item) => {
    const block = record(item);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }) : [];
  for (const text of texts) {
    const payload = record(parseJson(text));
    if (payload && Array.isArray(payload.results)) return payload.results;
  }
  if (provider !== 'exa' || texts.length === 0) throw new SearchMcpError('invalid_response');

  const text = texts.join('\n').replace(/\r\n/g, '\n').trim();
  if (text === 'No search results found. Please try a different query.'
    || /^No (?:search )?results found[.!]?$/i.test(text)) return [];
  // Exa emits bounded source records separated by a Title/URL header. Anchor
  // both lines together so ordinary headings in an excerpt do not split it.
  const headers = [...text.matchAll(/^Title: ([^\n]+)\nURL: (https?:\/\/[^\n]+)\n/gm)];
  if (headers.length === 0) throw new SearchMcpError('invalid_response');
  return headers.map((header, index) => {
    const details = text.slice(header.index! + header[0].length, headers[index + 1]?.index ?? text.length);
    const published = /^(?:Published|Published Date): (.+)$/m.exec(details)?.[1];
    const content = /^(?:Highlights|Text|Content):[ \t]*(?:\n)?/m.exec(details);
    return {
      title: header[1], url: header[2], publish_date: published,
      excerpts: [content ? details.slice(content.index + content[0].length).replace(/\n---\s*$/, '') : ''],
    };
  });
}

function normalizeResults(items: unknown[], site?: string): { results: WebSearchResult[]; truncated: boolean } {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  let valid = 0;
  let truncated = false;
  for (const item of items) {
    const value = record(item);
    if (!value || typeof value.url !== 'string' || typeof value.title !== 'string') continue;
    let url: URL;
    try { url = new URL(value.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    url.hash = '';
    if (Buffer.byteLength(url.href) > 4096 || !value.title.trim()) continue;
    valid++;
    if (site && url.host !== site && !url.host.endsWith(`.${site}`)) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const excerpts = Array.isArray(value.excerpts) ? value.excerpts.filter((text): text is string => typeof text === 'string')
      : typeof value.text === 'string' ? [value.text] : [];
    const title = compactText(value.title, 300);
    const fullSnippet = excerpts.join('\n\n');
    const snippet = compactText(fullSnippet, 1500);
    const published = typeof value.publish_date === 'string' ? value.publish_date : value.publishedDate;
    const publishedAt = typeof published === 'string' && published.length <= 64 && Number.isFinite(Date.parse(published))
      ? published : undefined;
    const entry: WebSearchResult = { title, url: url.href, snippet, source: url.host,
      ...(publishedAt ? { publishedAt } : {}) };
    const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (results.length >= MAX_SEARCH_LIMIT || bytes + entryBytes > MAX_RESULTS_BYTES) {
      truncated = true;
      break;
    }
    truncated ||= title !== value.title.trim().replace(/\s+/g, ' ')
      || snippet !== fullSnippet.trim().replace(/\s+/g, ' ');
    bytes += entryBytes;
    results.push(entry);
  }
  if (items.length > 0 && valid === 0) throw new SearchMcpError('invalid_response');
  return { results, truncated };
}

function compactText(text: string, limit: number): string {
  return Array.from(text.trim().replace(/\s+/g, ' ')).slice(0, limit).join('');
}
