import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { DocumentProjection, NodeId, NodeProjection } from '../api/types';
import type { DocumentIndex } from '../state/document';
import {
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ICON_SIZE,
  LibraryIcon,
  RecentsIcon,
  SearchIcon,
  TagIcon,
} from './icons';
import { ButtonControl } from './primitives/ButtonControl';
import { ResizeHandle } from './primitives/ResizeHandle';
import { textOf } from './shared';

const primaryNavItems = [
  { label: 'Today', key: 'today', icon: CalendarIcon },
  { label: 'Search', key: 'search', icon: SearchIcon },
  { label: 'Supertags', key: 'supertags', icon: TagIcon },
  { label: 'Library', key: 'library', icon: LibraryIcon },
  { label: 'Recents', key: 'recents', icon: RecentsIcon },
] as const;

interface SidebarProps {
  expandedIds: Set<NodeId>;
  index: DocumentIndex;
  onNavigateRoot: (nodeId: NodeId) => void;
  onOpenPanel: (nodeId: NodeId) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onToggleTreeNode: (nodeId: NodeId) => void;
  projection: DocumentProjection;
  rootId: NodeId | null;
}

export function Sidebar(props: SidebarProps) {
  const navTargets = {
    today: props.projection.todayId,
    search: props.projection.searchesId,
    supertags: props.projection.schemaId,
    library: props.projection.rootId,
    recents: null,
  } satisfies Record<typeof primaryNavItems[number]['key'], NodeId | null>;

  const renderWorkspaceTree = (nodeId: NodeId, depth = 0) => {
    const node = props.index.byId.get(nodeId);
    if (!node) return null;
    const children = node.children
      .map((childId) => props.index.byId.get(childId))
      .filter((child): child is NodeProjection => Boolean(child && child.parentId === node.id));
    const hasChildren = children.length > 0;
    const expanded = props.expandedIds.has(node.id);
    const active = props.rootId === node.id;
    const label = textOf(node) || 'Untitled';

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
            className="workspace-tree-label"
            onClick={(event) => {
              if (event.altKey) props.onOpenPanel(node.id);
              else props.onNavigateRoot(node.id);
            }}
          >
            <span>{label}</span>
          </ButtonControl>
        </div>
        {hasChildren && expanded && (
          <div className="workspace-tree-children">
            {children.map((child) => renderWorkspaceTree(child.id, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar-dock" aria-label="Primary navigation">
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
        <div className="sidebar-section-title">Workspace</div>
        <div className="workspace-tree" aria-label="Workspace tree">
          {(props.index.byId.get(props.projection.rootId)?.children ?? []).map((childId) => (
            renderWorkspaceTree(childId)
          ))}
        </div>
      </div>
      <ResizeHandle
        className="dock-resize-handle sidebar-resize-handle"
        label="Resize sidebar"
        onKeyDown={props.onResizeKeyDown}
        onPointerDown={props.onResizeStart}
        title="Resize sidebar"
      />
    </aside>
  );
}
