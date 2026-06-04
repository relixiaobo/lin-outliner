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
  return (
    <div
      className={[
        'outline-panel-surface',
        `is-${panel.type}`,
        active ? 'active-panel' : '',
      ].filter(Boolean).join(' ')}
      onFocusCapture={onActivate}
      onPointerDownCapture={onActivate}
      style={{
        '--panel-size': size,
      } as CSSProperties}
    >
      {/* Outliner panes render their own close INSIDE the breadcrumb (NodePanel) so it's a
          no-drag descendant of the drag region and aligns to the content inset. Only the
          breadcrumb-less agent-debug pane keeps the absolute corner close here. */}
      {showClose && panel.type !== 'outliner' && (
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
