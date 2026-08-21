import { useCallback, useEffect, useRef, useState } from 'react';
import { todayIsoLocalDate, type DocumentProjection, type NodeId } from '../api/types';
import { previewTargetFromUnknown, previewTargetKey, type PreviewTarget } from '../../core/preview';
import type { NavigateRootOptions } from './shared';
import type {
  FilePreviewNavigationOptions,
  FilePreviewPanelView,
  FilePreviewPresentation,
  OutlinerPanelView,
  PanelView,
  ThreadTrajectoryPanelView,
  WorkspaceContentPanelState,
  WorkspaceLayout,
  WorkspacePanelState,
} from './workspaceLayoutTypes';
import { isRecord } from '../state/persistence';
import { listWithItemMovedToIndex } from './interactions/dragDrop';

let nextWorkspaceId = 0;
const STORAGE_KEY = 'lin-outliner:workspace-layout:v7';
const STORAGE_VERSION = 7;
const MAX_PERSISTED_PANELS = 4;
const MAX_PANEL_PAGE_HISTORY = 50;

type NodeLookup = Pick<ReadonlyMap<NodeId, unknown>, 'has'>;
type ScrollablePanelView = OutlinerPanelView | FilePreviewPanelView;

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

function normalizeScrollTop(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function withScrollTop<T extends ScrollablePanelView>(view: T, scrollTop: number | undefined): T {
  if (scrollTop === undefined) {
    const { scrollTop: _unused, ...rest } = view;
    return rest as T;
  }
  return { ...view, scrollTop };
}

function outlinerView(rootId: NodeId, scrollTop?: number): OutlinerPanelView {
  return withScrollTop({ kind: 'outliner', rootId }, scrollTop);
}

function filePreviewView(
  target: PreviewTarget,
  nodeId?: NodeId,
  scrollTop?: number,
  presentation?: FilePreviewPresentation,
): PanelView {
  return withScrollTop({
    kind: 'file-preview',
    target,
    ...(nodeId ? { nodeId } : {}),
    ...(presentation ? { presentation } : {}),
  }, scrollTop);
}

function threadTrajectoryView(
  threadId: string,
  focus?: { readonly selectedRecordId?: string; readonly turnId?: string },
): ThreadTrajectoryPanelView {
  return {
    kind: 'thread-trajectory',
    threadId,
    ...(focus?.selectedRecordId ? { selectedRecordId: focus.selectedRecordId } : {}),
    ...(focus?.turnId ? { turnId: focus.turnId } : {}),
  };
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

function viewOutlineRootId(view: PanelView): NodeId | null {
  if (view.kind === 'outliner') return view.rootId;
  return view.kind === 'file-preview' ? view.nodeId ?? null : null;
}

function panelViewKey(view: PanelView): string {
  if (view.kind === 'outliner') return `outliner:${view.rootId}`;
  if (view.kind === 'thread-trajectory') {
    return `thread-trajectory:${view.threadId}:${view.selectedRecordId ?? ''}:${view.turnId ?? ''}`;
  }
  if (view.nodeId) return `file-preview-node:${view.nodeId}:${view.presentation ?? 'node'}`;
  return `file-preview:${previewTargetKey(view.target)}:${view.presentation ?? 'default'}`;
}

function samePanelView(left: PanelView, right: PanelView): boolean {
  return panelViewKey(left) === panelViewKey(right);
}

function workspacePanel(
  id: string,
  view: PanelView,
  size = 1,
  recoveryRootId?: NodeId,
): WorkspaceContentPanelState {
  return {
    id,
    type: 'workspace',
    view,
    size,
    backStack: [],
    forwardStack: [],
    ...(recoveryRootId ? { recoveryRootId } : {}),
  };
}

function outlinerPanel(id: string, rootId: NodeId, size = 1): WorkspaceContentPanelState {
  return workspacePanel(id, outlinerView(rootId), size);
}

function filePreviewPanel(
  id: string,
  target: PreviewTarget,
  size = 1,
  nodeId?: NodeId,
  presentation?: FilePreviewPresentation,
  recoveryRootId?: NodeId,
): WorkspaceContentPanelState {
  return workspacePanel(id, filePreviewView(target, nodeId, undefined, presentation), size, recoveryRootId);
}

function navigateWorkspacePanel(panel: WorkspaceContentPanelState, view: PanelView): WorkspaceContentPanelState {
  if (samePanelView(panel.view, view)) return panel;
  const recoveryRootId = isOutlinerView(panel.view) && !isOutlinerView(view)
    ? panel.view.rootId
    : panel.recoveryRootId;
  return {
    ...panel,
    view,
    backStack: [...panel.backStack, panel.view].slice(-MAX_PANEL_PAGE_HISTORY),
    forwardStack: [],
    ...(recoveryRootId ? { recoveryRootId } : {}),
  };
}

function navigateOutlinerPanel(panel: WorkspaceContentPanelState, rootId: NodeId): WorkspaceContentPanelState {
  return navigateWorkspacePanel(panel, outlinerView(rootId));
}

function sanitizeSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function sanitizePanelView(value: unknown, nodeIds: NodeLookup): PanelView | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  const scrollTop = normalizeScrollTop(value.scrollTop);
  if (value.kind === 'outliner') {
    return typeof value.rootId === 'string' && nodeIds.has(value.rootId)
      ? outlinerView(value.rootId, scrollTop)
      : null;
  }
  if (value.kind === 'file-preview') {
    const target = previewTargetFromUnknown(value.target);
    const nodeId = typeof value.nodeId === 'string' && nodeIds.has(value.nodeId) ? value.nodeId : undefined;
    const presentation = value.presentation === 'reader' ? value.presentation : undefined;
    // A document asset is only valid here when the file-preview view is bound to
    // its outliner node. Drop legacy asset-targeted previews that have no node id.
    return target && (target.kind !== 'asset' || nodeId) ? filePreviewView(target, nodeId, scrollTop, presentation) : null;
  }
  if (value.kind === 'thread-trajectory') {
    return typeof value.threadId === 'string' && value.threadId.length > 0
      ? threadTrajectoryView(value.threadId, {
        ...(typeof value.selectedRecordId === 'string' && value.selectedRecordId.length > 0
          ? { selectedRecordId: value.selectedRecordId }
          : {}),
        ...(typeof value.turnId === 'string' && value.turnId.length > 0 ? { turnId: value.turnId } : {}),
      })
      : null;
  }
  return null;
}

function sanitizeViewStack(value: unknown, nodeIds: NodeLookup): PanelView[] {
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

function panelRecoveryRootId(panel: WorkspacePanelState | null | undefined): NodeId | null {
  if (!isWorkspacePanel(panel)) return null;
  return panelOutlinerAnchor(panel)?.rootId ?? panel.recoveryRootId ?? null;
}

interface SanitizedWorkspacePanel {
  readonly id: string;
  readonly size: number;
  readonly view: PanelView | null;
  readonly backStack: PanelView[];
  readonly forwardStack: PanelView[];
  readonly recoveryRootId?: NodeId;
}

interface RepairedWorkspacePanel {
  readonly panel: WorkspaceContentPanelState;
  readonly recovered: boolean;
}

function sanitizePanel(value: unknown, nodeIds: NodeLookup): SanitizedWorkspacePanel | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  rememberId(value.id);
  const size = sanitizeSize(value.size);
  if (value.type !== 'workspace') return null;
  return {
    id: value.id,
    size,
    view: sanitizePanelView(value.view, nodeIds),
    backStack: sanitizeViewStack(value.backStack, nodeIds),
    forwardStack: sanitizeViewStack(value.forwardStack, nodeIds),
    ...(typeof value.recoveryRootId === 'string' && nodeIds.has(value.recoveryRootId)
      ? { recoveryRootId: value.recoveryRootId }
      : {}),
  };
}

function latestOutlinerIndex(views: readonly PanelView[]): number {
  for (let index = views.length - 1; index >= 0; index -= 1) {
    if (isOutlinerView(views[index])) return index;
  }
  return -1;
}

function cappedPanelHistory(...groups: readonly (readonly PanelView[])[]): PanelView[] {
  return groups.flat().slice(-MAX_PANEL_PAGE_HISTORY);
}

function repairedPanel(
  candidate: SanitizedWorkspacePanel,
  view: PanelView,
  backStack: PanelView[],
  forwardStack: PanelView[],
  recovered: boolean,
): RepairedWorkspacePanel {
  const recoveryRootId = recovered && isOutlinerView(view) ? view.rootId : candidate.recoveryRootId;
  return {
    recovered,
    panel: {
      id: candidate.id,
      type: 'workspace',
      size: candidate.size,
      view,
      backStack,
      forwardStack,
      ...(recoveryRootId ? { recoveryRootId } : {}),
    },
  };
}

function repairPanel(
  candidate: SanitizedWorkspacePanel,
  fallbackRootId: NodeId | null,
): RepairedWorkspacePanel | null {
  if (candidate.view) {
    return repairedPanel(candidate, candidate.view, candidate.backStack, candidate.forwardStack, false);
  }

  const backIndex = latestOutlinerIndex(candidate.backStack);
  if (backIndex >= 0) {
    const view = candidate.backStack[backIndex];
    return repairedPanel(
      candidate,
      view,
      candidate.backStack.slice(0, backIndex),
      cappedPanelHistory(
        candidate.forwardStack,
        candidate.backStack.slice(backIndex + 1).reverse(),
      ),
      true,
    );
  }

  const forwardIndex = latestOutlinerIndex(candidate.forwardStack);
  if (forwardIndex >= 0) {
    const view = candidate.forwardStack[forwardIndex];
    return repairedPanel(
      candidate,
      view,
      cappedPanelHistory(
        candidate.backStack,
        candidate.forwardStack.slice(forwardIndex + 1).reverse(),
      ),
      candidate.forwardStack.slice(0, forwardIndex),
      true,
    );
  }

  const recoveryRootId = candidate.recoveryRootId ?? fallbackRootId;
  if (!recoveryRootId) return null;
  return repairedPanel(
    { ...candidate, recoveryRootId },
    outlinerView(recoveryRootId),
    [],
    cappedPanelHistory(candidate.forwardStack, candidate.backStack.slice().reverse()),
    true,
  );
}

function dedupeRecoveredOutliners(
  entries: readonly RepairedWorkspacePanel[],
  activePanelId: string | null,
): RepairedWorkspacePanel[] {
  const byRoot = new Map<NodeId, RepairedWorkspacePanel[]>();
  for (const entry of entries) {
    if (!isOutlinerView(entry.panel.view)) continue;
    const group = byRoot.get(entry.panel.view.rootId) ?? [];
    group.push(entry);
    byRoot.set(entry.panel.view.rootId, group);
  }

  const removedIds = new Set<string>();
  for (const group of byRoot.values()) {
    const recovered = group.filter((entry) => entry.recovered);
    if (recovered.length === 0) continue;
    const activeRecovered = recovered.find((entry) => entry.panel.id === activePanelId);
    if (activeRecovered) {
      for (const entry of group) {
        if (entry !== activeRecovered) removedIds.add(entry.panel.id);
      }
      continue;
    }
    const stable = group.filter((entry) => !entry.recovered);
    if (stable.length > 0) {
      for (const entry of recovered) removedIds.add(entry.panel.id);
      continue;
    }
    for (const entry of recovered.slice(1)) removedIds.add(entry.panel.id);
  }
  return entries.filter((entry) => !removedIds.has(entry.panel.id));
}

function repairPanels(
  candidates: readonly SanitizedWorkspacePanel[],
  requestedActivePanelId: string | null,
  fallbackRootId: NodeId | null,
): WorkspaceLayout | null {
  const repaired = candidates
    .map((candidate) => repairPanel(candidate, fallbackRootId))
    .filter((entry): entry is RepairedWorkspacePanel => Boolean(entry));
  const entries = dedupeRecoveredOutliners(repaired, requestedActivePanelId);
  const panels = entries.map((entry) => entry.panel);
  if (panels.length === 0) return null;
  if (!panels.some((panel) => Boolean(panelOutlinerAnchor(panel)))) return null;

  const panelIds = new Set(panels.map((panel) => panel.id));
  const activePanelId = requestedActivePanelId && panelIds.has(requestedActivePanelId)
    ? requestedActivePanelId
    : panels[0].id;
  return { activePanelId, panels };
}

function sanitizeLayout(
  value: unknown,
  nodeIds: NodeLookup,
  fallbackRootId: NodeId | null,
): WorkspaceLayout | null {
  if (!isRecord(value) || !Array.isArray(value.panels)) return null;
  const candidates = value.panels
    .slice(0, MAX_PERSISTED_PANELS)
    .map((panel) => sanitizePanel(panel, nodeIds))
    .filter((panel): panel is SanitizedWorkspacePanel => Boolean(panel));
  const requestedActivePanelId = typeof value.activePanelId === 'string' ? value.activePanelId : null;
  return repairPanels(candidates, requestedActivePanelId, fallbackRootId);
}

function loadPersistedLayout(initial: DocumentProjection): WorkspaceLayout | null {
  const nodeIds = new Set(initial.nodes.map((node) => node.id));
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION) return null;
    if (parsed.localDate !== todayIsoLocalDate()) return null;
    return sanitizeLayout(parsed, nodeIds, fallbackOutlinerRootId(initial, nodeIds));
  } catch {
    return null;
  }
}

function persistLayout(activePanelId: string | null, panels: WorkspacePanelState[]) {
  if (!activePanelId || panels.length === 0) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: STORAGE_VERSION,
      localDate: todayIsoLocalDate(),
      activePanelId,
      panels,
    }));
  } catch {
    // Best-effort UI state only.
  }
}

function fallbackOutlinerRootId(projection: DocumentProjection, nodeIds: NodeLookup): NodeId | null {
  for (const nodeId of [projection.todayId, projection.libraryId, projection.rootId]) {
    if (nodeIds.has(nodeId)) return nodeId;
  }
  return projection.nodes[0]?.id ?? null;
}

function hasInvalidPanelState(panels: readonly WorkspacePanelState[], nodeIds: NodeLookup): boolean {
  for (const panel of panels) {
    if (!isWorkspacePanel(panel)) continue;
    if (!sanitizePanelView(panel.view, nodeIds)) return true;
    if (panel.recoveryRootId && !nodeIds.has(panel.recoveryRootId)) return true;
    for (const view of panel.backStack) {
      if (!sanitizePanelView(view, nodeIds)) return true;
    }
    for (const view of panel.forwardStack) {
      if (!sanitizePanelView(view, nodeIds)) return true;
    }
  }
  return false;
}

interface UseWorkspaceLayoutOptions {
  canFitPanelCount?: (nextPanelCount: number) => boolean;
  clearFocusAndSelection?: () => void;
  focusNode: (nodeId: NodeId | null) => void;
  preparePanelCount?: (nextPanelCount: number) => void;
}

interface InitializedWorkspaceLayout {
  focusRootId: NodeId;
  outlinerRootIds: NodeId[];
}

function allowPanelAdd() {
  return true;
}

export function useWorkspaceLayout({
  canFitPanelCount = allowPanelAdd,
  clearFocusAndSelection,
  focusNode,
  preparePanelCount = () => undefined,
}: UseWorkspaceLayoutOptions) {
  const [panels, setPanels] = useState<WorkspacePanelState[]>([]);
  const panelsRef = useRef<WorkspacePanelState[]>([]);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const initializedRef = useRef(false);

  panelsRef.current = panels;
  const clearPreviewNavigationState = useCallback(() => {
    if (clearFocusAndSelection) {
      clearFocusAndSelection();
      return;
    }
    focusNode(null);
  }, [clearFocusAndSelection, focusNode]);

  const activePanelIndex = Math.max(0, panels.findIndex((panel) => panel.id === activePanelId));
  const activePanel = panels[activePanelIndex] ?? null;
  const activeWorkspacePanel = isWorkspacePanel(activePanel) ? activePanel : null;
  // Strict: the active pane, but only when its current view is an outliner.
  // Targeted operations that act on "the active pane's outliner" — like "open
  // the active root in a pane" (Cmd+M) — key off this, so they no-op when a
  // non-outliner view is active rather than silently reaching across.
  const activeOutlinerPanel = isOutlinerPanel(activePanel) ? activePanel : null;
  // Ambient: the active outliner if any, else the first outliner on the canvas.
  // For non-targeted UI (sidebar root highlight, drag-selection scope) where "the
  // outliner the user is looking at" is good enough even while a non-outliner
  // view holds the active slot.
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
        const rootId = viewOutlineRootId(view);
        if (rootId) outlinerRootIds.add(rootId);
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
    const targetPanel = isOutlinerPanel(current) ? current : panels.find(isOutlinerPanel);
    if (targetPanel) {
      setActivePanelId(targetPanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === targetPanel.id && isWorkspacePanel(panel) ? navigateOutlinerPanel(panel, nodeId) : panel
      )));
    } else if (panels.length < MAX_PERSISTED_PANELS && canFitPanelCount(panels.length + 1)) {
      // No outliner pane but room to add one: append rather than replace the
      // whole canvas, so the other views survive.
      const panelId = nextId('panel');
      preparePanelCount(panels.length + 1);
      setActivePanelId(panelId);
      setPanels((prev) => [...prev, outlinerPanel(panelId, nodeId)]);
    } else {
      // No outliner pane and no room: repurpose the active pane in place. Only the
      // active pane is converted; every other pane is preserved.
      const replaceId = current?.id ?? panels.at(-1)?.id;
      if (!replaceId) return;
      setActivePanelId(replaceId);
      setPanels((prev) => prev.map((panel) => (
        panel.id === replaceId ? outlinerPanel(panel.id, nodeId, panel.size) : panel
      )));
    }
    focusNode(options?.focus === false ? null : nodeId);
  }, [activePanelId, canFitPanelCount, focusNode, panels, preparePanelCount]);

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

  const openPreviewPanel = useCallback((target: PreviewTarget, options: FilePreviewNavigationOptions = {}) => {
    const { nodeId, presentation } = options;
    const sourcePanel = panels.find((panel) => panel.id === activePanelId);
    const recoveryRootId = panelRecoveryRootId(sourcePanel)
      ?? rootId
      ?? panels.map(panelRecoveryRootId).find(Boolean)
      ?? undefined;
    const keepActive = (panelId: string) => {
      setActivePanelId(panelId);
      window.requestAnimationFrame(() => setActivePanelId(panelId));
    };
    if (panels.length >= MAX_PERSISTED_PANELS || !canFitPanelCount(panels.length + 1)) {
      const replacePanel = [...panels].reverse().find(isWorkspacePanel) ?? panels.at(-1);
      if (!replacePanel) return;
      keepActive(replacePanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === replacePanel.id
          ? navigateWorkspacePanel(panel, filePreviewView(target, nodeId, undefined, presentation))
          : panel
      )));
    } else {
      const panelId = nextId('panel');
      preparePanelCount(panels.length + 1);
      keepActive(panelId);
      setPanels((prev) => [
        ...prev,
        filePreviewPanel(panelId, target, 1, nodeId, presentation, recoveryRootId),
      ]);
    }
    clearPreviewNavigationState();
  }, [activePanelId, canFitPanelCount, clearPreviewNavigationState, panels, preparePanelCount, rootId]);

  const navigatePanelPreview = useCallback((panelId: string, target: PreviewTarget, options?: FilePreviewNavigationOptions) => {
    if (options?.newPane) {
      openPreviewPanel(target, options);
      return;
    }
    setActivePanelId(panelId);
    const nextView = filePreviewView(target, options?.nodeId, undefined, options?.presentation);
    setPanels((prev) => {
      let changed = false;
      const next = prev.map((panel) => {
        if (panel.id !== panelId || !isWorkspacePanel(panel)) return panel;
        const updated = navigateWorkspacePanel(panel, nextView);
        if (updated !== panel) changed = true;
        return updated;
      });
      return changed ? next : prev;
    });
    clearPreviewNavigationState();
  }, [clearPreviewNavigationState, openPreviewPanel]);

  const openPreview = useCallback((target: PreviewTarget, options?: FilePreviewNavigationOptions) => {
    if (options?.newPane) {
      openPreviewPanel(target, options);
      return;
    }
    const current = panels.find((panel) => panel.id === activePanelId);
    const targetPanel = isWorkspacePanel(current)
      ? current
      : panels.find(isOutlinerPanel) ?? panels.find(isWorkspacePanel);
    if (!targetPanel) {
      openPreviewPanel(target, options);
      return;
    }
    navigatePanelPreview(targetPanel.id, target, options);
  }, [activePanelId, navigatePanelPreview, openPreviewPanel, panels]);

  const bindPreviewPanelNode = useCallback((
    panelId: string,
    nodeId: NodeId,
    target?: PreviewTarget,
    expectedTarget?: PreviewTarget,
  ): boolean => {
    const panel = panelsRef.current.find((candidate) => candidate.id === panelId);
    if (!isWorkspacePanel(panel) || panel.view.kind !== 'file-preview') return false;
    if (expectedTarget && previewTargetKey(panel.view.target) !== previewTargetKey(expectedTarget)) return false;
    setActivePanelId(panelId);
    setPanels((prev) => prev.map((panel) => (
      panel.id === panelId && isWorkspacePanel(panel) && panel.view.kind === 'file-preview'
        ? { ...panel, view: { ...panel.view, ...(target ? { target } : {}), nodeId } }
        : panel
    )));
    clearPreviewNavigationState();
    return true;
  }, [clearPreviewNavigationState]);

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
    if (isOutlinerView(previousView)) {
      focusNode(previousView.scrollTop === undefined ? previousView.rootId : null);
    } else {
      clearPreviewNavigationState();
    }
    return previousView;
  }, [clearPreviewNavigationState, focusNode, panels]);

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
    if (isOutlinerView(nextView)) {
      focusNode(nextView.scrollTop === undefined ? nextView.rootId : null);
    } else {
      clearPreviewNavigationState();
    }
    return nextView;
  }, [clearPreviewNavigationState, focusNode, panels]);

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
      // Move focus to the next pane's root, or clear it for a file preview.
      focusNode(isOutlinerPanel(nextActivePanel) ? nextActivePanel.view.rootId : null);
    }
  }, [activePanelId, focusNode, panels]);

  const openPanel = useCallback((nodeId: NodeId | null = rootId) => {
    if (!nodeId) return;
    const keepActive = (panelId: string) => {
      setActivePanelId(panelId);
      window.requestAnimationFrame(() => setActivePanelId(panelId));
    };
    if (panels.length >= MAX_PERSISTED_PANELS || !canFitPanelCount(panels.length + 1)) {
      // At the cap, repurpose the rightmost workspace pane.
      const replacePanel = [...panels].reverse().find(isWorkspacePanel) ?? panels.at(-1);
      if (!replacePanel) return;
      keepActive(replacePanel.id);
      setPanels((prev) => prev.map((panel) => (
        panel.id === replacePanel.id ? outlinerPanel(panel.id, nodeId, panel.size) : panel
      )));
    } else {
      const panelId = nextId('panel');
      preparePanelCount(panels.length + 1);
      keepActive(panelId);
      setPanels((prev) => [...prev, outlinerPanel(panelId, nodeId)]);
    }
    focusNode(nodeId);
  }, [canFitPanelCount, focusNode, panels, preparePanelCount, rootId]);

  const openThreadTrajectoryPanel = useCallback((
    threadId: string,
    focus?: { readonly selectedRecordId?: string; readonly turnId?: string },
  ) => {
    const targetPanel = panels.find((panel) => panel.id === activePanelId) ?? panels[0];
    if (!targetPanel) return;
    const nextView = threadTrajectoryView(threadId, focus);
    setActivePanelId(targetPanel.id);
    setPanels((prev) => prev.map((panel) => {
      if (panel.id !== targetPanel.id) return panel;
      if (samePanelView(panel.view, nextView)) return panel;
      if (panel.view.kind === 'thread-trajectory') {
        return { ...panel, view: nextView };
      }
      return navigateWorkspacePanel(panel, nextView);
    }));
    clearPreviewNavigationState();
  }, [
    activePanelId,
    clearPreviewNavigationState,
    panels,
  ]);

  const repairInvalidPanelViews = useCallback((projection: DocumentProjection, nodeIds: NodeLookup): NodeId | null => {
    if (!initializedRef.current || panels.length === 0) return null;
    if (!hasInvalidPanelState(panels, nodeIds)) return null;
    const fallbackRootId = fallbackOutlinerRootId(projection, nodeIds);
    const candidates = panels
      .map((panel) => sanitizePanel(panel, nodeIds))
      .filter((panel): panel is SanitizedWorkspacePanel => Boolean(panel));
    const layout = repairPanels(candidates, activePanelId, fallbackRootId);
    if (!layout) return null;

    const previousActivePanel = panels.find((panel) => panel.id === activePanelId) ?? null;
    const nextActivePanel = layout.panels.find((panel) => panel.id === layout.activePanelId) ?? null;
    setPanels(layout.panels);
    if (layout.activePanelId !== activePanelId) setActivePanelId(layout.activePanelId);
    return isOutlinerPanel(nextActivePanel)
      && (!isOutlinerPanel(previousActivePanel) || previousActivePanel.view.rootId !== nextActivePanel.view.rootId)
      ? nextActivePanel.view.rootId
      : null;
  }, [activePanelId, panels]);

  // Move a pane to a new left-right position. `index` is an insertion position
  // (0..length) interpreted against the CURRENT array (shared reorder helper,
  // also used by the drag preview and the sidebar's pinNodeAtIndex). Order is
  // the only thing that changes; ids, sizes, view history, and the active pane
  // are untouched.
  const movePanelToIndex = useCallback((panelId: string, index: number) => {
    setPanels((prev) => {
      const panel = prev.find((candidate) => candidate.id === panelId);
      if (!panel) return prev;
      const next = listWithItemMovedToIndex(prev, panel, index);
      return next === prev ? prev : [...next];
    });
  }, []);

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

  const updatePanelScroll = useCallback((panelId: string, scrollTop: number) => {
    const nextScrollTop = normalizeScrollTop(scrollTop);
    setPanels((prev) => prev.map((panel) => {
      if (panel.id !== panelId || !isWorkspacePanel(panel)) return panel;
      if (panel.view.kind === 'thread-trajectory') return panel;
      if (panel.view.scrollTop === nextScrollTop) return panel;
      return { ...panel, view: withScrollTop(panel.view, nextScrollTop) };
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
    movePanelToIndex,
    navigatePanelRoot,
    navigatePanelPreview,
    bindPreviewPanelNode,
    navigatePanelBack,
    navigatePanelForward,
    navigateRoot,
    openPanel,
    openPreview,
    openThreadTrajectoryPanel,
    panels,
    repairInvalidPanelViews,
    resizePanelPair,
    rootId,
    updatePanelScroll,
  };
}
