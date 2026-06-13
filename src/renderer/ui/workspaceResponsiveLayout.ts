export const DEFAULT_SIDEBAR_WIDTH = 196;
export const DEFAULT_AGENT_WIDTH = 344;
export const MIN_SIDEBAR_WIDTH = 152;
export const MAX_SIDEBAR_WIDTH = 280;
export const MIN_AGENT_WIDTH = 280;
export const MAX_AGENT_WIDTH = 520;
export const FALLBACK_PANEL_MIN_WIDTH = 360;
export const MAX_OUTLINE_INDENT_DEPTH = 12;

export interface WorkspaceLayoutMetrics {
  canvasWidth: number;
  layoutGap: number;
  panelGap: number;
  panelMinWidth: number;
}

export interface RailWidths {
  sidebarWidth: number;
  agentWidth: number;
}

export interface ResponsiveRailState extends RailWidths {
  sidebarOpen: boolean;
  agentOpen: boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readCssPx(style: CSSStyleDeclaration, property: string, fallback: number) {
  const raw = style.getPropertyValue(property);
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function workspaceLayoutMetricsFromCanvas(canvas: HTMLElement): WorkspaceLayoutMetrics {
  const style = getComputedStyle(canvas);
  return {
    canvasWidth: canvas.getBoundingClientRect().width,
    layoutGap: readCssPx(style, '--layout-gap', 0),
    panelGap: readCssPx(style, '--panel-gap', 0),
    panelMinWidth: readCssPx(style, '--outline-panel-min-width', FALLBACK_PANEL_MIN_WIDTH),
  };
}

export function panelFloorWidth(metrics: WorkspaceLayoutMetrics, panelCount: number) {
  const count = Math.max(0, panelCount);
  return metrics.panelMinWidth * count + metrics.panelGap * Math.max(0, count - 1);
}

function railReservedWidth(width: number, open: boolean, layoutGap: number) {
  return open ? width + layoutGap * 2 : 0;
}

export function availablePanelWidth(metrics: WorkspaceLayoutMetrics, rails: ResponsiveRailState) {
  return metrics.canvasWidth
    - railReservedWidth(rails.sidebarWidth, rails.sidebarOpen, metrics.layoutGap)
    - railReservedWidth(rails.agentWidth, rails.agentOpen, metrics.layoutGap);
}

function panelCountFits(
  metrics: WorkspaceLayoutMetrics,
  rails: ResponsiveRailState,
  panelCount: number,
) {
  return availablePanelWidth(metrics, rails) >= panelFloorWidth(metrics, panelCount);
}

export function panelCountFitsAtMinimumRails(
  metrics: WorkspaceLayoutMetrics,
  rails: ResponsiveRailState,
  panelCount: number,
) {
  return panelCountFits(metrics, {
    ...rails,
    sidebarWidth: rails.sidebarOpen ? MIN_SIDEBAR_WIDTH : rails.sidebarWidth,
    agentWidth: rails.agentOpen ? MIN_AGENT_WIDTH : rails.agentWidth,
  }, panelCount);
}

export function clampRailWidthsToLimits(rails: RailWidths): RailWidths {
  return {
    sidebarWidth: clamp(rails.sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
    agentWidth: clamp(rails.agentWidth, MIN_AGENT_WIDTH, MAX_AGENT_WIDTH),
  };
}

export function clampRailWidthsForPanelFloor(
  metrics: WorkspaceLayoutMetrics,
  rails: ResponsiveRailState,
  panelCount: number,
) {
  const next = clampRailWidthsToLimits(rails);
  const nextRails = { ...rails, ...next };
  let deficit = panelFloorWidth(metrics, panelCount) - availablePanelWidth(metrics, nextRails);

  if (deficit > 0 && rails.agentOpen) {
    const reduction = Math.min(deficit, next.agentWidth - MIN_AGENT_WIDTH);
    next.agentWidth -= reduction;
    deficit -= reduction;
  }

  if (deficit > 0 && rails.sidebarOpen) {
    const reduction = Math.min(deficit, next.sidebarWidth - MIN_SIDEBAR_WIDTH);
    next.sidebarWidth -= reduction;
  }

  return next;
}
