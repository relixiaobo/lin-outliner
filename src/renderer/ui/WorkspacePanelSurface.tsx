import type { CSSProperties, ReactNode } from 'react';
import type { WorkspacePanelState } from './workspaceLayoutTypes';

interface WorkspacePanelSurfaceProps {
  active: boolean;
  children: ReactNode;
  onActivate: () => void;
  panel: WorkspacePanelState;
  size: number;
}

export function WorkspacePanelSurface({
  active,
  children,
  onActivate,
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
      ].filter(Boolean).join(' ')}
      onFocusCapture={onActivate}
      onPointerDownCapture={onActivate}
      style={{
        '--panel-size': size,
      } as CSSProperties}
    >
      {children}
    </div>
  );
}
