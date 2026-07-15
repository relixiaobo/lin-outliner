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
import {
  createUrlPageTranslationGuestBridge,
  type UrlPageTranslationGuestBatch,
  type UrlPageTranslationGuestLabels,
  type UrlPageTranslationGuestBridge,
} from './urlPageTranslationGuest';

const DEFAULT_POLL_INTERVAL_MS = 120;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const FIRST_VISIBLE_MAX_BLOCKS = 2;
const FIRST_VISIBLE_MAX_CHARS = 2_000;
const FIRST_CAPTION_MAX_BLOCKS = 6;
const FIRST_CAPTION_MAX_CHARS = 1_500;
const STANDARD_BATCH_MAX_BLOCKS = 4;
const STANDARD_BATCH_MAX_CHARS = 4_000;
const STANDARD_CAPTION_MAX_BLOCKS = 16;
const STANDARD_CAPTION_MAX_CHARS = 4_000;
const MAX_PREFETCH_REQUESTS = 1;
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
  captionRevision: number;
  contentKind: 'caption' | 'page';
  generation: number;
  ids: string[];
  priority: number;
  requestId: string;
  sequence: number;
  sessionId: string;
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
  private guestQueue: Promise<void> = Promise.resolve();
  private completedCaptionRevision: number | null = null;
  private hasCompletedPageTranslation = false;
  private hasStartedCaptionBatch = false;
  private hasStartedVisiblePageBatch = false;
  private initialized = false;
  private lastReportedCompletion = false;
  private manualSuppressed = false;
  private model: string | null;
  private pageIdentity: string;
  private pausedForError = false;
  private observedCaptionRevision: number | null = null;
  private requestSequence = 0;
  private status: UrlPageTranslationStatus = 'off';
  private targetLanguage: TranslationLanguage;
  private timer: number | null = null;
  private tickQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly webview: Electron.WebviewTag,
    private readonly options: UrlPageTranslationControllerOptions,
  ) {
    this.guest = options.guest ?? createUrlPageTranslationGuestBridge(webview);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.maxConcurrentRequests = Math.min(
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      Math.max(1, Math.floor(options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS)),
    );
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
    this.pausedForError = false;
    this.hasStartedCaptionBatch = false;
    this.hasStartedVisiblePageBatch = false;
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
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.initialized = false;
    this.pausedForError = false;
    this.hasStartedCaptionBatch = false;
    this.hasStartedVisiblePageBatch = false;
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
    this.pausedForError = false;
    this.generation += 1;
    this.clearTimer();
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
    this.pausedForError = false;
    this.initialized = false;
    this.cancelAllActiveRequests();
    this.hasStartedCaptionBatch = false;
    this.hasStartedVisiblePageBatch = false;
    this.manualSuppressed = false;
    this.failedIds.clear();
    this.resetCompletionState();
    this.generation += 1;
    this.clearTimer();
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
    this.pausedForError = false;
    this.initialized = false;
    this.generation += 1;
    const generation = this.generation;
    this.clearTimer();
    this.clearAutoTimer();
    this.cancelAllActiveRequests();
    this.hasStartedCaptionBatch = false;
    this.hasStartedVisiblePageBatch = false;
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
      while (
        this.isCurrent(generation)
        && this.activeRequests.size < this.maxConcurrentRequests
      ) {
        const batch = await this.nextAvailableBatch(generation);
        if (!this.isCurrent(generation)) return;
        if (batch.blocks.length === 0) break;
        this.startRequest(batch, generation);
      }

      if (!this.pausedForError && this.activeRequests.size >= this.maxConcurrentRequests) {
        for (let index = 0; index < this.maxConcurrentRequests; index += 1) {
          if (!await this.preemptForVisibleBatch(generation)) break;
        }
      }

      if (this.activeRequests.size === 0 && this.status === 'starting') {
        this.setStatus(this.hasCompletedTranslations ? 'on' : 'idle');
      }
    } catch {
      if (!this.isCurrent(generation)) return;
      this.failBeforeRequest('provider-error');
    }
    if (this.isCurrent(generation)) this.scheduleTick(this.pollIntervalMs, generation);
  }

  private async nextAvailableBatch(generation: number): Promise<UrlPageTranslationGuestBatch> {
    const activePrefetchRequests = [...this.activeRequests.values()]
      .filter((request) => request.priority > 0)
      .length;
    if (!this.hasStartedVisiblePageBatch && !this.pausedForError) {
      const firstVisible = await this.runGuest(() => this.guest.nextBatch({
        captionMaxBlocks: this.hasStartedCaptionBatch
          ? STANDARD_CAPTION_MAX_BLOCKS
          : FIRST_CAPTION_MAX_BLOCKS,
        captionMaxChars: this.hasStartedCaptionBatch
          ? STANDARD_CAPTION_MAX_CHARS
          : FIRST_CAPTION_MAX_CHARS,
        maxBlocks: FIRST_VISIBLE_MAX_BLOCKS,
        maxChars: FIRST_VISIBLE_MAX_CHARS,
        visibleOnly: true,
      }));
      this.observeGuestBatch(firstVisible, generation);
      if (firstVisible.blocks.length > 0) {
        this.markBatchStarted(firstVisible);
        return firstVisible;
      }
      if (activePrefetchRequests >= MAX_PREFETCH_REQUESTS) return firstVisible;
    }

    const batch = await this.runGuest(() => this.guest.nextBatch({
      captionMaxBlocks: this.hasStartedCaptionBatch
        ? STANDARD_CAPTION_MAX_BLOCKS
        : FIRST_CAPTION_MAX_BLOCKS,
      captionMaxChars: this.hasStartedCaptionBatch
        ? STANDARD_CAPTION_MAX_CHARS
        : FIRST_CAPTION_MAX_CHARS,
      maxBlocks: STANDARD_BATCH_MAX_BLOCKS,
      maxChars: STANDARD_BATCH_MAX_CHARS,
      retryOnly: this.pausedForError,
      visibleOnly: !this.pausedForError && activePrefetchRequests >= MAX_PREFETCH_REQUESTS,
    }));
    this.observeGuestBatch(batch, generation);
    if (batch.blocks.length > 0) this.markBatchStarted(batch);
    return batch;
  }

  private async preemptForVisibleBatch(generation: number): Promise<boolean> {
    const candidates = [...this.activeRequests.values()]
      .sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
    const batch = await this.runGuest(() => this.guest.nextBatch({
      activeBatches: candidates.map((request) => ({
        ids: request.ids,
        requestId: request.requestId,
      })),
      maxBlocks: STANDARD_BATCH_MAX_BLOCKS,
      maxChars: STANDARD_BATCH_MAX_CHARS,
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
    } else if (this.activeRequests.size >= this.maxConcurrentRequests) {
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
    const activeRequest: ActivePageTranslationRequest = {
      captionRevision: batch.captionRevision,
      contentKind: batch.contentKind ?? 'page',
      generation,
      ids: batch.blocks.map((block) => block.id),
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
      contentKind: activeRequest.contentKind,
      ...(this.model ? { model: this.model } : {}),
      blocks: batch.blocks,
    });
    void this.finishRequest(activeRequest, response);
  }

  private markBatchStarted(batch: UrlPageTranslationGuestBatch): void {
    if ((batch.contentKind ?? 'page') === 'caption') this.hasStartedCaptionBatch = true;
    else if (batch.priority === 0) this.hasStartedVisiblePageBatch = true;
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

    let insertedCount: number;
    try {
      insertedCount = await this.runGuest(() => this.guest.apply(response.translations));
    } catch {
      await this.failRequest(activeRequest, 'provider-error');
      return;
    }
    if (!this.isActiveRequest(activeRequest)) return;
    this.activeRequests.delete(activeRequest.requestId);
    if (insertedCount > 0) this.markRequestCompleted(activeRequest);
    for (const translation of response.translations) this.failedIds.delete(translation.id);
    this.pausedForError = this.failedIds.size > 0;
    this.setStatus(
      this.pausedForError
        ? 'error'
        : this.hasCompletedTranslations
          ? 'on'
          : this.activeRequests.size > 0
            ? 'starting'
            : 'idle',
    );
    this.scheduleTick(this.pausedForError ? this.pollIntervalMs : 0, activeRequest.generation);
  }

  private async failRequest(
    activeRequest: ActivePageTranslationRequest,
    error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>,
  ): Promise<void> {
    if (!this.isActiveRequest(activeRequest)) return;
    await this.runGuest(() => this.guest.fail(activeRequest.ids)).catch(() => undefined);
    if (!this.isActiveRequest(activeRequest)) return;
    this.activeRequests.delete(activeRequest.requestId);
    this.trackFailed(activeRequest);
    this.pauseWithError(error);
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
    this.pausedForError = false;
    this.generation += 1;
    this.clearTimer();
    this.cancelAllActiveRequests();
    this.failedIds.clear();
    if (this.initialized) {
      void this.runGuest(() => this.guest.setEnabled(false, this.targetLanguage)).catch(() => undefined);
    }
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

  private cancelAllActiveRequests(): void {
    const sessionIds = new Set(
      [...this.activeRequests.values()].map((request) => request.sessionId),
    );
    this.activeRequests.clear();
    for (const sessionId of sessionIds) {
      void this.cancel(sessionId).catch(() => undefined);
    }
  }

  private observeGuestBatch(batch: UrlPageTranslationGuestBatch, generation: number): void {
    if (!this.isCurrent(generation) || this.observedCaptionRevision === batch.captionRevision) return;
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
    this.pausedForError = this.failedIds.size > 0;
    this.emitCompletionChange();
    this.setStatus(
      this.pausedForError
        ? 'error'
        : this.hasCompletedTranslations
          ? 'on'
          : batch.blocks.length > 0 || this.activeRequests.size > 0
            ? 'starting'
            : 'idle',
    );
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
