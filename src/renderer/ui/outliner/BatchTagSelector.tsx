import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { AddIcon, ICON_SIZE } from '../icons';
import {
  commonTagIdsForTargets,
  targetIdsForRows,
} from '../interactions/contextMenuSelection';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { MenuItem } from '../primitives/MenuItem';
import { TextInputControl } from '../primitives/TextInputControl';
import { selectedRootIds } from '../interactions/selectionActions';
import { clampTagSelectorIndex, tagSelectorItemLabel, tagSelectorItems } from '../interactions/tagSelector';
import type { CommandRunner } from '../shared';
import { resolveTagColor } from '../tags/tagColors';

interface BatchTagSelectorProps {
  open: boolean;
  selectedIds: Set<NodeId>;
  index: DocumentIndex;
  run: CommandRunner;
  close: () => void;
  clearSelection: () => void;
}

export function BatchTagSelector(props: BatchTagSelectorProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedRowIds = useMemo(
    () => selectedRootIds([...props.selectedIds], props.index.byId),
    [props.index.byId, props.selectedIds],
  );
  const targetIds = useMemo(
    () => targetIdsForRows(selectedRowIds, props.index.byId),
    [props.index.byId, selectedRowIds],
  );
  const existingTagIds = useMemo(
    () => commonTagIdsForTargets(targetIds, props.index.byId),
    [props.index.byId, targetIds],
  );
  const items = useMemo(
    () => tagSelectorItems({
      query,
      index: props.index,
      existingTagIds,
      limit: 8,
    }),
    [existingTagIds, props.index, query],
  );

  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    setSelectedIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [props.open]);

  useEffect(() => {
    setSelectedIndex((current) => clampTagSelectorIndex(current, items.length));
  }, [items.length]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current
      .querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!props.open || targetIds.length === 0) return null;

  const applyTag = (tagId: NodeId) => {
    props.close();
    void props.run(() => api.batchApplyTag(targetIds, tagId)).then((result) => {
      if (result) props.clearSelection();
    });
  };

  const createAndApplyTag = (name: string) => {
    props.close();
    void props.run(async () => {
      const created = await api.createTag(name);
      const tagId = created.focus?.nodeId;
      if (!tagId) return created;
      return api.batchApplyTag(targetIds, tagId);
    }).then((result) => {
      if (result) props.clearSelection();
    });
  };

  const confirmSelection = () => {
    const item = items[selectedIndex];
    if (!item) return;
    if (item.type === 'existing') applyTag(item.tag.id);
    else createAndApplyTag(item.name);
  };

  return createPortal(
    <div
      className="batch-tag-selector-backdrop"
      data-preserve-selection
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        props.close();
      }}
    >
      <div className="batch-tag-selector" data-preserve-selection>
        <div className="batch-tag-heading">Apply tag to {targetIds.length} nodes</div>
        <TextInputControl
          ref={inputRef}
          className="batch-tag-input"
          label="Search or create tag"
          value={query}
          placeholder="Search or create tag"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setSelectedIndex(0);
          }}
          onKeyDown={(event) => {
            if (isImeComposingEvent(event)) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              props.close();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedIndex((current) => clampTagSelectorIndex(current + 1, items.length));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedIndex((current) => clampTagSelectorIndex(current - 1, items.length));
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              confirmSelection();
            }
          }}
        />
        <div ref={listRef} className="batch-tag-list">
          {items.length === 0 && <div className="popover-empty">No tags</div>}
          {items.map((item, index) => {
            const active = index === selectedIndex;
            const label = tagSelectorItemLabel(item);
            const icon = item.type === 'existing'
              ? (
                <span
                  className="tag-selector-hash"
                  style={{ color: resolveTagColor(item.tag, props.index.byId).text }}
                  aria-hidden="true"
                >
                  #
                </span>
              )
              : <AddIcon size={ICON_SIZE.menu} />;
            return (
              <MenuItem
                key={item.type === 'existing' ? item.tag.id : `create:${item.name}`}
                active={active}
                className="popover-item"
                data-selected={active ? 'true' : undefined}
                icon={icon}
                iconClassName="popover-item-icon"
                label={label}
                labelClassName="popover-item-label"
                onMouseEnter={() => setSelectedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (item.type === 'existing') applyTag(item.tag.id);
                  else createAndApplyTag(item.name);
                }}
              />
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
