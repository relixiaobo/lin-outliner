import { useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import type { CommandResult, NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex, ToolbarDropdownSection } from '../../state/document';
import {
  commonTagIdsForTargets,
  resolveActiveNodeSelection,
  targetIdsForRows,
} from '../interactions/contextMenuSelection';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { isDescendantOf, isNodeInTrash } from '../interactions/nodeLocation';
import { tagSelectorItemLabel, tagSelectorItems } from '../interactions/tagSelector';
import { permanentDeleteCandidateIds, trashRootChildIds } from '../interactions/trashActions';
import {
  idsAllowedForDuplicate,
  idsAllowedForMoveTo,
  idsEnabledForSelectionAction,
  runSelectionDelete,
  runSelectionDuplicate,
  runSelectionMove,
} from '../interactions/selectionBatchActions';
import {
  CheckboxIcon,
  CopyIcon,
  DescriptionIcon,
  DuplicateIcon,
  FieldIcon,
  FilterIcon,
  GroupIcon,
  HideToolbarIcon,
  ICON_SIZE,
  MoveDownIcon,
  MoveToIcon,
  MoveUpIcon,
  OpenIcon,
  PinIcon,
  RestoreIcon,
  ShowToolbarIcon,
  SortAscIcon,
  SupertagIcon,
  TrashIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { Input } from '../primitives/Input';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { overlayAnchorFromPoint, useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
import type { CommandRunner, NavigateRootOptions } from '../shared';
import { textOf } from '../shared';
import { resolveTagColor } from '../tags/tagColors';
import { readViewConfig } from './row-model';
import { useT } from '../../i18n/I18nProvider';

interface NodeContextMenuProps {
  x: number;
  y: number;
  node: NodeProjection;
  targetId: NodeId;
  visualRowId: NodeId;
  viewToolbarVisibleInRow: boolean;
  openId: NodeId;
  selectedIds: Set<NodeId>;
  index: DocumentIndex;
  isPinned: boolean;
  run: CommandRunner;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  onTogglePin: (nodeId: NodeId) => void;
  onEditDescription: () => void;
  onRevealViewToolbar: (visualRowId: NodeId, nodeId: NodeId) => void;
  onOpenViewSection: (nodeId: NodeId, section: ToolbarDropdownSection) => void;
  onClose: () => void;
}

type PendingDeleteConfirmation =
  | {
    kind: 'deleteForever';
    nodeIds: NodeId[];
    title: string;
    message: string;
    confirmLabel: string;
  };

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
  const t = useT();
  const tc = t.outliner.contextMenu;
  const [mode, setMode] = useState<'main' | 'tag' | 'move'>('main');
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteConfirmation | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuAnchor = useMemo(() => overlayAnchorFromPoint(props.x, props.y), [props.x, props.y]);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRect: menuAnchor,
    layoutKey: `${mode}:${query.length}`,
    maxHeight: 440,
    placement: 'bottom-start',
    width: mode === 'main' ? 240 : 280,
  });
  const target = props.index.byId.get(props.targetId) ?? props.node;
  const pinned = props.isPinned;
  const view = readViewConfig(target, props.index.byId);
  const viewToolbarVisibleInRow = view.toolbarVisible && props.viewToolbarVisibleInRow;
  const trashId = props.index.projection.trashId;
  const isTrashRoot = props.node.id === trashId;
  const trashed = !isTrashRoot && isNodeInTrash(props.index, props.node.id);
  const trashChildIds = useMemo(() => trashRootChildIds(props.index), [props.index]);
  const emptyTrashDeleteIds = useMemo(
    () => permanentDeleteCandidateIds({ ids: trashChildIds, index: props.index }),
    [props.index, trashChildIds],
  );
  const activeSelection = useMemo(() => resolveActiveNodeSelection({
    nodeId: props.node.id,
    targetId: props.targetId,
    selectedIds: props.selectedIds,
    byId: props.index.byId,
  }), [props.index.byId, props.node.id, props.selectedIds, props.targetId]);
  const activeNodeIds = activeSelection.nodeIds;
  const actionPanelRootId = activeNodeIds[0] ?? props.node.parentId ?? props.node.id;
  const activeTargetRowIds = useMemo(
    () => idsEnabledForSelectionAction({
      ids: activeNodeIds,
      action: 'tag',
      panelRootId: actionPanelRootId,
      byId: props.index.byId,
    }),
    [actionPanelRootId, activeNodeIds, props.index.byId],
  );
  const activeCheckboxRowIds = useMemo(
    () => idsEnabledForSelectionAction({
      ids: activeNodeIds,
      action: 'checkbox',
      panelRootId: actionPanelRootId,
      byId: props.index.byId,
    }),
    [actionPanelRootId, activeNodeIds, props.index.byId],
  );
  const activeDeleteIds = useMemo(
    () => idsEnabledForSelectionAction({
      ids: activeNodeIds,
      action: 'delete',
      panelRootId: actionPanelRootId,
      byId: props.index.byId,
    }),
    [actionPanelRootId, activeNodeIds, props.index.byId],
  );
  const activePermanentDeleteIds = useMemo(
    () => permanentDeleteCandidateIds({ ids: activeNodeIds, index: props.index }),
    [activeNodeIds, props.index],
  );
  const activeDuplicateIds = useMemo(
    () => idsAllowedForDuplicate({
      ids: activeNodeIds,
      panelRootId: actionPanelRootId,
      byId: props.index.byId,
    }),
    [actionPanelRootId, activeNodeIds, props.index.byId],
  );
  const activeMoveIds = useMemo(
    () => idsEnabledForSelectionAction({
      ids: activeNodeIds,
      action: 'move',
      panelRootId: actionPanelRootId,
      byId: props.index.byId,
    }),
    [actionPanelRootId, activeNodeIds, props.index.byId],
  );
  const activeMoveToIds = useMemo(
    () => idsAllowedForMoveTo({
      ids: activeNodeIds,
      panelRootId: actionPanelRootId,
      byId: props.index.byId,
    }),
    [actionPanelRootId, activeNodeIds, props.index.byId],
  );
  const activeTargetIds = useMemo(
    () => activeSelection.isBatch
      ? targetIdsForRows(activeTargetRowIds, props.index.byId)
      : activeTargetRowIds.length > 0 ? [props.targetId] : [],
    [activeSelection.isBatch, activeTargetRowIds, props.index.byId, props.targetId],
  );
  const activeCheckboxTargetIds = useMemo(
    () => activeSelection.isBatch
      ? targetIdsForRows(activeCheckboxRowIds, props.index.byId)
      : activeCheckboxRowIds.length > 0 ? [props.targetId] : [],
    [activeCheckboxRowIds, activeSelection.isBatch, props.index.byId, props.targetId],
  );
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
    const activeNodeIdSet = new Set(activeMoveToIds);
    return props.index.projection.nodes
      .filter((node) => !activeNodeIdSet.has(node.id))
      .filter((node) => node.type !== 'fieldEntry')
      .filter((node) => activeMoveToIds.every((nodeId) => !isDescendantOf(props.index.byId, node.id, nodeId)))
      .filter((node) => node.id !== props.index.projection.trashId)
      .filter((node) => !normalized || textOf(node, t.common.untitled).toLowerCase().includes(normalized))
      .slice(0, 10);
  }, [activeMoveToIds, props.index, query, t.common.untitled]);

  // Outside-pointer dismissal only — Escape is owned by `useMenuKeyboard` (below),
  // which scopes it to the focused surface and keeps the in-menu keyboard model.
  useDismissibleOverlay(menuRef, props.onClose, { disabled: pendingDelete !== null, escape: false });
  // `main` is a true menu (roving Arrow/Home/End); the tag / move submodes are
  // heterogeneous search popovers (focus-trap). The menu carries
  // `data-preserve-selection`, so focusing an item never trips the
  // selection-clearing path and the workspace keyboard handler stays out of the way.
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: props.onClose,
    kind: mode === 'main' ? 'menu' : 'dialog',
    // Switching submode swaps the body in place; without this, returning to `main`
    // (the Back button unmounts) drops focus to the body and kills Escape/roving.
    focusKey: mode,
  });

  const applyExistingTag = (tagId: NodeId) => {
    if (activeTargetIds.length === 0) return;
    void props.run(() => (
      activeTargetIds.length > 1
        ? api.batchApplyTag(activeTargetIds, tagId)
        : api.applyTag(activeTargetIds[0]!, tagId)
    ));
    props.onClose();
  };

  const createAndApplyTag = (name: string) => {
    if (activeTargetIds.length === 0) return;
    void props.run(async () => {
      const created = await api.createTag(name);
      const tagId = created.focus?.nodeId;
      if (!tagId) return created;
      return activeTargetIds.length > 1
        ? api.batchApplyTag(activeTargetIds, tagId)
        : api.applyTag(activeTargetIds[0]!, tagId);
    });
    props.onClose();
  };

  const openViewSection = (section: ToolbarDropdownSection) => {
    void props.run(() => api.setViewToolbarVisible(props.targetId, true)).then(() => {
      props.onRevealViewToolbar(props.visualRowId, props.targetId);
      props.onOpenViewSection(props.targetId, section);
    });
  };

  const confirmDeleteForever = (nodeIds: NodeId[]) => {
    if (nodeIds.length === 0) return;
    setPendingDelete({
      kind: 'deleteForever',
      nodeIds,
      title: nodeIds.length > 1 ? tc.deleteForeverTitleMultiple({ count: nodeIds.length }) : tc.deleteForeverTitle,
      message: nodeIds.length > 1 ? tc.deleteForeverMessageMultiple : tc.deleteForeverMessage,
      confirmLabel: tc.deleteForeverConfirm,
    });
  };

  const confirmEmptyTrash = () => {
    if (emptyTrashDeleteIds.length === 0) return;
    setPendingDelete({
      kind: 'deleteForever',
      nodeIds: emptyTrashDeleteIds,
      title: tc.emptyTrashTitle,
      message: tc.emptyTrashMessage,
      confirmLabel: tc.emptyTrashConfirm,
    });
  };

  const runPendingDelete = async () => {
    const pending = pendingDelete;
    if (!pending) return;
    setPendingDelete(null);
    props.onClose();
    for (const nodeId of pending.nodeIds) {
      const result = await props.run(() => api.deleteNode(nodeId), { applyFocus: false });
      if (!result) break;
    }
  };

  const item = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    disabled = false,
    options: { danger?: boolean; close?: boolean } = {},
  ) => (
    <MenuItem
      className={`node-context-item ${options.danger ? 'is-danger' : ''}`}
      disabled={disabled}
      icon={icon}
      label={label}
      onClick={() => {
        if (disabled) return;
        onClick();
        if (options.close !== false) props.onClose();
      }}
      role="menuitem"
    />
  );

  const renderMain = () => (
    <>
      {item(tc.openInSplitPane, <OpenIcon size={ICON_SIZE.menu} />, () => props.onRoot(props.openId, { newPane: true }))}
      {item(pinned ? tc.unpinNode : tc.pinNode, <PinIcon size={ICON_SIZE.menu} />, () => props.onTogglePin(props.openId))}
      {item(tc.duplicate({ prefix: activeLabelPrefix }), <DuplicateIcon size={ICON_SIZE.menu} />, () => void props.run(() => runSelectionDuplicate({
        ids: activeDuplicateIds,
        panelRootId: actionPanelRootId,
        byId: props.index.byId,
      })), activeDuplicateIds.length === 0)}
      {item(tc.moveUp({ prefix: activeLabelPrefix }), <MoveUpIcon size={ICON_SIZE.menu} />, () => void props.run(() => runSelectionMove({
        ids: activeMoveIds,
        direction: 'up',
        panelRootId: actionPanelRootId,
        byId: props.index.byId,
      })), activeMoveIds.length === 0)}
      {item(tc.moveDown({ prefix: activeLabelPrefix }), <MoveDownIcon size={ICON_SIZE.menu} />, () => void props.run(() => runSelectionMove({
        ids: activeMoveIds,
        direction: 'down',
        panelRootId: actionPanelRootId,
        byId: props.index.byId,
      })), activeMoveIds.length === 0)}
      <MenuItem
        className="node-context-item"
        disabled={activeMoveToIds.length === 0}
        icon={<MoveToIcon size={ICON_SIZE.menu} />}
        label={tc.moveTo}
        onClick={() => {
          if (activeMoveToIds.length === 0) return;
          setMode('move');
          setQuery('');
        }}
        role="menuitem"
      />
      <div className="node-context-separator" role="separator" />
      {item(
        activeNodeIds.length > 1
          ? tc.toggleDone({ prefix: activeLabelPrefix })
          : target.completedAt
            ? tc.markNotDonePrefixed({ prefix: activeLabelPrefix })
            : tc.markDonePrefixed({ prefix: activeLabelPrefix }),
        <CheckboxIcon size={ICON_SIZE.menu} />,
        () => void props.run(() => activeCheckboxTargetIds.length > 1
          ? api.batchToggleDone(activeCheckboxTargetIds)
          : api.toggleDone(activeCheckboxTargetIds[0]!)),
        activeCheckboxTargetIds.length === 0,
      )}
      <MenuItem
        className="node-context-item"
        disabled={activeTargetIds.length === 0}
        icon={<SupertagIcon size={ICON_SIZE.menu} />}
        label={tc.addTag({ prefix: activeLabelPrefix })}
        onClick={() => {
          if (activeTargetIds.length === 0) return;
          setMode('tag');
          setQuery('');
        }}
        role="menuitem"
      />
      <div className="node-context-separator" role="separator" />
      {item(
        viewToolbarVisibleInRow ? tc.hideViewToolbar : tc.showViewToolbar,
        viewToolbarVisibleInRow ? <HideToolbarIcon size={ICON_SIZE.menu} /> : <ShowToolbarIcon size={ICON_SIZE.menu} />,
        () => void props.run(() => api.setViewToolbarVisible(props.targetId, !viewToolbarVisibleInRow)).then(() => {
          if (!viewToolbarVisibleInRow) props.onRevealViewToolbar(props.visualRowId, props.targetId);
          props.onClose();
        }),
      )}
      {item(tc.filterBy, <FilterIcon size={ICON_SIZE.menu} />, () => openViewSection('filter'))}
      {item(tc.sortBy, <SortAscIcon size={ICON_SIZE.menu} />, () => openViewSection('sort'))}
      {item(tc.groupBy, <GroupIcon size={ICON_SIZE.menu} />, () => openViewSection('group'))}
      {item(tc.display, <FieldIcon size={ICON_SIZE.menu} />, () => openViewSection('display'))}
      <div className="node-context-separator" role="separator" />
      {item(target.description ? tc.editDescription : tc.addDescription, <DescriptionIcon size={ICON_SIZE.menu} />, props.onEditDescription)}
      <div className="node-context-separator" role="separator" />
      {item(tc.copyText, <CopyIcon size={ICON_SIZE.menu} />, () => void writeClipboardText(textOf(target, t.common.untitled)))}
      {item(tc.copyNodeId, <CopyIcon size={ICON_SIZE.menu} />, () => void writeClipboardText(props.targetId))}
      <div className="node-context-separator" role="separator" />
      {isTrashRoot
        ? item(tc.emptyTrash, <TrashIcon size={ICON_SIZE.menu} />, confirmEmptyTrash, emptyTrashDeleteIds.length === 0, { close: false, danger: true })
        : trashed
          ? (
            <>
              {item(tc.restore, <RestoreIcon size={ICON_SIZE.menu} />, () => void props.run(() => api.restoreNode(props.node.id)))}
              {item(
                tc.deleteForever({ prefix: activeLabelPrefix }),
                <TrashIcon size={ICON_SIZE.menu} />,
                () => confirmDeleteForever(activePermanentDeleteIds),
                activePermanentDeleteIds.length === 0,
                { close: false, danger: true },
              )}
            </>
          )
        : item(tc.trash({ prefix: activeLabelPrefix }), <TrashIcon size={ICON_SIZE.menu} />, () => void props.run(() => runSelectionDelete({
          ids: activeDeleteIds,
          panelRootId: actionPanelRootId,
          byId: props.index.byId,
        })), activeDeleteIds.length === 0)}
    </>
  );

  const renderTagMode = () => (
    <>
      <div className="node-context-subhead">
        <Button onClick={() => setMode('main')} size="sm" variant="ghost">{tc.back}</Button>
        <span>{tc.addTagTitle}</span>
      </div>
      <Input
        className="node-context-search"
        label={tc.tagNameLabel}
        value={query}
        placeholder={tc.tagNamePlaceholder}
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
          icon={tagItem.type === 'existing'
            ? (
              <span
                className="tag-selector-hash"
                style={{ color: resolveTagColor(tagItem.tag, props.index.byId).text }}
                aria-hidden="true"
              >
                #
              </span>
            )
            : <SupertagIcon size={ICON_SIZE.menu} />}
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
        <Button onClick={() => setMode('main')} size="sm" variant="ghost">{tc.back}</Button>
        <span>{tc.moveTo}</span>
      </div>
      <Input
        className="node-context-search"
        label={tc.nodeNameLabel}
        value={query}
        placeholder={tc.nodeNamePlaceholder}
        autoFocus
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {moveTargets.map((targetNode) => (
        <MenuItem
          key={targetNode.id}
          className="node-context-item"
          icon={<MoveToIcon size={ICON_SIZE.menu} />}
          label={textOf(targetNode) || t.common.untitled}
          onClick={() => {
            void props.run(async () => {
              let lastResult: CommandResult | null = null;
              for (const nodeId of activeMoveToIds) {
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

  const modeLabel = mode === 'main' ? tc.nodeActions
    : mode === 'tag' ? tc.addTagTitle
      : tc.moveNode;

  return createPortal(
    <>
      <MenuSurface
        ref={menuRef}
        aria-label={modeLabel}
        className="node-context-menu"
        preserveSelection
        role={mode === 'main' ? 'menu' : 'dialog'}
        style={menuStyle}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {mode === 'main'
          ? renderMain()
          : mode === 'tag'
            ? renderTagMode()
            : renderMoveMode()}
      </MenuSurface>
      {pendingDelete ? (
        <ConfirmDialog
          danger
          title={pendingDelete.title}
          message={pendingDelete.message}
          confirmLabel={pendingDelete.confirmLabel}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void runPendingDelete()}
        />
      ) : null}
    </>,
    document.body,
  );
}
