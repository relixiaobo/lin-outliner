import type { CSSProperties, ReactNode } from 'react';
import type { WorkspacePanelState } from './workspaceLayoutTypes';

interface WorkspacePanelSurfaceProps {
  active: boolean;
  children: ReactNode;
  /** Visual position flags (CSS `order` decouples visual from DOM order, so
   *  the corner-clearance rules cannot use :first-child/:last-child). */
  firstPane: boolean;
  lastPane: boolean;
  onActivate: () => void;
  /** Flex `order` carrying the visual left-right position; the DOM order of
   *  surfaces is stable across reorders (see WorkspaceCanvas). */
  order: number;
  panel: WorkspacePanelState;
  /** Live pane-reorder preview (WorkspaceCanvas): translateX to the position
   *  this pane would occupy if the active pane drag dropped now. Pure visual
   *  offset — the DOM never changes until the drop commits. */
  previewOffset?: number | null;
  size: number;
}

export function WorkspacePanelSurface({
  active,
  children,
  firstPane,
  lastPane,
  onActivate,
  order,
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
        firstPane ? 'is-first-pane' : '',
        lastPane ? 'is-last-pane' : '',
      ].filter(Boolean).join(' ')}
      data-panel-id={panel.id}
      onFocusCapture={onActivate}
      onPointerDownCapture={onActivate}
      style={{
        '--panel-size': size,
        order,
        ...(previewOffset ? { transform: `translateX(${previewOffset}px)` } : {}),
      } as CSSProperties}
    >
      {children}
    </div>
  );
}
