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
import {
  createUrlPageTranslationGuestBridge,
  type UrlPageTranslationGuestBatch,
  type UrlPageTranslationGuestLabels,
  type UrlPageTranslationGuestBridge,
} from './urlPageTranslationGuest';
import {
  PREFETCH_TRANSLATION_BATCH_LIMITS,
  PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS,
  PreviewTranslationLatencyTracker,
  VISIBLE_TRANSLATION_BATCH_LIMITS,
} from './previewTranslationScheduling';
import {
  previewTranslationCacheResponsePlan,
  previewTranslationCacheSourceId,
} from './previewTranslationCache';

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const FIRST_CAPTION_MAX_BLOCKS = 6;
const FIRST_CAPTION_MAX_CHARS = 1_500;
const STANDARD_CAPTION_MAX_BLOCKS = 16;
const STANDARD_CAPTION_MAX_CHARS = 4_000;
const AUTO_EVALUATION_INTERVAL_MS = 1_000;
const DEFAULT_GUEST_LABELS: UrlPageTranslationGuestLabels = {
  retry: 'Retry translation',
  translating: 'Translating',
};

let fallbackId = 1;

export type UrlPageTranslationStatus = 'error' | 'idle' | 'off' | 'on' | 'starting';

interface UrlPageTranslationControllerOptions {
  autoTranslate?: boolean;
  model?: string | null;
  targetLanguage: TranslationLanguage;
  onCompletionChange?: (completed: boolean) => void;
  onError: (error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>) => void;
  onStatusChange: (status: UrlPageTranslationStatus) => void;
  labels?: UrlPageTranslationGuestLabels;
  guest?: UrlPageTranslationGuestBridge;
  maxConcurrentRequests?: number;
  pollIntervalMs?: number;
  translate?: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;
  cancel?: (sessionId: string) => Promise<unknown>;
}

interface ActivePageTranslationRequest {
  blocks: UrlPageTranslationBlock[];
  cacheSourceId?: string;
  captionRevision: number;
  contentKind: 'caption' | 'page';
  generation: number;
  ids: string[];
  priority: number;
  requestId: string;
  sequence: number;
  sessionId: string;
  startedAt: number;
}

interface FailedPageTranslationBlock {
  captionRevision: number;
  contentKind: 'caption' | 'page';
}

export class UrlPageTranslationController {
  private readonly guest: UrlPageTranslationGuestBridge;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrentRequests: number;
  private readonly translate: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;
  private readonly cancel: (sessionId: string) => Promise<unknown>;
  private autoActivated = false;
  private autoTimer: number | null = null;
  private readonly activeRequests = new Map<string, ActivePageTranslationRequest>();
  private autoTranslate: boolean;
  private destroyed = false;
  private domReady = false;
  private enabled = false;
  private readonly failedIds = new Map<string, FailedPageTranslationBlock>();
  private generation = 0;
  private blockedForConfiguration = false;
  private currentConcurrencyLimit: number;
  private guestQueue: Promise<void> = Promise.resolve();
  private completedCaptionRevision: number | null = null;
  private hasCompletedPageTranslation = false;
  private hasStartedCaptionBatch = false;
  private initialized = false;
  private readonly latency = new PreviewTranslationLatencyTracker();
  private lastReportedCompletion = false;
  private manualSuppressed = false;
  private model: string | null;
  private pageIdentity: string;
  private pendingFailureUpdates = 0;
  private observedCaptionRevision: number | null = null;
  private observedWorkRevision = 0;
  private requestSequence = 0;
  private status: UrlPageTranslationStatus = 'off';
  private targetLanguage: TranslationLanguage;
  private timer: number | null = null;
  private tickQueue: Promise<void> = Promise.resolve();
  private workWatchPending = false;
  private workWatchToken = 0;

  constructor(
    private readonly webview: Electron.WebviewTag,
    private readonly options: UrlPageTranslationControllerOptions,
  ) {
    this.guest = options.guest ?? createUrlPageTranslationGuestBridge(webview);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrentRequests = Math.min(
      PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS,
      Math.max(1, Math.floor(options.maxConcurrentRequests ?? PREVIEW_TRANSLATION_MAX_CONCURRENT_REQUESTS)),
    );
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.translate = options.translate ?? api.translateUrlPageBlocks;
    this.cancel = options.cancel ?? api.cancelUrlPageTranslation;
    this.autoTranslate = options.autoTranslate ?? false;
    this.model = options.model ?? null;
    this.targetLanguage = options.targetLanguage;
    this.pageIdentity = urlPageIdentity(readWebviewUrl(webview));
    this.domReady = webviewIsReady(webview);
    webview.addEventListener('did-start-navigation', this.handleDidStartNavigation);
    webview.addEventListener('did-navigate-in-page', this.handleDidNavigateInPage);
    webview.addEventListener('dom-ready', this.handleDomReady);
    if (this.autoTranslate && this.domReady) void this.evaluateAutoTranslation(this.generation);
  }

  get currentStatus(): UrlPageTranslationStatus {
    return this.status;
  }

  get hasCompletedTranslations(): boolean {
    return this.hasCompletedPageTranslation || (
      this.completedCaptionRevision !== null
      && this.completedCaptionRevision === this.observedCaptionRevision
    );
  }

  toggle(): void {
    if (this.status === 'off') this.enable();
    else this.disable();
  }

  enable(): void {
    this.manualSuppressed = false;
    this.clearAutoTimer();
    this.startTranslation(false);
  }

  setAutoTranslate(autoTranslate: boolean): void {
    if (this.destroyed || this.autoTranslate === autoTranslate) return;
    this.autoTranslate = autoTranslate;
    if (!autoTranslate) {
      this.autoActivated = false;
      this.clearAutoTimer();
      if (!this.enabled) {
        this.initialized = false;
        void this.runGuest(() => this.guest.destroy()).catch(() => undefined);
      }
      return;
    }
    this.manualSuppressed = false;
    if (this.domReady && !this.enabled) void this.evaluateAutoTranslation(this.generation);
  }

  setTranslationModel(model: string | null): void {
    if (this.destroyed || this.model === model) return;
    this.model = model;
    this.resetForConfigurationChange();
  }

  private startTranslation(automatic: boolean): void {
    if (this.destroyed || this.enabled) return;
    this.clearAutoTimer();
    this.autoActivated = automatic;
    this.enabled = true;
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.hasStartedCaptionBatch = false;
    this.generation += 1;
    this.setStatus('starting');
    if (this.domReady) void this.startGuest(this.generation);
  }

  setTargetLanguage(targetLanguage: TranslationLanguage): void {
    if (this.destroyed || this.targetLanguage === targetLanguage) return;
    const reevaluateAuto = this.enabled && this.autoActivated && this.autoTranslate;
    this.targetLanguage = targetLanguage;
    this.resetForConfigurationChange(reevaluateAuto);
  }

  private resetForConfigurationChange(reevaluateAuto = false): void {
    const shouldRestart = this.enabled && !reevaluateAuto;
    if (reevaluateAuto) {
      this.enabled = false;
      this.autoActivated = false;
    }
    this.generation += 1;
    const generation = this.generation;
    this.clearTimer();
    this.clearWorkWatcher();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.initialized = false;
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.hasStartedCaptionBatch = false;
    this.failedIds.clear();
    this.resetCompletionState();
    const resetGuest = this.runGuest(() => this.guest.destroy()).catch(() => undefined);
    if (!shouldRestart) {
      if (reevaluateAuto) this.setStatus('off');
      void resetGuest.then(() => {
        if (this.autoTranslate && !this.manualSuppressed && this.domReady) {
          void this.evaluateAutoTranslation(generation);
        }
      });
      return;
    }
    this.setStatus('starting');
    void resetGuest.then(() => {
      if (this.domReady && this.isCurrent(generation)) void this.startGuest(generation);
    });
  }

  disable(): void {
    if (this.destroyed) return;
    this.manualSuppressed = true;
    this.autoActivated = false;
    this.enabled = false;
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.generation += 1;
    this.clearTimer();
    this.clearWorkWatcher();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    if (this.initialized) {
      void this.runGuest(() => this.guest.setEnabled(false, this.targetLanguage)).catch(() => undefined);
    }
    this.failedIds.clear();
    this.setStatus('off');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.enabled = false;
    this.autoActivated = false;
    this.generation += 1;
    this.clearTimer();
    this.clearWorkWatcher();
    this.clearAutoTimer();
    this.webview.removeEventListener('did-start-navigation', this.handleDidStartNavigation);
    this.webview.removeEventListener('did-navigate-in-page', this.handleDidNavigateInPage);
    this.webview.removeEventListener('dom-ready', this.handleDomReady);
    this.cancelAllActiveRequests();
    void this.runGuest(() => this.guest.destroy()).catch(() => undefined);
  }

  private readonly handleDomReady = () => {
    if (this.destroyed) return;
    this.domReady = true;
    if (this.enabled) void this.startGuest(this.generation);
    else if (this.autoTranslate && !this.manualSuppressed) {
      void this.evaluateAutoTranslation(this.generation);
    }
  };

  private readonly handleDidStartNavigation = (event: Electron.DidStartNavigationEvent) => {
    if (!event.isMainFrame) return;
    if (event.isInPlace) {
      this.restartForInPageNavigation(event.url);
      return;
    }
    if (this.destroyed) return;
    this.pageIdentity = urlPageIdentity(event.url);
    this.domReady = false;
    this.enabled = false;
    this.autoActivated = false;
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.initialized = false;
    this.cancelAllActiveRequests();
    this.hasStartedCaptionBatch = false;
    this.manualSuppressed = false;
    this.failedIds.clear();
    this.resetCompletionState();
    this.generation += 1;
    this.clearTimer();
    this.clearWorkWatcher();
    this.clearAutoTimer();
    void this.runGuest(() => this.guest.destroy()).catch(() => undefined);
    this.setStatus('off');
  };

  private readonly handleDidNavigateInPage = (event: Electron.DidNavigateInPageEvent) => {
    if (!event.isMainFrame) return;
    this.restartForInPageNavigation(event.url);
  };

  private restartForInPageNavigation(url: string): void {
    if (this.destroyed) return;
    const identity = urlPageIdentity(url);
    if (!identity || identity === this.pageIdentity) return;
    this.pageIdentity = identity;
    const shouldRestart = this.enabled && !this.autoActivated;
    const shouldReevaluateAuto = this.autoTranslate && (this.autoActivated || !this.enabled);
    this.enabled = false;
    this.autoActivated = false;
    this.manualSuppressed = false;
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.initialized = false;
    this.generation += 1;
    const generation = this.generation;
    this.clearTimer();
    this.clearWorkWatcher();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.hasStartedCaptionBatch = false;
    this.failedIds.clear();
    this.resetCompletionState();
    const resetGuest = this.runGuest(() => this.guest.destroy()).catch(() => undefined);
    if (shouldRestart) {
      this.enabled = true;
      this.setStatus('starting');
      void resetGuest.then(() => {
        if (this.domReady && this.isCurrent(generation)) void this.startGuest(generation);
      });
      return;
    }
    this.setStatus('off');
    if (shouldReevaluateAuto) {
      void resetGuest.then(() => {
        if (this.domReady) void this.evaluateAutoTranslation(generation);
      });
    }
  }

  private async evaluateAutoTranslation(generation: number): Promise<void> {
    if (!this.isAutoEvaluationCurrent(generation)) return;
    try {
      if (!this.initialized) {
        await this.runGuest(() => (
          this.guest.initialize(this.targetLanguage, this.options.labels ?? DEFAULT_GUEST_LABELS)
        ));
        if (!this.isAutoEvaluationCurrent(generation)) return;
        this.initialized = true;
      }
      const [declaredLanguage, captionLanguage] = await Promise.all([
        this.runGuest(() => this.guest.documentLanguage()),
        this.guest.captionLanguage
          ? this.runGuest(() => this.guest.captionLanguage!())
          : Promise.resolve(null),
      ]);
      if (!this.isAutoEvaluationCurrent(generation)) return;
      const pageDiffers = isValidLanguageTag(declaredLanguage)
        && !languageTagMatchesTranslationLanguage(declaredLanguage, this.targetLanguage);
      const captionDiffers = isValidLanguageTag(captionLanguage)
        && !languageTagMatchesTranslationLanguage(captionLanguage, this.targetLanguage);
      if (pageDiffers || captionDiffers) {
        this.startTranslation(true);
        return;
      }
    } catch {
      // Missing or unreadable document metadata leaves automatic translation idle.
    }
    this.scheduleAutoEvaluation(generation);
  }

  private isAutoEvaluationCurrent(generation: number): boolean {
    return (
      !this.destroyed
      && this.domReady
      && !this.enabled
      && this.autoTranslate
      && !this.manualSuppressed
      && this.generation === generation
    );
  }

  private async startGuest(generation: number): Promise<void> {
    try {
      if (!this.initialized) {
        await this.runGuest(() => (
          this.guest.initialize(this.targetLanguage, this.options.labels ?? DEFAULT_GUEST_LABELS)
        ));
        if (!this.isCurrent(generation)) return;
        this.initialized = true;
      }
      await this.runGuest(() => this.guest.setEnabled(true, this.targetLanguage));
      if (!this.isCurrent(generation)) return;
      this.scheduleTick(0, generation);
    } catch {
      if (!this.isCurrent(generation)) return;
      this.failBeforeRequest('provider-error');
    }
  }

  private scheduleTick(delay: number, generation: number): void {
    this.clearTimer();
    if (!this.isCurrent(generation)) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      const result = this.tickQueue.then(
        () => this.tick(generation),
        () => this.tick(generation),
      );
      this.tickQueue = result.then(() => undefined, () => undefined);
    }, delay);
  }

  private async tick(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    try {
      if (this.blockedForConfiguration) {
        const retry = await this.runGuest(() => this.guest.nextBatch({
          captionMaxBlocks: STANDARD_CAPTION_MAX_BLOCKS,
          captionMaxChars: STANDARD_CAPTION_MAX_CHARS,
          ...VISIBLE_TRANSLATION_BATCH_LIMITS,
          estimatedLatencyMs: this.latency.estimateMs,
          retryOnly: true,
        }));
        this.observeGuestBatch(retry, generation);
        if (retry.blocks.length > 0) {
          this.startRequest(retry, generation);
        }
      }
      let queueVisible = true;
      while (
        this.isCurrent(generation)
        && !this.blockedForConfiguration
        && this.activeRequests.size < this.currentConcurrencyLimit
      ) {
        const batch = await this.nextAvailableBatch(generation, queueVisible);
        queueVisible = false;
        if (!this.isCurrent(generation)) return;
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
        this.setStatus(this.hasCompletedTranslations ? 'on' : 'idle');
      }
    } catch {
      if (!this.isCurrent(generation)) return;
      this.failBeforeRequest('provider-error');
    }
    if (this.isCurrent(generation)) this.ensureWorkWatcher(generation);
  }

  private async nextAvailableBatch(
    generation: number,
    queueVisible: boolean,
  ): Promise<UrlPageTranslationGuestBatch> {
    const visible = await this.runGuest(() => this.guest.nextBatch({
      captionMaxBlocks: this.hasStartedCaptionBatch
        ? STANDARD_CAPTION_MAX_BLOCKS
        : FIRST_CAPTION_MAX_BLOCKS,
      captionMaxChars: this.hasStartedCaptionBatch
        ? STANDARD_CAPTION_MAX_CHARS
        : FIRST_CAPTION_MAX_CHARS,
      ...VISIBLE_TRANSLATION_BATCH_LIMITS,
      estimatedLatencyMs: this.latency.estimateMs,
      queueVisible,
      visibleOnly: true,
    }));
    this.observeGuestBatch(visible, generation);
    if (visible.blocks.length > 0) {
      this.markBatchStarted(visible);
      return visible;
    }
    const prefetch = await this.runGuest(() => this.guest.nextBatch({
      captionMaxBlocks: this.hasStartedCaptionBatch
        ? STANDARD_CAPTION_MAX_BLOCKS
        : FIRST_CAPTION_MAX_BLOCKS,
      captionMaxChars: this.hasStartedCaptionBatch
        ? STANDARD_CAPTION_MAX_CHARS
        : FIRST_CAPTION_MAX_CHARS,
      ...PREFETCH_TRANSLATION_BATCH_LIMITS,
      estimatedLatencyMs: this.latency.estimateMs,
    }));
    this.observeGuestBatch(prefetch, generation);
    if (prefetch.blocks.length > 0) this.markBatchStarted(prefetch);
    return prefetch;
  }

  private async preemptForVisibleBatch(generation: number, queueVisible: boolean): Promise<boolean> {
    const candidates = [...this.activeRequests.values()]
      .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    const batch = await this.runGuest(() => this.guest.nextBatch({
      activeBatches: candidates.map((request) => ({
        ids: request.ids,
        requestId: request.requestId,
      })),
      ...VISIBLE_TRANSLATION_BATCH_LIMITS,
      estimatedLatencyMs: this.latency.estimateMs,
      queueVisible,
      captionMaxBlocks: this.hasStartedCaptionBatch
        ? STANDARD_CAPTION_MAX_BLOCKS
        : FIRST_CAPTION_MAX_BLOCKS,
      captionMaxChars: this.hasStartedCaptionBatch
        ? STANDARD_CAPTION_MAX_CHARS
        : FIRST_CAPTION_MAX_CHARS,
      visibleOnly: true,
    }));
    this.observeGuestBatch(batch, generation);
    if (!this.isCurrent(generation) || batch.blocks.length === 0) return false;

    const preempted = batch.preemptRequestId
      ? this.activeRequests.get(batch.preemptRequestId)
      : undefined;
    if (preempted) {
      this.activeRequests.delete(preempted.requestId);
      await Promise.all([
        this.runGuest(() => this.guest.release(preempted.ids)).catch(() => undefined),
        this.cancel(preempted.sessionId).catch(() => undefined),
      ]);
      if (!this.isCurrent(generation)) return false;
    } else if (this.activeRequests.size >= this.currentConcurrencyLimit) {
      await this.runGuest(() => this.guest.release(batch.blocks.map((block) => block.id)))
        .catch(() => undefined);
      return false;
    }

    this.markBatchStarted(batch);
    this.startRequest(batch, generation);
    return true;
  }

  private startRequest(batch: UrlPageTranslationGuestBatch, generation: number): void {
    if (!this.isCurrent(generation) || batch.blocks.length === 0) return;
    if (this.status === 'idle') this.setStatus('starting');
    const requestId = nextId('request');
    const cacheSourceId = this.pageIdentity && batch.blocks.every((block) => Boolean(block.cacheKey))
      ? previewTranslationCacheSourceId('url', [this.pageIdentity])
      : undefined;
    const activeRequest: ActivePageTranslationRequest = {
      blocks: [...batch.blocks],
      ...(cacheSourceId ? { cacheSourceId } : {}),
      captionRevision: batch.captionRevision,
      contentKind: batch.contentKind ?? 'page',
      generation,
      ids: batch.blocks.map((block) => block.id),
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

  private translationRequest(activeRequest: ActivePageTranslationRequest): UrlPageTranslationRequest {
    return {
      sessionId: activeRequest.sessionId,
      requestId: activeRequest.requestId,
      targetLanguage: this.targetLanguage,
      contentKind: activeRequest.contentKind,
      ...(this.model ? { model: this.model } : {}),
      ...(activeRequest.cacheSourceId ? { cacheSourceId: activeRequest.cacheSourceId } : {}),
      blocks: activeRequest.blocks,
    };
  }

  private markBatchStarted(batch: UrlPageTranslationGuestBatch): void {
    if ((batch.contentKind ?? 'page') === 'caption') this.hasStartedCaptionBatch = true;
  }

  private async finishRequest(
    activeRequest: ActivePageTranslationRequest,
    responsePromise: Promise<UrlPageTranslationResponse>,
  ): Promise<void> {
    let response: UrlPageTranslationResponse;
    try {
      response = await responsePromise;
    } catch {
      await this.failRequest(activeRequest, 'provider-error');
      return;
    }
    if (!this.isActiveRequest(activeRequest)) return;

    if (response.requestId !== activeRequest.requestId) {
      await this.failRequest(activeRequest, 'invalid-response');
      return;
    }
    if (!response.ok) {
      if (response.error === 'cancelled') {
        await this.runGuest(() => this.guest.release(activeRequest.ids)).catch(() => undefined);
        if (!this.isActiveRequest(activeRequest)) return;
        this.activeRequests.delete(activeRequest.requestId);
        this.scheduleTick(0, activeRequest.generation);
        return;
      }
      await this.failRequest(activeRequest, response.error);
      return;
    }

    const cachePlan = response.cacheHit
      ? previewTranslationCacheResponsePlan(response, activeRequest.blocks)
      : null;
    if ((response.cacheHit && !cachePlan) || (!response.cacheHit && response.remainingBlockIds)) {
      await this.failRequest(activeRequest, 'invalid-response');
      return;
    }
    if (!response.cacheHit) this.latency.record(Date.now() - activeRequest.startedAt);

    let insertedCount: number;
    try {
      insertedCount = await this.runGuest(() => this.guest.apply(response.translations));
    } catch {
      await this.failRequest(activeRequest, 'provider-error');
      return;
    }
    if (!this.isActiveRequest(activeRequest)) return;
    if (cachePlan && cachePlan.remainingBlocks.length > 0) {
      if (insertedCount > 0) this.markRequestCompleted(activeRequest);
      for (const translation of response.translations) this.failedIds.delete(translation.id);
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
    if (insertedCount > 0) this.markRequestCompleted(activeRequest);
    for (const translation of response.translations) this.failedIds.delete(translation.id);
    this.setStatus(
      this.failedIds.size > 0
        ? 'error'
        : this.hasCompletedTranslations
          ? 'on'
          : this.activeRequests.size > 0
            ? 'starting'
            : 'idle',
    );
    this.scheduleTick(0, activeRequest.generation);
  }

  private async failRequest(
    activeRequest: ActivePageTranslationRequest,
    error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>,
  ): Promise<void> {
    if (!this.isActiveRequest(activeRequest)) return;
    const shouldNotify = this.failedIds.size === 0;
    this.trackFailed(activeRequest);
    this.pendingFailureUpdates += 1;
    try {
      await this.runGuest(() => this.guest.fail(activeRequest.ids)).catch(() => undefined);
    } finally {
      this.pendingFailureUpdates -= 1;
    }
    if (!this.isActiveRequest(activeRequest)) return;
    this.activeRequests.delete(activeRequest.requestId);
    if (error === 'not-configured') {
      this.blockedForConfiguration = true;
      this.cancelOtherRequests();
    } else {
      this.currentConcurrencyLimit = 1;
    }
    this.setStatus('error');
    if (shouldNotify) this.options.onError(error);
    this.scheduleTick(error === 'not-configured' ? 0 : this.pollIntervalMs, activeRequest.generation);
  }

  private isActiveRequest(activeRequest: ActivePageTranslationRequest): boolean {
    return (
      this.isCurrent(activeRequest.generation)
      && this.activeRequests.get(activeRequest.requestId) === activeRequest
    );
  }

  private failBeforeRequest(error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>): void {
    this.enabled = false;
    this.autoActivated = false;
    this.blockedForConfiguration = false;
    this.currentConcurrencyLimit = this.maxConcurrentRequests;
    this.generation += 1;
    this.clearTimer();
    this.clearWorkWatcher();
    this.cancelAllActiveRequests();
    this.failedIds.clear();
    if (this.initialized) {
      void this.runGuest(() => this.guest.setEnabled(false, this.targetLanguage)).catch(() => undefined);
    }
    this.setStatus('off');
    this.options.onError(error);
  }

  private cancelAllActiveRequests(): void {
    const sessionIds = new Set(
      [...this.activeRequests.values()].map((request) => request.sessionId),
    );
    this.activeRequests.clear();
    for (const sessionId of sessionIds) {
      void this.cancel(sessionId).catch(() => undefined);
    }
  }

  private cancelOtherRequests(): void {
    for (const request of [...this.activeRequests.values()]) {
      this.activeRequests.delete(request.requestId);
      void Promise.all([
        this.runGuest(() => this.guest.release(request.ids)).catch(() => undefined),
        this.cancel(request.sessionId).catch(() => undefined),
      ]);
    }
  }

  private observeGuestBatch(batch: UrlPageTranslationGuestBatch, generation: number): void {
    if (!this.isCurrent(generation)) return;
    if (Number.isSafeInteger(batch.workRevision) && batch.workRevision >= 0) {
      this.observedWorkRevision = batch.workRevision;
    }
    if (
      !batch.hasActiveFailures
      && this.pendingFailureUpdates === 0
      && (
        this.failedIds.size > 0
        || this.blockedForConfiguration
        || this.currentConcurrencyLimit < this.maxConcurrentRequests
      )
    ) {
      this.failedIds.clear();
      if (
        !this.blockedForConfiguration
        && batch.blocks.length === 0
        && this.activeRequests.size === 0
      ) {
        this.currentConcurrencyLimit = this.maxConcurrentRequests;
      }
      this.setStatus(this.statusForObservedBatch(batch));
    }
    if (this.observedCaptionRevision === batch.captionRevision) return;
    const previousRevision = this.observedCaptionRevision;
    this.observedCaptionRevision = batch.captionRevision;
    if (previousRevision === null) return;

    this.completedCaptionRevision = null;
    this.hasStartedCaptionBatch = false;
    for (const request of [...this.activeRequests.values()]) {
      if (request.contentKind !== 'caption' || request.captionRevision === batch.captionRevision) continue;
      this.activeRequests.delete(request.requestId);
      void this.cancel(request.sessionId).catch(() => undefined);
    }
    for (const [id, failure] of this.failedIds) {
      if (
        failure.contentKind === 'caption'
        && failure.captionRevision !== batch.captionRevision
      ) this.failedIds.delete(id);
    }
    this.emitCompletionChange();
    this.setStatus(this.statusForObservedBatch(batch));
  }

  private statusForObservedBatch(batch: UrlPageTranslationGuestBatch): UrlPageTranslationStatus {
    if (
      this.failedIds.size > 0
      || (
        this.blockedForConfiguration
        && batch.blocks.length === 0
        && this.activeRequests.size === 0
      )
    ) return 'error';
    if (this.hasCompletedTranslations) return 'on';
    return batch.blocks.length > 0 || this.activeRequests.size > 0 ? 'starting' : 'idle';
  }

  private markRequestCompleted(request: ActivePageTranslationRequest): void {
    if (request.contentKind === 'page') {
      this.hasCompletedPageTranslation = true;
    } else if (request.captionRevision === this.observedCaptionRevision) {
      this.completedCaptionRevision = request.captionRevision;
    }
    this.emitCompletionChange();
  }

  private resetCompletionState(): void {
    this.hasCompletedPageTranslation = false;
    this.completedCaptionRevision = null;
    this.observedCaptionRevision = null;
    this.emitCompletionChange();
  }

  private trackFailed(request: ActivePageTranslationRequest): void {
    for (const id of request.ids) {
      this.failedIds.set(id, {
        captionRevision: request.captionRevision,
        contentKind: request.contentKind,
      });
    }
  }

  private ensureWorkWatcher(generation: number): void {
    const waitForWork = this.guest.waitForWork;
    if (!waitForWork) {
      this.scheduleTick(this.pollIntervalMs, generation);
      return;
    }
    if (!this.isCurrent(generation) || this.workWatchPending) return;
    const token = ++this.workWatchToken;
    const afterRevision = this.observedWorkRevision;
    const timeoutMs = Math.max(1, Math.min(2_000, this.pollIntervalMs));
    this.workWatchPending = true;
    void waitForWork.call(this.guest, afterRevision, timeoutMs).then(
      (revision) => {
        if (token !== this.workWatchToken) return;
        this.workWatchPending = false;
        if (!this.isCurrent(generation)) return;
        if (Number.isSafeInteger(revision) && revision >= 0) this.observedWorkRevision = revision;
        this.scheduleTick(0, generation);
      },
      () => {
        if (token !== this.workWatchToken) return;
        this.workWatchPending = false;
        if (this.isCurrent(generation)) this.scheduleTick(this.pollIntervalMs, generation);
      },
    );
  }

  private clearWorkWatcher(): void {
    this.workWatchToken += 1;
    this.workWatchPending = false;
  }

  private runGuest<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.guestQueue.then(operation, operation);
    this.guestQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private isCurrent(generation: number): boolean {
    return !this.destroyed && this.enabled && this.generation === generation;
  }

  private setStatus(status: UrlPageTranslationStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange(status);
  }

  private emitCompletionChange(): void {
    const completed = this.hasCompletedTranslations;
    if (this.lastReportedCompletion === completed) return;
    this.lastReportedCompletion = completed;
    this.options.onCompletionChange?.(completed);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleAutoEvaluation(generation: number): void {
    this.clearAutoTimer();
    if (!this.isAutoEvaluationCurrent(generation)) return;
    this.autoTimer = window.setTimeout(() => {
      this.autoTimer = null;
      void this.evaluateAutoTranslation(generation);
    }, AUTO_EVALUATION_INTERVAL_MS);
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
  return `${kind}:${Date.now()}:${fallbackId++}`;
}

function webviewIsReady(webview: Electron.WebviewTag): boolean {
  try {
    return Boolean(webview.getURL()) && !webview.isLoadingMainFrame();
  } catch {
    return false;
  }
}

function readWebviewUrl(webview: Electron.WebviewTag): string {
  try {
    return webview.getURL();
  } catch {
    return '';
  }
}

function urlPageIdentity(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value.split('#', 1)[0] ?? '';
  }
}
