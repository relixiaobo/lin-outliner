import { useEffect, useRef, useState } from 'react';
import type { PreviewRendererProps } from './previewRenderers';
import { MetadataPreview, PreviewMessage } from './previewRenderers';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';

type FoliateViewElement = HTMLElement & {
  close?: () => void;
  next?: (distance?: number) => Promise<void>;
  open: (book: Blob | File | string) => Promise<void>;
  prev?: (distance?: number) => Promise<void>;
  init?: (options: { showTextStart?: boolean }) => Promise<void>;
  renderer?: HTMLElement;
};

type EpubState =
  | { status: 'loading' }
  | { status: 'ready'; blob: Blob }
  | { status: 'error'; error?: string };

type FoliateRelocateEvent = CustomEvent<{
  index?: unknown;
  section?: { current?: unknown; total?: unknown };
}>;

type FoliateLoadEvent = CustomEvent<{
  doc?: unknown;
  index?: unknown;
}>;

let foliateViewModulePromise: Promise<void> | null = null;

function loadFoliateView(): Promise<void> {
  foliateViewModulePromise ??= import('foliate-js/view.js').then(() => undefined);
  return foliateViewModulePromise;
}

function isFoliateViewElement(element: HTMLElement): element is FoliateViewElement {
  return typeof (element as Partial<FoliateViewElement>).open === 'function';
}

export function EpubPreview({ displayMode, source }: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const [state, setState] = useState<EpubState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      const result = await api.readPreviewBytes(source.target);
      if (!result.bytes) throw new Error(result.error ?? 'missing');
      const blob = new Blob([result.bytes], { type: result.mimeType ?? source.mimeType });

      if (!cancelled) setState({ status: 'ready', blob });
    })().catch((error: unknown) => {
      if (!cancelled) setState({ status: 'error', error: error instanceof Error ? error.message : undefined });
    });

    return () => {
      cancelled = true;
    };
  }, [source.mimeType, source.target]);

  if (state.status === 'loading') return <PreviewMessage>{labels.loading}</PreviewMessage>;
  if (state.status === 'error') {
    return (
      <div className="file-preview-unavailable-metadata">
        <MetadataPreview source={source} />
        <p className="file-preview-unavailable-note">{state.error === 'too-large' ? labels.tooLarge : labels.unavailable}</p>
      </div>
    );
  }

  return (
    <EpubReader
      blob={state.blob}
      displayMode={displayMode}
      name={source.name}
    />
  );
}

function EpubReader({
  blob,
  displayMode,
  name,
}: {
  blob: Blob;
  displayMode: PreviewRendererProps['displayMode'];
  name: string;
}) {
  const labels = useT().shell.filePreview;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const displayModeRef = useRef(displayMode);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [sectionIndex, setSectionIndex] = useState(0);
  displayModeRef.current = displayMode;

  useEffect(() => {
    let cancelled = false;
    let view: FoliateViewElement | null = null;
    let loadedDocument: Document | null = null;
    const wheelNavigation: EpubWheelNavigation = { busy: false, pending: null };
    const releaseEventHandlers: Array<() => void> = [];
    setState('loading');
    setSectionIndex(0);

    void (async () => {
      await loadFoliateView();
      if (cancelled) return;

      const host = hostRef.current;
      if (!host) return;
      const element = document.createElement('foliate-view');
      if (!isFoliateViewElement(element)) throw new Error('foliate-view unavailable');
      element.className = 'file-preview-epub-view';
      element.dataset.epubDisplayMode = displayMode;
      element.addEventListener('external-link', handleEpubExternalLink as EventListener);
      const handleWheel = (event: WheelEvent) => handleEpubWheel(event, element, wheelNavigation);
      const handleLoad = (event: FoliateLoadEvent) => {
        const doc = event.detail?.doc;
        if (!isEpubDocument(doc)) return;
        if (loadedDocument === doc) return;
        loadedDocument?.removeEventListener('wheel', handleWheel);
        loadedDocument = doc;
        doc.addEventListener('wheel', handleWheel, { passive: false });
      };
      const handleRelocate = (event: FoliateRelocateEvent) => {
        const index = event.detail?.section?.current ?? event.detail?.index;
        if (typeof index === 'number' && Number.isFinite(index)) setSectionIndex(Math.max(0, index));
      };
      element.addEventListener('wheel', handleWheel, { passive: false });
      element.addEventListener('load', handleLoad as EventListener);
      element.addEventListener('relocate', handleRelocate as EventListener);
      releaseEventHandlers.push(
        () => element.removeEventListener('wheel', handleWheel),
        () => element.removeEventListener('load', handleLoad as EventListener),
        () => element.removeEventListener('relocate', handleRelocate as EventListener),
        () => loadedDocument?.removeEventListener('wheel', handleWheel),
      );
      view = element;
      viewRef.current = element;
      host.replaceChildren(element);
      await element.open(new File([blob], name || 'book.epub', { type: 'application/epub+zip' }));
      configureFoliateRenderer(element, displayModeRef.current);
      if (element.init) await element.init({ showTextStart: true });
      if (!cancelled) setState('ready');
    })().catch(() => {
      if (!cancelled) setState('error');
    });

    return () => {
      cancelled = true;
      wheelNavigation.busy = false;
      wheelNavigation.pending = null;
      if (view) {
        view.removeEventListener('external-link', handleEpubExternalLink as EventListener);
        view.close?.();
      }
      for (const release of releaseEventHandlers.splice(0)) release();
      if (viewRef.current === view) viewRef.current = null;
      hostRef.current?.replaceChildren();
    };
  }, [blob, name]);

  useEffect(() => {
    if (state !== 'ready' || !viewRef.current) return;
    configureFoliateRenderer(viewRef.current, displayMode);
  }, [displayMode, state]);

  return (
    <div className={`file-preview-epub file-preview-epub--${displayMode}`} data-preserve-selection>
      {state === 'loading' ? <PreviewMessage>{labels.loading}</PreviewMessage> : null}
      {state === 'error' ? <PreviewMessage>{labels.unavailable}</PreviewMessage> : null}
      <div
        aria-hidden={state !== 'ready'}
        aria-label={labels.epubPreviewAlt({ name })}
        className="file-preview-epub-host"
        data-epub-scroll-reader={displayMode === 'full' ? 'true' : undefined}
        data-epub-section={displayMode === 'full' ? String(sectionIndex + 1) : undefined}
        ref={hostRef}
      />
    </div>
  );
}

function handleEpubExternalLink(event: CustomEvent<{ href?: unknown }>) {
  event.preventDefault();
  const href = event.detail?.href;
  if (typeof href === 'string') void api.openExternalUrl(href);
}

type EpubWheelNavigation = {
  busy: boolean;
  pending: { direction: 1 | -1; distance: number } | null;
};

function isEpubDocument(value: unknown): value is Document {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Document>;
  return typeof candidate.addEventListener === 'function'
    && typeof candidate.removeEventListener === 'function'
    && candidate.documentElement?.nodeType === Node.ELEMENT_NODE;
}

function handleEpubWheel(event: WheelEvent, view: FoliateViewElement, navigation: EpubWheelNavigation) {
  if (view.dataset.epubDisplayMode !== 'full') return;
  if (event.defaultPrevented) return;
  const primaryDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (Math.abs(primaryDelta) < 1) return;

  event.preventDefault();
  const step = { direction: primaryDelta > 0 ? 1 as const : -1 as const, distance: Math.max(1, Math.abs(primaryDelta)) };
  if (navigation.busy) {
    navigation.pending = step;
    return;
  }
  runEpubWheelNavigation(view, navigation, step);
}

function runEpubWheelNavigation(
  view: FoliateViewElement,
  navigation: EpubWheelNavigation,
  step: { direction: 1 | -1; distance: number },
) {
  navigation.busy = true;
  const action = step.direction > 0 ? view.next : view.prev;
  const promise = action ? action.call(view, step.distance) : Promise.resolve();
  void promise
    .catch(() => undefined)
    .finally(() => {
      const pending = navigation.pending;
      navigation.pending = null;
      navigation.busy = false;
      if (pending && view.isConnected) runEpubWheelNavigation(view, navigation, pending);
    });
}

function configureFoliateRenderer(view: FoliateViewElement, displayMode: PreviewRendererProps['displayMode']) {
  const renderer = view.renderer;
  if (!renderer) return;
  view.dataset.epubDisplayMode = displayMode;
  renderer.setAttribute('flow', 'scrolled');
  renderer.setAttribute('max-inline-size', displayMode === 'summary' ? '560px' : '720px');
  renderer.setAttribute('max-column-count', '1');
  renderer.setAttribute('margin', '0px');
}
