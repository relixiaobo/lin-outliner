import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export type OverlayPlacement =
  | 'bottom-start'
  | 'bottom-center'
  | 'bottom-end'
  | 'top-start'
  | 'top-center'
  | 'top-end';

interface OverlayAnchorElement {
  getBoundingClientRect: () => DOMRect;
}

export interface OverlayAnchorRect {
  left: number;
  top: number;
  bottom: number;
  right?: number;
  width?: number;
}

interface UseAnchoredOverlayOptions {
  anchorRect?: OverlayAnchorRect | null;
  anchorRef?: RefObject<OverlayAnchorElement | null>;
  disabled?: boolean;
  fallbackStyle?: CSSProperties;
  gap?: number;
  layoutKey?: string;
  margin?: number;
  maxHeight?: number;
  placement?: OverlayPlacement;
  width?: number;
}

const HIDDEN_STYLE: CSSProperties = {
  position: 'fixed',
  top: -9999,
  left: -9999,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readAnchorRect(options: UseAnchoredOverlayOptions): OverlayAnchorRect | null {
  if (options.anchorRect) return options.anchorRect;
  const rect = options.anchorRef?.current?.getBoundingClientRect();
  return rect
    ? {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
    }
    : null;
}

export function overlayAnchorFromPoint(x: number, y: number): OverlayAnchorRect {
  return {
    bottom: y,
    left: x,
    right: x,
    top: y,
    width: 0,
  };
}

export function useAnchoredOverlay(
  overlayRef: RefObject<HTMLElement | null>,
  options: UseAnchoredOverlayOptions,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>(HIDDEN_STYLE);

  useLayoutEffect(() => {
    if (options.disabled) return undefined;

    const update = () => {
      const anchor = readAnchorRect(options);
      if (!anchor) {
        setStyle(HIDDEN_STYLE);
        return;
      }

      const gap = options.gap ?? 6;
      const margin = options.margin ?? 8;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
      const maxWidth = Math.max(1, viewportWidth - margin * 2);
      const width = Math.min(options.width ?? Math.max(anchor.width ?? 0, 220), maxWidth);
      const maxHeight = Math.min(
        options.maxHeight ?? 440,
        Math.max(120, viewportHeight - margin * 2),
      );
      const contentHeight = overlayRef.current?.scrollHeight ?? overlayRef.current?.offsetHeight ?? maxHeight;
      const height = Math.min(contentHeight, maxHeight);
      const anchorRight = anchor.right ?? anchor.left + (anchor.width ?? 0);
      const placement = options.placement ?? 'bottom-start';
      const alignEnd = placement.endsWith('-end');
      const alignCenter = placement.endsWith('-center');
      const preferredTop = options.placement?.startsWith('top') ?? false;
      const leftTarget = alignEnd
        ? anchorRight - width
        : alignCenter
          ? anchor.left + ((anchorRight - anchor.left) / 2) - (width / 2)
          : anchor.left;
      const left = clamp(leftTarget, margin, viewportWidth - width - margin);
      const spaceBelow = viewportHeight - anchor.bottom - gap - margin;
      const spaceAbove = anchor.top - gap - margin;
      const shouldPlaceAbove = preferredTop
        ? spaceAbove >= height || spaceAbove >= spaceBelow
        : spaceBelow < height && spaceAbove > spaceBelow;
      const topTarget = shouldPlaceAbove ? anchor.top - gap - height : anchor.bottom + gap;
      const top = clamp(topTarget, margin, viewportHeight - height - margin);

      setStyle({
        position: 'fixed',
        left,
        top,
        width,
        maxHeight,
      });
    };

    const requestFrame = window.requestAnimationFrame ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
    const cancelFrame = window.cancelAnimationFrame ?? ((handle: number) => window.clearTimeout(handle));

    update();
    const frame = requestFrame(update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelFrame(frame);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [
    options.anchorRect,
    options.anchorRef,
    options.disabled,
    options.gap,
    options.layoutKey,
    options.margin,
    options.maxHeight,
    options.placement,
    options.width,
    overlayRef,
  ]);

  return options.disabled ? options.fallbackStyle : style;
}
