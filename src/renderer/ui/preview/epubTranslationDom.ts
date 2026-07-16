import {
  isValidLanguageTag,
  languageTagMatchesTranslationLanguage,
  type TranslationLanguage,
} from '../../../core/translationLanguage';
import {
  URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
  type UrlPageTranslationBlock,
  type UrlPageTranslationItem,
} from '../../../core/urlPageTranslation';
import type { UrlPageTranslationGuestLabels } from './urlPageTranslationGuest';
import { matchesShortcutEvent } from '../interactions/shortcutRegistry';
import { previewTranslationLookaheadViewports } from './previewTranslationScheduling';

const TRANSLATION_ATTRIBUTE = 'data-tenon-epub-translation';
const STATUS_ATTRIBUTE = 'data-tenon-epub-translation-status';
const HIDDEN_ATTRIBUTE = 'data-tenon-epub-translations-hidden';
const STYLE_ATTRIBUTE = 'data-tenon-epub-translation-style';
const OWNED_SELECTOR = `[${TRANSLATION_ATTRIBUTE}], [${STATUS_ATTRIBUTE}], [${STYLE_ATTRIBUTE}]`;
const CANDIDATE_SELECTOR = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  '[role="heading"]', '[role="paragraph"]',
  'p', 'li', 'blockquote', 'figcaption', 'caption', 'td', 'th', 'dt', 'dd',
  'div',
].join(',');
const EXCLUDED_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'pre', 'code', 'kbd', 'samp',
  'input', 'textarea', 'select', 'option', 'button', 'form', 'nav',
  '[role="button"]', '[role="textbox"]', '[role="navigation"]',
  OWNED_SELECTOR,
].join(',');
const SCROLL_KEYS = new Set([
  'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp',
  'End', 'Home', 'PageDown', 'PageUp', ' ',
]);

export const EPUB_TRANSLATION_CSS = `
[${TRANSLATION_ATTRIBUTE}="true"] {
  display: block !important;
  width: 100% !important;
  margin-block-start: 0.35em !important;
  border: 0 !important;
  background: transparent !important;
  color: inherit !important;
  font: inherit !important;
  font-size: inherit !important;
  font-style: normal !important;
  font-weight: 400 !important;
  letter-spacing: 0 !important;
  line-height: inherit !important;
  opacity: 0.72 !important;
  overflow-anchor: none !important;
  text-decoration: none !important;
  text-transform: none !important;
  white-space: pre-wrap !important;
}
html[${HIDDEN_ATTRIBUTE}="true"] [${TRANSLATION_ATTRIBUTE}="true"] {
  display: none !important;
}
[${STATUS_ATTRIBUTE}] {
  all: unset !important;
  box-sizing: border-box !important;
  display: inline-flex !important;
  width: 16px !important;
  height: 16px !important;
  align-items: center !important;
  justify-content: center !important;
  margin-inline-start: 4px !important;
  border: 0 !important;
  border-radius: 50% !important;
  background: transparent !important;
  color: currentColor !important;
  cursor: default !important;
  font: 700 11px/1 system-ui, sans-serif !important;
  opacity: 0.52 !important;
  overflow-anchor: none !important;
  vertical-align: -2px !important;
}
[${STATUS_ATTRIBUTE}="loading"]::before {
  box-sizing: border-box !important;
  width: 10px !important;
  height: 10px !important;
  border: 1.5px solid currentColor !important;
  border-inline-end-color: transparent !important;
  border-radius: 50% !important;
  animation: tenon-epub-translation-spin 0.8s linear infinite !important;
  content: "" !important;
}
[${STATUS_ATTRIBUTE}="error"] {
  border: 1px solid currentColor !important;
  opacity: 0.78 !important;
}
[${STATUS_ATTRIBUTE}="error"]:hover {
  opacity: 0.92 !important;
}
[${STATUS_ATTRIBUTE}="error"]:active {
  border-width: 2px !important;
  opacity: 1 !important;
}
[${STATUS_ATTRIBUTE}="error"]::before {
  content: "!" !important;
}
[${STATUS_ATTRIBUTE}="error"]:focus-visible {
  outline: 2px solid currentColor !important;
  outline-offset: 2px !important;
  opacity: 1 !important;
}
@keyframes tenon-epub-translation-spin {
  to { transform: rotate(1turn); }
}
@media (prefers-contrast: more) {
  [${TRANSLATION_ATTRIBUTE}="true"],
  [${STATUS_ATTRIBUTE}] {
    opacity: 1 !important;
  }
}
@media (prefers-reduced-motion: reduce) {
  [${STATUS_ATTRIBUTE}="loading"]::before {
    animation: none !important;
  }
}
`;

export interface EpubTranslationActiveBatch {
  ids: readonly string[];
  requestId: string;
}

export interface EpubTranslationBatchOptions {
  activeBatches?: readonly EpubTranslationActiveBatch[];
  estimatedLatencyMs: number;
  maxBlocks: number;
  maxChars: number;
  queueVisible?: boolean;
  retryOnly?: boolean;
  visibleOnly?: boolean;
}

export interface EpubTranslationBatch {
  blocks: UrlPageTranslationBlock[];
  preemptRequestId?: string | null;
  priority: number | null;
}

export interface EpubTranslationSurface {
  apply(items: readonly UrlPageTranslationItem[]): number;
  fail(ids: readonly string[]): string[];
  failedRecordIds(): string[];
  languages(): string[];
  nextBatch(options: EpubTranslationBatchOptions): EpubTranslationBatch;
  release(ids: readonly string[]): void;
  reset(targetLanguage: TranslationLanguage): void;
  setEnabled(enabled: boolean): void;
  setWorkAvailableHandler(handler: () => void): void;
}

interface EpubTranslationRecord {
  completed: boolean;
  element: HTMLElement | null;
  failed: boolean;
  id: string;
  language: string | null;
  pending: boolean;
  queued: boolean;
  retryRequested: boolean;
  sectionIndex: number;
  statusNode: HTMLButtonElement | null;
  text: string;
  translation: string | null;
  translationNode: HTMLElement | null;
}

interface EpubSectionRegistration {
  dirty: boolean;
  doc: Document;
  frame: HTMLIFrameElement;
  mutationObserver: MutationObserver | null;
  recordIds: Set<string>;
  releaseInputListeners: () => void;
  style: HTMLStyleElement;
}

interface EpubTranslationDomOptions {
  bookLanguages: readonly string[];
  labels: UrlPageTranslationGuestLabels;
  onEnabledChange?: (enabled: boolean) => void;
  onShortcut: () => boolean;
  scrollRoot: HTMLElement;
}

interface TranslationAnchor {
  id: string;
  top: number;
}

interface RecordGeometry {
  bottom: number;
  top: number;
}

export class EpubTranslationDomAdapter implements EpubTranslationSurface {
  private readonly bookLanguages: string[];
  private labels: UrlPageTranslationGuestLabels;
  private readonly records = new Map<string, EpubTranslationRecord>();
  private readonly sections = new Map<number, EpubSectionRegistration>();
  private readonly scrollRoot: HTMLElement;
  private readonly onEnabledChange: (enabled: boolean) => void;
  private correctionFrame: number | null = null;
  private correctionRevision = 0;
  private direction: 'down' | 'neutral' | 'up' = 'neutral';
  private enabled = false;
  private inputRevision = 0;
  private lastScrollAt = Date.now();
  private lastScrollTop: number;
  private ownScrollTarget: number | null = null;
  private scrollVelocityViewportsPerMs = 0;
  private shortcutHandler: () => boolean;
  private targetLanguage: TranslationLanguage = 'en';
  private workAvailableHandler: () => void = () => undefined;

  constructor(options: EpubTranslationDomOptions) {
    this.bookLanguages = options.bookLanguages.filter(isValidLanguageTag);
    this.labels = options.labels;
    this.onEnabledChange = options.onEnabledChange ?? (() => undefined);
    this.scrollRoot = options.scrollRoot;
    this.shortcutHandler = options.onShortcut;
    this.lastScrollTop = options.scrollRoot.scrollTop;
    options.scrollRoot.addEventListener('scroll', this.handleScroll, { passive: true });
    options.scrollRoot.addEventListener('wheel', this.handleUserInput, { passive: true });
    options.scrollRoot.addEventListener('touchstart', this.handleUserInput, { passive: true });
    options.scrollRoot.addEventListener('pointerdown', this.handleUserInput, { passive: true });
    options.scrollRoot.addEventListener('keydown', this.handleHostKeyDown, true);
  }

  setShortcutHandler(handler: () => boolean): void {
    this.shortcutHandler = handler;
  }

  setWorkAvailableHandler(handler: () => void): void {
    this.workAvailableHandler = handler;
  }

  setLabels(labels: UrlPageTranslationGuestLabels): void {
    this.labels = labels;
    for (const record of this.records.values()) {
      const status = record.statusNode;
      const state = status?.getAttribute(STATUS_ATTRIBUTE);
      if (status && (state === 'error' || state === 'loading')) {
        updateStatusNodeLabels(status, state, labels);
      }
    }
  }

  languages(): string[] {
    const languages = new Set(this.bookLanguages);
    for (const { doc } of this.sections.values()) {
      const language = declaredDocumentLanguage(doc);
      if (isValidLanguageTag(language)) languages.add(language);
    }
    return [...languages];
  }

  registerSection(sectionIndex: number, frame: HTMLIFrameElement): void {
    const doc = frame.contentDocument;
    if (!doc) return;
    this.unregisterSection(sectionIndex);

    const style = doc.createElement('style');
    style.setAttribute(STYLE_ATTRIBUTE, 'true');
    style.textContent = EPUB_TRANSLATION_CSS;
    doc.head?.append(style);
    if (!this.enabled) doc.documentElement.setAttribute(HIDDEN_ATTRIBUTE, 'true');

    const registration: EpubSectionRegistration = {
      dirty: true,
      doc,
      frame,
      mutationObserver: null,
      recordIds: new Set(),
      releaseInputListeners: this.installSectionInputListeners(doc),
      style,
    };
    const Observer = doc.defaultView?.MutationObserver;
    if (Observer) {
      registration.mutationObserver = new Observer((mutations) => {
        if (mutations.every(mutationOnlyTouchesOwnedNodes)) return;
        registration.dirty = true;
        this.workAvailableHandler();
      });
      registration.mutationObserver.observe(doc.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    this.sections.set(sectionIndex, registration);
    this.scanSection(sectionIndex, registration);
    this.workAvailableHandler();
  }

  unregisterSection(sectionIndex: number): void {
    const registration = this.sections.get(sectionIndex);
    if (!registration) return;
    registration.mutationObserver?.disconnect();
    registration.releaseInputListeners();
    registration.style.remove();
    registration.doc.documentElement.removeAttribute(HIDDEN_ATTRIBUTE);
    for (const id of registration.recordIds) {
      const record = this.records.get(id);
      if (!record) continue;
      removeStatusNode(record);
      record.translationNode?.remove();
      record.element = null;
      record.translationNode = null;
    }
    this.sections.delete(sectionIndex);
    this.workAvailableHandler();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.withAnchoredWrite(() => {
      this.enabled = enabled;
      for (const { doc } of this.sections.values()) {
        if (enabled) doc.documentElement.removeAttribute(HIDDEN_ATTRIBUTE);
        else doc.documentElement.setAttribute(HIDDEN_ATTRIBUTE, 'true');
      }
      for (const record of this.records.values()) {
        if (!enabled) {
          record.pending = false;
          record.queued = false;
          record.failed = false;
          record.retryRequested = false;
          removeStatusNode(record);
        } else {
          this.renderRecord(record);
        }
      }
    });
    this.onEnabledChange(enabled);
    if (enabled) this.workAvailableHandler();
  }

  reset(targetLanguage: TranslationLanguage): void {
    this.withAnchoredWrite(() => {
      this.targetLanguage = targetLanguage;
      for (const record of this.records.values()) {
        removeStatusNode(record);
        record.translationNode?.remove();
        record.translationNode = null;
        record.completed = false;
        record.failed = false;
        record.pending = false;
        record.queued = false;
        record.retryRequested = false;
        record.translation = null;
      }
      for (const registration of this.sections.values()) registration.dirty = true;
    });
    this.workAvailableHandler();
  }

  nextBatch(options: EpubTranslationBatchOptions): EpubTranslationBatch {
    if (!this.enabled) return emptyBatch();
    this.scanDirtySections();
    if (options.queueVisible) this.queueVisibleRecords(options.estimatedLatencyMs);
    const candidates = this.batchCandidates(options);
    if (candidates.length === 0) return emptyBatch();

    const preemptRequestId = this.preemptibleRequest(options.activeBatches ?? []);
    const selected: Array<{
      geometry: RecordGeometry;
      priority: number;
      record: EpubTranslationRecord;
    }> = [];
    const selectedPriority = candidates[0]?.priority ?? null;
    let totalChars = 0;
    for (const candidate of candidates) {
      if (candidate.priority !== selectedPriority) break;
      const { record } = candidate;
      const nextChars = totalChars + record.text.length;
      if (
        record.text.length > options.maxChars
        || record.text.length > URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS
        || nextChars > options.maxChars
      ) continue;
      selected.push(candidate);
      totalChars = nextChars;
      if (selected.length >= options.maxBlocks || totalChars >= options.maxChars) break;
    }
    if (selected.length === 0) return emptyBatch();

    this.withAnchoredWrite(() => {
      for (const { record } of selected) {
        record.pending = true;
        record.queued = false;
        if (!options.retryOnly) record.failed = false;
        record.retryRequested = false;
        this.renderRecord(record);
      }
    });
    const recordsInDocumentOrder = [...selected]
      .sort((left, right) => left.geometry.top - right.geometry.top)
      .map(({ record }) => record);
    return {
      blocks: recordsInDocumentOrder.map(({ id, text }) => ({ id, text })),
      preemptRequestId,
      priority: selectedPriority,
    };
  }

  release(ids: readonly string[]): void {
    this.withAnchoredWrite(() => {
      for (const id of ids) {
        const record = this.records.get(id);
        if (!record) continue;
        record.pending = false;
        record.queued = false;
        record.failed = false;
        record.retryRequested = false;
        this.renderRecord(record);
      }
    });
  }

  apply(items: readonly UrlPageTranslationItem[]): number {
    let inserted = 0;
    this.withAnchoredWrite(() => {
      for (const item of items) {
        const record = this.records.get(item.id);
        if (!record) continue;
        record.pending = false;
        record.queued = false;
        if (!this.refreshCurrentRecord(record)) {
          this.discardStaleRecord(record);
          continue;
        }
        if (record.language && languageTagMatchesTranslationLanguage(record.language, this.targetLanguage)) {
          record.failed = false;
          record.retryRequested = false;
          removeOwnedNodes(record);
          continue;
        }
        record.failed = false;
        record.retryRequested = false;
        record.completed = true;
        record.translation = normalizeText(item.translation);
        removeStatusNode(record);
        if (!record.translation || record.translation === normalizeText(record.text)) {
          record.translationNode?.remove();
          record.translationNode = null;
          continue;
        }
        if (this.ensureTranslationNode(record)) inserted += 1;
      }
    });
    return inserted;
  }

  fail(ids: readonly string[]): string[] {
    const failedIds: string[] = [];
    this.withAnchoredWrite(() => {
      for (const id of ids) {
        const record = this.records.get(id);
        if (!record) continue;
        record.pending = false;
        record.queued = false;
        if (!this.refreshCurrentRecord(record)) {
          this.discardStaleRecord(record);
          continue;
        }
        if (record.language && languageTagMatchesTranslationLanguage(record.language, this.targetLanguage)) {
          record.failed = false;
          record.retryRequested = false;
          removeOwnedNodes(record);
          continue;
        }
        record.failed = true;
        record.retryRequested = false;
        this.renderRecord(record);
        failedIds.push(id);
      }
    });
    return failedIds;
  }

  failedRecordIds(): string[] {
    this.scanDirtySections();
    return [...this.records.values()]
      .filter((record) => record.failed)
      .map(({ id }) => id);
  }

  destroy(): void {
    const wasEnabled = this.enabled;
    this.enabled = false;
    if (wasEnabled) this.onEnabledChange(false);
    this.cancelCorrection();
    this.scrollRoot.removeEventListener('scroll', this.handleScroll);
    this.scrollRoot.removeEventListener('wheel', this.handleUserInput);
    this.scrollRoot.removeEventListener('touchstart', this.handleUserInput);
    this.scrollRoot.removeEventListener('pointerdown', this.handleUserInput);
    this.scrollRoot.removeEventListener('keydown', this.handleHostKeyDown, true);
    this.workAvailableHandler = () => undefined;
    for (const record of this.records.values()) {
      removeStatusNode(record);
      record.translationNode?.remove();
    }
    for (const sectionIndex of [...this.sections.keys()]) this.unregisterSection(sectionIndex);
    this.records.clear();
  }

  private scanDirtySections(): void {
    const dirtySections = [...this.sections]
      .filter(([, registration]) => registration.dirty);
    if (dirtySections.length === 0) return;
    this.withAnchoredWrite(() => {
      for (const [sectionIndex, registration] of dirtySections) {
        this.scanSection(sectionIndex, registration);
      }
    });
  }

  private scanSection(sectionIndex: number, registration: EpubSectionRegistration): void {
    registration.dirty = false;
    const nextIds = new Set<string>();
    let ordinal = 0;
    for (const element of Array.from(registration.doc.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR))) {
      if (!isEligibleCandidate(element)) continue;
      const text = sourceText(element);
      if (!text || text.length > URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS) continue;
      const id = `e${sectionIndex}:${ordinal}:${textHash(text)}`;
      ordinal += 1;
      nextIds.add(id);
      const language = nearestLanguage(element)
        ?? declaredDocumentLanguage(registration.doc)
        ?? this.bookLanguages[0]
        ?? null;
      const existing = this.records.get(id);
      const record: EpubTranslationRecord = existing ?? {
        completed: false,
        element,
        failed: false,
        id,
        language,
        pending: false,
        queued: false,
        retryRequested: false,
        sectionIndex,
        statusNode: null,
        text,
        translation: null,
        translationNode: null,
      };
      record.element = element;
      record.language = language;
      record.text = text;
      this.records.set(id, record);
      this.renderRecord(record);
    }

    for (const id of registration.recordIds) {
      if (nextIds.has(id)) continue;
      const record = this.records.get(id);
      if (!record) continue;
      removeOwnedNodes(record);
      record.element = null;
      this.records.delete(id);
    }
    registration.recordIds = nextIds;
  }

  private batchCandidates(options: EpubTranslationBatchOptions): Array<{
    geometry: RecordGeometry;
    distance: number;
    priority: number;
    record: EpubTranslationRecord;
  }> {
    const candidates: Array<{
      distance: number;
      geometry: RecordGeometry;
      priority: number;
      record: EpubTranslationRecord;
    }> = [];
    const root = this.scrollRoot.getBoundingClientRect();
    const lookaheadViewports = previewTranslationLookaheadViewports(
      this.currentScrollVelocity(),
      options.estimatedLatencyMs,
    );
    for (const record of this.records.values()) {
      if (!record.element || record.completed || record.pending) continue;
      if (record.language && languageTagMatchesTranslationLanguage(record.language, this.targetLanguage)) continue;
      if (options.retryOnly ? !record.retryRequested : record.failed && !record.retryRequested) continue;
      const geometry = this.recordGeometry(record);
      if (!geometry) continue;
      const priority = record.retryRequested || options.retryOnly
        ? 0
        : priorityForGeometry(geometry, root, this.direction, lookaheadViewports);
      if (priority === null || (options.visibleOnly && priority !== 0)) continue;
      candidates.push({
        distance: distanceForGeometry(geometry, root),
        geometry,
        priority,
        record,
      });
    }
    candidates.sort((left, right) => (
      left.priority - right.priority
      || left.distance - right.distance
      || left.record.id.localeCompare(right.record.id)
    ));
    return candidates;
  }

  private queueVisibleRecords(estimatedLatencyMs: number): void {
    const root = this.scrollRoot.getBoundingClientRect();
    const lookaheadViewports = previewTranslationLookaheadViewports(
      this.currentScrollVelocity(),
      estimatedLatencyMs,
    );
    this.withAnchoredWrite(() => {
      for (const record of this.records.values()) {
        if (!record.element || record.completed || record.pending || record.failed) continue;
        const geometry = this.recordGeometry(record);
        const shouldQueue = Boolean(
          geometry
          && priorityForGeometry(geometry, root, this.direction, lookaheadViewports) === 0
          && !(record.language && languageTagMatchesTranslationLanguage(record.language, this.targetLanguage)),
        );
        if (record.queued === shouldQueue) continue;
        record.queued = shouldQueue;
        this.renderRecord(record);
      }
    });
  }

  private preemptibleRequest(activeBatches: readonly EpubTranslationActiveBatch[]): string | null {
    const root = this.scrollRoot.getBoundingClientRect();
    let selectedDistance = -1;
    let selectedRequestId: string | null = null;
    for (const batch of activeBatches) {
      if (batch.ids.length === 0) continue;
      let batchDistance = Number.POSITIVE_INFINITY;
      let visible = false;
      for (const id of batch.ids) {
        const record = this.records.get(id);
        const geometry = record ? this.recordGeometry(record) : null;
        if (!geometry) continue;
        if (geometry.bottom > root.top && geometry.top < root.bottom) {
          visible = true;
          break;
        }
        batchDistance = Math.min(batchDistance, distanceForGeometry(geometry, root));
      }
      if (!visible && batchDistance > selectedDistance) {
        selectedDistance = batchDistance;
        selectedRequestId = batch.requestId;
      }
    }
    return selectedRequestId;
  }

  private currentScrollVelocity(): number {
    return Date.now() - this.lastScrollAt > 2_000 ? 0 : this.scrollVelocityViewportsPerMs;
  }

  private recordGeometry(record: EpubTranslationRecord): RecordGeometry | null {
    const element = record.element;
    const registration = this.sections.get(record.sectionIndex);
    if (!element?.isConnected || !registration?.frame.isConnected) return null;
    const frameRect = registration.frame.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const top = frameRect.top + elementRect.top;
    return { top, bottom: top + elementRect.height };
  }

  private refreshCurrentRecord(record: EpubTranslationRecord): boolean {
    const element = record.element;
    const registration = this.sections.get(record.sectionIndex);
    if (
      !element?.isConnected
      || !registration?.frame.isConnected
      || record.text !== currentRecordText(record)
    ) return false;
    record.language = nearestLanguage(element)
      ?? declaredDocumentLanguage(registration.doc)
      ?? this.bookLanguages[0]
      ?? null;
    return true;
  }

  private discardStaleRecord(record: EpubTranslationRecord): void {
    removeOwnedNodes(record);
    record.completed = false;
    record.element = null;
    record.failed = false;
    record.pending = false;
    record.queued = false;
    record.retryRequested = false;
    record.translation = null;
    const registration = this.sections.get(record.sectionIndex);
    if (registration) registration.dirty = true;
  }

  private renderRecord(record: EpubTranslationRecord): void {
    if (!record.element?.isConnected) return;
    if (record.language && languageTagMatchesTranslationLanguage(record.language, this.targetLanguage)) {
      removeStatusNode(record);
      record.translationNode?.remove();
      record.translationNode = null;
      return;
    }
    if (record.completed && record.translation && record.translation !== normalizeText(record.text)) {
      this.ensureTranslationNode(record);
    }
    if (!this.enabled) {
      removeStatusNode(record);
      return;
    }
    if (record.pending || record.queued) this.ensureStatusNode(record, 'loading');
    else if (record.failed) this.ensureStatusNode(record, 'error');
    else removeStatusNode(record);
  }

  private ensureTranslationNode(record: EpubTranslationRecord): boolean {
    const source = record.element;
    if (!source?.isConnected || !record.translation) return false;
    let translation = record.translationNode;
    const inserted = !translation?.isConnected;
    if (inserted) {
      translation = source.ownerDocument.createElement('span');
      translation.setAttribute(TRANSLATION_ATTRIBUTE, 'true');
      if (/^(CAPTION|DD|DT|FIGCAPTION|LI|TD|TH)$/u.test(source.tagName)) source.append(translation);
      else source.insertAdjacentElement('afterend', translation);
      record.translationNode = translation;
    }
    if (!translation) return false;
    translation.setAttribute('lang', this.targetLanguage);
    translation.textContent = record.translation;
    return inserted;
  }

  private ensureStatusNode(record: EpubTranslationRecord, state: 'error' | 'loading'): void {
    const source = record.element;
    if (!source?.isConnected) return;
    let status = record.statusNode;
    if (!status?.isConnected) {
      status = source.ownerDocument.createElement('button');
      status.type = 'button';
      status.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.enabled || !record.failed || record.pending) return;
        record.retryRequested = true;
        record.queued = true;
        this.ensureStatusNode(record, 'loading');
        this.workAvailableHandler();
      });
      source.append(status);
      record.statusNode = status;
    }
    status.setAttribute(STATUS_ATTRIBUTE, state);
    status.disabled = state === 'loading';
    status.tabIndex = state === 'error' ? 0 : -1;
    updateStatusNodeLabels(status, state, this.labels);
  }

  private installSectionInputListeners(doc: Document): () => void {
    const handleInput = () => this.invalidateCorrection();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.repeat && matchesShortcutEvent(event, 'global.toggle_page_translation')) {
        if (this.shortcutHandler()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (SCROLL_KEYS.has(event.key)) handleInput();
    };
    doc.addEventListener('wheel', handleInput, { passive: true });
    doc.addEventListener('touchstart', handleInput, { passive: true });
    doc.addEventListener('pointerdown', handleInput, { passive: true });
    doc.addEventListener('keydown', handleKeyDown, true);
    return () => {
      doc.removeEventListener('wheel', handleInput);
      doc.removeEventListener('touchstart', handleInput);
      doc.removeEventListener('pointerdown', handleInput);
      doc.removeEventListener('keydown', handleKeyDown, true);
    };
  }

  private readonly handleScroll = () => {
    const nextScrollTop = this.scrollRoot.scrollTop;
    if (this.ownScrollTarget !== null && Math.abs(nextScrollTop - this.ownScrollTarget) <= 2) {
      this.ownScrollTarget = null;
      this.lastScrollTop = nextScrollTop;
      return;
    }
    const delta = nextScrollTop - this.lastScrollTop;
    if (Math.abs(delta) >= 2) {
      const now = Date.now();
      const elapsed = Math.max(1, now - this.lastScrollAt);
      const viewportHeight = Math.max(1, this.scrollRoot.getBoundingClientRect().height);
      const nextDirection = delta > 0 ? 'down' : 'up';
      const sample = Math.min(0.02, Math.abs(delta) / viewportHeight / elapsed);
      this.scrollVelocityViewportsPerMs = this.direction === nextDirection
        ? this.scrollVelocityViewportsPerMs * 0.65 + sample * 0.35
        : sample;
      this.direction = nextDirection;
      this.lastScrollAt = now;
    }
    this.lastScrollTop = nextScrollTop;
    this.invalidateCorrection();
    this.workAvailableHandler();
  };

  private readonly handleUserInput = () => this.invalidateCorrection();

  private readonly handleHostKeyDown = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) this.invalidateCorrection();
  };

  private invalidateCorrection(): void {
    this.inputRevision += 1;
    this.cancelCorrection();
  }

  private withAnchoredWrite(write: () => void): void {
    const anchor = this.captureAnchor();
    const inputRevision = this.inputRevision;
    write();
    if (anchor) this.scheduleCorrection(anchor, inputRevision, 3);
  }

  private captureAnchor(): TranslationAnchor | null {
    const rootRect = this.scrollRoot.getBoundingClientRect();
    const visible: Array<{ id: string; top: number }> = [];
    for (const record of this.records.values()) {
      const geometry = this.recordGeometry(record);
      if (!geometry || geometry.bottom <= rootRect.top || geometry.top >= rootRect.bottom) continue;
      visible.push({ id: record.id, top: geometry.top });
    }
    visible.sort((left, right) => left.top - right.top);
    return visible[0] ?? null;
  }

  private scheduleCorrection(anchor: TranslationAnchor, inputRevision: number, frames: number): void {
    this.cancelCorrection();
    const view = this.scrollRoot.ownerDocument.defaultView ?? window;
    const revision = ++this.correctionRevision;
    const correct = (remaining: number) => {
      this.correctionFrame = null;
      if (revision !== this.correctionRevision || inputRevision !== this.inputRevision) return;
      const record = this.records.get(anchor.id);
      const geometry = record ? this.recordGeometry(record) : null;
      if (!geometry) return;
      const delta = geometry.top - anchor.top;
      if (Math.abs(delta) > 0.5) this.scrollBy(delta);
      if (remaining > 1) this.correctionFrame = view.requestAnimationFrame(() => correct(remaining - 1));
    };
    this.correctionFrame = view.requestAnimationFrame(() => correct(frames));
  }

  private scrollBy(delta: number): void {
    const target = this.scrollRoot.scrollTop + delta;
    this.ownScrollTarget = target;
    this.scrollRoot.scrollTop = target;
    this.lastScrollTop = target;
  }

  private cancelCorrection(): void {
    this.correctionRevision += 1;
    if (this.correctionFrame === null) return;
    const view = this.scrollRoot.ownerDocument.defaultView ?? window;
    view.cancelAnimationFrame(this.correctionFrame);
    this.correctionFrame = null;
  }
}

function emptyBatch(): EpubTranslationBatch {
  return { blocks: [], preemptRequestId: null, priority: null };
}

function priorityForGeometry(
  geometry: RecordGeometry,
  root: DOMRect,
  direction: 'down' | 'neutral' | 'up',
  aheadViewports: number,
): number | null {
  if (geometry.bottom > root.top && geometry.top < root.bottom) return 0;
  const viewportHeight = Math.max(1, root.height);
  if (direction === 'down') {
    if (geometry.top >= root.bottom && geometry.top <= root.bottom + viewportHeight * aheadViewports) return 1;
    if (geometry.bottom <= root.top && geometry.bottom >= root.top - viewportHeight) return 2;
    return null;
  }
  if (direction === 'up') {
    if (geometry.bottom <= root.top && geometry.bottom >= root.top - viewportHeight * aheadViewports) return 1;
    if (geometry.top >= root.bottom && geometry.top <= root.bottom + viewportHeight) return 2;
    return null;
  }
  return geometry.bottom >= root.top - viewportHeight * aheadViewports
    && geometry.top <= root.bottom + viewportHeight * aheadViewports
    ? 1
    : null;
}

function distanceForGeometry(geometry: RecordGeometry, root: DOMRect): number {
  if (geometry.bottom > root.top && geometry.top < root.bottom) {
    return Math.max(0, geometry.top - root.top);
  }
  if (geometry.bottom <= root.top) return Math.max(0, root.top - geometry.bottom);
  return Math.max(0, geometry.top - root.bottom);
}

function isEligibleCandidate(element: HTMLElement): boolean {
  if (element.matches(OWNED_SELECTOR) || element.closest(EXCLUDED_SELECTOR)) return false;
  if (element.ownerDocument.designMode?.toLowerCase() === 'on' || isEditable(element)) return false;
  if (hasHiddenPresentation(element)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function sourceText(element: HTMLElement): string {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const NodeFilterRef = view?.NodeFilter ?? NodeFilter;
  const walker = doc.createTreeWalker(element, NodeFilterRef.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(OWNED_SELECTOR) || parent.closest(EXCLUDED_SELECTOR)) continue;
    if (isEditable(parent, element)) continue;
    if (hasHiddenPresentation(parent, element)) continue;
    let nestedCandidate = false;
    for (let ancestor: Element | null = parent; ancestor && ancestor !== element; ancestor = ancestor.parentElement) {
      if (ancestor.matches(CANDIDATE_SELECTOR)) {
        nestedCandidate = true;
        break;
      }
    }
    if (!nestedCandidate) parts.push(node.nodeValue ?? '');
  }
  return normalizeText(parts.join(' '));
}

function currentRecordText(record: EpubTranslationRecord): string {
  return record.element ? sourceText(record.element) : '';
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function nearestLanguage(element: Element): string | null {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const language = declaredElementLanguage(current);
    if (language) return language;
  }
  return null;
}

function declaredDocumentLanguage(doc: Document): string | null {
  return declaredElementLanguage(doc.documentElement);
}

function declaredElementLanguage(element: Element): string | null {
  for (const attribute of ['lang', 'xml:lang']) {
    const value = element.getAttribute(attribute);
    if (isValidLanguageTag(value)) return value;
  }
  return null;
}

function hasHiddenPresentation(element: Element, boundary?: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (
      current.hasAttribute('hidden')
      || current.hasAttribute('inert')
      || current.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true'
    ) return true;
    const style = view?.getComputedStyle(current);
    if (
      style?.display === 'none'
      || style?.visibility === 'hidden'
      || style?.visibility === 'collapse'
      || style?.contentVisibility === 'hidden'
    ) return true;
    if (current === boundary) break;
  }
  return false;
}

function isEditable(element: Element, boundary?: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) {
    const value = current.getAttribute('contenteditable');
    if (value !== null) {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'false') return false;
      if (normalized === '' || normalized === 'true' || normalized === 'plaintext-only') return true;
    }
    if (current === boundary) break;
  }
  return false;
}

function textHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function removeStatusNode(record: EpubTranslationRecord): void {
  record.statusNode?.remove();
  record.statusNode = null;
}

function removeOwnedNodes(record: EpubTranslationRecord): void {
  removeStatusNode(record);
  record.translationNode?.remove();
  record.translationNode = null;
}

function updateStatusNodeLabels(
  status: HTMLButtonElement,
  state: 'error' | 'loading',
  labels: UrlPageTranslationGuestLabels,
): void {
  const label = state === 'error' ? labels.retry : labels.translating;
  status.setAttribute('aria-label', label);
  status.title = label;
}

function mutationOnlyTouchesOwnedNodes(mutation: MutationRecord): boolean {
  const target = mutation.target.nodeType === 1 ? mutation.target as Element : mutation.target.parentElement;
  if (target?.closest(OWNED_SELECTOR)) return true;
  if (mutation.type === 'characterData') return Boolean(mutation.target.parentElement?.closest(OWNED_SELECTOR));
  const changed = [...mutation.addedNodes, ...mutation.removedNodes];
  return changed.length > 0 && changed.every((node) => (
    node.nodeType === 1
      ? (node as Element).matches(OWNED_SELECTOR)
      : Boolean(node.parentElement?.closest(OWNED_SELECTOR))
  ));
}
