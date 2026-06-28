import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { PreviewRendererProps } from './previewRenderers';
import { MetadataPreview, PreviewMessage } from './previewRenderers';
import { DocumentOutlineRail, type DocumentOutlineItem } from './DocumentOutlineRail';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import {
  previewReadingPositionKey,
  readEpubReadingPosition,
  writeEpubReadingPosition,
  type EpubReadingPosition,
} from './readingPositionStore';

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

// Reading-column max-inline-size per display mode (matches `epubDocumentStyle`). The
// reader cap doubles as the `vw` resolution basis in `registerEpubCssTransform`.
const EPUB_READER_MAX_INLINE_SIZE = 720;
const EPUB_SUMMARY_MAX_INLINE_SIZE = 560;
// `vh` resolution basis in `registerEpubCssTransform`: the reader's visible viewport
// is bounded (the expanded reader caps at `min(70vh, 720px)`), so resolving `vh`
// against the full window would let a `height: 100vh` cover spill far past the reader
// and get clipped by the frame's `overflow: hidden`. The scrollport is not mounted
// yet when section CSS is transformed during book load, so this cap is an
// approximation of that height rather than a live measurement.
const EPUB_READER_MAX_BLOCK_SIZE = 720;
// Lazy mounting (mirrors the PDF page list): mount a section's iframe when its wrapper
// is within this margin of the scroll viewport, so opening a long book never spins up
// hundreds of live documents/observers at once. Mount-once — like the PDF canvases, a
// section stays mounted after it scrolls away.
const EPUB_LAZY_ROOT_MARGIN = '800px';
// Reserved height for a not-yet-mounted section so the scrollport keeps a real extent
// (a screenful per section). Without it every placeholder would collapse to ~0, drop
// all sections inside the lazy margin at once, and defeat the lazy mounting.
const EPUB_PLACEHOLDER_SECTION_HEIGHT = 720;

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
  const targetKey = previewReadingPositionKey(source.target);
  const savedReadingPositionRef = useRef<{ targetKey: string; position: EpubReadingPosition | null }>({
    targetKey,
    position: readEpubReadingPosition(targetKey),
  });

  if (savedReadingPositionRef.current.targetKey !== targetKey) {
    savedReadingPositionRef.current = {
      targetKey,
      position: readEpubReadingPosition(targetKey),
    };
  }

  const persistReadingPosition = useCallback((position: EpubReadingPosition) => {
    savedReadingPositionRef.current = { targetKey, position };
    writeEpubReadingPosition(targetKey, position);
  }, [targetKey]);

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
      initialReadingPosition={savedReadingPositionRef.current.position}
      name={source.name}
      onReadingPositionChange={persistReadingPosition}
    />
  );
}

function EpubReader({
  blob,
  displayMode,
  initialReadingPosition,
  name,
  onReadingPositionChange,
}: {
  blob: Blob;
  displayMode: PreviewRendererProps['displayMode'];
  initialReadingPosition: EpubReadingPosition | null;
  name: string;
  onReadingPositionChange: (position: EpubReadingPosition) => void;
}) {
  const labels = useT().shell.filePreview;
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const frameRefs = useRef(new Map<number, HTMLIFrameElement>());
  // Sections that have reported a measured height (or settled on error). The restore
  // effect waits on this so it only locks once the layout above the target is final.
  const measuredSectionsRef = useRef(new Map<number, number>());
  const [state, setState] = useState<EpubReaderState>({ status: 'loading' });
  const [outlineLayoutVersion, setOutlineLayoutVersion] = useState(0);
  const restoredFullSessionRef = useRef(0);
  const fullSessionRef = useRef(0);
  const scrollReportFrameRef = useRef<number | null>(null);

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
      measuredSectionsRef.current.clear();
    };
  }, [blob, name]);

  useEffect(() => {
    if (displayMode === 'full') fullSessionRef.current += 1;
  }, [blob, displayMode]);

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
  const reportSectionLayout = useCallback((sectionIndex: number, height: number | null) => {
    const measured = measuredSectionsRef.current;
    if (height === null) {
      // The section unmounted (e.g. a full→summary flip drops every section but the
      // first): forget it with no re-render so the restore gate tracks only the
      // sections currently in the scrollport.
      measured.delete(sectionIndex);
      return;
    }
    measured.set(sectionIndex, height);
    setOutlineLayoutVersion((version) => version + 1);
  }, []);
  const outlineItems = useMemo(() => (
    state.status === 'ready' && displayMode === 'full'
      ? epubOutlineItems(state.book)
      : []
  ), [displayMode, state]);
  const resolveOutlineTop = useCallback((item: DocumentOutlineItem, scrollRoot: HTMLElement) => {
    if (state.status !== 'ready' || !state.book.resolveHref) return null;
    const href = (item.target as Partial<EpubOutlineTarget>).href;
    if (typeof href !== 'string') return null;
    const resolved = state.book.resolveHref(href);
    const sectionIndex = resolved?.index;
    if (typeof sectionIndex !== 'number' || !Number.isFinite(sectionIndex)) return null;

    // Resolve against the always-rendered section wrapper, not the iframe, so a marker
    // still resolves when its section is lazily unmounted; the in-section anchor offset
    // only applies once the frame is mounted (otherwise jump to the section top).
    const sectionElement = epubSectionElement(scrollRoot, sectionIndex);
    if (!sectionElement) return null;
    const frame = frameRefs.current.get(sectionIndex) ?? null;
    const anchorOffset = frame ? epubAnchorOffset(frame, resolved?.anchor) : 0;
    return epubSectionScrollTop(scrollRoot, sectionElement) + anchorOffset;
  }, [state]);

  const sections = state.status === 'ready'
    ? displayMode === 'summary' ? state.sections.slice(0, 1) : state.sections
    : [];
  const ready = state.status === 'ready';

  useEffect(() => {
    if (
      displayMode !== 'full'
      || state.status !== 'ready'
      || !initialReadingPosition
      || restoredFullSessionRef.current === fullSessionRef.current
    ) {
      return undefined;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const scrollRoot = scrollRootRef.current;
      if (!scrollRoot) return;
      // Resolve against the always-rendered wrapper, not the iframe: under lazy mounting
      // the target is unmounted until we scroll to it, so scrolling to the wrapper's
      // placeholder position is what brings it into view and triggers its mount.
      const sectionElement = epubSectionElement(scrollRoot, initialReadingPosition.sectionIndex);
      if (!sectionElement) return;

      const sectionHeight = sectionElement.getBoundingClientRect().height;
      const sectionOffset = Math.max(0, sectionHeight * initialReadingPosition.sectionOffsetRatio);
      scrollRoot.scrollTo({
        top: epubSectionScrollTop(scrollRoot, sectionElement) + sectionOffset,
        behavior: 'auto',
      });

      // Re-pin on every layout change until the target section itself has measured,
      // then lock. Under lazy mounting the sections above the target stay at their
      // stable reserved placeholder height (they are not mounted while we sit on the
      // target), so the target does not drift once its own height is known; any later
      // re-measure of a just-mounted neighbour above is absorbed by the scrollport's
      // native scroll anchoring. Locking on the target's measure (not "everything
      // above") is what keeps this satisfiable when most sections never mount.
      if (measuredSectionsRef.current.has(initialReadingPosition.sectionIndex)) {
        restoredFullSessionRef.current = fullSessionRef.current;
      }
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [displayMode, initialReadingPosition, outlineLayoutVersion, state]);

  useEffect(() => () => {
    if (scrollReportFrameRef.current !== null) window.cancelAnimationFrame(scrollReportFrameRef.current);
  }, []);

  const reportReadingPosition = () => {
    if (displayMode !== 'full' || state.status !== 'ready' || scrollReportFrameRef.current !== null) return;
    scrollReportFrameRef.current = window.requestAnimationFrame(() => {
      scrollReportFrameRef.current = null;
      const position = currentEpubReadingPosition(scrollRootRef.current);
      if (position) onReadingPositionChange(position);
    });
  };

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
        onScroll={reportReadingPosition}
        ref={scrollRootRef}
      >
        {ready ? sections.map(({ index, number, section }) => (
          <EpubSectionFrame
            book={state.book}
            displayMode={displayMode}
            key={index}
            name={name}
            onNavigate={handleNavigation}
            onSectionLayout={reportSectionLayout}
            registerFrame={registerFrame}
            scrollRootRef={scrollRootRef}
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
  onNavigate,
  onSectionLayout,
  registerFrame,
  scrollRootRef,
  section,
  sectionIndex,
  sectionNumber,
}: {
  book: EpubBook;
  displayMode: PreviewRendererProps['displayMode'];
  name: string;
  onNavigate: (href: string) => void;
  onSectionLayout: (sectionIndex: number, height: number | null) => void;
  registerFrame: (sectionIndex: number, frame: HTMLIFrameElement | null) => void;
  scrollRootRef: RefObject<HTMLElement | null>;
  section: EpubSection;
  sectionIndex: number;
  sectionNumber: number;
}) {
  const labels = useT().shell.filePreview;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const releaseDocumentRef = useRef<(() => void) | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [height, setHeight] = useState<number | null>(null);
  // Lazy mounting: don't load the document or mount the iframe until the section is near
  // the viewport. Summary mode renders a single section, so it is always active.
  const [visible, setVisible] = useState(displayMode === 'summary');

  const setIframeRef = useCallback((frame: HTMLIFrameElement | null) => {
    iframeRef.current = frame;
    registerFrame(sectionIndex, frame);
  }, [registerFrame, sectionIndex]);

  // Once shown (in summary, or after the observer fires) stay mounted — like the PDF
  // canvases — so a full→summary→full flip never unloads the already-loaded section.
  useEffect(() => {
    if (displayMode === 'summary') setVisible(true);
  }, [displayMode]);

  useEffect(() => {
    if (visible) return undefined;
    const element = wrapperRef.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: scrollRootRef.current ?? null, rootMargin: EPUB_LAZY_ROOT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRootRef, visible]);

  // `onLoad` only records that the document is available; the single setup effect below
  // owns running `setupEpubDocument`. Driving setup from both the load event and a state
  // effect ran it twice per load (rebuilding the style/observer/listeners and re-measuring
  // for nothing) and re-ran it on unrelated prop churn.
  const handleIframeLoad = useCallback(() => {
    setState(iframeRef.current?.contentDocument ? 'ready' : 'error');
  }, []);

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
  }, [book, displayMode, onNavigate, section]);

  useEffect(() => {
    if (!visible) return undefined;
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
  }, [registerFrame, section, sectionIndex, visible]);

  // Single setup source: run once when the document becomes available, and again only
  // when a setup input (displayMode/book/section/onNavigate) actually changes.
  useEffect(() => {
    if (state !== 'ready') return;
    applyDocumentSetup();
  }, [applyDocumentSetup, state]);

  // Report this section's settled layout to the reader so the restore gate knows the
  // height above the target is final. Error sections settle at 0 so a failed preceding
  // section never stalls the gate.
  useEffect(() => {
    if (state === 'error') onSectionLayout(sectionIndex, 0);
    else if (height !== null) onSectionLayout(sectionIndex, height);
  }, [height, onSectionLayout, sectionIndex, state]);

  useEffect(() => () => onSectionLayout(sectionIndex, null), [onSectionLayout, sectionIndex]);

  // Full mode reserves a real height for every section so the scrollport never
  // collapses: the measured height once known, otherwise a placeholder estimate while
  // the section is unmounted or still loading. Summary mode fills its frame via CSS.
  const reservedHeight = displayMode === 'full' ? height ?? EPUB_PLACEHOLDER_SECTION_HEIGHT : null;
  const frameStyle = reservedHeight !== null ? { height: `${reservedHeight}px` } : undefined;
  const iframeStyle = height ? { height: `${height}px` } : undefined;

  return (
    <div
      className="file-preview-epub-section"
      data-epub-section-index={sectionIndex}
      data-epub-section-number={sectionNumber}
      ref={wrapperRef}
    >
      <div className="file-preview-epub-frame" style={frameStyle}>
        {visible && state === 'loading' ? <PreviewMessage>{labels.loading}</PreviewMessage> : null}
        {visible && state === 'error' ? <PreviewMessage>{labels.unavailable}</PreviewMessage> : null}
        {src ? (
          <iframe
            className="file-preview-epub-iframe"
            onLoad={handleIframeLoad}
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
  // Keep every spine section, including `linear="no"` ones (covers, footnote/endnote
  // pages). `resolveHref` returns full-spine indices, so a TOC entry or in-text anchor
  // can point at a non-linear section; dropping those here would register no frame for
  // that index and make the jump silently fail. The continuous reader shows the whole
  // book, so non-linear sections belong in the scrollport.
  const sections = Array.isArray(book.sections) ? book.sections : [];
  return sections
    .map((section, index) => ({ index, section }))
    .filter((entry): entry is { index: number; section: EpubSection } => isEpubSection(entry.section))
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
    const record = value as Record<string, unknown>;
    // Prefer the conventional human-title keys before any generic fallback, so an
    // object label like `{ href: 'ch1.xhtml', text: 'Chapter One' }` resolves to the
    // title rather than whichever string field happens to enumerate first.
    for (const key of ['text', 'label', 'title', 'name', 'value']) {
      const entry = record[key];
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
    }
    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === 'string' && entry.trim() && !/^(href|id|src|url|path|file)$/i.test(key)) {
        return entry.trim();
      }
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
  const maxInlineSize = displayMode === 'summary' ? EPUB_SUMMARY_MAX_INLINE_SIZE : EPUB_READER_MAX_INLINE_SIZE;
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

// The iframe is `scrolling="no"` with `overflow: hidden` on html/body, so it never
// grows to its content; we measure the content height and pin an explicit iframe
// height. `scrollHeight` is the primary signal because it includes scrollable layout
// overflow — trailing floats and absolutely-positioned blocks that a body-contents
// Range never reports — and is unaffected by `overflow: hidden`. The Range bottom and
// the replaced-element scan only refine it upward for the odd case scrollHeight
// undercounts (e.g. an image overflowing a zero-height clearfix).
const MEASURABLE_EPUB_TAGS = 'canvas,embed,iframe,img,math,object,svg,table,video';

function measureEpubDocumentHeight(doc: Document): number {
  const html = doc.documentElement;
  const body = doc.body;
  if (!body) return Math.max(1, Math.ceil(html.getBoundingClientRect().height));

  const rootTop = html.getBoundingClientRect().top;
  const bodyStyle = doc.defaultView?.getComputedStyle(body);
  const paddingBottom = cssPixelValue(bodyStyle?.paddingBottom);
  const borderBottom = cssPixelValue(bodyStyle?.borderBottomWidth);
  const contentBottom = measureEpubContentBottom(doc, body, rootTop);
  const flowHeight = Math.max(html.scrollHeight, body.scrollHeight);
  const height = Math.max(
    flowHeight,
    contentBottom > 0 ? contentBottom + paddingBottom + borderBottom : 0,
  );

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

  // Only the replaced/figure-like tags can extend past the text Range; scanning them
  // by selector (a few dozen nodes) avoids an O(n) getComputedStyle sweep over every
  // element in the document.
  for (const element of Array.from(body.querySelectorAll(MEASURABLE_EPUB_TAGS))) {
    if (!isMeasurableEpubElement(element)) continue;
    for (const rect of Array.from(element.getClientRects())) includeRect(rect);
  }

  return bottom;
}

function isMeasurableEpubElement(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return true;
  return style.display !== 'none' && style.visibility !== 'hidden' && style.position !== 'fixed';
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

  // Resolve against the always-rendered wrapper so a jump to a lazily-unmounted section
  // still works (the anchor offset applies once the frame mounts; until then, the
  // section top is the target and the scroll brings it into view to mount).
  const sectionElement = epubSectionElement(scrollRoot, sectionIndex);
  if (!sectionElement) return;
  const frame = frameRefs.get(sectionIndex) ?? null;
  const offset = frame ? epubAnchorOffset(frame, resolved?.anchor) : 0;
  scrollRoot.scrollTo({
    top: epubSectionScrollTop(scrollRoot, sectionElement) + offset,
    behavior: 'smooth',
  });
}

function epubSectionElement(scrollRoot: HTMLElement, sectionIndex: number): HTMLElement | null {
  return scrollRoot.querySelector<HTMLElement>(
    `.file-preview-epub-section[data-epub-section-index="${sectionIndex}"]`,
  );
}

// Top of a section in the scrollport's scroll-content coordinates (what `scrollTo` and
// `scrollTop` compare against) — not offsetParent-relative `offsetTop`, so it stays
// correct if the scrollport gains padding or a positioned ancestor. Callers add their
// own in-section offset (anchor / saved ratio) on top.
function epubSectionScrollTop(scrollRoot: HTMLElement, sectionElement: HTMLElement): number {
  const rootRect = scrollRoot.getBoundingClientRect();
  const sectionRect = sectionElement.getBoundingClientRect();
  return scrollRoot.scrollTop + (sectionRect.top - rootRect.top);
}

function currentEpubReadingPosition(scrollRoot: HTMLElement | null): EpubReadingPosition | null {
  if (!scrollRoot) return null;
  const sections = Array.from(scrollRoot.querySelectorAll<HTMLElement>('.file-preview-epub-section'));
  if (sections.length === 0) return null;
  const rootRect = scrollRoot.getBoundingClientRect();
  const viewportTop = rootRect.top + 1;
  const currentSection = sections.find((section) => section.getBoundingClientRect().bottom > viewportTop)
    ?? sections[sections.length - 1];
  const sectionIndex = Number(currentSection.dataset.epubSectionIndex);
  if (!Number.isFinite(sectionIndex) || sectionIndex < 0) return null;
  const sectionRect = currentSection.getBoundingClientRect();
  const sectionOffset = Math.max(0, Math.min(sectionRect.height, viewportTop - sectionRect.top));
  const sectionOffsetRatio = sectionRect.height > 0 ? sectionOffset / sectionRect.height : 0;
  return {
    sectionIndex,
    sectionOffsetRatio,
    updatedAt: Date.now(),
  };
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
    // Resolve `vw`/`vh` against the bounded reader, not the whole window: the body is
    // capped at the reader's max-inline-size and the reader's visible height is bounded
    // too, so units keyed off the window (e.g. a `width: 80vw` image or a `height: 100vh`
    // cover) would blow past the column/viewport and get clipped by the frame's
    // `overflow: hidden`. (foliate sizes against its renderer column, not `window`.)
    const viewportWidth = Math.min(window.innerWidth, EPUB_READER_MAX_INLINE_SIZE);
    const viewportHeight = Math.min(window.innerHeight, EPUB_READER_MAX_BLOCK_SIZE);
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
