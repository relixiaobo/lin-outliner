import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { FilterOp, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { FilterIcon, GroupIcon, ICON_SIZE, SortAscIcon, SortDescIcon } from '../icons';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import type { CommandRunner } from '../shared';
import { collectViewFieldChoices, fieldChoiceLabel, NAME_FIELD } from './row-model';

interface ViewToolbarProps {
  node: NodeProjection;
  index: DocumentIndex;
  run: CommandRunner;
}

function normalizeValues(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function ViewToolbar({ node, index, run }: ViewToolbarProps) {
  const [filterText, setFilterText] = useState(node.filterValues.join(', '));
  const choices = useMemo(() => collectViewFieldChoices(node, index.byId), [node, index.byId]);
  const sortLabel = node.sortField ? fieldChoiceLabel(node.sortField, index.byId) : 'Sort';
  const filterLabel = node.filterField ? fieldChoiceLabel(node.filterField, index.byId) : 'Filter';
  const groupLabel = node.groupField ? fieldChoiceLabel(node.groupField, index.byId) : 'Group';

  useEffect(() => {
    setFilterText(node.filterValues.join(', '));
  }, [node.id, node.filterValues]);

  return (
    <div className="view-toolbar" aria-label="View toolbar">
      <label className="view-toolbar-control">
        {node.sortDirection === 'desc' ? (
          <SortDescIcon size={ICON_SIZE.menu} />
        ) : (
          <SortAscIcon size={ICON_SIZE.menu} />
        )}
        <select
          value={node.sortField ?? ''}
          aria-label={sortLabel}
          onChange={(event) => {
            const field = event.currentTarget.value || null;
            void run(() => api.setNodeSort(node.id, field, field ? node.sortDirection ?? 'asc' : null));
          }}
        >
          <option value="">Sort</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>{choice.label}</option>
          ))}
        </select>
        {node.sortField && (
          <button
            className="view-toolbar-icon"
            type="button"
            title="Reverse sort"
            onClick={() => {
              void run(() => api.setNodeSort(
                node.id,
                node.sortField ?? NAME_FIELD,
                node.sortDirection === 'desc' ? 'asc' : 'desc',
              ));
            }}
          >
            {node.sortDirection === 'desc' ? (
              <SortAscIcon size={ICON_SIZE.menu} />
            ) : (
              <SortDescIcon size={ICON_SIZE.menu} />
            )}
          </button>
        )}
      </label>

      <label className="view-toolbar-control">
        <FilterIcon size={ICON_SIZE.menu} />
        <select
          value={node.filterField ?? ''}
          aria-label={filterLabel}
          onChange={(event) => {
            const field = event.currentTarget.value || null;
            void run(() => api.setNodeFilter(
              node.id,
              field,
              field ? node.filterOp ?? 'all' : null,
              field ? normalizeValues(filterText) : [],
            ));
          }}
        >
          <option value="">Filter</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>{choice.label}</option>
          ))}
        </select>
        {node.filterField && (
          <>
            <select
              value={node.filterOp ?? 'all'}
              aria-label="Filter mode"
              onChange={(event) => {
                const op = event.currentTarget.value as FilterOp;
                void run(() => api.setNodeFilter(node.id, node.filterField ?? NAME_FIELD, op, normalizeValues(filterText)));
              }}
            >
              <option value="all">All</option>
              <option value="any">Any</option>
            </select>
            <input
              value={filterText}
              placeholder="value"
              aria-label="Filter values"
              onChange={(event) => setFilterText(event.currentTarget.value)}
              onBlur={() => {
                void run(() => api.setNodeFilter(
                  node.id,
                  node.filterField ?? NAME_FIELD,
                  node.filterOp ?? 'all',
                  normalizeValues(filterText),
                ));
              }}
              onKeyDown={(event) => {
                if (isImeComposingEvent(event)) return;
                if (event.key !== 'Enter') return;
                event.preventDefault();
                event.currentTarget.blur();
              }}
            />
          </>
        )}
      </label>

      <label className="view-toolbar-control">
        <GroupIcon size={ICON_SIZE.menu} />
        <select
          value={node.groupField ?? ''}
          aria-label={groupLabel}
          onChange={(event) => {
            void run(() => api.setNodeGroup(node.id, event.currentTarget.value || null));
          }}
        >
          <option value="">Group</option>
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>{choice.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
