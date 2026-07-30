import type { CSSProperties, ReactNode } from 'react';
import type { WorkspacePanelState } from './workspaceLayoutTypes';

interface WorkspacePanelSurfaceProps {
  active: boolean;
  children: ReactNode;
  onActivate: () => void;
  panel: WorkspacePanelState;
  /** Live pane-reorder preview (WorkspaceCanvas): translateX to the position
   *  this pane would occupy if the active pane drag dropped now. Pure visual
   *  offset — the DOM order never changes until the drop commits. */
  previewOffset?: number | null;
  size: number;
}

export function WorkspacePanelSurface({
  active,
  children,
  onActivate,
  panel,
  previewOffset,
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
      ].filter(Boolean).join(' ')}
      onFocusCapture={onActivate}
      onPointerDownCapture={onActivate}
      style={{
        '--panel-size': size,
        ...(previewOffset ? { transform: `translateX(${previewOffset}px)` } : {}),
      } as CSSProperties}
    >
      {children}
    </div>
  );
}
