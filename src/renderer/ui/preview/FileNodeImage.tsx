import { useEffect, useRef, useState } from 'react';
import { assetUrl } from '../../../core/assets';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { FileNodeActionMenu } from './FileNodeActionMenu';
import { fileNodeTarget, type FileNode } from './fileNode';

type ImageNode = Extract<FileNode, { type: 'image' }>;

/**
 * An image file node's outliner row content: the image itself, rendered inline as a
 * bounded preview — an image's content is its identity, so it shows directly instead
 * of a file-type icon + filename (other file kinds use FileNodeCard). The filename is
 * edited on the node page, not in the row. A ⋯ menu sits at the image's top-right,
 * revealed on hover, offering Maximize (open the node page) + Reveal. Clicking the
 * image also maximizes it; the leading bullet/chevron still drill / expand children.
 *
 * Loads through the streaming `asset://` protocol (the same path the node-page image
 * preview uses): Chromium-cached, lazy, range-served and uncapped, so large images
 * render and the outliner hot path pays no per-mount byte read. If that direct source
 * fails — an environment without the asset:// handler (the browser test harness) or a
 * transient protocol error — it falls back once to a sandboxed byte read (object URL),
 * then to an "unavailable" state.
 */
export function FileNodeImage({ node, onMaximize }: { node: ImageNode; onMaximize: () => void }) {
  const ta = useT().outliner.field.attachment;
  const labels = useT().shell.filePreview;
  const directSrc = node.assetId ? assetUrl(node.assetId) : node.mediaUrl ?? null;
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const objectUrlRef = useRef<string | null>(null);

  // Reset the fallback/error state when the backing source changes, and revoke any
  // object URL we created on unmount or before re-resolving.
  const sourceKey = node.assetId ?? node.mediaUrl ?? null;
  useEffect(() => {
    setFallbackSrc(null);
    setFailed(false);
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [sourceKey]);

  const handleError = () => {
    // The direct source (asset:// or a remote URL) failed to load. Try a sandboxed
    // byte read once; if that also fails, settle on the unavailable state.
    if (fallbackSrc) {
      setFailed(true);
      return;
    }
    const target = fileNodeTarget(node);
    if (!target) {
      setFailed(true);
      return;
    }
    void api.readPreviewBytes(target)
      .then((result) => {
        if (!result.bytes) {
          setFailed(true);
          return;
        }
        const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }));
        objectUrlRef.current = url;
        setFallbackSrc(url);
      })
      .catch(() => setFailed(true));
  };

  const menu = (
    <div className="file-node-image-actions" data-preserve-selection>
      <FileNodeActionMenu node={node} primaryLabel={ta.maximize} onPrimary={onMaximize} />
    </div>
  );

  const src = fallbackSrc ?? directSrc;
  if (!src || failed) {
    return (
      <div className="file-node-image file-node-image--missing">
        <span className="file-node-image-fallback">{labels.unavailable}</span>
        {menu}
      </div>
    );
  }

  const hasIntrinsicSize = typeof node.imageWidth === 'number' && typeof node.imageHeight === 'number';
  return (
    <div className="file-node-image">
      <button
        aria-label={labels.open}
        className="file-node-image-button"
        // A click maximizes the image (its node page); keep it off the row, where it
        // would otherwise move edit focus into the hidden filename anchor.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onMaximize();
        }}
        type="button"
      >
        <img
          alt={node.mediaAlt || node.description || ''}
          draggable={false}
          loading="lazy"
          onError={handleError}
          src={src}
          {...(hasIntrinsicSize ? { width: node.imageWidth, height: node.imageHeight } : {})}
        />
      </button>
      {menu}
    </div>
  );
}
