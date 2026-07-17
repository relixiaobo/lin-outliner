import {
  isValidLanguageTag,
  languageTagMatchesTranslationLanguage,
  type TranslationLanguage,
} from '../../../core/translationLanguage';
import type {
  UrlPageTranslationBlock,
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
import {
  PREFETCH_TRANSLATION_BATCH_LIMITS,
  PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS,
  PreviewTranslationLatencyTracker,
  VISIBLE_TRANSLATION_BATCH_LIMITS,
} from './previewTranslationScheduling';
import { previewTranslationCacheResponsePlan } from './previewTranslationCache';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const AUTO_EVALUATION_INTERVAL_MS = 1_000;

let fallbackId = 1;

export interface EpubTranslationControllerOptions {
  autoTranslate?: boolean;
  cacheSourceId?: string;
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
  blocks: UrlPageTranslationBlock[];
  generation: number;
  ids: string[];
  priority: number;
  requestId: string;
  sequence: number;
  sessionId: string;
  startedAt: number;
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
  private blockedForConfiguration = false;
  private cacheSourceId: string | undefined;
  private currentConcurrencyLimit: number;
  private readonly latency = new PreviewTranslationLatencyTracker();
  private readonly maxConcurrentRequests: number;
  private manualSuppressed = false;
  private model: string | null;
  private readonly pollIntervalMs: number;
  private requestSequence = 0;
  private status: UrlPageTranslationStatus = 'off';
  private targetLanguage: TranslationLanguage;
  private timer: number | null = null;
  private tickQueue: Promise<void> = Promise.resolve();
  private workSignalPending = false;
  private readonly translate: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;

  constructor(
    private readonly surface: EpubTranslationSurface,
    private readonly options: EpubTranslationControllerOptions,
  ) {
    this.autoTranslate = options.autoTranslate ?? false;
    this.cacheSourceId = options.cacheSourceId;
    this.cancel = options.cancel ?? api.cancelUrlPageTranslation;
    this.maxConcurrentRequests = Math.min(
      PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS,
      Math.max(1, Math.floor(options.maxConcurrentRequests ?? PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS)),
    );
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.model = options.model ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.targetLanguage = options.targetLanguage;
    this.translate = options.translate ?? api.translateUrlPageBlocks;
    this.surface.reset(this.targetLanguage);
    this.surface.setWorkAvailableHandler(() => {
      this.workSignalPending = true;
      this.scheduleTick(0, this.generation);
    });
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
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.generation += 1;
    this.workSignalPending = false;
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

  setCacheSourceId(cacheSourceId: string | undefined): void {
    if (this.destroyed || this.cacheSourceId === cacheSourceId) return;
    this.cacheSourceId = cacheSourceId;
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
    this.workSignalPending = false;
    this.clearTimer();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.surface.setWorkAvailableHandler(() => undefined);
    this.surface.setEnabled(false);
  }

  private startTranslation(automatic: boolean): void {
    if (this.destroyed || this.enabled) return;
    this.clearAutoTimer();
    this.autoActivated = automatic;
    this.enabled = true;
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.generation += 1;
    this.workSignalPending = false;
    this.surface.setEnabled(true);
    this.setStatus('starting');
    this.scheduleTick(0, this.generation);
  }

  private resetForConfigurationChange(reevaluateAuto = false): void {
    const shouldRestart = this.enabled && !reevaluateAuto;
    this.enabled = false;
    if (reevaluateAuto) this.autoActivated = false;
    this.generation += 1;
    this.workSignalPending = false;
    const generation = this.generation;
    this.clearTimer();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.failedIds.clear();
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
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
    this.workSignalPending = false;
    try {
      this.reconcileCompletedRecords();
      this.reconcileFailedRecords();
      if (this.blockedForConfiguration) {
        const retry = this.surface.nextBatch({
          ...VISIBLE_TRANSLATION_BATCH_LIMITS,
          estimatedLatencyMs: this.latency.estimateMs,
          retryOnly: true,
        });
        if (retry.blocks.length > 0) {
          if (this.failedIds.size === 0 && this.status === 'error') {
            this.setStatus(this.completed ? 'on' : 'starting');
          }
          this.startRequest(retry, generation);
        }
      }
      let queueVisible = true;
      while (
        this.isCurrent(generation)
        && !this.blockedForConfiguration
        && this.activeRequests.size < this.currentConcurrencyLimit
      ) {
        const batch = this.nextAvailableBatch(queueVisible);
        queueVisible = false;
        if (batch.blocks.length === 0) break;
        this.startRequest(batch, generation);
      }

      if (!this.blockedForConfiguration && this.activeRequests.size >= this.currentConcurrencyLimit) {
        for (let index = 0; index < this.currentConcurrencyLimit; index += 1) {
          const preempted = await this.preemptForVisibleBatch(generation, queueVisible);
          queueVisible = false;
          if (!preempted) break;
        }
      }

      if (this.activeRequests.size === 0 && this.status === 'starting') {
        this.setStatus(this.completed ? 'on' : 'idle');
      }
    } catch {
      this.failBeforeRequest('provider-error');
      return;
    }
    if (this.isCurrent(generation)) {
      this.scheduleTick(this.workSignalPending ? 0 : this.pollIntervalMs, generation);
    }
  }

  private nextAvailableBatch(queueVisible: boolean): EpubTranslationBatch {
    const visible = this.surface.nextBatch({
      ...VISIBLE_TRANSLATION_BATCH_LIMITS,
      estimatedLatencyMs: this.latency.estimateMs,
      queueVisible,
      visibleOnly: true,
    });
    if (visible.blocks.length > 0) return visible;
    return this.surface.nextBatch({
      ...PREFETCH_TRANSLATION_BATCH_LIMITS,
      estimatedLatencyMs: this.latency.estimateMs,
    });
  }

  private async preemptForVisibleBatch(generation: number, queueVisible: boolean): Promise<boolean> {
    const candidates = [...this.activeRequests.values()]
      .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    const batch = this.surface.nextBatch({
      activeBatches: candidates.map(({ ids, requestId }) => ({ ids, requestId })),
      ...VISIBLE_TRANSLATION_BATCH_LIMITS,
      estimatedLatencyMs: this.latency.estimateMs,
      queueVisible,
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
    } else if (this.activeRequests.size >= this.currentConcurrencyLimit) {
      this.surface.release(batch.blocks.map(({ id }) => id));
      return false;
    }

    this.startRequest(batch, generation);
    return true;
  }

  private startRequest(batch: EpubTranslationBatch, generation: number): void {
    if (!this.isCurrent(generation) || batch.blocks.length === 0) return;
    if (this.status === 'idle') this.setStatus('starting');
    const requestId = nextId('request');
    const activeRequest: ActiveEpubTranslationRequest = {
      blocks: [...batch.blocks],
      generation,
      ids: batch.blocks.map(({ id }) => id),
      priority: Math.max(0, batch.priority ?? 0),
      requestId,
      sequence: this.requestSequence++,
      sessionId: nextId('session'),
      startedAt: Date.now(),
    };
    this.activeRequests.set(requestId, activeRequest);
    const response = this.translate(this.translationRequest(activeRequest));
    void this.finishRequest(activeRequest, response);
  }

  private translationRequest(activeRequest: ActiveEpubTranslationRequest): UrlPageTranslationRequest {
    const cacheSourceId = this.cacheSourceId
      && activeRequest.blocks.every((block) => Boolean(block.cacheKey))
      ? this.cacheSourceId
      : undefined;
    return {
      sessionId: activeRequest.sessionId,
      requestId: activeRequest.requestId,
      targetLanguage: this.targetLanguage,
      contentKind: 'document',
      ...(this.model ? { model: this.model } : {}),
      ...(cacheSourceId ? { cacheSourceId } : {}),
      blocks: activeRequest.blocks,
    };
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

    const cachePlan = response.cacheHit
      ? previewTranslationCacheResponsePlan(response, activeRequest.blocks)
      : null;
    if ((response.cacheHit && !cachePlan) || (!response.cacheHit && response.remainingBlockIds)) {
      this.failRequest(activeRequest, 'invalid-response');
      return;
    }
    if (!response.cacheHit) this.latency.record(Date.now() - activeRequest.startedAt);

    try {
      this.surface.apply(response.translations);
    } catch {
      this.failRequest(activeRequest, 'provider-error');
      return;
    }
    if (!this.isActiveRequest(activeRequest)) return;
    if (cachePlan && cachePlan.remainingBlocks.length > 0) {
      this.reconcileCompletedRecords();
      for (const { id } of response.translations) this.failedIds.delete(id);
      activeRequest.blocks = cachePlan.remainingBlocks;
      activeRequest.ids = cachePlan.remainingBlocks.map((block) => block.id);
      activeRequest.startedAt = Date.now();
      this.setStatus(this.failedIds.size > 0 ? 'error' : 'starting');
      void this.finishRequest(activeRequest, this.translate(this.translationRequest(activeRequest)));
      return;
    }
    this.activeRequests.delete(activeRequest.requestId);
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.reconcileCompletedRecords();
    for (const { id } of response.translations) this.failedIds.delete(id);
    this.setStatus(
      this.failedIds.size > 0
        ? 'error'
        : this.completed
          ? 'on'
          : this.activeRequests.size > 0
            ? 'starting'
            : 'idle',
    );
    this.scheduleTick(0, activeRequest.generation);
  }

  private failRequest(
    activeRequest: ActiveEpubTranslationRequest,
    error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>,
  ): void {
    if (!this.isActiveRequest(activeRequest)) return;
    const shouldNotify = this.failedIds.size === 0;
    const failedIds = this.surface.fail(activeRequest.ids);
    this.reconcileCompletedRecords();
    if (!this.isActiveRequest(activeRequest)) return;
    this.activeRequests.delete(activeRequest.requestId);
    for (const id of failedIds) this.failedIds.add(id);
    if (error === 'not-configured') {
      this.blockedForConfiguration = true;
      this.cancelOtherRequests();
      this.setStatus('error');
      if (shouldNotify) this.options.onError(error);
      this.scheduleTick(0, activeRequest.generation);
      return;
    }
    if (failedIds.length === 0) {
      this.scheduleTick(0, activeRequest.generation);
      return;
    }
    this.currentConcurrencyLimit = 1;
    this.setStatus('error');
    if (shouldNotify) this.options.onError(error);
    this.scheduleTick(this.pollIntervalMs, activeRequest.generation);
  }

  private failBeforeRequest(error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>): void {
    this.enabled = false;
    this.autoActivated = false;
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.generation += 1;
    this.clearTimer();
    this.cancelAllActiveRequests();
    this.failedIds.clear();
    this.surface.setEnabled(false);
    this.setStatus('off');
    this.options.onError(error);
  }

  private reconcileFailedRecords(): void {
    const currentFailedIds = this.surface.failedRecordIds();
    this.failedIds.clear();
    for (const id of currentFailedIds) this.failedIds.add(id);
    if (this.failedIds.size === 0 && this.status === 'error' && !this.blockedForConfiguration) {
      this.setStatus(this.completed ? 'on' : this.activeRequests.size > 0 ? 'starting' : 'idle');
    }
  }

  private reconcileCompletedRecords(): void {
    this.setCompleted(this.surface.completedRecordCount() > 0);
  }

  private cancelOtherRequests(): void {
    for (const request of [...this.activeRequests.values()]) {
      this.activeRequests.delete(request.requestId);
      this.surface.release(request.ids);
      void this.cancel(request.sessionId).catch(() => undefined);
    }
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
