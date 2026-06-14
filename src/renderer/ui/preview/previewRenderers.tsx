/// <reference types="vite/client" />

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
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
  ChevronLeftIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  ICON_SIZE,
  ZoomInIcon,
  ZoomOutIcon,
} from '../icons';
import { inlineFileIconKind, INLINE_FILE_ICON_CLASS } from '../editor/inlineFileIcon';
import { highlightCode, isKnownCodeLanguage, plainCodeHtml } from '../editor/shikiHighlighter';
import { normalizeCodeLanguage } from '../editor/codeLanguages';
import { IconButton } from '../primitives/IconButton';
import { wantsNewPaneFromClick } from '../shared';

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
 * Shared by the standalone preview panel, the file-node page body, and the
 * inline preview block. Pass a referentially-stable `target` (useMemo) so the
 * resolve effect does not re-fire every render.
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
const PDF_DEFAULT_SCALE = 1;
const PDF_MIN_SCALE = 0.5;
const PDF_MAX_SCALE = 2.5;
const PDF_SCALE_STEP = 0.25;

type PdfJsModule = typeof import('pdfjs-dist');

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

export interface PreviewRendererProps {
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  source: PreviewFileSource;
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
  { id: 'markdown', match: isMarkdownSource, component: MarkdownPreview },
  { id: 'delimited', match: isDelimitedSource, component: DelimitedPreview },
  { id: 'text', match: isTextSource, component: TextPreview },
  { id: 'metadata', match: () => true, component: MetadataPreview },
];

export function PreviewRenderer({
  onOpenTarget,
  source,
}: {
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  source: PreviewSourceDescriptor;
}) {
  const labels = useT().shell.filePreview;
  if (source.kind === 'url') {
    return <PreviewMessage>{labels.unsupported}</PreviewMessage>;
  }
  const Renderer = FILE_PREVIEW_RENDERERS.find((entry) => entry.match(source))?.component ?? MetadataPreview;
  return <Renderer onOpenTarget={onOpenTarget} source={source} />;
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
  const initialSrc = source.streamUrl ?? source.thumbnailDataUrl ?? null;
  const [state, setState] = useState<
    | { status: 'loading'; src: string | null }
    | { status: 'ready'; src: string }
    | { status: 'error'; error?: string; src: string | null }
  >(initialSrc ? { status: 'ready', src: initialSrc } : { status: 'loading', src: null });

  useEffect(() => {
    if (source.streamUrl) {
      setState({ status: 'ready', src: source.streamUrl });
      return undefined;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState(source.thumbnailDataUrl
      ? { status: 'loading', src: source.thumbnailDataUrl }
      : { status: 'loading', src: null });
    void api.readPreviewBytes(source.target)
      .then((result) => {
        if (cancelled) return;
        if (!result.bytes) {
          setState({ status: 'error', error: result.error, src: source.thumbnailDataUrl ?? null });
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType ?? source.mimeType }));
        setState({ status: 'ready', src: objectUrl });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: error instanceof Error ? error.message : undefined, src: source.thumbnailDataUrl ?? null });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source]);

  const src = state.src;
  if (!src) return <PreviewMessage>{labels.loading}</PreviewMessage>;
  return (
    <figure className="file-preview-image">
      <img alt={labels.imageAlt({ name: source.name })} src={src} />
      {state.status === 'error' ? <figcaption>{labels.tooLarge}</figcaption> : null}
    </figure>
  );
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

function PdfPreview({ source }: PreviewRendererProps) {
  const labels = useT().shell.filePreview;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; document: PDFDocumentProxy; pageCount: number }
    | { status: 'error'; error?: string }
  >({ status: 'loading' });
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(PDF_DEFAULT_SCALE);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setState({ status: 'loading' });
    setPageNumber(1);
    setScale(PDF_DEFAULT_SCALE);

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

  const canGoPrevious = pageNumber > 1;
  const canGoNext = pageNumber < state.pageCount;
  const canZoomOut = scale > PDF_MIN_SCALE;
  const canZoomIn = scale < PDF_MAX_SCALE;
  const zoomPercent = Math.round(scale * 100);

  return (
    <div className="file-preview-pdf">
      <div className="file-preview-pdf-toolbar" aria-label={labels.pdfToolbar}>
        <div className="file-preview-pdf-control-group">
          <IconButton
            className="file-preview-pdf-icon-button"
            disabled={!canGoPrevious}
            icon={ChevronLeftIcon}
            label={labels.pdfPreviousPage}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
            variant="toolbar"
          />
          <span className="file-preview-pdf-page-label">
            {labels.pdfPage({ page: pageNumber, total: state.pageCount })}
          </span>
          <IconButton
            className="file-preview-pdf-icon-button"
            disabled={!canGoNext}
            icon={ChevronRightIcon}
            label={labels.pdfNextPage}
            onClick={() => setPageNumber((current) => Math.min(state.pageCount, current + 1))}
            variant="toolbar"
          />
        </div>
        <div className="file-preview-pdf-control-group">
          <IconButton
            className="file-preview-pdf-icon-button"
            disabled={!canZoomOut}
            icon={ZoomOutIcon}
            label={labels.pdfZoomOut}
            onClick={() => setScale((current) => clampPdfScale(current - PDF_SCALE_STEP))}
            variant="toolbar"
          />
          <span className="file-preview-pdf-zoom-label">{labels.pdfZoom({ percent: zoomPercent })}</span>
          <IconButton
            className="file-preview-pdf-icon-button"
            disabled={!canZoomIn}
            icon={ZoomInIcon}
            label={labels.pdfZoomIn}
            onClick={() => setScale((current) => clampPdfScale(current + PDF_SCALE_STEP))}
            variant="toolbar"
          />
        </div>
      </div>
      <PdfPageCanvas document={state.document} pageNumber={pageNumber} scale={scale} />
    </div>
  );
}

function PdfPageCanvas({
  document,
  pageNumber,
  scale,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
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
      const page = await document.getPage(pageNumber);
      try {
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        const pixelRatio = window.devicePixelRatio || 1;
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
  }, [document, pageNumber, scale]);

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
  return (
    <div className="file-preview-metadata">
      <FilePreviewGlyph source={source} target={source.target} />
      <div>
        <h2>{labels.unsupported}</h2>
        <dl>
          <div>
            <dt>{labels.metadataType}</dt>
            <dd>{source.mimeType}</dd>
          </div>
          <div>
            <dt>{labels.metadataSize}</dt>
            <dd>{formatBytes(source.sizeBytes)}</dd>
          </div>
          {source.displayPath ? (
            <div>
              <dt>{labels.metadataPath}</dt>
              <dd>{source.displayPath}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </div>
  );
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

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatModifiedDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function clampPdfScale(value: number): number {
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, Number(value.toFixed(2))));
}

function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsModulePromise ??= import('pdfjs-dist').then((module) => {
    module.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
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
