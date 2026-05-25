import { useState } from 'react';

interface ImageRowProps {
  assetId: string;
  alt?: string;
  width?: number;
  height?: number;
}

/**
 * Presentational image element for `image` nodes. It renders above the row's
 * normal text editor, so keyboard navigation, caption text, and row commands
 * keep flowing through the editor unchanged. Bytes load via the
 * `lin-asset://` protocol served by the main process.
 */
export function ImageRow(props: ImageRowProps) {
  const [failed, setFailed] = useState(false);
  const hasIntrinsicSize = typeof props.width === 'number' && typeof props.height === 'number';

  if (failed) {
    return (
      <div className="outliner-image outliner-image--missing" contentEditable={false}>
        Image unavailable
      </div>
    );
  }

  return (
    <div className="outliner-image" contentEditable={false}>
      <img
        className="outliner-image-el"
        src={`lin-asset://${props.assetId}`}
        alt={props.alt ?? ''}
        loading="lazy"
        draggable={false}
        {...(hasIntrinsicSize ? { width: props.width, height: props.height } : {})}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
