import { describe, expect, test } from 'bun:test';
import type { RendererUserViewHints } from '../../src/core/agent/protocol';
import type { DocumentProjection, NodeProjection } from '../../src/core/types';
import { buildUserViewPayload, outlineText } from '../../src/main/agent/context/userView';

describe('main-owned Agent user view', () => {
  test('derives reference child counts from the resolved displayed parent', () => {
    const hints: RendererUserViewHints = {
      activePanelId: 'panel-1',
      focusedPanelId: 'panel-1',
      focusSurface: 'row',
      focusedNodeId: 'ref',
      selectedNodeIds: [],
      panels: [{
        panelId: 'panel-1',
        rootNodeId: 'root',
        order: 1,
        active: true,
        focused: true,
        visibleNodes: [
          { nodeId: 'root', depth: 0, expanded: true },
          { nodeId: 'ref', depth: 1, expanded: true },
          { nodeId: 'child', depth: 2, expanded: false },
        ],
        visibleOutlineTruncated: false,
      }],
      truncated: false,
    };
    const payload = buildUserViewPayload(hints, projection([
      node('root', 'Root', { children: ['ref'] }),
      node('ref', 'Reference', { parentId: 'root', type: 'reference', targetId: 'target' }),
      node('target', 'Target', { children: ['child'] }),
      node('child', 'Child', { parentId: 'target' }),
    ]), []);

    expect(payload?.panels[0]).toMatchObject({
      childCount: 1,
      visibleOutline: [
        { nodeId: 'root', childCount: 1, collapsed: false },
        { nodeId: 'ref', childCount: 1, collapsed: false },
        { nodeId: 'child', childCount: 0, collapsed: false },
      ],
    });
  });

  test('surfaces an ordinary table owner through the shared view directive', () => {
    const nodes = [
      node('root', 'Projects', { children: ['view'] }),
      node('view', '', { parentId: 'root', type: 'viewDef', viewMode: 'table' }),
      node('plain', 'Notes'),
    ];
    const byId = new Map(nodes.map((entry) => [entry.id, entry]));

    expect(outlineText(byId.get('root')!, byId)).toBe('%%view:table%% Projects');
    expect(outlineText(byId.get('plain')!, byId)).toBe('Notes');
  });
});

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
    ...patch,
  } as NodeProjection;
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
    todayId: 'root',
    nodes,
  };
}
