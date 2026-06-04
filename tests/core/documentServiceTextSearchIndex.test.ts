import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { plainText, replaceAllRichTextPatch, type SearchHit } from '../../src/core/types';

let electronUserDataRoot = '';

mock.module('electron', () => ({
  app: {
    getPath: () => electronUserDataRoot,
  },
}));

type DocumentServiceModule = typeof import('../../src/main/documentService');
type DocumentServiceInstance = InstanceType<DocumentServiceModule['DocumentService']>;

let documentServiceModule: Promise<DocumentServiceModule> | null = null;
let activeServices: DocumentServiceInstance[] = [];

async function createService(): Promise<DocumentServiceInstance> {
  documentServiceModule ??= import('../../src/main/documentService');
  const { DocumentService } = await documentServiceModule;
  const service = new DocumentService();
  await service.initWorkspace();
  activeServices.push(service);
  return service;
}

function focusNodeId(outcome: unknown): string {
  const focus = (outcome as { focus?: { nodeId?: unknown } }).focus;
  expect(typeof focus?.nodeId).toBe('string');
  return focus.nodeId as string;
}

async function searchNodeIds(service: DocumentServiceInstance, query: string): Promise<string[]> {
  const hits = await service.handle('search_nodes', { query }) as SearchHit[];
  return hits.map((hit) => hit.nodeId);
}

function searchResultTargetIds(service: DocumentServiceInstance, searchId: string): string[] {
  const projection = service.getProjection();
  const nodes = new Map(projection.nodes.map((node) => [node.id, node]));
  const searchNode = nodes.get(searchId);
  expect(searchNode).toBeDefined();
  return searchNode!.children.flatMap((childId): string[] => {
    const child = nodes.get(childId);
    return child?.type === 'reference' && child.targetId ? [child.targetId] : [];
  });
}

describe('DocumentService text search index', () => {
  beforeEach(async () => {
    electronUserDataRoot = await mkdtemp(path.join(tmpdir(), 'lin-document-service-text-search-'));
  });

  afterEach(async () => {
    for (const service of activeServices) await service.flushPendingChanges();
    activeServices = [];
    await rm(electronUserDataRoot, { recursive: true, force: true });
    electronUserDataRoot = '';
  });

  test('preserves strict string-match semantics through the live index', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    await service.handle('create_node', { parentId: rootId, index: null, text: 'Alpha project' });
    await service.handle('create_node', { parentId: rootId, index: null, text: 'Beta launch' });
    await service.handle('create_node', { parentId: rootId, index: null, text: 'Alpha beta' });

    expect(await searchNodeIds(service, 'alpha beta')).toHaveLength(1);
    expect(await searchNodeIds(service, 'alpha gamma')).toEqual([]);
  });

  test('keeps text, tag, and trash updates fresh incrementally', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const nodeId = focusNodeId(await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Alpha project',
    }));

    expect(await searchNodeIds(service, 'alpha')).toContain(nodeId);

    await service.handle('apply_node_text_patch', {
      nodeId,
      patch: replaceAllRichTextPatch(plainText('Gamma project')),
    });
    expect(await searchNodeIds(service, 'gamma')).toContain(nodeId);
    expect(await searchNodeIds(service, 'alpha')).not.toContain(nodeId);

    const tagId = focusNodeId(await service.handle('create_tag', { name: 'Urgent' }));
    await service.handle('apply_tag', { nodeId, tagId });
    expect(await searchNodeIds(service, 'urgent')).toContain(nodeId);

    await service.handle('apply_node_text_patch', {
      nodeId: tagId,
      patch: replaceAllRichTextPatch(plainText('Waiting')),
    });
    expect(await searchNodeIds(service, 'waiting')).toContain(nodeId);
    expect(await searchNodeIds(service, 'urgent')).not.toContain(nodeId);

    await service.handle('trash_node', { nodeId });
    expect(await searchNodeIds(service, 'gamma')).not.toContain(nodeId);
    expect(await searchNodeIds(service, 'waiting')).not.toContain(nodeId);

    await service.handle('restore_node', { nodeId });
    expect(await searchNodeIds(service, 'gamma')).toContain(nodeId);
    expect(await searchNodeIds(service, 'waiting')).toContain(nodeId);

    await service.flushPendingChanges();
  });

  test('uses indexed relevance when materializing saved searches inside agent transactions', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    let exact = '';
    let loose = '';
    let searchId = '';

    await service.transaction({ origin: 'agent', tool: 'node_create' }, async () => {
      exact = focusNodeId(await service.handle('create_node', {
        parentId: rootId,
        index: null,
        text: 'Launch design',
      }));
      loose = focusNodeId(await service.handle('create_node', {
        parentId: rootId,
        index: null,
        text: 'Design review',
      }));
      await service.handle('update_node_description', {
        nodeId: loose,
        description: 'Launch notes',
      });
      searchId = focusNodeId(await service.handle('create_search_node', {
        parentId: rootId,
        index: null,
        config: {
          title: 'Launch design',
          query: { kind: 'rule', op: 'STRING_MATCH', text: 'launch design' },
        },
      }));
    });

    expect(searchResultTargetIds(service, searchId)).toEqual([exact, loose]);

    await service.handle('refresh_search_node_results', { nodeId: searchId });
    expect(searchResultTargetIds(service, searchId)).toEqual([exact, loose]);
  });

  test('rebuilds the text index when core revision deltas skip ahead', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const core = (service as unknown as { core: { createNode: (parentId: string, index: number | null, text: string) => unknown } }).core;

    const first = focusNodeId(core.createNode(rootId, null, 'First drift'));
    const second = focusNodeId(core.createNode(rootId, null, 'Second drift'));

    expect(await searchNodeIds(service, 'first drift')).toContain(first);
    expect(await searchNodeIds(service, 'second drift')).toContain(second);
  });
});
