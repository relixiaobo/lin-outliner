import { describe, expect, test } from 'bun:test';
import {
  MAX_AGENT_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_AGENT_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampRailWidthsForPanelFloor,
  panelCountFitsAtMinimumRails,
  type ResponsiveRailState,
  type WorkspaceLayoutMetrics,
} from '../../src/renderer/ui/workspaceResponsiveLayout';

const baseMetrics: WorkspaceLayoutMetrics = {
  canvasWidth: 980,
  layoutGap: 8,
  panelGap: 8,
  panelMinWidth: 360,
};

const openRails: ResponsiveRailState = {
  sidebarWidth: 196,
  agentWidth: 344,
  sidebarOpen: true,
  agentOpen: true,
};

describe('workspace responsive layout', () => {
  test('shrinks the agent rail first when a window resize creates a pane deficit', () => {
    const next = clampRailWidthsForPanelFloor(baseMetrics, {
      ...openRails,
      sidebarWidth: MAX_SIDEBAR_WIDTH,
      agentWidth: MAX_AGENT_WIDTH,
    }, 1);

    expect(next).toEqual({
      sidebarWidth: MAX_SIDEBAR_WIDTH,
      agentWidth: 308,
    });
  });

  test('never shrinks rails below their own minimums when the pane floor cannot fully fit', () => {
    const next = clampRailWidthsForPanelFloor({
      ...baseMetrics,
      canvasWidth: 760,
    }, openRails, 1);

    expect(next).toEqual({
      sidebarWidth: MIN_SIDEBAR_WIDTH,
      agentWidth: MIN_AGENT_WIDTH,
    });
  });

  test('keeps the dragged sidebar at its preference while the agent yields first', () => {
    const next = clampRailWidthsForPanelFloor(baseMetrics, {
      ...openRails,
      sidebarWidth: MAX_SIDEBAR_WIDTH,
    }, 1);

    expect(next).toEqual({
      sidebarWidth: MAX_SIDEBAR_WIDTH,
      agentWidth: 308,
    });
  });

  test('rejects additional panes when even minimum rails cannot host the pane floor', () => {
    expect(panelCountFitsAtMinimumRails({
      ...baseMetrics,
      canvasWidth: 760,
    }, openRails, 2)).toBe(false);

    expect(panelCountFitsAtMinimumRails({
      ...baseMetrics,
      canvasWidth: 1200,
    }, openRails, 2)).toBe(true);
  });
});
