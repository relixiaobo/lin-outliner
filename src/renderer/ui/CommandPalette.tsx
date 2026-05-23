import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { DocumentProjection, NodeId, SearchHit } from '../api/types';
import type { DocumentIndex } from '../state/document';
import {
  AddChildIcon,
  CalendarIcon,
  ICON_SIZE,
  LibraryIcon,
  SearchIcon,
  SupertagIcon,
  TrashIcon,
  type AppIcon,
} from './icons';
import { isImeComposingEvent } from './interactions/imeKeyboard';
import { ButtonControl } from './primitives/ButtonControl';
import { Dialog } from './primitives/Dialog';
import { MenuItem } from './primitives/MenuItem';
import { TextInputControl } from './primitives/TextInputControl';
import type { CommandRunner } from './shared';

interface CommandPaletteProps {
  projection: DocumentProjection;
  index: DocumentIndex;
  onClose: () => void;
  onFocus: (nodeId: NodeId | null) => void;
  onRoot: (nodeId: NodeId) => void;
  run: CommandRunner;
}

type PaletteItemKind = 'navigate' | 'node' | 'create';

interface PaletteItem {
  id: string;
  label: string;
  icon?: AppIcon;
  kind: PaletteItemKind;
  typeLabel: string;
  action: () => void;
}

function actionLabel(kind: PaletteItemKind) {
  return kind === 'create' ? 'Create' : 'Open';
}

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      if (!trimmed) {
        setHits([]);
        return;
      }
      void api.searchNodes(trimmed)
        .then((nextHits) => {
          if (active) setHits(nextHits);
        })
        .catch(() => {
          if (active) setHits([]);
        });
    }, 80);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const openNode = (nodeId: NodeId) => {
    props.onRoot(nodeId);
    props.onFocus(nodeId);
    props.onClose();
  };

  const createFromQuery = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    void props.run(async () => {
      const outcome = await api.createNode(props.projection.todayId, null, trimmed);
      props.onClose();
      return outcome;
    });
  };

  const defaultItems: PaletteItem[] = [
    {
      id: props.projection.todayId,
      label: 'Today',
      icon: CalendarIcon,
      kind: 'navigate',
      typeLabel: 'Navigate',
      action: () => openNode(props.projection.todayId),
    },
    {
      id: props.projection.libraryId,
      label: 'Library',
      icon: LibraryIcon,
      kind: 'navigate',
      typeLabel: 'Navigate',
      action: () => openNode(props.projection.libraryId),
    },
    {
      id: props.projection.schemaId,
      label: 'Schema',
      icon: SupertagIcon,
      kind: 'navigate',
      typeLabel: 'Navigate',
      action: () => openNode(props.projection.schemaId),
    },
    {
      id: props.projection.searchesId,
      label: 'Saved searches',
      icon: SearchIcon,
      kind: 'navigate',
      typeLabel: 'Navigate',
      action: () => openNode(props.projection.searchesId),
    },
    {
      id: props.projection.trashId,
      label: 'Trash',
      icon: TrashIcon,
      kind: 'navigate',
      typeLabel: 'Navigate',
      action: () => openNode(props.projection.trashId),
    },
  ];
  const trimmedQuery = query.trim();
  const hitItems: PaletteItem[] = hits.map((hit) => {
    const node = props.index.byId.get(hit.nodeId);
    return {
      id: hit.nodeId,
      label: node?.content.text || 'Untitled',
      kind: 'node',
      typeLabel: 'Node',
      action: () => openNode(hit.nodeId),
    };
  });
  const createItem: PaletteItem | null = trimmedQuery
    ? {
      id: '__create__',
      label: trimmedQuery,
      icon: AddChildIcon,
      kind: 'create',
      typeLabel: 'New in Today',
      action: createFromQuery,
    }
    : null;
  const visibleItems = trimmedQuery
    ? [...hitItems, ...(createItem ? [createItem] : [])]
    : defaultItems;
  const selected = visibleItems[selectedIndex];

  useEffect(() => {
    setSelectedIndex(0);
  }, [trimmedQuery, hits.length]);

  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;
    listEl.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const selectedItemId = selected ? `command-item-${selectedIndex}` : undefined;

  return (
    <Dialog
      backdropClassName="overlay"
      initialFocus={() => inputRef.current}
      label="Command palette"
      onBackdropMouseDown={props.onClose}
      onEscapeKeyDown={props.onClose}
      surfaceClassName="command-palette"
    >
      <TextInputControl
        ref={inputRef}
        aria-activedescendant={selectedItemId}
        aria-controls="command-palette-list"
        className="command-input"
        label="Search or create"
        value={query}
        placeholder="Search or create"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (isImeComposingEvent(event)) {
            if (event.key === 'Escape') event.stopPropagation();
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setSelectedIndex((current) => Math.min(current + 1, visibleItems.length - 1));
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setSelectedIndex((current) => Math.max(current - 1, 0));
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            selected?.action();
          }
        }}
      />
      <div className="command-list" id="command-palette-list" ref={listRef} role="listbox">
        {!trimmedQuery && <div className="command-group-heading">Navigate</div>}
        {trimmedQuery && hitItems.length > 0 && <div className="command-group-heading">Nodes</div>}
        {visibleItems.map((item, index) => {
          const Icon = item.icon;
          return (
            <MenuItem
              key={item.id}
              active={index === selectedIndex}
              aria-selected={index === selectedIndex}
              className="command-item"
              data-selected={index === selectedIndex}
              id={`command-item-${index}`}
              icon={Icon ? (
                <Icon className="command-item-icon" size={ICON_SIZE.toolbar} strokeWidth={1.5} />
              ) : (
                <span className="command-item-bullet" />
              )}
              label={item.kind === 'create' ? `Create "${item.label}"` : item.label}
              labelClassName="command-item-label"
              meta={item.typeLabel}
              metaClassName="command-item-type"
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={item.action}
              role="option"
            />
          );
        })}
      </div>
      {selected && (
        <div className="command-action-bar">
          <ButtonControl className="command-action-button" onClick={selected.action}>
            <span>{actionLabel(selected.kind)}</span>
            <span className="kbd">↵</span>
          </ButtonControl>
        </div>
      )}
    </Dialog>
  );
}
