import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { FocusRequest, FocusTarget } from '../../state/document';
import type { TriggerAnchor } from '../shared';
import { focusTargetMatches } from '../focus/focusModel';
import { isCompositionLive } from '../editor/compositionRelay';

export interface FileNodeKeyboardAnchorProps {
  /** Accessible label announced when the row gains focus (the file's name). */
  label?: string;
  /** Selection bookkeeping when the row gains focus. */
  onFocus: () => void;
  tagTriggerQuery?: string | null;
  onOpenTagTrigger: (anchor?: TriggerAnchor) => void;
  onUpdateTagTriggerQuery: (query: string) => void;
  onCloseTagTrigger: () => void;
  onArrowUp: () => void;
  onArrowDown: () => void;
  /** Enter: create a sibling row below (or a first child when expanded). */
  onEnter: () => void;
  /** Backspace/Delete on the caret-less file row: remove the node. */
  onBackspace: () => void;
  onEscape: () => void;
  /** Shift+Arrow at the row edge drops into row (block) selection. */
  onShiftArrow: () => void;
  onTab: (shiftKey: boolean) => void;
  onSelectAllRows: () => void;
  onUndo: () => void;
  onRedo: () => void;
  focusTarget: FocusTarget;
  focusRequest: FocusRequest | null;
  onFocusRequestConsumed: (request: FocusRequest) => void;
}

/**
 * Image file rows render the image itself as their visible row content, so there
 * is no filename caret surface to own keyboard focus. This visually hidden,
 * focusable anchor restores the block keyboard contract for that row: arrow nav,
 * Enter → sibling, Backspace → remove, Tab → indent, Escape, undo/redo,
 * select-all, and `#` tag trigger.
 */
export function FileNodeKeyboardAnchor(props: FileNodeKeyboardAnchorProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Consume a focus request aimed at this row (e.g. arrow-nav into it, or right
  // after the file node is created). Mirrors the old BlockNodeRow handshake: a
  // live IME composition parks the request and relays it at compositionend.
  useEffect(() => {
    const el = ref.current;
    const request = props.focusRequest;
    const target = props.focusTarget;
    if (!el || !request || !target) return;
    if (!focusTargetMatches(request.target, target)) return;
    if (isCompositionLive()) return;
    el.focus({ preventScroll: true });
    props.onFocusRequestConsumed(request);
  }, [props.focusRequest, props.focusTarget, props.onFocusRequestConsumed]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const p = propsRef.current;
    const mod = event.metaKey || event.ctrlKey;

    if (p.tagTriggerQuery !== undefined && p.tagTriggerQuery !== null) {
      if (event.key === 'Backspace') {
        event.preventDefault();
        if (p.tagTriggerQuery.length === 0) {
          p.onCloseTagTrigger();
        } else {
          p.onUpdateTagTriggerQuery(p.tagTriggerQuery.slice(0, -1));
        }
        return;
      }
      if (!mod && !event.altKey && event.key.length === 1) {
        event.preventDefault();
        if (/\s/.test(event.key)) {
          p.onCloseTagTrigger();
        } else {
          p.onUpdateTagTriggerQuery(`${p.tagTriggerQuery}${event.key}`);
        }
        return;
      }
    }

    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      p.onSelectAllRows();
      return;
    }
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) p.onRedo();
      else p.onUndo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      p.onRedo();
      return;
    }

    if (!mod && !event.altKey && event.key === '#') {
      event.preventDefault();
      const rect = ref.current?.getBoundingClientRect();
      p.onOpenTagTrigger(rect
        ? { left: rect.left, top: rect.top, bottom: rect.bottom }
        : undefined);
      return;
    }

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        if (event.shiftKey) p.onShiftArrow();
        else p.onArrowUp();
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (event.shiftKey) p.onShiftArrow();
        else p.onArrowDown();
        return;
      case 'Enter':
        if (event.shiftKey) return;
        event.preventDefault();
        p.onEnter();
        return;
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        p.onBackspace();
        return;
      case 'Escape':
        event.preventDefault();
        p.onEscape();
        return;
      case 'Tab':
        event.preventDefault();
        p.onTab(event.shiftKey);
        return;
      default:
    }
  };

  return (
    <div
      ref={ref}
      className="file-node-keyboard-anchor"
      tabIndex={-1}
      aria-label={props.label || undefined}
      onFocus={props.onFocus}
      onKeyDown={handleKeyDown}
    />
  );
}
