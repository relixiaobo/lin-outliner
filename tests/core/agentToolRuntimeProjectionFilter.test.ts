import { describe, expect, test } from 'bun:test';
import { createFilteredTextSearchIndex, createTextSearchIndex } from '../../src/core/textSearchIndex';
import type { DocumentProjection, NodeProjection } from '../../src/core/types';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import type {
  OutlinerProjectionFilter,
  OutlinerToolHost,
  ProjectionIndex,
} from '../../src/main/agent/capabilities/agentNodeToolTypes';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import type { AgentTool } from '../../src/main/agent/runtime/kernel/types';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';

describe('ToolRuntime projection filtering', () => {
  test('filters projection, maintained read model, and text index inside one tool causation', async () => {
    const projection = testProjection();
    const hiddenIds = new Set(['hidden']);
    const fullIndex: ProjectionIndex = {
      projection,
      nodes: new Map(projection.nodes.map((node) => [node.id, node])),
    };
    const textIndex = createTextSearchIndex(projection.nodes.map((node) => ({
      id: node.id,
      kind: node.type,
      fields: [{ key: 'title', text: node.content.text }],
    })));
    const calls: Array<{ surface: string; itemId: string }> = [];
    const projectionFilter: OutlinerProjectionFilter = {
      filterProjection: (source, causation) => {
        calls.push({ surface: 'projection', itemId: causation.itemId });
        return visibleProjection(source, hiddenIds);
      },
      filterProjectionIndex: (source, causation) => {
        calls.push({ surface: 'readModel', itemId: causation.itemId });
        const visible = visibleProjection(source.projection, hiddenIds);
        return {
          projection: visible,
          nodes: new Map(visible.nodes.map((node) => [node.id, node])),
        };
      },
      filterTextSearchIndex: (source, causation) => {
        calls.push({ surface: 'textIndex', itemId: causation.itemId });
        return createFilteredTextSearchIndex(source, hiddenIds);
      },
    };
    const host: OutlinerToolHost = {
      getProjection: () => projection,
      getDocumentReadModel: () => ({ asProjectionIndex: () => fullIndex }),
      getTextSearchIndex: () => textIndex,
      handle: async () => ({}),
    };
    let observed: {
      projectionIds: string[];
      readModelIds: string[];
      searchIds: string[];
    } | null = null;
    const runtime = new ToolRuntime(runtimeService(), {
      outliner: host,
      outlinerProjectionFilter: projectionFilter,
      capabilityTools: (_context, outliner) => [probeTool(outliner!, (value) => { observed = value; })],
      capabilityConfig: { blocks: [] },
    });
    const tool = (await runtime.createTools(runtimeContext())).find((entry) => entry.name === 'node_search');
    if (!tool) throw new Error('Expected node_search probe tool');

    await tool.execute('tool:probe', {});

    expect(observed).toEqual({
      projectionIds: ['visible'],
      readModelIds: ['visible'],
      searchIds: ['visible'],
    });
    expect(calls).toEqual([
      { surface: 'projection', itemId: 'tool:probe' },
      { surface: 'readModel', itemId: 'tool:probe' },
      { surface: 'textIndex', itemId: 'tool:probe' },
    ]);
  });
});

function probeTool(
  host: OutlinerToolHost,
  observe: (value: { projectionIds: string[]; readModelIds: string[]; searchIds: string[] }) => void,
): AgentTool {
  return {
    name: 'node_search',
    label: 'Projection filter probe',
    description: 'Projection filter probe.',
    parameters: { type: 'object', additionalProperties: false },
    execute: async () => {
      observe({
        projectionIds: host.getProjection().nodes.map((node) => node.id),
        readModelIds: [...host.getDocumentReadModel!().asProjectionIndex().nodes.keys()],
        searchIds: host.getTextSearchIndex!().search('needle').map((result) => result.id),
      });
      return { content: [{ type: 'text', text: 'ok' }], details: { ok: true } };
    },
  };
}

function runtimeService(): ThreadService {
  return {
    collaborationToolContributions: async () => [],
    extensionToolContributions: async () => [],
    notifyToolStarted: async () => undefined,
    notifyToolCompleted: async () => undefined,
  } as unknown as ThreadService;
}

function runtimeContext(): TurnExecutionContext {
  return {
    thread: {
      id: 'thread:probe',
      parentThreadId: null,
      cwd: process.cwd(),
    },
    turn: { id: 'turn:probe' },
    configuration: {
      profileName: 'projection-filter-probe',
      developerInstructions: [],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: ['node_search'],
      skills: [],
      preloadedSkills: [],
      plugins: [],
      mcpServers: [],
    },
  } as unknown as TurnExecutionContext;
}

function testProjection(): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'workspace',
    libraryId: 'library',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'today',
    nodes: [
      node('visible', 'Visible needle'),
      node('hidden', 'Hidden needle'),
    ],
  };
}

function node(id: string, text: string): NodeProjection {
  return {
    id,
    children: [],
    content: { text, spans: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    type: 'text',
    fieldEntries: [],
    references: [],
  } as NodeProjection;
}

function visibleProjection(
  projection: DocumentProjection,
  hiddenIds: ReadonlySet<string>,
): DocumentProjection {
  return {
    ...projection,
    nodes: projection.nodes.filter((node) => !hiddenIds.has(node.id)),
  };
}
