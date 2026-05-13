import type { DocumentProjection, NodeId } from '../api/types';
import {
  AddIcon,
  BackIcon,
  ForwardIcon,
  HomeIcon,
  ICON_SIZE,
  RedoIcon,
  SearchIcon,
  UndoIcon,
} from './icons';
import { textOf } from './shared';

interface TopBarProps {
  projection: DocumentProjection;
  rootId: NodeId;
  rootName: string;
  onRoot: (nodeId: NodeId) => void;
  onNew: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCommand: () => void;
}

function breadcrumbFor(projection: DocumentProjection, rootId: NodeId) {
  const byId = new Map(projection.nodes.map((node) => [node.id, node]));
  const chain = [];
  let current = byId.get(rootId);
  const seen = new Set<NodeId>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    if (!current.parentId) break;
    current = byId.get(current.parentId);
  }
  return chain;
}

export function TopBar(props: TopBarProps) {
  const { projection } = props;
  const crumbs = breadcrumbFor(projection, props.rootId);
  return (
    <header className="topbar">
      <div className="topbar-nav">
        <button className="topbar-nav-button" disabled title="Back">
          <BackIcon size={ICON_SIZE.menu} strokeWidth={1.7} />
        </button>
        <button className="topbar-nav-button" disabled title="Forward">
          <ForwardIcon size={ICON_SIZE.menu} strokeWidth={1.7} />
        </button>
      </div>

      <nav className="breadcrumb" aria-label="Breadcrumb">
        <button className="breadcrumb-home" onClick={() => props.onRoot(projection.rootId)} title="Workspace">
          <HomeIcon size={ICON_SIZE.menu} strokeWidth={1.7} />
        </button>
        {crumbs
          .filter((crumb) => crumb.id !== projection.rootId)
          .slice(-3)
          .map((crumb) => (
            <span className="breadcrumb-segment" key={crumb.id}>
              <span className="breadcrumb-divider">/</span>
              <button className="breadcrumb-button" onClick={() => props.onRoot(crumb.id)}>
                {textOf(crumb)}
              </button>
            </span>
          ))}
        {crumbs.length <= 1 && <span className="breadcrumb-current">{props.rootName}</span>}
      </nav>

      <div className="spacer" />
      <button className="icon-button" onClick={props.onCommand} title="Command palette">
        <SearchIcon size={ICON_SIZE.toolbar} />
      </button>
      <button className="icon-button" onClick={props.onNew} title="New node">
        <AddIcon size={ICON_SIZE.toolbar} />
      </button>
      <button className="icon-button" onClick={props.onUndo} title="Undo">
        <UndoIcon size={ICON_SIZE.toolbar} />
      </button>
      <button className="icon-button" onClick={props.onRedo} title="Redo">
        <RedoIcon size={ICON_SIZE.toolbar} />
      </button>
    </header>
  );
}
