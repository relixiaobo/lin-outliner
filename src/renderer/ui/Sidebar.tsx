import { useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
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
  SettingsIcon,
  SupertagIcon,
} from './icons';
import { ButtonControl } from './primitives/ButtonControl';
import { MenuItem } from './primitives/MenuItem';
import { MenuSurface } from './primitives/MenuSurface';
import { ResizeHandle } from './primitives/ResizeHandle';
import { overlayAnchorFromPoint, useAnchoredOverlay } from './primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from './primitives/useDismissibleOverlay';
import { textOf } from './shared';
import type { NavigateRootOptions } from './shared';
import { useT } from '../i18n/I18nProvider';
import { isNodeInTrash } from './interactions/nodeLocation';

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
  onOpenSettings: () => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeReset: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onToggleTreeNode: (nodeId: NodeId) => void;
  onTogglePin: (nodeId: NodeId) => void;
  pinnedNodeIds: NodeId[];
  projection: DocumentProjection;
  rootId: NodeId | null;
}

export function Sidebar(props: SidebarProps) {
  const t = useT();
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const navTargets = {
    today: props.projection.todayId,
    library: props.projection.libraryId,
    recents: props.projection.recentsId,
    schema: props.projection.schemaId,
  } satisfies Record<typeof primaryNavItems[number]['key'], NodeId | null>;
  const rootNode = props.index.byId.get(props.projection.rootId);
  // T3: show all root sections in the workspace tree (Schema/Settings no longer
  // hidden) — the center root outline already shows all of them.
  const rootChildren = rootNode?.children
    .map((childId) => props.index.byId.get(childId))
    .filter((child): child is NodeProjection => (
      Boolean(child && child.parentId === rootNode.id)
    )) ?? [];
  const rootLabel = rootNode ? textOf(rootNode) || t.common.untitled : '';
  const rootActive = rootNode ? props.rootId === rootNode.id : false;

  const renderWorkspaceTree = (nodeId: NodeId, depth = 0, parentPath: readonly NodeId[] = []) => {
    const node = props.index.byId.get(nodeId);
    if (!node) return null;
    const presentation = sidebarNodePresentation(node, props.index.byId, {
      untitled: t.common.untitled,
      missingReference: t.shell.sidebar.missingReference,
    });
    const childParent = presentation.childParent;
    const childParentId = childParent.id;
    const referenceCycle = parentPath.includes(childParentId);
    const children = referenceCycle ? [] : sidebarChildren(childParent, props.index.byId);
    const hasChildren = children.length > 0;
    const expanded = props.expandedIds.has(node.id);
    const active = props.rootId === node.id || props.rootId === presentation.navigateId;
    const label = presentation.label;
    const childPath = referenceCycle ? parentPath : [...parentPath, childParentId];
    const trashed = presentation.navigateId !== props.projection.trashId
      && isNodeInTrash(props.index, presentation.navigateId);

    return (
      <div className="workspace-tree-branch" key={node.id}>
        <div
          className={[
            'workspace-tree-row',
            active ? 'active' : '',
            trashed ? 'trashed' : '',
          ].filter(Boolean).join(' ')}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({
              x: event.clientX,
              y: event.clientY,
              nodeId: presentation.navigateId,
              label,
            });
          }}
          style={{ '--tree-depth': depth } as CSSProperties}
        >
          <ButtonControl
            aria-label={expanded ? t.shell.sidebar.collapseNode({ label }) : t.shell.sidebar.expandNode({ label })}
            className="workspace-tree-chevron-button"
            disabled={!hasChildren}
            onClick={() => props.onToggleTreeNode(node.id)}
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
              if (event.altKey) props.onOpenPanel(presentation.navigateId);
              else props.onNavigateRoot(presentation.navigateId);
            }}
          >
            <span className="workspace-tree-label-text">{label}</span>
          </ButtonControl>
        </div>
        {hasChildren && expanded && (
          <div className="workspace-tree-children">
            {children.map((child) => renderWorkspaceTree(child.id, depth + 1, childPath))}
          </div>
        )}
      </div>
    );
  };

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

      <div className="sidebar-section">
        <div className="sidebar-section-title">{t.shell.sidebar.pinnedSection}</div>
        {props.pinnedNodeIds.length === 0 ? (
          <div className="sidebar-empty-row">
            <PinIcon className="sidebar-empty-icon" size={ICON_SIZE.menu} strokeWidth={1.7} />
            <span>{t.shell.sidebar.noPinnedHint}</span>
          </div>
        ) : (
          <div className="workspace-tree" aria-label={t.shell.sidebar.pinnedNodesAriaLabel}>
            {props.pinnedNodeIds.map((nodeId) => renderWorkspaceTree(nodeId))}
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
              renderWorkspaceTree(child.id, 0, [props.projection.rootId])
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

  useDismissibleOverlay(menuRef, props.onClose);

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
