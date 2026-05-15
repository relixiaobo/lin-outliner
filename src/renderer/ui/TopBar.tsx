import {
  AddIcon,
  AgentIcon,
  BackIcon,
  ForwardIcon,
  ICON_SIZE,
  SidebarIcon,
  UserIcon,
} from './icons';
import { IconButton } from './primitives/IconButton';
import { WorkspaceTab, type WorkspaceTabModel } from './WorkspaceTab';

export type TopBarTab = WorkspaceTabModel;

interface TopBarProps {
  agentOpen: boolean;
  sidebarOpen: boolean;
  tabs: TopBarTab[];
  activeTabId: string | null;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onSelectTab: (tabId: string) => void;
  onToggleAgent: () => void;
  onToggleSidebar: () => void;
}

export function TopBar(props: TopBarProps) {
  return (
    <header
      className="top-chrome"
      data-electron-drag-region="deep"
    >
      <div className="top-chrome-left" aria-label="Window and navigation controls">
        <div className="window-controls-spacer" aria-hidden="true" />
        <IconButton
          aria-pressed={props.sidebarOpen}
          className="top-chrome-icon-button"
          icon={SidebarIcon}
          label={props.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          onClick={props.onToggleSidebar}
          title={props.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          strokeWidth={2}
        />
        <IconButton
          className="top-chrome-icon-button"
          disabled
          icon={BackIcon}
          iconSize={ICON_SIZE.menu}
          label="Back"
          strokeWidth={1.7}
        />
        <IconButton
          className="top-chrome-icon-button"
          disabled
          icon={ForwardIcon}
          iconSize={ICON_SIZE.menu}
          label="Forward"
          strokeWidth={1.7}
        />
      </div>

      <nav className="tab-strip" aria-label="Workspace tabs">
        {props.tabs.map((tab) => (
          <WorkspaceTab
            active={tab.id === props.activeTabId}
            canClose={props.tabs.length > 1}
            key={tab.id}
            tab={tab}
            onClose={props.onCloseTab}
            onSelect={props.onSelectTab}
          />
        ))}
        <IconButton
          className="top-chrome-icon-button add-tab-button"
          icon={AddIcon}
          label="New tab"
          onClick={props.onCreateTab}
        />
      </nav>

      <div className="top-chrome-right" aria-label="Global actions">
        <IconButton
          aria-pressed={props.agentOpen}
          className="top-chrome-icon-button"
          icon={AgentIcon}
          label={props.agentOpen ? 'Collapse agent' : 'Expand agent'}
          onClick={props.onToggleAgent}
          title={props.agentOpen ? 'Collapse agent' : 'Expand agent'}
        />
        <IconButton
          className="top-chrome-icon-button"
          disabled
          icon={UserIcon}
          label="Account"
        />
      </div>
    </header>
  );
}
