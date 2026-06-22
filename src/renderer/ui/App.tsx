import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AgentUserViewContext } from '../../core/agentTypes';
import type { PreviewTarget } from '../../core/preview';
import { api } from '../api/client';
import { parseIsoLocalDate, todayIsoLocalDate, type AssetMetadata, type FocusHint, type NodeId } from '../api/types';
import { flattenVisibleRows, useProjectionStore, useUiState } from '../state/document';
import { AgentDock, type AgentRailState } from './AgentDock';
import { CommandPalette } from './CommandPalette';
import { Sidebar } from './Sidebar';
import { WindowChrome } from './WindowChrome';
import { CloseIcon, ICON_SIZE } from './icons';
import {
  clearFocusState,
  cursorAll,
  cursorEnd,
  cursorStart,
  requestFocusState,
  requestPendingInputState,
  rowFocusTarget,
  focusTarget,
} from './focus/focusModel';
import { useDragSelection } from './interactions/dragSelection';
import { BatchTagSelector } from './outliner/BatchTagSelector';
import { ButtonControl } from './primitives/ButtonControl';
import type { NavigateRootOptions, TriggerState } from './shared';
import { useCommandRunner } from './shared';
import { buildAgentUserViewContext, insertionTargetFor } from './agent/userViewContext';
import { createAssetNode } from './interactions/attachmentIngest';
import { onInsertFileIntoOutlinerRequest } from '../agent/agentFileInsert';
import { ingestPreviewTargetToAsset, onAddPreviewTargetToOutlineRequest } from './preview/previewIngest';
import { onAgentRevealRequest } from '../agent/agentReveal';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { useResizableLayout } from './useResizableLayout';
import { useSelectionDismissal } from './useSelectionDismissal';
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard';
import { useWorkspaceLayout } from './useWorkspaceLayout';
import { useWorkspacePinnedNodes } from './useWorkspacePinnedNodes';
import { useT } from '../i18n/I18nProvider';
import { InlineFilePreviewLayer } from './editor/InlineFilePreviewLayer';
import { onPreviewTargetOpen } from './preview/previewEvents';
import { fileNodeTarget, isFileNode } from './preview/fileNode';
import {
  persistOutlineViewState,
  restoreOutlineExpansionForRoot,
} from '../state/outlineViewState';

const NODE_ACCESS_RECORD_DELAY_MS = 1200;

export function App() {
  const t = useT();
  const { index, applyProjectionUpdate } = useProjectionStore(api.getProjection);
  const [ui, setUi] = useUiState();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Agent rail is a 3-state model: collapsed seed (bare icon) -> hover glass chip
  // (CSS-only, no React state) -> open full panel. We persist only the binary
  // open/collapsed in React; the chip is a pure :hover affordance in CSS.
  const [agentOpen, setAgentOpen] = useState(true);
  const agentRailState: AgentRailState = agentOpen ? 'open' : 'collapsed';
  const [sidebarExpandedIds, setSidebarExpandedIds] = useState<Set<NodeId>>(() => new Set());
  const [pendingFocus, setPendingFocus] = useState<FocusHint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<TriggerState>(null);
  const [dragId, setDragId] = useState<NodeId | null>(null);
  const indexRef = useRef(index);
  const pendingLocalUserCommandsRef = useRef(0);
  const ignoreLocalUserEventsThroughRef = useRef(0);
  const commandRunnerLifecycle = useMemo(() => ({
    onLocalCommandStart: () => {
      pendingLocalUserCommandsRef.current += 1;
    },
    onLocalCommandSettled: () => {
      pendingLocalUserCommandsRef.current = Math.max(0, pendingLocalUserCommandsRef.current - 1);
      ignoreLocalUserEventsThroughRef.current = Date.now();
    },
  }), []);
  const run = useCommandRunner(applyProjectionUpdate, setPendingFocus, setError, commandRunnerLifecycle);
  const nodeAccessTimersRef = useRef<Map<NodeId, number>>(new Map());

  useEffect(() => () => {
    for (const timer of nodeAccessTimersRef.current.values()) window.clearTimeout(timer);
    nodeAccessTimersRef.current.clear();
  }, []);

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

  const setCommandOpen = useCallback((commandOpen: boolean) => {
    setUi((prev) => ({ ...prev, commandOpen }));
  }, [setUi]);

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
      const firstVisibleRow = currentIndex.byId.get(firstVisibleRowId);
      const firstVisibleParentId = firstVisibleRow?.parentId ?? nodeId;
      return requestFocusState(
        prev,
        firstVisibleRow?.type === 'fieldEntry'
          ? focusTarget(firstVisibleRowId, firstVisibleParentId, null, 'field-name')
          : rowFocusTarget(firstVisibleRowId, firstVisibleParentId, null),
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
  const notifyPanelOpenRejected = useCallback(() => {
    setError(t.shell.workspace.tooNarrowForNewPane);
  }, [t.shell.workspace.tooNarrowForNewPane]);

  const {
    activeOutlinerPanel,
    activePanelId,
    activeWorkspacePanel,
    activatePanel,
    bindPreviewPanelNode,
    closePanel,
    initializeLayout,
    navigatePanelBack: goPanelBack,
    navigatePanelForward: goPanelForward,
    navigatePanelPreview: setPanelPreview,
    navigatePanelRoot: setPanelRoot,
    navigateRoot: setActivePanelRoot,
    openAgentDebugPanel,
    openPanel,
    openPreview,
    panels,
    repairMissingOutlinerRoots,
    resizePanelPair,
    rootId,
    updatePanelScroll,
  } = useWorkspaceLayout({
    canFitPanelCount,
    clearFocusAndSelection,
    focusNode,
    onPanelOpenRejected: notifyPanelOpenRejected,
    preparePanelCount,
  });
  // Global Back/Forward (Cmd+[ / Cmd+]) act on the active workspace pane's view
  // history. Debug panes still no-op instead of navigating an unrelated pane.
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

  const openAgentRail = useCallback(() => {
    if (!agentOpen) prepareAgentOpen();
    setAgentOpen(true);
  }, [agentOpen, prepareAgentOpen]);
  const toggleAgentRail = useCallback(() => {
    if (!agentOpen) prepareAgentOpen();
    setAgentOpen((open) => !open);
  }, [agentOpen, prepareAgentOpen]);
  // A content row (e.g. a command node's Run button) can ask to surface the agent
  // panel on its delivery conversation; preflow the rail width before opening so
  // the floating sidebar and canvas do not visibly jump through an oversized frame.
  useEffect(() => onAgentRevealRequest(() => openAgentRail()), [openAgentRail]);

  useDragSelection({ rootId, index, ui, setUi });

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    if (!index) return;
    const repairedFocusRootId = repairMissingOutlinerRoots(index.projection, index.byId);
    if (repairedFocusRootId) focusNode(repairedFocusRootId);
  }, [focusNode, index, repairMissingOutlinerRoots]);

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
      const rootId = panel.type === 'workspace'
        ? panel.view.kind === 'outliner' ? panel.view.rootId : panel.view.nodeId ?? null
        : null;
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
      // Local commands apply their returned projection through run(); delayed user events can still carry intermediate state.
      const isLocalUserCommandEvent = event.origin === 'user'
        && (
          pendingLocalUserCommandsRef.current > 0
          || (
            typeof event.timestamp === 'number'
            && event.timestamp <= ignoreLocalUserEventsThroughRef.current
          )
        );
      if (isLocalUserCommandEvent) return;
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
    options?: NavigateRootOptions & { panelId?: string },
  ): boolean => {
    const fileTarget = filePreviewTargetForNode(nodeId);
    if (!fileTarget) return false;
    if (options?.panelId) {
      setPanelPreview(options.panelId, fileTarget, { newPane: options.newPane, nodeId });
    } else {
      openPreview(fileTarget, { newPane: options?.newPane, nodeId });
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
  // panel to it and focus it (mirrors the in-app CommandPalette jump).
  useEffect(() => window.lin?.onNavigateToNode?.((nodeId) => {
    navigateRoot(nodeId as NodeId);
    focusNode(nodeId as NodeId);
  }) ?? undefined, [navigateRoot, focusNode]);

  useEffect(() => onPreviewTargetOpen(({ newPane, target }) => {
    openPreview(target, { newPane });
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

  const navigatePanelPreview = useCallback((panelId: string, target: PreviewTarget, options?: { newPane?: boolean; nodeId?: NodeId }) => {
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
    // Cmd+M opens the *active* outliner pane's root in a new pane. When a debug
    // pane is active there is no active outliner root, so this is a no-op rather
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
    const row = index.byId.get(rowId);
    if (!row) return;
    const target = row.type === 'fieldEntry'
      ? focusTarget(rowId, row.parentId ?? null, null, 'field-name')
      : rowFocusTarget(rowId, row.parentId ?? null, null);
    setUi((prev) => requestPendingInputState(prev, target, char, cursorEnd()));
  }, [index, setUi]);

  const applyOutcomeFocus = useCallback((focus: FocusHint | null) => {
    if (!focus) return;
    if (focus.placement?.kind === 'preserve') return;
    setUi((prev) => requestFocusState(
      prev,
      focusTarget(focus.nodeId, focus.parentId ?? null, null, focus.surface ?? 'row'),
      focus.placement ?? (focus.selectAll ? cursorAll() : cursorEnd()),
    ));
  }, [setUi]);

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
    setCommandOpen,
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

  const agentUserViewContext = useMemo<AgentUserViewContext>(() => {
    if (!index) {
      return {
        activePanelId,
        focusedPanelId: ui.focusedPanelId,
        focusSurface: ui.focusSurface,
        focusedNode: null,
        nodePanels: [],
      };
    }
    return buildAgentUserViewContext({
      activePanelId,
      panels,
      index,
      ui,
    });
  }, [activePanelId, index, panels, ui]);

  // The ingest bridge (agent-file-model F4): a file chip deep in the agent tree asks
  // to save its working file into the outliner. Resolve where the file lands the way
  // paste/drop does (insertionTargetFor — a sibling after the focused row, else the
  // current root), ingest the path into a committed asset in main, then create the
  // matching image/attachment node -- identical to a user-added file. Focus stays in
  // the agent panel (applyFocus: false). A ref keeps the bridge reading the latest
  // doc state while registering once (so it does not re-subscribe on every mutation).
  const insertFileBridgeRef = useRef({ index, agentUserViewContext, run });
  useEffect(() => {
    insertFileBridgeRef.current = { index, agentUserViewContext, run };
  }, [index, agentUserViewContext, run]);
  useEffect(() => onInsertFileIntoOutlinerRequest(async (path) => {
    const bridge = insertFileBridgeRef.current;
    if (!bridge.index) return false;
    const target = insertionTargetFor(bridge.agentUserViewContext, bridge.index);
    if (!target) return false;
    // Null when the file is gone or outside the trusted roots (e.g. a stale chip in
    // an old conversation): report not-inserted so the chip never falsely confirms.
    const asset = await api.ingestLocalFileToAsset(path);
    if (!asset) return false;
    // run() swallows a failed command into a null result (it never rejects), so a
    // create that fails mid-insert (e.g. the parent was deleted between resolve and
    // now) would otherwise still report success. Confirm only on a real CommandResult.
    const result = await createAssetNode(bridge.run, target.parentId, target.index, asset, { applyFocus: false });
    return result !== null;
  }), []);

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

  if (!index) {
    return (
      <div className="app">
        <div className="loading-panel">
          {error ? t.shell.startupError({ error }) : t.common.loading}
        </div>
      </div>
    );
  }

  const appShellStyle = {
    '--sidebar-width': `${sidebarWidth}px`,
    '--agent-width': `${agentWidth}px`,
  } as CSSProperties;

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

        <AgentDock
          index={index}
          railState={agentRailState}
          userViewContext={agentUserViewContext}
          onOpenNodeReference={openNodeReferenceFromAgent}
          onOpenDebugPanel={openAgentDebugPanel}
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

      {ui.commandOpen && (
        <CommandPalette
          projection={index.projection}
          index={index}
          onClose={() => setCommandOpen(false)}
          onEnsureToday={ensureTodayNode}
          onFocus={focusNode}
          onRoot={navigateRoot}
          run={run}
        />
      )}

      {error && (
        <div className="error">
          <span>{error}</span>
          <ButtonControl className="error-close-button" aria-label={t.shell.errorDismiss} onClick={() => setError(null)}>
            <CloseIcon size={ICON_SIZE.menu} />
          </ButtonControl>
        </div>
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
