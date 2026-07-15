import { describe, expect, test } from 'bun:test';
import type { HandlerDetails } from 'electron';
import { URL_PREVIEW_WEBVIEW_PARTITION } from '../../src/core/urlPreviewSession';
import {
  clearUrlPreviewSessionData,
  configureUrlPreviewSession,
  createUrlPreviewWindowOpenHandler,
  flushUrlPreviewSession,
} from '../../src/main/urlPreviewSession';

type PreviewSession = Parameters<typeof configureUrlPreviewSession>[0];

function handlerDetails(overrides: Partial<HandlerDetails> = {}): HandlerDetails {
  return {
    url: 'https://example.com/account',
    frameName: '_blank',
    features: '',
    disposition: 'foreground-tab',
    referrer: {
      url: 'https://example.com/start',
      policy: 'strict-origin-when-cross-origin',
    },
    ...overrides,
  };
}

describe('URL Preview persistent session', () => {
  test('uses one persistent partition', () => {
    expect(URL_PREVIEW_WEBVIEW_PARTITION).toBe('persist:url-preview');
  });

  test('configures the permission allowlist once per session', () => {
    let requestHandler: ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | null = null;
    let checkHandler: ((contents: unknown, permission: string) => boolean) | null = null;
    let requestConfigCount = 0;
    let checkConfigCount = 0;
    const previewSession = {
      setPermissionRequestHandler: (handler: typeof requestHandler) => {
        requestConfigCount += 1;
        requestHandler = handler;
      },
      setPermissionCheckHandler: (handler: typeof checkHandler) => {
        checkConfigCount += 1;
        checkHandler = handler;
      },
    } as unknown as PreviewSession;

    configureUrlPreviewSession(previewSession);
    configureUrlPreviewSession(previewSession);

    expect(requestConfigCount).toBe(1);
    expect(checkConfigCount).toBe(1);
    const requested: boolean[] = [];
    requestHandler?.(null, 'fullscreen', (allowed) => requested.push(allowed));
    requestHandler?.(null, 'clipboard-sanitized-write', (allowed) => requested.push(allowed));
    requestHandler?.(null, 'media', (allowed) => requested.push(allowed));
    expect(requested).toEqual([true, true, false]);
    expect(checkHandler?.(null, 'fullscreen')).toBe(true);
    expect(checkHandler?.(null, 'geolocation')).toBe(false);
  });

  test('routes an HTTP GET new-window request back into the same guest', async () => {
    const loads: Array<{ url: string; referrer?: string }> = [];
    const guest = {
      isDestroyed: () => false,
      loadURL: async (url: string, options?: { httpReferrer?: string | { url: string } }) => {
        const referrer = typeof options?.httpReferrer === 'string'
          ? options.httpReferrer
          : options?.httpReferrer?.url;
        loads.push({ url, referrer });
      },
    };

    const response = createUrlPreviewWindowOpenHandler(guest)(handlerDetails());
    expect(response).toEqual({ action: 'deny' });
    await Promise.resolve();

    expect(loads).toEqual([{
      url: 'https://example.com/account',
      referrer: 'https://example.com/start',
    }]);
  });

  test('blocks unsupported, POST, and destroyed-guest new-window requests', async () => {
    const loads: string[] = [];
    let destroyed = false;
    const guest = {
      isDestroyed: () => destroyed,
      loadURL: async (url: string) => { loads.push(url); },
    };
    const handler = createUrlPreviewWindowOpenHandler(guest);

    handler(handlerDetails({ url: 'file:///tmp/private' }));
    handler(handlerDetails({
      postBody: { contentType: 'application/x-www-form-urlencoded', data: [] },
    }));
    destroyed = true;
    handler(handlerDetails({ url: 'https://example.com/destroyed' }));
    await Promise.resolve();

    expect(loads).toEqual([]);
  });

  test('clears website state, flushes the cookie store, and closes live connections', async () => {
    const calls: string[] = [];
    const previewSession = {
      clearAuthCache: async () => { calls.push('auth'); },
      clearCache: async () => { calls.push('cache'); },
      clearStorageData: async () => { calls.push('storage'); },
      closeAllConnections: async () => { calls.push('connections'); },
      cookies: { flushStore: async () => { calls.push('cookies'); } },
    } as unknown as PreviewSession;

    await clearUrlPreviewSessionData(previewSession);

    expect(calls[0]).toBe('connections');
    expect(new Set(calls.slice(1, 4))).toEqual(new Set(['auth', 'cache', 'storage']));
    expect(calls[4]).toBe('cookies');
  });

  test('flushes DOM storage and cookies before quit', async () => {
    const calls: string[] = [];
    const previewSession = {
      flushStorageData: () => { calls.push('storage'); },
      cookies: { flushStore: async () => { calls.push('cookies'); } },
    } as unknown as PreviewSession;

    await flushUrlPreviewSession(previewSession);
    await flushUrlPreviewSession(null);

    expect(calls).toEqual(['storage', 'cookies']);
  });
});
