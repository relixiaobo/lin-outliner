import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { isNodeInTrash } from '../interactions/nodeLocation';
import { CloseIcon, ICON_SIZE, SearchIcon, SettingsIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { overlayAnchorFromPoint, useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useT } from '../../i18n/I18nProvider';
import type { CommandRunner } from '../shared';
import { textOf } from '../shared';
import { AppliedTag } from './AppliedTag';
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
  const t = useT();
  const color = resolveTagColor(tag, index.byId);
  const label = textOf(tag);
  const trashed = isNodeInTrash(index, tag.id);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuAnchor = useMemo(
    () => menu ? overlayAnchorFromPoint(menu.x, menu.y) : null,
    [menu],
  );
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRect: menuAnchor,
    disabled: !menuAnchor,
    maxHeight: 320,
    placement: 'bottom-start',
    width: 220,
  });

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
      <AppliedTag
        label={label}
        color={color}
        trashed
        onOpen={openTagSearch}
        onRemove={removeTag}
      />
    );
  }

  return (
    <>
      <AppliedTag
        label={label}
        color={color}
        onOpen={openTagSearch}
        onRemove={removeTag}
        onContextMenu={openMenu}
      />
      {menu && createPortal(
        <div
          ref={menuRef}
          className="tag-context-menu"
          style={menuStyle}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <ButtonControl
            className="tag-context-item"
            onClick={() => {
              removeTag();
              setMenu(null);
            }}
          >
            <CloseIcon size={ICON_SIZE.menu} />
            {t.tags.removeTitle}
          </ButtonControl>
          <ButtonControl
            className="tag-context-item"
            onClick={() => {
              openTagSearch();
              setMenu(null);
            }}
          >
            <SearchIcon size={ICON_SIZE.menu} />
            {t.tags.everythingTagged({ label })}
          </ButtonControl>
          <div className="tag-context-separator" />
          <ButtonControl
            className="tag-context-item"
            onClick={() => {
              onRoot?.(tag.id);
              setMenu(null);
            }}
          >
            <SettingsIcon size={ICON_SIZE.menu} />
            {t.tags.configureTag}
          </ButtonControl>
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
