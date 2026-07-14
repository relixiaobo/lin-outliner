import type { Locale } from '../../../core/locale';
import type {
  UrlPageTranslationFailureCode,
  UrlPageTranslationRequest,
  UrlPageTranslationResponse,
} from '../../../core/urlPageTranslation';
import { api } from '../../api/client';
import {
  createUrlPageTranslationGuestBridge,
  type UrlPageTranslationGuestBridge,
} from './urlPageTranslationGuest';

const DEFAULT_POLL_INTERVAL_MS = 400;

let fallbackId = 1;

export type UrlPageTranslationStatus = 'error' | 'off' | 'on' | 'starting';

interface UrlPageTranslationControllerOptions {
  targetLocale: Locale;
  onError: (error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>) => void;
  onStatusChange: (status: UrlPageTranslationStatus) => void;
  guest?: UrlPageTranslationGuestBridge;
  pollIntervalMs?: number;
  translate?: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;
  cancel?: (sessionId: string) => Promise<unknown>;
}

export class UrlPageTranslationController {
  private readonly guest: UrlPageTranslationGuestBridge;
  private readonly pollIntervalMs: number;
  private readonly translate: (request: UrlPageTranslationRequest) => Promise<UrlPageTranslationResponse>;
  private readonly cancel: (sessionId: string) => Promise<unknown>;
  private destroyed = false;
  private domReady = false;
  private enabled = false;
  private generation = 0;
  private initialized = false;
  private inFlight = false;
  private pausedForError = false;
  private sessionId = nextId('session');
  private status: UrlPageTranslationStatus = 'off';
  private timer: number | null = null;

  constructor(
    private readonly webview: Electron.WebviewTag,
    private readonly options: UrlPageTranslationControllerOptions,
  ) {
    this.guest = options.guest ?? createUrlPageTranslationGuestBridge(webview);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.translate = options.translate ?? api.translateUrlPageBlocks;
    this.cancel = options.cancel ?? api.cancelUrlPageTranslation;
    this.domReady = webviewIsReady(webview);
    webview.addEventListener('did-start-navigation', this.handleDidStartNavigation);
    webview.addEventListener('dom-ready', this.handleDomReady);
  }

  get currentStatus(): UrlPageTranslationStatus {
    return this.status;
  }

  toggle(): void {
    if (this.status === 'off') this.enable();
    else this.disable();
  }

  enable(): void {
    if (this.destroyed || this.enabled) return;
    this.enabled = true;
    this.pausedForError = false;
    this.generation += 1;
    this.setStatus('starting');
    if (this.domReady) void this.startGuest(this.generation);
  }

  disable(): void {
    if (this.destroyed) return;
    this.enabled = false;
    this.pausedForError = false;
    this.generation += 1;
    this.clearTimer();
    const cancelledSessionId = this.sessionId;
    this.sessionId = nextId('session');
    void this.cancel(cancelledSessionId).catch(() => undefined);
    if (this.initialized) void this.guest.setEnabled(false, this.options.targetLocale).catch(() => undefined);
    this.inFlight = false;
    this.setStatus('off');
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.enabled = false;
    this.generation += 1;
    this.clearTimer();
    this.webview.removeEventListener('did-start-navigation', this.handleDidStartNavigation);
    this.webview.removeEventListener('dom-ready', this.handleDomReady);
    void this.cancel(this.sessionId).catch(() => undefined);
    void this.guest.destroy().catch(() => undefined);
  }

  private readonly handleDomReady = () => {
    if (this.destroyed) return;
    this.domReady = true;
    if (this.enabled) void this.startGuest(this.generation);
  };

  private readonly handleDidStartNavigation = (event: Electron.DidStartNavigationEvent) => {
    if (!event.isMainFrame || event.isInPlace) return;
    if (this.destroyed) return;
    this.domReady = false;
    this.enabled = false;
    this.pausedForError = false;
    this.initialized = false;
    this.inFlight = false;
    this.generation += 1;
    this.clearTimer();
    void this.cancel(this.sessionId).catch(() => undefined);
    void this.guest.destroy().catch(() => undefined);
    this.sessionId = nextId('session');
    this.setStatus('off');
  };

  private async startGuest(generation: number): Promise<void> {
    try {
      if (!this.initialized) {
        await this.guest.initialize(this.options.targetLocale);
        if (!this.isCurrent(generation)) return;
        this.initialized = true;
      }
      await this.guest.setEnabled(true, this.options.targetLocale);
      if (!this.isCurrent(generation)) return;
      this.scheduleTick(0, generation);
    } catch {
      if (!this.isCurrent(generation)) return;
      this.failBeforeRequest('provider-error');
    }
  }

  private scheduleTick(delay: number, generation: number): void {
    this.clearTimer();
    if (!this.isCurrent(generation) || this.pausedForError) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.tick(generation);
    }, delay);
  }

  private async tick(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.pausedForError || this.inFlight) return;
    let ids: string[] = [];
    try {
      const batch = await this.guest.nextBatch();
      if (!this.isCurrent(generation)) return;
      if (batch.blocks.length === 0) {
        if (this.status === 'starting') this.setStatus('on');
        this.scheduleTick(this.pollIntervalMs, generation);
        return;
      }

      ids = batch.blocks.map((block) => block.id);
      this.inFlight = true;
      const requestId = nextId('request');
      const response = await this.translate({
        sessionId: this.sessionId,
        requestId,
        targetLocale: this.options.targetLocale,
        blocks: batch.blocks,
      });
      if (!this.isCurrent(generation)) return;
      if (response.requestId !== requestId) {
        await this.guest.fail(ids);
        this.pauseWithError('invalid-response');
        return;
      }
      if (!response.ok) {
        if (response.error === 'cancelled') return;
        await this.guest.fail(ids);
        if (response.error === 'not-configured') {
          this.failBeforeRequest(response.error);
        } else {
          this.pauseWithError(response.error);
        }
        return;
      }

      await this.guest.apply(response.translations);
      if (!this.isCurrent(generation)) return;
      if (this.status === 'starting') this.setStatus('on');
      this.scheduleTick(0, generation);
    } catch {
      if (!this.isCurrent(generation)) return;
      if (ids.length > 0) await this.guest.fail(ids).catch(() => undefined);
      this.pauseWithError('provider-error');
    } finally {
      this.inFlight = false;
    }
  }

  private failBeforeRequest(error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>): void {
    this.enabled = false;
    this.pausedForError = false;
    this.generation += 1;
    this.clearTimer();
    if (this.initialized) void this.guest.setEnabled(false, this.options.targetLocale).catch(() => undefined);
    this.setStatus('off');
    this.options.onError(error);
  }

  private pauseWithError(error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>): void {
    this.pausedForError = true;
    this.clearTimer();
    this.setStatus('error');
    this.options.onError(error);
  }

  private isCurrent(generation: number): boolean {
    return !this.destroyed && this.enabled && this.generation === generation;
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
