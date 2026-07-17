import type { HTMLAttributes, MouseEventHandler, ReactNode } from 'react';

interface OutlinerRowShellProps {
  hasChildren: boolean;
  // Whether the row exposes an expand/collapse toggle at all. Defaults to
  // `hasChildren`, but a file row's chevron toggles its inline preview, so it is
  // expandable even with no children — `aria-expanded` must then be announced.
  expandable?: boolean;
  expanded: boolean;
  // 1-based depth for `aria-level` (root rows are level 1).
  level: number;
  // Whether the row is part of the current selection (`aria-selected`).
  selected: boolean;
  wrapProps: HTMLAttributes<HTMLDivElement>;
  wrapClassName?: string;
  rowClassName: string;
  onSelectFromPointer: MouseEventHandler<HTMLDivElement>;
  onContextMenu: MouseEventHandler<HTMLDivElement>;
  rowContent: ReactNode;
  semanticRole?: 'treeitem' | 'presentation';
  children?: ReactNode;
}

export function OutlinerRowShell({
  hasChildren,
  expandable,
  expanded,
  level,
  selected,
  wrapProps,
  wrapClassName,
  rowClassName,
  onSelectFromPointer,
  onContextMenu,
  rowContent,
  semanticRole = 'treeitem',
  children,
}: OutlinerRowShellProps) {
  const isExpandable = expandable ?? hasChildren;
  const treeSemantic = semanticRole === 'treeitem';
  return (
    <div
      className={`row-wrap ${hasChildren ? 'has-children' : ''} ${expanded ? 'expanded' : ''} ${wrapClassName ?? ''}`.trim()}
      {...wrapProps}
      // ARIA tree structure (additive — the row stays a div, the sighted keyboard
      // model is unchanged). `aria-expanded` is omitted on non-expandable leaf rows
      // so assistive tech never announces a toggle that does not exist.
      role={semanticRole}
      aria-level={treeSemantic ? level : undefined}
      aria-expanded={treeSemantic && isExpandable ? expanded : undefined}
      aria-selected={treeSemantic ? selected : undefined}
    >
      <div
        className={rowClassName}
        onMouseDownCapture={onSelectFromPointer}
        onContextMenu={onContextMenu}
      >
        {rowContent}
      </div>
      {children}
    </div>
  );
}
