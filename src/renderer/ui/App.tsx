import { useCallback, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api/client';
import type { DocumentProjection, FocusHint, NodeId } from '../api/types';
import { useDocumentIndex, useUiState } from '../state/document';
import { AgentDock } from './AgentDock';
import { CommandPalette } from './CommandPalette';
import { Sidebar } from './Sidebar';
import type { TopBarTab } from './TopBar';
import { TopBar } from './TopBar';
import { CloseIcon, ICON_SIZE } from './icons';
import {
  clearFocusState,
  cursorAll,
  cursorEnd,
  requestFocusState,
  requestPendingInputState,
  rowFocusTarget,
  focusTarget,
} from './focus/focusModel';
import { useDragSelection } from './interactions/dragSelection';
import { BatchTagSelector } from './outliner/BatchTagSelector';
import { ButtonControl } from './primitives/ButtonControl';
import type { TriggerState } from './shared';
import { textOf, useCommandRunner } from './shared';
import { WorkspaceCanvas } from './WorkspaceCanvas';
import { useResizableLayout } from './useResizableLayout';
import { useSelectionDismissal } from './useSelectionDismissal';
import { useWorkspaceKeyboard } from './useWorkspaceKeyboard';
import { useWorkspaceTabs } from './useWorkspaceTabs';

export function App() {
  const [projection, setProjection] = useState<DocumentProjection | null>(null);
  const [ui, setUi] = useUiState();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const [sidebarExpandedIds, setSidebarExpandedIds] = useState<Set<NodeId>>(() => new Set());
  const [pendingFocus, setPendingFocus] = useState<FocusHint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<TriggerState>(null);
  const [dragId, setDragId] = useState<NodeId | null>(null);
  const index = useDocumentIndex(projection);
  const run = useCommandRunner(setProjection, setPendingFocus, setError);

  const setCommandOpen = useCallback((commandOpen: boolean) => {
    setUi((prev) => ({ ...prev, commandOpen }));
  }, [setUi]);

  const focusNode = useCallback((nodeId: NodeId | null) => {
    setUi((prev) => {
      if (!nodeId) return clearFocusState(prev);
      return requestFocusState(prev, rowFocusTarget(nodeId, null, null), cursorEnd());
    });
  }, [setUi]);

  const {
    activeOutlinerPanel,
    activeTab,
    activeTabId,
    activatePanel,
    closePanel,
    closeTab,
    createTab,
    initializeTabs,
    navigatePanelBack: goPanelBack,
    navigatePanelForward: goPanelForward,
    navigatePanelRoot: setPanelRoot,
    navigateRoot: setActivePanelRoot,
    openAgentDebugPanel,
    openPanel,
    resizePanelPair,
    rootId,
    selectTab,
    tabs,
  } = useWorkspaceTabs({ focusNode });
  const pageHistoryPanel = activeOutlinerPanel;

  const {
    agentWidth,
    beginAgentResize,
    beginPanelResize,
    beginSidebarResize,
    canvasRef,
    resizeAgentWithKeyboard,
    resizePanelPairWithKeyboard,
    resizeSidebarWithKeyboard,
    sidebarWidth,
  } = useResizableLayout({ activeTab, resizePanelPair });

  useDragSelection({ rootId, index, ui, setUi });

  useEffect(() => {
    void run(async () => {
      const initial = await api.initWorkspace();
      const initialFocusId = initializeTabs(initial);
      setUi((prev) => {
        const next = requestFocusState(prev, rowFocusTarget(initialFocusId, null, null), cursorEnd());
        return {
          ...next,
          expanded: new Set([...next.expanded, initial.rootId]),
        };
      });
      return initial;
    });
  }, [initializeTabs, run, setUi]);

  useEffect(() => {
    const unlisten = window.lin?.onDocumentEvent((event) => {
      if (event.type === 'projection_changed') setProjection(event.projection);
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const expandNodeInOutliner = useCallback((nodeId: NodeId) => {
    setUi((prev) => {
      const expanded = new Set(prev.expanded);
      expanded.add(nodeId);
      return { ...prev, expanded };
    });
  }, [setUi]);

  const navigateRoot = useCallback((nodeId: NodeId) => {
    setActivePanelRoot(nodeId);
    expandNodeInOutliner(nodeId);
  }, [expandNodeInOutliner, setActivePanelRoot]);

  const navigatePanelRoot = useCallback((panelId: string, nodeId: NodeId) => {
    setPanelRoot(panelId, nodeId);
    expandNodeInOutliner(nodeId);
  }, [expandNodeInOutliner, setPanelRoot]);

  const navigatePanelBack = useCallback((panelId: string) => {
    const nodeId = goPanelBack(panelId);
    if (nodeId) expandNodeInOutliner(nodeId);
  }, [expandNodeInOutliner, goPanelBack]);

  const navigatePanelForward = useCallback((panelId: string) => {
    const nodeId = goPanelForward(panelId);
    if (nodeId) expandNodeInOutliner(nodeId);
  }, [expandNodeInOutliner, goPanelForward]);

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
    expandNodeInOutliner(nodeId);
  }, [expandNodeInOutliner, openPanel]);

  const openActiveRootInPanel = useCallback(() => {
    if (!rootId) return;
    openRootInPanel(rootId);
  }, [openRootInPanel, rootId]);

  const requestEditFocus = useCallback((nodeId: NodeId) => {
    setUi((prev) => requestFocusState(prev, rowFocusTarget(nodeId, null, null), cursorEnd()));
    setPendingFocus({ nodeId, selectAll: false });
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

  if (!projection || !index) {
    return (
      <div className="app">
        <div className="loading-panel">
          {error ? `Startup failed: ${error}` : 'Loading...'}
        </div>
      </div>
    );
  }

  const topBarTabs: TopBarTab[] = tabs.map((tab) => {
    const tabActivePanel = tab.panels.find((panel) => panel.id === tab.activePanelId) ?? tab.panels[0];
    const title = tabActivePanel?.type === 'outliner'
      ? textOf(index.byId.get(tabActivePanel.rootId)) || 'Workspace'
      : tabActivePanel?.type === 'agent-debug'
        ? 'Agent Debug'
        : 'Workspace';
    return {
      id: tab.id,
      panelCount: tab.panels.length,
      title,
    };
  });
  const appShellStyle = {
    '--sidebar-width': `${sidebarWidth}px`,
    '--agent-width': `${agentWidth}px`,
  } as CSSProperties;

  return (
    <div className="app">
      <TopBar
        agentOpen={agentOpen}
        sidebarOpen={sidebarOpen}
        tabs={topBarTabs}
        activeTabId={activeTabId}
        canNavigateBack={Boolean(pageHistoryPanel?.pageBackStack?.length)}
        canNavigateForward={Boolean(pageHistoryPanel?.pageForwardStack?.length)}
        onCreateTab={createTab}
        onCloseTab={closeTab}
        onNavigateBack={navigateActivePanelBack}
        onNavigateForward={navigateActivePanelForward}
        onSelectTab={selectTab}
        onToggleAgent={() => setAgentOpen((open) => !open)}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
      />

      <div
        className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${agentOpen ? '' : 'agent-collapsed'}`}
        style={appShellStyle}
      >
        <Sidebar
          expandedIds={sidebarExpandedIds}
          index={index}
          onNavigateRoot={navigateRoot}
          onOpenPanel={openRootInPanel}
          onResizeKeyDown={resizeSidebarWithKeyboard}
          onResizeStart={beginSidebarResize}
          onToggleTreeNode={toggleSidebarTreeNode}
          projection={projection}
          rootId={rootId}
        />

        <WorkspaceCanvas
          activeTab={activeTab}
          canvasRef={canvasRef}
          dragId={dragId}
          index={index}
          onActivatePanel={activatePanel}
          onClosePanel={closePanel}
          onNavigatePanelBack={navigatePanelBack}
          onNavigatePanelRoot={navigatePanelRoot}
          onPanelResizeKeyDown={resizePanelPairWithKeyboard}
          onPanelResizeStart={beginPanelResize}
          run={run}
          setDragId={setDragId}
          setTrigger={setTrigger}
          setUi={setUi}
          trigger={trigger}
          ui={ui}
        />

        <AgentDock
          onOpenDebugPanel={openAgentDebugPanel}
          onResizeKeyDown={resizeAgentWithKeyboard}
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
          projection={projection}
          index={index}
          onClose={() => setCommandOpen(false)}
          onFocus={focusNode}
          onRoot={navigateRoot}
          run={run}
        />
      )}

      {error && (
        <div className="error">
          <span>{error}</span>
          <ButtonControl className="error-close-button" onClick={() => setError(null)}>
            <CloseIcon size={ICON_SIZE.menu} />
          </ButtonControl>
        </div>
      )}
    </div>
  );
}
