import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseHTML } from 'linkedom';
import type {
  UrlPageTranslationRequest,
  UrlPageTranslationResponse,
} from '../../src/core/urlPageTranslation';
import { EpubTranslationController } from '../../src/renderer/ui/preview/epubTranslationController';
import type {
  EpubTranslationBatch,
  EpubTranslationBatchOptions,
  EpubTranslationSurface,
} from '../../src/renderer/ui/preview/epubTranslationDom';
import type { UrlPageTranslationStatus } from '../../src/renderer/ui/preview/urlPageTranslationController';

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

describe('EpubTranslationController', () => {
  test('stays idle without a visible block and never reports false completion', async () => {
    const surface = new FakeSurface([]);
    const statuses: UrlPageTranslationStatus[] = [];
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async () => { throw new Error('unexpected request'); },
      onError: () => undefined,
      onStatusChange: (status) => statuses.push(status),
    });

    controller.enable();
    await waitFor(() => controller.currentStatus === 'idle');
    expect(controller.hasCompletedTranslations).toBe(false);
    expect(statuses).toEqual(['starting', 'idle']);
    controller.destroy();
  });

  test('requires the EPUB auto preference and valid foreign-language metadata', async () => {
    const surface = new FakeSurface([batch(['Hello'], 0)]);
    surface.detectedLanguages = ['en'];
    const requests: UrlPageTranslationRequest[] = [];
    const controller = new EpubTranslationController(surface, {
      autoTranslate: false,
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => {
        requests.push(request);
        return success(request);
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    await delay(15);
    expect(requests).toHaveLength(0);
    expect(controller.currentStatus).toBe('off');

    controller.setAutoTranslate(true);
    await waitFor(() => requests.length === 1);
    expect(requests[0]?.contentKind).toBe('document');
    controller.destroy();

    const matching = new FakeSurface([batch(['Already Chinese'], 0)]);
    matching.detectedLanguages = ['zh-Hans'];
    const matchingController = new EpubTranslationController(matching, {
      autoTranslate: true,
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async () => { throw new Error('unexpected request'); },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });
    await delay(15);
    expect(matchingController.currentStatus).toBe('off');
    matchingController.destroy();
  });

  test('preserves automatic activation across a model restart and reevaluates a matching target', async () => {
    const surface = new FakeSurface([]);
    surface.detectedLanguages = ['en'];
    const controller = new EpubTranslationController(surface, {
      autoTranslate: true,
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async () => { throw new Error('unexpected request'); },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    await waitFor(() => controller.currentStatus === 'idle');
    controller.setTranslationModel('openai::gpt-5.4-mini');
    await waitFor(() => controller.currentStatus === 'idle');
    controller.setTargetLanguage('en');
    await waitFor(() => controller.currentStatus === 'off');
    expect(surface.resetTargets).toEqual(['zh-Hans', 'zh-Hans', 'en']);
    controller.destroy();
  });

  test('uses the shared six-request pool for visible work and applies responses in completion order', async () => {
    const surface = new FakeSurface([
      batch(['One'], 0),
      batch(['Two'], 0),
      batch(['Three'], 0),
      batch(['Four'], 0),
      batch(['Five'], 0),
      batch(['Six'], 0),
    ]);
    const pending: Array<{
      request: UrlPageTranslationRequest;
      resolve: (response: UrlPageTranslationResponse) => void;
    }> = [];
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => await new Promise((resolve) => pending.push({ request, resolve })),
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    controller.enable();
    await waitFor(() => pending.length === 6);
    expect(pending.map(({ request }) => request.blocks.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(pending.every(({ request }) => request.contentKind === 'document')).toBe(true);
    expect(surface.nextBatchCalls.slice(0, 6).map(({ maxBlocks }) => maxBlocks)).toEqual([8, 8, 8, 8, 8, 8]);
    expect(surface.nextBatchCalls.slice(0, 6).map(({ queueVisible }) => queueVisible))
      .toEqual([true, false, false, false, false, false]);
    expect(surface.nextBatchCalls.slice(0, 6).every(({ visibleOnly }) => visibleOnly === true)).toBe(true);

    pending[5]?.resolve(success(pending[5].request));
    await waitFor(() => surface.applied.length === 1);
    pending[0]?.resolve(success(pending[0].request));
    await waitFor(() => surface.applied.length === 2);
    for (let index = 1; index < 5; index += 1) pending[index]?.resolve(success(pending[index].request));
    await waitFor(() => surface.applied.length === 6);
    expect(surface.applied.map((items) => items[0]?.translation)).toEqual([
      'Translated Six',
      'Translated One',
      'Translated Two',
      'Translated Three',
      'Translated Four',
      'Translated Five',
    ]);
    expect(controller.currentStatus).toBe('on');
    controller.destroy();
  });

  test('applies partial persistent-cache hits before continuing only the EPUB misses', async () => {
    const sourceBatch = batch(['Cached passage', 'Missing passage'], 0);
    const surface = new FakeSurface([sourceBatch]);
    const requests: UrlPageTranslationRequest[] = [];
    let resolveProvider: ((response: UrlPageTranslationResponse) => void) | null = null;
    const controller = new EpubTranslationController(surface, {
      cacheSourceId: '["epub","asset:book",1024,1000]',
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return {
            ok: true,
            requestId: request.requestId,
            cacheHit: true,
            translations: [{ id: request.blocks[0]!.id, translation: '缓存段落' }],
            remainingBlockIds: [request.blocks[1]!.id],
          };
        }
        return await new Promise((resolve) => {
          resolveProvider = resolve;
        });
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    controller.enable();
    await waitFor(() => requests.length === 2);
    expect(surface.applied).toEqual([[
      { id: sourceBatch.blocks[0]!.id, translation: '缓存段落' },
    ]]);
    expect(controller.currentStatus).toBe('starting');
    expect(requests[0]?.blocks).toEqual(sourceBatch.blocks);
    expect(requests[1]?.blocks).toEqual([sourceBatch.blocks[1]]);
    expect(requests[1]?.sessionId).toBe(requests[0]?.sessionId);
    expect(requests[1]?.requestId).toBe(requests[0]?.requestId);
    expect(requests.every((request) => request.cacheSourceId === '["epub","asset:book",1024,1000]'))
      .toBe(true);

    resolveProvider?.({
      ok: true,
      requestId: requests[1]!.requestId,
      translations: [{ id: sourceBatch.blocks[1]!.id, translation: '模型段落' }],
    });
    await waitFor(() => surface.applied.length === 2);
    expect(surface.applied[1]).toEqual([
      { id: sourceBatch.blocks[1]!.id, translation: '模型段落' },
    ]);
    expect(controller.currentStatus).toBe('on');
    controller.destroy();
  });

  test('restarts an enabled session when the persistent-cache source changes', async () => {
    const initialBatch = batch(['Old edition'], 0);
    const replacementBatch = batch(['New edition'], 0);
    const surface = new FakeSurface([initialBatch]);
    const pending: Array<{
      request: UrlPageTranslationRequest;
      resolve: (response: UrlPageTranslationResponse) => void;
    }> = [];
    const cancelled: string[] = [];
    const controller = new EpubTranslationController(surface, {
      cacheSourceId: '["epub","asset:book",1024,1000]',
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async (sessionId) => { cancelled.push(sessionId); },
      translate: async (request) => await new Promise((resolve) => pending.push({ request, resolve })),
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    controller.enable();
    await waitFor(() => pending.length === 1);
    surface.enqueue(replacementBatch);
    controller.setCacheSourceId('["epub","asset:book",2048,2000]');
    await waitFor(() => pending.length === 2);

    expect(cancelled).toEqual([pending[0]!.request.sessionId]);
    expect(surface.released).toContainEqual(initialBatch.blocks.map(({ id }) => id));
    expect(surface.resetTargets).toEqual(['zh-Hans', 'zh-Hans']);
    expect(pending[1]!.request.cacheSourceId).toBe('["epub","asset:book",2048,2000]');

    pending[0]!.resolve(success(pending[0]!.request));
    await delay(10);
    expect(surface.applied).toEqual([]);

    pending[1]!.resolve(success(pending[1]!.request));
    await waitFor(() => surface.applied.length === 1);
    expect(surface.applied[0]?.[0]?.translation).toBe('Translated New edition');
    controller.destroy();
  });

  test('waits for an obsolete prefetch cancellation before starting replacement work', async () => {
    const surface = new FakeSurface([
      batch(['One', 'Two'], 0),
      batch(['Three', 'Four', 'Five', 'Six'], 0),
      batch(['Prefetch'], 1),
      (options) => ({
        ...batch(['New visible'], 0),
        preemptRequestId: options.activeBatches?.find(({ ids }) => (
          ids.some((id) => id.includes('Prefetch'))
        ))?.requestId ?? null,
      }),
    ]);
    const requests: UrlPageTranslationRequest[] = [];
    const cancelled: string[] = [];
    let releaseCancellation: (() => void) | null = null;
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      maxConcurrentRequests: 3,
      pollIntervalMs: 5,
      cancel: async (sessionId) => {
        cancelled.push(sessionId);
        if (cancelled.length === 1) {
          await new Promise<void>((resolve) => { releaseCancellation = resolve; });
        }
      },
      translate: async (request) => {
        requests.push(request);
        return await new Promise<UrlPageTranslationResponse>(() => undefined);
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    controller.enable();
    await waitFor(() => cancelled.length === 1);
    expect(requests.map(({ blocks }) => blocks.map(({ text }) => text))).toEqual([
      ['One', 'Two'],
      ['Three', 'Four', 'Five', 'Six'],
      ['Prefetch'],
    ]);
    releaseCancellation?.();
    await waitFor(() => requests.length === 4);
    expect(requests[3]?.blocks.map(({ text }) => text)).toEqual(['New visible']);
    controller.destroy();
  });

  test('does not start a re-enabled session until prior cancellation settles', async () => {
    const surface = new FakeSurface([batch(['First session'], 0)]);
    const requests: UrlPageTranslationRequest[] = [];
    let releaseCancellation: (() => void) | null = null;
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => {
        await new Promise<void>((resolve) => { releaseCancellation = resolve; });
      },
      translate: async (request) => {
        requests.push(request);
        return await new Promise<UrlPageTranslationResponse>(() => undefined);
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    controller.enable();
    await waitFor(() => requests.length === 1);
    controller.disable();
    surface.enqueue(batch(['Second session'], 0));
    controller.enable();
    await delay(15);
    expect(requests).toHaveLength(1);
    releaseCancellation?.();
    await waitFor(() => requests.length === 2);
    expect(requests[1]?.blocks.map(({ text }) => text)).toEqual(['Second session']);
    controller.destroy();
    releaseCancellation?.();
  });

  test('does not report completion when no translation is inserted', async () => {
    const surface = new FakeSurface([batch(['Already translated'], 0)]);
    surface.applyInsertedCount = 0;
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'en',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => success(request),
      onError: () => undefined,
      onStatusChange: () => undefined,
    });
    controller.enable();
    await waitFor(() => surface.applied.length === 1);
    await waitFor(() => controller.currentStatus === 'idle');
    expect(controller.hasCompletedTranslations).toBe(false);
    controller.destroy();
  });

  test('clears completion when the surface loses its last valid cached translation', async () => {
    const surface = new FakeSurface([batch(['Translated once'], 0)]);
    const completionStates: boolean[] = [];
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => success(request),
      onCompletionChange: (completed) => completionStates.push(completed),
      onError: () => undefined,
      onStatusChange: () => undefined,
    });
    controller.enable();
    await waitFor(() => controller.hasCompletedTranslations);

    surface.completedCount = 0;
    surface.wake();
    await waitFor(() => !controller.hasCompletedTranslations);

    expect(completionStates).toEqual([true, false]);
    controller.destroy();
  });

  test('resumes normal scheduling when a failed source record becomes obsolete', async () => {
    const surface = new FakeSurface([batch(['Old text'], 0)]);
    let requestCount = 0;
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => {
        requestCount += 1;
        return requestCount === 1
          ? { ok: false, requestId: request.requestId, error: 'provider-error' }
          : success(request);
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });
    controller.enable();
    await waitFor(() => controller.currentStatus === 'error');

    surface.activeFailedIds.clear();
    surface.enqueue(batch(['Updated text'], 0));
    await waitFor(() => surface.applied.length === 1);
    expect(controller.currentStatus).toBe('on');
    controller.destroy();
  });

  test('continues unrelated scheduling after a terminal batch failure', async () => {
    const surface = new FakeSurface([
      batch(['Fails'], 0),
      batch(['Succeeds'], 0),
      batch(['Continues'], 1),
    ]);
    const requests: UrlPageTranslationRequest[] = [];
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => {
        requests.push(request);
        if (request.blocks[0]?.text === 'Fails') {
          return { ok: false, requestId: request.requestId, error: 'provider-error' };
        }
        return success(request);
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    controller.enable();
    await waitFor(() => surface.applied.length === 2);
    expect(requests.map(({ blocks }) => blocks[0]?.text)).toEqual(['Fails', 'Succeeds', 'Continues']);
    expect(surface.failed).toHaveLength(1);
    expect(controller.currentStatus).toBe('error');
    controller.destroy();
  });

  test('keeps unrelated work blocked until an explicit configuration retry succeeds', async () => {
    const surface = new FakeSurface([batch(['Needs configuration'], 0)]);
    const requests: UrlPageTranslationRequest[] = [];
    let configured = false;
    let resolveRetry: ((response: UrlPageTranslationResponse) => void) | null = null;
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => {
        requests.push(request);
        if (!configured) {
          return { ok: false, requestId: request.requestId, error: 'not-configured' };
        }
        if (request.blocks[0]?.text === 'Needs configuration') {
          return await new Promise((resolve) => { resolveRetry = resolve; });
        }
        return success(request);
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });

    controller.enable();
    await waitFor(() => controller.currentStatus === 'error');
    configured = true;
    surface.activeFailedIds.clear();
    surface.enqueue({ ...batch(['Needs configuration'], 0), requiresRetry: true });
    surface.enqueue({ ...batch(['Must wait for recovery'], 0), requiresRetry: false });
    surface.wake();
    await waitFor(() => requests.length === 2);
    await delay(20);
    expect(requests).toHaveLength(2);

    const retryRequest = requests[1]!;
    resolveRetry?.(success(retryRequest));
    await waitFor(() => requests.length === 3);
    expect(requests.map(({ blocks }) => blocks[0]?.text)).toEqual([
      'Needs configuration',
      'Needs configuration',
      'Must wait for recovery',
    ]);
    controller.destroy();
  });

  test('keeps configuration work blocked when the failed EPUB record is stale', async () => {
    const surface = new FakeSurface([batch(['Stale configuration source'], 0)]);
    surface.failReturnsIds = false;
    const requests: UrlPageTranslationRequest[] = [];
    let configured = false;
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async () => undefined,
      translate: async (request) => {
        requests.push(request);
        return configured
          ? success(request)
          : { ok: false, requestId: request.requestId, error: 'not-configured' };
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });
    controller.enable();
    await waitFor(() => controller.currentStatus === 'error');

    surface.enqueue({ ...batch(['New visible text'], 0), requiresRetry: false });
    surface.wake();
    await delay(30);
    expect(requests).toHaveLength(1);
    expect(controller.currentStatus).toBe('error');
    const firstRetryCall = surface.nextBatchCalls.findIndex((call) => call.retryOnly);
    expect(firstRetryCall).toBeGreaterThanOrEqual(0);
    expect(surface.nextBatchCalls.slice(firstRetryCall).every((call) => call.retryOnly)).toBe(true);

    configured = true;
    controller.setTranslationModel('openai::gpt-5.4-mini');
    await waitFor(() => requests.length === 2);
    expect(requests[1]?.blocks[0]?.text).toBe('New visible text');
    controller.destroy();
  });

  test('wakes immediately when a new EPUB section or scroll makes work available', async () => {
    const surface = new FakeSurface([]);
    const requests: UrlPageTranslationRequest[] = [];
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 1_000,
      cancel: async () => undefined,
      translate: async (request) => {
        requests.push(request);
        return success(request);
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });
    controller.enable();
    await waitFor(() => controller.currentStatus === 'idle');

    surface.enqueue(batch(['Newly visible'], 0));
    surface.wake();

    await waitFor(() => requests.length === 1);
    expect(requests[0]?.blocks[0]?.text).toBe('Newly visible');
    controller.destroy();
  });

  test('ignores a late response after target-language reset', async () => {
    const surface = new FakeSurface([batch(['Old text'], 0)]);
    let resolveRequest: ((response: UrlPageTranslationResponse) => void) | null = null;
    let activeRequest: UrlPageTranslationRequest | null = null;
    const cancelled: string[] = [];
    const controller = new EpubTranslationController(surface, {
      targetLanguage: 'zh-Hans',
      pollIntervalMs: 5,
      cancel: async (sessionId) => { cancelled.push(sessionId); },
      translate: async (request) => {
        activeRequest = request;
        return await new Promise((resolve) => { resolveRequest = resolve; });
      },
      onError: () => undefined,
      onStatusChange: () => undefined,
    });
    controller.enable();
    await waitFor(() => activeRequest !== null);
    controller.setTargetLanguage('ja');
    expect(surface.resetTargets).toEqual(['zh-Hans', 'ja']);
    expect(cancelled).toHaveLength(1);

    if (!activeRequest || !resolveRequest) throw new Error('Missing pending EPUB translation');
    resolveRequest(success(activeRequest));
    await delay(10);
    expect(surface.applied).toEqual([]);
    controller.destroy();
  });
});

type FakeBatch = (EpubTranslationBatch & { requiresRetry?: boolean })
  | ((options: EpubTranslationBatchOptions) => EpubTranslationBatch & { requiresRetry?: boolean });

class FakeSurface implements EpubTranslationSurface {
  activeFailedIds = new Set<string>();
  applied: Array<ReadonlyArray<{ id: string; translation: string }>> = [];
  applyInsertedCount = 1;
  completedCount = 0;
  detectedLanguages: string[] = [];
  enabledStates: boolean[] = [];
  failReturnsIds = true;
  failed: string[][] = [];
  nextBatchCalls: EpubTranslationBatchOptions[] = [];
  released: string[][] = [];
  resetTargets: string[] = [];
  private workAvailableHandler: () => void = () => undefined;

  constructor(private readonly batches: FakeBatch[]) {}

  enqueue(next: FakeBatch): void {
    this.batches.push(next);
  }

  apply(items: ReadonlyArray<{ id: string; translation: string }>): number {
    this.applied.push(items);
    for (const { id } of items) this.activeFailedIds.delete(id);
    if (this.applyInsertedCount > 0) this.completedCount += this.applyInsertedCount;
    return this.applyInsertedCount;
  }

  completedRecordCount(): number {
    return this.completedCount;
  }

  fail(ids: readonly string[]): string[] {
    this.failed.push([...ids]);
    if (!this.failReturnsIds) return [];
    for (const id of ids) this.activeFailedIds.add(id);
    return [...ids];
  }

  failedRecordIds(): string[] {
    return [...this.activeFailedIds];
  }

  languages(): string[] {
    return this.detectedLanguages;
  }

  nextBatch(options: EpubTranslationBatchOptions): EpubTranslationBatch {
    this.nextBatchCalls.push(options);
    const batchIndex = this.batches.findIndex((entry) => (
      typeof entry === 'function'
      || entry.requiresRetry === undefined
      || entry.requiresRetry === (options.retryOnly ?? false)
    ));
    const next = batchIndex >= 0 ? this.batches.splice(batchIndex, 1)[0] : undefined;
    const resolved = typeof next === 'function'
      ? next(options)
      : next ?? { blocks: [], priority: null };
    const { requiresRetry: _requiresRetry, ...batch } = resolved;
    return batch;
  }

  release(ids: readonly string[]): void {
    this.released.push([...ids]);
  }

  reset(targetLanguage: Parameters<EpubTranslationSurface['reset']>[0]): void {
    this.activeFailedIds.clear();
    this.completedCount = 0;
    this.resetTargets.push(targetLanguage);
  }

  setEnabled(enabled: boolean): void {
    this.enabledStates.push(enabled);
  }

  setWorkAvailableHandler(handler: () => void): void {
    this.workAvailableHandler = handler;
  }

  wake(): void {
    this.workAvailableHandler();
  }
}

function batch(texts: string[], priority: number): EpubTranslationBatch {
  return {
    blocks: texts.map((text, index) => {
      const id = `e:${text}:${index}`;
      return { id, text, cacheKey: id };
    }),
    priority,
  };
}

function success(request: UrlPageTranslationRequest): UrlPageTranslationResponse {
  return {
    ok: true,
    requestId: request.requestId,
    translations: request.blocks.map(({ id, text }) => ({ id, translation: `Translated ${text}` })),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for EPUB translation state');
    await delay(2);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
