import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { formatHotkey } from '../../core/launcher/commands';
import type { DocumentProjection, NodeId, NodeProjection } from '../api/types';
import { resolveReferenceTargetId, type DocumentIndex } from '../state/document';
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ICON_SIZE,
  LibraryIcon,
  OpenIcon,
  PinIcon,
  RecentsIcon,
  SearchIcon,
  SettingsIcon,
  SupertagIcon,
} from './icons';
import { ButtonControl } from './primitives/ButtonControl';
import { MenuItem } from './primitives/MenuItem';
import { MenuSurface } from './primitives/MenuSurface';
import { ResizeHandle } from './primitives/ResizeHandle';
import { overlayAnchorFromPoint, useAnchoredOverlay } from './primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from './primitives/useDismissibleOverlay';
import { useMenuKeyboard } from './primitives/useMenuKeyboard';
import { textOf } from './shared';
import type { NavigateRootOptions } from './shared';
import { useT } from '../i18n/I18nProvider';
import { OUTLINER_NODE_DRAG_MIME, PINNED_NODE_REORDER_MIME } from './interactions/dragDrop';
import { MAX_OUTLINE_INDENT_DEPTH } from './workspaceResponsiveLayout';

const primaryNavItems = [
  { key: 'today', icon: CalendarIcon },
  { key: 'library', icon: LibraryIcon },
  { key: 'recents', icon: RecentsIcon },
  { key: 'schema', icon: SupertagIcon },
] as const;

interface SidebarProps {
  expandedIds: Set<NodeId>;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  onNavigateToday: (options?: NavigateRootOptions) => void;
  onNavigateRoot: (nodeId: NodeId) => void;
  onOpenPanel: (nodeId: NodeId) => void;
  /** Opens the command surface — the mouse-reachable entry point to search. */
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeReset: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onToggleTreeNode: (nodeId: NodeId) => void;
  onTogglePin: (nodeId: NodeId) => void;
  onReorderPin: (nodeId: NodeId, index: number) => void;
  pinnedNodeIds: NodeId[];
  projection: DocumentProjection;
  rootId: NodeId | null;
}

interface SidebarTreeLabels {
  collapseNode: (params: { label: string }) => string;
  expandNode: (params: { label: string }) => string;
  missingReference: string;
  untitled: string;
}

interface WorkspaceTreeBranchProps {
  depth: number;
  expandedIds: Set<NodeId>;
  index: DocumentIndex;
  labels: SidebarTreeLabels;
  nodeId: NodeId;
  onContextMenu: (state: SidebarContextMenuState) => void;
  onNavigateRoot: (nodeId: NodeId) => void;
  onOpenPanel: (nodeId: NodeId) => void;
  onToggleTreeNode: (nodeId: NodeId) => void;
  parentPath: readonly NodeId[];
  rootId: NodeId | null;
  trashId: NodeId;
}

const WorkspaceTreeBranch = memo(function WorkspaceTreeBranch({
  depth,
  expandedIds,
  index,
  labels,
  nodeId,
  onContextMenu,
  onNavigateRoot,
  onOpenPanel,
  onToggleTreeNode,
  parentPath,
  rootId,
  trashId,
}: WorkspaceTreeBranchProps) {
  const node = index.byId.get(nodeId);
  if (!node) return null;
  const presentation = sidebarNodePresentation(node, index.byId, labels);
  const childParent = presentation.childParent;
  const childParentId = childParent.id;
  const referenceCycle = parentPath.includes(childParentId);
  const children = referenceCycle ? [] : sidebarChildren(childParent, index.byId);
  const hasChildren = children.length > 0;
  const expanded = expandedIds.has(node.id);
  const active = rootId === node.id || rootId === presentation.navigateId;
  const label = presentation.label;
  const childPath = referenceCycle ? parentPath : [...parentPath, childParentId];
  const trashed = presentation.navigateId !== trashId
    && index.trashNodeIds.has(presentation.navigateId);

  return (
    <div className="workspace-tree-branch">
      <div
        className={[
          'workspace-tree-row',
          active ? 'active' : '',
          trashed ? 'trashed' : '',
        ].filter(Boolean).join(' ')}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu({
            x: event.clientX,
            y: event.clientY,
            nodeId: presentation.navigateId,
            label,
          });
        }}
        style={{ '--tree-depth': Math.min(depth, MAX_OUTLINE_INDENT_DEPTH) } as CSSProperties}
      >
        <ButtonControl
          aria-label={expanded ? labels.collapseNode({ label }) : labels.expandNode({ label })}
          className="workspace-tree-chevron-button"
          disabled={!hasChildren}
          onClick={() => onToggleTreeNode(node.id)}
        >
          {hasChildren && (
            expanded
              ? <ChevronDownIcon size={ICON_SIZE.menu} strokeWidth={2} />
              : <ChevronRightIcon size={ICON_SIZE.menu} strokeWidth={2} />
          )}
        </ButtonControl>
        <ButtonControl
          className="workspace-tree-label"
          onClick={(event) => {
            if (event.altKey) onOpenPanel(presentation.navigateId);
            else onNavigateRoot(presentation.navigateId);
          }}
        >
          <span className="workspace-tree-label-text">{label}</span>
        </ButtonControl>
      </div>
      {hasChildren && expanded && (
        <div className="workspace-tree-children">
          {children.map((child) => (
            <WorkspaceTreeBranch
              key={child.id}
              depth={depth + 1}
              expandedIds={expandedIds}
              index={index}
              labels={labels}
              nodeId={child.id}
              onContextMenu={onContextMenu}
              onNavigateRoot={onNavigateRoot}
              onOpenPanel={onOpenPanel}
              onToggleTreeNode={onToggleTreeNode}
              parentPath={childPath}
              rootId={rootId}
              trashId={trashId}
            />
          ))}
        </div>
      )}
    </div>
  );
}, sameWorkspaceTreeBranchProps);

function sameWorkspaceTreeBranchProps(
  previous: WorkspaceTreeBranchProps,
  next: WorkspaceTreeBranchProps,
): boolean {
  if (
    previous.nodeId !== next.nodeId
    || previous.depth !== next.depth
    || previous.expandedIds !== next.expandedIds
    || previous.labels !== next.labels
    || previous.onContextMenu !== next.onContextMenu
    || previous.onNavigateRoot !== next.onNavigateRoot
    || previous.onOpenPanel !== next.onOpenPanel
    || previous.onToggleTreeNode !== next.onToggleTreeNode
    || previous.rootId !== next.rootId
    || previous.trashId !== next.trashId
    || previous.index.semanticRevisions.trashMembership
      !== next.index.semanticRevisions.trashMembership
    || !sameNodeIds(previous.parentPath, next.parentPath)
  ) return false;
  if (previous.index === next.index) return true;
  const previousRevision = previous.index.renderRev?.get(previous.nodeId);
  const nextRevision = next.index.renderRev?.get(next.nodeId);
  return previousRevision !== undefined
    && nextRevision !== undefined
    && previousRevision === nextRevision;
}

function sameNodeIds(left: readonly NodeId[], right: readonly NodeId[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function Sidebar(props: SidebarProps) {
  const t = useT();
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  // Pinned-list drop state. `pinDragOver` lights the empty-state dropzone; `pinDropIndex`
  // is the insertion position (0..length) shown as a line between pinned rows. A drag is
  // accepted if it carries an outliner node (adds a pin) OR a pinned node (reorder).
  const [pinDragOver, setPinDragOver] = useState(false);
  const [pinDropIndex, setPinDropIndex] = useState<number | null>(null);

  const pinDragTypes = (event: ReactDragEvent<HTMLElement>) => (
    event.dataTransfer.types.includes(OUTLINER_NODE_DRAG_MIME)
    || event.dataTransfer.types.includes(PINNED_NODE_REORDER_MIME)
  );
  const pinDragNodeId = (event: ReactDragEvent<HTMLElement>) => (
    event.dataTransfer.getData(PINNED_NODE_REORDER_MIME)
    || event.dataTransfer.getData(OUTLINER_NODE_DRAG_MIME)
  );

  // Section-level dragover: the fallback when the cursor is over the section but not a
  // specific pinned row (empty list, or the gap below the last row → append).
  const handlePinDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!pinDragTypes(event)) return;
    event.preventDefault();
    // The drags set effectAllowed='move'; the browser only fires `drop` when dropEffect
    // is compatible, so this must stay 'move' (a 'copy' here silently cancels the drop).
    event.dataTransfer.dropEffect = 'move';
    if (!pinDragOver) setPinDragOver(true);
    if (props.pinnedNodeIds.length > 0) setPinDropIndex(props.pinnedNodeIds.length);
  };
  // Row-level dragover: before/after the hovered row by its vertical midpoint.
  const handlePinRowDragOver = (event: ReactDragEvent<HTMLDivElement>, index: number) => {
    if (!pinDragTypes(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY - rect.top > rect.height / 2;
    setPinDragOver(true);
    setPinDropIndex(after ? index + 1 : index);
  };
  const handlePinReorderDragStart = (event: ReactDragEvent<HTMLDivElement>, nodeId: NodeId) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PINNED_NODE_REORDER_MIME, nodeId);
    event.dataTransfer.setData('text/plain', '');
  };
  const resetPinDrag = () => {
    setPinDragOver(false);
    setPinDropIndex(null);
  };
  const handlePinDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    resetPinDrag();
  };
  const handlePinDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    const nodeId = pinDragNodeId(event);
    const index = pinDropIndex ?? props.pinnedNodeIds.length;
    resetPinDrag();
    if (!nodeId) return;
    event.preventDefault();
    props.onReorderPin(nodeId, index);
  };
  const navTargets = {
    today: props.projection.todayId,
    library: props.projection.libraryId,
    recents: props.projection.recentsId,
    schema: props.projection.schemaId,
  } satisfies Record<typeof primaryNavItems[number]['key'], NodeId | null>;
  const rootNode = props.index.byId.get(props.projection.rootId);
  const rootChildren = rootNode?.children
    .map((childId) => props.index.byId.get(childId))
    .filter((child): child is NodeProjection => (
      Boolean(child && child.parentId === rootNode.id)
    )) ?? [];
  const rootLabel = rootNode ? textOf(rootNode) || t.common.untitled : '';
  const rootActive = rootNode ? props.rootId === rootNode.id : false;
  const treeLabels = useMemo<SidebarTreeLabels>(() => ({
    collapseNode: t.shell.sidebar.collapseNode,
    expandNode: t.shell.sidebar.expandNode,
    missingReference: t.shell.sidebar.missingReference,
    untitled: t.common.untitled,
  }), [
    t.common.untitled,
    t.shell.sidebar.collapseNode,
    t.shell.sidebar.expandNode,
    t.shell.sidebar.missingReference,
  ]);
  // The hint re-derives from the accelerator the SUMMON hotkey actually
  // registered under — resolved in main, since it may have fallen back — rather
  // than a renderer binding that no longer exists.
  const searchShortcutHint = useLauncherHotkeyHint();

  return (
    <aside className="sidebar-dock" aria-label={t.shell.sidebar.ariaLabel}>
      {/* Top spacer keeps the rail's first row clear of the traffic lights +
          sidebar toggle (window chrome on the shared centreline). It is NOT a drag
          region: a drag region here would underlap the chrome toggle from a
          different DOM subtree and the OS would swallow the toggle's click (see
          sidebar.css). Dragging is owned by the chrome zones + breadcrumb. */}
      <div className="rail-top" aria-hidden="true" />
      <div className="sidebar-scroll">
        <nav className="sidebar-primary-nav">
        {/* Search leads the group (the universal entry point), but it is an
            ACTION, not a nav target — so it is its own row rather than a
            pseudo-entry forced into the navTargets record below. The hint is
            derived from the shortcut registry so a rebind carries through; it is
            aria-hidden, leaving the row's accessible name just "Search". */}
        <ButtonControl
          className="sidebar-nav-item"
          onClick={props.onOpenSearch}
        >
          <SearchIcon className="sidebar-nav-icon" size={ICON_SIZE.toolbar} strokeWidth={1.8} />
          <span>{t.shell.sidebar.search}</span>
          {searchShortcutHint ? (
            <span aria-hidden="true" className="sidebar-nav-hint">{searchShortcutHint}</span>
          ) : null}
        </ButtonControl>
        {primaryNavItems.map((item) => {
          const target = navTargets[item.key];
          const active = target === props.rootId;
          const NavIcon = item.icon;
          return (
            <ButtonControl
              className={`sidebar-nav-item ${active ? 'active' : ''}`}
              disabled={!target}
              key={item.key}
              onClick={(event) => {
                if (!target) return;
                if (item.key === 'today') {
                  props.onNavigateToday({ newPane: event.altKey });
                  return;
                }
                if (event.altKey) props.onOpenPanel(target);
                else props.onNavigateRoot(target);
              }}
            >
              <NavIcon className="sidebar-nav-icon" size={ICON_SIZE.toolbar} strokeWidth={1.8} />
              <span>{t.shell.sidebar.primaryNav[item.key]}</span>
            </ButtonControl>
          );
        })}
      </nav>

      <div
        className={`sidebar-section ${pinDragOver ? 'pin-dragover' : ''}`}
        onDragOver={handlePinDragOver}
        onDragLeave={handlePinDragLeave}
        onDrop={handlePinDrop}
      >
        <div className="sidebar-section-title">{t.shell.sidebar.pinnedSection}</div>
        {props.pinnedNodeIds.length === 0 ? (
          <div className="sidebar-pin-dropzone">
            <PinIcon className="sidebar-empty-icon" size={ICON_SIZE.menu} strokeWidth={1.7} />
            <span>{t.shell.sidebar.noPinnedHint}</span>
          </div>
        ) : (
          <div className="workspace-tree" aria-label={t.shell.sidebar.pinnedNodesAriaLabel}>
            {props.pinnedNodeIds.map((nodeId, index) => (
              <div
                key={nodeId}
                className={[
                  'pinned-branch',
                  // Each inter-row boundary is drawn once, by the row BELOW it
                  // (drop-before); the trailing append position is drawn by the last
                  // row's drop-after — so a shared boundary never doubles up.
                  pinDropIndex === index ? 'drop-before' : '',
                  pinDropIndex === index + 1 && index === props.pinnedNodeIds.length - 1 ? 'drop-after' : '',
                ].filter(Boolean).join(' ')}
                draggable
                onDragStart={(event) => handlePinReorderDragStart(event, nodeId)}
                onDragOver={(event) => handlePinRowDragOver(event, index)}
                onDragEnd={resetPinDrag}
              >
                <WorkspaceTreeBranch
                  depth={0}
                  expandedIds={props.expandedIds}
                  index={props.index}
                  labels={treeLabels}
                  nodeId={nodeId}
                  onContextMenu={setContextMenu}
                  onNavigateRoot={props.onNavigateRoot}
                  onOpenPanel={props.onOpenPanel}
                  onToggleTreeNode={props.onToggleTreeNode}
                  parentPath={[]}
                  rootId={props.rootId}
                  trashId={props.projection.trashId}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {rootNode && (
        <div className="sidebar-section sidebar-root-section">
          <div
            className="sidebar-root-row"
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                nodeId: rootNode.id,
                label: rootLabel,
              });
            }}
          >
            <ButtonControl
              aria-label={t.shell.sidebar.openRoot({ rootLabel })}
              className={`sidebar-root-button ${rootActive ? 'active' : ''}`}
              onClick={(event) => {
                if (event.altKey) props.onOpenPanel(rootNode.id);
                else props.onNavigateRoot(rootNode.id);
              }}
            >
              <span className="sidebar-root-avatar" aria-hidden="true">
                {rootAvatar(rootNode, rootLabel)}
              </span>
              <span className="sidebar-root-label">{rootLabel}</span>
            </ButtonControl>
          </div>
          <div className="workspace-tree" aria-label={t.shell.sidebar.workspaceRootTreeAriaLabel}>
            {rootChildren.map((child) => (
              <WorkspaceTreeBranch
                key={child.id}
                depth={0}
                expandedIds={props.expandedIds}
                index={props.index}
                labels={treeLabels}
                nodeId={child.id}
                onContextMenu={setContextMenu}
                onNavigateRoot={props.onNavigateRoot}
                onOpenPanel={props.onOpenPanel}
                onToggleTreeNode={props.onToggleTreeNode}
                parentPath={[props.projection.rootId]}
                rootId={props.rootId}
                trashId={props.projection.trashId}
              />
            ))}
          </div>
        </div>
      )}
      </div>
      <div className="sidebar-bottom">
        <ButtonControl
          className="sidebar-bottom-item"
          onClick={props.onOpenSettings}
        >
          <SettingsIcon className="sidebar-nav-icon" size={ICON_SIZE.toolbar} strokeWidth={1.8} />
          <span>{t.shell.sidebar.settings}</span>
        </ButtonControl>
      </div>
      <ResizeHandle
        className="dock-resize-handle sidebar-resize-handle"
        label={t.shell.sidebar.resizeLabel}
        onDoubleClick={props.onResizeReset}
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizeStart}
        title={t.shell.sidebar.resizeTitle}
      />
      {contextMenu && (
        <SidebarNodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isPinned={props.isNodePinned(contextMenu.nodeId)}
          label={contextMenu.label}
          onClose={() => setContextMenu(null)}
          onOpen={() => props.onNavigateRoot(contextMenu.nodeId)}
          onOpenPanel={() => props.onOpenPanel(contextMenu.nodeId)}
          onTogglePin={() => props.onTogglePin(contextMenu.nodeId)}
        />
      )}
    </aside>
  );
}

interface SidebarContextMenuState {
  x: number;
  y: number;
  nodeId: NodeId;
  label: string;
}

interface SidebarNodeContextMenuProps {
  x: number;
  y: number;
  isPinned: boolean;
  label: string;
  onClose: () => void;
  onOpen: () => void;
  onOpenPanel: () => void;
  onTogglePin: () => void;
}

function SidebarNodeContextMenu(props: SidebarNodeContextMenuProps) {
  const t = useT();
  const tc = t.outliner.contextMenu;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuAnchor = useMemo(() => overlayAnchorFromPoint(props.x, props.y), [props.x, props.y]);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRect: menuAnchor,
    layoutKey: props.label,
    maxHeight: 280,
    placement: 'bottom-start',
    width: 240,
  });

  useDismissibleOverlay(menuRef, props.onClose, { escape: false });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: props.onClose,
    kind: 'menu',
  });

  const item = (label: string, icon: ReactNode, onClick: () => void) => (
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

  return createPortal(
    <MenuSurface
      ref={menuRef}
      aria-label={tc.nodeActions}
      className="node-context-menu"
      preserveSelection
      role="menu"
      style={menuStyle}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {item(tc.openNode, <OpenIcon size={ICON_SIZE.menu} />, props.onOpen)}
      {item(tc.openInSplitPane, <OpenIcon size={ICON_SIZE.menu} />, props.onOpenPanel)}
      {item(props.isPinned ? tc.unpinNode : tc.pinNode, <PinIcon size={ICON_SIZE.menu} />, props.onTogglePin)}
    </MenuSurface>,
    document.body,
  );
}

interface SidebarNodePresentation {
  childParent: NodeProjection;
  label: string;
  navigateId: NodeId;
}

function sidebarNodePresentation(
  node: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
  // Localized fallbacks passed in from the component (this helper runs outside React,
  // so it can't call useT itself).
  fallbacks: { untitled: string; missingReference: string },
): SidebarNodePresentation {
  const target = referenceTargetNode(node, byId);
  const displayed = target ?? node;
  const fallbackLabel = node.type === 'reference' && node.targetId ? fallbacks.missingReference : fallbacks.untitled;

  return {
    childParent: displayed,
    label: displayed.content.text || fallbackLabel,
    navigateId: displayed.id,
  };
}

function referenceTargetNode(
  node: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
): NodeProjection | null {
  if (node.type !== 'reference' || !node.targetId) return null;
  const targetId = resolveReferenceTargetId(node.targetId, byId);
  return targetId ? byId.get(targetId) ?? null : null;
}

function sidebarChildren(
  parent: NodeProjection,
  byId: Map<NodeId, NodeProjection>,
): NodeProjection[] {
  return parent.children
    .map((childId) => byId.get(childId))
    .filter((child): child is NodeProjection => Boolean(
      child
      && child.parentId === parent.id
      && child.type !== 'queryCondition'
      // config-as-nodes: internal config rows + system enum options never
      // appear in the workspace tree.
      && child.type !== 'defConfig'
      && child.type !== 'systemOption',
    ));
}

// Workspace-tree rows are text-only. A node's icon (its own emoji, or the fixed
// glyph the system roots fall back to) renders in the outliner/canvas, but the
// tree intentionally omits it so the navigation list stays scannable.
function nodeIconOf(node: NodeProjection) {
  const icon = node.icon;
  return typeof icon === 'string' && icon.trim() ? icon.trim() : null;
}

function rootAvatar(node: NodeProjection, label: string) {
  return nodeIconOf(node) ?? Array.from(label.trim())[0]?.toUpperCase() ?? 'L';
}

/**
 * The formatted summon accelerator, or null when none registered. Read from
 * main because that is where the registration (and any fallback) happened.
 */
function useLauncherHotkeyHint(): string | null {
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.lin?.getLauncherHotkey?.().then((accelerator) => {
      if (!cancelled) setHint(formatHotkey(accelerator));
    });
    return () => { cancelled = true; };
  }, []);
  return hint;
}
