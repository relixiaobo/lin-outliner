import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import type { TranslationLanguage } from '../../src/core/translationLanguage';
import type { UrlPageTranslationResponse } from '../../src/core/urlPageTranslation';
import {
  UrlPageTranslationController,
  type UrlPageTranslationStatus,
} from '../../src/renderer/ui/preview/urlPageTranslationController';
import type {
  UrlPageTranslationGuestBatch,
  UrlPageTranslationGuestBridge,
} from '../../src/renderer/ui/preview/urlPageTranslationGuest';

let previousWindow: typeof globalThis.window | undefined;

beforeEach(() => {
  previousWindow = globalThis.window;
  const { window } = parseHTML('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window });
});

afterEach(() => {
  if (previousWindow) Object.assign(globalThis, { window: previousWindow });
  else delete (globalThis as typeof globalThis & { window?: Window }).window;
});

describe('UrlPageTranslationController', () => {
  test('stays idle without reporting completion when no eligible blocks exist', async () => {
    const guest = new FakeGuest([]);
    const statuses: UrlPageTranslationStatus[] = [];
    const requests: string[] = [];
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'en',
      guest,
      pollIntervalMs: 5,
      onError: () => undefined,
      onStatusChange: (status) => statuses.push(status),
      cancel: async () => undefined,
      translate: async (request) => {
        requests.push(...request.blocks.map((block) => block.text));
        return { ok: true, requestId: request.requestId, translations: [] };
      },
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => guest.nextBatchCalls.length > 0);

    expect(requests).toEqual([]);
    expect(controller.currentStatus).toBe('idle');
    expect(controller.hasCompletedTranslations).toBe(false);
    expect(statuses).toEqual(['starting', 'idle']);
    controller.destroy();
  });

  test('returns to starting when an eligible block appears after idle', async () => {
    const guest = new FakeGuest([]);
    const statuses: UrlPageTranslationStatus[] = [];
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      pollIntervalMs: 5,
      onError: () => undefined,
      onStatusChange: (status) => statuses.push(status),
      cancel: async () => undefined,
      translate: async (request) => ({
        ok: true,
        requestId: request.requestId,
        translations: [{ id: 'b1', translation: '你好' }],
      }),
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => controller.currentStatus === 'idle');

    guest.queueBatch({ blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 });
    await waitFor(() => guest.applied.length === 1);

    expect(controller.currentStatus).toBe('on');
    expect(controller.hasCompletedTranslations).toBe(true);
    expect(statuses).toEqual(['starting', 'idle', 'starting', 'on']);
    controller.destroy();
  });

  test('translates the guest-selected viewport batch and settles the header state', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
      { blocks: [], priority: null },
    ]);
    const statuses: UrlPageTranslationStatus[] = [];
    const requests: string[] = [];
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      pollIntervalMs: 5,
      onError: () => undefined,
      onStatusChange: (status) => statuses.push(status),
      cancel: async () => undefined,
      translate: async (request) => {
        requests.push(request.blocks[0]?.text ?? '');
        return {
          ok: true,
          requestId: request.requestId,
          translations: [{ id: 'b1', translation: '你好' }],
        };
      },
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => guest.applied.length === 1);

    expect(requests).toEqual(['Hello']);
    expect(guest.applied).toEqual([[{ id: 'b1', translation: '你好' }]]);
    expect(controller.currentStatus).toBe('on');
    expect(controller.hasCompletedTranslations).toBe(true);
    expect(statuses).toEqual(['starting', 'on']);
    controller.destroy();
  });

  test('uses the selected target language independently of the UI locale', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
    ]);
    const targets: TranslationLanguage[] = [];
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'ja',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => undefined,
      translate: async (request) => {
        targets.push(request.targetLanguage);
        return {
          ok: true,
          requestId: request.requestId,
          translations: [{ id: 'b1', translation: '你好' }],
        };
      },
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => guest.applied.length === 1);

    expect(targets).toEqual(['ja']);
    expect(guest.enabledCalls[0]).toEqual([true, 'ja']);
    controller.destroy();
  });

  test('automatically translates a page with a valid differing top-level language', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
    ], 'en-US');
    const controller = new UrlPageTranslationController(fakeWebview(), {
      autoTranslate: true,
      targetLanguage: 'zh-Hans',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => undefined,
      translate: async (request) => ({
        ok: true,
        requestId: request.requestId,
        translations: [{ id: 'b1', translation: '你好' }],
      }),
    });

    dispatch(controller, 'dom-ready');
    await waitFor(() => guest.applied.length === 1);

    expect(guest.documentLanguageCalls).toBe(1);
    expect(controller.currentStatus).toBe('on');
    controller.destroy();
  });

  test('turns an auto-activated page off when the target changes to its declared language', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
    ], 'en-US');
    let requests = 0;
    const controller = new UrlPageTranslationController(fakeWebview(), {
      autoTranslate: true,
      targetLanguage: 'zh-Hans',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => undefined,
      translate: async (request) => {
        requests += 1;
        return {
          ok: true,
          requestId: request.requestId,
          translations: [{ id: 'b1', translation: '你好' }],
        };
      },
    });
    dispatch(controller, 'dom-ready');
    await waitFor(() => controller.currentStatus === 'on');

    controller.setTargetLanguage('en');
    await waitFor(() => guest.documentLanguageCalls >= 2);

    expect(controller.currentStatus).toBe('off');
    expect(controller.hasCompletedTranslations).toBe(false);
    expect(requests).toBe(1);
    controller.destroy();
  });

  test('keeps same-language, missing-language, and invalid-language pages manual', async () => {
    for (const declaredLanguage of ['zh-CN', null, 'not_a_language']) {
      const guest = new FakeGuest([
        { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
      ], declaredLanguage);
      const controller = new UrlPageTranslationController(fakeWebview(), {
        autoTranslate: true,
        targetLanguage: 'zh-Hans',
        guest,
        onError: () => undefined,
        onStatusChange: () => undefined,
        cancel: async () => undefined,
      });

      dispatch(controller, 'dom-ready');
      await waitFor(() => guest.documentLanguageCalls === 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(controller.currentStatus).toBe('off');
      expect(guest.nextBatchCalls).toEqual([]);
      controller.destroy();
    }
  });

  test('checks the current page when auto translation is enabled and does not hide it when disabled', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
    ], 'en');
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => undefined,
      translate: async (request) => ({
        ok: true,
        requestId: request.requestId,
        translations: [{ id: 'b1', translation: '你好' }],
      }),
    });
    dispatch(controller, 'dom-ready');
    expect(controller.currentStatus).toBe('off');

    controller.setAutoTranslate(true);
    await waitFor(() => controller.currentStatus === 'on');
    controller.setAutoTranslate(false);

    expect(controller.currentStatus).toBe('on');
    expect(guest.enabledCalls.at(-1)).toEqual([true, 'zh-Hans']);
    controller.destroy();
  });

  test('suppresses auto translation after manual hide until the next top-level navigation', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'First page' }], priority: 0 },
    ], 'en');
    let requests = 0;
    const webview = fakeWebview();
    const controller = new UrlPageTranslationController(webview, {
      autoTranslate: true,
      targetLanguage: 'zh-Hans',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => undefined,
      translate: async (request) => {
        requests += 1;
        return {
          ok: true,
          requestId: request.requestId,
          translations: [{ id: request.blocks[0]!.id, translation: '译文' }],
        };
      },
    });
    dispatch(controller, 'dom-ready');
    await waitFor(() => requests === 1);
    controller.disable();

    dispatch(controller, 'dom-ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toBe(1);

    guest.queueBatch({ blocks: [{ id: 'b2', text: 'Second page' }], priority: 0 });
    const navigation = new window.Event('did-start-navigation');
    Object.defineProperties(navigation, {
      isInPlace: { value: false },
      isMainFrame: { value: true },
    });
    webview.dispatchEvent(navigation);
    dispatch(controller, 'dom-ready');
    await waitFor(() => requests === 2);

    expect(controller.currentStatus).toBe('on');
    controller.destroy();
  });

  test('cancels, clears, and restarts the visible work when the translation model changes', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'First' }], priority: 0 },
      { blocks: [{ id: 'b2', text: 'Second' }], priority: 0 },
    ]);
    const models: Array<string | undefined> = [];
    const sessions: string[] = [];
    const cancelled: string[] = [];
    let resolveFirst: ((response: UrlPageTranslationResponse) => void) | null = null;
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async (sessionId) => {
        cancelled.push(sessionId);
      },
      translate: async (request) => {
        models.push(request.model);
        sessions.push(request.sessionId);
        if (models.length === 1) {
          return await new Promise<UrlPageTranslationResponse>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return {
          ok: true,
          requestId: request.requestId,
          translations: [{ id: 'b2', translation: '第二' }],
        };
      },
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => models.length === 1);
    controller.setTranslationModel('openai/gpt-4.1-mini');
    await waitFor(() => models.length === 2);

    expect(models).toEqual([undefined, 'openai/gpt-4.1-mini']);
    expect(sessions[1]).not.toBe(sessions[0]);
    expect(cancelled).toEqual([sessions[0]!]);
    expect(guest.destroyed).toBeGreaterThan(0);
    resolveFirst?.({ ok: false, requestId: 'obsolete', error: 'cancelled' });
    controller.destroy();
  });

  test('keeps a failed block retryable until the user explicitly retries it', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
    ]);
    const errors: string[] = [];
    const statuses: UrlPageTranslationStatus[] = [];
    let configured = false;
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      pollIntervalMs: 5,
      onError: (error) => errors.push(error),
      onStatusChange: (status) => statuses.push(status),
      cancel: async () => undefined,
      translate: async (request): Promise<UrlPageTranslationResponse> => configured
        ? {
            ok: true,
            requestId: request.requestId,
            translations: [{ id: 'b1', translation: '你好' }],
          }
        : {
            ok: false,
            requestId: request.requestId,
            error: 'not-configured',
          },
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => guest.nextBatchCalls.length >= 2);

    expect(errors).toEqual(['not-configured']);
    expect(controller.currentStatus).toBe('error');
    expect(controller.hasCompletedTranslations).toBe(false);
    expect(guest.failed).toEqual([['b1']]);
    expect(guest.nextBatchCalls.slice(1).every(Boolean)).toBe(true);
    expect(guest.enabledCalls).toEqual([[true, 'zh-Hans']]);

    configured = true;
    guest.queueBatch({ blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 });
    await waitFor(() => guest.applied.length === 1);

    expect(controller.currentStatus).toBe('on');
    expect(controller.hasCompletedTranslations).toBe(true);
    expect(statuses).toEqual(['starting', 'error', 'on']);
    controller.destroy();
  });

  test('keeps completion visible when a later viewport batch fails', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'First' }], priority: 0 },
      { blocks: [{ id: 'b2', text: 'Second' }], priority: 0 },
    ]);
    const completionStates: boolean[] = [];
    let requestCount = 0;
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      pollIntervalMs: 5,
      onCompletionChange: (completed) => completionStates.push(completed),
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => undefined,
      translate: async (request): Promise<UrlPageTranslationResponse> => {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            ok: true,
            requestId: request.requestId,
            translations: [{ id: 'b1', translation: '第一' }],
          };
        }
        return { ok: false, requestId: request.requestId, error: 'provider-error' };
      },
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => controller.currentStatus === 'error');

    expect(guest.applied).toEqual([[{ id: 'b1', translation: '第一' }]]);
    expect(controller.hasCompletedTranslations).toBe(true);
    expect(completionStates).toEqual([true]);
    controller.destroy();
  });

  test('hides guest translations and cancels the active session when disabled', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
    ]);
    let resolveResponse: ((response: UrlPageTranslationResponse) => void) | null = null;
    let activeRequestId = '';
    const cancelled: string[] = [];
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async (sessionId) => {
        cancelled.push(sessionId);
      },
      translate: async (request) => {
        activeRequestId = request.requestId;
        return await new Promise<UrlPageTranslationResponse>((resolve) => {
          resolveResponse = resolve;
        });
      },
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => Boolean(resolveResponse));
    controller.disable();
    resolveResponse?.({ ok: false, requestId: activeRequestId, error: 'cancelled' });
    await Promise.resolve();

    expect(controller.currentStatus).toBe('off');
    expect(cancelled).toHaveLength(1);
    expect(guest.enabledCalls.at(-1)).toEqual([false, 'zh-Hans']);
    controller.destroy();
  });

  test('restores the completed state when cached translations are shown again', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'Hello' }], priority: 0 },
      { blocks: [], priority: null },
    ]);
    const statuses: UrlPageTranslationStatus[] = [];
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      pollIntervalMs: 5,
      onError: () => undefined,
      onStatusChange: (status) => statuses.push(status),
      cancel: async () => undefined,
      translate: async (request) => ({
        ok: true,
        requestId: request.requestId,
        translations: [{ id: 'b1', translation: '你好' }],
      }),
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => controller.currentStatus === 'on');
    controller.disable();
    controller.enable();
    await waitFor(() => statuses.filter((status) => status === 'on').length === 2);

    expect(statuses).toEqual(['starting', 'on', 'off', 'starting', 'on']);
    expect(guest.applied).toHaveLength(1);
    expect(controller.hasCompletedTranslations).toBe(true);
    controller.destroy();
  });

  test('uses a fresh session when translation is re-enabled before cancellation settles', async () => {
    const guest = new FakeGuest([
      { blocks: [{ id: 'b1', text: 'First' }], priority: 0 },
      { blocks: [{ id: 'b2', text: 'Second' }], priority: 0 },
    ]);
    const sessions: string[] = [];
    let resolveFirst: ((response: UrlPageTranslationResponse) => void) | null = null;
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      pollIntervalMs: 5,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => await new Promise<void>(() => undefined),
      translate: async (request) => {
        sessions.push(request.sessionId);
        if (sessions.length === 1) {
          return await new Promise<UrlPageTranslationResponse>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return {
          ok: true,
          requestId: request.requestId,
          translations: [{ id: 'b2', translation: '第二' }],
        };
      },
    });

    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => Boolean(resolveFirst));
    controller.disable();
    controller.enable();
    await waitFor(() => sessions.length === 2);

    expect(sessions[1]).not.toBe(sessions[0]);
    resolveFirst?.({ ok: false, requestId: 'obsolete', error: 'cancelled' });
    controller.destroy();
  });

  test('resets to off when the webview starts a top-level navigation', async () => {
    const webview = fakeWebview();
    const guest = new FakeGuest([]);
    const controller = new UrlPageTranslationController(webview, {
      targetLanguage: 'zh-Hans',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => undefined,
    });
    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => guest.enabledCalls.length > 0);

    const navigation = new window.Event('did-start-navigation');
    Object.defineProperties(navigation, {
      isInPlace: { value: false },
      isMainFrame: { value: true },
    });
    webview.dispatchEvent(navigation);

    expect(controller.currentStatus).toBe('off');
    await waitFor(() => guest.destroyed > 0);
    expect(guest.destroyed).toBeGreaterThan(0);
    controller.destroy();
  });

  test('serializes guest teardown before restarting the latest selected language', async () => {
    const operations: string[] = [];
    let destroyCount = 0;
    let releaseFirstDestroy: (() => void) | null = null;
    const guest: UrlPageTranslationGuestBridge = {
      async documentLanguage() {
        return 'en';
      },
      async initialize(targetLanguage) {
        operations.push(`initialize:${targetLanguage}`);
      },
      async setEnabled(enabled, targetLanguage) {
        operations.push(`enabled:${enabled}:${targetLanguage}`);
      },
      async nextBatch() {
        return { blocks: [], priority: null };
      },
      async apply() {},
      async fail() {},
      async destroy() {
        destroyCount += 1;
        const current = destroyCount;
        operations.push(`destroy:${current}:start`);
        if (current === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstDestroy = resolve;
          });
        }
        operations.push(`destroy:${current}:end`);
      },
    };
    const controller = new UrlPageTranslationController(fakeWebview(), {
      targetLanguage: 'zh-Hans',
      guest,
      onError: () => undefined,
      onStatusChange: () => undefined,
      cancel: async () => undefined,
    });
    controller.enable();
    dispatch(controller, 'dom-ready');
    await waitFor(() => operations.includes('enabled:true:zh-Hans'));

    controller.setTargetLanguage('ja');
    await waitFor(() => operations.includes('destroy:1:start'));
    controller.setTargetLanguage('fr');
    expect(operations).not.toContain('initialize:ja');
    expect(operations).not.toContain('initialize:fr');

    releaseFirstDestroy?.();
    await waitFor(() => operations.includes('enabled:true:fr'));

    expect(operations).not.toContain('initialize:ja');
    expect(operations.indexOf('destroy:2:end')).toBeLessThan(operations.indexOf('initialize:fr'));
    controller.destroy();
  });
});

class FakeGuest implements UrlPageTranslationGuestBridge {
  applied: Array<Array<{ id: string; translation: string }>> = [];
  documentLanguageCalls = 0;
  destroyed = 0;
  enabledCalls: Array<[boolean, TranslationLanguage]> = [];
  failed: string[][] = [];
  nextBatchCalls: boolean[] = [];

  constructor(
    private readonly batches: UrlPageTranslationGuestBatch[],
    public declaredLanguage: string | null = 'en',
  ) {}

  queueBatch(batch: UrlPageTranslationGuestBatch): void {
    this.batches.push(batch);
  }

  async documentLanguage(): Promise<string | null> {
    this.documentLanguageCalls += 1;
    return this.declaredLanguage;
  }

  async initialize(): Promise<void> {}

  async setEnabled(enabled: boolean, targetLanguage: TranslationLanguage): Promise<void> {
    this.enabledCalls.push([enabled, targetLanguage]);
  }

  async nextBatch(retryOnly = false): Promise<UrlPageTranslationGuestBatch> {
    this.nextBatchCalls.push(retryOnly);
    return this.batches.shift() ?? { blocks: [], priority: null };
  }

  async apply(translations: readonly { id: string; translation: string }[]): Promise<void> {
    this.applied.push([...translations]);
  }

  async fail(ids: readonly string[]): Promise<void> {
    this.failed.push([...ids]);
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
}

function fakeWebview(): Electron.WebviewTag {
  return new window.EventTarget() as Electron.WebviewTag;
}

function dispatch(controller: UrlPageTranslationController, type: string): void {
  const webview = (controller as unknown as { webview: Electron.WebviewTag }).webview;
  webview.dispatchEvent(new window.Event(type));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for translation controller');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
