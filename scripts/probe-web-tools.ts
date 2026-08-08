import { app } from 'electron';
import { createServer, type Server } from 'node:http';

import { createAgentTools } from '../src/main/agent/capabilities/agentTools';
import { isToolEnvelope, type ToolEnvelope } from '../src/main/agent/capabilities/agentToolEnvelope';

interface ProbeResult {
  name: string;
  verdict: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
  durationMs: number;
}

interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  details: unknown;
}

interface WebFetchProbeData {
  finalUrl?: string;
  statusCode?: number;
  title?: string;
  content?: string;
  metadata?: {
    title?: string;
    description?: string;
  };
  totalMatches?: number;
  returnedMatches?: number;
  truncated?: boolean;
}

interface WebSearchProbeData {
  finalUrl?: string;
  resultCount?: number;
  hint?: {
    type: string;
    reason?: string;
  };
  results?: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}

interface LocalWebFixture {
  url: string;
  close: () => Promise<void>;
}

const results: ProbeResult[] = [];
const tools = createAgentTools();
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const SEARCH_TOOL_TIMEOUT_MS = 85_000;

async function main(): Promise<number> {
  await app.whenReady();

  const fixture = await startLocalWebFixture();
  try {
    await runWebFetchProbes(
      'local fixture',
      fixture.url,
      'Tenon Web Fetch Probe',
      'deterministic local page',
    );
  } finally {
    await fixture.close();
  }
  await runWebFetchProbes(
    'example.com',
    'https://example.com/',
    'Example Domain',
    'documentation examples',
  );

  await runProbe('web_search Google SERP', async () => {
    const envelope = await executeTool<WebSearchProbeData>(
      'web_search',
      {
        query: 'electron BrowserWindow documentation',
        limit: 3,
      },
      SEARCH_TOOL_TIMEOUT_MS,
    );
    if (!envelope.ok && envelope.error?.code === 'extraction_failed') {
      return {
        verdict: 'SKIP' as const,
        detail: `search provider did not expose a normal SERP: ${envelope.error.message}`,
      };
    }
    assertOk(envelope);
    if (envelope.data?.hint) {
      return {
        verdict: 'SKIP' as const,
        detail: `search provider returned hint=${JSON.stringify(envelope.data.hint)}`,
      };
    }
    if (!envelope.data?.resultCount) {
      throw new Error('expected at least one search result');
    }
    const first = envelope.data.results?.[0];
    return `count=${envelope.data.resultCount} first="${preview(first?.title ?? '')}"`;
  });

  printSummary();
  return results.some((result) => result.verdict === 'FAIL') ? 1 : 0;
}

async function runWebFetchProbes(
  label: string,
  url: string,
  expectedTitle: string,
  contentNeedle: string,
): Promise<void> {
  await runProbe(`web_fetch read ${label}`, async () => {
    const envelope = await executeTool<WebFetchProbeData>('web_fetch', {
      url,
      max_chars: 5_000,
    });
    assertOk(envelope);
    if (!envelope.data?.content?.includes(contentNeedle)) {
      throw new Error(`expected fetched content to include ${contentNeedle}; got ${preview(envelope.data?.content ?? '')}`);
    }
    return `status=${envelope.data.statusCode} chars=${envelope.data.content.length}`;
  });

  await runProbe(`web_fetch metadata ${label}`, async () => {
    const envelope = await executeTool<WebFetchProbeData>('web_fetch', {
      url,
      format: 'metadata',
    });
    assertOk(envelope);
    const title = envelope.data?.title ?? envelope.data?.metadata?.title ?? '';
    if (!title.includes(expectedTitle)) {
      throw new Error(`expected metadata title to include ${expectedTitle}; got ${title || '<empty>'}`);
    }
    return `title="${title}" finalUrl=${envelope.data?.finalUrl ?? ''}`;
  });

  await runProbe(`web_fetch find ${label}`, async () => {
    const envelope = await executeTool<WebFetchProbeData>('web_fetch', {
      url,
      query: contentNeedle,
      context: 80,
      head_limit: 3,
    });
    assertOk(envelope);
    if (!envelope.data?.totalMatches) {
      throw new Error('expected at least one query match');
    }
    return `matches=${envelope.data.totalMatches} returned=${envelope.data.returnedMatches ?? 0}`;
  });
}

async function startLocalWebFixture(): Promise<LocalWebFixture> {
  const html = [
    '<!doctype html><html lang="en"><head><title>Tenon Web Fetch Probe</title></head>',
    '<body><main><article><h1>Tenon Web Fetch Probe</h1>',
    '<p>This deterministic local page exercises the real Electron Session.fetch request path.</p>',
    '<p>Readable content, metadata, and find mode must all survive request construction.</p>',
    '</article></main></body></html>',
  ].join('');
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
    });
    response.end(html);
  });

  await listenOnLoopback(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('local web fixture did not expose a TCP address');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server),
  };
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function runProbe(
  name: string,
  fn: () => Promise<string | { verdict: 'PASS' | 'SKIP'; detail: string }>,
): Promise<void> {
  const started = Date.now();
  try {
    const outcome = await fn();
    const durationMs = Date.now() - started;
    if (typeof outcome === 'string') {
      recordResult({ name, verdict: 'PASS', detail: outcome, durationMs });
    } else {
      recordResult({ name, verdict: outcome.verdict, detail: outcome.detail, durationMs });
    }
  } catch (error) {
    recordResult({
      name,
      verdict: 'FAIL',
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    });
  }
}

async function executeTool<TData>(
  toolName: string,
  params: Record<string, unknown>,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
): Promise<ToolEnvelope<TData>> {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`tool not found: ${toolName}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(`probe timeout after ${timeoutMs}ms`);
  }, timeoutMs);

  try {
    const result = await Promise.race([
      tool.execute(`probe-${toolName}`, params as never, controller.signal),
      rejectAfter(timeoutMs + 1_000, `${toolName} did not settle after abort`),
    ]) as ToolResultLike;

    if (!isToolEnvelope(result.details)) {
      const text = result.content?.find((item) => item.type === 'text')?.text ?? '';
      throw new Error(`tool returned non-envelope details: ${preview(text, 240)}`);
    }
    return result.details as ToolEnvelope<TData>;
  } finally {
    clearTimeout(timeout);
  }
}

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function recordResult(result: ProbeResult): void {
  results.push(result);
  console.log(formatResult(result));
}

function formatResult(result: ProbeResult): string {
  return `${result.verdict.padEnd(4)} ${result.name} (${result.durationMs}ms) ${result.detail}`;
}

function assertOk<TData>(envelope: ToolEnvelope<TData>): asserts envelope is ToolEnvelope<TData> & { ok: true; data: TData } {
  if (!envelope.ok) {
    throw new Error(`${envelope.error?.code ?? 'error'}: ${envelope.error?.message ?? 'tool failed'}`);
  }
}

function printSummary(): void {
  const passed = results.filter((result) => result.verdict === 'PASS').length;
  const skipped = results.filter((result) => result.verdict === 'SKIP').length;
  const failed = results.filter((result) => result.verdict === 'FAIL').length;
  console.log(`\nweb tools probe: ${passed} passed, ${skipped} skipped, ${failed} failed`);
}

function preview(value: string, limit = 120): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return 1;
  })
  .then((exitCode) => {
    app.exit(exitCode);
  });
