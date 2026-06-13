import { useCallback, useEffect, useRef, useState } from 'react';
import { todayIsoLocalDate, type DocumentProjection, type NodeId } from '../api/types';
import { previewTargetFromUnknown, previewTargetKey, type PreviewTarget } from '../../core/preview';
import type { NavigateRootOptions } from './shared';
import type {
  AgentDebugPanelState,
  OutlinerPanelView,
  PanelView,
  WorkspaceContentPanelState,
  WorkspaceLayout,
  WorkspacePanelState,
} from './workspaceLayoutTypes';
import { isRecord } from '../state/persistence';

let nextWorkspaceId = 0;
const STORAGE_KEY = 'lin-outliner:workspace-layout:v4';
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

function outlinerView(rootId: NodeId): OutlinerPanelView {
  return { kind: 'outliner', rootId };
}

function filePreviewView(target: PreviewTarget): PanelView {
  return { kind: 'file-preview', target };
}

function isWorkspacePanel(
  panel: WorkspacePanelState | null | undefined,
): panel is WorkspaceContentPanelState {
  return panel?.type === 'workspace';
}

function isOutlinerView(view: PanelView | null | undefined): view is OutlinerPanelView {
  return view?.kind === 'outliner';
}

function isOutlinerPanel(
  panel: WorkspacePanelState | null | undefined,
): panel is WorkspaceContentPanelState & { view: OutlinerPanelView } {
  return isWorkspacePanel(panel) && isOutlinerView(panel.view);
}

function panelViewKey(view: PanelView): string {
  if (view.kind === 'outliner') return `outliner:${view.rootId}`;
  return `file-preview:${previewTargetKey(view.target)}`;
}

function samePanelView(left: PanelView, right: PanelView): boolean {
  return panelViewKey(left) === panelViewKey(right);
}

function workspacePanel(id: string, view: PanelView, size = 1): WorkspaceContentPanelState {
  return { id, type: 'workspace', view, size, backStack: [], forwardStack: [] };
}

function outlinerPanel(id: string, rootId: NodeId, size = 1): WorkspaceContentPanelState {
  return workspacePanel(id, outlinerView(rootId), size);
}

function filePreviewPanel(id: string, target: PreviewTarget, size = 1): WorkspaceContentPanelState {
  return workspacePanel(id, filePreviewView(target), size);
}

function agentDebugPanel(id: string, conversationId: string | null, size = 1): AgentDebugPanelState {
  return { id, type: 'agent-debug', conversationId, size };
}

function navigateWorkspacePanel(panel: WorkspaceContentPanelState, view: PanelView): WorkspaceContentPanelState {
  if (samePanelView(panel.view, view)) return panel;
  return {
    ...panel,
    view,
    backStack: [...panel.backStack, panel.view].slice(-MAX_PANEL_PAGE_HISTORY),
    forwardStack: [],
  };
}

function navigateOutlinerPanel(panel: WorkspaceContentPanelState, rootId: NodeId): WorkspaceContentPanelState {
  return navigateWorkspacePanel(panel, outlinerView(rootId));
}

function sanitizeSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function sanitizePanelView(value: unknown, nodeIds: Set<NodeId>): PanelView | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'outliner') {
    return typeof value.rootId === 'string' && nodeIds.has(value.rootId)
      ? outlinerView(value.rootId)
      : null;
  }
  if (value.kind === 'file-preview') {
    const target = previewTargetFromUnknown(value.target);
    return target ? { kind: 'file-preview', target } : null;
  }
  return null;
}

function sanitizeViewStack(value: unknown, nodeIds: Set<NodeId>): PanelView[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => sanitizePanelView(entry, nodeIds))
    .filter((entry): entry is PanelView => Boolean(entry))
    .slice(-MAX_PANEL_PAGE_HISTORY);
}

function panelOutlinerAnchor(panel: WorkspacePanelState): OutlinerPanelView | null {
  if (!isWorkspacePanel(panel)) return null;
  if (isOutlinerView(panel.view)) return panel.view;
  for (let index = panel.backStack.length - 1; index >= 0; index -= 1) {
    const view = panel.backStack[index];
    if (isOutlinerView(view)) return view;
  }
  for (let index = panel.forwardStack.length - 1; index >= 0; index -= 1) {
    const view = panel.forwardStack[index];
    if (isOutlinerView(view)) return view;
  }
  return null;
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
      conversationId: typeof value.conversationId === 'string' ? value.conversationId : null,
    };
  }
  if (value.type !== 'workspace') return null;
  const view = sanitizePanelView(value.view, nodeIds);
  if (!view) return null;
  return {
    id: value.id,
    type: 'workspace',
    size,
    view,
    backStack: sanitizeViewStack(value.backStack, nodeIds),
    forwardStack: sanitizeViewStack(value.forwardStack, nodeIds),
  };
}

function sanitizeLayout(value: unknown, nodeIds: Set<NodeId>): WorkspaceLayout | null {
  if (!isRecord(value) || !Array.isArray(value.panels)) return null;
  const panels = value.panels
    .slice(0, MAX_PERSISTED_PANELS)
    .map((panel) => sanitizePanel(panel, nodeIds))
    .filter((panel): panel is WorkspacePanelState => Boolean(panel));
  if (panels.length === 0) return null;
  // The canvas is anchored by at least one outliner view (current or in a
  // workspace pane's view history). A restored layout of only agent-debug panes
  // has nothing to anchor, so treat it as corrupt and fall back to default.
  if (!panels.some((panel) => Boolean(panelOutlinerAnchor(panel)))) return null;

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
    if (!isRecord(parsed) || parsed.version !== 3) return null;
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
      version: 3,
      localDate: todayIsoLocalDate(),
      activePanelId,
      panels,
    }));
  } catch {
    // Best-effort UI state only.
  }
}

interface UseWorkspaceLayoutOptions {
  canAddPanel?: (nextPanelCount: number) => boolean;
  focusNode: (nodeId: NodeId | null) => void;
}

interface InitializedWorkspaceLayout {
  focusRootId: NodeId;
  outlinerRootIds: NodeId[];
}

function allowPanelAdd() {
  return true;
}

export function useWorkspaceLayout({
  canAddPanel = allowPanelAdd,
  focusNode,
}: UseWorkspaceLayoutOptions) {
  const [panels, setPanels] = useState<WorkspacePanelState[]>([]);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const activePanelIndex = Math.max(0, panels.findIndex((panel) => panel.id === activePanelId));
  const activePanel = panels[activePanelIndex] ?? null;
  const activeWorkspacePanel = isWorkspacePanel(activePanel) ? activePanel : null;
  // Strict: the active pane, but only when its current view is an outliner.
  // Targeted operations that act on "the active pane's outliner" — like "open
  // the active root in a pane" (Cmd+M) — key off this, so they no-op when a debug
  // or file preview view is active rather than silently reaching across.
  const activeOutlinerPanel = isOutlinerPanel(activePanel) ? activePanel : null;
  // Ambient: the active outliner if any, else the first outliner on the canvas.
  // For non-targeted UI (sidebar root highlight, drag-selection scope) where "the
  // outliner the user is looking at" is good enough even while a debug pane holds
  // the active slot.
  const ambientOutlinerPanel = activeOutlinerPanel ?? panels.find(isOutlinerPanel) ?? null;
  const rootId = ambientOutlinerPanel?.view.rootId ?? null;

  const initializeLayout = useCallback((initial: DocumentProjection): InitializedWorkspaceLayout => {
    const layout = loadPersistedLayout(initial) ?? defaultLayout(initial);
    setPanels(layout.panels);
    setActivePanelId(layout.activePanelId);
    initializedRef.current = true;
    const activeLayoutPanel = layout.panels.find((panel) => panel.id === layout.activePanelId)
      ?? layout.panels[0];
    const focusRootId = isOutlinerPanel(activeLayoutPanel)
      ? activeLayoutPanel.view.rootId
      : layout.panels.find(isOutlinerPanel)?.view.rootId
        ?? layout.panels.map(panelOutlinerAnchor).find(Boolean)?.rootId
        ?? initial.todayId;
    const outlinerRootIds = new Set<NodeId>();
    for (const panel of layout.panels) {
      if (!isWorkspacePanel(panel)) continue;
      const views = [panel.view, ...panel.backStack, ...panel.forwardStack];
      for (const view of views) {
        if (isOutlinerView(view)) outlinerRootIds.add(view.rootId);
      }
    }
    return {
      focusRootId,
      outlinerRootIds: [...outlinerRootIds],
    };
  }, []);

  useEffect(() => {
    if (!initializedRef.current) return;
    persistLayout(activePanelId, panels);
  }, [activePanelId, panels]);

  const navigateRoot = useCallback((nodeId: NodeId, options?: NavigateRootOptions) => {
    const current = panels.find((panel) => panel.id === activePanelId);
    const targetPanel = isWorkspacePanel(current) ? current : panels.find(isOutlinerPanel);
    if (targetPanel) {
      setActivePanelId(targetPanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === targetPanel.id && isWorkspacePanel(panel) ? navigateOutlinerPanel(panel, nodeId) : panel
      )));
    } else if (panels.length < MAX_PERSISTED_PANELS && canAddPanel(panels.length + 1)) {
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
  }, [activePanelId, canAddPanel, focusNode, panels]);

  const activatePanel = useCallback((panel: WorkspacePanelState) => {
    setActivePanelId(panel.id);
  }, []);

  const navigatePanelRoot = useCallback((panelId: string, nodeId: NodeId, options?: NavigateRootOptions) => {
    setActivePanelId(panelId);
    setPanels((prev) => prev.map((panel) => (
      panel.id === panelId && isWorkspacePanel(panel) ? navigateOutlinerPanel(panel, nodeId) : panel
    )));
    focusNode(options?.focus === false ? null : nodeId);
  }, [focusNode]);

  const openPreviewPanel = useCallback((target: PreviewTarget) => {
    const keepActive = (panelId: string) => {
      setActivePanelId(panelId);
      window.requestAnimationFrame(() => setActivePanelId(panelId));
    };
    if (panels.length >= MAX_PERSISTED_PANELS || !canAddPanel(panels.length + 1)) {
      const replacePanel = [...panels].reverse().find(isWorkspacePanel) ?? panels.at(-1);
      if (!replacePanel) return;
      keepActive(replacePanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === replacePanel.id
          ? isWorkspacePanel(panel)
            ? navigateWorkspacePanel(panel, filePreviewView(target))
            : filePreviewPanel(panel.id, target, panel.size)
          : panel
      )));
    } else {
      const panelId = nextId('panel');
      keepActive(panelId);
      setPanels((prev) => [...prev, filePreviewPanel(panelId, target)]);
    }
    focusNode(null);
  }, [canAddPanel, focusNode, panels]);

  const navigatePanelPreview = useCallback((panelId: string, target: PreviewTarget, options?: { newPane?: boolean }) => {
    if (options?.newPane) {
      openPreviewPanel(target);
      return;
    }
    setActivePanelId(panelId);
    setPanels((prev) => prev.map((panel) => (
      panel.id === panelId && isWorkspacePanel(panel)
        ? navigateWorkspacePanel(panel, filePreviewView(target))
        : panel
    )));
    focusNode(null);
  }, [focusNode, openPreviewPanel]);

  const openPreview = useCallback((target: PreviewTarget, options?: { newPane?: boolean }) => {
    if (options?.newPane) {
      openPreviewPanel(target);
      return;
    }
    const current = panels.find((panel) => panel.id === activePanelId);
    const targetPanel = isWorkspacePanel(current)
      ? current
      : panels.find(isOutlinerPanel) ?? panels.find(isWorkspacePanel);
    if (!targetPanel) {
      openPreviewPanel(target);
      return;
    }
    navigatePanelPreview(targetPanel.id, target);
  }, [activePanelId, navigatePanelPreview, openPreviewPanel, panels]);

  const navigatePanelBack = useCallback((panelId: string): PanelView | null => {
    const panel = panels.find((candidate) => candidate.id === panelId);
    const previousView = isWorkspacePanel(panel) ? panel.backStack.at(-1) ?? null : null;
    if (!previousView) return null;

    setActivePanelId(panelId);
    setPanels((prev) => prev.map((candidate) => (
      candidate.id === panelId && isWorkspacePanel(candidate)
        ? {
          ...candidate,
          view: previousView,
          backStack: candidate.backStack.slice(0, -1),
          forwardStack: [...candidate.forwardStack, candidate.view]
            .slice(-MAX_PANEL_PAGE_HISTORY),
        }
        : candidate
    )));
    focusNode(isOutlinerView(previousView) ? previousView.rootId : null);
    return previousView;
  }, [focusNode, panels]);

  const navigatePanelForward = useCallback((panelId: string): PanelView | null => {
    const panel = panels.find((candidate) => candidate.id === panelId);
    const nextView = isWorkspacePanel(panel) ? panel.forwardStack.at(-1) ?? null : null;
    if (!nextView) return null;

    setActivePanelId(panelId);
    setPanels((prev) => prev.map((candidate) => (
      candidate.id === panelId && isWorkspacePanel(candidate)
        ? {
          ...candidate,
          view: nextView,
          backStack: [...candidate.backStack, candidate.view]
            .slice(-MAX_PANEL_PAGE_HISTORY),
          forwardStack: candidate.forwardStack.slice(0, -1),
        }
        : candidate
    )));
    focusNode(isOutlinerView(nextView) ? nextView.rootId : null);
    return nextView;
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
      focusNode(isOutlinerPanel(nextActivePanel) ? nextActivePanel.view.rootId : null);
    }
  }, [activePanelId, focusNode, panels]);

  const openPanel = useCallback((nodeId: NodeId | null = rootId) => {
    if (!nodeId) return;
    const keepActive = (panelId: string) => {
      setActivePanelId(panelId);
      window.requestAnimationFrame(() => setActivePanelId(panelId));
    };
    if (panels.length >= MAX_PERSISTED_PANELS || !canAddPanel(panels.length + 1)) {
      // At the cap, repurpose an existing workspace pane (rightmost first) so a
      // debug conversation is never silently dropped — symmetric with how
      // openAgentDebugPanel reverse-finds a debug pane. Falls back to the last
      // pane only if somehow none is a workspace pane.
      const replacePanel = [...panels].reverse().find(isWorkspacePanel) ?? panels.at(-1);
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
  }, [canAddPanel, focusNode, panels, rootId]);

  const openAgentDebugPanel = useCallback((conversationId: string | null) => {
    const existing = panels.find((panel) => (
      panel.type === 'agent-debug' && panel.conversationId === conversationId
    ));
    if (existing) {
      setActivePanelId(existing.id);
      return;
    }

    const emptyDebugPanel = conversationId
      ? panels.find((panel) => panel.type === 'agent-debug' && panel.conversationId === null)
      : null;
    if (emptyDebugPanel) {
      setActivePanelId(emptyDebugPanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === emptyDebugPanel.id ? agentDebugPanel(panel.id, conversationId, panel.size) : panel
      )));
      return;
    }

    if (panels.length >= MAX_PERSISTED_PANELS) {
      const replacePanel = [...panels].reverse().find((panel) => panel.type === 'agent-debug') ?? panels.at(-1);
      if (!replacePanel) return;
      setActivePanelId(replacePanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === replacePanel.id ? agentDebugPanel(panel.id, conversationId, panel.size) : panel
      )));
      return;
    }

    if (!canAddPanel(panels.length + 1)) return;

    const panelId = nextId('panel');
    setActivePanelId(panelId);
    setPanels((prev) => [...prev, agentDebugPanel(panelId, conversationId)]);
  }, [canAddPanel, panels]);

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
    activeWorkspacePanel,
    activatePanel,
    closePanel,
    initializeLayout,
    navigatePanelRoot,
    navigatePanelPreview,
    navigatePanelBack,
    navigatePanelForward,
    navigateRoot,
    openAgentDebugPanel,
    openPanel,
    openPreview,
    panels,
    resizePanelPair,
    rootId,
  };
}
