import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RendererUserViewHints } from '../../core/agent/protocol';
import type { PreviewTarget } from '../../core/preview';
import { api } from '../api/client';
import { parseIsoLocalDate, todayIsoLocalDate, type AssetMetadata, type FocusHint, type NodeId } from '../api/types';
import { flattenVisibleRows, useProjectionStore, useUiState } from '../state/document';
import { selectableRowForId } from '../state/selectableRows';
import { ThreadDock, type ThreadRailState } from '../agent/components/ThreadDock';
import { buildRendererUserViewHints } from './agent/userViewContext';
import { Sidebar } from './Sidebar';
import { WindowChrome } from './WindowChrome';
import { ActionNotice, nextActionNotice, type ActionNoticeState } from './ActionNotice';
import {
  clearFocusState,
  cursorAll,
  cursorEnd,
  cursorStart,
  outlinerNavigationFocusTarget,
  requestFocusState,
  requestPendingInputState,
  rowFocusTarget,
  focusTarget,
} from './focus/focusModel';
import { useDragSelection } from './interactions/dragSelection';
import { animateOutlinerRowMovementAfterNextCommit } from './outliner/rowMoveAnimation';
import { collapseExpandedParentIds } from './shared';
import { BatchTagSelector } from './outliner/BatchTagSelector';
import type { NavigateRootOptions, TriggerState } from './shared';
import {
  installActionErrorSink,
  installActionFocusSink,
  installActionStepListener,
  installDefaultActionStepHandlers,
  stageComposerObject,
} from './interactions/actionSteps';
import { useCommandRunner } from './shared';
import { createAssetNode } from './interactions/attachmentIngest';
import { ingestPreviewTargetToAsset, onAddPreviewTargetToOutlineRequest } from './preview/previewIngest';
import { onThreadRailRevealRequest } from '../agent/agentReveal';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { useResizableLayout } from './useResizableLayout';
import { useSelectionDismissal } from './useSelectionDismissal';
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard';
import { useWorkspaceLayout } from './useWorkspaceLayout';
import { useWorkspacePinnedNodes } from './useWorkspacePinnedNodes';
import { useT } from '../i18n/I18nProvider';
import { InlineFilePreviewLayer } from './editor/InlineFilePreviewLayer';
import { onPreviewTargetOpen } from './preview/previewEvents';
import type { FilePreviewNavigationOptions } from './workspaceLayoutTypes';
import { fileNodeTarget, isFileNode } from './preview/fileNode';
import {
  persistOutlineViewState,
  restoreOutlineExpansionForRoot,
} from '../state/outlineViewState';

const NODE_ACCESS_RECORD_DELAY_MS = 1200;
const EMPTY_AGENT_USER_VIEW: RendererUserViewHints = {
  activePanelId: null,
  focusedPanelId: null,
  focusSurface: null,
  focusedNodeId: null,
  selectedNodeIds: [],
  panels: [],
  truncated: false,
};

export function App() {
  const t = useT();
  const [ui, setUi] = useUiState();
  const { index, indexStore, applyProjectionUpdate } = useProjectionStore(api.getProjection, setUi);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Agent rail is a 3-state model: collapsed seed (bare icon) -> hover glass chip
  // (CSS-only, no React state) -> open full panel. We persist only the binary
  // open/collapsed in React; the chip is a pure :hover affordance in CSS.
  const [agentOpen, setAgentOpen] = useState(true);
  const agentOpenRef = useRef(agentOpen);
  agentOpenRef.current = agentOpen;
  const agentRailState: ThreadRailState = agentOpen ? 'open' : 'collapsed';
  const [sidebarExpandedIds, setSidebarExpandedIds] = useState<Set<NodeId>>(() => new Set());
  const [pendingFocus, setPendingFocus] = useState<FocusHint | null>(null);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const noticeSeqRef = useRef(0);
  const setError = useCallback((message: string | null) => {
    noticeSeqRef.current += 1;
    setNotice(nextActionNotice(message, noticeSeqRef.current));
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const [trigger, setTrigger] = useState<TriggerState>(null);
  const [dragId, setDragId] = useState<NodeId | null>(null);
  const indexRef = useRef(index);
  const uiStateRef = useRef(ui);
  uiStateRef.current = ui;
  const run = useCommandRunner(applyProjectionUpdate, setPendingFocus, setError);
  const nodeAccessTimersRef = useRef<Map<NodeId, number>>(new Map());

  useEffect(() => () => {
    for (const timer of nodeAccessTimersRef.current.values()) window.clearTimeout(timer);
    nodeAccessTimersRef.current.clear();
  }, []);

  // The action seam's renderer legs: main routes `mainRenderer` effect steps to
  // this one listener and waits for its ack, and forwards the executed
  // commands' focus hint so the caret still lands where the command says.
  useEffect(() => installActionStepListener(), []);
  useEffect(() => installActionFocusSink(setPendingFocus), []);
  useEffect(() => installActionErrorSink(setError), []);
  const recordNodeLanding = useCallback((nodeId: NodeId) => {
    const timers = nodeAccessTimersRef.current;
    const pendingTimer = timers.get(nodeId);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    const timer = window.setTimeout(() => {
      timers.delete(nodeId);
      void api.recordNodeAccess(nodeId).catch(() => undefined);
    }, NODE_ACCESS_RECORD_DELAY_MS);
    timers.set(nodeId, timer);
  }, []);

  /** Summon the command surface — the one globally-summoned panel (D3). */
  const showCommandSurface = useCallback(() => {
    void window.lin?.showLauncher?.();
  }, []);

  const focusNode = useCallback((nodeId: NodeId | null) => {
    setUi((prev) => {
      if (!nodeId) return clearFocusState(prev);
      const currentIndex = indexRef.current;
      const node = currentIndex?.byId.get(nodeId);
      if (node?.type === 'search') return clearFocusState(prev);
      const firstVisibleRowId = currentIndex
        ? flattenVisibleRows(
          nodeId,
          currentIndex.byId,
          prev.expanded,
          prev.expandedHiddenFields,
        )[0] ?? null
        : null;
      if (!firstVisibleRowId || !currentIndex) {
        return requestFocusState(prev, focusTarget(nodeId, nodeId, null, 'trailing'), cursorEnd());
      }
      const firstVisibleRow = selectableRowForId(firstVisibleRowId, nodeId, currentIndex.byId);
      const firstVisibleParentId = firstVisibleRow?.parentId ?? nodeId;
      return requestFocusState(
        prev,
        outlinerNavigationFocusTarget(
          firstVisibleRowId,
          firstVisibleParentId,
          null,
          firstVisibleRow?.kind ?? 'content',
        ),
        cursorStart(),
      );
    });
  }, [setUi]);
  const clearFocusAndSelection = useCallback(() => {
    setUi((prev) => ({
      ...clearFocusState(prev),
      selectedId: null,
      selectedIds: new Set<NodeId>(),
      selectionAnchorId: null,
      selectionRootId: null,
      selectionSource: null,
    }));
  }, [setUi]);
  const panelCountFitsRef = useRef<(nextPanelCount: number) => boolean>(() => true);
  const reflowPanelCountRef = useRef<(nextPanelCount: number) => boolean>(() => true);
  const canFitPanelCount = useCallback((nextPanelCount: number) => (
    panelCountFitsRef.current(nextPanelCount)
  ), []);
  const preparePanelCount = useCallback((nextPanelCount: number) => {
    reflowPanelCountRef.current(nextPanelCount);
  }, []);
  const {
    activeOutlinerPanel,
    activePanelId,
    activeWorkspacePanel,
    activatePanel,
    bindPreviewPanelNode,
    closePanel,
    initializeLayout,
    movePanelToIndex,
    navigatePanelBack: goPanelBack,
    navigatePanelForward: goPanelForward,
    navigatePanelPreview: setPanelPreview,
    navigatePanelRoot: setPanelRoot,
    navigateRoot: setActivePanelRoot,
    openPanel,
    openPreview,
    openThreadTrajectoryPanel,
    panels,
    repairInvalidPanelViews,
    resizePanelPair,
    rootId,
    updatePanelScroll,
  } = useWorkspaceLayout({
    canFitPanelCount,
    clearFocusAndSelection,
    focusNode,
    preparePanelCount,
  });
  // Global Back/Forward (Cmd+[ / Cmd+]) act on the active workspace pane's view
  // history, including Trajectory and file previews.
  const pageHistoryPanel = activeWorkspacePanel;

  const {
    agentWidth,
    beginAgentResize,
    beginPanelResize,
    beginSidebarResize,
    canvasRef,
    panelCountFitsCapacity,
    prepareAgentOpen,
    reflowRailsForPanelCount,
    resetAgentWidth,
    resetPanelPair,
    resetSidebarWidth,
    resizeAgentWithKeyboard,
    resizePanelPairWithKeyboard,
    resizeSidebarWithKeyboard,
    sidebarWidth,
  } = useResizableLayout({
    agentOpen,
    panels,
    resizePanelPair,
    sidebarOpen,
  });
  panelCountFitsRef.current = panelCountFitsCapacity;
  reflowPanelCountRef.current = reflowRailsForPanelCount;
  const { isNodePinned, pinNodeAtIndex, pinnedNodeIds, togglePin } = useWorkspacePinnedNodes(index?.byId ?? null);
  // An in-app summon has no page to capture; the ambient object is what the
  // user had focused, and this renderer is the only surface that knows. It
  // answers with raw FACTS — main validates the ids and builds the object.
  useEffect(() => window.lin?.actions?.onAmbientSeedRequest?.(() => {
    const state = uiStateRef.current;
    const anchorNodeId = state.selectedId ?? state.focusedId;
    if (!anchorNodeId) return null;
    return {
      from: 'mainRenderer',
      anchorNodeId,
      visualRowId: anchorNodeId,
      panelId: activePanelId ?? '',
      selectedIds: [...state.selectedIds],
      isPinned: isNodePinned(anchorNodeId),
      rowExpanded: state.expanded.has(anchorNodeId),
      // Outdent is defined relative to the pane the user is acting from, and
      // only this renderer knows which one that is.
      ...(state.selectionRootId ? { selectionRootId: state.selectionRootId } : {}),
    };
  }) ?? (() => undefined), [activePanelId, isNodePinned]);
  const agentUserViewSourceRef = useRef({ activePanelId, index, indexStore, panels, ui });
  agentUserViewSourceRef.current = { activePanelId, index, indexStore, panels, ui };
  const getAgentUserView = useCallback((): RendererUserViewHints => {
    const source = agentUserViewSourceRef.current;
    const currentIndex = source.indexStore?.getCurrent() ?? source.index;
    return currentIndex ? buildRendererUserViewHints({
      activePanelId: source.activePanelId,
      panels: source.panels,
      index: currentIndex,
      ui: source.ui,
    }) : EMPTY_AGENT_USER_VIEW;
  }, []);

  const openAgentRail = useCallback(() => {
    if (agentOpenRef.current) return;
    prepareAgentOpen();
    agentOpenRef.current = true;
    setAgentOpen(true);
  }, [prepareAgentOpen]);
  const toggleAgentRail = useCallback(() => {
    const nextOpen = !agentOpenRef.current;
    if (nextOpen) prepareAgentOpen();
    agentOpenRef.current = nextOpen;
    setAgentOpen(nextOpen);
  }, [prepareAgentOpen]);
  // Deep content rows can ask to surface the agent panel without prop-drilling
  // App-local rail state. Reveals are layout no-ops while the rail is already
  // open; only the collapsed -> open transition preflows rail width.
  useEffect(() => onThreadRailRevealRequest(() => openAgentRail()), [openAgentRail]);

  useDragSelection({ rootId, index, ui, setUi });

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    if (!index) return;
    const repairedFocusRootId = repairInvalidPanelViews(index.projection, index.byId);
    if (repairedFocusRootId) focusNode(repairedFocusRootId);
  }, [focusNode, index, repairInvalidPanelViews]);

  useEffect(() => {
    void run(async () => {
      const initial = await api.initWorkspace();
      const initialLayout = initializeLayout(initial.projection);
      const initialById = new Map(initial.projection.nodes.map((node) => [node.id, node]));
      setUi((prev) => {
        const next = requestFocusState(prev, rowFocusTarget(initialLayout.focusRootId, null, null), cursorEnd());
        let restored = {
          expanded: new Set([...next.expanded, initial.projection.libraryId]),
          expandedHiddenFields: new Set(next.expandedHiddenFields),
        };
        for (const rootNodeId of initialLayout.outlinerRootIds) {
          restored = restoreOutlineExpansionForRoot(
            rootNodeId,
            initialById,
            restored.expanded,
            restored.expandedHiddenFields,
          );
        }
        return {
          ...next,
          expanded: restored.expanded,
          expandedHiddenFields: restored.expandedHiddenFields,
        };
      });
      return initial;
    });
  }, [initializeLayout, run, setUi]);

  useEffect(() => {
    const currentIndex = indexRef.current;
    if (!currentIndex) return;
    const persistedRootIds = new Set<NodeId>();
    for (const panel of panels) {
      const rootId = panel.view.kind === 'outliner'
        ? panel.view.rootId
        : panel.view.kind === 'file-preview' ? panel.view.nodeId ?? null : null;
      if (!rootId || persistedRootIds.has(rootId)) continue;
      persistedRootIds.add(rootId);
      persistOutlineViewState(rootId, currentIndex.byId, {
        expanded: ui.expanded,
        expandedHiddenFields: ui.expandedHiddenFields,
      });
    }
  }, [panels, ui.expanded, ui.expandedHiddenFields]);

  useEffect(() => {
    const unlisten = window.lin?.onDocumentEvent((event) => {
      if (event.type !== 'projection_changed') return;
      applyProjectionUpdate(event.update);
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Desaturate the chrome while the window is inactive (the macOS
  // inactive-window convention). The main process forwards OS focus/blur; we
  // mark the document root so shell.css can grey the rails. Default to active so
  // the dev/browser preview (no main process) never starts greyed.
  useEffect(() => window.lin?.onWindowActiveChange?.((active) => {
    document.documentElement.classList.toggle('window-inactive', !active);
  }) ?? undefined, []);

  const restoreNodeInOutliner = useCallback((nodeId: NodeId) => {
    setUi((prev) => {
      if (!index) {
        const expanded = new Set(prev.expanded);
        expanded.add(nodeId);
        return { ...prev, expanded };
      }
      const restored = restoreOutlineExpansionForRoot(
        nodeId,
        index.byId,
        prev.expanded,
        prev.expandedHiddenFields,
      );
      return {
        ...prev,
        expanded: restored.expanded,
        expandedHiddenFields: restored.expandedHiddenFields,
      };
    });
  }, [index, setUi]);

  const filePreviewTargetForNode = useCallback((nodeId: NodeId): PreviewTarget | null => {
    const node = index?.byId.get(nodeId);
    return isFileNode(node) ? fileNodeTarget(node) : null;
  }, [index]);

  const openFilePreviewForNode = useCallback((
    nodeId: NodeId,
    options?: NavigateRootOptions & { panelId?: string; presentation?: FilePreviewNavigationOptions['presentation'] },
  ): boolean => {
    const fileTarget = filePreviewTargetForNode(nodeId);
    if (!fileTarget) return false;
    if (options?.panelId) {
      setPanelPreview(options.panelId, fileTarget, { newPane: options.newPane, nodeId, presentation: options.presentation });
    } else {
      openPreview(fileTarget, { newPane: options?.newPane, nodeId, presentation: options?.presentation });
    }
    restoreNodeInOutliner(nodeId);
    return true;
  }, [filePreviewTargetForNode, openPreview, restoreNodeInOutliner, setPanelPreview]);

  const navigateRoot = useCallback((nodeId: NodeId, options?: NavigateRootOptions) => {
    if (openFilePreviewForNode(nodeId, options)) {
      recordNodeLanding(nodeId);
      return;
    }
    if (options?.newPane) {
      openPanel(nodeId);
      restoreNodeInOutliner(nodeId);
      recordNodeLanding(nodeId);
      return;
    }
    setActivePanelRoot(nodeId, options);
    restoreNodeInOutliner(nodeId);
    recordNodeLanding(nodeId);
  }, [openFilePreviewForNode, openPanel, recordNodeLanding, restoreNodeInOutliner, setActivePanelRoot]);

  const ensureTodayNode = useCallback(async (): Promise<NodeId | null> => {
    const today = parseIsoLocalDate(todayIsoLocalDate());
    if (!today) return null;
    const result = await run(() => api.ensureDateNode(
      today.getFullYear(),
      today.getMonth() + 1,
      today.getDate(),
    ), { applyFocus: false });
    return result && 'focus' in result ? result.focus?.nodeId ?? null : null;
  }, [run]);

  const navigateToday = useCallback((options?: NavigateRootOptions) => {
    void ensureTodayNode().then((nodeId) => {
      if (nodeId) navigateRoot(nodeId, options);
    });
  }, [ensureTodayNode, navigateRoot]);

  // The global launcher opened an inline node search result — navigate the active
  // panel to it and focus it: the same in-place re-root a node row performs.
  // Fallback for LAUNCHER-originated plans: that invocation has no surface in
  // this renderer to register handlers, but its navigate / pin / composer legs
  // still land here. `reveal` is deliberately absent — only an anchored opening
  // carries the view facts one needs.
  useEffect(() => installDefaultActionStepHandlers({
    // The SAME landing the deleted `launcher:openNode` performed — file-preview
    // handling, outliner restore and the access record all live in
    // `navigateRoot`/`focusNode`. Raw `setActivePanelRoot` skipped every one.
    navigate: (nodeId) => {
      navigateRoot(nodeId as NodeId);
      focusNode(nodeId as NodeId);
    },
    workspace: (op, nodeId) => {
      if (op === 'openSplitPane') setActivePanelRoot(nodeId, { newPane: true });
      else if (op === 'pin' ? !isNodePinned(nodeId) : isNodePinned(nodeId)) togglePin(nodeId);
    },
    composerHandoff: (object) => stageComposerObject(object),
    // Structural commands from the searchable surface must keep the behaviour
    // the keyboard path has: the selection survives and expansion follows the
    // rows. The ORDER is the plan's — expansion before an indent, collapse
    // after an outdent — so neither direction flashes.
    outlineIntent: (intent) => {
      if (intent.kind === 'animateRowMovement') {
        animateOutlinerRowMovementAfterNextCommit();
        return;
      }
      setUi((prev) => {
        if (intent.kind === 'expand') {
          const expanded = new Set(prev.expanded);
          for (const nodeId of intent.nodeIds) expanded.add(nodeId);
          return { ...prev, expanded };
        }
        if (intent.kind === 'collapse') {
          return { ...prev, expanded: collapseExpandedParentIds(prev.expanded, new Set(intent.nodeIds)) };
        }
        return {
          ...clearFocusState(prev),
          focusedId: null,
          selectedId: intent.anchorId,
          selectedIds: new Set(intent.selectedIds),
          selectionAnchorId: intent.anchorId,
          selectionRootId: intent.selectionRootId,
          selectionSource: 'global',
        };
      });
    },
  }), [focusNode, isNodePinned, navigateRoot, setActivePanelRoot, setUi, togglePin]);

  useEffect(() => window.lin?.onNavigateToNode?.((nodeId) => {
    navigateRoot(nodeId as NodeId);
    focusNode(nodeId as NodeId);
  }) ?? undefined, [navigateRoot, focusNode]);

  useEffect(() => onPreviewTargetOpen(({ newPane, nodeId, presentation, target }) => {
    openPreview(target, { newPane, nodeId, presentation });
  }), [openPreview]);

  const navigatePanelRoot = useCallback((panelId: string, nodeId: NodeId, options?: NavigateRootOptions) => {
    if (openFilePreviewForNode(nodeId, { ...options, panelId })) {
      recordNodeLanding(nodeId);
      return;
    }
    if (options?.newPane) {
      openPanel(nodeId);
      restoreNodeInOutliner(nodeId);
      recordNodeLanding(nodeId);
      return;
    }
    setPanelRoot(panelId, nodeId, options);
    restoreNodeInOutliner(nodeId);
    recordNodeLanding(nodeId);
  }, [openFilePreviewForNode, openPanel, recordNodeLanding, restoreNodeInOutliner, setPanelRoot]);

  const navigatePanelPreview = useCallback((panelId: string, target: PreviewTarget, options?: FilePreviewNavigationOptions) => {
    setPanelPreview(panelId, target, options);
  }, [setPanelPreview]);

  const navigatePanelBack = useCallback((panelId: string) => {
    const view = goPanelBack(panelId);
    if (view?.kind === 'outliner') restoreNodeInOutliner(view.rootId);
    if (view?.kind === 'file-preview' && view.nodeId) restoreNodeInOutliner(view.nodeId);
  }, [goPanelBack, restoreNodeInOutliner]);

  const navigatePanelForward = useCallback((panelId: string) => {
    const view = goPanelForward(panelId);
    if (view?.kind === 'outliner') restoreNodeInOutliner(view.rootId);
    if (view?.kind === 'file-preview' && view.nodeId) restoreNodeInOutliner(view.nodeId);
  }, [goPanelForward, restoreNodeInOutliner]);

  const navigateActivePanelBack = useCallback(() => {
    if (!pageHistoryPanel) return;
    navigatePanelBack(pageHistoryPanel.id);
  }, [navigatePanelBack, pageHistoryPanel]);

  const navigateActivePanelForward = useCallback(() => {
    if (!pageHistoryPanel) return;
    navigatePanelForward(pageHistoryPanel.id);
  }, [navigatePanelForward, pageHistoryPanel]);

  const openRootInPanel = useCallback((nodeId: NodeId) => {
    if (openFilePreviewForNode(nodeId, { newPane: true })) {
      recordNodeLanding(nodeId);
      return;
    }
    openPanel(nodeId);
    restoreNodeInOutliner(nodeId);
    recordNodeLanding(nodeId);
  }, [openFilePreviewForNode, openPanel, recordNodeLanding, restoreNodeInOutliner]);

  const openNodeReferenceFromAgent = useCallback((nodeId: NodeId, options?: NavigateRootOptions) => {
    navigateRoot(nodeId, { focus: false, newPane: options?.newPane });
  }, [navigateRoot]);

  const openActiveRootInPanel = useCallback(() => {
    // Cmd+M opens the *active* outliner pane's root in a new pane. When another
    // view is active there is no active outliner root, so this is a no-op rather
    // than reaching across to the ambient (first) outliner.
    const activeRootId = activeOutlinerPanel?.view.rootId;
    if (!activeRootId) return;
    openRootInPanel(activeRootId);
  }, [activeOutlinerPanel, openRootInPanel]);

  const requestEditFocus = useCallback((nodeId: NodeId, parentId: NodeId | null = null) => {
    setUi((prev) => requestFocusState(prev, rowFocusTarget(nodeId, parentId, null), cursorEnd()));
    setPendingFocus({ nodeId, parentId, selectAll: false });
  }, [setUi]);

  const appendTypedCharToRow = useCallback((rowId: NodeId, char: string) => {
    if (!index) return;
    const row = selectableRowForId(rowId, index.projection.rootId, index.byId);
    if (!row) return;
    const target = outlinerNavigationFocusTarget(rowId, row.parentId, null, row.kind);
    setUi((prev) => requestPendingInputState(prev, target, char, cursorEnd()));
  }, [index, setUi]);

  const applyOutcomeFocus = useCallback((focus: FocusHint | null) => {
    if (!focus) return;
    if (focus.placement?.kind === 'preserve') return;
    setUi((prev) => {
      const panelId = activeOutlinerPanel?.id ?? null;
      if (!panelId) return prev;
      return requestFocusState(
        prev,
        focusTarget(focus.nodeId, focus.parentId ?? null, panelId, focus.surface ?? 'row'),
        focus.placement ?? (focus.selectAll ? cursorAll() : cursorEnd()),
      );
    });
  }, [activeOutlinerPanel?.id, setUi]);

  useEffect(() => {
    applyOutcomeFocus(pendingFocus);
  }, [applyOutcomeFocus, pendingFocus]);

  useSelectionDismissal(setUi);
  useWorkspaceKeyboard({
    appendTypedCharToRow,
    index,
    onGoToRoot: navigateRoot,
    onNavigateBack: navigateActivePanelBack,
    onNavigateForward: navigateActivePanelForward,
    onOpenPanel: openActiveRootInPanel,
    requestEditFocus,
    rootId,
    run,
    setError,
    setUi,
    ui,
  });

  const toggleSidebarTreeNode = useCallback((nodeId: NodeId) => {
    setSidebarExpandedIds((prev) => {
      const expanded = new Set(prev);
      if (expanded.has(nodeId)) expanded.delete(nodeId);
      else expanded.add(nodeId);
      return expanded;
    });
  }, []);

  // The non-node preview "Add to outline" bridge: copy the previewed source into an
  // asset and create a file node under Today. Both callers (the pane "Add to outline"
  // and a transcript chip's "Add to Today") land it under today's daily note; the
  // pane path (`panelId`) also binds the requesting file surface to the new node in
  // place. Ensure-today goes through `run()` — App's command runner folds the create
  // into the projection/index — so the new parent is usable immediately (a bare
  // `api.ensureDateNode` would leave the renderer index stale until the next commit).
  // Confirms only on a real create.
  // Read the failure copy through a ref so the single-handler subscription does not
  // depend on the whole `t` object: a locale change must not tear down and re-add the
  // bridge mid-flight (it would unbind an in-progress "Add to Today").
  const addFailedMessageRef = useRef(t.shell.filePreview.addToOutlineFailed);
  addFailedMessageRef.current = t.shell.filePreview.addToOutlineFailed;
  useEffect(() => onAddPreviewTargetToOutlineRequest(async ({ panelId, target }) => {
    // Surface a failure toast for both callers (the menu / pill fire-and-forget the
    // result), so an add that can't complete is never silent.
    const fail = () => {
      setError(addFailedMessageRef.current);
      return false;
    };
    const todayId = await ensureTodayNode();
    if (!todayId) return fail();
    const asset = await ingestPreviewTargetToAsset(target);
    if (!asset) return fail();
    const result = await createAssetNode(run, todayId, null, asset, { applyFocus: false });
    const newNodeId = result && 'focus' in result ? result.focus?.nodeId ?? null : null;
    if (!newNodeId) return fail();
    // No requesting pane (a transcript chip's "Add to Today") — a real create is the
    // success signal on its own; otherwise bind the requesting pane to the new node.
    if (!panelId) return true;
    const nextTarget = previewTargetForAsset(asset);
    if (!bindPreviewPanelNode(panelId, newNodeId, nextTarget, target)) return fail();
    return true;
  }), [ensureTodayNode, bindPreviewPanelNode, run]);

  const appShellStyle = {
    '--sidebar-width': `${sidebarWidth}px`,
    '--agent-width': `${agentWidth}px`,
  } as CSSProperties;

  if (!index || !indexStore) {
    return (
      <div
        className={[
          'app',
          sidebarOpen ? '' : 'sidebar-collapsed',
          `agent-${agentRailState}`,
        ].filter(Boolean).join(' ')}
        style={appShellStyle}
      >
        <WindowChrome
          agentOpen={agentOpen}
          sidebarOpen={sidebarOpen}
          onToggleAgent={toggleAgentRail}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
        />
        {/* Still loading, and the keyboard and preview bridges are already live
            above this branch — so a command CAN fail here. It is reported as
            what it is: this branch used to relabel any action failure as
            "startup failed", which named the wrong culprit and, having no
            timer, left that accusation on screen until the projection landed.
            There is no startup-failure channel to report from. */}
        <div className="app-shell app-startup-shell" aria-busy="true" />
        {notice && (
          <ActionNotice message={notice.message} onDismiss={dismissNotice} seq={notice.seq} />
        )}
      </div>
    );
  }

  return (
    <div
      className={[
        'app',
        sidebarOpen ? '' : 'sidebar-collapsed',
        `agent-${agentRailState}`,
      ].filter(Boolean).join(' ')}
      style={appShellStyle}
    >
      {/* Persistent window chrome: a top-left drag strip that reserves the
          traffic-light inset + the two symmetric fixed rail toggles. This is the
          ONLY -webkit-app-region:drag host now that TopBar is gone (rail tops and
          pane headers add further drag regions in CSS). */}
      <WindowChrome
        agentOpen={agentOpen}
        sidebarOpen={sidebarOpen}
        onToggleAgent={toggleAgentRail}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
      />

      <div className="app-shell">
        <Sidebar
          expandedIds={sidebarExpandedIds}
          index={index}
          isNodePinned={isNodePinned}
          onNavigateToday={navigateToday}
          onNavigateRoot={navigateRoot}
          onOpenPanel={openRootInPanel}
          onOpenSearch={showCommandSurface}
          onOpenSettings={() => {
            void window.lin?.openSettings();
          }}
          onResizeKeyDown={resizeSidebarWithKeyboard}
          onResizeReset={resetSidebarWidth}
          onResizeStart={beginSidebarResize}
          onToggleTreeNode={toggleSidebarTreeNode}
          onTogglePin={togglePin}
          onReorderPin={pinNodeAtIndex}
          pinnedNodeIds={pinnedNodeIds}
          projection={index.projection}
          rootId={rootId}
        />

        <WorkspaceCanvas
          activePanelId={activePanelId}
          panels={panels}
          canvasRef={canvasRef}
          dragId={dragId}
          index={index}
          onActivatePanel={activatePanel}
          onClosePanel={closePanel}
          onError={setError}
          onMovePanel={movePanelToIndex}
          onNavigatePanelBack={navigatePanelBack}
          onNavigatePanelPreview={navigatePanelPreview}
          onNavigatePanelRoot={navigatePanelRoot}
          onPanelScrollPositionChange={updatePanelScroll}
          onPanelResizeKeyDown={resizePanelPairWithKeyboard}
          onPanelResizeReset={resetPanelPair}
          onPanelResizeStart={beginPanelResize}
          run={run}
          isNodePinned={isNodePinned}
          setDragId={setDragId}
          setTrigger={setTrigger}
          setUi={setUi}
          onTogglePin={togglePin}
          trigger={trigger}
          ui={ui}
        />

        <ThreadDock
          getUserView={getAgentUserView}
          indexStore={indexStore}
          railState={agentRailState}
          onOpenNodeReference={openNodeReferenceFromAgent}
          onOpenTurnDetails={(threadId, turnId) => openThreadTrajectoryPanel(threadId, { turnId })}
          onResizeKeyDown={resizeAgentWithKeyboard}
          onResizeReset={resetAgentWidth}
          onResizeStart={beginAgentResize}
        />
      </div>

      <BatchTagSelector
        open={ui.batchTagSelectorOpen}
        selectedIds={ui.selectedIds}
        index={index}
        run={run}
        close={() => setUi((prev) => ({ ...prev, batchTagSelectorOpen: false }))}
        clearSelection={() => setUi((prev) => ({
          ...clearFocusState(prev),
          focusedId: null,
          selectedId: null,
          selectedIds: new Set(),
          selectionAnchorId: null,
          selectionRootId: null,
          selectionSource: null,
          batchTagSelectorOpen: false,
        }))}
      />


      {notice && (
        <ActionNotice message={notice.message} onDismiss={dismissNotice} seq={notice.seq} />
      )}

      <InlineFilePreviewLayer />
    </div>
  );
}

function previewTargetForAsset(asset: AssetMetadata): PreviewTarget {
  return {
    kind: 'asset',
    assetId: asset.id,
    ...(asset.originalFilename ? { label: asset.originalFilename } : {}),
  };
}
