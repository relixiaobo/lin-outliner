import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { DocumentProjection, NodeId, SearchHit } from '../api/types';
import type { DocumentIndex } from '../state/document';
import {
  AddIcon,
  CalendarIcon,
  ICON_SIZE,
  LibraryIcon,
  SearchIcon,
  TrashIcon,
  type AppIcon,
} from './icons';
import { isImeComposingEvent } from './interactions/imeKeyboard';
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
    inputRef.current?.focus();
  }, []);

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
      id: props.projection.rootId,
      label: 'Workspace',
      icon: LibraryIcon,
      kind: 'navigate',
      typeLabel: 'Navigate',
      action: () => openNode(props.projection.rootId),
    },
    {
      id: props.projection.schemaId,
      label: 'Schema',
      icon: LibraryIcon,
      kind: 'navigate',
      typeLabel: 'Navigate',
      action: () => openNode(props.projection.schemaId),
    },
    {
      id: props.projection.searchesId,
      label: 'Searches',
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
      icon: AddIcon,
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

  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-input"
          value={query}
          placeholder="Search or create"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposingEvent(event)) return;
            if (event.key === 'Escape') props.onClose();
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
        <div className="command-list" ref={listRef}>
          {!trimmedQuery && <div className="command-group-heading">Navigate</div>}
          {trimmedQuery && hitItems.length > 0 && <div className="command-group-heading">Nodes</div>}
          {visibleItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`command-item ${index === selectedIndex ? 'active' : ''}`}
                data-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={item.action}
              >
                {Icon ? (
                  <Icon className="command-item-icon" size={ICON_SIZE.toolbar} strokeWidth={1.5} />
                ) : (
                  <span className="command-item-bullet" />
                )}
                <span className="command-item-label">{item.kind === 'create' ? `Create "${item.label}"` : item.label}</span>
                <span className="command-item-type">{item.typeLabel}</span>
              </button>
            );
          })}
        </div>
        {selected && (
          <div className="command-action-bar">
            <button className="command-action-button" onClick={selected.action}>
              <span>{actionLabel(selected.kind)}</span>
              <span className="kbd">↵</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
