import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_AGENT_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_AGENT_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_AGENT_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampAgentRailForPanelFloor,
  clampRailWidthsForPanelFloor,
  panelCountFitsAtMinimumRails,
  type ResponsiveRailState,
  type WorkspaceLayoutMetrics,
} from '../../src/renderer/ui/workspaceResponsiveLayout';

const tokenSource = readFileSync('src/renderer/styles/tokens.css', 'utf8');

function tokenPx(name: string): number {
  const match = new RegExp(`--${name}:\\s*(\\d+)px;`).exec(tokenSource);
  expect(match, `missing --${name}`).not.toBeNull();
  return Number(match![1]);
}

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
  test('keeps responsive rail constants aligned with design tokens', () => {
    expect({
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      sidebarMinWidth: MIN_SIDEBAR_WIDTH,
      sidebarMaxWidth: MAX_SIDEBAR_WIDTH,
      agentWidth: DEFAULT_AGENT_WIDTH,
      agentMinWidth: MIN_AGENT_WIDTH,
      agentMaxWidth: MAX_AGENT_WIDTH,
    }).toEqual({
      sidebarWidth: tokenPx('sidebar-width'),
      sidebarMinWidth: tokenPx('sidebar-min-width'),
      sidebarMaxWidth: tokenPx('sidebar-max-width'),
      agentWidth: tokenPx('agent-width'),
      agentMinWidth: tokenPx('agent-min-width'),
      agentMaxWidth: tokenPx('agent-max-width'),
    });
  });

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

  test('agent reveal opening preserves the sidebar width while shrinking only the agent rail', () => {
    const next = clampAgentRailForPanelFloor(baseMetrics, {
      ...openRails,
      sidebarWidth: MAX_SIDEBAR_WIDTH,
      agentWidth: MAX_AGENT_WIDTH,
    }, 1);

    expect(next).toEqual({
      sidebarWidth: MAX_SIDEBAR_WIDTH,
      agentWidth: 308,
    });
  });

  test('agent reveal opening does not use the sidebar as overflow relief', () => {
    const next = clampAgentRailForPanelFloor({
      ...baseMetrics,
      canvasWidth: 760,
    }, openRails, 1);

    expect(next).toEqual({
      sidebarWidth: openRails.sidebarWidth,
      agentWidth: MIN_AGENT_WIDTH,
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
