import { describe, expect, test } from 'bun:test';
import { buildIndex, type UiState } from '../../src/renderer/state/document';
import { buildAgentUserViewContext } from '../../src/renderer/ui/agent/userViewContext';
import type { DocumentProjection, NodeProjection } from '../../src/core/types';

function node(id: string, text: string, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    toolbarVisible: false,
    filterValues: [],
    ...patch,
  };
}

function projection(nodes: NodeProjection[]): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'root',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    settingsId: 'settings',
    todayId: 'today',
    nodes,
  };
}

function ui(patch: Partial<UiState> = {}): UiState {
  return {
    focusedId: null,
    focusedParentId: null,
    focusedPanelId: null,
    focusSurface: null,
    selectedId: null,
    selectedIds: new Set(),
    selectionAnchorId: null,
    focusRequest: null,
    pendingInputChar: null,
    expanded: new Set(),
    expandedHiddenFields: new Set(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
    ...patch,
  };
}

describe('agent user view context', () => {
  test('summarizes visible node panels and focus', () => {
    const index = buildIndex(projection([
      node('workspace', 'Workspace', { children: ['root'] }),
      node('root', 'Library', { parentId: 'workspace', children: ['daily-notes'] }),
      node('daily-notes', 'Daily Notes', { parentId: 'root', children: ['today'] }),
      node('today', '2026-05-19', { parentId: 'daily-notes', children: ['child-1'] }),
      node('child-1', 'Focused task', { parentId: 'today' }),
    ]));

    const context = buildAgentUserViewContext({
      activeTab: {
        id: 'tab-1',
        activePanelId: 'panel-1',
        panelSizes: { 'panel-1': 1, 'panel-2': 1 },
        panels: [
          { id: 'panel-1', type: 'outliner', rootId: 'today' },
          { id: 'panel-2', type: 'outliner', rootId: 'root' },
        ],
      },
      index,
      ui: ui({
        focusedId: 'child-1',
        focusedPanelId: 'panel-1',
        focusSurface: 'row',
      }),
    });

    expect(context.activePanelId).toBe('panel-1');
    expect(context.focusedNode).toMatchObject({
      nodeId: 'child-1',
      title: 'Focused task',
      panelId: 'panel-1',
      surface: 'row',
    });
    expect(context.nodePanels.map((panel) => ({
      panelId: panel.panelId,
      rootNodeId: panel.rootNodeId,
      rootTitle: panel.rootTitle,
      active: panel.active,
      focused: panel.focused,
      childCount: panel.childCount,
      visibleOutline: panel.visibleOutline,
      visibleOutlineTruncated: panel.visibleOutlineTruncated,
    }))).toEqual([
      {
        panelId: 'panel-1',
        rootNodeId: 'today',
        rootTitle: '2026-05-19',
        active: true,
        focused: true,
        childCount: 1,
        visibleOutline: [
          { nodeId: 'today', title: '2026-05-19', depth: 0 },
          { nodeId: 'child-1', title: 'Focused task', depth: 1, focused: true },
        ],
        visibleOutlineTruncated: false,
      },
      {
        panelId: 'panel-2',
        rootNodeId: 'root',
        rootTitle: 'Library',
        active: false,
        focused: false,
        childCount: 1,
        visibleOutline: [
          { nodeId: 'root', title: 'Library', depth: 0 },
          { nodeId: 'daily-notes', title: 'Daily Notes', depth: 1, collapsed: true, childCount: 1 },
        ],
        visibleOutlineTruncated: false,
      },
    ]);
  });
});
