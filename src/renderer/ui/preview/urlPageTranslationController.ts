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
  type UrlPageTranslationGuestLabels,
  type UrlPageTranslationGuestBridge,
} from './urlPageTranslationGuest';

const DEFAULT_POLL_INTERVAL_MS = 120;
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
  pollIntervalMs?: number;
  translate?: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;
  cancel?: (sessionId: string) => Promise<unknown>;
}

interface ActivePageTranslationRequest {
  generation: number;
  ids: string[];
  requestId: string;
}

export class UrlPageTranslationController {
  private readonly guest: UrlPageTranslationGuestBridge;
  private readonly pollIntervalMs: number;
  private readonly translate: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;
  private readonly cancel: (sessionId: string) => Promise<unknown>;
  private autoActivated = false;
  private activeRequest: ActivePageTranslationRequest | null = null;
  private autoTranslate: boolean;
  private destroyed = false;
  private domReady = false;
  private enabled = false;
  private readonly failedIds = new Set<string>();
  private generation = 0;
  private guestQueue: Promise<void> = Promise.resolve();
  private hasCompletedTranslation = false;
  private initialized = false;
  private manualSuppressed = false;
  private model: string | null;
  private pausedForError = false;
  private sessionId = nextId('session');
  private status: UrlPageTranslationStatus = 'off';
  private targetLanguage: TranslationLanguage;
  private timer: number | null = null;

  constructor(
    private readonly webview: Electron.WebviewTag,
    private readonly options: UrlPageTranslationControllerOptions,
  ) {
    this.guest = options.guest ?? createUrlPageTranslationGuestBridge(webview);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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
    void this.cancel(this.sessionId).catch(() => undefined);
    this.sessionId = nextId('session');
    this.initialized = false;
    this.activeRequest = null;
    this.pausedForError = false;
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
    const cancelledSessionId = this.sessionId;
    this.sessionId = nextId('session');
    void this.cancel(cancelledSessionId).catch(() => undefined);
    if (this.initialized) {
      void this.runGuest(() => this.guest.setEnabled(false, this.targetLanguage)).catch(() => undefined);
    }
    this.activeRequest = null;
    this.failedIds.clear();
    this.setStatus('off');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.enabled = false;
    this.autoActivated = false;
    this.activeRequest = null;
    this.generation += 1;
    this.clearTimer();
    this.webview.removeEventListener('did-start-navigation', this.handleDidStartNavigation);
    this.webview.removeEventListener('dom-ready', this.handleDomReady);
    void this.cancel(this.sessionId).catch(() => undefined);
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
    this.activeRequest = null;
    this.manualSuppressed = false;
    this.failedIds.clear();
    this.setHasCompletedTranslation(false);
    this.generation += 1;
    this.clearTimer();
    void this.cancel(this.sessionId).catch(() => undefined);
    void this.runGuest(() => this.guest.destroy()).catch(() => undefined);
    this.sessionId = nextId('session');
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
      void this.tick(generation);
    }, delay);
  }

  private async tick(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return;
    const previousRequest = this.activeRequest;
    try {
      const batch = await this.runGuest(() => (
        this.guest.nextBatch(this.pausedForError, previousRequest?.ids ?? [])
      ));
      if (!this.isCurrent(generation)) return;
      if (batch.blocks.length === 0) {
        if (!this.activeRequest && this.status === 'starting') {
          this.setStatus(this.hasCompletedTranslation ? 'on' : 'idle');
        }
        this.scheduleTick(this.pollIntervalMs, generation);
        return;
      }

      if (previousRequest && this.activeRequest === previousRequest) {
        this.activeRequest = null;
        await this.runGuest(() => this.guest.release(previousRequest.ids));
        if (!this.isCurrent(generation)) return;
      }

      if (this.status === 'idle') this.setStatus('starting');
      const requestId = nextId('request');
      const activeRequest: ActivePageTranslationRequest = {
        generation,
        ids: batch.blocks.map((block) => block.id),
        requestId,
      };
      this.activeRequest = activeRequest;
      const response = this.translate({
        sessionId: this.sessionId,
        requestId,
        targetLanguage: this.targetLanguage,
        ...(this.model ? { model: this.model } : {}),
        blocks: batch.blocks,
      });
      void this.finishRequest(activeRequest, response);
      this.scheduleTick(this.pollIntervalMs, generation);
    } catch {
      if (!this.isCurrent(generation)) return;
      this.failBeforeRequest('provider-error');
    }
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
        this.activeRequest = null;
        this.scheduleTick(0, activeRequest.generation);
        return;
      }
      await this.failRequest(activeRequest, response.error);
      return;
    }

    try {
      await this.runGuest(() => this.guest.apply(response.translations));
    } catch {
      await this.failRequest(activeRequest, 'provider-error');
      return;
    }
    if (!this.isActiveRequest(activeRequest)) return;
    this.activeRequest = null;
    if (response.translations.length > 0) this.setHasCompletedTranslation(true);
    for (const translation of response.translations) this.failedIds.delete(translation.id);
    this.pausedForError = this.failedIds.size > 0;
    this.setStatus(
      this.pausedForError ? 'error' : this.hasCompletedTranslation ? 'on' : 'idle',
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
    this.activeRequest = null;
    this.trackFailed(activeRequest.ids);
    this.pauseWithError(error);
  }

  private isActiveRequest(activeRequest: ActivePageTranslationRequest): boolean {
    return (
      this.isCurrent(activeRequest.generation)
      && this.activeRequest === activeRequest
    );
  }

  private failBeforeRequest(error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>): void {
    this.enabled = false;
    this.autoActivated = false;
    this.activeRequest = null;
    this.pausedForError = false;
    this.generation += 1;
    this.clearTimer();
    const cancelledSessionId = this.sessionId;
    this.sessionId = nextId('session');
    void this.cancel(cancelledSessionId).catch(() => undefined);
    this.failedIds.clear();
    if (this.initialized) {
      void this.runGuest(() => this.guest.setEnabled(false, this.targetLanguage)).catch(() => undefined);
    }
    this.setStatus('off');
    this.options.onError(error);
  }

  private pauseWithError(error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>): void {
    this.pausedForError = true;
    this.clearTimer();
    this.setStatus('error');
    this.options.onError(error);
    this.scheduleTick(this.pollIntervalMs, this.generation);
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
