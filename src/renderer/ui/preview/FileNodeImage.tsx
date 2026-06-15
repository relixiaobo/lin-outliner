import { useEffect, useMemo, useState } from 'react';
import { assetUrl } from '../../../core/assets';
import { useT } from '../../i18n/I18nProvider';
import { FileNodeActionMenu } from './FileNodeActionMenu';
import { fileNodeTarget, type FileNode } from './fileNode';
import { usePreviewObjectUrl } from './usePreviewObjectUrl';

type ImageNode = Extract<FileNode, { type: 'image' }>;

/**
 * An image file node's outliner row content: the image itself, rendered inline as a
 * bounded preview — an image's content is its identity, so it shows directly instead
 * of a file-type icon + filename (other file kinds use FileNodeCard). The filename is
 * displayed read-only on the node page, not in the row. A ⋯ menu sits at the image's
 * top-right, revealed on hover or keyboard focus, offering Maximize (open the node page)
 * plus the asset actions (Open / Reveal / Copy). Clicking the image also maximizes it; the
 * leading bullet/chevron still drill / expand children.
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
  const sourceKey = node.assetId ?? node.mediaUrl ?? null;

  // Prefer the cached asset:// (or remote) URL; read bytes only if that <img> errors —
  // an environment without the asset:// handler (the browser test harness) or a
  // transient protocol error. The shared hook carries the cancel/revoke guard, so a
  // late resolve never paints onto a changed node or leaks its object URL.
  const [needsFallback, setNeedsFallback] = useState(false);
  useEffect(() => { setNeedsFallback(false); }, [sourceKey]);
  // The asset read is keyed by assetId/mediaUrl, so re-memo only when those change
  // (a display-name-only update changes the target's cosmetic label, not the bytes).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => fileNodeTarget(node), [node.assetId, node.mediaUrl, node.type]);
  const fallback = usePreviewObjectUrl(target, { enabled: needsFallback });

  const handleError = () => setNeedsFallback(true);

  const src = fallback.src ?? directSrc;
  const failed = !src || (needsFallback && fallback.error !== undefined && !fallback.src);

  const menu = (
    <div className="file-node-image-actions" data-preserve-selection>
      <FileNodeActionMenu node={node} primaryLabel={ta.maximize} onPrimary={onMaximize} />
    </div>
  );

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
        // A click maximizes the image (its node page); stop the mousedown from
        // reaching the row so it does not also run row pointer-selection.
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
