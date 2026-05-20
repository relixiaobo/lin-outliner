import { CloseIcon, DebugIcon, ICON_SIZE } from './icons';
import { ButtonControl } from './primitives/ButtonControl';
import { IconButton } from './primitives/IconButton';

export interface WorkspaceTabSegment {
  active: boolean;
  icon?: string | null;
  id: string;
  kind: 'node' | 'agent-debug';
  title: string;
}

export interface WorkspaceTabModel {
  id: string;
  segments: WorkspaceTabSegment[];
  title: string;
}

interface WorkspaceTabProps {
  active: boolean;
  canClose: boolean;
  tab: WorkspaceTabModel;
  onClose: (tabId: string) => void;
  onSelect: (tabId: string, panelId?: string) => void;
}

export function WorkspaceTab({ active, canClose, tab, onClose, onSelect }: WorkspaceTabProps) {
  return (
    <div
      className={`workspace-tab ${active ? 'active' : ''}`}
      title={tab.title}
    >
      <ButtonControl
        aria-current={active ? 'page' : undefined}
        className="workspace-tab-trigger"
        onClick={(event) => {
          const target = event.target;
          const segment = target instanceof Element
            ? target.closest('[data-workspace-panel-id]')
            : null;
          const panelId = segment instanceof HTMLElement
            ? segment.dataset.workspacePanelId
            : undefined;
          onSelect(tab.id, panelId);
        }}
      >
        <span className="workspace-tab-segments">
          {tab.segments.map((segment) => (
            <span
              className={`workspace-tab-segment ${segment.active ? 'is-active' : ''}`}
              data-workspace-panel-id={segment.id}
              key={segment.id}
            >
              <WorkspaceTabSegmentIcon segment={segment} />
              <span className="workspace-tab-title">{segment.title}</span>
            </span>
          ))}
        </span>
      </ButtonControl>
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

function WorkspaceTabSegmentIcon({ segment }: { segment: WorkspaceTabSegment }) {
  if (segment.kind === 'agent-debug') {
    return (
      <DebugIcon
        aria-hidden="true"
        className="workspace-tab-segment-icon"
        size={ICON_SIZE.rowGlyph}
      />
    );
  }

  if (segment.icon?.trim()) {
    return (
      <span className="workspace-tab-segment-icon workspace-tab-node-icon" aria-hidden="true">
        {segment.icon.trim()}
      </span>
    );
  }

  return <span className="workspace-tab-segment-icon workspace-tab-bullet" aria-hidden="true" />;
}
