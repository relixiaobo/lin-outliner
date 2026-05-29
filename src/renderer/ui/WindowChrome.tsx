import type { CSSProperties } from 'react';
import {
  MAC_TRAFFIC_LIGHT_POSITION,
  MAC_TRAFFIC_LIGHT_SIZE,
} from '../../core/chromeGeometry';
import {
  AgentCollapseIcon,
  AgentExpandIcon,
  ICON_SIZE,
  SidebarCollapseIcon,
  SidebarExpandIcon,
} from './icons';
import { IconButton } from './primitives/IconButton';

interface WindowChromeProps {
  agentOpen: boolean;
  sidebarOpen: boolean;
  onToggleAgent: () => void;
  onToggleSidebar: () => void;
}

// The two symmetric rail toggles + the macOS traffic lights share a single
// horizontal centreline derived from the traffic-light geometry, so the toggle
// boxes never drift relative to the OS window controls. centre = y + size / 2.
type ChromeStyle = CSSProperties & Record<
  '--traffic-light-size' | '--traffic-light-x' | '--traffic-light-y' | '--chrome-centreline',
  string
>;

const TOGGLE_SIZE = 26;
const trafficLightCentre = MAC_TRAFFIC_LIGHT_POSITION.y + MAC_TRAFFIC_LIGHT_SIZE / 2;

const chromeStyle: ChromeStyle = {
  '--traffic-light-size': `${MAC_TRAFFIC_LIGHT_SIZE}px`,
  '--traffic-light-x': `${MAC_TRAFFIC_LIGHT_POSITION.x}px`,
  '--traffic-light-y': `${MAC_TRAFFIC_LIGHT_POSITION.y}px`,
  // Top offset that vertically centres a TOGGLE_SIZE control on the light centre.
  '--chrome-centreline': `${trafficLightCentre - TOGGLE_SIZE / 2}px`,
};

// Persistent, fixed window chrome that survives the dissolved TopBar:
//  • the sidebar toggle (top-left, beside the lights)
//  • the agent toggle (top-right corner)
// Both toggles are window chrome anchored to the window, not the rails — they
// stay put when a rail collapses. Toggles signal hover by colour, not a fill.
// Window dragging is provided by the per-pane breadcrumb headers and the sidebar
// rail-top (both -webkit-app-region: drag) — NOT a full-width overlay here, which
// would sit on top of these no-drag toggles and have the OS swallow their clicks.
export function WindowChrome(props: WindowChromeProps) {
  return (
    <div className="window-chrome" style={chromeStyle}>
      <IconButton
        className="rail-toggle sidebar-toggle"
        icon={props.sidebarOpen ? SidebarCollapseIcon : SidebarExpandIcon}
        iconSize={ICON_SIZE.toolbar}
        label={props.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        onClick={props.onToggleSidebar}
        strokeWidth={1.7}
        title={props.sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        variant="chrome"
      />

      <IconButton
        className="rail-toggle agent-toggle"
        icon={props.agentOpen ? AgentCollapseIcon : AgentExpandIcon}
        iconSize={ICON_SIZE.toolbar}
        label={props.agentOpen ? 'Collapse agent' : 'Expand agent'}
        onClick={props.onToggleAgent}
        strokeWidth={1.7}
        title={props.agentOpen ? 'Collapse agent' : 'Expand agent'}
        variant="chrome"
      />
    </div>
  );
}
