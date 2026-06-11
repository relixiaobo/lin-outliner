import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AgentUserViewContext } from '../../core/agentTypes';
import { api } from '../api/client';
import { parseIsoLocalDate, todayIsoLocalDate, type FocusHint, type NodeId } from '../api/types';
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
import { buildAgentUserViewContext } from './agent/userViewContext';
import { onAgentRevealRequest } from '../agent/agentReveal';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { useResizableLayout } from './useResizableLayout';
import { useSelectionDismissal } from './useSelectionDismissal';
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard';
import { useWorkspaceLayout } from './useWorkspaceLayout';
import { useWorkspacePinnedNodes } from './useWorkspacePinnedNodes';
import { useT } from '../i18n/I18nProvider';
import { InlineFilePreviewLayer } from './editor/InlineFilePreviewLayer';
import {
  persistOutlineViewState,
  restoreOutlineExpansionForRoot,
} from '../state/outlineViewState';

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
  // A content row (e.g. a command node's Run button) can ask to surface the agent
  // panel on its delivery conversation; open the rail so the run is visible.
  useEffect(() => onAgentRevealRequest(() => setAgentOpen(true)), []);
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

  const {
    activeOutlinerPanel,
    activePanelId,
    activatePanel,
    closePanel,
    initializeLayout,
    navigatePanelBack: goPanelBack,
    navigatePanelForward: goPanelForward,
    navigatePanelRoot: setPanelRoot,
    navigateRoot: setActivePanelRoot,
    openAgentDebugPanel,
    openPanel,
    panels,
    resizePanelPair,
    rootId,
  } = useWorkspaceLayout({ focusNode });
  // Global Back/Forward (Cmd+[ / Cmd+]) act on the active pane's page history.
  // activeOutlinerPanel is strict (null when a debug pane is active), so the
  // keyboard handlers below no-op instead of navigating an unrelated pane.
  const pageHistoryPanel = activeOutlinerPanel;

  const {
    agentWidth,
    beginAgentResize,
    beginPanelResize,
    beginSidebarResize,
    canvasRef,
    resetAgentWidth,
    resetPanelPair,
    resetSidebarWidth,
    resizeAgentWithKeyboard,
    resizePanelPairWithKeyboard,
    resizeSidebarWithKeyboard,
    sidebarWidth,
  } = useResizableLayout({ panels, resizePanelPair });
  const { isNodePinned, pinnedNodeIds, togglePin } = useWorkspacePinnedNodes(index?.projection ?? null);

  useDragSelection({ rootId, index, ui, setUi });

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

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
      if (panel.type !== 'outliner' || persistedRootIds.has(panel.rootId)) continue;
      persistedRootIds.add(panel.rootId);
      persistOutlineViewState(panel.rootId, currentIndex.byId, {
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

  const navigateRoot = useCallback((nodeId: NodeId, options?: NavigateRootOptions) => {
    if (options?.newPane) {
      openPanel(nodeId);
      restoreNodeInOutliner(nodeId);
      return;
    }
    setActivePanelRoot(nodeId, options);
    restoreNodeInOutliner(nodeId);
  }, [openPanel, restoreNodeInOutliner, setActivePanelRoot]);

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

  const navigatePanelRoot = useCallback((panelId: string, nodeId: NodeId, options?: NavigateRootOptions) => {
    if (options?.newPane) {
      openPanel(nodeId);
      restoreNodeInOutliner(nodeId);
      return;
    }
    setPanelRoot(panelId, nodeId, options);
    restoreNodeInOutliner(nodeId);
  }, [openPanel, restoreNodeInOutliner, setPanelRoot]);

  const navigatePanelBack = useCallback((panelId: string) => {
    const nodeId = goPanelBack(panelId);
    if (nodeId) restoreNodeInOutliner(nodeId);
  }, [goPanelBack, restoreNodeInOutliner]);

  const navigatePanelForward = useCallback((panelId: string) => {
    const nodeId = goPanelForward(panelId);
    if (nodeId) restoreNodeInOutliner(nodeId);
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
    openPanel(nodeId);
    restoreNodeInOutliner(nodeId);
  }, [openPanel, restoreNodeInOutliner]);

  const openNodeReferenceFromAgent = useCallback((nodeId: NodeId, options?: NavigateRootOptions) => {
    navigateRoot(nodeId, { focus: false, newPane: options?.newPane });
  }, [navigateRoot]);

  const openActiveRootInPanel = useCallback(() => {
    // Cmd+M opens the *active* outliner pane's root in a new pane. When a debug
    // pane is active there is no active outliner root, so this is a no-op rather
    // than reaching across to the ambient (first) outliner.
    const activeRootId = activeOutlinerPanel?.rootId;
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
        onToggleAgent={() => setAgentOpen((open) => !open)}
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
          onNavigatePanelRoot={navigatePanelRoot}
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
