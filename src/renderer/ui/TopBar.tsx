import {
  AddIcon,
  AgentIcon,
  BackIcon,
  CloseIcon,
  ForwardIcon,
  ICON_SIZE,
  SidebarIcon,
  UserIcon,
} from './icons';

export interface TopBarTab {
  id: string;
  panelCount: number;
  title: string;
}

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
      data-tauri-drag-region="deep"
    >
      <div className="top-chrome-left" aria-label="Window and navigation controls">
        <div className="window-controls-spacer" aria-hidden="true" />
        <button
          aria-pressed={props.sidebarOpen}
          className="top-chrome-icon-button"
          onClick={props.onToggleSidebar}
          title={props.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          type="button"
        >
          <SidebarIcon size={ICON_SIZE.toolbar} strokeWidth={2} />
        </button>
        <button className="top-chrome-icon-button" disabled title="Back">
          <BackIcon size={ICON_SIZE.menu} strokeWidth={1.7} />
        </button>
        <button className="top-chrome-icon-button" disabled title="Forward">
          <ForwardIcon size={ICON_SIZE.menu} strokeWidth={1.7} />
        </button>
      </div>

      <nav className="tab-strip" aria-label="Workspace tabs">
        {props.tabs.map((tab) => {
          const active = tab.id === props.activeTabId;
          return (
          <div
            className={`workspace-tab ${active ? 'active' : ''}`}
            key={tab.id}
            title={tab.title}
          >
            <button
              aria-current={active ? 'page' : undefined}
              className="workspace-tab-trigger"
              onClick={() => props.onSelectTab(tab.id)}
              type="button"
            >
              <span className="workspace-tab-title">{tab.title}</span>
              {tab.panelCount > 1 && <span className="workspace-tab-count">{tab.panelCount}</span>}
            </button>
            {props.tabs.length > 1 && (
              <button
                aria-label={`Close ${tab.title}`}
                className="workspace-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onCloseTab(tab.id);
                }}
                title="Close tab"
                type="button"
              >
                <CloseIcon size={ICON_SIZE.tiny} strokeWidth={2.2} />
              </button>
            )}
          </div>
          );
        })}
        <button className="top-chrome-icon-button add-tab-button" onClick={props.onCreateTab} title="New tab" type="button">
          <AddIcon size={ICON_SIZE.toolbar} />
        </button>
      </nav>

      <div className="top-chrome-right" aria-label="Global actions">
        <button
          aria-pressed={props.agentOpen}
          className="top-chrome-icon-button"
          onClick={props.onToggleAgent}
          title={props.agentOpen ? 'Collapse agent' : 'Expand agent'}
          type="button"
        >
          <AgentIcon size={ICON_SIZE.toolbar} />
        </button>
        <button className="top-chrome-icon-button" disabled title="Account">
          <UserIcon size={ICON_SIZE.toolbar} />
        </button>
      </div>
    </header>
  );
}
