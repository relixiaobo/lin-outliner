import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { DescriptionIcon, ExpandIcon, ICON_SIZE, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';

interface ImageRowProps {
  assetId: string;
  alt?: string;
  width?: number;
  height?: number;
  /** Whether the node already carries a caption (its `description` field). */
  hasCaption?: boolean;
  /** Open the caption editor (the node's `description`). */
  onAddCaption?: () => void;
}

/**
 * Presentational body for an `image` node, rendered inside the focusable
 * `BlockNodeRow` shell (which owns focus and keyboard navigation). Bytes load
 * via the `lin-asset://` protocol. A hover toolbar offers a caption (the node's
 * `description` field), fullscreen preview, and "open original" (the OS default
 * app — an Electron capability); double-clicking the image also opens the
 * lightbox. The caption renders below the image as a `NodeDescription` and is
 * added on demand, not always shown.
 */
export function ImageRow(props: ImageRowProps) {
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const src = `lin-asset://${props.assetId}`;
  const hasIntrinsicSize = typeof props.width === 'number' && typeof props.height === 'number';

  useEffect(() => {
    if (!lightboxOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightboxOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen]);

  if (failed) {
    return (
      <div className="outliner-image outliner-image--missing" contentEditable={false}>
        Image unavailable
      </div>
    );
  }

  return (
    <div className="outliner-image" contentEditable={false}>
      <div className="outliner-image-frame">
        <img
          className="outliner-image-el"
          src={src}
          alt={props.alt ?? ''}
          loading="lazy"
          draggable={false}
          {...(hasIntrinsicSize ? { width: props.width, height: props.height } : {})}
          onError={() => setFailed(true)}
          onDoubleClick={() => setLightboxOpen(true)}
        />
        <div
          className="outliner-image-toolbar"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {props.onAddCaption && (
            <ButtonControl
              aria-label={props.hasCaption ? 'Edit caption' : 'Add caption'}
              className="outliner-image-tool"
              onClick={() => props.onAddCaption?.()}
            >
              <DescriptionIcon size={ICON_SIZE.toolbar} />
            </ButtonControl>
          )}
          <ButtonControl
            aria-label="Expand image"
            className="outliner-image-tool"
            onClick={() => setLightboxOpen(true)}
          >
            <ExpandIcon size={ICON_SIZE.toolbar} />
          </ButtonControl>
          <ButtonControl
            aria-label="Open original"
            className="outliner-image-tool"
            onClick={() => void api.openAsset(props.assetId)}
          >
            <OpenIcon size={ICON_SIZE.toolbar} />
          </ButtonControl>
        </div>
      </div>
      {lightboxOpen && createPortal(
        <div
          className="outliner-image-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightboxOpen(false)}
        >
          <img className="outliner-image-lightbox-img" src={src} alt={props.alt ?? ''} />
        </div>,
        document.body,
      )}
    </div>
  );
}
