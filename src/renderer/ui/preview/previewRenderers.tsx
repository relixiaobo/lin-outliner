/// <reference types="vite/client" />

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type {
  PreviewDirectoryEntry,
  PreviewFileSource,
  PreviewSourceDescriptor,
  PreviewTarget,
} from '../../../core/preview';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import {
  FileTextIcon,
  FolderIcon,
  ICON_SIZE,
} from '../icons';
import { inlineFileIconKind, INLINE_FILE_ICON_CLASS } from '../editor/inlineFileIcon';
import { highlightCode, isKnownCodeLanguage, plainCodeHtml } from '../editor/shikiHighlighter';
import { normalizeCodeLanguage } from '../editor/codeLanguages';
import { wantsNewPaneFromClick } from '../shared';
import { formatBytes } from './fileNode';
import { FilePreviewPill, type FilePreviewMenuAction } from './FilePreviewPill';
import { usePreviewObjectUrl } from './usePreviewObjectUrl';

type FilePreviewLabels = ReturnType<typeof useT>['shell']['filePreview'];

export type PreviewSourceState =
  | { status: 'loading' }
  | { status: 'ready'; source: PreviewSourceDescriptor }
  | { status: 'missing'; error?: string };

type TextState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; error?: string };

/**
 * Resolve a PreviewTarget to its source descriptor (loading → ready/missing).
 * Shared by the unified file preview body and inline preview block. Pass a
 * referentially-stable `target` (useMemo) so the resolve effect does not re-fire
 * every render.
 */
export function usePreviewSource(target: PreviewTarget): PreviewSourceState {
  const [state, setState] = useState<PreviewSourceState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void api.resolvePreviewSource(target)
      .then((result) => {
        if (cancelled) return;
        setState(result.source ? { status: 'ready', source: result.source } : { status: 'missing', error: result.error });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'missing', error: error instanceof Error ? error.message : undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [target]);
  return state;
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 24;
// A4-ish fallback aspect (height / width) for a not-yet-measured PDF page, so the
// placeholder reserves roughly the right height before its canvas lazily renders.
const PDF_FALLBACK_ASPECT = 1.414;
// Cap the device-pixel render scale so a wide pane on a Retina display does not
// rasterize an enormous canvas per page.
const PDF_MAX_RENDER_SCALE = 3;
// Render a page when it is within this many pixels of the scroll viewport.
const PDF_LAZY_ROOT_MARGIN = '800px';
const PDF_SUMMARY_PAGE_MIN_WIDTH = 104;
const PREVIEW_RESIZE_MIN_HEIGHT = 180;
const PREVIEW_RESIZE_MAX_HEIGHT = 720;
const PREVIEW_RESIZE_KEY_STEP = 24;

type FilePreviewDisplayMode = 'summary' | 'full';

type PdfJsModule = typeof import('pdfjs-dist');

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function clampPreviewHeight(height: number) {
  return Math.max(PREVIEW_RESIZE_MIN_HEIGHT, Math.min(PREVIEW_RESIZE_MAX_HEIGHT, Math.round(height)));
}

export interface PreviewRendererProps {
  displayMode: FilePreviewDisplayMode;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  onSummaryPageSelect?: (pageNumber: number) => void;
  source: PreviewFileSource;
  scrollToPageNumber?: number | null;
  onScrollToPageNumberConsumed?: () => void;
  // The internally-scrolling preview container. The PDF renderer uses it as the
  // IntersectionObserver root so pages render lazily as they scroll into view;
  // other renderers ignore it.
  scrollRootRef?: RefObject<HTMLElement | null>;
}

interface PreviewRendererEntry {
  id: string;
  match: (source: PreviewFileSource) => boolean;
  component: (props: PreviewRendererProps) => ReactElement;
}

const FILE_PREVIEW_RENDERERS: PreviewRendererEntry[] = [
  { id: 'directory', match: (source) => source.entryKind === 'directory', component: DirectoryPreview },
  { id: 'image', match: isImageSource, component: ImagePreview },
  { id: 'pdf', match: isPdfSource, component: PdfPreview },
  { id: 'audio', match: isAudioSource, component: AudioPreview },
  { id: 'video', match: isVideoSource, component: VideoPreview },
  { id: 'markdown', match: isMarkdownSource, component: MarkdownPreview },
  { id: 'delimited', match: isDelimitedSource, component: DelimitedPreview },
  { id: 'text', match: isTextSource, component: TextPreview },
  { id: 'metadata', match: () => true, component: MetadataPreview },
];

/**
 * Whether a resolved source has a real content renderer (anything but the metadata
 * fallback). Drives the preview pill: a previewable source gets Expand/Collapse; a
 * non-previewable one (the metadata card) gets Open-with-default-app as its primary.
 */
export function isPreviewableSource(source: PreviewSourceDescriptor): boolean {
  if (source.kind !== 'file') return false;
  const entry = FILE_PREVIEW_RENDERERS.find((candidate) => candidate.match(source));
  return entry ? entry.id !== 'metadata' : false;
}

export function PreviewRenderer({
  displayMode,
  onSummaryPageSelect,
  onOpenTarget,
  scrollToPageNumber,
  onScrollToPageNumberConsumed,
  source,
  scrollRootRef,
}: {
  displayMode: FilePreviewDisplayMode;
  onSummaryPageSelect?: (pageNumber: number) => void;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  scrollToPageNumber?: number | null;
  onScrollToPageNumberConsumed?: () => void;
  source: PreviewSourceDescriptor;
  scrollRootRef?: RefObject<HTMLElement | null>;
}) {
  const labels = useT().shell.filePreview;
  if (source.kind === 'url') {
    return <PreviewMessage>{labels.unsupported}</PreviewMessage>;
  }
  const Renderer = FILE_PREVIEW_RENDERERS.find((entry) => entry.match(source))?.component ?? MetadataPreview;
  return (
    <Renderer
      displayMode={displayMode}
      onSummaryPageSelect={onSummaryPageSelect}
      onOpenTarget={onOpenTarget}
      scrollToPageNumber={scrollToPageNumber}
      onScrollToPageNumberConsumed={onScrollToPageNumberConsumed}
      source={source}
      scrollRootRef={scrollRootRef}
    />
  );
}

export interface FilePreviewShellProps {
  state: PreviewSourceState;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  /** The OS-default-app open action (asset / local file / url). Null when not openable. */
  primaryOpen?: { label: string; run: () => void } | null;
  /** Secondary actions for the `⋯` menu (reveal in Finder, copy, add to outline). */
  menuActions?: FilePreviewMenuAction[];
  /** A quiet caption (type · size · pages) shown in the `⋯` menu header. */
  meta?: string | null;
  /** Start in the full reader instead of the summary strip. */
  initialExpanded?: boolean;
}

/**
 * The shared body of a file preview: the rendered content in an internally-scrolling
 * stage with a single bottom-center floating pill (primary + `⋯`), replacing the old
 * top meta+actions toolbar. Both lifecycle states reuse it so a loose preview reads
 * identically to an ingested file-node preview (same `.file-node-*` CSS). A previewable
 * source toggles between a rounded summary strip and an expanded full-scroll reader;
 * a non-previewable one (the metadata card) renders at natural height with
 * Open-with-default-app as the same pill's primary. Callers supply the open action +
 * the `⋯` menu actions; the resolved-source rendering and the action location are
 * common across non-image file types.
 */
export function FilePreviewShell({
  state,
  onOpenTarget,
  primaryOpen = null,
  menuActions = [],
  meta = null,
  initialExpanded = false,
}: FilePreviewShellProps) {
  const labels = useT().shell.filePreview;
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(initialExpanded);
  const [previewHeights, setPreviewHeights] = useState<{ summary?: number; full?: number }>({});
  const [scrollToPageNumber, setScrollToPageNumber] = useState<number | null>(null);
  const previewable = state.status === 'ready' && isPreviewableSource(state.source);
  const metadataFallback = state.status === 'ready' && !previewable;
  const displayMode: FilePreviewDisplayMode = previewable && !expanded ? 'summary' : 'full';
  const resizedHeight = displayMode === 'summary' ? previewHeights.summary : previewHeights.full;
  const toggleExpanded = () => {
    setExpanded((value) => {
      const next = !value;
      if (!next) setScrollToPageNumber(null);
      return next;
    });
  };
  const openSummaryPage = (pageNumber: number) => {
    setScrollToPageNumber(pageNumber);
    setExpanded(true);
  };
  const consumeScrollToPageNumber = useCallback(() => {
    setScrollToPageNumber(null);
  }, []);
  const setResizedHeight = (height: number) => {
    const nextHeight = clampPreviewHeight(height);
    setPreviewHeights((prev) => ({ ...prev, [displayMode]: nextHeight }));
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    const preview = previewRef.current;
    if (!preview) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = resizedHeight ?? preview.getBoundingClientRect().height;
    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      setResizedHeight(startHeight + moveEvent.clientY - startY);
    };
    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  };
  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const preview = previewRef.current;
    if (!preview) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    setResizedHeight((resizedHeight ?? preview.getBoundingClientRect().height) + direction * PREVIEW_RESIZE_KEY_STEP);
  };
  // A non-previewable source (metadata card) needs no collapse/expand stage, so it
  // carries only the base class — `.collapsed` / `.expanded` are the only stage rules.
  const stageClass = [
    'file-node-preview',
    `file-node-preview--${displayMode}`,
    metadataFallback ? 'file-node-preview--metadata' : '',
    resizedHeight !== undefined ? 'resized' : '',
    previewable ? (expanded ? 'expanded' : 'collapsed') : '',
  ].filter(Boolean).join(' ');
  const previewStyle = resizedHeight !== undefined
    ? ({ '--file-preview-resized-height': `${resizedHeight}px` } as CSSProperties)
    : undefined;
  const bodyClass = ['file-node-body', metadataFallback ? 'file-node-body--metadata' : '']
    .filter(Boolean)
    .join(' ');
  const pill = state.status !== 'loading' ? (
    // Hold the pill until the source resolves: while loading, `previewable` is
    // false, so the primary would briefly be "Open with default app" and a click
    // in that window would open the file externally instead of toggling the
    // preview it is about to become.
    <FilePreviewPill
      previewable={previewable}
      expanded={expanded}
      onToggleExpand={toggleExpanded}
      primaryOpen={primaryOpen}
      menuActions={menuActions}
      meta={meta}
      placement={metadataFallback ? 'footer' : 'overlay'}
    />
  ) : null;
  return (
    <div className={bodyClass}>
      <div className={stageClass} ref={previewRef} style={previewStyle}>
        {state.status === 'loading' ? (
          <PreviewMessage>{labels.loading}</PreviewMessage>
        ) : state.status === 'missing' ? (
          <PreviewMessage>{state.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>
        ) : (
          <PreviewRenderer
            displayMode={displayMode}
            onSummaryPageSelect={openSummaryPage}
            source={state.source}
            onOpenTarget={onOpenTarget}
            scrollToPageNumber={expanded ? scrollToPageNumber : null}
            onScrollToPageNumberConsumed={consumeScrollToPageNumber}
            scrollRootRef={previewRef}
          />
        )}
        {metadataFallback ? pill : null}
      </div>
      {metadataFallback ? null : pill}
      {previewable ? (
        <div
          aria-label="Resize preview"
          aria-orientation="horizontal"
          className="file-preview-resize-handle"
          onKeyDown={handleResizeKeyDown}
          onPointerDown={beginResize}
          role="separator"
          tabIndex={0}
        />
      ) : null}
    </div>
  );
}

function DirectoryPreview({ onOpenTarget, source }: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; entries: PreviewDirectoryEntry[]; truncated: boolean }
    | { status: 'error'; error?: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void api.listPreviewDirectory(source.target)
      .then((result) => {
        if (cancelled) return;
        setState(result.entries
          ? { status: 'ready', entries: result.entries, truncated: result.truncated === true }
          : { status: 'error', error: result.error });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: error instanceof Error ? error.message : undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [source.target]);

  if (state.status === 'loading') return <PreviewMessage>{labels.loading}</PreviewMessage>;
  if (state.status === 'error') return <PreviewMessage>{labels.unavailable}</PreviewMessage>;
  if (state.entries.length === 0) return <PreviewMessage>{labels.emptyDirectory}</PreviewMessage>;

  return (
    <div className="file-preview-directory">
      <div className="file-preview-directory-summary">
        {labels.itemCount({ count: state.entries.length })}
        {state.truncated ? <span>...</span> : null}
      </div>
      <div className="file-preview-directory-list">
        {state.entries.map((entry) => (
          <button
            className="file-preview-directory-row"
            key={`${entry.entryKind}:${entry.name}:${entry.lastModified ?? ''}`}
            onClick={(event) => onOpenTarget(entry.target, { newPane: wantsNewPaneFromClick(event) })}
            type="button"
          >
            <span
              aria-hidden="true"
              className={INLINE_FILE_ICON_CLASS}
              data-file-icon-kind={inlineFileIconKind({
                entryKind: entry.entryKind,
                mimeType: entry.mimeType,
                name: entry.name,
              })}
            />
            <span className="file-preview-directory-name">{entry.name}</span>
            <span className="file-preview-directory-meta">
              {entry.entryKind === 'directory' ? labels.directory : formatBytes(entry.sizeBytes)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ImagePreview({ source }: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  // Prefer the stream URL; otherwise read bytes (shared cancel/revoke machine). The
  // thumbnail data URL is the placeholder while the read is in flight or on failure.
  const bytes = usePreviewObjectUrl(source.target, {
    enabled: !source.streamUrl,
    mimeType: source.mimeType,
  });
  const src = source.streamUrl ?? bytes.src ?? source.thumbnailDataUrl ?? null;
  const isError = !source.streamUrl && bytes.error !== undefined && !bytes.src;
  if (!src) return <PreviewMessage>{labels.loading}</PreviewMessage>;
  return (
    <figure className="file-preview-image">
      <img alt={labels.imageAlt({ name: source.name })} src={src} />
      {isError ? <figcaption>{labels.tooLarge}</figcaption> : null}
    </figure>
  );
}

/**
 * Resolve a playable media URL for an audio/video source: prefer the streaming
 * `asset://` URL (uncapped, Chromium-cached, range-request friendly), falling back
 * to a bounded byte read → object URL for non-asset sources that have no stream URL.
 */
function useMediaSourceUrl(source: PreviewFileSource): { src: string | null; error?: string } {
  const bytes = usePreviewObjectUrl(source.target, {
    enabled: !source.streamUrl,
    mimeType: source.mimeType,
  });
  return source.streamUrl ? { src: source.streamUrl } : bytes;
}

function AudioPreview({ source }: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const { src, error } = useMediaSourceUrl(source);
  if (!src) return <PreviewMessage>{error === 'too-large' ? labels.tooLarge : labels.loading}</PreviewMessage>;
  return <audio className="file-preview-media file-preview-audio" controls preload="metadata" src={src} />;
}

function VideoPreview({ source }: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const { src, error } = useMediaSourceUrl(source);
  if (!src) return <PreviewMessage>{error === 'too-large' ? labels.tooLarge : labels.loading}</PreviewMessage>;
  return <video className="file-preview-media file-preview-video" controls preload="metadata" src={src} />;
}

function MarkdownPreview({ source }: PreviewRendererProps) {
  const textState = usePreviewText(source.target);
  const labels = useT().shell.filePreview;
  if (textState.status === 'loading') return <PreviewMessage>{labels.loading}</PreviewMessage>;
  if (textState.status === 'error') return <PreviewMessage>{textState.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>;
  return (
    <article className="file-preview-markdown">
      <Markdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{textState.text}</Markdown>
    </article>
  );
}

function DelimitedPreview({ source }: PreviewRendererProps) {
  const textState = usePreviewText(source.target);
  const labels = useT().shell.filePreview;
  const delimiter = source.ext === 'tsv' || source.mimeType === 'text/tab-separated-values' ? '\t' : ',';
  const rows = useMemo(() => (
    textState.status === 'ready' ? parseDelimitedRows(textState.text, delimiter) : []
  ), [delimiter, textState]);
  if (textState.status === 'loading') return <PreviewMessage>{labels.loading}</PreviewMessage>;
  if (textState.status === 'error') return <PreviewMessage>{textState.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>;
  if (rows.length === 0) return <PreviewMessage>{labels.unsupported}</PreviewMessage>;
  return (
    <div className="file-preview-table-wrap">
      <table className="file-preview-table">
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextPreview({ source }: PreviewRendererProps) {
  const textState = usePreviewText(source.target);
  const labels = useT().shell.filePreview;
  const [html, setHtml] = useState(() => plainCodeHtml(''));
  const language = languageForSource(source);

  useEffect(() => {
    let cancelled = false;
    if (textState.status !== 'ready') {
      setHtml(plainCodeHtml(''));
      return () => {
        cancelled = true;
      };
    }
    setHtml(plainCodeHtml(textState.text));
    void highlightCode(textState.text, language).then((next) => {
      if (!cancelled) setHtml(next);
    });
    return () => {
      cancelled = true;
    };
  }, [language, textState]);

  if (textState.status === 'loading') return <PreviewMessage>{labels.loading}</PreviewMessage>;
  if (textState.status === 'error') return <PreviewMessage>{textState.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>;
  return <div className="file-preview-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

function PdfPreview({
  displayMode,
  onSummaryPageSelect,
  onScrollToPageNumberConsumed,
  scrollToPageNumber,
  source,
  scrollRootRef,
}: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; document: PDFDocumentProxy; pageCount: number }
    | { status: 'error'; error?: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setState({ status: 'loading' });

    void (async () => {
      const bytesResult = await api.readPreviewBytes(source.target);
      if (!bytesResult.bytes) {
        throw new Error(bytesResult.error ?? 'missing');
      }
      if (cancelled) return;
      const pdfjs = await loadPdfJs();
      if (cancelled) return;
      const data = new Uint8Array(bytesResult.bytes.slice(0));
      loadingTask = pdfjs.getDocument({
        data,
        enableXfa: false,
        stopAtErrors: true,
      });
      const loadedDocument = await loadingTask.promise;
      if (cancelled) {
        void loadingTask.destroy();
        return;
      }
      setState({ status: 'ready', document: loadedDocument, pageCount: loadedDocument.numPages });
    })().catch((error: unknown) => {
      if (cancelled) return;
      setState({ status: 'error', error: error instanceof Error ? error.message : undefined });
    });

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [source.target]);

  if (state.status === 'loading') return <PreviewMessage>{labels.loading}</PreviewMessage>;
  if (state.status === 'error') return <MetadataPreview source={source} />;

  // Key on the document fingerprint so navigating this same pane to a different PDF
  // remounts the page list: otherwise the position-keyed LazyPdfPages keep their
  // `visible`/rendered canvases and the previous document's pages flash through until
  // the new pages re-render.
  return (
    <PdfPages
      key={state.document.fingerprints?.[0] ?? undefined}
      document={state.document}
      displayMode={displayMode}
      onSummaryPageSelect={onSummaryPageSelect}
      pageCount={state.pageCount}
      scrollToPageNumber={scrollToPageNumber}
      onScrollToPageNumberConsumed={onScrollToPageNumberConsumed}
      scrollRootRef={scrollRootRef}
    />
  );
}

/**
 * Every PDF page stacked vertically, scrolled to navigate (no page-nav, no zoom).
 * Each page renders lazily as it nears the scroll viewport; until then a placeholder
 * reserves its height so mounting never shifts the scroll position. The placeholder
 * uses the first page's aspect as an estimate — pages render `PDF_LAZY_ROOT_MARGIN`
 * ahead of the viewport, so each page is rasterized at its exact height before it
 * scrolls into view; a mixed-page-size PDF only differs in the (off-screen) scrollbar
 * estimate, never in a visible jump.
 */
function PdfPages({
  displayMode,
  document: pdfDocument,
  onSummaryPageSelect,
  onScrollToPageNumberConsumed,
  pageCount,
  scrollToPageNumber,
  scrollRootRef,
}: {
  displayMode: FilePreviewDisplayMode;
  document: PDFDocumentProxy;
  onSummaryPageSelect?: (pageNumber: number) => void;
  onScrollToPageNumberConsumed?: () => void;
  pageCount: number;
  scrollToPageNumber?: number | null;
  scrollRootRef?: RefObject<HTMLElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [aspect, setAspect] = useState(PDF_FALLBACK_ASPECT);

  useEffect(() => {
    let cancelled = false;
    void pdfDocument.getPage(1).then((page) => {
      const viewport = page.getViewport({ scale: 1 });
      if (!cancelled && viewport.width > 0) setAspect(viewport.height / viewport.width);
      page.cleanup();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

  // Measure the width synchronously before the first paint so every page reserves a
  // real placeholder height (width × aspect) immediately. Without this, the first
  // frame has width 0 → every placeholder collapses to ~0px → all pages fall inside
  // the IntersectionObserver's root margin at once and render together, defeating the
  // lazy mounting. Round to whole pixels so sub-pixel ResizeObserver noise (and a
  // live drag) doesn't re-rasterize every visible page each fractional frame.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element) {
      setContainerSize(measurePdfContainerSize(element));
    }
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      if (!entries[0]) return;
      const nextSize = measurePdfContainerSize(element);
      if (nextSize.width > 0) setContainerSize(nextSize);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const pageWidth = displayMode === 'summary'
    ? Math.max(
      PDF_SUMMARY_PAGE_MIN_WIDTH,
      containerSize.height > 0
        ? Math.floor(containerSize.height / aspect)
        : Math.round(containerSize.width * 0.24),
    )
    : containerSize.width;
  const pageScrollRootRef = containerRef;

  useEffect(() => {
    if (displayMode !== 'full' || !scrollToPageNumber || pageWidth <= 0) return undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      const scrollRoot = pageScrollRootRef.current;
      const pageElement = containerRef.current?.querySelector<HTMLElement>(`[data-pdf-page-number="${scrollToPageNumber}"]`);
      if (scrollRoot && pageElement) {
        const rootRect = scrollRoot.getBoundingClientRect();
        const pageRect = pageElement.getBoundingClientRect();
        scrollRoot.scrollTo({
          top: scrollRoot.scrollTop + pageRect.top - rootRect.top,
          behavior: 'auto',
        });
      }
      onScrollToPageNumberConsumed?.();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [displayMode, onScrollToPageNumberConsumed, pageScrollRootRef, pageWidth, scrollToPageNumber]);

  return (
    <div className={`file-preview-pdf file-preview-pdf--${displayMode}`} ref={containerRef}>
      {Array.from({ length: pageCount }, (_, index) => (
        <LazyPdfPage
          key={index}
          aspect={aspect}
          document={pdfDocument}
          displayMode={displayMode}
          onSummaryPageSelect={onSummaryPageSelect}
          pageNumber={index + 1}
          scrollRootRef={pageScrollRootRef}
          width={pageWidth}
        />
      ))}
    </div>
  );
}

function measurePdfContainerSize(element: HTMLElement) {
  const style = getComputedStyle(element);
  const horizontalInset = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const verticalInset = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  return {
    width: Math.max(0, Math.round(element.clientWidth - horizontalInset)),
    height: Math.max(0, Math.round(element.clientHeight - verticalInset)),
  };
}

function LazyPdfPage({
  aspect,
  document: pdfDocument,
  displayMode,
  onSummaryPageSelect,
  pageNumber,
  scrollRootRef,
  width,
}: {
  aspect: number;
  document: PDFDocumentProxy;
  displayMode: FilePreviewDisplayMode;
  onSummaryPageSelect?: (pageNumber: number) => void;
  pageNumber: number;
  scrollRootRef?: RefObject<HTMLElement | null>;
  width: number;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: scrollRootRef?.current ?? null, rootMargin: PDF_LAZY_ROOT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRootRef, visible]);

  // Reserve the page height (width × aspect) up front so lazy mounting never jumps.
  const reservedHeight = width > 0 ? Math.round(width * aspect) : undefined;
  const summary = displayMode === 'summary';
  const activatePage = () => {
    if (summary) onSummaryPageSelect?.(pageNumber);
  };
  return (
    <div
      aria-label={summary ? `Open page ${pageNumber}` : undefined}
      className="file-preview-pdf-page"
      data-pdf-page-number={pageNumber}
      onClick={summary ? activatePage : undefined}
      onKeyDown={summary
        ? (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          activatePage();
        }
        : undefined}
      ref={wrapperRef}
      role={summary ? 'button' : undefined}
      style={{ minHeight: reservedHeight }}
      tabIndex={summary ? 0 : undefined}
    >
      {visible && width > 0 ? (
        <PdfPageCanvas
          key={`${displayMode}:${width}`}
          document={pdfDocument}
          pageNumber={pageNumber}
          width={width}
        />
      ) : null}
    </div>
  );
}

function PdfPageCanvas({
  document: pdfDocument,
  pageNumber,
  width,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
}) {
  const labels = useT().shell.filePreview;
  const [state, setState] = useState<
    | { status: 'rendering' }
    | { status: 'ready' }
    | { status: 'error'; error?: string }
  >({ status: 'rendering' });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setState({ status: 'rendering' });

    void (async () => {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error('canvas-unavailable');
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = '0px';
      canvas.style.height = '0px';
      const page = await pdfDocument.getPage(pageNumber);
      try {
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        // Fit each page to the available width; cap the device-pixel scale so a wide
        // Retina pane does not allocate an oversized canvas.
        const fitScale = baseViewport.width > 0 ? width / baseViewport.width : 1;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, PDF_MAX_RENDER_SCALE);
        const viewport = page.getViewport({ scale: fitScale });
        const context = canvas.getContext('2d');
        if (!context) throw new Error('canvas-unavailable');
        canvas.width = Math.ceil(viewport.width * pixelRatio);
        canvas.height = Math.ceil(viewport.height * pixelRatio);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
        });
        await renderTask.promise;
        if (!cancelled) setState({ status: 'ready' });
      } finally {
        page.cleanup();
      }
    })().catch((error: unknown) => {
      if (cancelled) return;
      setState({ status: 'error', error: error instanceof Error ? error.message : undefined });
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDocument, pageNumber, width]);

  return (
    <div className="file-preview-pdf-stage">
      {state.status === 'rendering' ? <PreviewMessage>{labels.loading}</PreviewMessage> : null}
      {state.status === 'error' ? <PreviewMessage>{labels.unavailable}</PreviewMessage> : null}
      <canvas
        ref={canvasRef}
        aria-label={labels.pdfCanvas({ page: pageNumber })}
        className="file-preview-pdf-canvas"
      />
    </div>
  );
}

function MetadataPreview({ source }: { source: PreviewFileSource }) {
  const labels = useT().shell.filePreview;
  const kind = metadataKindLabel(source);
  const size = formatBytes(source.sizeBytes);
  const modified = source.lastModified
    ? labels.modified({ date: formatModifiedDate(source.lastModified) })
    : null;
  return (
    <div className="file-preview-metadata">
      <div className="file-preview-metadata-kind-row">
        <h2>{kind}</h2>
        <span>{size}</span>
      </div>
      {modified ? <p>{modified}</p> : null}
    </div>
  );
}

function metadataKindLabel(source: PreviewFileSource): string {
  const ext = source.ext.trim().toLowerCase();
  if (ext) return ext;
  const mimeType = source.mimeType.trim().toLowerCase();
  if (!mimeType || mimeType === 'application/octet-stream') return 'file';
  const subtype = mimeType.split('/')[1]?.split(/[+;]/)[0]?.trim();
  return subtype || mimeType;
}

export function usePreviewText(target: PreviewTarget): TextState {
  const [state, setState] = useState<TextState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void api.readPreviewText(target)
      .then((result) => {
        if (cancelled) return;
        setState(result.text !== null ? { status: 'ready', text: result.text } : { status: 'error', error: result.error });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: error instanceof Error ? error.message : undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [target]);
  return state;
}

export function FilePreviewGlyph({
  source,
  target,
}: {
  source: PreviewSourceDescriptor | null;
  target: PreviewTarget;
}) {
  if (source?.kind === 'file') {
    if (source.entryKind === 'directory') return <FolderIcon aria-hidden="true" size={ICON_SIZE.toolbar} />;
    return (
      <span
        aria-hidden="true"
        className={INLINE_FILE_ICON_CLASS}
        data-file-icon-kind={inlineFileIconKind({
          entryKind: source.entryKind,
          mimeType: source.mimeType,
          name: source.name,
        })}
      />
    );
  }
  if (target.kind === 'local-file' && target.entryKind === 'directory') {
    return <FolderIcon aria-hidden="true" size={ICON_SIZE.toolbar} />;
  }
  return <FileTextIcon aria-hidden="true" size={ICON_SIZE.toolbar} />;
}

export function PreviewMessage({ children }: { children: string }) {
  return <div className="file-preview-message">{children}</div>;
}

export function sourceTitle(source: PreviewSourceDescriptor): string {
  if (source.kind === 'url') return source.title;
  return source.name;
}

export function sourceMeta(source: PreviewSourceDescriptor, labels: FilePreviewLabels): string {
  if (source.kind === 'url') return labels.sourceUrl;
  const parts = [sourceKindLabel(source.sourceKind, labels), formatBytes(source.sizeBytes)];
  if (source.entryKind === 'directory') parts[1] = labels.directory;
  if (source.lastModified) parts.push(labels.modified({ date: formatModifiedDate(source.lastModified) }));
  return parts.join(' · ');
}

function sourceKindLabel(kind: PreviewFileSource['sourceKind'], labels: FilePreviewLabels): string {
  if (kind === 'local-file') return labels.sourceLocalFile;
  if (kind === 'asset') return labels.sourceAsset;
  return labels.sourceAgentPayload;
}

export function targetTitleFallback(target: PreviewTarget): string {
  if (target.kind === 'local-file') return target.path.split('/').filter(Boolean).at(-1) ?? target.path;
  if (target.kind === 'asset') return target.assetId;
  if (target.kind === 'agent-payload') return target.payloadId;
  return target.url;
}

function isImageSource(source: PreviewFileSource): boolean {
  return source.mimeType.toLowerCase().startsWith('image/');
}

function isAudioSource(source: PreviewFileSource): boolean {
  return source.entryKind === 'file' && source.mimeType.toLowerCase().startsWith('audio/');
}

function isVideoSource(source: PreviewFileSource): boolean {
  return source.entryKind === 'file' && source.mimeType.toLowerCase().startsWith('video/');
}

function isPdfSource(source: PreviewFileSource): boolean {
  return source.entryKind === 'file'
    && (source.mimeType.toLowerCase() === 'application/pdf' || source.ext === 'pdf');
}

function isMarkdownSource(source: PreviewFileSource): boolean {
  return source.ext === 'md' || source.ext === 'markdown' || source.mimeType.toLowerCase() === 'text/markdown';
}

function isDelimitedSource(source: PreviewFileSource): boolean {
  const mimeType = source.mimeType.toLowerCase();
  return source.ext === 'csv'
    || source.ext === 'tsv'
    || mimeType === 'text/csv'
    || mimeType === 'text/tab-separated-values';
}

function isTextSource(source: PreviewFileSource): boolean {
  const mimeType = source.mimeType.toLowerCase();
  return mimeType.startsWith('text/')
    || ['application/json', 'application/xml', 'application/yaml'].includes(mimeType)
    || Boolean(languageForSource(source));
}

function languageForSource(source: PreviewFileSource): string {
  const extLanguage = normalizeCodeLanguage(source.ext);
  if (isKnownCodeLanguage(extLanguage)) return extLanguage;
  const mimeType = source.mimeType.toLowerCase();
  if (mimeType === 'application/json') return 'json';
  if (mimeType === 'application/xml' || mimeType === 'text/xml') return 'xml';
  if (mimeType === 'application/yaml' || mimeType === 'text/yaml') return 'yaml';
  return '';
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(cell);
      rows.push(row.slice(0, MAX_TABLE_COLUMNS));
      if (rows.length >= MAX_TABLE_ROWS) return rows;
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }

  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row.slice(0, MAX_TABLE_COLUMNS));
  }
  return rows;
}

export function formatModifiedDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function loadPdfJs(): Promise<PdfJsModule> {
  // Both the engine and its bundled same-origin worker URL load on demand, so
  // this `?url` asset never enters the static module graph (which non-Vite test
  // runners cannot parse). Vite still emits the worker into assets/, so the
  // packaged file:// CSP's worker-src ← script-src 'self' permits it (PR #227).
  pdfJsModulePromise ??= Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.mjs?url'),
  ]).then(([module, worker]) => {
    module.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
    return module;
  });
  return pdfJsModulePromise;
}

export function canOpenPreviewSource(source: PreviewSourceDescriptor): boolean {
  if (source.kind === 'url') return true;
  return source.sourceKind === 'local-file' || source.sourceKind === 'asset';
}

export async function openPreviewSource(source: PreviewSourceDescriptor): Promise<void> {
  if (source.kind === 'url') {
    await api.openExternalUrl(source.url);
    return;
  }
  if (source.sourceKind === 'asset' && source.target.kind === 'asset') {
    await api.openAsset(source.target.assetId);
    return;
  }
  if (source.sourceKind === 'local-file' && source.target.kind === 'local-file') {
    await window.lin?.openLocalFile?.({ path: source.target.path });
  }
}

/** A URL source has no on-disk location to reveal; only stored assets and local files do. */
export function canRevealPreviewSource(source: PreviewSourceDescriptor): boolean {
  return source.kind === 'file' && (source.sourceKind === 'local-file' || source.sourceKind === 'asset');
}

export async function revealPreviewSource(source: PreviewSourceDescriptor): Promise<void> {
  if (source.kind === 'url') return;
  if (source.sourceKind === 'asset' && source.target.kind === 'asset') {
    await api.revealAsset(source.target.assetId);
    return;
  }
  if (source.sourceKind === 'local-file' && source.target.kind === 'local-file') {
    await window.lin?.revealLocalFile?.({ path: source.target.path });
  }
}
