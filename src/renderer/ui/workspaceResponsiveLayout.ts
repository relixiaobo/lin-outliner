export const DEFAULT_SIDEBAR_WIDTH = 196;
export const DEFAULT_AGENT_WIDTH = 344;
export const MIN_SIDEBAR_WIDTH = 152;
export const MAX_SIDEBAR_WIDTH = 280;
export const MIN_AGENT_WIDTH = 280;
export const MAX_AGENT_WIDTH = 520;
export const FALLBACK_PANEL_MIN_WIDTH = 360;
export const MAX_OUTLINE_INDENT_DEPTH = 12;

export type RailKind = 'sidebar' | 'agent';

export interface WorkspaceLayoutMetrics {
  canvasWidth: number;
  layoutGap: number;
  panelGap: number;
  panelMinWidth: number;
}

export interface ResponsiveRailState {
  sidebarWidth: number;
  agentWidth: number;
  sidebarOpen: boolean;
  agentOpen: boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readCssPx(element: HTMLElement, property: string, fallback: number) {
  const raw = getComputedStyle(element).getPropertyValue(property);
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function workspaceLayoutMetricsFromCanvas(canvas: HTMLElement): WorkspaceLayoutMetrics {
  return {
    canvasWidth: canvas.getBoundingClientRect().width,
    layoutGap: readCssPx(canvas, '--layout-gap', 0),
    panelGap: readCssPx(canvas, '--panel-gap', 0),
    panelMinWidth: readCssPx(canvas, '--outline-panel-min-width', FALLBACK_PANEL_MIN_WIDTH),
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

export function panelCountFits(
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

function railMin(kind: RailKind) {
  return kind === 'sidebar' ? MIN_SIDEBAR_WIDTH : MIN_AGENT_WIDTH;
}

function railMax(kind: RailKind) {
  return kind === 'sidebar' ? MAX_SIDEBAR_WIDTH : MAX_AGENT_WIDTH;
}

function railOpen(rails: ResponsiveRailState, kind: RailKind) {
  return kind === 'sidebar' ? rails.sidebarOpen : rails.agentOpen;
}

function otherRailReservedWidth(metrics: WorkspaceLayoutMetrics, rails: ResponsiveRailState, kind: RailKind) {
  return kind === 'sidebar'
    ? railReservedWidth(rails.agentWidth, rails.agentOpen, metrics.layoutGap)
    : railReservedWidth(rails.sidebarWidth, rails.sidebarOpen, metrics.layoutGap);
}

export function maxRailWidthForPanelFloor(
  metrics: WorkspaceLayoutMetrics,
  rails: ResponsiveRailState,
  kind: RailKind,
  panelCount: number,
) {
  if (!railOpen(rails, kind)) return railMax(kind);
  return metrics.canvasWidth
    - otherRailReservedWidth(metrics, rails, kind)
    - metrics.layoutGap * 2
    - panelFloorWidth(metrics, panelCount);
}

export function clampRailWidthForPanelFloor(
  metrics: WorkspaceLayoutMetrics,
  rails: ResponsiveRailState,
  kind: RailKind,
  width: number,
  panelCount: number,
) {
  const min = railMin(kind);
  const max = Math.max(min, Math.min(railMax(kind), maxRailWidthForPanelFloor(metrics, rails, kind, panelCount)));
  return clamp(width, min, max);
}

export function clampRailWidthsForPanelFloor(
  metrics: WorkspaceLayoutMetrics,
  rails: ResponsiveRailState,
  panelCount: number,
) {
  const next = {
    sidebarWidth: clamp(rails.sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
    agentWidth: clamp(rails.agentWidth, MIN_AGENT_WIDTH, MAX_AGENT_WIDTH),
  };
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
