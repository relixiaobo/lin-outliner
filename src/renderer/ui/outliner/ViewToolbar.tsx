import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { FilterOperator, NodeProjection, SortDirection, ViewMode } from '../../api/types';
import type { DocumentIndex, ToolbarDropdownRequest, ToolbarDropdownSection } from '../../state/document';
import {
  AddIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FieldIcon,
  FilterIcon,
  GroupIcon,
  ICON_SIZE,
  SortAscIcon,
  SortDescIcon,
  TableIcon,
} from '../icons';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { ButtonControl } from '../primitives/ButtonControl';
import { CheckboxMark } from '../primitives/CheckboxMark';
import { SelectControl } from '../primitives/SelectControl';
import { TextInputControl } from '../primitives/TextInputControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import type { CommandRunner } from '../shared';
import {
  collectViewFieldChoices,
  NAME_FIELD,
  REF_COUNT_FIELD,
  type ViewConfig,
} from './row-model';

interface ViewToolbarProps {
  node: NodeProjection;
  view: ViewConfig;
  index: DocumentIndex;
  run: CommandRunner;
  dropdownRequest: ToolbarDropdownRequest | null;
  onDropdownRequestConsumed: (request: ToolbarDropdownRequest) => void;
}

type OpenSection = ToolbarDropdownSection | null;
type FieldChoice = { id: string; label: string; section: 'System fields' | 'Fields' };

const VIEW_MODES: Array<{ id: ViewMode; label: string }> = [
  { id: 'list', label: 'List' },
  { id: 'table', label: 'Table' },
  { id: 'cards', label: 'Cards' },
  { id: 'calendar', label: 'Calendar' },
];

const FILTER_OPERATORS: Array<{ id: FilterOperator; label: string }> = [
  { id: 'contains', label: 'Contains' },
  { id: 'not_contains', label: 'Does not contain' },
  { id: 'is', label: 'Is' },
  { id: 'is_not', label: 'Is not' },
  { id: 'is_empty', label: 'Is empty' },
  { id: 'is_not_empty', label: 'Is not empty' },
  { id: 'gt', label: 'Greater than' },
  { id: 'lt', label: 'Less than' },
  { id: 'after', label: 'After' },
  { id: 'before', label: 'Before' },
];

// Fields that never make sense to group by: the row text itself and a derived count.
const GROUP_FIELD_DENYLIST = new Set([NAME_FIELD, REF_COUNT_FIELD]);

// Operators that match on presence alone, so the value input is hidden for them.
const VALUELESS_OPERATORS = new Set<FilterOperator>(['is_empty', 'is_not_empty']);

const SECTION_TITLES: Record<ToolbarDropdownSection, string> = {
  view: 'View as',
  display: 'Display',
  group: 'Group by',
  sort: 'Sort by',
  filter: 'Filter by',
};

// Field pickers and option lists stay compact; the rule editors (sort/filter)
// need room for the field/operator/value controls.
const SECTION_WIDTHS: Record<ToolbarDropdownSection, number> = {
  view: 240,
  display: 264,
  group: 264,
  sort: 520,
  filter: 560,
};

function normalizeValues(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function bySection(choices: FieldChoice[]): Array<{ section: FieldChoice['section']; items: FieldChoice[] }> {
  const order: FieldChoice['section'][] = ['System fields', 'Fields'];
  return order
    .map((section) => ({ section, items: choices.filter((choice) => choice.section === section) }))
    .filter((group) => group.items.length > 0);
}

export function ViewToolbar({
  node,
  view,
  index,
  run,
  dropdownRequest,
  onDropdownRequestConsumed,
}: ViewToolbarProps) {
  const [open, setOpen] = useState<OpenSection>(null);
  const choices = useMemo(() => collectViewFieldChoices(node, index.byId), [node, index.byId]);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLButtonElement>(null);
  const displayRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLButtonElement>(null);
  const sortRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const buttonRefs: Record<ToolbarDropdownSection, RefObject<HTMLButtonElement | null>> = {
    view: viewRef,
    display: displayRef,
    group: groupRef,
    sort: sortRef,
    filter: filterRef,
  };

  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRef: open ? buttonRefs[open] : undefined,
    disabled: !open,
    placement: 'bottom-start',
    width: open ? SECTION_WIDTHS[open] : undefined,
    layoutKey: `${open ?? ''}:${view.sortRules.length}:${view.filterRules.length}:${view.displayFields.length}`,
  });

  useEffect(() => {
    if (!dropdownRequest || dropdownRequest.nodeId !== node.id) return;
    setOpen(dropdownRequest.section);
    onDropdownRequestConsumed(dropdownRequest);
  }, [dropdownRequest, node.id, onDropdownRequestConsumed]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (toolbarRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const toggle = (section: ToolbarDropdownSection) => {
    setOpen((current) => (current === section ? null : section));
  };

  const visibleDisplayCount = view.displayFields.filter((field) => field.visible).length;

  return (
    <div className="view-toolbar" aria-label="View toolbar" ref={toolbarRef}>
      <div className="view-toolbar-button-row">
        <ToolbarButton
          ref={viewRef}
          active={view.viewMode !== 'list'}
          label="View as"
          open={open === 'view'}
          onClick={() => toggle('view')}
        >
          <TableIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        <ToolbarButton
          ref={displayRef}
          active={visibleDisplayCount > 0}
          label="Display"
          open={open === 'display'}
          onClick={() => toggle('display')}
        >
          <FieldIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        <ToolbarButton
          ref={groupRef}
          active={view.groupField != null}
          label="Group by"
          open={open === 'group'}
          onClick={() => toggle('group')}
        >
          <GroupIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        <ToolbarButton
          ref={sortRef}
          active={view.sortRules.length > 0}
          badge={view.sortRules.length}
          label="Sort by"
          open={open === 'sort'}
          onClick={() => toggle('sort')}
        >
          {view.sortRules[0]?.direction === 'desc' ? (
            <SortDescIcon size={ICON_SIZE.menu} />
          ) : (
            <SortAscIcon size={ICON_SIZE.menu} />
          )}
        </ToolbarButton>
        <ToolbarButton
          ref={filterRef}
          active={view.filterRules.length > 0}
          badge={view.filterRules.length}
          label="Filter by"
          open={open === 'filter'}
          onClick={() => toggle('filter')}
        >
          <FilterIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
      </div>

      {open && createPortal(
        <div
          ref={menuRef}
          aria-label={SECTION_TITLES[open]}
          className="view-toolbar-popover"
          role="dialog"
          style={menuStyle}
        >
          <div className="view-toolbar-popover-title">{SECTION_TITLES[open]}</div>
          {open === 'view' && (
            <ViewModeSection node={node} run={run} view={view} />
          )}
          {open === 'display' && (
            <DisplaySection choices={choices} node={node} run={run} view={view} />
          )}
          {open === 'group' && (
            <GroupSection choices={choices} node={node} run={run} view={view} />
          )}
          {open === 'sort' && (
            <SortSection choices={choices} node={node} run={run} view={view} />
          )}
          {open === 'filter' && (
            <FilterSection choices={choices} node={node} run={run} view={view} />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

const ToolbarButton = forwardRef<HTMLButtonElement, {
  active: boolean;
  badge?: number;
  label: string;
  open: boolean;
  onClick: () => void;
  children: ReactNode;
}>(function ToolbarButton({ active, badge, label, open, onClick, children }, ref) {
  const classes = [
    'view-toolbar-pill',
    open ? 'is-open' : '',
    active && !open ? 'is-active' : '',
  ].filter(Boolean).join(' ');
  return (
    <ButtonControl
      ref={ref}
      aria-expanded={open}
      aria-label={label}
      className={classes}
      title={label}
      onClick={onClick}
    >
      {children}
      {badge && badge > 0 ? <span className="view-toolbar-pill-count">{badge}</span> : null}
    </ButtonControl>
  );
});

function ViewModeSection({
  node,
  run,
  view,
}: {
  node: NodeProjection;
  run: CommandRunner;
  view: ViewConfig;
}) {
  return (
    <div className="view-toolbar-options">
      {VIEW_MODES.map((mode) => (
        <OptionRow
          key={mode.id}
          label={mode.label}
          selected={view.viewMode === mode.id}
          variant="radio"
          onSelect={() => void run(() => api.setViewMode(node.id, mode.id))}
        />
      ))}
    </div>
  );
}

function DisplaySection({
  choices,
  node,
  run,
  view,
}: {
  choices: FieldChoice[];
  node: NodeProjection;
  run: CommandRunner;
  view: ViewConfig;
}) {
  // Name is the row text itself and is always shown, so it is not a toggle here.
  const displayable = choices.filter((choice) => choice.id !== NAME_FIELD);
  const byField = new Map(view.displayFields.map((field) => [field.field, field]));
  const groups = bySection(displayable);
  return (
    <div className="view-toolbar-options">
      {groups.map((group) => (
        <div className="view-toolbar-option-group" key={group.section}>
          <div className="view-toolbar-option-section">{group.section}</div>
          {group.items.map((choice) => {
            const entry = byField.get(choice.id);
            const checked = Boolean(entry && entry.visible);
            return (
              <OptionRow
                key={choice.id}
                label={choice.label}
                selected={checked}
                variant="checkbox"
                onSelect={() => {
                  if (entry) {
                    void run(() => api.removeDisplayField(entry.id));
                  } else {
                    void run(() => api.addDisplayField(node.id, choice.id));
                  }
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function GroupSection({
  choices,
  node,
  run,
  view,
}: {
  choices: FieldChoice[];
  node: NodeProjection;
  run: CommandRunner;
  view: ViewConfig;
}) {
  const groupable = choices.filter((choice) => !GROUP_FIELD_DENYLIST.has(choice.id));
  const groups = bySection(groupable);
  const current = view.groupField ?? '';
  return (
    <div className="view-toolbar-options">
      <OptionRow
        label="No grouping"
        selected={current === ''}
        variant="radio"
        onSelect={() => void run(() => api.setGroupField(node.id, null))}
      />
      {groups.map((group) => (
        <div className="view-toolbar-option-group" key={group.section}>
          <div className="view-toolbar-option-section">{group.section}</div>
          {group.items.map((choice) => (
            <OptionRow
              key={choice.id}
              label={choice.label}
              selected={current === choice.id}
              variant="radio"
              onSelect={() => void run(() => api.setGroupField(node.id, choice.id))}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SortSection({
  choices,
  node,
  run,
  view,
}: {
  choices: FieldChoice[];
  node: NodeProjection;
  run: CommandRunner;
  view: ViewConfig;
}) {
  return (
    <div className="view-toolbar-rules">
      {view.sortRules.map((rule, index) => (
        <div className="view-toolbar-rule" key={rule.id}>
          <span className="view-toolbar-rule-label">{index === 0 ? 'Sort by' : 'Then by'}</span>
          <SelectControl
            label="Sort field"
            value={rule.field}
            onChange={(event) => {
              void run(() => api.updateSortRule(rule.id, event.currentTarget.value, rule.direction));
            }}
          >
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>{choice.label}</option>
            ))}
          </SelectControl>
          <ButtonControl
            className="view-toolbar-rule-direction"
            title={rule.direction === 'desc' ? 'Descending' : 'Ascending'}
            onClick={() => {
              const next: SortDirection = rule.direction === 'desc' ? 'asc' : 'desc';
              void run(() => api.updateSortRule(rule.id, rule.field, next));
            }}
          >
            {rule.direction === 'desc' ? (
              <SortDescIcon size={ICON_SIZE.menu} />
            ) : (
              <SortAscIcon size={ICON_SIZE.menu} />
            )}
            <span>{rule.direction === 'desc' ? 'Descending' : 'Ascending'}</span>
          </ButtonControl>
          <ButtonControl
            aria-label="Remove sort rule"
            className="view-toolbar-rule-remove"
            title="Remove"
            onClick={() => void run(() => api.removeSortRule(rule.id))}
          >
            <CloseIcon size={ICON_SIZE.menu} />
          </ButtonControl>
        </div>
      ))}
      <div className="view-toolbar-rule-actions">
        <AddFieldSelect
          choices={choices}
          label={view.sortRules.length > 0 ? 'Add sort' : 'Sort field'}
          onSelect={(field) => void run(() => api.addSortRule(node.id, field, 'asc'))}
        />
        {view.sortRules.length > 0 && (
          <ButtonControl
            className="view-toolbar-reset"
            onClick={() => void run(() => api.clearSortRules(node.id))}
          >
            Reset
          </ButtonControl>
        )}
      </div>
    </div>
  );
}

// Progressive field menu (Tana-style): the popover first lists filterable
// fields; picking one drills into an operator/value editor for that field. We
// model one filter rule per field and look the rule up by field, so a freshly
// added rule resolves without threading the new rule id back through the command.
function FilterSection({
  choices,
  node,
  run,
  view,
}: {
  choices: FieldChoice[];
  node: NodeProjection;
  run: CommandRunner;
  view: ViewConfig;
}) {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const ruleByField = useMemo(
    () => new Map(view.filterRules.map((rule) => [rule.field, rule])),
    [view.filterRules],
  );

  if (editingField) {
    const label = choices.find((choice) => choice.id === editingField)?.label ?? 'Field';
    return (
      <FilterRuleEditor
        label={label}
        rule={ruleByField.get(editingField)}
        run={run}
        onBack={() => setEditingField(null)}
      />
    );
  }

  const normalized = query.trim().toLowerCase();
  const matches = normalized
    ? choices.filter((choice) => choice.label.toLowerCase().includes(normalized))
    : choices;

  const openField = (field: string) => {
    if (!ruleByField.has(field)) {
      void run(() => api.addFilterRule(node.id, field, 'contains', [], 'any'));
    }
    setEditingField(field);
  };

  return (
    <div className="view-toolbar-filter">
      <input
        autoFocus
        className="view-toolbar-filter-search"
        placeholder="Filter field"
        spellCheck={false}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="view-toolbar-options">
        {matches.length === 0 && <div className="view-toolbar-empty">No matching fields</div>}
        {bySection(matches).map((group) => (
          <div className="view-toolbar-option-group" key={group.section}>
            <div className="view-toolbar-option-section">{group.section}</div>
            {group.items.map((choice) => (
              <ButtonControl
                key={choice.id}
                className="view-toolbar-option view-toolbar-filter-field"
                onClick={() => openField(choice.id)}
              >
                <span className="view-toolbar-option-label">{choice.label}</span>
                {ruleByField.has(choice.id) ? (
                  <CheckIcon className="view-toolbar-field-check" size={ICON_SIZE.menu} />
                ) : null}
                <ChevronRightIcon className="view-toolbar-field-chevron" size={ICON_SIZE.menu} />
              </ButtonControl>
            ))}
          </div>
        ))}
      </div>
      {view.filterRules.length > 0 && (
        <div className="view-toolbar-rule-actions">
          <ButtonControl
            className="view-toolbar-reset"
            onClick={() => void run(() => api.clearFilterRules(node.id))}
          >
            Reset
          </ButtonControl>
        </div>
      )}
    </div>
  );
}

function FilterRuleEditor({
  label,
  rule,
  run,
  onBack,
}: {
  label: string;
  rule: ViewConfig['filterRules'][number] | undefined;
  run: CommandRunner;
  onBack: () => void;
}) {
  const needsValue = rule ? !VALUELESS_OPERATORS.has(rule.operator) : true;
  return (
    <div className="view-toolbar-filter-editor">
      <ButtonControl className="view-toolbar-filter-back" onClick={onBack}>
        <ChevronLeftIcon size={ICON_SIZE.menu} />
        <span>{label}</span>
      </ButtonControl>
      {rule ? (
        <div className="view-toolbar-rules">
          <div className="view-toolbar-rule view-toolbar-rule-filter">
            <SelectControl
              label="Filter operator"
              value={rule.operator}
              onChange={(event) => {
                void run(() => api.updateFilterRule(rule.id, { operator: event.currentTarget.value as FilterOperator }));
              }}
            >
              {FILTER_OPERATORS.map((operator) => (
                <option key={operator.id} value={operator.id}>{operator.label}</option>
              ))}
            </SelectControl>
            {needsValue && (
              <TextInputControl
                defaultValue={rule.values.join(', ')}
                label="Filter values"
                placeholder="value"
                onBlur={(event) => {
                  void run(() => api.updateFilterRule(rule.id, { values: normalizeValues(event.currentTarget.value) }));
                }}
                onKeyDown={(event) => {
                  if (isImeComposingEvent(event)) return;
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  event.currentTarget.blur();
                }}
              />
            )}
          </div>
          <div className="view-toolbar-rule-actions">
            <ButtonControl
              aria-label="Remove filter rule"
              className="view-toolbar-reset"
              onClick={() => {
                void run(() => api.removeFilterRule(rule.id));
                onBack();
              }}
            >
              Remove filter
            </ButtonControl>
          </div>
        </div>
      ) : (
        <div className="view-toolbar-empty">Adding filter…</div>
      )}
    </div>
  );
}

function OptionRow({
  label,
  selected,
  variant,
  onSelect,
}: {
  label: ReactNode;
  selected: boolean;
  variant: 'checkbox' | 'radio';
  onSelect: () => void;
}) {
  return (
    <ButtonControl
      aria-pressed={selected}
      className={`view-toolbar-option ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
    >
      {variant === 'checkbox' ? (
        <CheckboxMark checked={selected} />
      ) : (
        <span className={selected ? 'view-toolbar-radio checked' : 'view-toolbar-radio'} aria-hidden="true" />
      )}
      <span className="view-toolbar-option-label">{label}</span>
    </ButtonControl>
  );
}

function AddFieldSelect({
  label,
  choices,
  onSelect,
}: {
  label: string;
  choices: FieldChoice[];
  onSelect: (field: string) => void;
}) {
  return (
    <label className="view-toolbar-add-field">
      <AddIcon size={ICON_SIZE.menu} />
      <SelectControl
        label={label}
        value=""
        onChange={(event) => {
          const field = event.currentTarget.value || NAME_FIELD;
          onSelect(field);
          event.currentTarget.value = '';
        }}
      >
        <option value="">{label}</option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>{choice.label}</option>
        ))}
      </SelectControl>
    </label>
  );
}
