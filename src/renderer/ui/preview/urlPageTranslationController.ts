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
const STANDARD_BATCH_MAX_BLOCKS = 4;
const STANDARD_BATCH_MAX_CHARS = 4_000;
const MAX_PREFETCH_REQUESTS = 1;
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
  generation: number;
  ids: string[];
  priority: number;
  requestId: string;
  sequence: number;
  sessionId: string;
}

export class UrlPageTranslationController {
  private readonly guest: UrlPageTranslationGuestBridge;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrentRequests: number;
  private readonly translate: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;
  private readonly cancel: (sessionId: string) => Promise<unknown>;
  private autoActivated = false;
  private readonly activeRequests = new Map<string, ActivePageTranslationRequest>();
  private autoTranslate: boolean;
  private destroyed = false;
  private domReady = false;
  private enabled = false;
  private readonly failedIds = new Set<string>();
  private generation = 0;
  private guestQueue: Promise<void> = Promise.resolve();
  private hasCompletedTranslation = false;
  private hasStartedVisibleBatch = false;
  private initialized = false;
  private manualSuppressed = false;
  private model: string | null;
  private pausedForError = false;
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
    this.domReady = webviewIsReady(webview);
    webview.addEventListener('did-start-navigation', this.handleDidStartNavigation);
    webview.addEventListener('dom-ready', this.handleDomReady);
    if (this.autoTranslate && this.domReady) void this.evaluateAutoTranslation(this.generation);
  }

  get currentStatus(): UrlPageTranslationStatus {
    return this.status;
  }

  get hasCompletedTranslations(): boolean {
    return this.hasCompletedTranslation;
  }

  toggle(): void {
    if (this.status === 'off') this.enable();
    else this.disable();
  }

  enable(): void {
    this.manualSuppressed = false;
    this.startTranslation(false);
  }

  setAutoTranslate(autoTranslate: boolean): void {
    if (this.destroyed || this.autoTranslate === autoTranslate) return;
    this.autoTranslate = autoTranslate;
    if (!autoTranslate) {
      this.autoActivated = false;
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
    this.autoActivated = automatic;
    this.enabled = true;
    this.pausedForError = false;
    this.hasStartedVisibleBatch = false;
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
    this.cancelAllActiveRequests();
    this.initialized = false;
    this.pausedForError = false;
    this.hasStartedVisibleBatch = false;
    this.failedIds.clear();
    this.setHasCompletedTranslation(false);
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
    this.webview.removeEventListener('did-start-navigation', this.handleDidStartNavigation);
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
    if (!event.isMainFrame || event.isInPlace) return;
    if (this.destroyed) return;
    this.domReady = false;
    this.enabled = false;
    this.autoActivated = false;
    this.pausedForError = false;
    this.initialized = false;
    this.cancelAllActiveRequests();
    this.hasStartedVisibleBatch = false;
    this.manualSuppressed = false;
    this.failedIds.clear();
    this.setHasCompletedTranslation(false);
    this.generation += 1;
    this.clearTimer();
    void this.runGuest(() => this.guest.destroy()).catch(() => undefined);
    this.setStatus('off');
  };

  private async evaluateAutoTranslation(generation: number): Promise<void> {
    if (!this.isAutoEvaluationCurrent(generation)) return;
    try {
      const declaredLanguage = await this.runGuest(() => this.guest.documentLanguage());
      if (!this.isAutoEvaluationCurrent(generation)) return;
      if (
        isValidLanguageTag(declaredLanguage)
        && !languageTagMatchesTranslationLanguage(declaredLanguage, this.targetLanguage)
      ) {
        this.startTranslation(true);
      }
    } catch {
      // Missing or unreadable document metadata leaves automatic translation idle.
    }
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
        const batch = await this.nextAvailableBatch();
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
        this.setStatus(this.hasCompletedTranslation ? 'on' : 'idle');
      }
    } catch {
      if (!this.isCurrent(generation)) return;
      this.failBeforeRequest('provider-error');
    }
    if (this.isCurrent(generation)) this.scheduleTick(this.pollIntervalMs, generation);
  }

  private async nextAvailableBatch(): Promise<UrlPageTranslationGuestBatch> {
    const activePrefetchRequests = [...this.activeRequests.values()]
      .filter((request) => request.priority > 0)
      .length;
    if (!this.hasStartedVisibleBatch && !this.pausedForError) {
      const firstVisible = await this.runGuest(() => this.guest.nextBatch({
        maxBlocks: FIRST_VISIBLE_MAX_BLOCKS,
        maxChars: FIRST_VISIBLE_MAX_CHARS,
        visibleOnly: true,
      }));
      if (firstVisible.blocks.length > 0) {
        this.hasStartedVisibleBatch = true;
        return firstVisible;
      }
      if (activePrefetchRequests >= MAX_PREFETCH_REQUESTS) return firstVisible;
    }

    return await this.runGuest(() => this.guest.nextBatch({
      maxBlocks: STANDARD_BATCH_MAX_BLOCKS,
      maxChars: STANDARD_BATCH_MAX_CHARS,
      retryOnly: this.pausedForError,
      visibleOnly: !this.pausedForError && activePrefetchRequests >= MAX_PREFETCH_REQUESTS,
    }));
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
      visibleOnly: true,
    }));
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

    this.startRequest(batch, generation);
    return true;
  }

  private startRequest(batch: UrlPageTranslationGuestBatch, generation: number): void {
    if (!this.isCurrent(generation) || batch.blocks.length === 0) return;
    if (this.status === 'idle') this.setStatus('starting');
    const requestId = nextId('request');
    const activeRequest: ActivePageTranslationRequest = {
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
      ...(this.model ? { model: this.model } : {}),
      blocks: batch.blocks,
    });
    void this.finishRequest(activeRequest, response);
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
    if (insertedCount > 0) this.setHasCompletedTranslation(true);
    for (const translation of response.translations) this.failedIds.delete(translation.id);
    this.pausedForError = this.failedIds.size > 0;
    this.setStatus(
      this.pausedForError
        ? 'error'
        : this.hasCompletedTranslation
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
    this.trackFailed(activeRequest.ids);
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

  private trackFailed(ids: readonly string[]): void {
    for (const id of ids) this.failedIds.add(id);
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

  private setHasCompletedTranslation(completed: boolean): void {
    if (this.hasCompletedTranslation === completed) return;
    this.hasCompletedTranslation = completed;
    this.options.onCompletionChange?.(completed);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
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
