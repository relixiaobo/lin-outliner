import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import type { FieldReuseCandidate } from '../interactions/fieldReuseCandidates';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { PopoverBulletIcon, PopoverEmpty, PopoverListbox, PopoverListItem } from './PopoverList';
import { useT } from '../../i18n/I18nProvider';

interface FieldNameReusePopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  candidates: FieldReuseCandidate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (candidate: FieldReuseCandidate) => void;
}

// The field-name reuse popover: while a field is being named, it lists existing
// fields (and built-in system fields) whose names match the typed text, so the
// user can reuse one definition instead of forking a new one. Modeled on
// TrailingOptionsPopover, with one deliberate difference: the highlight starts at
// -1 (nothing selected). Enter only reuses a candidate after the user explicitly
// Arrows into the list; otherwise Enter falls through to the name editor and
// commits the user's own (new) field. This keeps "type a fresh name + Enter"
// creating a new field, never silently relinking to a lookalike.
export function FieldNameReusePopover(props: FieldNameReusePopoverProps) {
  const tf = useT().outliner.field;
  const count = props.candidates.length;
  const [activeIndex, setActiveIndex] = useState(-1);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef: props.anchorRef,
    disabled: !props.open,
    layoutKey: `${count}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 280,
  });

  // Reset the highlight whenever the candidate set changes under the cursor.
  useEffect(() => {
    setActiveIndex(-1);
  }, [count]);

  const stateRef = useRef({ open: props.open, count, activeIndex, candidates: props.candidates });
  stateRef.current = { open: props.open, count, activeIndex, candidates: props.candidates };

  useEffect(() => {
    if (!props.open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isImeComposingEvent(event)) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      const state = stateRef.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        props.onOpenChange(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => Math.min(state.count - 1, current + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => Math.max(-1, current - 1));
        return;
      }
      // Enter. Only claim it when the user has explicitly highlighted a
      // candidate; with nothing selected, let it reach the name editor so the
      // typed name commits as a new field.
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      if (state.activeIndex < 0) return;
      const candidate = state.candidates[state.activeIndex];
      if (!candidate) return;
      event.preventDefault();
      event.stopPropagation();
      props.onSelect(candidate);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  if (!props.open) return null;

  return createPortal(
    <PopoverListbox
      ref={menuRef}
      className="node-picker-popover field-name-reuse-popover"
      label={tf.reuseFieldLabel}
      style={menuStyle}
    >
      {count === 0 && <PopoverEmpty>{tf.noMatchingFields}</PopoverEmpty>}
      {props.candidates.map((candidate, index) => {
        // Candidates arrive grouped (user fields, then system fields); a header
        // marks each section's first row. Headers are non-interactive, so they
        // don't shift the keyboard index.
        const showHeader = index === 0 || candidate.section !== props.candidates[index - 1]?.section;
        return (
          <div key={candidate.id} role="presentation">
            {showHeader && <div className="popover-section-header">{candidate.section}</div>}
            <PopoverListItem
              active={index === activeIndex}
              icon={<PopoverBulletIcon />}
              label={candidate.label}
              // Keep focus on the name input so its blur-commit does not fire and
              // tear the popover down before this click lands.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => props.onSelect(candidate)}
            />
          </div>
        );
      })}
    </PopoverListbox>,
    document.body,
  );
}
