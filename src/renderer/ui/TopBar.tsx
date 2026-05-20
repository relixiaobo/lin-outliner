import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  MAC_TRAFFIC_LIGHT_POSITION,
  MAC_TRAFFIC_LIGHT_SIZE,
} from '../../core/chromeGeometry';
import {
  AddIcon,
  AgentIcon,
  BackIcon,
  ColorIcon,
  ForwardIcon,
  ICON_SIZE,
  MoreIcon,
  SettingsIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
} from './icons';
import { IconButton } from './primitives/IconButton';
import { ButtonControl } from './primitives/ButtonControl';
import { MenuItem } from './primitives/MenuItem';
import { MenuSurface } from './primitives/MenuSurface';
import { useAnchoredOverlay } from './primitives/useAnchoredOverlay';
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
  onOpenAppearanceSettings?: () => void;
  onOpenProviderSettings: () => void;
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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuStyle = useAnchoredOverlay(moreMenuRef, {
    anchorRef: moreButtonRef,
    disabled: !moreOpen,
    placement: 'bottom-end',
    width: 220,
  });

  useEffect(() => {
    if (!moreOpen) return undefined;

    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && moreButtonRef.current?.contains(target)) return;
      if (target instanceof Node && moreMenuRef.current?.contains(target)) return;
      setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };

    document.addEventListener('pointerdown', closeOnPointerDown, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [moreOpen]);

  const openProviderSettings = () => {
    setMoreOpen(false);
    props.onOpenProviderSettings();
  };

  const openAppearanceSettings = () => {
    if (!props.onOpenAppearanceSettings) return;
    setMoreOpen(false);
    props.onOpenAppearanceSettings();
  };

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
          className="top-chrome-icon-button"
          icon={AgentIcon}
          label={props.agentOpen ? 'Collapse agent' : 'Expand agent'}
          onClick={props.onToggleAgent}
          title={props.agentOpen ? 'Collapse agent' : 'Expand agent'}
        />
        <ButtonControl
          ref={moreButtonRef}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          aria-label="More"
          className="icon-button icon-button-chrome top-chrome-icon-button"
          onClick={() => setMoreOpen((open) => !open)}
          title="More"
        >
          <MoreIcon size={ICON_SIZE.toolbar} />
        </ButtonControl>
      </div>

      {moreOpen ? createPortal(
        <MenuSurface
          ref={moreMenuRef}
          className="top-chrome-more-menu"
          preserveSelection
          role="menu"
          style={moreMenuStyle}
        >
          <MenuItem
            className="top-chrome-more-item"
            icon={<SettingsIcon size={ICON_SIZE.menu} />}
            iconClassName="top-chrome-more-item-icon"
            label="Provider settings"
            labelClassName="top-chrome-more-item-label"
            onClick={openProviderSettings}
            role="menuitem"
          />
          {props.onOpenAppearanceSettings ? (
            <MenuItem
              className="top-chrome-more-item"
              icon={<ColorIcon size={ICON_SIZE.menu} />}
              iconClassName="top-chrome-more-item-icon"
              label="Appearance settings"
              labelClassName="top-chrome-more-item-label"
              onClick={openAppearanceSettings}
              role="menuitem"
            />
          ) : null}
        </MenuSurface>,
        document.body,
      ) : null}
    </header>
  );
}
