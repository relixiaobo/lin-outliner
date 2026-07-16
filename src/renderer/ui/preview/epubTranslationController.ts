import {
  isValidLanguageTag,
  languageTagMatchesTranslationLanguage,
  type TranslationLanguage,
} from '../../../core/translationLanguage';
import type {
  UrlPageTranslationFailureCode,
  UrlPageTranslationRequest,
  UrlPageTranslationResponse,
} from '../../../core/urlPageTranslation';
import { api } from '../../api/client';
import type { UrlPageTranslationStatus } from './urlPageTranslationController';
import {
  type EpubTranslationBatch,
  type EpubTranslationSurface,
} from './epubTranslationDom';

const DEFAULT_POLL_INTERVAL_MS = 120;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const FIRST_VISIBLE_MAX_BLOCKS = 2;
const FIRST_VISIBLE_MAX_CHARS = 2_000;
const STANDARD_BATCH_MAX_BLOCKS = 4;
const STANDARD_BATCH_MAX_CHARS = 4_000;
const MAX_PREFETCH_REQUESTS = 1;
const AUTO_EVALUATION_INTERVAL_MS = 1_000;

let fallbackId = 1;

export interface EpubTranslationControllerOptions {
  autoTranslate?: boolean;
  cancel?: (sessionId: string) => Promise<unknown>;
  maxConcurrentRequests?: number;
  model?: string | null;
  onCompletionChange?: (completed: boolean) => void;
  onError: (error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>) => void;
  onStatusChange: (status: UrlPageTranslationStatus) => void;
  pollIntervalMs?: number;
  targetLanguage: TranslationLanguage;
  translate?: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;
}

interface ActiveEpubTranslationRequest {
  generation: number;
  ids: string[];
  priority: number;
  requestId: string;
  sequence: number;
  sessionId: string;
}

export class EpubTranslationController {
  private readonly activeRequests = new Map<string, ActiveEpubTranslationRequest>();
  private autoActivated = false;
  private autoTimer: number | null = null;
  private autoTranslate: boolean;
  private readonly cancel: (sessionId: string) => Promise<unknown>;
  private cancellationBarrier: Promise<void> = Promise.resolve();
  private completed = false;
  private destroyed = false;
  private enabled = false;
  private readonly failedIds = new Set<string>();
  private generation = 0;
  private hasStartedVisibleBatch = false;
  private readonly maxConcurrentRequests: number;
  private manualSuppressed = false;
  private model: string | null;
  private pausedForError = false;
  private readonly pollIntervalMs: number;
  private requestSequence = 0;
  private status: UrlPageTranslationStatus = 'off';
  private targetLanguage: TranslationLanguage;
  private timer: number | null = null;
  private tickQueue: Promise<void> = Promise.resolve();
  private readonly translate: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;

  constructor(
    private readonly surface: EpubTranslationSurface,
    private readonly options: EpubTranslationControllerOptions,
  ) {
    this.autoTranslate = options.autoTranslate ?? false;
    this.cancel = options.cancel ?? api.cancelUrlPageTranslation;
    this.maxConcurrentRequests = Math.min(
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      Math.max(1, Math.floor(options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS)),
    );
    this.model = options.model ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.targetLanguage = options.targetLanguage;
    this.translate = options.translate ?? api.translateUrlPageBlocks;
    this.surface.reset(this.targetLanguage);
    if (this.autoTranslate) this.evaluateAutoTranslation(this.generation);
  }

  get currentStatus(): UrlPageTranslationStatus {
    return this.status;
  }

  get hasCompletedTranslations(): boolean {
    return this.completed;
  }

  toggle(): void {
    if (this.status === 'off') this.enable();
    else this.disable();
  }

  enable(): void {
    if (this.destroyed || this.enabled) return;
    this.manualSuppressed = false;
    this.startTranslation(false);
  }

  disable(): void {
    if (this.destroyed) return;
    this.manualSuppressed = true;
    this.autoActivated = false;
    this.enabled = false;
    this.pausedForError = false;
    this.generation += 1;
    this.clearTimer();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.failedIds.clear();
    this.surface.setEnabled(false);
    this.setStatus('off');
  }

  setAutoTranslate(autoTranslate: boolean): void {
    if (this.destroyed || this.autoTranslate === autoTranslate) return;
    this.autoTranslate = autoTranslate;
    if (!autoTranslate) {
      this.autoActivated = false;
      this.clearAutoTimer();
      return;
    }
    this.manualSuppressed = false;
    if (!this.enabled) this.evaluateAutoTranslation(this.generation);
  }

  setTranslationModel(model: string | null): void {
    if (this.destroyed || this.model === model) return;
    this.model = model;
    this.resetForConfigurationChange();
  }

  setTargetLanguage(targetLanguage: TranslationLanguage): void {
    if (this.destroyed || this.targetLanguage === targetLanguage) return;
    const reevaluateAuto = this.enabled && this.autoActivated && this.autoTranslate;
    this.targetLanguage = targetLanguage;
    this.resetForConfigurationChange(reevaluateAuto);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.enabled = false;
    this.generation += 1;
    this.clearTimer();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.surface.setEnabled(false);
  }

  private startTranslation(automatic: boolean): void {
    if (this.destroyed || this.enabled) return;
    this.clearAutoTimer();
    this.autoActivated = automatic;
    this.enabled = true;
    this.pausedForError = false;
    this.hasStartedVisibleBatch = false;
    this.generation += 1;
    this.surface.setEnabled(true);
    this.setStatus('starting');
    this.scheduleTick(0, this.generation);
  }

  private resetForConfigurationChange(reevaluateAuto = false): void {
    const shouldRestart = this.enabled && !reevaluateAuto;
    this.enabled = false;
    if (reevaluateAuto) this.autoActivated = false;
    this.generation += 1;
    const generation = this.generation;
    this.clearTimer();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.failedIds.clear();
    this.pausedForError = false;
    this.hasStartedVisibleBatch = false;
    this.setCompleted(false);
    this.surface.setEnabled(false);
    this.surface.reset(this.targetLanguage);
    if (shouldRestart) {
      this.enabled = true;
      this.surface.setEnabled(true);
      this.setStatus('starting');
      this.scheduleTick(0, generation);
      return;
    }
    this.setStatus('off');
    if (reevaluateAuto || (this.autoTranslate && !this.manualSuppressed)) {
      this.evaluateAutoTranslation(generation);
    }
  }

  private evaluateAutoTranslation(generation: number): void {
    this.clearAutoTimer();
    if (!this.isAutoEvaluationCurrent(generation)) return;
    const differs = this.surface.languages().some((language) => (
      isValidLanguageTag(language)
      && !languageTagMatchesTranslationLanguage(language, this.targetLanguage)
    ));
    if (differs) {
      this.startTranslation(true);
      return;
    }
    this.autoTimer = window.setTimeout(() => {
      this.autoTimer = null;
      this.evaluateAutoTranslation(generation);
    }, AUTO_EVALUATION_INTERVAL_MS);
  }

  private isAutoEvaluationCurrent(generation: number): boolean {
    return (
      !this.destroyed
      && !this.enabled
      && this.autoTranslate
      && !this.manualSuppressed
      && this.generation === generation
    );
  }

  private scheduleTick(delay: number, generation: number): void {
    this.clearTimer();
    if (!this.isCurrent(generation)) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const runTick = async () => {
        await this.cancellationBarrier;
        await this.tick(generation);
      };
      const result = this.tickQueue.then(
        runTick,
        runTick,
      );
      this.tickQueue = result.then(() => undefined, () => undefined);
    }, delay);
  }

  private async tick(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    try {
      if (this.pausedForError) this.reconcileFailedRecords();
      while (this.isCurrent(generation) && this.activeRequests.size < this.maxConcurrentRequests) {
        const batch = this.nextAvailableBatch();
        if (batch.blocks.length === 0) break;
        this.startRequest(batch, generation);
      }

      if (!this.pausedForError && this.activeRequests.size >= this.maxConcurrentRequests) {
        for (let index = 0; index < this.maxConcurrentRequests; index += 1) {
          if (!await this.preemptForVisibleBatch(generation)) break;
        }
      }

      if (this.activeRequests.size === 0 && this.status === 'starting') {
        this.setStatus(this.completed ? 'on' : 'idle');
      }
    } catch {
      this.failBeforeRequest('provider-error');
      return;
    }
    if (this.isCurrent(generation)) this.scheduleTick(this.pollIntervalMs, generation);
  }

  private nextAvailableBatch(): EpubTranslationBatch {
    const activePrefetchRequests = [...this.activeRequests.values()]
      .filter((request) => request.priority > 0)
      .length;
    if (!this.hasStartedVisibleBatch && !this.pausedForError) {
      const firstVisible = this.surface.nextBatch({
        maxBlocks: FIRST_VISIBLE_MAX_BLOCKS,
        maxChars: FIRST_VISIBLE_MAX_CHARS,
        visibleOnly: true,
      });
      if (firstVisible.blocks.length > 0) {
        this.markBatchStarted(firstVisible);
        return firstVisible;
      }
      if (activePrefetchRequests >= MAX_PREFETCH_REQUESTS) return firstVisible;
    }

    const batch = this.surface.nextBatch({
      maxBlocks: STANDARD_BATCH_MAX_BLOCKS,
      maxChars: STANDARD_BATCH_MAX_CHARS,
      retryOnly: this.pausedForError,
      visibleOnly: !this.pausedForError && activePrefetchRequests >= MAX_PREFETCH_REQUESTS,
    });
    if (batch.blocks.length > 0) this.markBatchStarted(batch);
    return batch;
  }

  private async preemptForVisibleBatch(generation: number): Promise<boolean> {
    const candidates = [...this.activeRequests.values()]
      .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    const batch = this.surface.nextBatch({
      activeBatches: candidates.map(({ ids, requestId }) => ({ ids, requestId })),
      maxBlocks: STANDARD_BATCH_MAX_BLOCKS,
      maxChars: STANDARD_BATCH_MAX_CHARS,
      visibleOnly: true,
    });
    if (!this.isCurrent(generation) || batch.blocks.length === 0) return false;

    const preempted = batch.preemptRequestId
      ? this.activeRequests.get(batch.preemptRequestId)
      : undefined;
    if (preempted) {
      this.activeRequests.delete(preempted.requestId);
      this.surface.release(preempted.ids);
      await this.cancel(preempted.sessionId).catch(() => undefined);
      if (!this.isCurrent(generation)) return false;
    } else if (this.activeRequests.size >= this.maxConcurrentRequests) {
      this.surface.release(batch.blocks.map(({ id }) => id));
      return false;
    }

    this.markBatchStarted(batch);
    this.startRequest(batch, generation);
    return true;
  }

  private startRequest(batch: EpubTranslationBatch, generation: number): void {
    if (!this.isCurrent(generation) || batch.blocks.length === 0) return;
    if (this.status === 'idle') this.setStatus('starting');
    const requestId = nextId('request');
    const activeRequest: ActiveEpubTranslationRequest = {
      generation,
      ids: batch.blocks.map(({ id }) => id),
      priority: Math.max(0, batch.priority ?? 0),
      requestId,
      sequence: this.requestSequence++,
      sessionId: nextId('session'),
    };
    this.activeRequests.set(requestId, activeRequest);
    const response = this.translate({
      sessionId: activeRequest.sessionId,
      requestId,
      targetLanguage: this.targetLanguage,
      contentKind: 'document',
      ...(this.model ? { model: this.model } : {}),
      blocks: batch.blocks,
    });
    void this.finishRequest(activeRequest, response);
  }

  private markBatchStarted(batch: EpubTranslationBatch): void {
    if (batch.priority === 0) this.hasStartedVisibleBatch = true;
  }

  private async finishRequest(
    activeRequest: ActiveEpubTranslationRequest,
    responsePromise: Promise<UrlPageTranslationResponse>,
  ): Promise<void> {
    let response: UrlPageTranslationResponse;
    try {
      response = await responsePromise;
    } catch {
      this.failRequest(activeRequest, 'provider-error');
      return;
    }
    if (!this.isActiveRequest(activeRequest)) return;
    if (response.requestId !== activeRequest.requestId) {
      this.failRequest(activeRequest, 'invalid-response');
      return;
    }
    if (!response.ok) {
      if (response.error === 'cancelled') {
        this.surface.release(activeRequest.ids);
        if (!this.isActiveRequest(activeRequest)) return;
        this.activeRequests.delete(activeRequest.requestId);
        this.scheduleTick(0, activeRequest.generation);
        return;
      }
      this.failRequest(activeRequest, response.error);
      return;
    }

    let insertedCount: number;
    try {
      insertedCount = this.surface.apply(response.translations);
    } catch {
      this.failRequest(activeRequest, 'provider-error');
      return;
    }
    if (!this.isActiveRequest(activeRequest)) return;
    this.activeRequests.delete(activeRequest.requestId);
    if (insertedCount > 0) this.setCompleted(true);
    for (const { id } of response.translations) this.failedIds.delete(id);
    this.pausedForError = this.failedIds.size > 0;
    this.setStatus(
      this.pausedForError
        ? 'error'
        : this.completed
          ? 'on'
          : this.activeRequests.size > 0
            ? 'starting'
            : 'idle',
    );
    this.scheduleTick(this.pausedForError ? this.pollIntervalMs : 0, activeRequest.generation);
  }

  private failRequest(
    activeRequest: ActiveEpubTranslationRequest,
    error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>,
  ): void {
    if (!this.isActiveRequest(activeRequest)) return;
    const failedIds = this.surface.fail(activeRequest.ids);
    if (!this.isActiveRequest(activeRequest)) return;
    this.activeRequests.delete(activeRequest.requestId);
    if (failedIds.length === 0) {
      this.scheduleTick(0, activeRequest.generation);
      return;
    }
    for (const id of failedIds) this.failedIds.add(id);
    this.pauseWithError(error);
  }

  private failBeforeRequest(error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>): void {
    this.enabled = false;
    this.autoActivated = false;
    this.pausedForError = false;
    this.generation += 1;
    this.clearTimer();
    this.cancelAllActiveRequests();
    this.failedIds.clear();
    this.surface.setEnabled(false);
    this.setStatus('off');
    this.options.onError(error);
  }

  private pauseWithError(error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>): void {
    const shouldNotify = !this.pausedForError;
    this.pausedForError = true;
    this.clearTimer();
    this.setStatus('error');
    if (shouldNotify) this.options.onError(error);
    this.scheduleTick(this.pollIntervalMs, this.generation);
  }

  private reconcileFailedRecords(): void {
    const currentFailedIds = this.surface.failedRecordIds();
    this.failedIds.clear();
    for (const id of currentFailedIds) this.failedIds.add(id);
    if (this.failedIds.size > 0) return;
    this.pausedForError = false;
    this.setStatus(this.completed ? 'on' : 'starting');
  }

  private isActiveRequest(activeRequest: ActiveEpubTranslationRequest): boolean {
    return (
      this.isCurrent(activeRequest.generation)
      && this.activeRequests.get(activeRequest.requestId) === activeRequest
    );
  }

  private cancelAllActiveRequests(): void {
    const active = [...this.activeRequests.values()];
    this.activeRequests.clear();
    const previousBarrier = this.cancellationBarrier;
    const cancellations: Array<Promise<unknown>> = [];
    for (const request of active) {
      this.surface.release(request.ids);
      cancellations.push(this.cancel(request.sessionId).catch(() => undefined));
    }
    this.cancellationBarrier = Promise.all([previousBarrier, ...cancellations]).then(() => undefined);
  }

  private isCurrent(generation: number): boolean {
    return !this.destroyed && this.enabled && this.generation === generation;
  }

  private setCompleted(completed: boolean): void {
    if (this.completed === completed) return;
    this.completed = completed;
    this.options.onCompletionChange?.(completed);
  }

  private setStatus(status: UrlPageTranslationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange(status);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  private clearAutoTimer(): void {
    if (this.autoTimer === null) return;
    window.clearTimeout(this.autoTimer);
    this.autoTimer = null;
  }
}

function nextId(kind: 'request' | 'session'): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${kind}:${uuid}`;
  const id = fallbackId++;
  return `${kind}:${Date.now().toString(36)}:${id.toString(36)}`;
}
