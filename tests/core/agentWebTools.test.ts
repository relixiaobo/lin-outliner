import { describe, expect, test } from 'bun:test';
import { agentToolResult } from '../../src/main/agent/capabilities/agentToolEnvelope';
import { expectToolOutputContract } from '../helpers/toolOutputContract';
import {
  buildWebFetchSuccessEnvelope,
  isWebFetchUrl,
  normalizeWebFetchParams,
  normalizeWebSearchParams,
  webFetchModelData,
  webFetchToolResult,
  webSearchModelData,
  type FetchTextResult,
  type WebFetchData,
  type WebSearchData,
  type WebParamResult,
} from '../../src/main/agent/capabilities/agentWebTools';
import {
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_FORMAT_PARAMETER_DESCRIPTION,
  WEB_FETCH_QUERY_PARAMETER_DESCRIPTION,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_QUERY_PARAMETER_DESCRIPTION,
  WEB_SEARCH_RECENCY_PARAMETER_DESCRIPTION,
} from '../../src/main/agent/capabilities/agentWebToolGuidance';

function expectParams<T>(result: WebParamResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.params;
}

function fetchedText(body: string, contentType = 'text/html; charset=utf-8'): FetchTextResult {
  return {
    requestedUrl: 'https://example.com/docs/page',
    finalUrl: 'https://example.com/docs/page',
    statusCode: 200,
    statusText: 'OK',
    contentType,
    byteLength: Buffer.byteLength(body, 'utf8'),
    body,
  };
}

describe('agent web tools', () => {
  test('paginates UTF-8 find snippets by serialized bytes without skipping matches', async () => {
    const body = Array.from({ length: 60 }, (_, index) => `${'文'.repeat(2100)}needle${index} ${'文'.repeat(2100)}`).join('\n');
    const seen: number[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page += 1) {
      const params = expectParams(normalizeWebFetchParams({
        url: 'https://example.com/docs/page', query: 'needle', context: 2000, head_limit: 50, match_offset: offset,
      }));
      const envelope = await buildWebFetchSuccessEnvelope(fetchedText(body, 'text/plain'), params, 0);
      const result = webFetchToolResult(envelope);
      expect(result.outcome.ok).toBe(true);
      expectToolOutputContract('web_fetch', result.data);
      const data = result.data as { matches: Array<{ snippet: string }>; nextMatchOffset?: number; totalMatches: number };
      expect(data.totalMatches).toBe(60);
      seen.push(...data.matches.map((match) => Number(match.snippet.match(/needle(\d+)/)?.[1])));
      if (data.nextMatchOffset === undefined) break;
      expect(result.outcome).toMatchObject({ ok: true, status: 'partial' });
      expect(data.nextMatchOffset).toBe(offset + data.matches.length);
      expect(data.nextMatchOffset).toBeGreaterThan(offset);
      offset = data.nextMatchOffset;
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, index) => index));
  });

  test('bounds metadata text while retaining complete usable URLs and private source metadata', async () => {
    const label = '文😀'.repeat(60_000);
    const oversizedUrl = `https://example.com/${'x'.repeat(70_000)}`;
    const body = `<html><title>${label}</title><body><a href="${oversizedUrl}">Too large</a><a href="/kept">${label}</a></body></html>`;
    const params = expectParams(normalizeWebFetchParams({ url: 'https://example.com/docs/page', format: 'metadata' }));
    const envelope = await buildWebFetchSuccessEnvelope(fetchedText(body), params, 0);
    const result = webFetchToolResult(envelope);
    expect(result.outcome).toMatchObject({ ok: true, status: 'partial' });
    expectToolOutputContract('web_fetch', result.data);
    const data = result.data as { title: string; metadata: { title: string; links: Array<{ text: string; url: string }> } };
    expect(data.title.length).toBeLessThan(label.length);
    expect(data.title.endsWith('\ud83d')).toBe(false);
    expect(data.metadata.links).toEqual([{ text: expect.any(String), url: 'https://example.com/kept' }]);
    expect(data.metadata.links[0]!.text.endsWith('\ud83d')).toBe(false);
    expect(result.details.data!.metadata!.links![1]!.text).toBe(label);
    expect(result.warnings).toContain('The visible page was truncated. Use its continuation offset, or read the page content for omitted metadata.');
  });

  test('web tool descriptions guide source discovery, verification, and fetch modes', () => {
    expect(WEB_SEARCH_DESCRIPTION).toContain('Use web_search when you do not already have a specific URL');
    expect(WEB_SEARCH_DESCRIPTION).toContain('Use web_fetch on result URLs when you need details');
    expect(WEB_SEARCH_DESCRIPTION).toContain('cite the relevant result or fetched source URLs');
    expect(WEB_SEARCH_QUERY_PARAMETER_DESCRIPTION).toContain('current year/date');
    expect(WEB_SEARCH_RECENCY_PARAMETER_DESCRIPTION).toContain('verify publication dates');

    expect(WEB_FETCH_DESCRIPTION).toContain('Use web_fetch when you already have a URL');
    expect(WEB_FETCH_DESCRIPTION).toContain('Use query to find matching snippets');
    expect(WEB_FETCH_DESCRIPTION).toContain('Use offset/max_chars and nextOffset');
    expect(WEB_FETCH_DESCRIPTION).toContain('If binaryFile is returned, use file_read');
    expect(WEB_FETCH_DESCRIPTION).not.toContain('HTTP GET');
    expect(WEB_FETCH_DESCRIPTION).not.toContain('browser fallback');
    expect(WEB_FETCH_FORMAT_PARAMETER_DESCRIPTION).toContain('metadata');
    expect(WEB_FETCH_QUERY_PARAMETER_DESCRIPTION).toContain('find mode');
  });

  test('normalizes and validates web_search and web_fetch args', () => {
    const invalidSearch = normalizeWebSearchParams({ query: '   ' });
    expect(invalidSearch.ok).toBe(false);
    if (invalidSearch.ok) throw new Error('Expected invalid search params');
    expect(invalidSearch.code).toBe('invalid_args');
    expect(invalidSearch.instructions).toContain('non-empty query');

    const invalidFetch = normalizeWebFetchParams({
      url: 'https://example.com/',
      format: 'pdf',
    });
    expect(invalidFetch.ok).toBe(false);
    if (invalidFetch.ok) throw new Error('Expected invalid fetch params');
    expect(invalidFetch.code).toBe('invalid_args');
    expect(invalidFetch.message).toContain('unsupported format');
  });

  test('web_search kind defaults to web and validates the enum', () => {
    const defaulted = normalizeWebSearchParams({ query: 'aurora' });
    if (!defaulted.ok) throw new Error('Expected valid search params');
    expect(defaulted.params.kind).toBe('web');

    const image = normalizeWebSearchParams({ query: 'aurora', kind: 'image' });
    if (!image.ok) throw new Error('Expected valid image search params');
    expect(image.params.kind).toBe('image');

    const invalidKind = normalizeWebSearchParams({ query: 'aurora', kind: 'video' });
    expect(invalidKind.ok).toBe(false);
    if (invalidKind.ok) throw new Error('Expected invalid kind');
    expect(invalidKind.message).toContain('unsupported kind');
  });

  test('preserves literal http URLs during normalization', () => {
    const params = expectParams(normalizeWebFetchParams({
      url: ' http://example.com/path?q=lin#section ',
    }));

    expect(params.url).toBe('http://example.com/path?q=lin#section');
    expect(params.format).toBe('markdown');
    expect(params.mode).toBe('read');
  });

  test('rejects embedded URL credentials while accepting local and private hosts', () => {
    const credentialUrl = normalizeWebFetchParams({ url: 'https://user:pass@example.com/docs' });
    expect(credentialUrl.ok).toBe(false);
    if (credentialUrl.ok) throw new Error('Expected credential URL rejection');
    expect(credentialUrl.message).toContain('username or password');

    const localhostUrl = normalizeWebFetchParams({ url: 'https://localhost/docs' });
    expect(localhostUrl.ok).toBe(true);

    const privateUrl = normalizeWebFetchParams({ url: 'https://192.168.1.10/docs' });
    expect(privateUrl.ok).toBe(true);
    expect(normalizeWebFetchParams({ url: 'http://devbox:5173/docs' }).ok).toBe(true);
  });

  test('isWebFetchUrl accepts every uncredentialed http(s) host', () => {
    for (const url of [
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fc00::1]/',
      'http://[::1]/',
      'http://localhost./admin',
      'http://router.local./',
      'http://devbox:5173/',
      'http://example.com/x',
      'https://[2606:4700:4700::1111]/',
    ]) {
      expect(isWebFetchUrl(url), url).toBe(true);
    }
    expect(isWebFetchUrl('ftp://localhost/file')).toBe(false);
    expect(isWebFetchUrl('http://user:pass@localhost/')).toBe(false);
  });

  test('builds read-mode paginated fetch envelopes', async () => {
    const body = 'alpha beta gamma delta epsilon';
    const params = expectParams(normalizeWebFetchParams({
      url: 'https://example.com/docs/page',
      format: 'text',
      max_chars: 11,
    }));

    const envelope = await buildWebFetchSuccessEnvelope(fetchedText(body, 'text/plain'), params, 5);

    expect(envelope.ok).toBe(true);
    expect(envelope.tool).toBe('web_fetch');
    expect(envelope.data).toMatchObject({
      mode: 'read',
      format: 'text',
      content: 'alpha beta ',
      totalChars: body.length,
      returnedChars: 11,
      nextOffset: 11,
      truncated: true,
    });
    expect(envelope.instructions).toContain('offset 11');
    expect(envelope.metrics?.truncated).toBe(true);
  });

  test('builds find-mode match pagination envelopes', async () => {
    const params = expectParams(normalizeWebFetchParams({
      url: 'https://example.com/docs/page',
      format: 'text',
      query: 'beta',
      context: 2,
      head_limit: 2,
    }));

    const envelope = await buildWebFetchSuccessEnvelope(
      fetchedText('alpha beta gamma beta delta beta', 'text/plain'),
      params,
      8,
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({
      mode: 'find',
      format: 'text',
      totalMatches: 3,
      returnedMatches: 2,
      nextMatchOffset: 2,
      truncated: true,
    });
    expect(envelope.data!.matches).toHaveLength(2);
    expect(envelope.data!.matches![0]!.snippet).toContain('beta');
    expect(envelope.metrics?.truncated).toBe(true);
  });

  test('builds metadata-mode envelopes and remains kernel-result compatible', async () => {
    const html = [
      '<!doctype html><html lang="en"><head>',
      '<title>Lin Docs</title>',
      '<meta name="description" content="Outliner documentation">',
      '<meta property="og:site_name" content="Lin">',
      '<link rel="canonical" href="/docs/canonical">',
      '</head><body>',
      '<h1>Overview</h1><h2>Install</h2>',
      '<a href="/docs/next">Next</a>',
      '</body></html>',
    ].join('');
    const params = expectParams(normalizeWebFetchParams({
      url: 'https://example.com/docs/page',
      format: 'metadata',
    }));

    const envelope = await buildWebFetchSuccessEnvelope(fetchedText(html), params, 12);
    const result = agentToolResult(envelope, webFetchModelData(envelope.data!));

    expect(result.details).toBe(envelope);
    // The model-visible projection drops `tool` and omits `status` on success;
    // the runtime envelope on details keeps the full shape.
    expect(result.data).not.toHaveProperty('tool');
    expect(result.outcome).toEqual({ ok: true });
    expect(result.details!.tool).toBe('web_fetch');
    // The full WebFetchData stays on details; the model only sees title + metadata.
    expect(result.data).toMatchObject({
        title: 'Lin Docs',
        metadata: {
          title: 'Lin Docs',
          description: 'Outliner documentation',
          canonicalUrl: 'https://example.com/docs/canonical',
          siteName: 'Lin',
          language: 'en',
          headings: ['Overview', 'Install'],
          links: [{ text: 'Next', url: 'https://example.com/docs/next' }],
        },
    });
    // Echoed arguments and telemetry are dropped from the model view.
    expect(result.data).not.toHaveProperty('mode');
    expect(result.data).not.toHaveProperty('format');
    expect(result.data).not.toHaveProperty('url');
    expect(result.data).not.toHaveProperty('durationMs');
    expect(envelope.data!.content).toBeUndefined();
  });

  test('uses Defuddle to extract readable page content before paginating', async () => {
    const html = [
      '<!doctype html><html lang="en"><head>',
      '<title>Clean Article - Example</title>',
      '<meta name="description" content="Readable content">',
      '</head><body>',
      '<nav>Home Pricing Login Account Settings</nav>',
      '<main><article>',
      '<h1>Clean Article</h1>',
      '<p>Alpha article paragraph with beta detail that belongs in the readable result.</p>',
      '<p>Second paragraph with enough context for extraction.</p>',
      '</article></main>',
      '<aside>Related links and promotional navigation should not be part of the article body.</aside>',
      '</body></html>',
    ].join('');
    const params = expectParams(normalizeWebFetchParams({
      url: 'https://example.com/docs/page',
      format: 'markdown',
    }));

    const envelope = await buildWebFetchSuccessEnvelope(fetchedText(html), params, 15);

    expect(envelope.ok).toBe(true);
    expect(envelope.data!.content).toContain('Alpha article paragraph');
    expect(envelope.data!.content).not.toContain('Home Pricing Login');
    expect(envelope.data!.content).not.toContain('promotional navigation');
  });

  test('returns persisted binary metadata without decoding bytes into content', async () => {
    const params = expectParams(normalizeWebFetchParams({
      url: 'https://example.com/docs/file.pdf',
      format: 'markdown',
    }));
    const fetched: FetchTextResult = {
      ...fetchedText('', 'application/pdf'),
      finalUrl: 'https://example.com/docs/file.pdf',
      byteLength: 1234,
      binaryFile: {
        filePath: '/tmp/thread-observations/webfetch-test.pdf',
        resourceRef: {
          id: 'a'.repeat(64),
          mimeType: 'application/pdf',
          byteLength: 1234,
          fileName: 'webfetch-test.pdf',
        },
        mimeType: 'application/pdf',
        byteLength: 1234,
      },
    };

    const envelope = await buildWebFetchSuccessEnvelope(fetched, params, 9);

    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({
      mode: 'read',
      format: 'markdown',
      content: 'Binary content stored as webfetch-test.pdf. The current readable path is /tmp/thread-observations/webfetch-test.pdf. Use file_read on this path when you need to inspect supported files such as PDFs or images.',
      binaryFile: {
        filePath: '/tmp/thread-observations/webfetch-test.pdf',
        resourceRef: {
          id: 'a'.repeat(64),
          mimeType: 'application/pdf',
          byteLength: 1234,
          fileName: 'webfetch-test.pdf',
        },
        mimeType: 'application/pdf',
        byteLength: 1234,
      },
      truncated: false,
    });
    expect(envelope.instructions).toContain('file_read');
    expect(envelope.data!.content).not.toContain('a'.repeat(64));
  });
});

describe('web tool model-visible projections', () => {
  test('web_search keeps results and pagination, drops echoed args and telemetry', () => {
    const data: WebSearchData = {
      query: 'chengdu weather',
      effectiveQuery: 'chengdu weather',
      kind: 'web',
      provider: 'provider',
      providerName: 'google_serp',
      finalUrl: 'https://www.google.com/search?q=chengdu+weather',
      resultCount: 1,
      totalResults: 14,
      truncated: true,
      durationMs: 49023,
      results: [
        { title: 'Weather', url: 'https://example.com/w', snippet: 'sunny', source: 'example.com' },
      ],
    };

    expect(webSearchModelData(data)).toEqual({
      results: [{ title: 'Weather', url: 'https://example.com/w', snippet: 'sunny' }],
      truncated: true,
      totalResults: 14,
    });
  });

  test('web_search image kind surfaces imageUrl/thumbnailUrl and echoes kind', () => {
    const data: WebSearchData = {
      query: 'aurora',
      effectiveQuery: 'aurora',
      kind: 'image',
      provider: 'provider',
      providerName: 'bing_images',
      resultCount: 1,
      truncated: false,
      results: [
        {
          title: 'Aurora',
          url: 'https://example.com/aurora-article',
          snippet: '',
          imageUrl: 'https://cdn.example.com/aurora.jpg',
          thumbnailUrl: 'https://tse.example.com/th?id=aurora',
          source: 'example.com',
        },
      ],
    };

    expect(webSearchModelData(data)).toEqual({
      kind: 'image',
      results: [
        {
          title: 'Aurora',
          url: 'https://example.com/aurora-article',
          imageUrl: 'https://cdn.example.com/aurora.jpg',
          thumbnailUrl: 'https://tse.example.com/th?id=aurora',
        },
      ],
    });
  });

  test('web_search omits truncated/totalResults when not truncated and keeps hints', () => {
    const data: WebSearchData = {
      query: 'q',
      effectiveQuery: 'q',
      kind: 'web',
      provider: 'provider',
      providerName: 'google_serp',
      resultCount: 0,
      truncated: false,
      results: [],
      hint: { type: 'search_blocked', reason: 'captcha', origin: 'https://www.google.com' },
    };

    expect(webSearchModelData(data)).toEqual({
      results: [],
      hint: { type: 'search_blocked', reason: 'captcha', origin: 'https://www.google.com' },
    });
  });

  test('web_fetch read mode keeps content and pagination only when truncated', () => {
    const base: WebFetchData = {
      url: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
      statusCode: 200,
      contentType: 'text/html',
      byteLength: 999,
      durationMs: 42,
      mode: 'read',
      format: 'markdown',
      title: 'Page',
      content: 'hello',
      totalChars: 12,
      returnedChars: 5,
      nextOffset: 5,
      truncated: true,
    };

    expect(webFetchModelData(base)).toEqual({
      title: 'Page',
      truncated: true,
      totalChars: 12,
      nextOffset: 5,
    });
    expect(webFetchModelData({ ...base, truncated: false, nextOffset: undefined })).toEqual({
      title: 'Page',
    });
  });

  test('web_fetch surfaces finalUrl on redirect and statusCode on non-200', () => {
    const data: WebFetchData = {
      url: 'https://example.com/a',
      finalUrl: 'https://other.com/b',
      statusCode: 404,
      mode: 'read',
      format: 'markdown',
      content: 'x',
      truncated: false,
    };

    expect(webFetchModelData(data)).toEqual({
      finalUrl: 'https://other.com/b',
      statusCode: 404,
    });
  });

  test('web_fetch find mode drops byte offsets and keeps snippets', () => {
    const data: WebFetchData = {
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      statusCode: 200,
      mode: 'find',
      format: 'markdown',
      matches: [
        { index: 0, start: 10, end: 14, snippetStart: 0, snippetEnd: 30, snippet: '...beta...' },
      ],
      totalMatches: 3,
      returnedMatches: 1,
      nextMatchOffset: 1,
      truncated: true,
    };

    expect(webFetchModelData(data)).toEqual({
      matches: [{ snippet: '...beta...' }],
      totalMatches: 3,
      nextMatchOffset: 1,
    });
  });

  test('web_fetch binary exposes display metadata and the current readable handle without Host identity', () => {
    const resourceRef = {
      id: 'b'.repeat(64),
      mimeType: 'application/pdf',
      byteLength: 1234,
      fileName: 'x.pdf',
    };
    const data: WebFetchData = {
      url: 'https://example.com/file.pdf',
      finalUrl: 'https://example.com/file.pdf',
      statusCode: 200,
      mode: 'read',
      format: 'markdown',
      content: 'Binary content saved to /tmp/x.pdf. Use file_read on this path.',
      binaryFile: {
        filePath: '/tmp/x.pdf',
        resourceRef,
        mimeType: 'application/pdf',
        byteLength: 1234,
      },
      truncated: false,
    };

    expect(webFetchModelData(data)).toEqual({
      binaryFile: {
        filePath: '/tmp/x.pdf',
        fileName: 'x.pdf',
        mimeType: 'application/pdf',
        byteLength: 1234,
      },
    });
    expect(JSON.stringify(webFetchModelData(data))).not.toContain(resourceRef.id);
  });
});
