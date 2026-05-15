import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { CommandOutcome, NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import {
  commonTagIdsForTargets,
  resolveActiveNodeSelection,
} from '../interactions/contextMenuSelection';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { isDescendantOf, isNodeInTrash } from '../interactions/nodeLocation';
import { tagSelectorItemLabel, tagSelectorItems } from '../interactions/tagSelector';
import {
  AddIcon,
  CheckboxIcon,
  CloseIcon,
  FilterIcon,
  ICON_SIZE,
  MoreIcon,
  RestoreIcon,
  SearchIcon,
  ShowIcon,
  TagIcon,
  TrashIcon,
} from '../icons';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import type { CommandRunner } from '../shared';
import { textOf } from '../shared';

interface NodeContextMenuProps {
  x: number;
  y: number;
  node: NodeProjection;
  targetId: NodeId;
  openId: NodeId;
  selectedIds: Set<NodeId>;
  index: DocumentIndex;
  run: CommandRunner;
  onRoot: (nodeId: NodeId) => void;
  onEditDescription: () => void;
  onClose: () => void;
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

export function NodeContextMenu(props: NodeContextMenuProps) {
  const [mode, setMode] = useState<'main' | 'tag' | 'move'>('main');
  const [query, setQuery] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const target = props.index.byId.get(props.targetId) ?? props.node;
  const trashed = isNodeInTrash(props.index, props.node.id);
  const activeSelection = useMemo(() => resolveActiveNodeSelection({
    nodeId: props.node.id,
    targetId: props.targetId,
    selectedIds: props.selectedIds,
    byId: props.index.byId,
  }), [props.index.byId, props.node.id, props.selectedIds, props.targetId]);
  const activeNodeIds = activeSelection.nodeIds;
  const activeTargetIds = activeSelection.targetIds;
  const activeLabelPrefix = activeSelection.labelPrefix;
  const activeExistingTagIds = useMemo(
    () => commonTagIdsForTargets(activeTargetIds, props.index.byId),
    [activeTargetIds, props.index.byId],
  );
  const tagItems = useMemo(() => tagSelectorItems({
    query,
    index: props.index,
    existingTagIds: activeExistingTagIds,
    limit: 8,
  }), [activeExistingTagIds, props.index, query]);
  const moveTargets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const activeNodeIdSet = new Set(activeNodeIds);
    return props.index.projection.nodes
      .filter((node) => !activeNodeIdSet.has(node.id))
      .filter((node) => node.type !== 'fieldEntry')
      .filter((node) => activeNodeIds.every((nodeId) => !isDescendantOf(props.index.byId, node.id, nodeId)))
      .filter((node) => node.id !== props.index.projection.trashId)
      .filter((node) => !normalized || textOf(node).toLowerCase().includes(normalized))
      .slice(0, 10);
  }, [activeNodeIds, props.index, query]);

  useEffect(() => {
    const close = (event: globalThis.MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      props.onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [props]);

  const applyExistingTag = (tagId: NodeId) => {
    void props.run(() => (
      activeTargetIds.length > 1
        ? api.batchApplyTag(activeTargetIds, tagId)
        : api.applyTag(props.targetId, tagId)
    ));
    props.onClose();
  };

  const createAndApplyTag = (name: string) => {
    void props.run(async () => {
      const created = await api.createTag(name);
      const tagId = created.focus?.nodeId;
      if (!tagId) return created;
      return activeTargetIds.length > 1
        ? api.batchApplyTag(activeTargetIds, tagId)
        : api.applyTag(props.targetId, tagId);
    });
    props.onClose();
  };

  const item = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
  ) => (
    <MenuItem
      className="node-context-item"
      icon={icon}
      label={label}
      onClick={() => {
        onClick();
        props.onClose();
      }}
      role="menuitem"
    />
  );

  const renderMain = () => (
    <>
      {item('Open', <SearchIcon size={ICON_SIZE.menu} />, () => props.onRoot(props.openId))}
      {item(`${activeLabelPrefix}Duplicate`, <AddIcon size={ICON_SIZE.menu} />, () => void props.run(() => api.batchDuplicateNodes(activeNodeIds)))}
      {item(`${activeLabelPrefix}Move up`, <MoreIcon size={ICON_SIZE.menu} />, () => void props.run(() => api.batchMoveNodesUp(activeNodeIds)))}
      {item(`${activeLabelPrefix}Move down`, <MoreIcon size={ICON_SIZE.menu} />, () => void props.run(() => api.batchMoveNodesDown(activeNodeIds)))}
      <MenuItem
        className="node-context-item"
        icon={<MoreIcon size={ICON_SIZE.menu} />}
        label="Move to"
        onClick={() => {
          setMode('move');
          setQuery('');
        }}
        role="menuitem"
      />
      <div className="node-context-separator" role="separator" />
      {item(
        `${activeLabelPrefix}${activeNodeIds.length > 1 ? 'Toggle done' : target.completedAt ? 'Mark not done' : 'Mark done'}`,
        <CheckboxIcon size={ICON_SIZE.menu} />,
        () => void props.run(() => activeTargetIds.length > 1 ? api.batchToggleDone(activeTargetIds) : api.toggleDone(props.targetId)),
      )}
      <MenuItem
        className="node-context-item"
        icon={<TagIcon size={ICON_SIZE.menu} />}
        label={`${activeLabelPrefix}Add tag`}
        onClick={() => {
          setMode('tag');
          setQuery('');
        }}
        role="menuitem"
      />
      {item(target.description ? 'Edit description' : 'Add description', <MoreIcon size={ICON_SIZE.menu} />, props.onEditDescription)}
      {item(
        target.toolbarVisible ? 'Hide view toolbar' : 'Show view toolbar',
        target.toolbarVisible ? <CloseIcon size={ICON_SIZE.menu} /> : <FilterIcon size={ICON_SIZE.menu} />,
        () => void props.run(() => api.setNodeToolbarVisible(props.targetId, !target.toolbarVisible)),
      )}
      <div className="node-context-separator" role="separator" />
      {item('Copy text', <MoreIcon size={ICON_SIZE.menu} />, () => void writeClipboardText(textOf(target)))}
      {item('Copy node id', <MoreIcon size={ICON_SIZE.menu} />, () => void writeClipboardText(props.targetId))}
      <div className="node-context-separator" role="separator" />
      {trashed
        ? item('Restore', <RestoreIcon size={ICON_SIZE.menu} />, () => void props.run(() => api.restoreNode(props.node.id)))
        : item(`${activeLabelPrefix}Trash`, <TrashIcon size={ICON_SIZE.menu} />, () => void props.run(() => activeNodeIds.length > 1 ? api.batchTrashNodes(activeNodeIds) : api.trashNode(props.node.id)))}
    </>
  );

  const renderTagMode = () => (
    <>
      <div className="node-context-subhead">
        <button type="button" onClick={() => setMode('main')}>Back</button>
        <span>Add tag</span>
      </div>
      <input
        className="node-context-search"
        value={query}
        placeholder="tag name"
        autoFocus
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (isImeComposingEvent(event)) return;
          if (event.key !== 'Enter') return;
          const first = tagItems[0];
          if (!first) return;
          event.preventDefault();
          if (first.type === 'existing') applyExistingTag(first.tag.id);
          else createAndApplyTag(first.name);
        }}
      />
      {tagItems.map((tagItem) => (
        <MenuItem
          key={tagItem.type === 'existing' ? tagItem.tag.id : `create:${tagItem.name}`}
          className="node-context-item"
          icon={<TagIcon size={ICON_SIZE.menu} />}
          label={tagSelectorItemLabel(tagItem)}
          onClick={() => {
            if (tagItem.type === 'existing') applyExistingTag(tagItem.tag.id);
            else createAndApplyTag(tagItem.name);
          }}
        />
      ))}
    </>
  );

  const renderMoveMode = () => (
    <>
      <div className="node-context-subhead">
        <button type="button" onClick={() => setMode('main')}>Back</button>
        <span>Move to</span>
      </div>
      <input
        className="node-context-search"
        value={query}
        placeholder="node name"
        autoFocus
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {moveTargets.map((targetNode) => (
        <MenuItem
          key={targetNode.id}
          className="node-context-item"
          icon={<ShowIcon size={ICON_SIZE.menu} />}
          label={textOf(targetNode)}
          onClick={() => {
            void props.run(async () => {
              let lastResult: CommandOutcome | null = null;
              for (const nodeId of activeNodeIds) {
                lastResult = await api.moveNode(nodeId, targetNode.id, null);
              }
              return lastResult ?? api.getProjection();
            });
            props.onClose();
          }}
        />
      ))}
    </>
  );

  return createPortal(
    <MenuSurface
      ref={menuRef}
      aria-label={mode === 'main' ? 'Node actions' : mode === 'tag' ? 'Add tag' : 'Move node'}
      className="node-context-menu"
      preserveSelection
      role={mode === 'main' ? 'menu' : 'dialog'}
      style={{ left: props.x, top: props.y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {mode === 'main' ? renderMain() : mode === 'tag' ? renderTagMode() : renderMoveMode()}
    </MenuSurface>,
    document.body,
  );
}
