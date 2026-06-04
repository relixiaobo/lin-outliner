import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { NodeId, NodeProjection } from '../../api/types';
import { projectFieldConfig } from '../../../core/configProjection';
import { filterFieldOptions, resolveFieldOptions } from '../interactions/fieldOptions';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import {
  PopoverBulletIcon,
  PopoverEmpty,
  PopoverListbox,
  PopoverListItem,
} from './PopoverList';
import { useT } from '../../i18n/I18nProvider';

interface TrailingOptionsPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  optionField: NodeProjection;
  byId: Map<NodeId, NodeProjection>;
  autocollect: boolean;
  open: boolean;
  query: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (optionId: NodeId) => void;
  onCreate: (name: string) => void;
}

// The options popover for an optionPicker field value, ported out of the legacy
// TrailingInput. It opens on focus, filters by the typed free-text query, and
// owns Arrow/Enter/Escape via a window capture-phase listener (mirroring the
// trigger popover) so navigation does not depend on the editor's keymap. A
// `Create "x"` affordance appears for a novel query on an `options` field.
export function TrailingOptionsPopover(props: TrailingOptionsPopoverProps) {
  const tf = useT().outliner.field;
  const config = projectFieldConfig(props.byId, props.optionField);
  const fieldType = config?.fieldType;
  const allOptions = resolveFieldOptions(props.optionField, props.byId);
  const filteredOptions = filterFieldOptions(allOptions, props.query);
  // Options fields always accept free-typed values; auto-collect only governs
  // whether the value joins the reusable option pool (decided by onCreate).
  const trimmedQuery = props.query.trim();
  const canCreateOption = fieldType === 'options'
    && Boolean(trimmedQuery)
    && !allOptions.some((option) => option.label.toLowerCase() === trimmedQuery.toLowerCase());
  const optionCount = filteredOptions.length + (canCreateOption ? 1 : 0);

  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef: props.anchorRef,
    disabled: !props.open,
    layoutKey: `${props.query}:${optionCount}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 280,
  });

  // Reset the highlight to the top whenever the query or option count shifts the
  // list under the cursor.
  useEffect(() => {
    setActiveIndex(0);
  }, [props.query, optionCount]);

  const stateRef = useRef({
    open: props.open,
    optionCount,
    filteredOptions,
    canCreateOption,
    trimmedQuery,
    activeIndex,
  });
  stateRef.current = {
    open: props.open,
    optionCount,
    filteredOptions,
    canCreateOption,
    trimmedQuery,
    activeIndex,
  };

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
        setActiveIndex((current) => Math.min(state.optionCount - 1, current + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((current) => Math.max(0, current - 1));
        return;
      }
      // Enter. While the popover is open it owns Enter unconditionally — swallow
      // it before it can reach the editor keymap (which would otherwise fire
      // onEnter -> the draft's discrete-confirm commit) even when there is
      // nothing to pick. An empty list is a no-op, not a leak.
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (state.optionCount === 0) return;
      const option = state.filteredOptions[state.activeIndex];
      if (option) props.onSelect(option.id);
      else if (state.canCreateOption) props.onCreate(state.trimmedQuery);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  if (!props.open) return null;

  return createPortal(
    <PopoverListbox
      ref={menuRef}
      className="node-picker-popover trailing-options-popover"
      label={tf.fieldOptionsLabel}
      style={menuStyle}
    >
      {optionCount === 0 && <PopoverEmpty>{tf.noOptions}</PopoverEmpty>}
      {filteredOptions.map((option, index) => (
        <PopoverListItem
          key={option.id}
          active={index === activeIndex}
          icon={<PopoverBulletIcon />}
          label={option.label}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => props.onSelect(option.id)}
        />
      ))}
      {canCreateOption && (
        <PopoverListItem
          active={activeIndex === filteredOptions.length}
          icon={<PopoverBulletIcon />}
          label={tf.createOption({ label: trimmedQuery })}
          onMouseEnter={() => setActiveIndex(filteredOptions.length)}
          onClick={() => props.onCreate(trimmedQuery)}
        />
      )}
    </PopoverListbox>,
    document.body,
  );
}
