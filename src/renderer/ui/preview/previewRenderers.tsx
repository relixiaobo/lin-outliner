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
  type ReactNode,
  type RefObject,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import type {
  PreviewDirectoryEntry,
  PreviewFileSource,
  PreviewSourceDescriptor,
  PreviewTarget,
  PreviewUrlSource,
} from '../../../core/preview';
import { normalizePreviewHttpUrl, previewTargetKey } from '../../../core/preview';
import { mediaKindForMimeType } from '../../../core/mediaKind';
import {
  httpReferrerForUrlPreview,
  URL_PREVIEW_WEBVIEW_PARTITION,
} from '../../../core/urlPreviewSession';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import {
  MediaController,
  MediaDurationDisplay,
  MediaFullscreenButton,
  MediaMuteButton,
  MediaPlayButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeDisplay,
  MediaTimeRange,
  MediaVolumeRange,
} from 'media-chrome/react';
import {
  CollapseIcon,
  ExpandIcon,
  FileTextIcon,
  FolderIcon,
  ICON_SIZE,
  PauseIcon,
  PlayIcon,
  SeekBackwardIcon,
  SeekForwardIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeOffIcon,
} from '../icons';
import { inlineFileIconKind, INLINE_FILE_ICON_CLASS } from '../editor/inlineFileIcon';
import { highlightCode, isKnownCodeLanguage, plainCodeHtml } from '../editor/shikiHighlighter';
import { normalizeCodeLanguage } from '../editor/codeLanguages';
import { ButtonControl } from '../primitives/ButtonControl';
import { formatDateTime } from '../formatting';
import { wantsNewPaneFromClick } from '../shared';
import type { FilePreviewNavigationOptions } from '../workspaceLayoutTypes';
import type { EpubTranslationDomAdapter } from './epubTranslationDom';
import { formatBytes } from './previewFormatting';
import { DocumentOutlineRail, type DocumentOutlineItem } from './DocumentOutlineRail';
import { FilePreviewPill, type FilePreviewMenuAction } from './FilePreviewPill';
import {
  previewReadingPositionKey,
  readPdfReadingPosition,
  useReadingPositionSession,
  writePdfReadingPosition,
  type PdfReadingPosition,
} from './readingPositionStore';
import { openUrlPreviewFromClick, youtubePreviewRouteForUrl } from './urlPreviewRouting';
import { usePreviewObjectUrl } from './usePreviewObjectUrl';

type FilePreviewLabels = ReturnType<typeof useT>['shell']['filePreview'];
const PREVIEW_MODIFIED_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: 'medium',
  timeStyle: 'short',
};

// React drops boolean values for this Electron-only attribute, so pass the
// string value Electron expects while retaining React's intrinsic webview type.
const ENABLE_WEBVIEW_POPUPS = 'true' as unknown as boolean;

export type PreviewSourceState =
  | { status: 'loading' }
  | { status: 'ready'; source: PreviewSourceDescriptor }
  | { status: 'missing'; error?: string };

export interface UrlPreviewPageMetadata {
  faviconUrl?: string;
  title?: string;
}

type TextState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; error?: string };

/**
 * Resolve a PreviewTarget to its source descriptor (loading → ready/missing).
 * Shared by the unified file preview body and inline preview block. Equivalent
 * targets retain one semantic identity so ordinary parent re-renders do not
 * restart resolution or collapse a ready preview back to loading.
 */
export function usePreviewSource(target: PreviewTarget): PreviewSourceState {
  const targetIdentity = `${previewTargetKey(target)}\0${target.label ?? ''}`;
  const stableTargetRef = useRef({ identity: targetIdentity, target });
  if (stableTargetRef.current.identity !== targetIdentity) {
    stableTargetRef.current = { identity: targetIdentity, target };
  }
  const stableTarget = stableTargetRef.current.target;
  const [state, setState] = useState<PreviewSourceState>(() => (
    stableTarget.kind === 'url' ? previewSourceStateForUrlTarget(stableTarget) : { status: 'loading' }
  ));
  useEffect(() => {
    let cancelled = false;
    if (stableTarget.kind === 'url') {
      setState(previewSourceStateForUrlTarget(stableTarget));
      return () => {
        cancelled = true;
      };
    }
    setState({ status: 'loading' });
    void api.resolvePreviewSource(stableTarget)
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
  }, [stableTarget]);
  return state;
}

function previewSourceStateForUrlTarget(target: Extract<PreviewTarget, { kind: 'url' }>): PreviewSourceState {
  const url = normalizePreviewHttpUrl(target.url);
  if (!url) return { status: 'missing', error: 'invalid-target' };
  return {
    status: 'ready',
    source: {
      kind: 'url',
      id: `url:${url}`,
      target: { ...target, url },
      title: target.label?.trim() || url,
      url,
    },
  };
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

type PdfRefProxy = {
  gen: number;
  num: number;
};

type PdfOutlineNode = {
  dest: string | unknown[] | null;
  items?: PdfOutlineNode[];
  title?: string;
};

type PdfOutlineTarget = {
  pageNumber: number;
};

type PdfJsModule = typeof import('pdfjs-dist');

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

function clampPreviewHeight(height: number) {
  return Math.max(PREVIEW_RESIZE_MIN_HEIGHT, Math.min(PREVIEW_RESIZE_MAX_HEIGHT, Math.round(height)));
}

export interface PreviewRendererProps {
  accessibleName?: string;
  displayMode: FilePreviewDisplayMode;
  mediaActions?: ReactElement | null;
  onEpubTranslationSurfaceChange?: (surface: EpubTranslationDomAdapter | null) => void;
  onOpenTarget: (target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  onSummaryPageSelect?: (pageNumber: number) => void;
  onUrlMetadataChange?: (metadata: UrlPreviewPageMetadata) => void;
  source: PreviewFileSource;
  scrollToPageNumber?: number | null;
  onScrollToPageNumberConsumed?: () => void;
  // The internally-scrolling preview container. The PDF renderer uses it as the
  // IntersectionObserver root so pages render lazily as they scroll into view;
  // other renderers ignore it.
  scrollRootRef?: RefObject<HTMLElement | null>;
}

interface PreviewRendererEntry {
  match: (source: PreviewFileSource) => boolean;
  component: (props: PreviewRendererProps) => ReactElement;
  presentation: PreviewPresentation;
}

export type PreviewPresentation = 'document' | 'image' | 'media' | 'metadata' | 'web' | 'youtube';

const METADATA_PREVIEW_RENDERER: PreviewRendererEntry = {
  match: () => true,
  component: MetadataPreview,
  presentation: 'metadata',
};

const FILE_PREVIEW_RENDERERS: PreviewRendererEntry[] = [
  { match: (source) => source.entryKind === 'directory', component: DirectoryPreview, presentation: 'document' },
  { match: isImageSource, component: ImagePreview, presentation: 'image' },
  { match: isPdfSource, component: PdfPreview, presentation: 'document' },
  { match: isEpubSource, component: EpubPreviewLoader, presentation: 'document' },
  { match: isAudioSource, component: AudioPreview, presentation: 'media' },
  { match: isVideoSource, component: VideoPreview, presentation: 'media' },
  { match: isHtmlSource, component: HtmlPreview, presentation: 'document' },
  { match: isMarkdownSource, component: MarkdownPreview, presentation: 'document' },
  { match: isDelimitedSource, component: DelimitedPreview, presentation: 'document' },
  { match: isTextSource, component: TextPreview, presentation: 'document' },
  METADATA_PREVIEW_RENDERER,
];

/**
 * Resolve both content and chrome from the same ordered registry. MIME and extension
 * matching stays in the renderer entries; shells consume only the presentation.
 */
export function previewPresentationForSource(source: PreviewSourceDescriptor): PreviewPresentation {
  if (source.kind === 'url') return youtubePreviewRouteForUrl(source.url) ? 'youtube' : 'web';
  return previewRendererEntryForFile(source).presentation;
}

export function isPreviewableSource(source: PreviewSourceDescriptor): boolean {
  return previewPresentationForSource(source) !== 'metadata';
}

export function isPassivePlaybackSource(source: PreviewSourceDescriptor): boolean {
  return previewPresentationForSource(source) === 'media';
}

function previewRendererEntryForFile(source: PreviewFileSource): PreviewRendererEntry {
  return FILE_PREVIEW_RENDERERS.find((entry) => entry.match(source))
    ?? METADATA_PREVIEW_RENDERER;
}

export function PreviewRenderer({
  accessibleName,
  displayMode,
  onEpubTranslationSurfaceChange,
  onSummaryPageSelect,
  onUrlMetadataChange,
  onUrlWebviewChange,
  onOpenTarget,
  scrollToPageNumber,
  onScrollToPageNumberConsumed,
  source,
  scrollRootRef,
  mediaActions,
}: {
  accessibleName?: string;
  displayMode: FilePreviewDisplayMode;
  mediaActions?: ReactElement | null;
  onEpubTranslationSurfaceChange?: (surface: EpubTranslationDomAdapter | null) => void;
  onSummaryPageSelect?: (pageNumber: number) => void;
  onOpenTarget: (target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  scrollToPageNumber?: number | null;
  onScrollToPageNumberConsumed?: () => void;
  source: PreviewSourceDescriptor;
  onUrlMetadataChange?: (metadata: UrlPreviewPageMetadata) => void;
  onUrlWebviewChange?: (webview: Electron.WebviewTag | null) => void;
  scrollRootRef?: RefObject<HTMLElement | null>;
}) {
  if (source.kind === 'url') {
    return (
      <UrlPreview
        onMetadataChange={onUrlMetadataChange}
        onWebviewChange={onUrlWebviewChange}
        source={source}
      />
    );
  }
  const Renderer = previewRendererEntryForFile(source).component;
  return (
    <Renderer
      accessibleName={accessibleName}
      displayMode={displayMode}
      onEpubTranslationSurfaceChange={onEpubTranslationSurfaceChange}
      onSummaryPageSelect={onSummaryPageSelect}
      onOpenTarget={onOpenTarget}
      scrollToPageNumber={scrollToPageNumber}
      onScrollToPageNumberConsumed={onScrollToPageNumberConsumed}
      source={source}
      scrollRootRef={scrollRootRef}
      mediaActions={mediaActions}
    />
  );
}

export interface FilePreviewShellProps {
  /** User-authored Node content used to name an image-backed Source. */
  accessibleName?: string;
  /** Optional shared action group anchored to the preview body's upper-right corner. */
  cornerAction?: ReactNode;
  state: PreviewSourceState;
  onOpenTarget: (target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  /** The OS-default-app open action (asset / local file / url). Null when not openable. */
  primaryOpen?: { label: string; run: () => void } | null;
  /** Secondary actions for the `⋯` menu (reveal in Finder, copy, add to outline). */
  menuActions?: FilePreviewMenuAction[];
  /** A quiet caption (type · size · pages) shown in the `⋯` menu header. */
  meta?: string | null;
  /** Start in the full reader instead of the summary strip. */
  initialExpanded?: boolean;
  /** Dedicated split-pane reader: full content only, with header actions outside the preview. */
  readerMode?: boolean;
  onEpubTranslationSurfaceChange?: (surface: EpubTranslationDomAdapter | null) => void;
  onUrlMetadataChange?: (metadata: UrlPreviewPageMetadata) => void;
  onUrlWebviewChange?: (webview: Electron.WebviewTag | null) => void;
}

/**
 * Shared preview body for loose previews and selected Node Sources. The renderer
 * registry resolves a presentation policy: documents own summary/full chrome,
 * images render directly with an action-only menu, media owns playback controls,
 * webpages stay single-layer, YouTube uses a bounded player, and unsupported files
 * use metadata actions. A Source surface can provide shared corner chrome; when it
 * does, presentation-specific controls keep content actions only.
 */
export function FilePreviewShell({
  accessibleName,
  cornerAction,
  state,
  onOpenTarget,
  primaryOpen = null,
  menuActions = [],
  meta = null,
  initialExpanded = false,
  readerMode = false,
  onEpubTranslationSurfaceChange,
  onUrlMetadataChange,
  onUrlWebviewChange,
}: FilePreviewShellProps) {
  const labels = useT().shell.filePreview;
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(initialExpanded);
  const [previewHeights, setPreviewHeights] = useState<{ summary?: number; full?: number }>({});
  const [scrollToPageNumber, setScrollToPageNumber] = useState<number | null>(null);
  const presentation = state.status === 'ready' ? previewPresentationForSource(state.source) : null;
  const previewable = presentation !== null && presentation !== 'metadata';
  const documentPreview = presentation === 'document';
  const imagePreview = presentation === 'image';
  const passivePlayback = presentation === 'media';
  const mediaKind = state.status === 'ready' ? mediaKindForSource(state.source) : null;
  const webPreview = presentation === 'web';
  const youtubePreview = presentation === 'youtube';
  const documentKind = state.status === 'ready' && state.source.kind === 'file'
    ? documentKindForSource(state.source)
    : null;
  const metadataFallback = state.status === 'ready' && !previewable;
  const effectiveExpanded = readerMode || !documentPreview || expanded;
  const displayMode: FilePreviewDisplayMode = documentPreview && !effectiveExpanded ? 'summary' : 'full';
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
  const expansionClass = documentPreview
    ? (effectiveExpanded ? 'expanded' : 'collapsed')
    : readerMode || webPreview ? 'expanded' : '';
  const stageClass = [
    'file-node-preview',
    `file-node-preview--${displayMode}`,
    metadataFallback ? 'file-node-preview--metadata' : '',
    imagePreview ? 'file-node-preview--image' : '',
    passivePlayback ? 'file-node-preview--media' : '',
    webPreview ? 'file-node-preview--url' : '',
    youtubePreview ? 'file-node-preview--youtube' : '',
    documentKind ? `file-node-preview--${documentKind}` : '',
    mediaKind ? `file-node-preview--media-${mediaKind}` : '',
    readerMode ? 'file-node-preview--reader' : '',
    resizedHeight !== undefined ? 'resized' : '',
    expansionClass,
  ].filter(Boolean).join(' ');
  const previewStyle = resizedHeight !== undefined
    ? ({ '--file-preview-resized-height': `${resizedHeight}px` } as CSSProperties)
    : undefined;
  const bodyClass = [
    'file-node-body',
    metadataFallback ? 'file-node-body--metadata' : '',
    imagePreview ? 'file-node-body--image' : '',
    passivePlayback ? 'file-node-body--media' : '',
    webPreview ? 'file-node-body--url' : '',
    youtubePreview ? 'file-node-body--youtube' : '',
    documentKind ? `file-node-body--${documentKind}` : '',
    mediaKind ? `file-node-body--media-${mediaKind}` : '',
    readerMode ? 'file-node-body--reader' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const documentActions = !readerMode && documentPreview ? (
    <FilePreviewPill
      previewable
      expanded={expanded}
      onToggleExpand={toggleExpanded}
      primaryMode="toggle"
      primaryOpen={cornerAction ? null : primaryOpen}
      menuActions={cornerAction ? [] : menuActions}
      meta={meta}
    />
  ) : null;
  const imageActions = !readerMode && imagePreview && !cornerAction ? (
    <FilePreviewPill
      previewable
      expanded
      onToggleExpand={toggleExpanded}
      primaryMode="none"
      primaryOpen={primaryOpen}
      menuActions={menuActions}
      meta={meta}
      placement="image"
    />
  ) : null;
  const metadataActions = state.status !== 'loading' && !readerMode && !cornerAction
    && (metadataFallback || state.status === 'missing') ? (
      <FilePreviewPill
        previewable={false}
        expanded={false}
        onToggleExpand={toggleExpanded}
        primaryMode="open"
        primaryOpen={primaryOpen}
        menuActions={menuActions}
        meta={meta}
        placement="footer"
      />
    ) : null;
  const mediaActions = state.status !== 'loading' && !readerMode && passivePlayback && !cornerAction ? (
    <FilePreviewPill
      previewable={previewable}
      expanded={expanded}
      onToggleExpand={toggleExpanded}
      primaryMode="none"
      primaryOpen={primaryOpen}
      menuActions={menuActions}
      meta={meta}
      placement="media-control"
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
            accessibleName={accessibleName}
            displayMode={displayMode}
            onEpubTranslationSurfaceChange={onEpubTranslationSurfaceChange}
            onSummaryPageSelect={openSummaryPage}
            onUrlMetadataChange={onUrlMetadataChange}
            onUrlWebviewChange={onUrlWebviewChange}
            source={state.source}
            onOpenTarget={onOpenTarget}
            scrollToPageNumber={effectiveExpanded ? scrollToPageNumber : null}
            onScrollToPageNumberConsumed={consumeScrollToPageNumber}
            scrollRootRef={previewRef}
            mediaActions={mediaActions}
          />
        )}
        {metadataActions}
      </div>
      {cornerAction}
      {documentActions}
      {imageActions}
      {documentPreview && !readerMode ? (
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
          <ButtonControl
            className="file-preview-directory-row"
            key={`${entry.entryKind}:${entry.name}:${entry.lastModified ?? ''}`}
            onClick={(event) => onOpenTarget(entry.target, { newPane: wantsNewPaneFromClick(event) })}
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
          </ButtonControl>
        ))}
      </div>
    </div>
  );
}

function ImagePreview({ accessibleName, source }: PreviewRendererProps) {
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
      <img alt={accessibleName?.trim() || labels.imageAlt({ name: source.name })} src={src} />
      {isError ? <figcaption>{labels.tooLarge}</figcaption> : null}
    </figure>
  );
}

function UrlPreview({
  onMetadataChange,
  onWebviewChange,
  source,
}: {
  onMetadataChange?: (metadata: UrlPreviewPageMetadata) => void;
  onWebviewChange?: (webview: Electron.WebviewTag | null) => void;
  source: PreviewUrlSource;
}) {
  const youtubeRoute = youtubePreviewRouteForUrl(source.url);
  const previewUrl = youtubeRoute?.embedUrl ?? source.url;
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const setWebviewRef = useCallback((webview: Electron.WebviewTag | null) => {
    webviewRef.current = webview;
    onWebviewChange?.(webview);
  }, [onWebviewChange]);

  useEffect(() => {
    onMetadataChange?.({ title: source.title });
  }, [onMetadataChange, source.title]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !onMetadataChange) return undefined;
    const onTitle = (event: Event) => {
      const title = typeof (event as Event & { title?: unknown }).title === 'string'
        ? (event as Event & { title: string }).title.trim()
        : '';
      if (title) onMetadataChange({ title });
    };
    const onFavicon = (event: Event) => {
      const faviconUrl = firstPreviewFaviconUrl((event as Event & { favicons?: unknown }).favicons);
      if (faviconUrl) onMetadataChange({ faviconUrl });
    };
    webview.addEventListener('page-title-updated', onTitle);
    webview.addEventListener('page-favicon-updated', onFavicon);
    return () => {
      webview.removeEventListener('page-title-updated', onTitle);
      webview.removeEventListener('page-favicon-updated', onFavicon);
    };
  }, [onMetadataChange]);

  return (
    <div
      className={youtubeRoute ? 'file-preview-youtube' : 'file-preview-url'}
      data-preserve-selection
    >
      <webview
        allowpopups={ENABLE_WEBVIEW_POPUPS}
        className={youtubeRoute
          ? 'file-preview-url-webview file-preview-youtube-webview'
          : 'file-preview-url-webview'}
        httpreferrer={httpReferrerForUrlPreview(previewUrl)}
        partition={URL_PREVIEW_WEBVIEW_PARTITION}
        ref={setWebviewRef}
        src={previewUrl}
        title={source.title}
      />
    </div>
  );
}

function firstPreviewFaviconUrl(favicons: unknown): string | undefined {
  if (!Array.isArray(favicons)) return undefined;
  for (const candidate of favicons) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizePreviewHttpUrl(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

/**
 * Resolve a playable media URL for an audio/video source: prefer the streaming URL
 * (asset or trusted local file), falling back to a bounded byte read → object URL
 * for sources that have no stream URL.
 */
function useMediaSourceUrl(source: PreviewFileSource): { src: string | null; error?: string } {
  const bytes = usePreviewObjectUrl(source.target, {
    enabled: !source.streamUrl,
    mimeType: source.mimeType,
  });
  return source.streamUrl ? { src: source.streamUrl } : bytes;
}

function AudioPreview({ accessibleName, mediaActions, source }: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const { src, error } = useMediaSourceUrl(source);
  const setMediaRef = useCallback((element: HTMLAudioElement | null) => {
    if (element) element.disableRemotePlayback = true;
  }, []);
  if (!src) return <PreviewMessage>{error === 'too-large' ? labels.tooLarge : labels.loading}</PreviewMessage>;
  return (
    <MediaPreviewPlayer
      actions={mediaActions}
      kind="audio"
      name={accessibleName?.trim() || source.name}
    >
      <audio
        ref={setMediaRef}
        className="file-preview-media file-preview-audio"
        controlsList="nodownload noplaybackrate noremoteplayback"
        data-preserve-selection
        preload="metadata"
        slot="media"
        src={src}
        tabIndex={0}
      />
    </MediaPreviewPlayer>
  );
}

function VideoPreview({ accessibleName, mediaActions, source }: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const { src, error } = useMediaSourceUrl(source);
  if (!src) return <PreviewMessage>{error === 'too-large' ? labels.tooLarge : labels.loading}</PreviewMessage>;
  return (
    <MediaPreviewPlayer
      actions={mediaActions}
      kind="video"
      name={accessibleName?.trim() || source.name}
    >
      <video
        className="file-preview-media file-preview-video"
        controlsList="nodownload noplaybackrate noremoteplayback"
        data-preserve-selection
        disablePictureInPicture
        disableRemotePlayback
        preload="metadata"
        slot="media"
        src={src}
        tabIndex={0}
      />
    </MediaPreviewPlayer>
  );
}

function MediaPreviewPlayer({
  actions,
  children,
  kind,
  name,
}: {
  actions?: ReactElement | null;
  children: ReactElement;
  kind: 'audio' | 'video';
  name: string;
}) {
  const isAudio = kind === 'audio';
  return (
    <MediaController
      audio={isAudio}
      className={`file-preview-media-player file-preview-media-player--${kind}`}
      data-preserve-selection
      keyboardControl
      noAutohide={isAudio}
    >
      {children}
      <div
        className="file-preview-media-info"
        slot={isAudio ? undefined : 'top-chrome'}
      >
        <span className="file-preview-media-name" title={name}>{name}</span>
      </div>
      <div className="file-preview-media-controls">
        <div className="file-preview-media-progress-row">
          <MediaTimeRange className="file-preview-media-timeline" />
        </div>
        <div className="file-preview-media-command-row">
          <div className="file-preview-media-command-group">
            <MediaMuteButton className="file-preview-media-button">
              <VolumeOffIcon aria-hidden="true" className="file-preview-media-glyph" slot="off" />
              <VolumeLowIcon aria-hidden="true" className="file-preview-media-glyph" slot="low" />
              <VolumeLowIcon aria-hidden="true" className="file-preview-media-glyph" slot="medium" />
              <VolumeHighIcon aria-hidden="true" className="file-preview-media-glyph" slot="high" />
            </MediaMuteButton>
            <MediaVolumeRange className="file-preview-media-volume" />
          </div>
          <div className="file-preview-media-command-group file-preview-media-command-group--transport">
            <MediaSeekBackwardButton className="file-preview-media-button" seekOffset={15}>
              <SeekBackwardIcon aria-hidden="true" className="file-preview-media-glyph" slot="icon" />
            </MediaSeekBackwardButton>
            <MediaPlayButton className="file-preview-media-button">
              <PlayIcon aria-hidden="true" className="file-preview-media-glyph" slot="play" />
              <PauseIcon
                aria-hidden="true"
                className="file-preview-media-glyph file-preview-media-glyph--pause"
                slot="pause"
              />
            </MediaPlayButton>
            <MediaSeekForwardButton className="file-preview-media-button" seekOffset={15}>
              <SeekForwardIcon aria-hidden="true" className="file-preview-media-glyph" slot="icon" />
            </MediaSeekForwardButton>
          </div>
          <div className="file-preview-media-command-group file-preview-media-command-group--trailing">
            <span className="file-preview-media-time-group">
              <MediaTimeDisplay className="file-preview-media-time" noToggle />
              <span aria-hidden="true" className="file-preview-media-time-separator">/</span>
              <MediaDurationDisplay className="file-preview-media-duration" />
            </span>
            {isAudio ? null : (
              <MediaFullscreenButton className="file-preview-media-button">
                <ExpandIcon aria-hidden="true" className="file-preview-media-glyph" slot="enter" />
                <CollapseIcon aria-hidden="true" className="file-preview-media-glyph" slot="exit" />
              </MediaFullscreenButton>
            )}
            {actions}
          </div>
        </div>
      </div>
    </MediaController>
  );
}

function HtmlPreview({ source }: PreviewRendererProps) {
  const textState = usePreviewText(source.target);
  const labels = useT().shell.filePreview;
  const [showSource, setShowSource] = useState(false);
  const [sourceHtml, setSourceHtml] = useState(() => plainCodeHtml(''));
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (textState.status !== 'ready') {
      setSourceHtml(plainCodeHtml(''));
      return () => {
        cancelled = true;
      };
    }
    setSourceHtml(plainCodeHtml(textState.text));
    void highlightCode(textState.text, 'html').then((next) => {
      if (!cancelled) setSourceHtml(next);
    });
    return () => {
      cancelled = true;
    };
  }, [textState]);

  const interceptFrameLinks = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener('click', (event) => {
      const target = closestAnchorFromEventTarget(event.target);
      if (!target) return;
      if (openUrlPreviewFromClick(event, target.href, target.textContent?.trim() || target.href)) {
        event.preventDefault();
      } else {
        // Let non-URL anchors behave inside the sandboxed static document.
      }
    });
  }, []);

  if (textState.status === 'loading') return <PreviewMessage>{labels.loading}</PreviewMessage>;
  if (textState.status === 'error') return <PreviewMessage>{textState.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>;
  return (
    <div className={`file-preview-html ${showSource ? 'file-preview-html--source' : 'file-preview-html--render'}`}>
      <div className="file-preview-html-mode" role="group" aria-label="HTML preview mode">
        <ButtonControl
          aria-pressed={!showSource}
          className="file-preview-html-mode-button"
          onClick={() => setShowSource(false)}
        >
          {labels.htmlRenderMode}
        </ButtonControl>
        <ButtonControl
          aria-pressed={showSource}
          className="file-preview-html-mode-button"
          onClick={() => setShowSource(true)}
        >
          {labels.htmlSourceMode}
        </ButtonControl>
      </div>
      {showSource ? (
        <div className="file-preview-code file-preview-html-source" data-preserve-selection data-preview-text dangerouslySetInnerHTML={{ __html: sourceHtml }} />
      ) : (
        <iframe
          className="file-preview-html-frame"
          onLoad={interceptFrameLinks}
          ref={iframeRef}
          sandbox="allow-same-origin"
          srcDoc={textState.text}
          title={labels.htmlFrameTitle({ name: source.name })}
        />
      )}
    </div>
  );
}

function closestAnchorFromEventTarget(target: EventTarget | null): HTMLAnchorElement | null {
  if (!target || typeof target !== 'object' || !('closest' in target)) return null;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== 'function') return null;
  const anchor = closest.call(target, 'a[href]');
  return isHtmlAnchorLike(anchor) ? anchor : null;
}

function isHtmlAnchorLike(value: unknown): value is HTMLAnchorElement {
  return typeof value === 'object'
    && value !== null
    && 'href' in value
    && typeof (value as { href?: unknown }).href === 'string';
}

function MarkdownPreview({ source }: PreviewRendererProps) {
  const textState = usePreviewText(source.target);
  const labels = useT().shell.filePreview;
  if (textState.status === 'loading') return <PreviewMessage>{labels.loading}</PreviewMessage>;
  if (textState.status === 'error') return <PreviewMessage>{textState.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>;
  return (
    <article className="file-preview-markdown" data-preserve-selection data-preview-text>
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
    <div className="file-preview-table-wrap" data-preserve-selection data-preview-text>
      <div className="file-preview-table-scroll">
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
  return <div className="file-preview-code" data-preserve-selection data-preview-text dangerouslySetInnerHTML={{ __html: html }} />;
}

function EpubPreviewLoader(props: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const [component, setComponent] = useState<PreviewRendererEntry['component'] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setComponent(null);
    setFailed(false);
    void import('./EpubPreview')
      .then(({ EpubPreview }) => {
        if (!cancelled) setComponent(() => EpubPreview);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) return <PreviewMessage>{labels.unavailable}</PreviewMessage>;
  if (!component) return <PreviewMessage>{labels.loading}</PreviewMessage>;
  const EpubPreview = component;
  return <EpubPreview {...props} />;
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
  const targetKey = previewReadingPositionKey(source.target);
  const sessionDocument = state.status === 'ready' ? state.document : null;
  const initialReadingPosition = useReadingPositionSession(
    targetKey,
    displayMode,
    sessionDocument,
    readPdfReadingPosition,
  );

  const persistReadingPosition = useCallback((position: PdfReadingPosition) => {
    writePdfReadingPosition(targetKey, position);
  }, [targetKey]);

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
        void loadingTask?.destroy();
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
  if (state.status === 'error') {
    return <PdfUnavailablePreview source={source} message={pdfPreviewErrorLabel(labels, state.error)} />;
  }

  // Key on the document fingerprint so navigating this same pane to a different PDF
  // remounts the page list: otherwise the position-keyed LazyPdfPages keep their
  // `visible`/rendered canvases and the previous document's pages flash through until
  // the new pages re-render.
  return (
    <PdfPages
      key={state.document.fingerprints?.[0] ?? undefined}
      document={state.document}
      displayMode={displayMode}
      initialReadingPosition={initialReadingPosition}
      onReadingPositionChange={persistReadingPosition}
      onSummaryPageSelect={onSummaryPageSelect}
      pageCount={state.pageCount}
      scrollToPageNumber={scrollToPageNumber}
      onScrollToPageNumberConsumed={onScrollToPageNumberConsumed}
      scrollRootRef={scrollRootRef}
    />
  );
}

function pdfPreviewErrorLabel(labels: FilePreviewLabels, error: string | undefined): string {
  return error === 'too-large' ? labels.tooLarge : labels.unavailable;
}

/**
 * Every PDF page stacked vertically, scrolled to navigate (no page-nav, no zoom).
 * Each page renders lazily as it nears the scroll viewport; until then a placeholder
 * reserves its height so mounting never shifts the scroll position. The first page's
 * aspect is the fallback, while rendered pages and explicit restore targets report
 * their real aspect so mixed-size PDFs do not restore against a stale placeholder.
 */
function PdfPages({
  displayMode,
  document: pdfDocument,
  initialReadingPosition,
  onReadingPositionChange,
  onSummaryPageSelect,
  onScrollToPageNumberConsumed,
  pageCount,
  scrollToPageNumber,
  scrollRootRef,
}: {
  displayMode: FilePreviewDisplayMode;
  document: PDFDocumentProxy;
  initialReadingPosition?: PdfReadingPosition | null;
  onReadingPositionChange?: (position: PdfReadingPosition) => void;
  onSummaryPageSelect?: (pageNumber: number) => void;
  onScrollToPageNumberConsumed?: () => void;
  pageCount: number;
  scrollToPageNumber?: number | null;
  scrollRootRef?: RefObject<HTMLElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollReportFrameRef = useRef<number | null>(null);
  const previousDisplayModeRef = useRef<FilePreviewDisplayMode>(displayMode);
  const fullSessionRef = useRef(displayMode === 'full' ? 1 : 0);
  const restoredSessionRef = useRef(0);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [aspect, setAspect] = useState(PDF_FALLBACK_ASPECT);
  const [pageAspects, setPageAspects] = useState<Record<number, number>>({});
  const [outlineItems, setOutlineItems] = useState<DocumentOutlineItem[]>([]);

  const setPageAspect = useCallback((pageNumber: number, nextAspect: number) => {
    if (!Number.isFinite(nextAspect) || nextAspect <= 0) return;
    setPageAspects((current) => {
      if (Math.abs((current[pageNumber] ?? 0) - nextAspect) < 0.001) return current;
      return { ...current, [pageNumber]: nextAspect };
    });
  }, []);

  if (displayMode !== previousDisplayModeRef.current) {
    if (displayMode === 'full') fullSessionRef.current += 1;
    previousDisplayModeRef.current = displayMode;
  }

  useEffect(() => {
    let cancelled = false;
    void pdfDocument.getPage(1).then((page) => {
      const nextAspect = pdfPageAspect(page);
      if (!cancelled) {
        setAspect(nextAspect);
        setPageAspect(1, nextAspect);
      }
      page.cleanup();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pdfDocument, setPageAspect]);

  useEffect(() => {
    if (displayMode !== 'full') {
      setOutlineItems((current) => current.length === 0 ? current : []);
      return undefined;
    }

    let cancelled = false;
    void readPdfOutlineItems(pdfDocument, pageCount).then((items) => {
      if (!cancelled) setOutlineItems(items);
    }).catch(() => {
      if (!cancelled) setOutlineItems([]);
    });

    return () => {
      cancelled = true;
    };
  }, [displayMode, pageCount, pdfDocument]);

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
  const outlineLayoutVersion = `${pageWidth}:${pageCount}:${Object.keys(pageAspects).length}`;
  const resolvePdfOutlineTop = useCallback((item: DocumentOutlineItem, scrollRoot: HTMLElement) => {
    const target = item.target as Partial<PdfOutlineTarget>;
    if (typeof target.pageNumber !== 'number') return null;
    const pageElement = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page-number="${target.pageNumber}"]`);
    if (!pageElement) return null;
    // Scroll-content coordinates (what scrollTo/scrollTop compare against), not
    // offsetParent-relative offsetTop, so the marker stays accurate if the scrollport
    // gains padding or a positioned wrapper.
    const rootRect = scrollRoot.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    return scrollRoot.scrollTop + (pageRect.top - rootRect.top);
  }, []);
  const restoreTargetPageNumber = useMemo(() => {
    if (displayMode !== 'full') return null;
    const targetPageNumber = scrollToPageNumber ?? initialReadingPosition?.pageNumber;
    if (!targetPageNumber) return null;
    return Math.max(1, Math.min(pageCount, Math.floor(targetPageNumber)));
  }, [displayMode, initialReadingPosition, pageCount, scrollToPageNumber]);
  const restoreTargetAspectReady = !restoreTargetPageNumber || Boolean(pageAspects[restoreTargetPageNumber]);

  useEffect(() => {
    if (!restoreTargetPageNumber || pageAspects[restoreTargetPageNumber]) return undefined;
    let cancelled = false;
    void pdfDocument.getPage(restoreTargetPageNumber).then((page) => {
      const nextAspect = pdfPageAspect(page);
      if (!cancelled) setPageAspect(restoreTargetPageNumber, nextAspect);
      page.cleanup();
    }).catch(() => {
      if (!cancelled) setPageAspect(restoreTargetPageNumber, aspect);
    });
    return () => {
      cancelled = true;
    };
  }, [aspect, pageAspects, pdfDocument, restoreTargetPageNumber, setPageAspect]);

  useEffect(() => {
    if (displayMode !== 'full' || !scrollToPageNumber || pageWidth <= 0 || !restoreTargetAspectReady) return undefined;
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
        restoredSessionRef.current = fullSessionRef.current;
      }
      onScrollToPageNumberConsumed?.();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [displayMode, onScrollToPageNumberConsumed, pageScrollRootRef, pageWidth, restoreTargetAspectReady, scrollToPageNumber]);

  useEffect(() => {
    if (
      displayMode !== 'full'
      || pageWidth <= 0
      || !restoreTargetAspectReady
      || scrollToPageNumber
      || restoredSessionRef.current === fullSessionRef.current
    ) {
      return undefined;
    }
    if (!initialReadingPosition) {
      restoredSessionRef.current = fullSessionRef.current;
      return undefined;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      const scrollRoot = pageScrollRootRef.current;
      const pageNumber = Math.max(1, Math.min(pageCount, initialReadingPosition.pageNumber));
      const pageElement = containerRef.current?.querySelector<HTMLElement>(`[data-pdf-page-number="${pageNumber}"]`);
      if (scrollRoot && pageElement) {
        const rootRect = scrollRoot.getBoundingClientRect();
        const pageRect = pageElement.getBoundingClientRect();
        const pageOffset = pageRect.height * initialReadingPosition.pageOffsetRatio;
        scrollRoot.scrollTo({
          top: scrollRoot.scrollTop + pageRect.top - rootRect.top + pageOffset,
          behavior: 'auto',
        });
        restoredSessionRef.current = fullSessionRef.current;
      }
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [
    displayMode,
    initialReadingPosition,
    pageCount,
    pageScrollRootRef,
    pageWidth,
    restoreTargetAspectReady,
    scrollToPageNumber,
  ]);

  useEffect(() => () => {
    if (scrollReportFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollReportFrameRef.current);
    }
  }, []);

  const reportReadingPosition = () => {
    if (displayMode !== 'full' || !onReadingPositionChange || scrollReportFrameRef.current !== null) return;
    scrollReportFrameRef.current = window.requestAnimationFrame(() => {
      scrollReportFrameRef.current = null;
      const position = currentPdfReadingPosition(containerRef.current);
      if (position) onReadingPositionChange(position);
    });
  };

  const pages = (
    <div
      className={`file-preview-pdf file-preview-pdf--${displayMode}`}
      onScroll={reportReadingPosition}
      ref={containerRef}
    >
      {Array.from({ length: pageCount }, (_, index) => (
        <LazyPdfPage
          key={index}
          aspect={pageAspects[index + 1] ?? aspect}
          document={pdfDocument}
          displayMode={displayMode}
          onPageAspectMeasured={setPageAspect}
          onSummaryPageSelect={onSummaryPageSelect}
          pageNumber={index + 1}
          scrollRootRef={pageScrollRootRef}
          width={pageWidth}
        />
      ))}
    </div>
  );

  if (displayMode !== 'full') return pages;

  return (
    <div className="file-preview-pdf-shell file-preview-pdf-shell--full">
      {pages}
      {displayMode === 'full' && outlineItems.length > 0 ? (
        <DocumentOutlineRail
          items={outlineItems}
          layoutVersion={outlineLayoutVersion}
          resolveItemTop={resolvePdfOutlineTop}
          scrollRootRef={pageScrollRootRef}
        />
      ) : null}
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

function pdfPageAspect(page: PDFPageProxy): number {
  const viewport = page.getViewport({ scale: 1 });
  return viewport.width > 0 ? viewport.height / viewport.width : PDF_FALLBACK_ASPECT;
}

function fittedPdfViewport(page: PDFPageProxy, width: number) {
  const baseViewport = page.getViewport({ scale: 1 });
  const fitScale = baseViewport.width > 0 ? width / baseViewport.width : 1;
  return {
    aspect: baseViewport.width > 0 ? baseViewport.height / baseViewport.width : PDF_FALLBACK_ASPECT,
    viewport: page.getViewport({ scale: fitScale }),
  };
}

function currentPdfReadingPosition(scrollRoot: HTMLElement | null): PdfReadingPosition | null {
  if (!scrollRoot) return null;
  const pages = Array.from(scrollRoot.querySelectorAll<HTMLElement>('.file-preview-pdf-page'));
  if (pages.length === 0) return null;
  const rootRect = scrollRoot.getBoundingClientRect();
  const viewportTop = rootRect.top + 1;
  const currentPage = pages.find((page) => page.getBoundingClientRect().bottom > viewportTop)
    ?? pages[pages.length - 1];
  const pageNumber = Number(currentPage.dataset.pdfPageNumber);
  if (!Number.isFinite(pageNumber) || pageNumber < 1) return null;
  const pageRect = currentPage.getBoundingClientRect();
  const pageOffset = Math.max(0, Math.min(pageRect.height, viewportTop - pageRect.top));
  const pageOffsetRatio = pageRect.height > 0 ? pageOffset / pageRect.height : 0;
  return {
    pageNumber,
    pageOffsetRatio,
    updatedAt: Date.now(),
  };
}

async function readPdfOutlineItems(pdfDocument: PDFDocumentProxy, pageCount: number): Promise<DocumentOutlineItem[]> {
  const outline = await pdfDocument.getOutline();
  if (!Array.isArray(outline) || outline.length === 0) return [];

  const items: DocumentOutlineItem[] = [];
  const visit = async (nodes: PdfOutlineNode[], level: number) => {
    for (const node of nodes) {
      const pageNumber = await pdfOutlinePageNumber(pdfDocument, node.dest, pageCount);
      const title = typeof node.title === 'string' ? node.title.trim() : '';
      if (pageNumber && title) {
        items.push({
          id: `pdf-outline-${items.length}:${pageNumber}:${title}`,
          level,
          target: { pageNumber } satisfies PdfOutlineTarget,
          title,
        });
      }
      if (Array.isArray(node.items) && node.items.length > 0) {
        await visit(node.items, level + 1);
      }
    }
  };

  await visit(outline as PdfOutlineNode[], 0);
  return items;
}

async function pdfOutlinePageNumber(
  pdfDocument: PDFDocumentProxy,
  dest: string | unknown[] | null,
  pageCount: number,
): Promise<number | null> {
  const destination = typeof dest === 'string'
    ? await pdfDocument.getDestination(dest).catch(() => null)
    : Array.isArray(dest) ? dest : null;
  const pageRef = destination?.[0];
  if (typeof pageRef === 'number') {
    const pageNumber = pageRef + 1;
    return pageNumber >= 1 && pageNumber <= pageCount ? pageNumber : null;
  }
  if (!isPdfRefProxy(pageRef)) return null;
  const pageNumber = await pdfDocument.getPageIndex(pageRef).then((index) => index + 1).catch(() => null);
  if (!pageNumber || pageNumber < 1 || pageNumber > pageCount) return null;
  return pageNumber;
}

function isPdfRefProxy(value: unknown): value is PdfRefProxy {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PdfRefProxy>;
  return typeof record.num === 'number' && typeof record.gen === 'number';
}

function LazyPdfPage({
  aspect,
  document: pdfDocument,
  displayMode,
  onPageAspectMeasured,
  onSummaryPageSelect,
  pageNumber,
  scrollRootRef,
  width,
}: {
  aspect: number;
  document: PDFDocumentProxy;
  displayMode: FilePreviewDisplayMode;
  onPageAspectMeasured?: (pageNumber: number, aspect: number) => void;
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
          onPageAspectMeasured={onPageAspectMeasured}
          selectableText={!summary}
          pageNumber={pageNumber}
          width={width}
        />
      ) : null}
    </div>
  );
}

function PdfPageCanvas({
  document: pdfDocument,
  onPageAspectMeasured,
  pageNumber,
  selectableText,
  width,
}: {
  document: PDFDocumentProxy;
  onPageAspectMeasured?: (pageNumber: number, aspect: number) => void;
  pageNumber: number;
  selectableText: boolean;
  width: number;
}) {
  const labels = useT().shell.filePreview;
  const [state, setState] = useState<
    | { status: 'rendering' }
    | { status: 'ready' }
    | { status: 'error'; error?: string }
  >({ status: 'rendering' });
  const [canvasElement, setCanvasElement] = useState<HTMLCanvasElement | null>(null);
  const setCanvasRef = useCallback((element: HTMLCanvasElement | null) => {
    setCanvasElement(element);
  }, []);

  useEffect(() => {
    if (!canvasElement) return undefined;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setState({ status: 'rendering' });

    void (async () => {
      const canvas = canvasElement;
      canvas.width = 0;
      canvas.height = 0;
      canvas.style.width = '0px';
      canvas.style.height = '0px';
      const page = await pdfDocument.getPage(pageNumber);
      try {
        if (cancelled) return;
        const { aspect, viewport } = fittedPdfViewport(page, width);
        onPageAspectMeasured?.(pageNumber, aspect);
        // Fit each page to the available width; cap the device-pixel scale so a wide
        // Retina pane does not allocate an oversized canvas.
        const pixelRatio = Math.min(window.devicePixelRatio || 1, PDF_MAX_RENDER_SCALE);
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
  }, [canvasElement, pdfDocument, pageNumber, width]);

  return (
    <div className="file-preview-pdf-stage">
      {state.status === 'rendering' ? <PreviewMessage>{labels.loading}</PreviewMessage> : null}
      {state.status === 'error' ? <PreviewMessage>{labels.unavailable}</PreviewMessage> : null}
      <canvas
        ref={setCanvasRef}
        aria-label={labels.pdfCanvas({ page: pageNumber })}
        className="file-preview-pdf-canvas"
      />
      {selectableText ? (
        <PdfPageTextLayer
          document={pdfDocument}
          pageNumber={pageNumber}
          width={width}
        />
      ) : null}
    </div>
  );
}

function PdfPageTextLayer({
  document: pdfDocument,
  pageNumber,
  width,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    let textLayer: InstanceType<PdfJsModule['TextLayer']> | null = null;
    const layer = layerRef.current;
    if (!layer || width <= 0) return undefined;
    layer.replaceChildren();
    setState('loading');

    void (async () => {
      const page = await pdfDocument.getPage(pageNumber);
      try {
        if (cancelled) return;
        const { viewport } = fittedPdfViewport(page, width);
        const textContent = await page.getTextContent();
        if (cancelled) return;
        const pdfjs = await loadPdfJs();
        if (cancelled) return;
        textLayer = new pdfjs.TextLayer({
          container: layer,
          textContentSource: textContent,
          viewport,
        });
        await textLayer.render();
        if (!cancelled) setState('ready');
      } finally {
        page.cleanup();
      }
    })().catch(() => {
      if (!cancelled) setState('error');
    });

    return () => {
      cancelled = true;
      textLayer?.cancel();
      layer.replaceChildren();
    };
  }, [pdfDocument, pageNumber, width]);

  return (
    <div
      aria-hidden={state !== 'ready' ? 'true' : undefined}
      className={`textLayer file-preview-pdf-text-layer ${state}`}
      data-preserve-selection
      ref={layerRef}
    />
  );
}

function PdfUnavailablePreview({ message, source }: { message: string; source: PreviewFileSource }) {
  return (
    <div className="file-preview-unavailable-metadata">
      <MetadataPreview source={source} />
      <p className="file-preview-unavailable-note">{message}</p>
    </div>
  );
}

export function MetadataPreview({ source }: { source: PreviewFileSource }) {
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
  if (kind === 'local-file' || kind === 'linked-file') return labels.sourceLocalFile;
  return labels.sourceAsset;
}

export function targetTitleFallback(target: PreviewTarget): string {
  if (target.kind === 'local-file') return target.path.split('/').filter(Boolean).at(-1) ?? target.path;
  if (target.kind === 'asset') return target.assetId;
  if (target.kind === 'linked-file') return target.label ?? target.sourceText;
  return target.url;
}

function isImageSource(source: PreviewFileSource): boolean {
  return mediaKindForMimeType(source.mimeType) === 'image';
}

function isAudioSource(source: PreviewFileSource): boolean {
  return source.entryKind === 'file' && mediaKindForMimeType(source.mimeType) === 'audio';
}

function isVideoSource(source: PreviewFileSource): boolean {
  return source.entryKind === 'file' && mediaKindForMimeType(source.mimeType) === 'video';
}

function mediaKindForSource(source: PreviewSourceDescriptor): 'audio' | 'video' | null {
  if (source.kind !== 'file') return null;
  if (isAudioSource(source)) return 'audio';
  if (isVideoSource(source)) return 'video';
  return null;
}

function documentKindForSource(source: PreviewFileSource): 'epub' | 'html' | 'pdf' | null {
  if (isPdfSource(source)) return 'pdf';
  if (isEpubSource(source)) return 'epub';
  if (isHtmlSource(source)) return 'html';
  return null;
}

function isHtmlSource(source: PreviewFileSource): boolean {
  return source.entryKind === 'file'
    && (source.ext === 'html' || source.ext === 'htm' || source.mimeType.toLowerCase() === 'text/html');
}

function isPdfSource(source: PreviewFileSource): boolean {
  return source.entryKind === 'file'
    && (source.mimeType.toLowerCase() === 'application/pdf' || source.ext === 'pdf');
}

export function isEpubSource(source: PreviewFileSource): boolean {
  return source.entryKind === 'file'
    && (source.mimeType.toLowerCase() === 'application/epub+zip' || source.ext === 'epub');
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
  return formatDateTime(value, undefined, PREVIEW_MODIFIED_DATE_OPTIONS);
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
    await window.lin?.openLocalFile?.({
      path: source.target.path,
      ...(source.target.threadId && source.target.attachmentId
        ? { threadId: source.target.threadId, attachmentId: source.target.attachmentId }
        : {}),
    });
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
    await window.lin?.revealLocalFile?.({
      path: source.target.path,
      ...(source.target.threadId && source.target.attachmentId
        ? { threadId: source.target.threadId, attachmentId: source.target.attachmentId }
        : {}),
    });
  }
}

export function canCopyPreviewSource(source: PreviewSourceDescriptor): boolean {
  return source.kind === 'file' && source.sourceKind === 'asset' && source.target.kind === 'asset';
}

export async function copyPreviewSource(source: PreviewSourceDescriptor): Promise<void> {
  if (canCopyPreviewSource(source) && source.target.kind === 'asset') {
    await api.copyAssetFile(source.target.assetId);
  }
}
