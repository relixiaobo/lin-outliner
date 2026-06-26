import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PreviewRendererProps } from './previewRenderers';
import { MetadataPreview, PreviewMessage } from './previewRenderers';
import { DocumentOutlineRail, type DocumentOutlineItem } from './DocumentOutlineRail';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';

type EpubState =
  | { status: 'loading' }
  | { status: 'ready'; blob: Blob }
  | { status: 'error'; error?: string };

type EpubReaderState =
  | { status: 'loading' }
  | { status: 'ready'; book: EpubBook; sections: EpubReadableSection[] }
  | { status: 'error' };

type EpubBook = {
  destroy?: () => void;
  isExternal?: (href: string) => boolean;
  resolveHref?: (href: string) => { index?: unknown; anchor?: unknown } | undefined;
  sections?: unknown[];
  toc?: unknown[];
  transformTarget?: EventTarget;
};

type EpubSection = {
  id?: string;
  linear?: string;
  load: () => Promise<string> | string;
  resolveHref?: (href: string) => string;
  unload?: () => void;
};

type EpubReadableSection = {
  index: number;
  number: number;
  section: EpubSection;
};

type EpubOutlineTarget = {
  href: string;
};

type EpubTocItem = {
  href?: unknown;
  label?: unknown;
  subitems?: unknown;
};

type EpubMakeBook = (book: Blob | File | string) => Promise<EpubBook>;

type EpubDocumentSetupOptions = {
  book: EpubBook;
  displayMode: PreviewRendererProps['displayMode'];
  doc: Document;
  measureHeight: () => void;
  onNavigate: (href: string) => void;
  section: EpubSection;
};

let foliateMakeBookPromise: Promise<EpubMakeBook> | null = null;

function loadFoliateMakeBook(): Promise<EpubMakeBook> {
  foliateMakeBookPromise ??= import('foliate-js/view.js').then((module) => {
    const makeBook = (module as { makeBook?: unknown }).makeBook;
    if (typeof makeBook !== 'function') throw new Error('foliate makeBook unavailable');
    return makeBook as EpubMakeBook;
  });
  return foliateMakeBookPromise;
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
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const frameRefs = useRef(new Map<number, HTMLIFrameElement>());
  const [state, setState] = useState<EpubReaderState>({ status: 'loading' });
  const [outlineLayoutVersion, setOutlineLayoutVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let book: EpubBook | null = null;
    let releaseTransform: (() => void) | null = null;
    setState({ status: 'loading' });

    void (async () => {
      const makeBook = await loadFoliateMakeBook();
      if (cancelled) return;

      book = await makeBook(new File([blob], name || 'book.epub', { type: 'application/epub+zip' }));
      releaseTransform = registerEpubCssTransform(book);
      const sections = readableEpubSections(book);
      if (sections.length === 0) throw new Error('empty-epub');
      if (!cancelled) setState({ status: 'ready', book, sections });
    })().catch(() => {
      if (!cancelled) setState({ status: 'error' });
    });

    return () => {
      cancelled = true;
      releaseTransform?.();
      book?.destroy?.();
      frameRefs.current.clear();
    };
  }, [blob, name]);

  const registerFrame = useCallback((sectionIndex: number, frame: HTMLIFrameElement | null) => {
    if (frame) frameRefs.current.set(sectionIndex, frame);
    else frameRefs.current.delete(sectionIndex);
  }, []);

  const handleNavigation = useCallback((href: string) => {
    if (state.status !== 'ready') return;
    scrollToEpubTarget({
      book: state.book,
      frameRefs: frameRefs.current,
      href,
      scrollRoot: scrollRootRef.current,
    });
  }, [state]);
  const noteOutlineLayoutChange = useCallback(() => {
    setOutlineLayoutVersion((version) => version + 1);
  }, []);
  const outlineItems = useMemo(() => (
    state.status === 'ready' && displayMode === 'full'
      ? epubOutlineItems(state.book)
      : []
  ), [displayMode, state]);
  const resolveOutlineTop = useCallback((item: DocumentOutlineItem) => {
    if (state.status !== 'ready' || !state.book.resolveHref) return null;
    const href = (item.target as Partial<EpubOutlineTarget>).href;
    if (typeof href !== 'string') return null;
    const resolved = state.book.resolveHref(href);
    const sectionIndex = resolved?.index;
    if (typeof sectionIndex !== 'number' || !Number.isFinite(sectionIndex)) return null;

    const frame = frameRefs.current.get(sectionIndex);
    const sectionElement = frame?.closest<HTMLElement>('.file-preview-epub-section');
    if (!frame || !sectionElement) return null;
    return sectionElement.offsetTop + epubAnchorOffset(frame, resolved?.anchor);
  }, [state]);

  const sections = state.status === 'ready'
    ? displayMode === 'summary' ? state.sections.slice(0, 1) : state.sections
    : [];
  const ready = state.status === 'ready';

  return (
    <div className={`file-preview-epub file-preview-epub--${displayMode}`} data-preserve-selection>
      {state.status === 'loading' ? <PreviewMessage>{labels.loading}</PreviewMessage> : null}
      {state.status === 'error' ? <PreviewMessage>{labels.unavailable}</PreviewMessage> : null}
      <div
        aria-hidden={!ready}
        aria-label={labels.epubPreviewAlt({ name })}
        className="file-preview-epub-host"
        data-epub-continuous-reader={displayMode === 'full' && ready ? 'true' : undefined}
        data-epub-section-count={displayMode === 'full' && ready ? String(sections.length) : undefined}
        ref={scrollRootRef}
      >
        {ready ? sections.map(({ index, number, section }) => (
          <EpubSectionFrame
            book={state.book}
            displayMode={displayMode}
            key={index}
            name={name}
            onLayoutChange={noteOutlineLayoutChange}
            onNavigate={handleNavigation}
            registerFrame={registerFrame}
            section={section}
            sectionIndex={index}
            sectionNumber={number}
          />
        )) : null}
      </div>
      {displayMode === 'full' && outlineItems.length > 0 ? (
        <DocumentOutlineRail
          items={outlineItems}
          layoutVersion={outlineLayoutVersion}
          resolveItemTop={resolveOutlineTop}
          scrollRootRef={scrollRootRef}
        />
      ) : null}
    </div>
  );
}

function EpubSectionFrame({
  book,
  displayMode,
  name,
  onLayoutChange,
  onNavigate,
  registerFrame,
  section,
  sectionIndex,
  sectionNumber,
}: {
  book: EpubBook;
  displayMode: PreviewRendererProps['displayMode'];
  name: string;
  onLayoutChange: () => void;
  onNavigate: (href: string) => void;
  registerFrame: (sectionIndex: number, frame: HTMLIFrameElement | null) => void;
  section: EpubSection;
  sectionIndex: number;
  sectionNumber: number;
}) {
  const labels = useT().shell.filePreview;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const releaseDocumentRef = useRef<(() => void) | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [height, setHeight] = useState<number | null>(null);

  const setIframeRef = useCallback((frame: HTMLIFrameElement | null) => {
    iframeRef.current = frame;
    registerFrame(sectionIndex, frame);
  }, [registerFrame, sectionIndex]);

  const applyDocumentSetup = useCallback(() => {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) {
      setState('error');
      return;
    }

    releaseDocumentRef.current?.();
    const measureHeight = () => {
      const nextHeight = measureEpubDocumentHeight(doc);
      setHeight((previousHeight) => previousHeight === nextHeight ? previousHeight : nextHeight);
    };
    releaseDocumentRef.current = setupEpubDocument({
      book,
      displayMode,
      doc,
      measureHeight,
      onNavigate,
      section,
    });
    measureHeight();
    setState('ready');
  }, [book, displayMode, onNavigate, section]);

  useEffect(() => {
    let cancelled = false;
    releaseDocumentRef.current?.();
    releaseDocumentRef.current = null;
    setState('loading');
    setHeight(null);
    setSrc(null);

    void Promise.resolve(section.load()).then((loadedSrc) => {
      if (!cancelled) setSrc(loadedSrc);
    }).catch(() => {
      if (!cancelled) setState('error');
    });

    return () => {
      cancelled = true;
      releaseDocumentRef.current?.();
      releaseDocumentRef.current = null;
      registerFrame(sectionIndex, null);
      section.unload?.();
    };
  }, [registerFrame, section, sectionIndex]);

  useEffect(() => {
    if (state !== 'ready') return;
    applyDocumentSetup();
  }, [applyDocumentSetup, state]);

  useEffect(() => {
    if (height !== null) onLayoutChange();
  }, [height, onLayoutChange]);

  const frameStyle = displayMode === 'full' && height ? { height: `${height}px` } : undefined;
  const iframeStyle = height ? { height: `${height}px` } : undefined;

  return (
    <div
      className="file-preview-epub-section"
      data-epub-section-number={sectionNumber}
    >
      <div className="file-preview-epub-frame" style={frameStyle}>
        {state === 'loading' ? <PreviewMessage>{labels.loading}</PreviewMessage> : null}
        {state === 'error' ? <PreviewMessage>{labels.unavailable}</PreviewMessage> : null}
        {src ? (
          <iframe
            className="file-preview-epub-iframe"
            onLoad={applyDocumentSetup}
            ref={setIframeRef}
            sandbox="allow-same-origin allow-scripts"
            scrolling="no"
            src={src}
            style={iframeStyle}
            title={`${name} EPUB section ${sectionNumber}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function isEpubSection(value: unknown): value is EpubSection {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Partial<EpubSection>).load === 'function';
}

function readableEpubSections(book: EpubBook): EpubReadableSection[] {
  const sections = Array.isArray(book.sections) ? book.sections : [];
  return sections
    .map((section, index) => ({ index, section }))
    .filter((entry): entry is { index: number; section: EpubSection } => (
      isEpubSection(entry.section) && entry.section.linear !== 'no'
    ))
    .map((entry, offset) => ({ ...entry, number: offset + 1 }));
}

function epubOutlineItems(book: EpubBook): DocumentOutlineItem[] {
  const toc = Array.isArray(book.toc) ? book.toc : [];
  const items: DocumentOutlineItem[] = [];
  const visit = (tocItems: unknown[], level: number) => {
    for (const tocItem of tocItems) {
      if (!isEpubTocItem(tocItem)) continue;
      const href = typeof tocItem.href === 'string' ? tocItem.href : null;
      const title = epubTocLabel(tocItem.label) ?? href;
      if (href && title) {
        items.push({
          id: `epub-outline-${items.length}:${href}`,
          level,
          target: { href } satisfies EpubOutlineTarget,
          title,
        });
      }
      if (Array.isArray(tocItem.subitems)) visit(tocItem.subitems, level + 1);
    }
  };
  visit(toc, 0);
  return items;
}

function isEpubTocItem(value: unknown): value is EpubTocItem {
  return Boolean(value && typeof value === 'object');
}

function epubTocLabel(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
    }
  }
  return null;
}

function setupEpubDocument({
  book,
  displayMode,
  doc,
  measureHeight,
  onNavigate,
  section,
}: EpubDocumentSetupOptions): () => void {
  const style = doc.createElement('style');
  style.textContent = epubDocumentStyle(displayMode);
  doc.head?.append(style);

  const handleClick = (event: MouseEvent) => {
    const anchor = closestHrefAnchor(event.target);
    const rawHref = anchor?.getAttribute('href');
    if (!rawHref) return;

    event.preventDefault();
    const href = section.resolveHref?.(rawHref) ?? rawHref;
    if (isExternalEpubHref(book, href)) void api.openExternalUrl(href);
    else onNavigate(href);
  };

  let animationFrame: number | null = null;
  const scheduleMeasure = () => {
    if (animationFrame !== null) return;
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = null;
      measureHeight();
    });
  };

  doc.addEventListener('click', handleClick);
  const observer = new ResizeObserver(scheduleMeasure);
  observer.observe(doc.documentElement);
  if (doc.body) observer.observe(doc.body);
  doc.defaultView?.addEventListener('resize', scheduleMeasure);
  void doc.fonts?.ready.then(scheduleMeasure).catch(() => undefined);
  scheduleMeasure();

  return () => {
    if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    doc.removeEventListener('click', handleClick);
    doc.defaultView?.removeEventListener('resize', scheduleMeasure);
    observer.disconnect();
    style.remove();
  };
}

function epubDocumentStyle(displayMode: PreviewRendererProps['displayMode']) {
  const inlinePadding = displayMode === 'summary' ? 24 : 56;
  const blockPadding = displayMode === 'summary' ? 24 : 48;
  const maxInlineSize = displayMode === 'summary' ? 560 : 720;
  return `
    :root {
      color-scheme: light;
      background: transparent !important;
    }
    html,
    body {
      box-sizing: border-box !important;
      min-height: 0 !important;
      margin: 0 !important;
      overflow: hidden !important;
      background: transparent !important;
    }
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    body {
      width: 100% !important;
      max-width: ${maxInlineSize}px !important;
      margin-inline: auto !important;
      padding: ${blockPadding}px ${inlinePadding}px !important;
      color: black;
      background: white !important;
      overflow-wrap: anywhere;
    }
    img,
    svg,
    video,
    canvas {
      max-width: 100% !important;
      height: auto;
    }
    table {
      max-width: 100%;
    }
    a {
      color: LinkText;
    }
  `;
}

function closestHrefAnchor(target: EventTarget | null): Element | null {
  if (!target || typeof (target as { closest?: unknown }).closest !== 'function') return null;
  return (target as Element).closest('a[href]');
}

function isExternalEpubHref(book: EpubBook, href: string): boolean {
  if (book.isExternal?.(href)) return true;
  try {
    return /^https?:$/i.test(new URL(href).protocol);
  } catch {
    return false;
  }
}

function measureEpubDocumentHeight(doc: Document): number {
  const html = doc.documentElement;
  const body = doc.body;
  if (!body) return Math.max(1, Math.ceil(html.getBoundingClientRect().height));

  const rootTop = html.getBoundingClientRect().top;
  const bodyStyle = doc.defaultView?.getComputedStyle(body);
  const bodyRect = body.getBoundingClientRect();
  const bodyBottomEdge = bodyRect.top - rootTop
    + cssPixelValue(bodyStyle?.paddingTop)
    + cssPixelValue(bodyStyle?.paddingBottom)
    + cssPixelValue(bodyStyle?.borderBottomWidth);
  const contentBottom = measureEpubContentBottom(doc, body, rootTop);
  const height = contentBottom > 0
    ? contentBottom + cssPixelValue(bodyStyle?.paddingBottom) + cssPixelValue(bodyStyle?.borderBottomWidth)
    : bodyBottomEdge;

  return Math.max(1, Math.ceil(height));
}

function measureEpubContentBottom(doc: Document, body: HTMLElement, rootTop: number): number {
  let bottom = 0;
  const includeRect = (rect: DOMRect | DOMRectReadOnly) => {
    if (rect.width <= 0 || rect.height <= 0) return;
    bottom = Math.max(bottom, rect.bottom - rootTop);
  };

  const range = doc.createRange();
  range.selectNodeContents(body);
  for (const rect of Array.from(range.getClientRects())) includeRect(rect);
  range.detach();

  for (const element of Array.from(body.querySelectorAll('*'))) {
    if (!isMeasurableEpubElement(element)) continue;
    for (const rect of Array.from(element.getClientRects())) includeRect(rect);
  }

  return bottom;
}

function isMeasurableEpubElement(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style || style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') return false;
  return ['canvas', 'embed', 'iframe', 'img', 'math', 'object', 'svg', 'table', 'video'].includes(element.localName);
}

function cssPixelValue(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scrollToEpubTarget({
  book,
  frameRefs,
  href,
  scrollRoot,
}: {
  book: EpubBook;
  frameRefs: Map<number, HTMLIFrameElement>;
  href: string;
  scrollRoot: HTMLElement | null;
}) {
  if (!scrollRoot || !book.resolveHref) return;
  const resolved = book.resolveHref(href);
  const sectionIndex = resolved?.index;
  if (typeof sectionIndex !== 'number' || !Number.isFinite(sectionIndex)) return;

  const frame = frameRefs.get(sectionIndex);
  const sectionElement = frame?.closest<HTMLElement>('.file-preview-epub-section');
  if (!frame || !sectionElement) return;

  const offset = epubAnchorOffset(frame, resolved?.anchor);
  scrollRoot.scrollTo({
    top: sectionElement.offsetTop + offset,
    behavior: 'smooth',
  });
}

function epubAnchorOffset(frame: HTMLIFrameElement, anchor: unknown): number {
  const doc = frame.contentDocument;
  if (!doc || typeof anchor !== 'function') return 0;
  const target = (anchor as (doc: Document) => unknown)(doc);
  if (!target || typeof target !== 'object') return 0;
  const rect = typeof (target as { getBoundingClientRect?: unknown }).getBoundingClientRect === 'function'
    ? (target as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect()
    : null;
  if (!rect) return 0;
  const docTop = doc.documentElement.getBoundingClientRect().top;
  return Math.max(0, rect.top - docTop);
}

function registerEpubCssTransform(book: EpubBook): () => void {
  const target = book.transformTarget;
  if (!target) return () => undefined;

  const handleData = (event: Event) => {
    const detail = (event as CustomEvent<{ data?: unknown; type?: unknown }>).detail;
    if (detail?.type !== 'text/css') return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    detail.data = Promise.resolve(detail.data).then((data) => {
      if (typeof data !== 'string') return data;
      return data
        .replace(/(?<=[{\s;])-epub-/gi, '')
        .replace(/(\d*\.?\d+)vw/gi, (_, value: string) => `${Number.parseFloat(value) * viewportWidth / 100}px`)
        .replace(/(\d*\.?\d+)vh/gi, (_, value: string) => `${Number.parseFloat(value) * viewportHeight / 100}px`);
    });
  };

  target.addEventListener('data', handleData as EventListener);
  return () => target.removeEventListener('data', handleData as EventListener);
}
