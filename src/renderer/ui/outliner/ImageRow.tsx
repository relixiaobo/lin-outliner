import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { DescriptionIcon, ExpandIcon, ICON_SIZE, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';

interface ImageRowProps {
  /** Resolved URL to load: `asset://<id>` for local, or the remote URL. */
  src: string;
  /** Remote (mediaUrl) vs local (assetId) — changes "open original". */
  isRemote: boolean;
  assetId?: string;
  mediaUrl?: string;
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
 * via the `asset://` protocol. A hover toolbar offers a caption (the node's
 * `description` field), fullscreen preview, and "open original" (the OS default
 * app — an Electron capability); double-clicking the image also opens the
 * lightbox. The caption renders below the image as a `NodeDescription` and is
 * added on demand, not always shown.
 */
export function ImageRow(props: ImageRowProps) {
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const src = props.src;
  const hasIntrinsicSize = typeof props.width === 'number' && typeof props.height === 'number';

  const openOriginal = () => {
    if (props.isRemote) {
      if (props.mediaUrl) void api.openExternalUrl(props.mediaUrl);
    } else if (props.assetId) {
      void api.openAsset(props.assetId);
    }
  };

  // Move focus into the lightbox while open (and restore it on close) so its
  // own Esc handler closes it without the same keydown also reaching the
  // BlockNodeRow shell behind it (which would exit the row to selection).
  useEffect(() => {
    if (!lightboxOpen) return undefined;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    lightboxRef.current?.focus({ preventScroll: true });
    return () => {
      restoreFocusRef.current?.focus({ preventScroll: true });
    };
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
            aria-label={props.isRemote ? 'Open in browser' : 'Open original'}
            className="outliner-image-tool"
            onClick={openOriginal}
          >
            <OpenIcon size={ICON_SIZE.toolbar} />
          </ButtonControl>
        </div>
      </div>
      {lightboxOpen && createPortal(
        <div
          ref={lightboxRef}
          className="outliner-image-lightbox"
          role="dialog"
          aria-modal="true"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setLightboxOpen(false);
            }
          }}
          onClick={() => setLightboxOpen(false)}
        >
          <img className="outliner-image-lightbox-img" src={src} alt={props.alt ?? ''} />
        </div>,
        document.body,
      )}
    </div>
  );
}
