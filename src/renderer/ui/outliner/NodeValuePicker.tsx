import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useT } from '../../i18n/I18nProvider';
import {
  PopoverBulletIcon,
  PopoverEmpty,
  PopoverListbox,
  PopoverListItem,
} from './PopoverList';
import { RowMarker } from './RowMarker';

export type NodeValuePickerMarker = 'bullet' | 'reference' | 'hash';

export interface NodeValuePickerOption {
  id: string;
  label: string;
  color?: string;
  icon?: ReactNode;
  marker?: NodeValuePickerMarker;
}

interface NodeValuePickerProps {
  allowClear?: boolean;
  allowCreate?: boolean;
  ariaLabel: string;
  clearLabel?: string;
  createLabel?: (label: string) => string;
  emptyLabel?: string;
  maxHeight?: number;
  onClear?: () => Promise<unknown> | unknown;
  onCreate?: (label: string) => Promise<unknown> | unknown;
  onSelect: (optionId: string) => Promise<unknown> | unknown;
  options: NodeValuePickerOption[];
  placeholder: string;
  selectedFallbackLabel?: string;
  selectedId?: string;
  selectedMarkerWhenPresent?: NodeValuePickerMarker;
  width?: number;
}

type PickerAction =
  | { type: 'option'; option: NodeValuePickerOption }
  | { type: 'create'; label: string }
  | { type: 'clear' };

export function NodeValuePicker({
  allowClear = false,
  allowCreate = false,
  ariaLabel,
  clearLabel,
  createLabel,
  emptyLabel,
  maxHeight = 260,
  onClear,
  onCreate,
  onSelect,
  options,
  placeholder,
  selectedFallbackLabel,
  selectedId,
  selectedMarkerWhenPresent = 'bullet',
  width = 280,
}: NodeValuePickerProps) {
  const tp = useT().outliner.field.valuePicker;
  const resolvedClearLabel = clearLabel ?? tp.clearSelection;
  const resolvedCreateLabel = createLabel ?? ((label: string) => tp.create({ label }));
  const resolvedEmptyLabel = emptyLabel ?? tp.noOptions;
  const optionsAriaLabel = tp.optionsListLabel({ name: ariaLabel });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = selectedId ? options.find((option) => option.id === selectedId) : undefined;
  const selectedLabel = selectedOption?.label ?? selectedFallbackLabel ?? '';
  const canClearSelection = Boolean(allowClear && onClear);
  const normalizedQuery = query.trim();
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery || (selectedLabel && query === selectedLabel)) return options;
    const lowered = normalizedQuery.toLowerCase();
    return options.filter((option) => option.label.toLowerCase().includes(lowered));
  }, [normalizedQuery, options, query, selectedLabel]);
  const canCreate = Boolean(
    allowCreate
    && onCreate
    && normalizedQuery
    && !options.some((option) => option.label.toLowerCase() === normalizedQuery.toLowerCase()),
  );
  const actions = useMemo<PickerAction[]>(() => {
    const next: PickerAction[] = filteredOptions.map((option) => ({ type: 'option', option }));
    if (canCreate) next.push({ type: 'create', label: normalizedQuery });
    if (canClearSelection) next.push({ type: 'clear' });
    return next;
  }, [canClearSelection, canCreate, filteredOptions, normalizedQuery]);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open,
    layoutKey: `${query}:${actions.length}:${selectedId ?? selectedFallbackLabel ?? ''}`,
    maxHeight,
    placement: 'bottom-start',
    width,
  });

  useEffect(() => {
    setActiveIndex(0);
  }, [query, actions.length]);

  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (selectedLabel && query === selectedLabel) input.select();
    });
  }, [open, query, selectedLabel]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  };

  const openPicker = () => {
    setQuery(selectedLabel);
    setOpen(true);
  };

  const runAction = (action: PickerAction | undefined) => {
    if (!action) return;
    close();
    if (action.type === 'option') {
      void Promise.resolve(onSelect(action.option.id));
      return;
    }
    if (action.type === 'create' && onCreate) {
      void Promise.resolve(onCreate(action.label));
      return;
    }
    if (onClear) void Promise.resolve(onClear());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (actions.length === 0) return;
      setActiveIndex((current) => Math.min(actions.length - 1, current + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (actions.length === 0) return;
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runAction(actions[activeIndex]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (
      event.key === 'Backspace'
      && canClearSelection
      && inputRef.current
      && inputRef.current.selectionStart === 0
      && inputRef.current.selectionEnd === inputRef.current.value.length
    ) {
      event.preventDefault();
      setQuery('');
      void Promise.resolve(onClear?.());
    }
  };

  const displayLabel = selectedLabel || placeholder;
  const selectedMarker = selectedOption?.marker ?? (selectedLabel ? selectedMarkerWhenPresent : 'bullet');

  return (
    <div
      ref={anchorRef}
      className={`field-option-picker ${open ? 'open' : ''}`}
    >
      <div
        role="button"
        tabIndex={0}
        className={`field-option-picker-row ${selectedLabel ? '' : 'empty'}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (open) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          openPicker();
        }}
      >
        <span className="field-option-picker-leading">
          <NodeValueMarker
            color={selectedOption?.color}
            icon={selectedOption?.icon}
            marker={selectedMarker}
          />
        </span>
        {open ? (
          <input
            ref={inputRef}
            className="field-option-picker-input"
            value={query}
            placeholder={displayLabel}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={onKeyDown}
          />
        ) : (
          <span className="field-option-picker-label">{displayLabel}</span>
        )}
      </div>
      {open && createPortal(
        <PopoverListbox
          ref={menuRef}
          className="node-picker-popover field-option-picker-popover"
          label={optionsAriaLabel}
          style={menuStyle}
        >
          {actions.length === 0 && <PopoverEmpty>{resolvedEmptyLabel}</PopoverEmpty>}
          {actions.map((action, index) => (
            <PopoverListItem
              key={actionKey(action)}
              active={index === activeIndex}
              icon={actionIcon(action)}
              label={actionLabel(action, { clearLabel: resolvedClearLabel, createLabel: resolvedCreateLabel })}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runAction(action)}
            />
          ))}
        </PopoverListbox>,
        document.body,
      )}
    </div>
  );
}

function NodeValueMarker({
  color,
  icon,
  marker,
}: {
  color?: string;
  icon?: ReactNode;
  marker: NodeValuePickerMarker;
}) {
  if (icon) return <span className="field-option-picker-icon">{icon}</span>;
  if (marker === 'hash') {
    return (
      <span className="field-option-picker-hash" style={color ? { color } : undefined} aria-hidden="true">
        #
      </span>
    );
  }
  return (
    <RowMarker
      hasChildren={false}
      expanded={false}
      variant={marker === 'reference' ? 'reference' : 'content'}
    />
  );
}

function PopoverMarker({ option }: { option: NodeValuePickerOption }) {
  if (option.icon) return <span className="popover-item-icon">{option.icon}</span>;
  if (option.marker === 'hash') {
    return (
      <span
        className="popover-item-icon field-option-picker-popover-hash"
        style={option.color ? { color: option.color } : undefined}
        aria-hidden="true"
      >
        #
      </span>
    );
  }
  if (option.marker === 'reference') {
    return (
      <span className="popover-item-icon">
        <RowMarker hasChildren={false} expanded={false} variant="reference" />
      </span>
    );
  }
  return <PopoverBulletIcon />;
}

function actionIcon(action: PickerAction) {
  if (action.type === 'option') return <PopoverMarker option={action.option} />;
  return <PopoverBulletIcon />;
}

function actionKey(action: PickerAction): string {
  if (action.type === 'option') return `option:${action.option.id}`;
  if (action.type === 'create') return `create:${action.label}`;
  return 'clear';
}

function actionLabel(
  action: PickerAction,
  labels: {
    clearLabel: string;
    createLabel: (label: string) => string;
  },
) {
  if (action.type === 'option') return action.option.label;
  if (action.type === 'create') return labels.createLabel(action.label);
  return labels.clearLabel;
}
