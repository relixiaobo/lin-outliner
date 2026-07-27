import { describe, expect, test } from 'bun:test';
import type { DocumentProjection, NodeProjection } from '../../src/core/types';
import { buildIndex, type UiState } from '../../src/renderer/state/document';
import { buildRendererUserViewHints } from '../../src/renderer/ui/agent/userViewContext';
import type { WorkspacePanelState } from '../../src/renderer/ui/workspaceLayoutTypes';

function node(id: string, text = id, patch: Partial<NodeProjection> = {}): NodeProjection {
  return {
    id,
    children: [],
    content: { text, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
    ...patch,
  } as NodeProjection;
}

function projection(nodes: NodeProjection[], todayId = 'root'): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'root',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId,
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
    selectionRootId: null,
    selectionSource: null,
    focusRequest: null,
    pendingInputChar: null,
    pendingReferenceConversion: null,
    pendingReferenceTypeAhead: null,
    trailingDraftPlacement: null,
    expanded: new Set(),
    expandedHiddenFields: new Set(),
    editingDescriptionId: null,
    commandOpen: false,
    batchTagSelectorOpen: false,
    toolbarDropdownRequest: null,
    ...patch,
  };
}

function panel(rootId = 'root'): WorkspacePanelState {
  return {
    id: 'panel-1',
    type: 'workspace',
    view: { kind: 'outliner', rootId },
    size: 1,
    backStack: [],
    forwardStack: [],
  };
}

describe('renderer Agent user-view hints', () => {
  test('sends structural identities without renderer-authored Node text', () => {
    const index = buildIndex(projection([
      node('root', 'Authoritative root', { children: ['focused'] }),
      node('focused', 'Renderer must not send this title', { parentId: 'root' }),
    ]));

    const hints = buildRendererUserViewHints({
      activePanelId: 'panel-1',
      panels: [panel()],
      index,
      ui: ui({ focusedId: 'focused', focusedPanelId: 'panel-1', focusSurface: 'row' }),
    });

    expect(hints).toEqual({
      activePanelId: 'panel-1',
      focusedPanelId: 'panel-1',
      focusSurface: 'row',
      focusedNodeId: 'focused',
      selectedNodeIds: [],
      panels: [{
        panelId: 'panel-1',
        rootNodeId: 'root',
        order: 1,
        active: true,
        focused: true,
        visibleNodes: [
          { nodeId: 'root', depth: 0, expanded: true },
          { nodeId: 'focused', depth: 1, expanded: false },
        ],
        visibleOutlineTruncated: false,
      }],
      truncated: false,
    });
    expect(JSON.stringify(hints)).not.toContain('Renderer must not send this title');
  });

  test('bounds the visible outline to 80 Nodes and depth 5 with explicit truncation', () => {
    const wideChildren = Array.from({ length: 90 }, (_, index) => `wide-${index}`);
    const chain = Array.from({ length: 7 }, (_, index) => `depth-${index}`);
    const wideIndex = buildIndex(projection([
      node('root', 'Root', { children: wideChildren }),
      ...wideChildren.map((id) => node(id, id, { parentId: 'root' })),
    ]));
    const wide = buildRendererUserViewHints({
      activePanelId: 'panel-1',
      panels: [panel()],
      index: wideIndex,
      ui: ui(),
    });
    expect(wide.panels[0]?.visibleNodes).toHaveLength(80);
    expect(wide.panels[0]?.visibleOutlineTruncated).toBe(true);
    expect(wide.truncated).toBe(true);

    const depthNodes = chain.map((id, index) => node(id, id, {
      parentId: index === 0 ? undefined : chain[index - 1],
      children: index === chain.length - 1 ? [] : [chain[index + 1]!],
    }));
    const depthIndex = buildIndex(projection(depthNodes, chain[0]));
    const depth = buildRendererUserViewHints({
      activePanelId: 'panel-1',
      panels: [panel(chain[0])],
      index: depthIndex,
      ui: ui({ expanded: new Set(chain) }),
    });
    expect(depth.panels[0]?.visibleNodes.map((entry) => entry.depth)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(depth.panels[0]?.visibleOutlineTruncated).toBe(true);
    expect(depth.truncated).toBe(true);
  });

  test('visits expanded descendants once with their structural depth', () => {
    const index = buildIndex(projection([
      node('root', 'Root', { children: ['parent', 'sibling'] }),
      node('parent', 'Parent', { parentId: 'root', children: ['child'] }),
      node('child', 'Child', { parentId: 'parent', children: ['grandchild'] }),
      node('grandchild', 'Grandchild', { parentId: 'child' }),
      node('sibling', 'Sibling', { parentId: 'root' }),
    ]));

    const hints = buildRendererUserViewHints({
      activePanelId: 'panel-1',
      panels: [panel()],
      index,
      ui: ui({ expanded: new Set(['parent', 'child']) }),
    });

    expect(hints.panels[0]?.visibleNodes).toEqual([
      { nodeId: 'root', depth: 0, expanded: true },
      { nodeId: 'parent', depth: 1, expanded: true },
      { nodeId: 'child', depth: 2, expanded: true },
      { nodeId: 'grandchild', depth: 3, expanded: false },
      { nodeId: 'sibling', depth: 1, expanded: false },
    ]);
    expect(hints.panels[0]?.visibleOutlineTruncated).toBe(false);
  });

  test('orders and bounds selection to 50 authoritative Node IDs', () => {
    const children = Array.from({ length: 55 }, (_, index) => `selected-${index}`);
    const index = buildIndex(projection([
      node('root', 'Root', { children }),
      ...children.map((id) => node(id, id, { parentId: 'root' })),
    ]));
    const selectedIds = new Set([...children].reverse());

    const hints = buildRendererUserViewHints({
      activePanelId: 'panel-1',
      panels: [panel()],
      index,
      ui: ui({ selectedIds, selectionRootId: 'root', focusedPanelId: 'panel-1' }),
    });

    expect(hints.selectedNodeIds).toEqual(children.slice(0, 50));
    expect(hints.truncated).toBe(true);
  });
});
