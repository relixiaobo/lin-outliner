import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { buildReferenceCandidates, referenceCandidateLabels, type ReferenceCandidate } from '../interactions/referenceCandidates';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { NodeReferenceMenuIcon } from './NodeReferenceMenuIcon';
import { PopoverEmpty, PopoverListbox, PopoverListItem } from './PopoverList';
import { useT } from '../../i18n/I18nProvider';

type NodeCandidate = Extract<ReferenceCandidate, { type: 'node' }>;

interface TrailingReferencePopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  index: DocumentIndex;
  entryId: NodeId;
  open: boolean;
  query: string;
  onOpenChange: (open: boolean) => void;
  onPick: (targetId: NodeId) => void;
}

// The node-search popover for a `reference` field-value draft. It mirrors
// TrailingOptionsPopover (open on focus/typing, owns Arrow/Enter/Escape via a
// window capture-phase listener so navigation does not depend on the editor's
// keymap), but the candidate pool is the whole document — the same in-memory
// reference search that powers an `@` reference — and picking one appends a
// reference to that node via add_field_reference. A reference value points at an
// EXISTING node, so there is no "create" affordance here (and date shortcuts,
// which would have to materialize a date node, are likewise out — references go
// through the date *field type*, not this picker).
export function TrailingReferencePopover(props: TrailingReferencePopoverProps) {
  const t = useT();
  const tr = t.outliner.field;
  const candidates = buildReferenceCandidates({
    index: props.index,
    currentNodeId: props.entryId,
    query: props.query,
    treeReferenceParentId: props.entryId,
    allowCreate: false,
    labels: referenceCandidateLabels(t),
  }).filter((candidate): candidate is NodeCandidate => (
    candidate.type === 'node' && !candidate.disabledReason
  ));
  const count = candidates.length;

  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef: props.anchorRef,
    disabled: !props.open,
    layoutKey: `${props.query}:${count}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 280,
  });

  // Reset the highlight to the top whenever the query or candidate count shifts
  // the list under the cursor.
  useEffect(() => {
    setActiveIndex(0);
  }, [props.query, count]);

  const stateRef = useRef({ open: props.open, count, candidates, activeIndex });
  stateRef.current = { open: props.open, count, candidates, activeIndex };

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
        setActiveIndex((current) => Math.max(0, current - 1));
        return;
      }
      // Enter. While the popover is open it owns Enter unconditionally — swallow
      // it before it can reach the editor keymap (which would otherwise commit
      // the draft as free text). An empty list is a no-op, not a leak.
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (state.count === 0) return;
      const candidate = state.candidates[state.activeIndex];
      if (candidate) props.onPick(candidate.id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  if (!props.open) return null;

  return createPortal(
    <PopoverListbox
      ref={menuRef}
      className="node-picker-popover trailing-reference-popover"
      label={tr.referenceSuggestions}
      style={menuStyle}
    >
      {count === 0 && <PopoverEmpty>{tr.noMatches}</PopoverEmpty>}
      {candidates.map((candidate, index) => (
        <PopoverListItem
          key={candidate.id}
          active={index === activeIndex}
          icon={<NodeReferenceMenuIcon index={props.index} node={props.index.byId.get(candidate.id)} />}
          iconClassName="popover-item-icon"
          label={(
            <>
              <span>{candidate.label}</span>
              {candidate.breadcrumb && <span className="popover-item-meta">{candidate.breadcrumb}</span>}
            </>
          )}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => props.onPick(candidate.id)}
        />
      ))}
    </PopoverListbox>,
    document.body,
  );
}
