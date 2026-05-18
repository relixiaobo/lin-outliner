import { describe, expect, test } from 'bun:test';
import { agentToolResult } from '../../src/main/agentToolEnvelope';
import {
  buildWebFetchSuccessEnvelope,
  normalizeWebFetchParams,
  normalizeWebSearchParams,
  type FetchTextResult,
  type WebParamResult,
} from '../../src/main/agentWebTools';

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

  test('upgrades http web_fetch URLs to https during normalization', () => {
    const params = expectParams(normalizeWebFetchParams({
      url: ' http://example.com/path?q=lin#section ',
    }));

    expect(params.url).toBe('https://example.com/path?q=lin#section');
    expect(params.format).toBe('markdown');
    expect(params.mode).toBe('read');
  });

  test('builds read-mode paginated fetch envelopes', () => {
    const body = 'alpha beta gamma delta epsilon';
    const params = expectParams(normalizeWebFetchParams({
      url: 'https://example.com/docs/page',
      format: 'text',
      max_chars: 11,
    }));

    const envelope = buildWebFetchSuccessEnvelope(fetchedText(body, 'text/plain'), params, 5);

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

  test('builds find-mode match pagination envelopes', () => {
    const params = expectParams(normalizeWebFetchParams({
      url: 'https://example.com/docs/page',
      format: 'text',
      query: 'beta',
      context: 2,
      head_limit: 2,
    }));

    const envelope = buildWebFetchSuccessEnvelope(
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

  test('builds metadata-mode envelopes and remains pi-agent-core result compatible', () => {
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

    const envelope = buildWebFetchSuccessEnvelope(fetchedText(html), params, 12);
    const result = agentToolResult(envelope);
    const visible = JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}');

    expect(result.details).toBe(envelope);
    expect(visible).toMatchObject({
      ok: true,
      tool: 'web_fetch',
      status: 'success',
      data: {
        mode: 'metadata',
        format: 'metadata',
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
        truncated: false,
      },
    });
    expect(visible.version).toBeUndefined();
    expect(envelope.data!.content).toBeUndefined();
  });
});
