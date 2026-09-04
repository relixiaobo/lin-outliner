import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { resolveFlyoutPlacement, type FlyoutSide } from './flyoutPlacement';

function hiddenFlyoutStyle(width: number): CSSProperties {
  return { position: 'fixed', left: -9999, top: -9999, width };
}

/**
 * Positions a side flyout without moving it when content grows after opening.
 * `placementKey` identifies the anchored surface; `contentKey` only re-applies
 * its ceiling so expanding content scrolls in place.
 */
export function useFlyoutOverlay(
  ref: RefObject<HTMLDivElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
  placementKey: string,
  contentKey: string,
  preferredSide: FlyoutSide = 'left',
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>(() => hiddenFlyoutStyle(width));
  const placementHeightRef = useRef<{ readonly height: number; readonly key: string } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      placementHeightRef.current = null;
      setStyle((current) => (current.top === -9999 ? current : hiddenFlyoutStyle(width)));
      return undefined;
    }

    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const element = ref.current;
      if (!anchor || !element) return;
      const placed = placementHeightRef.current;
      const placementHeight = placed?.key === placementKey
        ? placed.height
        : element.scrollHeight;
      placementHeightRef.current = { height: placementHeight, key: placementKey };
      const placement = resolveFlyoutPlacement({
        anchorLeft: anchor.left,
        anchorRight: anchor.right,
        anchorTop: anchor.top,
        gap: 4,
        margin: 8,
        placementHeight,
        preferredSide,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        width,
      });
      setStyle((current) => (
        current.left === placement.left
          && current.top === placement.top
          && current.maxHeight === placement.maxHeight
          && current.width === width
          ? current
          : {
            position: 'fixed',
            left: placement.left,
            top: placement.top,
            width,
            maxHeight: placement.maxHeight,
          }
      ));
    };

    update();
    const frame = window.requestAnimationFrame(update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorRef, contentKey, open, placementKey, preferredSide, ref, width]);

  return style;
}
