import { useCallback, useEffect, useMemo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  PreviewDirectoryEntry,
  PreviewFileSource,
  PreviewSourceDescriptor,
  PreviewTarget,
} from '../../../core/preview';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { BackIcon, FileTextIcon, FolderIcon, ICON_SIZE, OpenIcon } from '../icons';
import { inlineFileIconKind, INLINE_FILE_ICON_CLASS } from '../editor/inlineFileIcon';
import { highlightCode, isKnownCodeLanguage, plainCodeHtml } from '../editor/shikiHighlighter';
import { normalizeCodeLanguage } from '../editor/codeLanguages';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';

interface FilePreviewPanelProps {
  canGoBack: boolean;
  onBack: () => void;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  target: PreviewTarget;
}

type SourceState =
  | { status: 'loading' }
  | { status: 'ready'; source: PreviewSourceDescriptor }
  | { status: 'missing'; error?: string };

type TextState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; error?: string };

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 24;

export function FilePreviewPanel({
  canGoBack,
  onBack,
  onOpenTarget,
  target,
}: FilePreviewPanelProps) {
  const t = useT();
  const labels = t.shell.filePreview;
  const [state, setState] = useState<SourceState>({ status: 'loading' });

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

  const openOriginal = useCallback(() => {
    if (state.status !== 'ready') return;
    void openPreviewSource(state.source);
  }, [state]);

  const title = state.status === 'ready'
    ? sourceTitle(state.source)
    : target.label ?? targetTitleFallback(target);
  const meta = state.status === 'ready' ? sourceMeta(state.source, labels) : null;

  return (
    <section className="main-panel file-preview-panel" aria-label={title}>
      <header className="file-preview-header">
        <div className="file-preview-title-group">
          <div className="file-preview-title-row">
            {canGoBack ? (
              <IconButton
                className="file-preview-back"
                icon={BackIcon}
                label={t.nodePanel.previousPage}
                onClick={onBack}
                variant="panel"
              />
            ) : null}
            <FilePreviewGlyph source={state.status === 'ready' ? state.source : null} target={target} />
            <div className="file-preview-title-text">
              <h1 title={title}>{title}</h1>
              {meta ? <p>{meta}</p> : null}
            </div>
          </div>
        </div>
        {state.status === 'ready' && canOpenPreviewSource(state.source) ? (
          <ButtonControl className="file-preview-open-button" onClick={openOriginal}>
            <OpenIcon size={ICON_SIZE.menu} />
            <span>{labels.open}</span>
          </ButtonControl>
        ) : null}
      </header>

      <div className="file-preview-content">
        {state.status === 'loading' ? (
          <PreviewMessage>{labels.loading}</PreviewMessage>
        ) : state.status === 'missing' ? (
          <PreviewMessage>{state.error === 'too-large' ? labels.tooLarge : labels.unavailable}</PreviewMessage>
        ) : (
          <PreviewRenderer source={state.source} onOpenTarget={onOpenTarget} />
        )}
      </div>
    </section>
  );
}

function PreviewRenderer({
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
  if (source.entryKind === 'directory') {
    return <DirectoryPreview onOpenTarget={onOpenTarget} source={source} />;
  }
  if (isImageSource(source)) return <ImagePreview source={source} />;
  if (isMarkdownSource(source)) return <MarkdownPreview source={source} />;
  if (isDelimitedSource(source)) return <DelimitedPreview source={source} />;
  if (isTextSource(source)) return <TextPreview source={source} />;
  return <MetadataPreview source={source} />;
}

function DirectoryPreview({
  onOpenTarget,
  source,
}: {
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  source: PreviewFileSource;
}) {
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
            onClick={() => onOpenTarget(entry.target)}
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

function ImagePreview({ source }: { source: PreviewFileSource }) {
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

function MarkdownPreview({ source }: { source: PreviewFileSource }) {
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

function DelimitedPreview({ source }: { source: PreviewFileSource }) {
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

function TextPreview({ source }: { source: PreviewFileSource }) {
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

function usePreviewText(target: PreviewTarget): TextState {
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

function FilePreviewGlyph({
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

function PreviewMessage({ children }: { children: string }) {
  return <div className="file-preview-message">{children}</div>;
}

function sourceTitle(source: PreviewSourceDescriptor): string {
  if (source.kind === 'url') return source.title;
  return source.name;
}

function sourceMeta(source: PreviewSourceDescriptor, labels: ReturnType<typeof useT>['shell']['filePreview']): string {
  if (source.kind === 'url') return labels.sourceUrl;
  const parts = [sourceKindLabel(source.sourceKind, labels), formatBytes(source.sizeBytes)];
  if (source.entryKind === 'directory') parts[1] = labels.directory;
  if (source.lastModified) parts.push(labels.modified({ date: formatModifiedDate(source.lastModified) }));
  return parts.join(' · ');
}

function sourceKindLabel(kind: PreviewFileSource['sourceKind'], labels: ReturnType<typeof useT>['shell']['filePreview']): string {
  if (kind === 'local-file') return labels.sourceLocalFile;
  if (kind === 'asset') return labels.sourceAsset;
  return labels.sourceAgentPayload;
}

function targetTitleFallback(target: PreviewTarget): string {
  if (target.kind === 'local-file') return target.path.split('/').filter(Boolean).at(-1) ?? target.path;
  if (target.kind === 'asset') return target.assetId;
  if (target.kind === 'agent-payload') return target.payloadId;
  return target.url;
}

function isImageSource(source: PreviewFileSource): boolean {
  return source.mimeType.toLowerCase().startsWith('image/');
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

function formatBytes(bytes: number): string {
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

function formatModifiedDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function canOpenPreviewSource(source: PreviewSourceDescriptor): boolean {
  if (source.kind === 'url') return true;
  return source.sourceKind === 'local-file' || source.sourceKind === 'asset';
}

async function openPreviewSource(source: PreviewSourceDescriptor): Promise<void> {
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
