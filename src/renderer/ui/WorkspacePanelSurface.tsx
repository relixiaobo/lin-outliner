import type { CSSProperties, ReactNode } from 'react';
import { CloseIcon } from './icons';
import { IconButton } from './primitives/IconButton';
import type { WorkspacePanelState } from './workspaceLayoutTypes';
import { useT } from '../i18n/I18nProvider';

interface WorkspacePanelSurfaceProps {
  active: boolean;
  children: ReactNode;
  onActivate: () => void;
  onClose: () => void;
  panel: WorkspacePanelState;
  showClose: boolean;
  size: number;
}

export function WorkspacePanelSurface({
  active,
  children,
  onActivate,
  onClose,
  panel,
  showClose,
  size,
}: WorkspacePanelSurfaceProps) {
  const t = useT();
  const workspaceViewClass = panel.type === 'workspace' ? `is-${panel.view.kind}` : '';
  const closeOwnedByChild = panel.type === 'workspace'
    || panel.type === 'thread-run-details';
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
      {/* Pane content owns close INSIDE the breadcrumb so it's a
          no-drag descendant of the drag region and aligns to the content inset. Only the
          remaining fallback panes keep the absolute corner close here. */}
      {showClose && !closeOwnedByChild && (
        <IconButton
          className="outline-panel-close"
          icon={CloseIcon}
          label={t.shell.panel.closeLabel}
          onClick={onClose}
          title={t.shell.panel.closeLabel}
          variant="panel"
        />
      )}
      {children}
    </div>
  );
}
