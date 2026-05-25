import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import type { FilterOperator, NodeProjection, SortDirection, ViewMode } from '../../api/types';
import type { DocumentIndex, ToolbarDropdownRequest, ToolbarDropdownSection } from '../../state/document';
import {
	  FieldIcon,
	  FilterIcon,
	  GroupIcon,
	  ICON_SIZE,
	  MoreIcon,
	  SearchIcon,
	  SortAscIcon,
	  SortDescIcon,
	  TableIcon,
} from '../icons';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { ButtonControl } from '../primitives/ButtonControl';
import { SelectControl } from '../primitives/SelectControl';
import { TextInputControl } from '../primitives/TextInputControl';
import type { CommandRunner } from '../shared';
import {
	  collectViewFieldChoices,
	  fieldChoiceLabel,
	  NAME_FIELD,
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

function normalizeValues(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
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

  useEffect(() => {
    if (!dropdownRequest || dropdownRequest.nodeId !== node.id) return;
    setOpen(dropdownRequest.section);
    onDropdownRequestConsumed(dropdownRequest);
  }, [dropdownRequest, node.id, onDropdownRequestConsumed]);

  const toggle = (section: Exclude<OpenSection, null>) => {
    setOpen((current) => (current === section ? null : section));
  };

  return (
    <div className="view-toolbar" aria-label="View toolbar">
      <div className="view-toolbar-button-row">
        <ToolbarButton active={open === 'view'} label="View as" onClick={() => toggle('view')}>
          <TableIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        <ToolbarButton active={open === 'display'} label="Display" onClick={() => toggle('display')}>
          <FieldIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        <ToolbarButton active={open === 'group'} label="Group by" onClick={() => toggle('group')}>
          <GroupIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
        <ToolbarButton active={open === 'sort'} label="Sort by" onClick={() => toggle('sort')}>
          {view.sortRules[0]?.direction === 'desc' ? (
            <SortDescIcon size={ICON_SIZE.menu} />
          ) : (
            <SortAscIcon size={ICON_SIZE.menu} />
          )}
        </ToolbarButton>
        <ToolbarButton active={open === 'filter'} label="Filter by" onClick={() => toggle('filter')}>
          <FilterIcon size={ICON_SIZE.menu} />
        </ToolbarButton>
      </div>

      {open === 'view' && (
        <ToolbarPanel title="View as">
          <SelectControl
            value={view.viewMode}
            label="View mode"
            onChange={(event) => {
              void run(() => api.setViewMode(node.id, event.currentTarget.value as ViewMode));
            }}
          >
            {VIEW_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>{mode.label}</option>
            ))}
          </SelectControl>
        </ToolbarPanel>
      )}

      {open === 'sort' && (
        <ToolbarPanel title="Sort by">
          {view.sortRules.map((rule, index) => (
            <div className="view-toolbar-row" key={rule.id}>
              <span className="view-toolbar-row-label">{index === 0 ? 'Sort by' : 'Then by'}</span>
              <SelectControl
                value={rule.field}
                label="Sort field"
                onChange={(event) => {
                  void run(() => api.updateSortRule(rule.id, event.currentTarget.value, rule.direction));
                }}
              >
                {choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>{choice.label}</option>
                ))}
              </SelectControl>
              <ButtonControl
                className="view-toolbar-icon"
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
              </ButtonControl>
              <ButtonControl className="view-toolbar-remove" onClick={() => void run(() => api.removeSortRule(rule.id))}>
                Remove
              </ButtonControl>
            </div>
          ))}
          <AddFieldSelect
            label={view.sortRules.length > 0 ? 'Add sort' : 'Sort field'}
            choices={choices}
            onSelect={(field) => void run(() => api.addSortRule(node.id, field, 'asc'))}
          />
          {view.sortRules.length > 0 && (
            <ButtonControl className="view-toolbar-danger" onClick={() => void run(() => api.clearSortRules(node.id))}>
              Reset sort
            </ButtonControl>
          )}
        </ToolbarPanel>
      )}

      {open === 'filter' && (
        <ToolbarPanel title="Filter by">
          {view.filterRules.map((rule) => (
            <div className="view-toolbar-row view-toolbar-filter-row" key={rule.id}>
              <SelectControl
                value={rule.field}
                label="Filter field"
                onChange={(event) => {
                  void run(() => api.updateFilterRule(rule.id, { field: event.currentTarget.value }));
                }}
              >
                {choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>{choice.label}</option>
                ))}
              </SelectControl>
              <SelectControl
                value={rule.operator}
                label="Filter operator"
                onChange={(event) => {
                  void run(() => api.updateFilterRule(rule.id, { operator: event.currentTarget.value as FilterOperator }));
                }}
              >
                {FILTER_OPERATORS.map((operator) => (
                  <option key={operator.id} value={operator.id}>{operator.label}</option>
                ))}
              </SelectControl>
              <TextInputControl
                defaultValue={rule.values.join(', ')}
                placeholder="value"
                label="Filter values"
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
              <ButtonControl className="view-toolbar-remove" onClick={() => void run(() => api.removeFilterRule(rule.id))}>
                Remove
              </ButtonControl>
            </div>
          ))}
          <AddFieldSelect
            label={view.filterRules.length > 0 ? 'Add filter' : 'Filter field'}
            choices={choices}
            onSelect={(field) => void run(() => api.addFilterRule(node.id, field, 'contains', [], 'any'))}
          />
          {view.filterRules.length > 0 && (
            <ButtonControl className="view-toolbar-danger" onClick={() => void run(() => api.clearFilterRules(node.id))}>
              Reset filters
            </ButtonControl>
          )}
        </ToolbarPanel>
      )}

      {open === 'group' && (
        <ToolbarPanel title="Group by">
          <SelectControl
            value={view.groupField ?? ''}
            label="Group field"
            onChange={(event) => {
              void run(() => api.setGroupField(node.id, event.currentTarget.value || null));
            }}
          >
            <option value="">No grouping</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>{choice.label}</option>
            ))}
          </SelectControl>
        </ToolbarPanel>
      )}

      {open === 'display' && (
        <ToolbarPanel title="Display">
          {view.displayFields.map((field) => (
            <div className="view-toolbar-row" key={field.id}>
              <span className="view-toolbar-row-label">{fieldChoiceLabel(field.field, index.byId)}</span>
              <ButtonControl
                className="view-toolbar-remove"
                onClick={() => void run(() => api.updateDisplayField(field.id, { visible: !field.visible }))}
              >
                {field.visible ? 'Hide' : 'Show'}
              </ButtonControl>
              <ButtonControl className="view-toolbar-remove" onClick={() => void run(() => api.removeDisplayField(field.id))}>
                Remove
              </ButtonControl>
            </div>
          ))}
          <AddFieldSelect
            label={view.displayFields.length > 0 ? 'Add field' : 'Display field'}
            choices={choices}
            onSelect={(field) => void run(() => api.addDisplayField(node.id, field))}
          />
        </ToolbarPanel>
      )}
    </div>
  );
}

function ToolbarButton({
  active,
  label,
  children,
  onClick,
}: {
  active: boolean;
  label: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <ButtonControl
      aria-label={label}
      className={`view-toolbar-pill ${active ? 'is-active' : ''}`}
      title={label}
      onClick={onClick}
    >
      {children}
    </ButtonControl>
  );
}

function ToolbarPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="view-toolbar-panel">
      <div className="view-toolbar-panel-title">
        <SearchIcon size={ICON_SIZE.menu} />
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}

function AddFieldSelect({
  label,
  choices,
  onSelect,
}: {
  label: string;
  choices: Array<{ id: string; label: string }>;
  onSelect: (field: string) => void;
}) {
  return (
    <label className="view-toolbar-add-field">
      <MoreIcon size={ICON_SIZE.menu} />
      <SelectControl
        value=""
        label={label}
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
