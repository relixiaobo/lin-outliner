import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { isNodeInTrash } from '../interactions/nodeLocation';
import {
  CloseIcon,
  ICON_SIZE,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
  WarningIcon,
} from '../icons';
import type { CommandRunner } from '../shared';
import { textOf } from '../shared';
import { resolveTagColor } from './tagColors';

interface TagBarProps {
  nodeId: NodeId;
  tagIds: readonly NodeId[];
  index: DocumentIndex;
  run: CommandRunner;
  onRoot?: (nodeId: NodeId) => void;
}

interface TagBadgeProps {
  nodeId: NodeId;
  tag: NodeProjection;
  index: DocumentIndex;
  run: CommandRunner;
  onRoot?: (nodeId: NodeId) => void;
}

function TagBadge({ nodeId, tag, index, run, onRoot }: TagBadgeProps) {
  const color = resolveTagColor(tag);
  const label = textOf(tag);
  const trashed = isNodeInTrash(index, tag.id);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (event: globalThis.MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu]);

  const removeTag = () => {
    void run(() => api.removeTag(nodeId, tag.id));
  };

  const openTagSearch = () => {
    void run(() => api.ensureTagSearch(tag.id)).then((outcome) => {
      if (outcome && 'focus' in outcome && outcome.focus?.nodeId) {
        onRoot?.(outcome.focus.nodeId);
      }
    });
  };

  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  };

  if (trashed) {
    return (
      <span className="tag-badge trashed" title={`Tag "${label}" has been deleted`}>
        <span className="tag-badge-hash">#</span>
        <span className="tag-badge-label">{label}</span>
        <WarningIcon size={ICON_SIZE.tiny + 1} />
        <TrashIcon size={ICON_SIZE.tiny + 1} />
      </span>
    );
  }

  return (
    <>
      <span
        className="tag-badge"
        style={{ color: color.text }}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onContextMenu={openMenu}
      >
        <button
          className="tag-badge-remove"
          title="Remove tag"
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            removeTag();
          }}
        >
          <span className="tag-badge-hash">#</span>
          <CloseIcon className="tag-badge-x" size={ICON_SIZE.tiny + 1} strokeWidth={2.5} />
        </button>
        <button
          className="tag-badge-label clickable"
          title={label}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openTagSearch();
          }}
        >
          {label}
        </button>
      </span>
      {menu && createPortal(
        <div
          ref={menuRef}
          className="tag-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            className="tag-context-item"
            type="button"
            onClick={() => {
              removeTag();
              setMenu(null);
            }}
          >
            <CloseIcon size={ICON_SIZE.menu} />
            Remove tag
          </button>
          <button
            className="tag-context-item"
            type="button"
            onClick={() => {
              openTagSearch();
              setMenu(null);
            }}
          >
            <SearchIcon size={ICON_SIZE.menu} />
            Everything tagged #{label}
          </button>
          <div className="tag-context-separator" />
          <button
            className="tag-context-item"
            type="button"
            onClick={() => {
              onRoot?.(tag.id);
              setMenu(null);
            }}
          >
            <SettingsIcon size={ICON_SIZE.menu} />
            Configure tag
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

export function TagBar({ nodeId, tagIds, index, run, onRoot }: TagBarProps) {
  const tags = tagIds
    .map((tagId) => index.byId.get(tagId))
    .filter((tag): tag is NodeProjection => Boolean(tag));

  if (tags.length === 0) return null;

  return (
    <span className="tag-bar" onClick={(event) => event.stopPropagation()}>
      {tags.map((tag) => (
        <TagBadge
          key={tag.id}
          nodeId={nodeId}
          tag={tag}
          index={index}
          run={run}
          onRoot={onRoot}
        />
      ))}
    </span>
  );
}
