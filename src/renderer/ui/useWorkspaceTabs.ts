import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentProjection, NodeId } from '../api/types';
import type { OutlinePanelState, WorkspacePanelState, WorkspaceTabState } from './workspaceLayoutTypes';

let nextWorkspaceId = 0;
const STORAGE_KEY = 'lin-outliner:workspace-layout:v1';
const MAX_PERSISTED_TABS = 12;
const MAX_PERSISTED_PANELS = 4;
const MAX_PANEL_PAGE_HISTORY = 50;

function nextId(prefix: string) {
  nextWorkspaceId += 1;
  return `${prefix}-${nextWorkspaceId}`;
}

function rememberId(id: string) {
  const match = id.match(/-(\d+)$/);
  if (!match) return;
  nextWorkspaceId = Math.max(nextWorkspaceId, Number(match[1]));
}

function defaultTabs(initial: DocumentProjection): { activeTabId: string; tabs: WorkspaceTabState[] } {
  const firstPanelId = nextId('panel');
  const secondPanelId = nextId('panel');
  const firstTabId = nextId('tab');
  return {
    activeTabId: firstTabId,
    tabs: [{
      id: firstTabId,
      activePanelId: firstPanelId,
      panelSizes: {
        [firstPanelId]: 1,
        [secondPanelId]: 1,
      },
      panels: [
        outlinerPanel(firstPanelId, initial.todayId),
        outlinerPanel(secondPanelId, initial.rootId),
      ],
    }],
  };
}

function isOutlinerPanel(panel: WorkspacePanelState | null | undefined): panel is OutlinePanelState {
  return panel?.type === 'outliner';
}

function outlinerPanel(id: string, rootId: NodeId): OutlinePanelState {
  return { id, type: 'outliner', rootId, pageBackStack: [], pageForwardStack: [] };
}

function navigateOutlinerPanel(panel: OutlinePanelState, rootId: NodeId): OutlinePanelState {
  if (panel.rootId === rootId) return panel;
  return {
    ...panel,
    rootId,
    pageBackStack: [...(panel.pageBackStack ?? []), panel.rootId].slice(-MAX_PANEL_PAGE_HISTORY),
    pageForwardStack: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizePanel(value: unknown, nodeIds: Set<NodeId>): WorkspacePanelState | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  rememberId(value.id);
  if (value.type === 'agent-debug') {
    return {
      id: value.id,
      type: 'agent-debug',
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    };
  }
  if (typeof value.rootId !== 'string' || !nodeIds.has(value.rootId)) return null;
  const pageBackStack = (Array.isArray(value.pageBackStack) ? value.pageBackStack : [])
    .filter((nodeId): nodeId is NodeId => typeof nodeId === 'string' && nodeIds.has(nodeId))
    .slice(-MAX_PANEL_PAGE_HISTORY);
  const pageForwardStack = (Array.isArray(value.pageForwardStack) ? value.pageForwardStack : [])
    .filter((nodeId): nodeId is NodeId => typeof nodeId === 'string' && nodeIds.has(nodeId))
    .slice(-MAX_PANEL_PAGE_HISTORY);
  return { id: value.id, type: 'outliner', rootId: value.rootId, pageBackStack, pageForwardStack };
}

function sanitizeTab(value: unknown, nodeIds: Set<NodeId>): WorkspaceTabState | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.panels)) return null;
  const panels = value.panels
    .slice(0, MAX_PERSISTED_PANELS)
    .map((panel) => sanitizePanel(panel, nodeIds))
    .filter((panel): panel is WorkspacePanelState => Boolean(panel));
  if (panels.length === 0) return null;

  rememberId(value.id);
  const panelIds = new Set(panels.map((panel) => panel.id));
  const activePanelId = typeof value.activePanelId === 'string' && panelIds.has(value.activePanelId)
    ? value.activePanelId
    : panels[0].id;
  const persistedSizes = isRecord(value.panelSizes) ? value.panelSizes : {};
  const panelSizes = Object.fromEntries(panels.map((panel) => {
    const size = persistedSizes[panel.id];
    return [panel.id, typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 1];
  }));
  return {
    id: value.id,
    activePanelId,
    panelSizes,
    panels,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 80) : undefined,
  };
}

function loadPersistedTabs(initial: DocumentProjection): { activeTabId: string; tabs: WorkspaceTabState[] } | null {
  const nodeIds = new Set(initial.nodes.map((node) => node.id));
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs
      .slice(0, MAX_PERSISTED_TABS)
      .map((tab) => sanitizeTab(tab, nodeIds))
      .filter((tab): tab is WorkspaceTabState => Boolean(tab));
    if (tabs.length === 0) return null;
    const activeTabId = typeof parsed.activeTabId === 'string' && tabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId
      : tabs[0].id;
    return { activeTabId, tabs };
  } catch {
    return null;
  }
}

function persistTabs(activeTabId: string | null, tabs: WorkspaceTabState[]) {
  if (!activeTabId || tabs.length === 0) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      activeTabId,
      tabs,
    }));
  } catch {
    // Best-effort UI state only.
  }
}

interface UseWorkspaceTabsOptions {
  focusNode: (nodeId: NodeId | null) => void;
}

export function useWorkspaceTabs({ focusNode }: UseWorkspaceTabsOptions) {
  const [tabs, setTabs] = useState<WorkspaceTabState[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const activePanelIndex = activeTab
    ? Math.max(0, activeTab.panels.findIndex((panel) => panel.id === activeTab.activePanelId))
    : 0;
  const activePanel = activeTab?.panels[activePanelIndex] ?? null;
  const activeOutlinerPanel = isOutlinerPanel(activePanel)
    ? activePanel
    : activeTab?.panels.find(isOutlinerPanel) ?? null;
  const rootId = activeOutlinerPanel?.rootId ?? null;

  const initializeTabs = useCallback((initial: DocumentProjection) => {
    const layout = loadPersistedTabs(initial) ?? defaultTabs(initial);
    setTabs(layout.tabs);
    setActiveTabId(layout.activeTabId);
    initializedRef.current = true;
    const activeLayoutTab = layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? layout.tabs[0];
    const activeLayoutPanel = activeLayoutTab.panels.find((panel) => panel.id === activeLayoutTab.activePanelId)
      ?? activeLayoutTab.panels[0];
    return isOutlinerPanel(activeLayoutPanel)
      ? activeLayoutPanel.rootId
      : activeLayoutTab.panels.find(isOutlinerPanel)?.rootId ?? initial.todayId;
  }, []);

  useEffect(() => {
    if (!initializedRef.current) return;
    persistTabs(activeTabId, tabs);
  }, [activeTabId, tabs]);

  const updateActiveTab = useCallback((updater: (tab: WorkspaceTabState) => WorkspaceTabState) => {
    setTabs((prev) => prev.map((tab) => (tab.id === activeTabId ? updater(tab) : tab)));
  }, [activeTabId]);

  const navigateRoot = useCallback((nodeId: NodeId) => {
    updateActiveTab((tab) => {
      const activePanel = tab.panels.find((panel) => panel.id === tab.activePanelId);
      const targetPanel = isOutlinerPanel(activePanel) ? activePanel : tab.panels.find(isOutlinerPanel);
      const activePanelId = targetPanel?.id;
      if (!activePanelId) {
        const panelId = nextId('panel');
        return {
          ...tab,
          activePanelId: panelId,
          panelSizes: { [panelId]: 1 },
          panels: [outlinerPanel(panelId, nodeId)],
        };
      }
      return {
        ...tab,
        activePanelId,
        panels: tab.panels.map((panel) => (
          panel.id === activePanelId && isOutlinerPanel(panel) ? navigateOutlinerPanel(panel, nodeId) : panel
        )),
      };
    });
    focusNode(nodeId);
  }, [focusNode, updateActiveTab]);

  const activatePanel = useCallback((panel: WorkspacePanelState) => {
    updateActiveTab((tab) => ({ ...tab, activePanelId: panel.id }));
  }, [updateActiveTab]);

  const navigatePanelRoot = useCallback((panelId: string, nodeId: NodeId) => {
    updateActiveTab((tab) => ({
      ...tab,
      activePanelId: panelId,
      panels: tab.panels.map((panel) => (
        panel.id === panelId && isOutlinerPanel(panel) ? navigateOutlinerPanel(panel, nodeId) : panel
      )),
    }));
    focusNode(nodeId);
  }, [focusNode, updateActiveTab]);

  const navigatePanelBack = useCallback((panelId: string): NodeId | null => {
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    const panel = tab?.panels.find((candidate) => candidate.id === panelId);
    const previousRootId = isOutlinerPanel(panel) ? panel.pageBackStack?.at(-1) ?? null : null;
    if (!previousRootId) return null;

    setTabs((prev) => prev.map((candidateTab) => (
      candidateTab.id !== activeTabId
        ? candidateTab
        : {
          ...candidateTab,
          activePanelId: panelId,
          panels: candidateTab.panels.map((candidatePanel) => (
            candidatePanel.id === panelId && isOutlinerPanel(candidatePanel)
              ? {
                ...candidatePanel,
                rootId: previousRootId,
                pageBackStack: (candidatePanel.pageBackStack ?? []).slice(0, -1),
                pageForwardStack: [...(candidatePanel.pageForwardStack ?? []), candidatePanel.rootId]
                  .slice(-MAX_PANEL_PAGE_HISTORY),
              }
              : candidatePanel
          )),
        }
    )));
    focusNode(previousRootId);
    return previousRootId;
  }, [activeTabId, focusNode, tabs]);

  const navigatePanelForward = useCallback((panelId: string): NodeId | null => {
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    const panel = tab?.panels.find((candidate) => candidate.id === panelId);
    const nextRootId = isOutlinerPanel(panel) ? panel.pageForwardStack?.at(-1) ?? null : null;
    if (!nextRootId) return null;

    setTabs((prev) => prev.map((candidateTab) => (
      candidateTab.id !== activeTabId
        ? candidateTab
        : {
          ...candidateTab,
          activePanelId: panelId,
          panels: candidateTab.panels.map((candidatePanel) => (
            candidatePanel.id === panelId && isOutlinerPanel(candidatePanel)
              ? {
                ...candidatePanel,
                rootId: nextRootId,
                pageBackStack: [...(candidatePanel.pageBackStack ?? []), candidatePanel.rootId]
                  .slice(-MAX_PANEL_PAGE_HISTORY),
                pageForwardStack: (candidatePanel.pageForwardStack ?? []).slice(0, -1),
              }
              : candidatePanel
          )),
        }
    )));
    focusNode(nextRootId);
    return nextRootId;
  }, [activeTabId, focusNode, tabs]);

  const closePanel = useCallback((panelId: string) => {
    updateActiveTab((tab) => {
      if (tab.panels.length <= 1) return tab;
      const panelIndex = tab.panels.findIndex((panel) => panel.id === panelId);
      const nextPanels = tab.panels.filter((panel) => panel.id !== panelId);
      const nextPanelSizes = { ...tab.panelSizes };
      delete nextPanelSizes[panelId];
      const nextActiveIndex = Math.max(0, Math.min(panelIndex, nextPanels.length - 1));
      const nextActivePanel = nextPanels[nextActiveIndex];
      if (tab.activePanelId === panelId && isOutlinerPanel(nextActivePanel)) {
        focusNode(nextActivePanel.rootId);
      }
      return {
        ...tab,
        activePanelId: nextActivePanel?.id ?? tab.activePanelId,
        panelSizes: nextPanelSizes,
        panels: nextPanels,
      };
    });
  }, [focusNode, updateActiveTab]);

  const selectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    const nextTab = tabs.find((tab) => tab.id === tabId);
    const nextPanel = nextTab?.panels.find((panel) => panel.id === nextTab.activePanelId)
      ?? nextTab?.panels[0];
    if (isOutlinerPanel(nextPanel)) {
      focusNode(nextPanel.rootId);
    }
  }, [focusNode, tabs]);

  const createTab = useCallback(() => {
    if (!rootId) return;
    const panelId = nextId('panel');
    const tabId = nextId('tab');
    setTabs((prev) => [
      ...prev,
      {
        id: tabId,
        activePanelId: panelId,
        panelSizes: { [panelId]: 1 },
        panels: [outlinerPanel(panelId, rootId)],
      },
    ]);
    setActiveTabId(tabId);
    focusNode(rootId);
  }, [focusNode, rootId]);

  const openPanel = useCallback((nodeId: NodeId | null = rootId) => {
    if (!nodeId) return;
    const panelId = nextId('panel');
    updateActiveTab((tab) => {
      if (tab.panels.length >= MAX_PERSISTED_PANELS) {
        const lastPanel = tab.panels.at(-1);
        if (!lastPanel) return tab;
        return {
          ...tab,
          activePanelId: lastPanel.id,
          panels: tab.panels.map((panel) => (
            panel.id === lastPanel.id ? outlinerPanel(panel.id, nodeId) : panel
          )),
        };
      }
      return {
        ...tab,
        activePanelId: panelId,
        panelSizes: {
          ...tab.panelSizes,
          [panelId]: 1,
        },
        panels: [
          ...tab.panels,
          outlinerPanel(panelId, nodeId),
        ],
      };
    });
    focusNode(nodeId);
  }, [focusNode, rootId, updateActiveTab]);

  const openAgentDebugPanel = useCallback((sessionId: string | null) => {
    const panelId = nextId('panel');
    updateActiveTab((tab) => {
      const existing = tab.panels.find((panel) => (
        panel.type === 'agent-debug' && panel.sessionId === sessionId
      ));
      if (existing) return { ...tab, activePanelId: existing.id };

      const emptyDebugPanel = sessionId
        ? tab.panels.find((panel) => panel.type === 'agent-debug' && panel.sessionId === null)
        : null;
      if (emptyDebugPanel) {
        return {
          ...tab,
          activePanelId: emptyDebugPanel.id,
          panels: tab.panels.map((panel) => (
            panel.id === emptyDebugPanel.id
              ? { id: panel.id, type: 'agent-debug', sessionId }
              : panel
          )),
        };
      }

      if (tab.panels.length >= MAX_PERSISTED_PANELS) {
        const replacePanel = [...tab.panels].reverse().find((panel) => panel.type === 'agent-debug') ?? tab.panels.at(-1);
        if (!replacePanel) return tab;
        return {
          ...tab,
          activePanelId: replacePanel.id,
          panels: tab.panels.map((panel) => (
            panel.id === replacePanel.id
              ? { id: panel.id, type: 'agent-debug', sessionId }
              : panel
          )),
        };
      }

      return {
        ...tab,
        activePanelId: panelId,
        panelSizes: {
          ...tab.panelSizes,
          [panelId]: 1,
        },
        panels: [
          ...tab.panels,
          { id: panelId, type: 'agent-debug', sessionId },
        ],
      };
    });
  }, [updateActiveTab]);

  const closeTab = useCallback((tabId: string) => {
    if (tabs.length <= 1) return;
    const tabIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex < 0) return;
    const nextTabs = tabs.filter((tab) => tab.id !== tabId);
    const nextActiveIndex = Math.max(0, Math.min(tabIndex, nextTabs.length - 1));
    const nextActiveTab = nextTabs[nextActiveIndex];
    setTabs(nextTabs);
    if (activeTabId === tabId) {
      setActiveTabId(nextActiveTab.id);
      const nextPanel = nextActiveTab.panels.find((panel) => panel.id === nextActiveTab.activePanelId)
        ?? nextActiveTab.panels[0];
      focusNode(isOutlinerPanel(nextPanel) ? nextPanel.rootId : null);
    }
  }, [activeTabId, focusNode, tabs]);

  const resizePanelPair = useCallback((
    tabId: string,
    leftPanelId: string,
    rightPanelId: string,
    leftSize: number,
    rightSize: number,
  ) => {
    setTabs((prev) => prev.map((tab) => (
      tab.id === tabId
        ? {
          ...tab,
          panelSizes: {
            ...tab.panelSizes,
            [leftPanelId]: leftSize,
            [rightPanelId]: rightSize,
          },
        }
        : tab
    )));
  }, []);

  return {
    activePanel,
    activeOutlinerPanel,
    activeTab,
    activeTabId,
    activatePanel,
    closePanel,
    closeTab,
    createTab,
    initializeTabs,
    navigatePanelRoot,
    navigatePanelBack,
    navigatePanelForward,
    navigateRoot,
    openAgentDebugPanel,
    openPanel,
    resizePanelPair,
    rootId,
    selectTab,
    tabs,
  };
}
