import { describe, expect, test } from 'bun:test';
import {
  PreviewOperations,
  type PreviewOperationCaller,
} from '../../src/main/hostDomain/previewOperations';
import {
  type PreviewAction,
  type PreviewObservation,
} from '../../src/core/previewOperations';

function observation(paneId = 'pane-1'): PreviewObservation {
  return {
    paneId,
    revision: 0,
    kind: 'page',
    sourceId: 'same-content',
    effectiveLanguage: 'en',
    status: 'off',
    controls: { language: null, model: null, automatic: false, display: 'automatic' },
  };
}
function fixture(
  options: {
    review?: () => Promise<boolean>;
    clear?: () => Promise<void>;
    send?: (action: PreviewAction) => void;
    timeout?: number;
  } = {},
) {
  const effects: string[] = [];
  let authorized = true;
  const caller: PreviewOperationCaller = {
    key: crypto.randomUUID(),
    origin: { kind: 'window', windowId: 1 },
    authorize: async () => {
      if (!authorized) throw new Error('Revoked');
    },
  };
  const host = new PreviewOperations({
    cache: {
      inspect: async () => ({
        entries: { page: 3, caption: 2, document: 1 },
        logicalBytes: 100,
        maxBytes: 1000,
        maxEntries: 100,
      }),
      clear: async (check) => {
        await check?.();
        effects.push('all');
        await options.clear?.();
      },
      clearSource: async (source, check) => {
        await check?.();
        effects.push(source);
      },
    },
    review: options.review ?? (async () => true),
    changed: () => {},
    websites: async () => ({ available: true, cacheBytes: 100, activeGuests: 2 }),
    clearWebsites: async () => {
      effects.push('websites');
      return { steps: [{ name: 'storage', state: 'completed' }], liveDisplays: 'reload_requested' };
    },
    send: (_owner, action) => options.send?.(action),
    ackTimeoutMs: options.timeout ?? 20,
  });
  return {
    host,
    caller,
    effects,
    revoke: () => {
      authorized = false;
    },
  };
}

describe('preview and data domain operations', () => {
  test('requires exact live identity and does not infer a same-source pane', async () => {
    const { host, caller } = fixture();
    const request = {
      request: { operation: 'configure', expectedRevision: 0, changes: { language: 'ja' } },
    };
    await expect(host.handle('preview_manage', request, caller)).rejects.toMatchObject({
      code: 'preview_unavailable',
    });
    const a = host.register(1, observation());
    const b = host.register(1, observation('pane-2'));
    await expect(host.handle('preview_manage', request, caller)).rejects.toMatchObject({
      code: 'preview_unavailable',
    });
    expect(await host.handle('preview_inspect', { request: {} }, caller)).toMatchObject({
      previews: [{ previewId: a }, { previewId: b }],
    });
    expect(() => host.observe(2, a, observation())).toThrow();
    host.releaseOwner(1);
    expect(await host.handle('preview_inspect', { request: {} }, caller)).toEqual({ previews: [] });
  });

  test('reports application only after an exact renderer acknowledgement', async () => {
    let sent!: PreviewAction;
    const { host, caller } = fixture({
      send: (action) => {
        sent = action;
      },
    });
    const id = host.register(1, observation());
    const result = host.handle(
      'preview_manage',
      {
        request: {
          operation: 'configure',
          previewId: id,
          expectedRevision: 0,
          changes: { language: 'ja' },
        },
      },
      caller,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const next = {
      ...observation(),
      revision: 1,
      effectiveLanguage: 'ja' as const,
      controls: { ...observation().controls, language: 'ja' as const },
    };
    host.acknowledge(2, { ...sent, state: 'applied', observation: next });
    host.acknowledge(1, { ...sent, state: 'applied', observation: next });
    expect(await result).toMatchObject({
      state: 'applied',
      preview: { previewId: id, revision: 1, effectiveLanguage: 'ja' },
    });
    await expect(
      host.handle(
        'preview_manage',
        { request: { operation: 'clear_cache', previewId: id, expectedRevision: 0 } },
        caller,
      ),
    ).rejects.toMatchObject({ code: 'stale_preview' });
  });

  test('missing acknowledgement is unknown and close/reopen invalidates the old identity', async () => {
    const { host, caller } = fixture();
    const old = host.register(1, observation());
    expect(
      await host.handle(
        'preview_manage',
        {
          request: {
            operation: 'configure',
            previewId: old,
            expectedRevision: 0,
            changes: { automatic: true },
          },
        },
        caller,
      ),
    ).toMatchObject({ state: 'unknown' });
    const reopened = host.register(1, observation());
    expect(old).not.toBe(reopened);
    await expect(
      host.handle('preview_inspect', { request: { previewId: old } }, caller),
    ).rejects.toMatchObject({ code: 'preview_unavailable' });
  });

  test('content clear selects one resource and preserves both same-source live states', async () => {
    const { host, caller, effects } = fixture();
    const a = host.register(1, observation());
    host.register(1, { ...observation('pane-2'), status: 'starting' });
    const before = await host.handle('preview_inspect', { request: {} }, caller);
    const result = await host.handle(
      'preview_manage',
      { request: { operation: 'clear_cache', previewId: a, expectedRevision: 0 } },
      caller,
    );
    expect(result).toMatchObject({ state: 'cleared', scope: 'content', liveDisplays: 'retained' });
    expect(effects).toEqual(['same-content']);
    expect(await host.handle('preview_inspect', { request: {} }, caller)).toEqual(before);
  });

  test('revalidates navigation and authority after native confirmation', async () => {
    let confirm!: (accept: boolean) => void;
    const setup = fixture({
      review: () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    });
    const id = setup.host.register(1, observation());
    const pending = setup.host.handle(
      'preview_manage',
      { request: { operation: 'clear_cache', previewId: id, expectedRevision: 0 } },
      setup.caller,
    );
    await new Promise((resolve) => setImmediate(resolve));
    setup.host.observe(1, id, { ...observation(), revision: 1, sourceId: 'different-content' });
    confirm(true);
    await expect(pending).rejects.toMatchObject({ code: 'stale_preview' });
    expect(setup.effects).toEqual([]);

    const revoked = fixture({
      review: async () => {
        revoked.revoke();
        return true;
      },
    });
    expect(
      await revoked.host.handle(
        'data_manage',
        { request: { scope: 'translations' } },
        revoked.caller,
      ),
    ).toMatchObject({ state: 'failed' });
    expect(revoked.effects).toEqual([]);
  });

  test('cancel is inert, and repeated delivery cannot clear newly produced data again', async () => {
    const canceled = fixture({ review: async () => false });
    expect(
      await canceled.host.handle(
        'data_manage',
        { request: { scope: 'websites' } },
        canceled.caller,
      ),
    ).toMatchObject({ state: 'canceled' });
    expect(canceled.effects).toEqual([]);
    const { host, caller, effects } = fixture();
    const input = { request: { scope: 'translations' } };
    const first = await host.handle('data_manage', input, caller);
    expect(await host.handle('data_manage', input, caller)).toEqual(first);
    expect(effects).toEqual(['all']);
    await expect(
      host.handle('data_manage', { request: { scope: 'websites' } }, caller),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('inspection is bounded and omits private source identities', async () => {
    const { host, caller } = fixture();
    host.register(1, observation());
    const data = await host.handle('data_inspect', { request: {} }, caller);
    expect(data).toMatchObject({ translations: { logicalBytes: expect.any(Number) } });
    const previews = await host.handle('preview_inspect', { request: {} }, caller);
    expect(JSON.stringify(previews)).not.toContain('same-content');
    for (const input of [
      { request: { approved: true, scope: 'translations' } },
      { request: { scope: 'content', path: '/private' } },
    ]) {
      await expect(host.handle('data_manage', input, caller)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
  });

  test('settles admitted effects after caller loss and makes concurrent clears busy', async () => {
    let finish!: () => void;
    const { host, caller, effects } = fixture({
      clear: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const controller = new AbortController();
    const pending = host.handle(
      'data_manage',
      { request: { scope: 'translations' } },
      { ...caller, signal: controller.signal },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(effects).toEqual(['all']);
    await expect(
      host.handle(
        'data_manage',
        { request: { scope: 'websites' } },
        { ...caller, key: 'different' },
      ),
    ).rejects.toMatchObject({ code: 'data_busy' });
    controller.abort();
    let settled = false;
    const closing = host.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect(await pending).toMatchObject({ state: 'cleared' });
    await closing;
    expect(await host.handle('data_inspect', { request: {} }, caller)).toMatchObject({
      operations: [{ state: 'cleared' }],
    });
  });
});
