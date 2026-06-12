import type { HTMLAttributes, MouseEventHandler, ReactNode } from 'react';

interface OutlinerRowShellProps {
  hasChildren: boolean;
  expanded: boolean;
  wrapProps: HTMLAttributes<HTMLDivElement>;
  wrapClassName?: string;
  rowClassName: string;
  onSelectFromPointer: MouseEventHandler<HTMLDivElement>;
  onContextMenu: MouseEventHandler<HTMLDivElement>;
  rowContent: ReactNode;
  children?: ReactNode;
}

export function OutlinerRowShell({
  hasChildren,
  expanded,
  wrapProps,
  wrapClassName,
  rowClassName,
  onSelectFromPointer,
  onContextMenu,
  rowContent,
  children,
}: OutlinerRowShellProps) {
  return (
    <div
      className={`row-wrap ${hasChildren ? 'has-children' : ''} ${expanded ? 'expanded' : ''} ${wrapClassName ?? ''}`.trim()}
      {...wrapProps}
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
