import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { NodeProjection } from '../../api/types';
import type { FocusRequest, FocusTarget } from '../../state/document';
import { focusTargetMatches } from '../focus/focusModel';
import { ImageRow } from './ImageRow';

/**
 * Node types whose body is a non-text block (an image today; attachments,
 * embeds, and media players later). They share one interaction contract:
 * a focusable, caret-less row whose caption is the node's `description`, with
 * arrow / Enter / Backspace navigation. `BlockNodeRow` owns that contract;
 * each type only contributes a presentational body in `renderBlockBody`.
 *
 * Returns false for types it cannot render yet (e.g. an `image` without an
 * `assetId`), so the caller can fall back to the normal text editor.
 */
export function isBlockNodeType(node: Pick<NodeProjection, 'type' | 'assetId'>): boolean {
  switch (node.type) {
    case 'image':
      return Boolean(node.assetId);
    default:
      return false;
  }
}

export interface BlockNodeRowProps {
  node: NodeProjection;
  readOnly?: boolean;
  /** Selection bookkeeping when the block gains focus. */
  onFocus: () => void;
  onArrowUp: () => void;
  onArrowDown: () => void;
  /** Enter: create a sibling row below. */
  onEnter: () => void;
  /** Backspace on the (caret-less) block: remove it. */
  onBackspace: () => void;
  onEscape: () => void;
  /** Shift+Arrow at the block edge extends into row (block) selection. */
  onShiftArrow?: (direction: 'up' | 'down') => void;
  onTab?: (shiftKey: boolean) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  /** Open the caption editor (the node's `description`). */
  onAddCaption?: () => void;
  focusTarget?: FocusTarget;
  focusRequest?: FocusRequest | null;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
}

function renderBlockBody(props: BlockNodeRowProps): ReactNode {
  const { node } = props;
  switch (node.type) {
    case 'image':
      if (!node.assetId) return null;
      return (
        <ImageRow
          assetId={node.assetId}
          alt={node.mediaAlt || node.description || undefined}
          width={node.imageWidth}
          height={node.imageHeight}
          hasCaption={Boolean(node.description)}
          onAddCaption={props.onAddCaption}
        />
      );
    default:
      return null;
  }
}

export function BlockNodeRow(props: BlockNodeRowProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Consume a focus request aimed at this row (e.g. right after the block is
  // created, or returning from the caption). Mirrors CodeBlockRow's handshake.
  useEffect(() => {
    const el = ref.current;
    const request = props.focusRequest;
    const target = props.focusTarget;
    if (!el || !request || !target) return;
    if (!focusTargetMatches(request.target, target)) return;
    el.focus({ preventScroll: true });
    props.onFocusRequestConsumed?.(request);
  }, [props.focusRequest, props.focusTarget, props.onFocusRequestConsumed]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Only handle keys aimed at the block shell itself, not ones bubbling up
    // from a focused toolbar button (caption / expand / open).
    if (event.target !== event.currentTarget) return;
    const p = propsRef.current;
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) p.onRedo?.();
      else p.onUndo?.();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      p.onRedo?.();
      return;
    }

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        if (event.shiftKey) p.onShiftArrow?.('up');
        else p.onArrowUp();
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (event.shiftKey) p.onShiftArrow?.('down');
        else p.onArrowDown();
        return;
      case 'Enter':
        if (event.shiftKey || p.readOnly) return;
        event.preventDefault();
        p.onEnter();
        return;
      case 'Backspace':
        if (p.readOnly) return;
        event.preventDefault();
        p.onBackspace();
        return;
      case 'Escape':
        event.preventDefault();
        p.onEscape();
        return;
      case 'Tab':
        if (p.readOnly) return;
        event.preventDefault();
        p.onTab?.(event.shiftKey);
        return;
      default:
    }
  };

  return (
    <div
      ref={ref}
      className="block-node-row"
      tabIndex={-1}
      role="group"
      onFocus={props.onFocus}
      onKeyDown={handleKeyDown}
    >
      {renderBlockBody(props)}
    </div>
  );
}
