import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { DocumentProjection, NodeId, NodeProjection } from '../api/types';
import { resolveReferenceTargetId, type DocumentIndex } from '../state/document';
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ICON_SIZE,
  LibraryIcon,
  PinIcon,
  RecentsIcon,
  SettingsIcon,
  SupertagIcon,
} from './icons';
import { ButtonControl } from './primitives/ButtonControl';
import { ResizeHandle } from './primitives/ResizeHandle';
import { textOf } from './shared';

const primaryNavItems = [
  { label: 'Today', key: 'today', icon: CalendarIcon },
  { label: 'Library', key: 'library', icon: LibraryIcon },
  { label: 'Recents', key: 'recents', icon: RecentsIcon },
  { label: 'Schema', key: 'schema', icon: SupertagIcon },
] as const;

interface SidebarProps {
  expandedIds: Set<NodeId>;
  index: DocumentIndex;
  onNavigateRoot: (nodeId: NodeId) => void;
  onOpenPanel: (nodeId: NodeId) => void;
  onOpenSettings: () => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeReset: () => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onToggleTreeNode: (nodeId: NodeId) => void;
  projection: DocumentProjection;
  rootId: NodeId | null;
}

export function Sidebar(props: SidebarProps) {
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
  const pinnedNodeIds: NodeId[] = [];
  const rootLabel = rootNode ? textOf(rootNode) || 'Untitled' : '';
  const rootActive = rootNode ? props.rootId === rootNode.id : false;

  const renderWorkspaceTree = (nodeId: NodeId, depth = 0, parentPath: readonly NodeId[] = [props.projection.rootId]) => {
    const node = props.index.byId.get(nodeId);
    if (!node) return null;
    const presentation = sidebarNodePresentation(node, props.index.byId);
    const childParent = presentation.childParent;
    const childParentId = childParent.id;
    const referenceCycle = parentPath.includes(childParentId);
    const children = referenceCycle ? [] : sidebarChildren(childParent, props.index.byId);
    const hasChildren = children.length > 0;
    const expanded = props.expandedIds.has(node.id);
    const active = props.rootId === node.id || props.rootId === presentation.navigateId;
    const label = presentation.label;
    const nodeIcon = renderSidebarNodeIcon(childParent);
    const childPath = referenceCycle ? parentPath : [...parentPath, childParentId];

    return (
      <div className="workspace-tree-branch" key={node.id}>
        <div
          className={`workspace-tree-row ${active ? 'active' : ''}`}
          style={{ '--tree-depth': depth } as CSSProperties}
        >
          <ButtonControl
            aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
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
            className={`workspace-tree-label ${nodeIcon ? 'has-icon' : 'no-icon'}`}
            onClick={(event) => {
              if (event.altKey) props.onOpenPanel(presentation.navigateId);
              else props.onNavigateRoot(presentation.navigateId);
            }}
          >
            {nodeIcon}
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
    <aside className="sidebar-dock" aria-label="Primary navigation">
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
                if (event.altKey) props.onOpenPanel(target);
                else props.onNavigateRoot(target);
              }}
            >
              <NavIcon className="sidebar-nav-icon" size={ICON_SIZE.toolbar} strokeWidth={1.8} />
              <span>{item.label}</span>
            </ButtonControl>
          );
        })}
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Pinned</div>
        {pinnedNodeIds.length === 0 ? (
          <div className="sidebar-empty-row">
            <PinIcon className="sidebar-empty-icon" size={ICON_SIZE.menu} strokeWidth={1.7} />
            <span>Drag to pin nodes</span>
          </div>
        ) : (
          <div className="workspace-tree" aria-label="Pinned nodes">
            {pinnedNodeIds.map((nodeId) => renderWorkspaceTree(nodeId))}
          </div>
        )}
      </div>

      {rootNode && (
        <div className="sidebar-section sidebar-root-section">
          <div className="sidebar-root-row">
            <ButtonControl
              aria-label={`Open ${rootLabel}`}
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
          <div className="workspace-tree" aria-label="Workspace root tree">
            {rootChildren.map((child) => (
              renderWorkspaceTree(child.id)
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
          <span>Settings</span>
        </ButtonControl>
      </div>
      <ResizeHandle
        className="dock-resize-handle sidebar-resize-handle"
        label="Resize sidebar"
        onDoubleClick={props.onResizeReset}
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizeStart}
        title="Resize sidebar (double-click to reset)"
      />
    </aside>
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
): SidebarNodePresentation {
  const target = referenceTargetNode(node, byId);
  const displayed = target ?? node;
  const fallbackLabel = node.type === 'reference' && node.targetId ? 'Missing reference' : 'Untitled';

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

// Workspace-tree items show only a node's own icon. System nodes (Daily notes,
// Library, Saved searches, Trash) carry no icon of their own, so they render
// without one rather than borrowing a hardcoded fallback glyph.
function renderSidebarNodeIcon(node: NodeProjection): ReactNode {
  const icon = nodeIconOf(node);
  if (!icon) return null;
  return (
    <span className="workspace-tree-label-icon workspace-tree-label-emoji" aria-hidden="true">
      {icon}
    </span>
  );
}

function nodeIconOf(node: NodeProjection) {
  const icon = node.icon;
  return typeof icon === 'string' && icon.trim() ? icon.trim() : null;
}

function rootAvatar(node: NodeProjection, label: string) {
  return nodeIconOf(node) ?? Array.from(label.trim())[0]?.toUpperCase() ?? 'L';
}
