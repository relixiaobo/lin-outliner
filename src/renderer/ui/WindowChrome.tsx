import { CollapseAgentPanelIcon, CollapseSidebarIcon, ExpandAgentPanelIcon, ExpandSidebarIcon, ICON_SIZE } from './icons';
import { IconButton } from './primitives/IconButton';
import { useT } from '../i18n/I18nProvider';

interface WindowChromeProps {
  agentOpen: boolean;
  sidebarOpen: boolean;
  onToggleAgent: () => void;
  onToggleSidebar: () => void;
}

// Persistent, window-anchored chrome that survives the dissolved TopBar, laid out in
// two CORNER drag zones (left / right): the sidebar toggle (left, beside the traffic
// lights) and the agent toggle (right corner). The zones are the window's title-bar
// drag regions at the two ends; the centre of the band is left uncovered so the pane
// breadcrumb (which reaches the top now) owns it. Each toggle is a no-drag DOM CHILD
// of its zone — the only reliable carve-out from a drag region on macOS (see
// shell.css). Toggles stay put when a rail collapses. Page-nav back/forward live on
// Cmd+[ / Cmd+] (no chrome buttons — they read as cluttered next to the toggle); the
// breadcrumb keeps a per-pane back. The traffic-light geometry and the derived
// --chrome-control-inset / zone widths live on :root, injected from
// core/chromeGeometry.ts in main.tsx (CSS fallbacks in tokens.css), so the chrome
// tracks the OS window controls with no JS-side duplicate to drift.
export function WindowChrome(props: WindowChromeProps) {
  const t = useT();
  const sidebarToggleLabel = props.sidebarOpen ? t.shell.chrome.collapseSidebar : t.shell.chrome.expandSidebar;
  const agentToggleLabel = props.agentOpen ? t.shell.chrome.collapseAgent : t.shell.chrome.expandAgent;
  return (
    <>
      <div className="window-chrome-zone window-chrome-zone-left">
        <div className="window-chrome-cluster window-chrome-cluster-left">
          <IconButton
            className="rail-toggle sidebar-toggle"
            aria-expanded={props.sidebarOpen}
            icon={props.sidebarOpen ? CollapseSidebarIcon : ExpandSidebarIcon}
            iconSize={ICON_SIZE.toolbar}
            label={sidebarToggleLabel}
            onClick={props.onToggleSidebar}
            title={sidebarToggleLabel}
            variant="chrome"
          />
        </div>
      </div>

      <div className="window-chrome-zone window-chrome-zone-right">
        <div className="window-chrome-cluster window-chrome-cluster-right">
          <IconButton
            className="rail-toggle agent-toggle"
            aria-expanded={props.agentOpen}
            icon={props.agentOpen ? CollapseAgentPanelIcon : ExpandAgentPanelIcon}
            iconSize={ICON_SIZE.toolbar}
            label={agentToggleLabel}
            onClick={props.onToggleAgent}
            title={agentToggleLabel}
            variant="chrome"
          />
        </div>
      </div>
    </>
  );
}
