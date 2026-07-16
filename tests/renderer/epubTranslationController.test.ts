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

  test('starts 2 / 4 / 4 visible batches and applies responses in completion order', async () => {
    const surface = new FakeSurface([
      batch(['One', 'Two'], 0),
      batch(['Three', 'Four', 'Five', 'Six'], 0),
      batch(['Seven', 'Eight', 'Nine', 'Ten'], 0),
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
    await waitFor(() => pending.length === 3);
    expect(pending.map(({ request }) => request.blocks.length)).toEqual([2, 4, 4]);
    expect(pending.every(({ request }) => request.contentKind === 'document')).toBe(true);
    expect(surface.nextBatchCalls.slice(0, 3).map(({ maxBlocks }) => maxBlocks)).toEqual([2, 4, 4]);

    pending[2]?.resolve(success(pending[2].request));
    await waitFor(() => surface.applied.length === 1);
    pending[0]?.resolve(success(pending[0].request));
    await waitFor(() => surface.applied.length === 2);
    pending[1]?.resolve(success(pending[1].request));
    await waitFor(() => surface.applied.length === 3);
    expect(surface.applied.map((items) => items[0]?.translation)).toEqual([
      'Translated Seven',
      'Translated One',
      'Translated Three',
    ]);
    expect(controller.currentStatus).toBe('on');
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

type FakeBatch = EpubTranslationBatch | ((options: EpubTranslationBatchOptions) => EpubTranslationBatch);

class FakeSurface implements EpubTranslationSurface {
  activeFailedIds = new Set<string>();
  applied: Array<ReadonlyArray<{ id: string; translation: string }>> = [];
  applyInsertedCount = 1;
  detectedLanguages: string[] = [];
  enabledStates: boolean[] = [];
  failed: string[][] = [];
  nextBatchCalls: EpubTranslationBatchOptions[] = [];
  released: string[][] = [];
  resetTargets: string[] = [];

  constructor(private readonly batches: FakeBatch[]) {}

  enqueue(next: FakeBatch): void {
    this.batches.push(next);
  }

  apply(items: ReadonlyArray<{ id: string; translation: string }>): number {
    this.applied.push(items);
    for (const { id } of items) this.activeFailedIds.delete(id);
    return this.applyInsertedCount;
  }

  fail(ids: readonly string[]): string[] {
    this.failed.push([...ids]);
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
    const next = this.batches.shift();
    return typeof next === 'function'
      ? next(options)
      : next ?? { blocks: [], priority: null };
  }

  release(ids: readonly string[]): void {
    this.released.push([...ids]);
  }

  reset(targetLanguage: Parameters<EpubTranslationSurface['reset']>[0]): void {
    this.activeFailedIds.clear();
    this.resetTargets.push(targetLanguage);
  }

  setEnabled(enabled: boolean): void {
    this.enabledStates.push(enabled);
  }
}

function batch(texts: string[], priority: number): EpubTranslationBatch {
  return {
    blocks: texts.map((text, index) => ({ id: `e:${text}:${index}`, text })),
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
