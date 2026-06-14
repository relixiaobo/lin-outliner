import { describe, expect, test } from 'bun:test';
import { buildIndex, type UiState } from '../../src/renderer/state/document';
import {
  buildAgentUserViewContext,
  composerCurrentNodeId,
  insertionTargetFor,
} from '../../src/renderer/ui/agent/userViewContext';
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
      activePanelId: 'panel-1',
      panels: [
        {
          id: 'panel-1',
          type: 'workspace',
          view: { kind: 'outliner', rootId: 'today' },
          size: 1,
          backStack: [],
          forwardStack: [],
        },
        {
          id: 'panel-2',
          type: 'workspace',
          view: { kind: 'outliner', rootId: 'root' },
          size: 1,
          backStack: [],
          forwardStack: [],
        },
      ],
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

// composerCurrentNodeId is the shared resolver for "the node this conversation is
// about" -- used by the composer (what the agent is told) and the ingest bridge
// (where an inserted file lands). Its fallback order is the F4 insertion target.
describe('composerCurrentNodeId', () => {
  const index = buildIndex(projection([
    node('workspace', 'Workspace', { children: ['root'] }),
    node('root', 'Library', { parentId: 'workspace', children: ['daily-notes'] }),
    node('daily-notes', 'Daily Notes', { parentId: 'root', children: ['today'] }),
    node('today', '2026-05-19', { parentId: 'daily-notes', children: ['child-1'] }),
    node('child-1', 'Focused task', { parentId: 'today' }),
  ]));

  function contextFor(input: { activePanelId: string | null; focusedId?: string | null }) {
    return buildAgentUserViewContext({
      activePanelId: input.activePanelId,
      panels: [
        { id: 'panel-1', type: 'workspace', view: { kind: 'outliner', rootId: 'today' }, size: 1, backStack: [], forwardStack: [] },
        { id: 'panel-2', type: 'workspace', view: { kind: 'outliner', rootId: 'root' }, size: 1, backStack: [], forwardStack: [] },
      ],
      index,
      ui: ui(input.focusedId ? { focusedId: input.focusedId, focusedPanelId: 'panel-1', focusSurface: 'row' } : {}),
    });
  }

  test('prefers the focused node', () => {
    expect(composerCurrentNodeId(contextFor({ activePanelId: 'panel-1', focusedId: 'child-1' }), index)).toBe('child-1');
  });

  test('falls back to the active panel root when nothing is focused', () => {
    expect(composerCurrentNodeId(contextFor({ activePanelId: 'panel-2' }), index)).toBe('root');
  });

  test('falls back to the first panel root when no panel is active', () => {
    expect(composerCurrentNodeId(contextFor({ activePanelId: null }), index)).toBe('today');
  });

  test('falls back to today when there are no outliner panels', () => {
    const context = buildAgentUserViewContext({ activePanelId: null, panels: [], index, ui: ui() });
    expect(composerCurrentNodeId(context, index)).toBe('today');
  });
});

// insertionTargetFor is where an ingested file lands: a sibling after the focused
// row (paste convention, so it is never buried under a media/code leaf), else the
// current outline root.
describe('insertionTargetFor', () => {
  const index = buildIndex(projection([
    node('workspace', 'Workspace', { children: ['root'] }),
    node('root', 'Library', { parentId: 'workspace', children: ['daily-notes'] }),
    node('daily-notes', 'Daily Notes', { parentId: 'root', children: ['today'] }),
    node('today', '2026-05-19', { parentId: 'daily-notes', children: ['child-1', 'child-2'] }),
    node('child-1', 'First task', { parentId: 'today' }),
    node('child-2', 'Second task', { parentId: 'today' }),
  ]));

  function contextFor(input: { activePanelId: string | null; focusedId?: string | null }) {
    return buildAgentUserViewContext({
      activePanelId: input.activePanelId,
      panels: [
        { id: 'panel-1', type: 'workspace', view: { kind: 'outliner', rootId: 'today' }, size: 1, backStack: [], forwardStack: [] },
        { id: 'panel-2', type: 'workspace', view: { kind: 'outliner', rootId: 'root' }, size: 1, backStack: [], forwardStack: [] },
      ],
      index,
      ui: ui(input.focusedId ? { focusedId: input.focusedId, focusedPanelId: 'panel-1', focusSurface: 'row' } : {}),
    });
  }

  test('inserts as a sibling right after the focused row, under its parent', () => {
    expect(insertionTargetFor(contextFor({ activePanelId: 'panel-1', focusedId: 'child-1' }), index))
      .toEqual({ parentId: 'today', index: 1 });
    expect(insertionTargetFor(contextFor({ activePanelId: 'panel-1', focusedId: 'child-2' }), index))
      .toEqual({ parentId: 'today', index: 2 });
  });

  test('appends into a focused node that is itself a root (no parent)', () => {
    expect(insertionTargetFor(contextFor({ activePanelId: 'panel-1', focusedId: 'workspace' }), index))
      .toEqual({ parentId: 'workspace', index: null });
  });

  test('appends into a focused panel root rather than escaping the visible subtree', () => {
    // 'today' is panel-1's root AND has a parent (daily-notes); a sibling-after would
    // land the file outside the zoomed-in view, so it must append into 'today'.
    expect(insertionTargetFor(contextFor({ activePanelId: 'panel-1', focusedId: 'today' }), index))
      .toEqual({ parentId: 'today', index: null });
  });

  test('appends into the active panel root when nothing is focused', () => {
    expect(insertionTargetFor(contextFor({ activePanelId: 'panel-2' }), index))
      .toEqual({ parentId: 'root', index: null });
  });

  test('appends into today when there are no outliner panels', () => {
    const context = buildAgentUserViewContext({ activePanelId: null, panels: [], index, ui: ui() });
    expect(insertionTargetFor(context, index)).toEqual({ parentId: 'today', index: null });
  });
});
