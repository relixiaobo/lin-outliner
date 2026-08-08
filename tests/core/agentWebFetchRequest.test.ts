import { describe, expect, test } from 'bun:test';

import { buildWebFetchHeaders } from '../../src/main/agent/capabilities/agentWebFetchRequest';

describe('agent web fetch request headers', () => {
  test('keeps first-hop browser identity without setting navigation-only mode', () => {
    const headers = buildWebFetchHeaders('https://example.com/article');

    expect(headers['user-agent']).toContain('Chrome/');
    expect(headers['sec-ch-ua']).toContain('Chromium');
    expect(headers['sec-fetch-dest']).toBe('document');
    expect(headers['sec-fetch-site']).toBe('none');
    expect(headers['sec-fetch-user']).toBe('?1');
    expect(headers).not.toHaveProperty('sec-fetch-mode');
    expect(headers).not.toHaveProperty('referer');
  });

  test('carries redirect referrer and chain site without a user gesture', () => {
    const headers = buildWebFetchHeaders('https://other.example/landing', {
      referrerUrl: 'https://source.example/article?ref=feed#section',
      secFetchSite: 'cross-site',
    });

    expect(headers.referer).toBe('https://source.example/');
    expect(headers['sec-fetch-site']).toBe('cross-site');
    expect(headers).not.toHaveProperty('sec-fetch-user');
    expect(headers).not.toHaveProperty('sec-fetch-mode');
  });
});
