import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { ExpandIcon, ICON_SIZE, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';

interface ImageRowProps {
  assetId: string;
  alt?: string;
  width?: number;
  height?: number;
}

/**
 * Image element for `image` nodes, rendered above the row's text editor (which
 * serves as the caption). Bytes load via the `lin-asset://` protocol. A hover
 * toolbar offers fullscreen preview and "open original" (the OS default app —
 * an Electron capability); clicking the image also opens the lightbox.
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
          <ButtonControl
            aria-label="Expand image"
            className="outliner-image-tool"
            onClick={() => setLightboxOpen(true)}
          >
            <ExpandIcon size={ICON_SIZE.menu} />
          </ButtonControl>
          <ButtonControl
            aria-label="Open original"
            className="outliner-image-tool"
            onClick={() => void api.openAsset(props.assetId)}
          >
            <OpenIcon size={ICON_SIZE.menu} />
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
