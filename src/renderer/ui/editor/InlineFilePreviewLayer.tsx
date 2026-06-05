import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  INLINE_FILE_ICON_CLASS,
  inlineFileIconKind,
} from './inlineFileIcon';
import type { InlineFilePreviewDescriptor } from './inlineFilePreviewData';
import { useT } from '../../i18n/I18nProvider';

interface InlineFilePreviewFile extends InlineFilePreviewDescriptor {
  entryKind: 'file' | 'directory';
  mimeType: string;
  name: string;
  path?: string;
}

interface InlineFilePreviewState {
  anchorRect: DOMRectReadOnly;
  file: InlineFilePreviewFile;
  status: 'loading' | 'ready' | 'missing';
}

const SHOW_DELAY_MS = 450;
const HIDE_DELAY_MS = 80;
const POPOVER_GAP = 8;
const POPOVER_WIDTH = 292;
const POPOVER_MIN_HEIGHT = 120;

export function InlineFilePreviewLayer() {
  const t = useT();
  const [preview, setPreview] = useState<InlineFilePreviewState | null>(null);
  const activeElementRef = useRef<HTMLElement | null>(null);
  const pendingElementRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    function clearShowTimer() {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      pendingElementRef.current = null;
    }

    function clearHideTimer() {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    }

    function hidePreview() {
      clearShowTimer();
      activeElementRef.current = null;
      requestIdRef.current += 1;
      setPreview(null);
    }

    function scheduleHide() {
      clearShowTimer();
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(hidePreview, HIDE_DELAY_MS);
    }

    function showPreviewFor(element: HTMLElement, immediate = false) {
      clearHideTimer();
      if (activeElementRef.current === element && previewElementStillConnected(element)) return;
      clearShowTimer();
      const run = () => {
        showTimerRef.current = null;
        pendingElementRef.current = null;
        if (!previewElementStillConnected(element)) return;
        const file = fileFromElement(element);
        if (!file) return;
        const anchorRect = element.getBoundingClientRect();
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        activeElementRef.current = element;
        setPreview({
          anchorRect,
          file,
          status: file.path && window.lin?.previewLocalFileReference ? 'loading' : 'ready',
        });
        if (!file.path || !window.lin?.previewLocalFileReference) return;
        void window.lin.previewLocalFileReference({ path: file.path })
          .then((result) => {
            if (requestIdRef.current !== requestId || activeElementRef.current !== element) return;
            setPreview({
              anchorRect: element.getBoundingClientRect(),
              file: result.file ? { ...file, ...result.file } : file,
              status: result.file ? 'ready' : 'missing',
            });
          })
          .catch(() => {
            if (requestIdRef.current !== requestId || activeElementRef.current !== element) return;
            setPreview({
              anchorRect: element.getBoundingClientRect(),
              file,
              status: 'missing',
            });
          });
      };
      if (immediate) {
        run();
        return;
      }
      pendingElementRef.current = element;
      showTimerRef.current = window.setTimeout(run, SHOW_DELAY_MS);
    }

    function handlePointerOver(event: PointerEvent) {
      const element = inlineFileElementFromTarget(event.target);
      if (!element) return;
      showPreviewFor(element);
    }

    function handlePointerOut(event: PointerEvent) {
      const element = inlineFileElementFromTarget(event.target);
      if (!element) return;
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      if (pendingElementRef.current === element) clearShowTimer();
      if (activeElementRef.current === element) scheduleHide();
    }

    function handleFocusIn(event: FocusEvent) {
      const element = inlineFileElementFromTarget(event.target);
      if (element) showPreviewFor(element, true);
    }

    function handleFocusOut(event: FocusEvent) {
      const element = inlineFileElementFromTarget(event.target);
      if (!element) return;
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      if (activeElementRef.current === element) scheduleHide();
    }

    function handlePointerDown(event: PointerEvent) {
      const element = inlineFileElementFromTarget(event.target);
      if (element === activeElementRef.current) return;
      hidePreview();
    }

    function handleClick(event: MouseEvent) {
      const element = inlineFileElementFromTarget(event.target);
      if (!element) return;
      if (isEditableInlineFileElement(element)) {
        hidePreview();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const file = fileFromElement(element);
      if (!file?.path || !window.lin?.openLocalFile) {
        hidePreview();
        return;
      }
      void window.lin.openLocalFile({ path: file.path });
      hidePreview();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isPreviewPreservingKey(event)) return;
      hidePreview();
    }

    function handleInput() {
      hidePreview();
    }

    function updateAnchorRect() {
      const element = activeElementRef.current;
      if (!element?.isConnected) {
        hidePreview();
        return;
      }
      setPreview((current) => current
        ? { ...current, anchorRect: element.getBoundingClientRect() }
        : current);
    }

    document.addEventListener('pointerover', handlePointerOver);
    document.addEventListener('pointerout', handlePointerOut);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('click', handleClick, true);
    window.addEventListener('scroll', updateAnchorRect, true);
    window.addEventListener('resize', updateAnchorRect);
    return () => {
      clearShowTimer();
      clearHideTimer();
      requestIdRef.current += 1;
      activeElementRef.current = null;
      pendingElementRef.current = null;
      document.removeEventListener('pointerover', handlePointerOver);
      document.removeEventListener('pointerout', handlePointerOut);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('scroll', updateAnchorRect, true);
      window.removeEventListener('resize', updateAnchorRect);
    };
  }, []);

  if (!preview) return null;
  const file = preview.file;
  const style = previewStyle(preview.anchorRect);
  const imagePreview = Boolean(file.thumbnailDataUrl && isImageFile(file));
  const details = fileDetails(file, t.agent.filePreview.file, t.agent.filePreview.folder);
  const modified = file.lastModified && Number.isFinite(file.lastModified)
    ? t.agent.filePreview.modified({ date: formatModifiedDate(file.lastModified) })
    : null;
  return (
    <div
      className={[
        'inline-file-preview-popover',
        imagePreview ? 'has-image' : '',
      ].filter(Boolean).join(' ')}
      data-inline-file-preview
      role="tooltip"
      style={style}
    >
      {imagePreview ? (
        <div className="inline-file-preview-image">
          <img alt="" src={file.thumbnailDataUrl} />
        </div>
      ) : null}
      <div className="inline-file-preview-card">
        {!imagePreview ? <FilePreviewIcon file={file} /> : null}
        <div className="inline-file-preview-body">
          <div className="inline-file-preview-name" title={file.name}>{file.name}</div>
          <div className="inline-file-preview-meta">{details}</div>
          {file.path ? <div className="inline-file-preview-path" title={file.path}>{file.path}</div> : null}
          {modified ? <div className="inline-file-preview-meta">{modified}</div> : null}
          {preview.status === 'missing' ? (
            <div className="inline-file-preview-warning">{t.agent.filePreview.unavailable}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FilePreviewIcon({ file }: { file: InlineFilePreviewFile }) {
  if (file.iconDataUrl) {
    return <img alt="" className="inline-file-preview-native-icon" src={file.iconDataUrl} />;
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-file-preview-mask-icon ${INLINE_FILE_ICON_CLASS}`}
      data-file-icon-kind={inlineFileIconKind(file)}
    />
  );
}

function inlineFileElementFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>('[data-inline-ref-kind="local-file"]');
}

function isEditableInlineFileElement(element: HTMLElement): boolean {
  return Boolean(element.closest('.ProseMirror, [contenteditable="true"], .agent-composer-editor'));
}

function isPreviewPreservingKey(event: KeyboardEvent): boolean {
  if (event.key === 'Escape') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return true;
  return [
    'Alt',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'CapsLock',
    'Control',
    'End',
    'Home',
    'Meta',
    'PageDown',
    'PageUp',
    'Shift',
    'Tab',
  ].includes(event.key);
}

function previewElementStillConnected(element: HTMLElement): boolean {
  return element.isConnected && document.contains(element);
}

function fileFromElement(element: HTMLElement): InlineFilePreviewFile | null {
  const dataset = element.dataset;
  if (dataset.inlineRefKind !== 'local-file') return null;
  const name = dataset.inlineRefName || element.textContent?.trim() || dataset.inlineRefRef || 'file';
  const mimeType = dataset.inlineRefMimeType || (dataset.inlineRefEntryKind === 'directory'
    ? 'inode/directory'
    : 'application/octet-stream');
  return {
    entryKind: dataset.inlineRefEntryKind === 'directory' || mimeType === 'inode/directory' ? 'directory' : 'file',
    iconDataUrl: dataset.inlineRefIconDataUrl,
    lastModified: finiteNumber(dataset.inlineRefLastModified),
    mimeType,
    name,
    path: dataset.inlineRefPath,
    ref: dataset.inlineRefRef,
    sizeBytes: finiteNumber(dataset.inlineRefSizeBytes),
    thumbnailDataUrl: dataset.inlineRefThumbnailDataUrl,
  };
}

function finiteNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function previewStyle(anchorRect: DOMRectReadOnly): CSSProperties {
  const width = Math.min(POPOVER_WIDTH, Math.max(180, window.innerWidth - POPOVER_GAP * 2));
  const left = clamp(anchorRect.left, POPOVER_GAP, window.innerWidth - width - POPOVER_GAP);
  const availableBelow = window.innerHeight - anchorRect.bottom - (POPOVER_GAP * 2);
  const availableAbove = anchorRect.top - (POPOVER_GAP * 2);
  if (availableBelow >= POPOVER_MIN_HEIGHT || availableBelow >= availableAbove) {
    return {
      left,
      maxHeight: Math.max(POPOVER_MIN_HEIGHT, availableBelow),
      top: anchorRect.bottom + POPOVER_GAP,
      width,
    };
  }
  return {
    bottom: window.innerHeight - anchorRect.top + POPOVER_GAP,
    left,
    maxHeight: Math.max(POPOVER_MIN_HEIGHT, availableAbove),
    width,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isImageFile(file: InlineFilePreviewFile): boolean {
  return file.entryKind !== 'directory' && file.mimeType.toLowerCase().startsWith('image/');
}

function fileDetails(file: InlineFilePreviewFile, fileLabel: string, folderLabel: string): string {
  if (file.entryKind === 'directory') return folderLabel;
  const type = file.mimeType && file.mimeType !== 'application/octet-stream' ? file.mimeType : fileLabel;
  const size = typeof file.sizeBytes === 'number' && Number.isFinite(file.sizeBytes) && file.sizeBytes > 0
    ? formatBytes(file.sizeBytes)
    : null;
  return [type, size].filter(Boolean).join(' - ');
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
