import type { CSSProperties, DragEventHandler, ReactNode } from 'react';
import type { WorkspacePanelState } from './workspaceLayoutTypes';

interface WorkspacePanelSurfaceProps {
  active: boolean;
  children: ReactNode;
  /** Which edge shows the pane-reorder insertion line while a pane drag hovers. */
  dropEdge?: 'before' | 'after' | null;
  onActivate: () => void;
  /** Pane-reorder drop wiring (WorkspaceCanvas). Attached in the CAPTURE phase so
   *  a pane drag never reaches the content's own drag-and-drop handlers (outliner
   *  rows, preview drop zones); the handlers gate on the pane MIME and let every
   *  other drag fall through to the content untouched. */
  onPanelDragOver?: DragEventHandler<HTMLDivElement>;
  onPanelDrop?: DragEventHandler<HTMLDivElement>;
  panel: WorkspacePanelState;
  size: number;
}

export function WorkspacePanelSurface({
  active,
  children,
  dropEdge,
  onActivate,
  onPanelDragOver,
  onPanelDrop,
  panel,
  size,
}: WorkspacePanelSurfaceProps) {
  const workspaceViewClass = `is-${panel.view.kind}`;
  return (
    <div
      className={[
        'outline-panel-surface',
        `is-${panel.type}`,
        workspaceViewClass,
        active ? 'active-panel' : '',
        dropEdge === 'before' ? 'panel-drop-before' : '',
        dropEdge === 'after' ? 'panel-drop-after' : '',
      ].filter(Boolean).join(' ')}
      onFocusCapture={onActivate}
      onPointerDownCapture={onActivate}
      onDragOverCapture={onPanelDragOver}
      onDropCapture={onPanelDrop}
      style={{
        '--panel-size': size,
      } as CSSProperties}
    >
      {children}
    </div>
  );
}
