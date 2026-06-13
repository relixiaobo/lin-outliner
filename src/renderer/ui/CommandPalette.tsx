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
import { Button } from './primitives/Button';
import { Dialog } from './primitives/Dialog';
import { MenuItem } from './primitives/MenuItem';
import { Input } from './primitives/Input';
import type { CommandRunner } from './shared';
import { useT } from '../i18n/I18nProvider';

interface CommandPaletteProps {
  projection: DocumentProjection;
  index: DocumentIndex;
  onClose: () => void;
  onEnsureToday: () => Promise<NodeId | null>;
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

export function CommandPalette(props: CommandPaletteProps) {
  const t = useT();
  const actionLabel = (kind: PaletteItemKind) =>
    kind === 'create' ? t.commandPalette.actionCreate : t.commandPalette.actionOpen;
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

  const openToday = () => {
    void props.onEnsureToday().then((nodeId) => {
      if (nodeId) openNode(nodeId);
    });
  };

  const createFromQuery = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    void props.onEnsureToday().then((todayId) => {
      if (!todayId) return;
      void props.run(async () => {
        const outcome = await api.createNode(todayId, null, trimmed);
        props.onClose();
        return outcome;
      });
    });
  };

  const defaultItems: PaletteItem[] = [
    {
      id: props.projection.todayId,
      label: t.commandPalette.navToday,
      icon: CalendarIcon,
      kind: 'navigate',
      typeLabel: t.commandPalette.typeNavigate,
      action: openToday,
    },
    {
      id: props.projection.libraryId,
      label: t.commandPalette.navLibrary,
      icon: LibraryIcon,
      kind: 'navigate',
      typeLabel: t.commandPalette.typeNavigate,
      action: () => openNode(props.projection.libraryId),
    },
    {
      id: props.projection.schemaId,
      label: t.commandPalette.navSchema,
      icon: SupertagIcon,
      kind: 'navigate',
      typeLabel: t.commandPalette.typeNavigate,
      action: () => openNode(props.projection.schemaId),
    },
    {
      id: props.projection.searchesId,
      label: t.commandPalette.navSavedSearches,
      icon: SearchIcon,
      kind: 'navigate',
      typeLabel: t.commandPalette.typeNavigate,
      action: () => openNode(props.projection.searchesId),
    },
    {
      id: props.projection.trashId,
      label: t.commandPalette.navTrash,
      icon: TrashIcon,
      kind: 'navigate',
      typeLabel: t.commandPalette.typeNavigate,
      action: () => openNode(props.projection.trashId),
    },
  ];
  const trimmedQuery = query.trim();
  const hitItems: PaletteItem[] = hits.map((hit) => {
    const node = props.index.byId.get(hit.nodeId);
    return {
      id: hit.nodeId,
      label: node?.content.text || t.common.untitled,
      kind: 'node',
      typeLabel: t.commandPalette.typeNode,
      action: () => openNode(hit.nodeId),
    };
  });
  const createItem: PaletteItem | null = trimmedQuery
    ? {
      id: '__create__',
      label: trimmedQuery,
      icon: AddChildIcon,
      kind: 'create',
      typeLabel: t.commandPalette.typeNewInToday,
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
      label={t.commandPalette.dialogLabel}
      onBackdropMouseDown={props.onClose}
      onEscapeKeyDown={props.onClose}
      surfaceClassName="command-palette"
    >
      <Input
        ref={inputRef}
        aria-activedescendant={selectedItemId}
        aria-controls="command-palette-list"
        className="command-input"
        label={t.commandPalette.inputLabel}
        value={query}
        variant="bare"
        placeholder={t.commandPalette.inputPlaceholder}
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
        {!trimmedQuery && <div className="command-group-heading">{t.commandPalette.headingNavigate}</div>}
        {trimmedQuery && hitItems.length > 0 && <div className="command-group-heading">{t.commandPalette.headingNodes}</div>}
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
              label={item.kind === 'create' ? t.commandPalette.createLabel({ label: item.label }) : item.label}
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
          <Button className="command-action-button" onClick={selected.action} size="sm" variant="ghost">
            <span>{actionLabel(selected.kind)}</span>
            <span className="kbd">↵</span>
          </Button>
        </div>
      )}
    </Dialog>
  );
}
