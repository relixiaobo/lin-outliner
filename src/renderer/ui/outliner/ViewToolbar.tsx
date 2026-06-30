import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { FilterOperator, NodeProjection, SortDirection } from '../../api/types';
import { projectFieldTypeById } from '../../../core/configProjection';
import type { DocumentIndex, ToolbarDropdownRequest, ToolbarDropdownSection } from '../../state/document';
import {
  CalendarIcon,
  CheckIcon,
  CheckboxIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FieldIcon,
  FilterIcon,
  GroupIcon,
  HashIcon,
  ICON_SIZE,
  OptionsIcon,
  PlainTextIcon,
  SearchIcon,
  SortAscIcon,
  SortDescIcon,
} from '../icons';
import type { ComponentType } from 'react';
import { resolveFieldOptions, type FieldOption } from '../interactions/fieldOptions';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { ButtonControl } from '../primitives/ButtonControl';
import { CheckboxMark } from '../primitives/CheckboxMark';
import { Input } from '../primitives/Input';
import { SelectControl } from '../primitives/SelectControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { resolveMenuNavigation, useMenuKeyboard } from '../primitives/useMenuKeyboard';
import type { CommandRunner } from '../shared';
import { collectViewFieldChoices, type ViewConfig } from './row-model';
import {
  CREATED_FIELD,
  DAY_FIELD,
  DONE_AT_FIELD,
  DONE_FIELD,
  NAME_FIELD,
  REF_COUNT_FIELD,
  TAGS_FIELD,
  UPDATED_FIELD,
  isSystemFieldId,
} from '../../../core/systemFields';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';

type ViewToolbarMessages = Messages['outliner']['viewToolbar'];

type FilterKind = 'boolean' | 'date' | 'number' | 'options' | 'text';

function filterFieldKind(fieldId: string, byId: DocumentIndex['byId']): FilterKind {
  if (fieldId === DONE_FIELD) return 'boolean';
  if (fieldId === CREATED_FIELD || fieldId === DAY_FIELD || fieldId === UPDATED_FIELD || fieldId === DONE_AT_FIELD) return 'date';
  if (fieldId === REF_COUNT_FIELD) return 'number';
  if (fieldId === NAME_FIELD || fieldId === TAGS_FIELD) return 'text';
  const fieldType = projectFieldTypeById(byId, fieldId);
  if (fieldType === 'checkbox') return 'boolean';
  if (fieldType === 'date') return 'date';
  if (fieldType === 'number') return 'number';
  if (fieldType === 'options' || fieldType === 'options_from_supertag') return 'options';
  return 'text';
}

// Operators offered per field kind; text keeps the full set.
const OPERATORS_BY_KIND: Record<'text' | 'date' | 'number', FilterOperator[]> = {
  text: ['contains', 'not_contains', 'is', 'is_not', 'is_empty', 'is_not_empty'],
  date: ['is', 'after', 'before', 'is_empty', 'is_not_empty'],
  number: ['is', 'gt', 'lt', 'is_empty', 'is_not_empty'],
};

function defaultFilterOperator(kind: FilterKind): FilterOperator {
  return kind === 'text' ? 'contains' : 'is';
}

type IconComponent = ComponentType<{ size?: number; className?: string }>;
const KIND_ICONS: Record<FilterKind, IconComponent> = {
  boolean: CheckboxIcon,
  date: CalendarIcon,
  number: HashIcon,
  options: OptionsIcon,
  text: PlainTextIcon,
};

// Field-type glyph shown beside a field name so date/text/option fields read
// apart at a glance.
function FieldKindIcon({ fieldId, byId }: { fieldId: string; byId: DocumentIndex['byId'] }) {
  const Icon = fieldId === TAGS_FIELD ? HashIcon : KIND_ICONS[filterFieldKind(fieldId, byId)];
  return <Icon className="view-toolbar-field-kind" size={ICON_SIZE.menu} />;
}

// Sort direction reads in the field's own terms: A→Z for text, 1→9 for
// numbers, Old→New for dates, rather than an abstract "Ascending". Labels are
// passed in from the component (these helpers run outside React).
function sortDirectionLabels(t: ViewToolbarMessages): Record<FilterKind, { asc: string; desc: string }> {
  return {
    boolean: { asc: t.sortBooleanAsc, desc: t.sortBooleanDesc },
    date: { asc: t.sortDateAsc, desc: t.sortDateDesc },
    number: { asc: t.sortNumberAsc, desc: t.sortNumberDesc },
    options: { asc: t.sortAlphaAsc, desc: t.sortAlphaDesc },
    text: { asc: t.sortAlphaAsc, desc: t.sortAlphaDesc },
  };
}

function sortDirectionLabel(
  fieldId: string,
  byId: DocumentIndex['byId'],
  direction: SortDirection,
  t: ViewToolbarMessages,
): string {
  const labels = sortDirectionLabels(t)[filterFieldKind(fieldId, byId)];
  return direction === 'desc' ? labels.desc : labels.asc;
}

interface ViewToolbarProps {
  node: NodeProjection;
  view: ViewConfig;
  index: DocumentIndex;
  run: CommandRunner;
  dropdownRequest: ToolbarDropdownRequest | null;
  onDropdownRequestConsumed: (request: ToolbarDropdownRequest) => void;
}

// Every dropdown section maps to a real view operation. The fake
// Table/Cards/Calendar "View as" switcher was removed: only the list view
// renders, so offering modes that do nothing would be misleading.
type ToolbarSection = ToolbarDropdownSection;
type OpenSection = ToolbarSection | null;
type FieldChoice = { id: string; label: string; section: 'System fields' | 'Fields' };
type FilterEditTarget = {
  field: string;
  ruleId?: string;
};
type ViewSummaryChip = {
  id: string;
  label: string;
  section: ToolbarSection;
  tone: 'display' | 'filter' | 'group' | 'sort';
  filterTarget?: FilterEditTarget;
  filterRuleId?: string;
};

type ToolbarTooltipState = {
  label: string;
  left: number;
  top: number;
  placement: 'top' | 'bottom';
};

function isNameFilterRule(rule: ViewConfig['filterRules'][number]): boolean {
  return rule.field === NAME_FIELD && rule.operator === 'contains';
}

function filterOperators(t: ViewToolbarMessages): Array<{ id: FilterOperator; label: string }> {
  return [
    { id: 'contains', label: t.operatorContains },
    { id: 'not_contains', label: t.operatorNotContains },
    { id: 'is', label: t.operatorIs },
    { id: 'is_not', label: t.operatorIsNot },
    { id: 'is_empty', label: t.operatorIsEmpty },
    { id: 'is_not_empty', label: t.operatorIsNotEmpty },
    { id: 'gt', label: t.operatorGreaterThan },
    { id: 'lt', label: t.operatorLessThan },
    { id: 'after', label: t.operatorAfter },
    { id: 'before', label: t.operatorBefore },
  ];
}

// Fields that never make sense to group by: the row text itself and a derived count.
const GROUP_FIELD_DENYLIST = new Set([NAME_FIELD, REF_COUNT_FIELD]);

// Operators that match on presence alone, so the value input is hidden for them.
const VALUELESS_OPERATORS = new Set<FilterOperator>(['is_empty', 'is_not_empty']);

function sectionTitles(t: ViewToolbarMessages): Record<ToolbarSection, string> {
  return {
    display: t.display,
    group: t.groupBy,
    sort: t.sortBy,
    filter: t.filterBy,
  };
}

// Field pickers and option lists stay compact; the rule editors (sort/filter)
// need room for the field/operator/value controls.
const SECTION_WIDTHS: Record<ToolbarSection, number> = {
  display: 264,
  group: 264,
  sort: 320,
  filter: 360,
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

function displayNodeForToolbar(node: NodeProjection, byId: DocumentIndex['byId']): NodeProjection {
  if (node.type === 'reference' && node.targetId) return byId.get(node.targetId) ?? node;
  return node;
}

function collectFilterFieldChoices(
  parent: NodeProjection,
  byId: DocumentIndex['byId'],
  choices: FieldChoice[],
  filterRules: ViewConfig['filterRules'],
): FieldChoice[] {
  const labelsById = new Map(choices.map((choice) => [choice.id, choice.label]));
  const systemChoices = choices.filter((choice) => choice.section === 'System fields' && choice.id !== NAME_FIELD);
  const fields = new Set<string>();

  for (const childId of parent.children) {
    const child = byId.get(childId);
    if (!child) continue;
    const displayed = displayNodeForToolbar(child, byId);
    for (const nestedId of displayed.children) {
      const nested = byId.get(nestedId);
      if (nested?.type !== 'fieldEntry' || !nested.fieldDefId || isSystemFieldId(nested.fieldDefId)) continue;
      fields.add(nested.fieldDefId);
    }
  }

  for (const rule of filterRules) {
    if (isNameFilterRule(rule) || isSystemFieldId(rule.field)) continue;
    fields.add(rule.field);
  }

  const customChoices = [...fields]
    .map((fieldId): FieldChoice => ({
      id: fieldId,
      label: labelsById.get(fieldId) ?? fieldId,
      section: 'Fields',
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  return [...systemChoices, ...customChoices];
}

// Compact chips restate what the view is currently doing, so the active state is
// legible without opening each menu. Empty when the view is default.
function summarizeView(
  view: ViewConfig,
  choices: FieldChoice[],
  t: ViewToolbarMessages,
  options: { includeSort: boolean },
): ViewSummaryChip[] {
  const labelOf = (fieldId: string) => choices.find((choice) => choice.id === fieldId)?.label ?? fieldId;
  const chips: ViewSummaryChip[] = [];
  const visibleDisplayCount = view.displayFields.filter((field) => field.visible && field.field !== NAME_FIELD).length;
  if (visibleDisplayCount > 0) {
    chips.push({
      id: 'display',
      label: t.summaryDisplayCount(visibleDisplayCount),
      section: 'display',
      tone: 'display',
    });
  }
  if (view.groupField) {
    chips.push({
      id: 'group',
      label: t.summaryGroupedBy({ field: labelOf(view.groupField) }),
      section: 'group',
      tone: 'group',
    });
  }
  if (options.includeSort && view.sortRules.length > 0) {
    const [first] = view.sortRules;
    const arrow = first.direction === 'desc' ? '↓' : '↑';
    const more = view.sortRules.length > 1 ? ` +${view.sortRules.length - 1}` : '';
    chips.push({
      id: 'sort',
      label: t.summarySortedBy({ field: labelOf(first.field), arrow: `${arrow}${more}` }),
      section: 'sort',
      tone: 'sort',
    });
  }
  for (const rule of view.filterRules) {
    if (isNameFilterRule(rule)) continue;
    chips.push({
      id: `filter:${rule.id}`,
      label: labelOf(rule.field),
      section: 'filter',
      tone: 'filter',
      filterTarget: { field: rule.field, ruleId: rule.id },
      filterRuleId: rule.id,
    });
  }
  return chips;
}

export function ViewToolbar({
  node,
  view,
  index,
  run,
  dropdownRequest,
  onDropdownRequestConsumed,
}: ViewToolbarProps) {
  const t = useT();
  const tv = t.outliner.viewToolbar;
  const [open, setOpen] = useState<OpenSection>(null);
  const [requestedFilterTarget, setRequestedFilterTarget] = useState<FilterEditTarget | null>(null);
  const [tooltip, setTooltip] = useState<ToolbarTooltipState | null>(null);
  const choices = useMemo(() => collectViewFieldChoices(node, index.byId), [node, index.byId]);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLButtonElement>(null);
  const sortRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const nameFilter = view.filterRules.find(isNameFilterRule);
  const firstSortRule = view.sortRules[0];
  const SortStateIcon = firstSortRule?.direction === 'desc' ? SortDescIcon : SortAscIcon;
  const buttonRefs: Record<ToolbarSection, RefObject<HTMLButtonElement | null>> = {
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
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);

  // The pill to restore focus to on close. Captured when a section opens, because
  // by the time `useMenuKeyboard`'s cleanup runs `open` is already null — reading
  // it live would always yield no target.
  const restoreTargetRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) restoreTargetRef.current = buttonRefs[open].current;
    // buttonRefs is a fresh literal each render but its members are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus-in / trap / Escape-to-close / focus-restore to the toolbar pill that
  // opened the popover (its content is heterogeneous form controls → dialog kind).
  // `focusKey: open` re-pulls focus into the surface when the user switches
  // section by clicking a different pill (focus would otherwise stay on the pill,
  // outside the surface, so Escape/Tab-trap would not fire).
  const { onKeyDown: onMenuKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: () => setOpen(null),
    kind: 'dialog',
    active: open !== null,
    getRestoreTarget: () => restoreTargetRef.current,
    focusKey: open ?? '',
  });

  const toggle = (section: ToolbarSection) => {
    if (section !== 'filter') setRequestedFilterTarget(null);
    setOpen((current) => (current === section ? null : section));
  };

  const openSummaryChip = (chip: ViewSummaryChip) => {
    setRequestedFilterTarget(chip.filterTarget ?? null);
    setOpen(chip.section);
  };

  const showTooltipFor = (element: HTMLElement) => {
    const label = element.dataset.tooltip?.trim();
    if (!label) {
      setTooltip(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const placement: ToolbarTooltipState['placement'] = rect.top >= 36 ? 'top' : 'bottom';
    setTooltip({
      label,
      left: rect.left + rect.width / 2,
      top: placement === 'top' ? rect.top - 8 : rect.bottom + 8,
      placement,
    });
  };

  const tooltipTargetFromEvent = (
    event: ReactFocusEvent<HTMLDivElement> | ReactPointerEvent<HTMLDivElement>,
  ): HTMLElement | null => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('.view-toolbar-tooltip-anchor[data-tooltip]')
      : null;
    return target && toolbarRef.current?.contains(target) ? target : null;
  };

  const onTooltipPointerOver = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = tooltipTargetFromEvent(event);
    if (target) showTooltipFor(target);
  };

  const onTooltipPointerOut = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = tooltipTargetFromEvent(event);
    if (!target) return;
    const related = event.relatedTarget;
    if (related instanceof Node && target.contains(related)) return;
    setTooltip(null);
  };

  const onTooltipFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    const target = tooltipTargetFromEvent(event);
    if (target) showTooltipFor(target);
  };

  const onTooltipBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const target = tooltipTargetFromEvent(event);
    if (!target) return;
    const related = event.relatedTarget;
    if (related instanceof Node && target.contains(related)) return;
    setTooltip(null);
  };

  const summaryChips = useMemo(
    () => summarizeView(view, choices, tv, { includeSort: open === 'sort' }),
    [view, choices, tv, open],
  );
  const titles = sectionTitles(tv);
  const renderSummaryChip = (chip: ViewSummaryChip) => {
    if (chip.filterRuleId) {
      return (
        <span className={`view-toolbar-summary-chip is-${chip.tone} has-remove`} key={chip.id}>
          <ButtonControl
            className="view-toolbar-summary-chip-main"
            onClick={() => openSummaryChip(chip)}
          >
            <span className="view-toolbar-summary-chip-label">{chip.label}</span>
          </ButtonControl>
          <ButtonControl
            aria-label={tv.removeFilterRule}
            className="view-toolbar-summary-chip-remove view-toolbar-tooltip-anchor"
            data-tooltip={tv.removeFilterRule}
            onClick={() => void run(() => api.removeFilterRule(chip.filterRuleId!))}
          >
            <CloseIcon size={ICON_SIZE.tiny} />
          </ButtonControl>
        </span>
      );
    }
    return (
      <ButtonControl
        className={`view-toolbar-summary-chip is-${chip.tone}`}
        key={chip.id}
        onClick={() => openSummaryChip(chip)}
      >
        <span className="view-toolbar-summary-chip-label">{chip.label}</span>
      </ButtonControl>
    );
  };

  return (
    <div
      className="view-toolbar"
      aria-label={tv.toolbarAriaLabel}
      ref={toolbarRef}
      onBlur={onTooltipBlur}
      onFocus={onTooltipFocus}
      onPointerDown={() => setTooltip(null)}
      onPointerOut={onTooltipPointerOut}
      onPointerOver={onTooltipPointerOver}
    >
      <div className="view-toolbar-button-row">
        <NameFilterControl
          nameFilter={nameFilter}
          nodeId={node.id}
          run={run}
          label={tv.filterByName}
          clearLabel={tv.clearNameFilter}
          placeholder={tv.nameFilterPlaceholder}
        />
        <ToolbarButton
          ref={displayRef}
          label={tv.display}
          open={open === 'display'}
          onClick={() => toggle('display')}
        >
          <FieldIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        <ToolbarButton
          ref={groupRef}
          label={tv.groupBy}
          open={open === 'group'}
          onClick={() => toggle('group')}
        >
          <GroupIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        <ToolbarButton
          ref={sortRef}
          active={view.sortRules.length > 0}
          label={tv.sortBy}
          open={open === 'sort'}
          onClick={() => toggle('sort')}
        >
          <SortStateIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        {summaryChips.length > 0 && (
          <div className="view-toolbar-summary" aria-label={tv.summaryAriaLabel}>
            {summaryChips.map(renderSummaryChip)}
          </div>
        )}
        <ToolbarButton
          ref={filterRef}
          label={tv.filterBy}
          open={open === 'filter'}
          onClick={() => toggle('filter')}
        >
          <FilterIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
      </div>

      {open && createPortal(
        <div
          ref={menuRef}
          aria-label={titles[open]}
          className="view-toolbar-popover"
          role="dialog"
          onKeyDown={onMenuKeyDown}
          style={menuStyle}
        >
          <div className="view-toolbar-popover-title">{titles[open]}</div>
          {open === 'display' && (
            <DisplaySection byId={index.byId} choices={choices} node={node} run={run} view={view} />
          )}
          {open === 'group' && (
            <GroupSection byId={index.byId} choices={choices} node={node} run={run} view={view} />
          )}
          {open === 'sort' && (
            <SortSection byId={index.byId} choices={choices} node={node} run={run} view={view} />
          )}
          {open === 'filter' && (
            <FilterSection
              choices={choices}
              index={index}
              node={node}
              requestedTarget={requestedFilterTarget}
              run={run}
              view={view}
              onRequestedTargetConsumed={() => setRequestedFilterTarget(null)}
            />
          )}
        </div>,
        document.body,
      )}
      {tooltip && createPortal(<ViewToolbarTooltip tooltip={tooltip} />, document.body)}
    </div>
  );
}

function ViewToolbarTooltip({ tooltip }: { tooltip: ToolbarTooltipState }) {
  return (
    <div
      className={`view-toolbar-tooltip is-${tooltip.placement}`}
      role="tooltip"
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.label}
    </div>
  );
}

function NameFilterControl({
  nameFilter,
  nodeId,
  run,
  label,
  clearLabel,
  placeholder,
}: {
  nameFilter: ViewConfig['filterRules'][number] | undefined;
  nodeId: string;
  run: CommandRunner;
  label: string;
  clearLabel: string;
  placeholder: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(nameFilter?.values[0] ?? '');
  const lastCommittedRef = useRef(nameFilter?.values[0] ?? '');
  const pendingCreateRef = useRef(false);
  const desiredValueRef = useRef(nameFilter?.values[0] ?? '');
  const nameFilterId = nameFilter?.id;
  const committedValue = nameFilter?.values[0] ?? '';
  const active = committedValue.trim().length > 0 || open;

  useEffect(() => {
    const previous = lastCommittedRef.current;
    lastCommittedRef.current = committedValue;
    desiredValueRef.current = committedValue;
    setDraft((current) => {
      if (open && current.trim() !== previous.trim()) return current;
      return committedValue;
    });
  }, [committedValue, nameFilterId, open, run]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const value = draft.trim();
    if (value === lastCommittedRef.current.trim()) return undefined;
    const timer = window.setTimeout(() => {
      desiredValueRef.current = value;
      if (value.length === 0) {
        if (!nameFilterId) {
          lastCommittedRef.current = '';
          return;
        }
        void run(() => api.removeFilterRule(nameFilterId), { applyFocus: false });
        lastCommittedRef.current = '';
        return;
      }
      if (nameFilterId) {
        lastCommittedRef.current = value;
        void run(() => api.updateFilterRule(nameFilterId, {
          operator: 'contains',
          valueLogic: 'any',
          values: [value],
        }), { applyFocus: false });
      } else if (!pendingCreateRef.current) {
        pendingCreateRef.current = true;
        lastCommittedRef.current = value;
        void run(() => api.addFilterRule(nodeId, NAME_FIELD, 'contains', [value], 'any'), { applyFocus: false })
          .then((result) => {
            if (!result) lastCommittedRef.current = '';
            const createdRuleId = result && 'focus' in result ? result.focus?.nodeId : undefined;
            if (createdRuleId && desiredValueRef.current.trim().length === 0) {
              lastCommittedRef.current = '';
              void run(() => api.removeFilterRule(createdRuleId), { applyFocus: false });
            }
          })
          .finally(() => {
            pendingCreateRef.current = false;
          });
      } else {
        return;
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [draft, nameFilterId, nodeId, open, run]);

  const clear = () => {
    setDraft('');
    setOpen(false);
    if (nameFilterId) {
      void run(() => api.removeFilterRule(nameFilterId), { applyFocus: false });
    }
    lastCommittedRef.current = '';
    desiredValueRef.current = '';
  };

  if (!active) {
    return (
      <ButtonControl
        aria-label={label}
        className="view-toolbar-pill view-toolbar-tooltip-anchor"
        data-tooltip={label}
        onClick={() => setOpen(true)}
      >
        <SearchIcon size={ICON_SIZE.menu} />
      </ButtonControl>
    );
  }

  return (
    <div className="view-toolbar-name-filter">
      <SearchIcon className="view-toolbar-name-filter-icon" size={ICON_SIZE.menu} />
      <Input
        ref={inputRef}
        className="view-toolbar-name-filter-input"
        label={label}
        placeholder={placeholder}
        size="sm"
        spellCheck={false}
        value={draft}
        variant="bare"
        onBlur={() => {
          if (draft.trim()) return;
          if (nameFilterId) {
            void run(() => api.removeFilterRule(nameFilterId), { applyFocus: false });
          }
          lastCommittedRef.current = '';
          desiredValueRef.current = '';
          setOpen(false);
        }}
        onChange={(event) => {
          if (!open) setOpen(true);
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (isImeComposingEvent(event)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(committedValue);
            desiredValueRef.current = committedValue;
            setOpen(false);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <ButtonControl
        aria-label={clearLabel}
        className="view-toolbar-name-filter-clear view-toolbar-tooltip-anchor"
        data-tooltip={clearLabel}
        onPointerDown={(event) => event.preventDefault()}
        onClick={clear}
      >
        <CloseIcon size={ICON_SIZE.menu} />
      </ButtonControl>
    </div>
  );
}

const ToolbarButton = forwardRef<HTMLButtonElement, {
  active?: boolean;
  label: string;
  open: boolean;
  onClick: () => void;
  children: ReactNode;
}>(function ToolbarButton({ active = false, label, open, onClick, children }, ref) {
  const classes = [
    'view-toolbar-pill',
    'view-toolbar-tooltip-anchor',
    active ? 'is-active' : '',
    open ? 'is-open' : '',
  ].filter(Boolean).join(' ');
  return (
    <ButtonControl
      ref={ref}
      aria-expanded={open}
      aria-label={label}
      className={classes}
      data-tooltip={label}
      onClick={onClick}
    >
      {children}
    </ButtonControl>
  );
});

function DisplaySection({
  byId,
  choices,
  node,
  run,
  view,
}: {
  byId: DocumentIndex['byId'];
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
                icon={<FieldKindIcon byId={byId} fieldId={choice.id} />}
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
  byId,
  choices,
  node,
  run,
  view,
}: {
  byId: DocumentIndex['byId'];
  choices: FieldChoice[];
  node: NodeProjection;
  run: CommandRunner;
  view: ViewConfig;
}) {
  const t = useT();
  const groupable = choices.filter((choice) => !GROUP_FIELD_DENYLIST.has(choice.id));
  const groups = bySection(groupable);
  const current = view.groupField ?? '';
  // When the active group field is not in the visible list (denylisted/removed),
  // no option is selected — keep "No grouping" the Tab stop so the group stays
  // keyboard-reachable.
  const groupedOnVisible = groupable.some((choice) => choice.id === current);
  return (
    <RadioOptionGroup className="view-toolbar-options" label={t.outliner.viewToolbar.groupBy}>
      <OptionRow
        label={t.outliner.viewToolbar.noGrouping}
        selected={current === ''}
        tabIndex={groupedOnVisible ? -1 : 0}
        variant="radio"
        onSelect={() => void run(() => api.setGroupField(node.id, null))}
      />
      {groups.map((group) => (
        <div className="view-toolbar-option-group" key={group.section}>
          <div className="view-toolbar-option-section">{group.section}</div>
          {group.items.map((choice) => (
            <OptionRow
              key={choice.id}
              icon={<FieldKindIcon byId={byId} fieldId={choice.id} />}
              label={choice.label}
              selected={current === choice.id}
              variant="radio"
              onSelect={() => void run(() => api.setGroupField(node.id, choice.id))}
            />
          ))}
        </div>
      ))}
    </RadioOptionGroup>
  );
}

function SortSection({
  byId,
  choices,
  node,
  run,
  view,
}: {
  byId: DocumentIndex['byId'];
  choices: FieldChoice[];
  node: NodeProjection;
  run: CommandRunner;
  view: ViewConfig;
}) {
  const t = useT();
  const tv = t.outliner.viewToolbar;
  const [editingTarget, setEditingTarget] = useState<{ field: string; ruleId?: string } | null>(null);
  const ruleByField = useMemo(
    () => new Map(view.sortRules.map((rule) => [rule.field, rule])),
    [view.sortRules],
  );
  const ruleById = useMemo(
    () => new Map(view.sortRules.map((rule) => [rule.id, rule])),
    [view.sortRules],
  );
  const sortOrderByRuleId = useMemo(
    () => new Map(view.sortRules.map((rule, index) => [rule.id, index + 1])),
    [view.sortRules],
  );

  useEffect(() => {
    if (!editingTarget) return;
    if (editingTarget.ruleId) {
      const rule = ruleById.get(editingTarget.ruleId);
      if (rule) {
        if (rule.field !== editingTarget.field) setEditingTarget({ field: rule.field, ruleId: rule.id });
        return;
      }
      setEditingTarget(null);
      return;
    }
    const rule = ruleByField.get(editingTarget.field);
    if (rule) setEditingTarget({ field: rule.field, ruleId: rule.id });
  }, [editingTarget, ruleByField, ruleById]);

  if (editingTarget) {
    const rule = editingTarget.ruleId
      ? ruleById.get(editingTarget.ruleId)
      : ruleByField.get(editingTarget.field);
    const editingField = rule?.field ?? editingTarget.field;
    const label = choices.find((choice) => choice.id === editingField)?.label ?? tv.fieldFallback;
    const directionLabels = sortDirectionLabels(tv)[filterFieldKind(editingField, byId)];
    return (
      <div className="view-toolbar-sort-editor">
        <ButtonControl autoFocus className="view-toolbar-filter-back" onClick={() => setEditingTarget(null)}>
          <ChevronLeftIcon size={ICON_SIZE.menu} />
          <span>{label}</span>
        </ButtonControl>
        {rule ? (
          <RadioOptionGroup className="view-toolbar-options" label={tv.sortDirectionLabel}>
            <OptionRow
              icon={<SortAscIcon size={ICON_SIZE.menu} />}
              label={directionLabels.asc}
              selected={rule.direction === 'asc'}
              tabIndex={rule.direction === 'desc' ? -1 : 0}
              variant="radio"
              onSelect={() => {
                void run(() => api.updateSortRule(rule.id, editingField, 'asc'));
              }}
            />
            <OptionRow
              icon={<SortDescIcon size={ICON_SIZE.menu} />}
              label={directionLabels.desc}
              selected={rule.direction === 'desc'}
              tabIndex={rule.direction === 'desc' ? 0 : -1}
              variant="radio"
              onSelect={() => {
                void run(() => api.updateSortRule(rule.id, editingField, 'desc'));
              }}
            />
          </RadioOptionGroup>
        ) : (
          <div className="view-toolbar-empty">{tv.addingSort}</div>
        )}
        {rule && (
          <div className="view-toolbar-rule-actions">
            <ButtonControl
              aria-label={tv.removeSortRule}
              className="view-toolbar-reset"
              onClick={() => {
                void run(() => api.removeSortRule(rule.id));
                setEditingTarget(null);
              }}
            >
              {tv.removeSort}
            </ButtonControl>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="view-toolbar-sort">
      <div className="view-toolbar-options">
        {bySection(choices).map((group) => (
          <div className="view-toolbar-option-group" key={group.section}>
            <div className="view-toolbar-option-section">{group.section}</div>
            {group.items.map((choice) => {
              const rule = ruleByField.get(choice.id);
              const directionLabel = rule ? sortDirectionLabel(choice.id, byId, rule.direction, tv) : null;
              const order = rule ? sortOrderByRuleId.get(rule.id) : undefined;
              return (
                <ButtonControl
                  key={choice.id}
                  className={`view-toolbar-option view-toolbar-filter-field ${rule ? 'is-selected' : ''}`}
                  onClick={() => {
                    if (rule) {
                      setEditingTarget({ field: choice.id, ruleId: rule.id });
                      return;
                    }
                    void run(() => api.addSortRule(node.id, choice.id, 'asc'));
                    setEditingTarget({ field: choice.id });
                  }}
                >
                  <FieldKindIcon byId={byId} fieldId={choice.id} />
                  <span className="view-toolbar-option-label">{choice.label}</span>
                  {directionLabel && order ? (
                    <span className="view-toolbar-option-meta">{tv.sortPriorityMeta({ index: order, direction: directionLabel })}</span>
                  ) : null}
                  <ChevronRightIcon className="view-toolbar-field-chevron" size={ICON_SIZE.menu} />
                </ButtonControl>
              );
            })}
          </div>
        ))}
      </div>
      {view.sortRules.length > 0 && (
        <div className="view-toolbar-rule-actions">
          <ButtonControl
            className="view-toolbar-reset"
            onClick={() => void run(() => api.clearSortRules(node.id))}
          >
            {tv.reset}
          </ButtonControl>
        </div>
      )}
    </div>
  );
}

// Progressive field menu (Tana-style): the popover first lists filterable
// fields; picking one drills into an operator/value editor for that field. We
// model one filter rule per field and look the rule up by field, so a freshly
// added rule resolves without threading the new rule id back through the command.
function FilterSection({
  choices,
  index,
  node,
  requestedTarget,
  run,
  view,
  onRequestedTargetConsumed,
}: {
  choices: FieldChoice[];
  index: DocumentIndex;
  node: NodeProjection;
  requestedTarget: FilterEditTarget | null;
  run: CommandRunner;
  view: ViewConfig;
  onRequestedTargetConsumed: () => void;
}) {
  const t = useT();
  const tv = t.outliner.viewToolbar;
  const [editingTarget, setEditingTarget] = useState<FilterEditTarget | null>(null);
  const [query, setQuery] = useState('');
  const filterRules = useMemo(
    () => view.filterRules.filter((rule) => !isNameFilterRule(rule)),
    [view.filterRules],
  );
  const filterChoices = useMemo(
    () => collectFilterFieldChoices(node, index.byId, choices, view.filterRules),
    [choices, index.byId, node, view.filterRules],
  );
  const ruleByField = useMemo(
    () => new Map(filterRules.map((rule) => [rule.field, rule])),
    [filterRules],
  );
  const ruleById = useMemo(
    () => new Map(filterRules.map((rule) => [rule.id, rule])),
    [filterRules],
  );

  useEffect(() => {
    if (!requestedTarget) return;
    const rule = requestedTarget.ruleId ? ruleById.get(requestedTarget.ruleId) : undefined;
    const field = rule?.field ?? requestedTarget.field;
    if (!filterChoices.some((choice) => choice.id === field) && !ruleByField.has(field)) {
      onRequestedTargetConsumed();
      return;
    }
    setEditingTarget({ field, ruleId: rule?.id ?? requestedTarget.ruleId });
    setQuery('');
    onRequestedTargetConsumed();
  }, [filterChoices, onRequestedTargetConsumed, requestedTarget, ruleByField, ruleById]);

  if (editingTarget) {
    const rule = editingTarget.ruleId
      ? ruleById.get(editingTarget.ruleId)
      : ruleByField.get(editingTarget.field);
    const editingField = rule?.field ?? editingTarget.field;
    const label = choices.find((choice) => choice.id === editingField)?.label ?? tv.fieldFallback;
    const kind = filterFieldKind(editingField, index.byId);
    const options = kind === 'options'
      ? resolveFieldOptions(index.byId.get(editingField), index.byId)
      : [];
    return (
      <FilterRuleEditor
        field={editingField}
        kind={kind}
        label={label}
        options={options}
        rule={rule}
        run={run}
        onBack={() => setEditingTarget(null)}
      />
    );
  }

  const normalized = query.trim().toLowerCase();
  const matches = normalized
    ? filterChoices.filter((choice) => choice.label.toLowerCase().includes(normalized))
    : filterChoices;

  const openField = (field: string) => {
    const rule = ruleByField.get(field);
    if (!rule) {
      void run(() => api.addFilterRule(node.id, field, defaultFilterOperator(filterFieldKind(field, index.byId)), [], 'any'));
      setEditingTarget({ field });
      return;
    }
    setEditingTarget({ field, ruleId: rule.id });
  };

  return (
    <div className="view-toolbar-filter">
      {filterChoices.length > 0 && (
        <Input
          autoFocus
          className="view-toolbar-filter-search"
          label={tv.filterFieldPlaceholder}
          placeholder={tv.filterFieldPlaceholder}
          size="sm"
          spellCheck={false}
          value={query}
          variant="boxed"
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="view-toolbar-options">
        {matches.length === 0 && <div className="view-toolbar-empty">{tv.noMatchingFields}</div>}
        {bySection(matches).map((group) => (
          <div className="view-toolbar-option-group" key={group.section}>
            <div className="view-toolbar-option-section">{group.section}</div>
            {group.items.map((choice) => (
              <ButtonControl
                key={choice.id}
                className="view-toolbar-option view-toolbar-filter-field"
                onClick={() => openField(choice.id)}
              >
                <FieldKindIcon byId={index.byId} fieldId={choice.id} />
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
      {filterRules.length > 0 && (
        <div className="view-toolbar-rule-actions">
          <ButtonControl
            className="view-toolbar-reset"
            onClick={() => {
              const hasNameFilter = view.filterRules.some(isNameFilterRule);
              if (!hasNameFilter) {
                void run(() => api.clearFilterRules(node.id));
                return;
              }
              void (async () => {
                for (const rule of filterRules) {
                  await run(() => api.removeFilterRule(rule.id), { applyFocus: false });
                }
              })();
            }}
          >
            {tv.reset}
          </ButtonControl>
        </div>
      )}
    </div>
  );
}

function FilterRuleEditor({
  field,
  kind,
  label,
  options,
  rule,
  run,
  onBack,
}: {
  field: string;
  kind: FilterKind;
  label: string;
  options: FieldOption[];
  rule: ViewConfig['filterRules'][number] | undefined;
  run: CommandRunner;
  onBack: () => void;
}) {
  const tv = useT().outliner.viewToolbar;
  return (
    <div className="view-toolbar-filter-editor">
      <ButtonControl autoFocus className="view-toolbar-filter-back" onClick={onBack}>
        <ChevronLeftIcon size={ICON_SIZE.menu} />
        <span>{label}</span>
      </ButtonControl>
      {rule ? (
        <div className="view-toolbar-rules">
          {kind === 'boolean' ? (
            <BooleanFilterBody field={field} rule={rule} run={run} />
          ) : kind === 'options' ? (
            <OptionsFilterBody options={options} rule={rule} run={run} />
          ) : (
            <OperatorFilterBody kind={kind} rule={rule} run={run} />
          )}
          <div className="view-toolbar-rule-actions">
            <ButtonControl
              aria-label={tv.removeFilterRule}
              className="view-toolbar-reset"
              onClick={() => {
                void run(() => api.removeFilterRule(rule.id));
                onBack();
              }}
            >
              {tv.removeFilter}
            </ButtonControl>
          </div>
        </div>
      ) : (
        <div className="view-toolbar-empty">{tv.addingFilter}</div>
      )}
    </div>
  );
}

type FilterRule = ViewConfig['filterRules'][number];

// Boolean / checkbox fields store 'true' | 'false', so they are a binary choice.
function BooleanFilterBody({ field, rule, run }: { field: string; rule: FilterRule; run: CommandRunner }) {
  const tv = useT().outliner.viewToolbar;
  const lowered = rule.operator === 'is' ? rule.values.map((value) => value.trim().toLowerCase()) : [];
  const selected = lowered.includes('true') ? 'true' : lowered.includes('false') ? 'false' : null;
  const [onLabel, offLabel] = field === DONE_FIELD
    ? [tv.booleanDone, tv.booleanNotDone]
    : [tv.booleanYes, tv.booleanNo];
  return (
    <RadioOptionGroup className="view-toolbar-options" label={tv.filterValuesLabel}>
      {/* A freshly-added boolean filter has neither value selected; keep the first
          option as the Tab stop so the group stays keyboard-reachable. */}
      <OptionRow
        label={onLabel}
        selected={selected === 'true'}
        tabIndex={selected === 'false' ? -1 : 0}
        variant="radio"
        onSelect={() => void run(() => api.updateFilterRule(rule.id, { operator: 'is', values: ['true'] }))}
      />
      <OptionRow
        label={offLabel}
        selected={selected === 'false'}
        tabIndex={selected === 'false' ? 0 : -1}
        variant="radio"
        onSelect={() => void run(() => api.updateFilterRule(rule.id, { operator: 'is', values: ['false'] }))}
      />
    </RadioOptionGroup>
  );
}

// Options fields filter by selecting one or more of the field's defined options.
function OptionsFilterBody({ options, rule, run }: { options: FieldOption[]; rule: FilterRule; run: CommandRunner }) {
  const tv = useT().outliner.viewToolbar;
  if (options.length === 0) return <div className="view-toolbar-empty">{tv.noOptions}</div>;
  const selected = new Set(rule.values.map((value) => value.trim().toLowerCase()));
  return (
    <div className="view-toolbar-options">
      {options.map((option) => {
        const checked = selected.has(option.label.trim().toLowerCase());
        return (
          <OptionRow
            key={option.id}
            label={option.label}
            selected={checked}
            variant="checkbox"
            onSelect={() => {
              const next = checked
                ? rule.values.filter((value) => value.trim().toLowerCase() !== option.label.trim().toLowerCase())
                : [...rule.values, option.label];
              void run(() => api.updateFilterRule(rule.id, { operator: 'is', valueLogic: 'any', values: next }));
            }}
          />
        );
      })}
    </div>
  );
}

// Date / number / text: an operator plus a kind-appropriate value control.
function OperatorFilterBody({ kind, rule, run }: { kind: FilterKind; rule: FilterRule; run: CommandRunner }) {
  const tv = useT().outliner.viewToolbar;
  const allowed = OPERATORS_BY_KIND[kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text'];
  const operators = filterOperators(tv).filter((operator) => allowed.includes(operator.id));
  const needsValue = !VALUELESS_OPERATORS.has(rule.operator);
  const dateValue = /^\d{4}-\d{2}-\d{2}/.test(rule.values[0] ?? '') ? rule.values[0]!.slice(0, 10) : '';
  return (
    <div className="view-toolbar-rule view-toolbar-rule-filter">
      <SelectControl
        label={tv.filterOperatorLabel}
        size="sm"
        value={rule.operator}
        variant="boxed"
        onChange={(event) => {
          void run(() => api.updateFilterRule(rule.id, { operator: event.currentTarget.value as FilterOperator }));
        }}
      >
        {operators.map((operator) => (
          <option key={operator.id} value={operator.id}>{operator.label}</option>
        ))}
      </SelectControl>
      {needsValue && kind === 'date' ? (
        <Input
          label={tv.filterDateLabel}
          className="view-toolbar-date-input"
          size="sm"
          type="date"
          value={dateValue}
          variant="boxed"
          onChange={(event) => {
            void run(() => api.updateFilterRule(rule.id, { values: event.currentTarget.value ? [event.currentTarget.value] : [] }));
          }}
        />
      ) : needsValue ? (
        <Input
          defaultValue={rule.values.join(', ')}
          label={tv.filterValuesLabel}
          placeholder={tv.filterValuePlaceholder}
          size="sm"
          variant="boxed"
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
      ) : null}
    </div>
  );
}

function OptionRow({
  label,
  icon,
  selected,
  variant,
  onSelect,
  tabIndex,
}: {
  label: ReactNode;
  icon?: ReactNode;
  selected: boolean;
  variant: 'checkbox' | 'radio';
  onSelect: () => void;
  // Radio variant only: the roving tab stop. Defaults to the selected option
  // (each radiogroup has exactly one selected); pass explicitly when a group can
  // momentarily have none selected, so one option stays Tab-reachable.
  tabIndex?: number;
}) {
  const resolvedTabIndex = variant === 'radio' ? (tabIndex ?? (selected ? 0 : -1)) : tabIndex;
  return (
    <ButtonControl
      role={variant === 'checkbox' ? 'checkbox' : 'radio'}
      aria-checked={selected}
      className={`view-toolbar-option ${selected ? 'is-selected' : ''}`}
      onClick={onSelect}
      tabIndex={resolvedTabIndex}
    >
      {variant === 'checkbox' ? (
        <CheckboxMark checked={selected} />
      ) : (
        <span className={selected ? 'view-toolbar-radio checked' : 'view-toolbar-radio'} aria-hidden="true" />
      )}
      {icon}
      <span className="view-toolbar-option-label">{label}</span>
    </ButtonControl>
  );
}

// A radiogroup wrapper for single-select OptionRows. The roving tab stop is
// declarative (each radio's `tabIndex` follows its selected state — see
// OptionRow); this wrapper adds the group role/label and Arrow-key
// move-and-select, matching SegmentedControl. The radios may be interleaved with
// section headers (GroupSection), so navigation queries `[role="radio"]`
// descendants rather than assuming flat siblings.
function RadioOptionGroup({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposingEvent(event)) return;
    // Horizontal or vertical arrows both move; map onto the shared vertical
    // resolver so the wrap math lives in one place (resolveMenuNavigation).
    const key = event.key === 'ArrowRight' ? 'ArrowDown' : event.key === 'ArrowLeft' ? 'ArrowUp' : event.key;
    if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
    const group = ref.current;
    if (!group) return;
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])')];
    const nextIndex = resolveMenuNavigation(key, radios.indexOf(document.activeElement as HTMLElement), radios.length);
    if (nextIndex === null) return;
    event.preventDefault();
    // Moving selection follows focus (radio convention); the click re-renders the
    // group, which shifts the declarative tab stop onto the newly-selected option.
    const next = radios[nextIndex];
    next?.focus();
    next?.click();
  };

  return (
    <div aria-label={label} className={className} onKeyDown={onKeyDown} ref={ref} role="radiogroup">
      {children}
    </div>
  );
}
