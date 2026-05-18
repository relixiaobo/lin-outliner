import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { filterFieldOptions, resolveFieldOptions, resolveSelectedOptionId } from '../interactions/fieldOptions';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { TextInputControl } from '../primitives/TextInputControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import type { CommandRunner } from '../shared';
import { FieldValueRow } from './FieldValueRow';
import { NodeBulletDot } from './NodeBulletDot';
import {
  PopoverBulletIcon,
  PopoverEmpty,
  PopoverListbox,
  PopoverListItem,
} from './PopoverList';

interface OptionsPickerProps {
  entryId: NodeId;
  field?: NodeProjection;
  index: DocumentIndex;
  run: CommandRunner;
  onFocus?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  setFocusElement?: (element: HTMLElement | null) => void;
  completed?: boolean;
}

export function OptionsPicker(props: OptionsPickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const valueNodeId = props.index.byId.get(props.entryId)?.children[0];
  const valueNode = valueNodeId ? props.index.byId.get(valueNodeId) : undefined;
  const options = useMemo(
    () => resolveFieldOptions(props.field, props.index.byId),
    [props.field, props.index.byId],
  );
  const selectedId = resolveSelectedOptionId(valueNode, options);
  const selectedOption = options.find((option) => option.id === selectedId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => filterFieldOptions(options, query), [options, query]);
  const canCreate = Boolean(query.trim())
    && props.field?.autocollectOptions !== false
    && !options.some((option) => option.label.toLowerCase() === query.trim().toLowerCase());
  const itemCount = filtered.length + (canCreate ? 1 : 0);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef: inputRef,
    disabled: !open,
    layoutKey: `${query}:${itemCount}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 280,
  });

  useEffect(() => {
    setActiveIndex(0);
  }, [query, itemCount]);

  const selectOption = (optionId: NodeId) => {
    setOpen(false);
    setQuery('');
    void props.run(() => api.selectFieldOption(props.entryId, optionId));
  };

  const createOption = () => {
    const name = query.trim();
    if (!props.field || !name) return;
    setOpen(false);
    setQuery('');
    void props.run(async () => {
      const created = await api.registerCollectedOption(props.field!.id, name);
      const optionId = created.focus?.nodeId;
      if (!optionId) return created;
      return api.selectFieldOption(props.entryId, optionId);
    });
  };

  const confirmActive = () => {
    const option = filtered[activeIndex];
    if (option) {
      selectOption(option.id);
      return;
    }
    if (canCreate) createOption();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposingEvent(event)) return;
    if (open && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowDown') {
        setActiveIndex((current) => Math.min(current + 1, Math.max(0, itemCount - 1)));
        return;
      }
      if (event.key === 'ArrowUp') {
        setActiveIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Escape') {
        setOpen(false);
        setQuery('');
        return;
      }
      confirmActive();
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'Enter') && !open) {
      event.preventDefault();
      setOpen(true);
      return;
    }
    props.onKeyDown?.(event);
  };

  return (
    <FieldValueRow dimmed={!selectedOption && !query} completed={props.completed}>
      <div className="node-picker">
        <div className="node-picker-input-wrap">
          {selectedOption && !open && (
            <span className="node-picker-ref-bullet">
              <NodeBulletDot />
            </span>
          )}
          <TextInputControl
            ref={(element) => {
              inputRef.current = element;
              props.setFocusElement?.(element);
            }}
            className="field-value-input node-picker-input"
            label={`${props.field?.content.text || 'Field'} option value`}
            value={open ? query : selectedOption?.label ?? ''}
            placeholder="Select option"
            spellCheck={false}
            onFocus={() => {
              props.onFocus?.();
              setOpen(true);
            }}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setOpen(true);
            }}
            onBlur={() => {
              window.setTimeout(() => {
                if (!document.activeElement?.closest('.node-picker-popover')) {
                  setOpen(false);
                  setQuery('');
                }
              }, 0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        {open && createPortal(
          <PopoverListbox
            ref={menuRef}
            className="node-picker-popover"
            label="Field options"
            style={menuStyle}
          >
            {itemCount === 0 && <PopoverEmpty>No options</PopoverEmpty>}
            {filtered.map((option, index) => (
              <PopoverListItem
                key={option.id}
                active={index === activeIndex}
                icon={<PopoverBulletIcon />}
                label={option.label}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option.id)}
              />
            ))}
            {canCreate && (
              <PopoverListItem
                active={activeIndex === filtered.length}
                icon={<PopoverBulletIcon />}
                label={`Create "${query.trim()}"`}
                onMouseEnter={() => setActiveIndex(filtered.length)}
                onClick={createOption}
              />
            )}
          </PopoverListbox>,
          document.body,
        )}
      </div>
    </FieldValueRow>
  );
}
