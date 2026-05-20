import type { CSSProperties } from 'react';
import {
  MAC_TRAFFIC_LIGHT_POSITION,
  MAC_TRAFFIC_LIGHT_SIZE,
} from '../../core/chromeGeometry';
import {
  AddIcon,
  AgentIcon,
  BackIcon,
  ForwardIcon,
  ICON_SIZE,
  SidebarCollapseIcon,
  SidebarExpandIcon,
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
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onSelectTab: (tabId: string, panelId?: string) => void;
  onToggleAgent: () => void;
  onToggleSidebar: () => void;
}

type TopChromeStyle = CSSProperties & Record<
  '--traffic-light-size' | '--traffic-light-x' | '--traffic-light-y',
  string
>;

const topChromeStyle: TopChromeStyle = {
  '--traffic-light-size': `${MAC_TRAFFIC_LIGHT_SIZE}px`,
  '--traffic-light-x': `${MAC_TRAFFIC_LIGHT_POSITION.x}px`,
  '--traffic-light-y': `${MAC_TRAFFIC_LIGHT_POSITION.y}px`,
};

export function TopBar(props: TopBarProps) {
  return (
    <header
      className="top-chrome"
      data-electron-drag-region="deep"
      style={topChromeStyle}
    >
      <div className="top-chrome-left" aria-label="Window and navigation controls">
        <div className="window-controls-spacer" aria-hidden="true" />
        <IconButton
          className="top-chrome-icon-button"
          icon={props.sidebarOpen ? SidebarCollapseIcon : SidebarExpandIcon}
          label={props.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          onClick={props.onToggleSidebar}
          title={props.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          strokeWidth={2}
        />
        <IconButton
          className="top-chrome-icon-button"
          disabled={!props.canNavigateBack}
          icon={BackIcon}
          iconSize={ICON_SIZE.menu}
          label="Back"
          onClick={props.onNavigateBack}
          strokeWidth={1.7}
        />
        <IconButton
          className="top-chrome-icon-button"
          disabled={!props.canNavigateForward}
          icon={ForwardIcon}
          iconSize={ICON_SIZE.menu}
          label="Forward"
          onClick={props.onNavigateForward}
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
