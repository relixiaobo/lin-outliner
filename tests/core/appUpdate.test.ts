import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AppUpdatePayloadError,
  decodeGitHubReleases,
  isAppUpdateAvailable,
  selectLatestStableRelease,
} from '../../src/core/appUpdate';
import { AppUpdateService, APP_UPDATE_THROTTLE_MS } from '../../src/main/appUpdateService';
import { AppUpdateStore, defaultState, type StoredAppUpdateState } from '../../src/main/appUpdateStore';

const NOW = 1_800_000_000_000;

function release(version: string, options: { draft?: boolean; prerelease?: boolean; asset?: boolean } = {}) {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: '2026-08-10T00:00:00Z',
    html_url: `https://github.com/relixiaobo/lin-outliner/releases/tag/${tag}`,
    assets: options.asset === false ? [] : [{
      name: `Tenon-${version}-arm64.dmg`,
      browser_download_url: `https://github.com/relixiaobo/lin-outliner/releases/download/${tag}/Tenon-${version}-arm64.dmg`,
    }],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function textResponse(value: string): Response {
  return new Response(value, { status: 200, headers: { 'content-type': 'text/plain' } });
}

describe('app update release decoding', () => {
  test('selects the highest stable SemVer instead of trusting response order', () => {
    const decoded = decodeGitHubReleases([
      release('0.4.0'),
      release('0.7.0-beta.1', { prerelease: true }),
      release('0.6.0'),
      release('0.5.0', { draft: true }),
    ]);
    expect(selectLatestStableRelease(decoded, '0.3.0')?.version).toBe('0.6.0');
    expect(selectLatestStableRelease(decoded, '0.6.0')).toBeNull();
  });

  test('rejects an unbounded response and ignores unsafe destinations', () => {
    expect(() => decodeGitHubReleases(Array.from({ length: 51 }, () => release('0.4.0'))))
      .toThrow(AppUpdatePayloadError);
    const unsafe = {
      ...release('0.4.0'),
      html_url: 'https://example.com/relixiaobo/lin-outliner/releases/tag/v0.4.0',
    };
    expect(decodeGitHubReleases([unsafe])).toEqual([]);
  });

  test('rejects normalized-but-impossible publication dates', () => {
    expect(decodeGitHubReleases([{
      ...release('0.4.0'),
      published_at: '2026-02-31T00:00:00Z',
    }])).toEqual([]);
  });
});

describe('AppUpdateStore', () => {
  test('degrades malformed state to defaults and records the load failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-app-update-store-'));
    const errors: string[] = [];
    try {
      await writeFile(join(root, 'app-update-state.json'), '{broken', 'utf8');
      const store = new AppUpdateStore(root, { onError: (_error, operation) => errors.push(operation) });
      expect(await store.load(true)).toEqual(defaultState(true));
      expect(errors).toEqual(['load']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists private state atomically with owner-only permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-app-update-store-'));
    try {
      const store = new AppUpdateStore(root);
      const state: StoredAppUpdateState = { ...defaultState(true), lastAttemptAt: NOW };
      await store.save(state);
      expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual(state);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AppUpdateService', () => {
  test('checks once per throttle window and keeps URLs out of the renderer view', async () => {
    const prepared = await prepareService();
    try {
      await prepared.service.checkInBackground();
      await prepared.service.checkInBackground();
      expect(prepared.fetchCalls).toHaveLength(2); // Releases plus exact-tag changelog.
      const view = await prepared.service.view();
      expect(view.availableRelease).toEqual({
        version: '0.6.0',
        publishedAt: '2026-08-10T00:00:00Z',
        note: 'A quieter, faster release.',
        downloadAvailable: true,
      });
      expect(JSON.stringify(view)).not.toContain('github.com');
      expect(isAppUpdateAvailable(view)).toBeTrue();
    } finally {
      await prepared.cleanup();
    }
  });

  test('explicit checks bypass throttling and ambient failures retain cached availability', async () => {
    const prepared = await prepareService();
    try {
      await prepared.service.checkInBackground();
      prepared.fetchImpl = async () => { throw new Error('offline'); };
      await prepared.service.checkInBackground({ force: true });
      expect((await prepared.service.view()).availableRelease?.version).toBe('0.6.0');
      expect((await prepared.service.view()).manualError).toBeNull();

      const explicit = await prepared.service.checkExplicitly();
      expect(explicit.availableRelease?.version).toBe('0.6.0');
      expect(explicit.manualError).toBe('network');
      expect(prepared.fetchCalls.length).toBe(4);
    } finally {
      await prepared.cleanup();
    }
  });

  test('surfaces failure when an explicit check joins an ambient check already in flight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-app-update-joined-check-'));
    let rejectFetch: ((error: Error) => void) | null = null;
    let markFetchStarted: (() => void) | null = null;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    try {
      const service = new AppUpdateService({
        currentVersion: '0.3.0',
        defaultAutomaticChecksEnabled: true,
        store: new AppUpdateStore(root),
        fetch: async () => new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
          markFetchStarted?.();
        }),
        openExternal: async () => undefined,
      });

      const ambient = service.checkInBackground();
      await fetchStarted;
      const explicit = service.checkExplicitly();
      rejectFetch?.(new Error('offline'));

      expect((await explicit).manualError).toBe('network');
      await ambient;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('stops reading an oversized chunked response at the byte limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-app-update-bounded-response-'));
    let pulls = 0;
    try {
      const service = new AppUpdateService({
        currentVersion: '0.3.0',
        defaultAutomaticChecksEnabled: true,
        store: new AppUpdateStore(root),
        fetch: async () => new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls > 2) throw new Error('Response was read past its byte limit.');
            controller.enqueue(new Uint8Array(600_000));
          },
        }, { highWaterMark: 0 })),
        openExternal: async () => undefined,
      });

      expect((await service.checkExplicitly()).manualError).toBe('invalid-response');
      expect(pulls).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports a five-second-style deadline only for an explicit check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-app-update-timeout-'));
    try {
      const service = new AppUpdateService({
        currentVersion: '0.3.0',
        defaultAutomaticChecksEnabled: true,
        store: new AppUpdateStore(root),
        fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        }),
        openExternal: async () => undefined,
        timeoutMs: 5,
      });

      expect((await service.checkExplicitly()).manualError).toBe('timeout');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps a verified release when its exact-tag note cannot be loaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-app-update-note-'));
    let calls = 0;
    try {
      const service = new AppUpdateService({
        currentVersion: '0.3.0',
        defaultAutomaticChecksEnabled: true,
        store: new AppUpdateStore(root),
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? jsonResponse([release('0.6.0', { asset: false })])
            : new Response('unavailable', { status: 503 });
        },
        openExternal: async () => undefined,
        now: () => NOW,
      });

      const view = await service.checkExplicitly();
      expect(view.manualError).toBeNull();
      expect(view.availableRelease).toEqual({
        version: '0.6.0',
        publishedAt: '2026-08-10T00:00:00Z',
        note: null,
        downloadAvailable: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('disabling automatic checks hides the dot but preserves manual checks', async () => {
    const prepared = await prepareService();
    try {
      await prepared.service.checkExplicitly();
      const disabled = await prepared.service.setAutomaticChecksEnabled(false);
      expect(disabled.availableRelease?.version).toBe('0.6.0');
      expect(isAppUpdateAvailable(disabled)).toBeFalse();
      const calls = prepared.fetchCalls.length;
      await prepared.service.checkInBackground({ force: true });
      expect(prepared.fetchCalls).toHaveLength(calls);
    } finally {
      await prepared.cleanup();
    }
  });

  test('opens only the main-owned cached destination', async () => {
    const opened: string[] = [];
    const prepared = await prepareService({ openExternal: async (url) => { opened.push(url); } });
    try {
      await prepared.service.checkExplicitly();
      expect(await prepared.service.openAvailableUpdate()).toEqual({ ok: true, destination: 'download' });
      expect(opened).toEqual([
        'https://github.com/relixiaobo/lin-outliner/releases/download/v0.6.0/Tenon-0.6.0-arm64.dmg',
      ]);
    } finally {
      await prepared.cleanup();
    }
  });

  test('retires cached availability when the running version catches up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenon-app-update-service-'));
    const store = new AppUpdateStore(root);
    try {
      await store.save({
        schemaVersion: 1,
        automaticChecksEnabled: true,
        lastAttemptAt: NOW - APP_UPDATE_THROTTLE_MS,
        lastSuccessfulCheckAt: NOW - APP_UPDATE_THROTTLE_MS,
        release: {
          version: '0.6.0',
          tag: 'v0.6.0',
          publishedAt: '2026-08-10T00:00:00.000Z',
          releasePageUrl: 'https://github.com/relixiaobo/lin-outliner/releases/tag/v0.6.0',
          downloadUrl: null,
          note: null,
        },
      });
      const service = new AppUpdateService({
        currentVersion: '0.6.0',
        defaultAutomaticChecksEnabled: true,
        store,
        fetch: async () => jsonResponse([]),
        openExternal: async () => undefined,
      });
      expect((await service.view()).availableRelease).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function prepareService(options: { openExternal?: (url: string) => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tenon-app-update-service-'));
  const fetchCalls: string[] = [];
  let fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('api.github.com')) return jsonResponse([release('0.4.0'), release('0.6.0')]);
    return textResponse('## [0.6.0] - 2026-08-10\n\nA quieter, faster release.\n\n### Fixed\n\n- Internal detail.\n');
  };
  const service = new AppUpdateService({
    currentVersion: '0.3.0',
    defaultAutomaticChecksEnabled: true,
    store: new AppUpdateStore(root),
    fetch: async (input, init) => {
      fetchCalls.push(String(input));
      return fetchImpl(input, init);
    },
    openExternal: options.openExternal ?? (async () => undefined),
    now: () => NOW,
  });
  return {
    service,
    fetchCalls,
    get fetchImpl() { return fetchImpl; },
    set fetchImpl(value: typeof fetch) { fetchImpl = value; },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
