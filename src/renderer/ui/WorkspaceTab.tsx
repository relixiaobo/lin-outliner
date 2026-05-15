import { CloseIcon } from './icons';
import { IconButton } from './primitives/IconButton';

export interface WorkspaceTabModel {
  id: string;
  panelCount: number;
  title: string;
}

interface WorkspaceTabProps {
  active: boolean;
  canClose: boolean;
  tab: WorkspaceTabModel;
  onClose: (tabId: string) => void;
  onSelect: (tabId: string) => void;
}

export function WorkspaceTab({ active, canClose, tab, onClose, onSelect }: WorkspaceTabProps) {
  return (
    <div
      className={`workspace-tab ${active ? 'active' : ''}`}
      title={tab.title}
    >
      <button
        aria-current={active ? 'page' : undefined}
        className="workspace-tab-trigger"
        onClick={() => onSelect(tab.id)}
        type="button"
      >
        <span className="workspace-tab-title">{tab.title}</span>
        {tab.panelCount > 1 && <span className="workspace-tab-count">{tab.panelCount}</span>}
      </button>
      {canClose && (
        <IconButton
          className="workspace-tab-close"
          icon={CloseIcon}
          label={`Close ${tab.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onClose(tab.id);
          }}
          title="Close tab"
          strokeWidth={2.2}
          variant="tabClose"
        />
      )}
    </div>
  );
}
