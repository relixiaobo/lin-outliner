import { describe, expect, test } from 'bun:test';

import { buildWebFetchHeaders } from '../../src/main/agent/capabilities/agentWebFetchRequest';

describe('agent web fetch request headers', () => {
  test('keeps browser identity while leaving all Fetch Metadata to Chromium', () => {
    const headers = buildWebFetchHeaders();

    expect(headers['user-agent']).toContain('Chrome/');
    expect(headers['sec-ch-ua']).toContain('Chromium');
    expect(Object.keys(headers).filter((name) => name.startsWith('sec-fetch-'))).toEqual([]);
    expect(headers).not.toHaveProperty('referer');
  });
});
