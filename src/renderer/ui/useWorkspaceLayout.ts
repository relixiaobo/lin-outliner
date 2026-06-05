import { useCallback, useEffect, useRef, useState } from 'react';
import { todayIsoLocalDate, type DocumentProjection, type NodeId } from '../api/types';
import type { NavigateRootOptions } from './shared';
import type {
  AgentDebugPanelState,
  OutlinePanelState,
  WorkspaceLayout,
  WorkspacePanelState,
} from './workspaceLayoutTypes';

let nextWorkspaceId = 0;
const STORAGE_KEY = 'lin-outliner:workspace-layout:v2';
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

function defaultLayout(initial: DocumentProjection): WorkspaceLayout {
  // Default to a single pane on Today; the user opens split panes on demand
  // (Cmd/Ctrl+click a reference, sidebar Alt+click, or "Open in split pane").
  const firstPanelId = nextId('panel');
  return {
    activePanelId: firstPanelId,
    panels: [outlinerPanel(firstPanelId, initial.todayId)],
  };
}

function isOutlinerPanel(panel: WorkspacePanelState | null | undefined): panel is OutlinePanelState {
  return panel?.type === 'outliner';
}

function outlinerPanel(id: string, rootId: NodeId, size = 1): OutlinePanelState {
  return { id, type: 'outliner', rootId, size, pageBackStack: [], pageForwardStack: [] };
}

function agentDebugPanel(id: string, sessionId: string | null, size = 1): AgentDebugPanelState {
  return { id, type: 'agent-debug', sessionId, size };
}

function navigateOutlinerPanel(panel: OutlinePanelState, rootId: NodeId): OutlinePanelState {
  if (panel.rootId === rootId) return panel;
  return {
    ...panel,
    rootId,
    pageBackStack: [...panel.pageBackStack, panel.rootId].slice(-MAX_PANEL_PAGE_HISTORY),
    pageForwardStack: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sanitizeSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function sanitizePanel(value: unknown, nodeIds: Set<NodeId>): WorkspacePanelState | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  rememberId(value.id);
  const size = sanitizeSize(value.size);
  if (value.type === 'agent-debug') {
    return {
      id: value.id,
      type: 'agent-debug',
      size,
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
  return { id: value.id, type: 'outliner', size, rootId: value.rootId, pageBackStack, pageForwardStack };
}

function sanitizeLayout(value: unknown, nodeIds: Set<NodeId>): WorkspaceLayout | null {
  if (!isRecord(value) || !Array.isArray(value.panels)) return null;
  const panels = value.panels
    .slice(0, MAX_PERSISTED_PANELS)
    .map((panel) => sanitizePanel(panel, nodeIds))
    .filter((panel): panel is WorkspacePanelState => Boolean(panel));
  if (panels.length === 0) return null;
  // The canvas is anchored by an outliner pane (it carries `rootId` + focus). A
  // restored layout of only agent-debug panes has nothing to anchor, so treat it
  // as corrupt and fall back to the default single pane rather than booting into
  // a rootless canvas.
  if (!panels.some(isOutlinerPanel)) return null;

  const panelIds = new Set(panels.map((panel) => panel.id));
  const activePanelId = typeof value.activePanelId === 'string' && panelIds.has(value.activePanelId)
    ? value.activePanelId
    : panels[0].id;
  return { activePanelId, panels };
}

function loadPersistedLayout(initial: DocumentProjection): WorkspaceLayout | null {
  const nodeIds = new Set(initial.nodes.map((node) => node.id));
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 2) return null;
    if (parsed.localDate !== todayIsoLocalDate()) return null;
    return sanitizeLayout(parsed, nodeIds);
  } catch {
    return null;
  }
}

function persistLayout(activePanelId: string | null, panels: WorkspacePanelState[]) {
  if (!activePanelId || panels.length === 0) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2,
      localDate: todayIsoLocalDate(),
      activePanelId,
      panels,
    }));
  } catch {
    // Best-effort UI state only.
  }
}

interface UseWorkspaceLayoutOptions {
  focusNode: (nodeId: NodeId | null) => void;
}

interface InitializedWorkspaceLayout {
  focusRootId: NodeId;
  outlinerRootIds: NodeId[];
}

export function useWorkspaceLayout({ focusNode }: UseWorkspaceLayoutOptions) {
  const [panels, setPanels] = useState<WorkspacePanelState[]>([]);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const activePanelIndex = Math.max(0, panels.findIndex((panel) => panel.id === activePanelId));
  const activePanel = panels[activePanelIndex] ?? null;
  // Strict: the active pane, but only when it is an outliner. Targeted operations
  // that act on "the active pane's outliner" — page history (Cmd+[ / Cmd+]) and
  // "open the active root in a pane" (Cmd+M) — key off this, so they no-op when a
  // debug pane is active rather than silently reaching across to another pane.
  const activeOutlinerPanel = isOutlinerPanel(activePanel) ? activePanel : null;
  // Ambient: the active outliner if any, else the first outliner on the canvas.
  // For non-targeted UI (sidebar root highlight, drag-selection scope) where "the
  // outliner the user is looking at" is good enough even while a debug pane holds
  // the active slot.
  const ambientOutlinerPanel = activeOutlinerPanel ?? panels.find(isOutlinerPanel) ?? null;
  const rootId = ambientOutlinerPanel?.rootId ?? null;

  const initializeLayout = useCallback((initial: DocumentProjection): InitializedWorkspaceLayout => {
    const layout = loadPersistedLayout(initial) ?? defaultLayout(initial);
    setPanels(layout.panels);
    setActivePanelId(layout.activePanelId);
    initializedRef.current = true;
    const activeLayoutPanel = layout.panels.find((panel) => panel.id === layout.activePanelId)
      ?? layout.panels[0];
    const focusRootId = isOutlinerPanel(activeLayoutPanel)
      ? activeLayoutPanel.rootId
      : layout.panels.find(isOutlinerPanel)?.rootId ?? initial.todayId;
    return {
      focusRootId,
      outlinerRootIds: layout.panels
        .filter(isOutlinerPanel)
        .map((panel) => panel.rootId),
    };
  }, []);

  useEffect(() => {
    if (!initializedRef.current) return;
    persistLayout(activePanelId, panels);
  }, [activePanelId, panels]);

  const navigateRoot = useCallback((nodeId: NodeId, options?: NavigateRootOptions) => {
    const current = panels.find((panel) => panel.id === activePanelId);
    const targetPanel = isOutlinerPanel(current) ? current : panels.find(isOutlinerPanel);
    if (targetPanel) {
      setActivePanelId(targetPanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === targetPanel.id && isOutlinerPanel(panel) ? navigateOutlinerPanel(panel, nodeId) : panel
      )));
    } else if (panels.length < MAX_PERSISTED_PANELS) {
      // No outliner pane (only debug panes) but room to add one: append rather
      // than replace the whole canvas, so the debug panes survive.
      const panelId = nextId('panel');
      setActivePanelId(panelId);
      setPanels((prev) => [...prev, outlinerPanel(panelId, nodeId)]);
    } else {
      // No outliner pane and no room: repurpose the active pane in place. Only the
      // active pane is converted — every other (debug) pane is preserved.
      const replaceId = current?.id ?? panels.at(-1)?.id;
      if (!replaceId) return;
      setActivePanelId(replaceId);
      setPanels((prev) => prev.map((panel) => (
        panel.id === replaceId ? outlinerPanel(panel.id, nodeId, panel.size) : panel
      )));
    }
    focusNode(options?.focus === false ? null : nodeId);
  }, [activePanelId, focusNode, panels]);

  const activatePanel = useCallback((panel: WorkspacePanelState) => {
    setActivePanelId(panel.id);
  }, []);

  const navigatePanelRoot = useCallback((panelId: string, nodeId: NodeId, options?: NavigateRootOptions) => {
    setActivePanelId(panelId);
    setPanels((prev) => prev.map((panel) => (
      panel.id === panelId && isOutlinerPanel(panel) ? navigateOutlinerPanel(panel, nodeId) : panel
    )));
    focusNode(options?.focus === false ? null : nodeId);
  }, [focusNode]);

  const navigatePanelBack = useCallback((panelId: string): NodeId | null => {
    const panel = panels.find((candidate) => candidate.id === panelId);
    const previousRootId = isOutlinerPanel(panel) ? panel.pageBackStack.at(-1) ?? null : null;
    if (!previousRootId) return null;

    setActivePanelId(panelId);
    setPanels((prev) => prev.map((candidate) => (
      candidate.id === panelId && isOutlinerPanel(candidate)
        ? {
          ...candidate,
          rootId: previousRootId,
          pageBackStack: candidate.pageBackStack.slice(0, -1),
          pageForwardStack: [...candidate.pageForwardStack, candidate.rootId]
            .slice(-MAX_PANEL_PAGE_HISTORY),
        }
        : candidate
    )));
    focusNode(previousRootId);
    return previousRootId;
  }, [focusNode, panels]);

  const navigatePanelForward = useCallback((panelId: string): NodeId | null => {
    const panel = panels.find((candidate) => candidate.id === panelId);
    const nextRootId = isOutlinerPanel(panel) ? panel.pageForwardStack.at(-1) ?? null : null;
    if (!nextRootId) return null;

    setActivePanelId(panelId);
    setPanels((prev) => prev.map((candidate) => (
      candidate.id === panelId && isOutlinerPanel(candidate)
        ? {
          ...candidate,
          rootId: nextRootId,
          pageBackStack: [...candidate.pageBackStack, candidate.rootId]
            .slice(-MAX_PANEL_PAGE_HISTORY),
          pageForwardStack: candidate.pageForwardStack.slice(0, -1),
        }
        : candidate
    )));
    focusNode(nextRootId);
    return nextRootId;
  }, [focusNode, panels]);

  const closePanel = useCallback((panelId: string) => {
    if (panels.length <= 1) return;
    const panelIndex = panels.findIndex((panel) => panel.id === panelId);
    if (panelIndex < 0) return;
    const nextPanels = panels.filter((panel) => panel.id !== panelId);
    const nextActiveIndex = Math.max(0, Math.min(panelIndex, nextPanels.length - 1));
    const nextActivePanel = nextPanels[nextActiveIndex];
    setPanels(nextPanels);
    if (activePanelId === panelId) {
      setActivePanelId(nextActivePanel.id);
      // Move focus to the next pane's root, or clear it when that pane is a debug
      // pane — leaving focus on a node from the just-closed outliner would surface
      // a stale focused node to the agent view-context.
      focusNode(isOutlinerPanel(nextActivePanel) ? nextActivePanel.rootId : null);
    }
  }, [activePanelId, focusNode, panels]);

  const openPanel = useCallback((nodeId: NodeId | null = rootId) => {
    if (!nodeId) return;
    const keepActive = (panelId: string) => {
      setActivePanelId(panelId);
      window.requestAnimationFrame(() => setActivePanelId(panelId));
    };
    if (panels.length >= MAX_PERSISTED_PANELS) {
      // At the cap, repurpose an existing outliner pane (rightmost first) so a
      // debug session is never silently dropped — symmetric with how
      // openAgentDebugPanel reverse-finds a debug pane. Falls back to the last
      // pane only if somehow none is an outliner.
      const replacePanel = [...panels].reverse().find(isOutlinerPanel) ?? panels.at(-1);
      if (!replacePanel) return;
      keepActive(replacePanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === replacePanel.id ? outlinerPanel(panel.id, nodeId, panel.size) : panel
      )));
    } else {
      const panelId = nextId('panel');
      keepActive(panelId);
      setPanels((prev) => [...prev, outlinerPanel(panelId, nodeId)]);
    }
    focusNode(nodeId);
  }, [focusNode, panels, rootId]);

  const openAgentDebugPanel = useCallback((sessionId: string | null) => {
    const existing = panels.find((panel) => (
      panel.type === 'agent-debug' && panel.sessionId === sessionId
    ));
    if (existing) {
      setActivePanelId(existing.id);
      return;
    }

    const emptyDebugPanel = sessionId
      ? panels.find((panel) => panel.type === 'agent-debug' && panel.sessionId === null)
      : null;
    if (emptyDebugPanel) {
      setActivePanelId(emptyDebugPanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === emptyDebugPanel.id ? agentDebugPanel(panel.id, sessionId, panel.size) : panel
      )));
      return;
    }

    if (panels.length >= MAX_PERSISTED_PANELS) {
      const replacePanel = [...panels].reverse().find((panel) => panel.type === 'agent-debug') ?? panels.at(-1);
      if (!replacePanel) return;
      setActivePanelId(replacePanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === replacePanel.id ? agentDebugPanel(panel.id, sessionId, panel.size) : panel
      )));
      return;
    }

    const panelId = nextId('panel');
    setActivePanelId(panelId);
    setPanels((prev) => [...prev, agentDebugPanel(panelId, sessionId)]);
  }, [panels]);

  const resizePanelPair = useCallback((
    leftPanelId: string,
    rightPanelId: string,
    leftSize: number,
    rightSize: number,
  ) => {
    setPanels((prev) => prev.map((panel) => {
      if (panel.id === leftPanelId) return { ...panel, size: leftSize };
      if (panel.id === rightPanelId) return { ...panel, size: rightSize };
      return panel;
    }));
  }, []);

  return {
    activePanel,
    activeOutlinerPanel,
    activePanelId,
    activatePanel,
    closePanel,
    initializeLayout,
    navigatePanelRoot,
    navigatePanelBack,
    navigatePanelForward,
    navigateRoot,
    openAgentDebugPanel,
    openPanel,
    panels,
    resizePanelPair,
    rootId,
  };
}
