import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { NodeProjection } from '../../api/types';
import type { FocusRequest, FocusTarget } from '../../state/document';
import { assetUrl } from '../../../core/assets';
import { focusTargetMatches } from '../focus/focusModel';
import { isCompositionLive } from '../editor/compositionRelay';
import { AttachmentRow } from './AttachmentRow';
import { ImageRow } from './ImageRow';

/**
 * Resolve a media node's source. It is exactly one of a local `assetId` (served
 * via `asset://`) or a remote `mediaUrl` (loaded directly). Returns the URL to
 * load plus whether it is remote (which changes "open original" and intrinsic
 * sizing). `null` means the node has no usable source yet.
 */
export function mediaSource(
  node: { assetId?: string; mediaUrl?: string },
): { src: string; isRemote: boolean } | null {
  if (node.assetId) return { src: assetUrl(node.assetId), isRemote: false };
  if (node.mediaUrl) return { src: node.mediaUrl, isRemote: true };
  return null;
}

/**
 * Node types whose body is a non-text block (images and attachments today;
 * embeds later). They share one interaction contract:
 * a focusable, caret-less row whose caption is the node's `description`, with
 * arrow / Enter / Backspace navigation. `BlockNodeRow` owns that contract;
 * each type only contributes a presentational body in `renderBlockBody`.
 *
 * Returns false for types it cannot render yet (e.g. an `image` without an
 * `assetId`), so the caller can fall back to the normal text editor.
 */
export function isBlockNodeType(node: { type?: NodeProjection['type']; assetId?: string; mediaUrl?: string }): boolean {
  switch (node.type) {
    case 'image':
      return Boolean(node.assetId || node.mediaUrl);
    case 'attachment':
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
    case 'image': {
      const source = mediaSource(node);
      if (!source) return null;
      return (
        <ImageRow
          src={source.src}
          isRemote={source.isRemote}
          assetId={node.assetId}
          mediaUrl={node.mediaUrl}
          alt={node.mediaAlt || node.description || undefined}
          width={node.imageWidth}
          height={node.imageHeight}
          hasCaption={Boolean(node.description)}
          onAddCaption={props.onAddCaption}
        />
      );
    }
    case 'attachment':
      return <AttachmentRow node={node} />;
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
    // A live IME composition parks the request (issue #176); the composing
    // editor relays it at compositionend.
    if (isCompositionLive()) return;
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
