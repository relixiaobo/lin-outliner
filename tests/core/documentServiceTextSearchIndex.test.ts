import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { plainText, replaceAllRichTextPatch, type SearchHit } from '../../src/core/types';
import { WorkspacePersistenceStore } from '../../src/main/workspacePersistenceStore';

let electronUserDataRoot = '';

mock.module('electron', () => ({
  app: {
    getPath: () => electronUserDataRoot,
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({ clearStorageData: async () => undefined }),
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

function countWorkspaceAppends(): { count: () => number; restore: () => void } {
  const original = WorkspacePersistenceStore.prototype.append;
  let count = 0;
  WorkspacePersistenceStore.prototype.append = async function append(capture) {
    count += 1;
    return original.call(this, capture);
  };
  return {
    count: () => count,
    restore: () => { WorkspacePersistenceStore.prototype.append = original; },
  };
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

  test('updates the text-search node map in place without cloning the document map', async () => {
    const service = await createService();
    const target = service as unknown as { textSearchNodes: Map<string, unknown> };
    const nodes = target.textSearchNodes;
    const rootId = service.getProjection().rootId;

    const created = focusNodeId(await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Map identity row',
    }));
    expect(target.textSearchNodes).toBe(nodes);

    await service.handle('apply_node_text_patch', {
      nodeId: created,
      patch: replaceAllRichTextPatch(plainText('Map identity changed')),
    });
    expect(target.textSearchNodes).toBe(nodes);
    expect(await searchNodeIds(service, 'map identity changed')).toContain(created);
  });

  test('removes and restores every descendant when a subtree crosses Trash', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const parentId = focusNodeId(await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Trash parent needle',
    }));
    const childId = focusNodeId(await service.handle('create_node', {
      parentId,
      index: null,
      text: 'Trash child needle',
    }));

    await service.handle('trash_node', { nodeId: parentId });
    expect(await searchNodeIds(service, 'trash child needle')).not.toContain(childId);

    await service.handle('restore_node', { nodeId: parentId });
    expect(await searchNodeIds(service, 'trash child needle')).toContain(childId);
  });

  test('prunes descendants when a parent is deleted in the same sparse delta', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const parentId = focusNodeId(await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Deleted parent needle',
    }));
    const childId = focusNodeId(await service.handle('create_node', {
      parentId,
      index: null,
      text: 'Deleted child needle',
    }));

    await service.handle('delete_node', { nodeId: parentId });

    expect(await searchNodeIds(service, 'deleted parent needle')).not.toContain(parentId);
    expect(await searchNodeIds(service, 'deleted child needle')).not.toContain(childId);
  });

  test('refreshes tag, field, and reference dependents when definitions or targets change', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const ownerId = focusNodeId(await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Dependency owner',
    }));
    const tagId = focusNodeId(await service.handle('create_tag', { name: 'Original tag label' }));
    await service.handle('apply_tag', { nodeId: ownerId, tagId });
    const fieldEntryId = focusNodeId(await service.handle('create_inline_field', {
      parentId: ownerId,
      index: null,
      name: 'Original field label',
      fieldType: 'plain',
    }));
    const fieldDefId = service.getProjection().nodes.find((node) => node.id === fieldEntryId)!.fieldDefId!;
    const referenceTargetId = focusNodeId(await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Original reference label',
    }));
    await service.handle('add_reference', { parentId: fieldEntryId, targetId: referenceTargetId, index: null });

    await service.handle('apply_node_text_patch', {
      nodeId: tagId,
      patch: replaceAllRichTextPatch(plainText('Renamed tag label')),
    });
    await service.handle('apply_node_text_patch', {
      nodeId: fieldDefId,
      patch: replaceAllRichTextPatch(plainText('Renamed field label')),
    });
    await service.handle('apply_node_text_patch', {
      nodeId: referenceTargetId,
      patch: replaceAllRichTextPatch(plainText('Renamed reference label')),
    });

    expect(await searchNodeIds(service, 'renamed tag label')).toContain(ownerId);
    expect(await searchNodeIds(service, 'renamed field label')).toContain(ownerId);
    expect(await searchNodeIds(service, 'renamed reference label')).toContain(ownerId);
    expect(await searchNodeIds(service, 'original tag label')).not.toContain(ownerId);
    expect(await searchNodeIds(service, 'original field label')).not.toContain(ownerId);
    expect(await searchNodeIds(service, 'original reference label')).not.toContain(ownerId);
  });

  test('coalesces bursty structural saves until flush', async () => {
    const appendCounter = countWorkspaceAppends();
    try {
      const service = await createService();
      const rootId = service.getProjection().rootId;

      await service.handle('create_node', { parentId: rootId, index: null, text: 'First structural write' });
      await service.handle('create_node', { parentId: rootId, index: null, text: 'Second structural write' });

      expect(appendCounter.count()).toBe(0);

      await service.flushPendingChanges();

      expect(appendCounter.count()).toBe(1);
      expect(await searchNodeIds(service, 'first structural write')).toHaveLength(1);
      expect(await searchNodeIds(service, 'second structural write')).toHaveLength(1);
    } finally {
      appendCounter.restore();
    }
  });

  test('drain waits for a mutation already admitted through the coordinator gate', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    let releaseGate!: () => void;
    let signalAdmitted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const admitted = new Promise<void>((resolve) => { signalAdmitted = resolve; });
    service.setMutationCoordinator(async (_meta, operation) => {
      signalAdmitted();
      await gate;
      return operation();
    });

    const mutation = service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Admission drain row',
    });
    await admitted;
    service.freezeMutationAdmission();
    let drained = false;
    const drain = service.drainPersistenceForQuit().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseGate();
    await mutation;
    await drain;
    expect(service.durablePersistenceRevision()).toBe(service.latestAcceptedPersistenceRevision());
  });

  test('persists a mutation accepted while the initial snapshot write is in flight', async () => {
    const originalCompact = WorkspacePersistenceStore.prototype.compact;
    let releaseCompact!: () => void;
    let signalCompact!: () => void;
    const compactStarted = new Promise<void>((resolve) => { signalCompact = resolve; });
    const compactGate = new Promise<void>((resolve) => { releaseCompact = resolve; });
    WorkspacePersistenceStore.prototype.compact = async function compact(snapshot) {
      signalCompact();
      await compactGate;
      return originalCompact.call(this, snapshot);
    };

    try {
      documentServiceModule ??= import('../../src/main/documentService');
      const { DocumentService } = await documentServiceModule;
      const service = new DocumentService();
      const initialized = service.initWorkspace();
      await compactStarted;

      const rootId = service.getProjection().rootId;
      const mutation = service.handle('create_node', {
        parentId: rootId,
        index: null,
        text: 'Accepted during initial compact',
      });
      await mutation;
      releaseCompact();
      await initialized;
      activeServices.push(service);
      await service.flushPendingChanges();

      const restored = new DocumentService();
      await restored.initWorkspace();
      activeServices.push(restored);
      expect(await searchNodeIds(restored, 'accepted during initial compact')).toHaveLength(1);
    } finally {
      WorkspacePersistenceStore.prototype.compact = originalCompact;
      releaseCompact?.();
    }
  });

  test('resnapshots the full document when the active update log is externally replaced', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Durable before log replacement',
    });
    await service.flushPendingChanges();

    await writeFile(path.join(electronUserDataRoot, 'workspace.loro.updates.jsonl'), '');
    await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Durable through replacement snapshot',
    });
    await service.flushPendingChanges();

    const restored = await createService();
    expect(await searchNodeIds(restored, 'durable before log replacement')).toHaveLength(1);
    expect(await searchNodeIds(restored, 'durable through replacement snapshot')).toHaveLength(1);
  });

  test('resumes queued mutations after a reversible admission freeze is cancelled', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    service.freezeMutationAdmission();
    const mutation = service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Queued during quit drain',
    });

    service.unfreezeMutationAdmission();
    await mutation;
    expect(await searchNodeIds(service, 'queued during quit drain')).toHaveLength(1);
  });

  test('rejects queued mutations only when the admission freeze becomes irreversible', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    service.freezeMutationAdmission();
    const mutation = service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Rejected during teardown',
    });

    service.commitMutationAdmissionFreeze();
    await expect(mutation).rejects.toThrow('application is quitting');
    await expect(service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Rejected after teardown starts',
    })).rejects.toThrow('application is quitting');
    expect(await searchNodeIds(service, 'rejected during teardown')).toEqual([]);
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

  test('keeps search fresh after yielding bulk tree creates', async () => {
    const service = await createService();
    const todayId = service.getProjection().todayId;
    const result = await service.createNodesFromTreeYielding(todayId, [{
      content: plainText('Imported alpha root'),
      children: [
        { content: plainText('Imported beta child'), children: [] },
        { content: plainText('Imported gamma child'), children: [] },
      ],
    }], { origin: 'agent', tool: 'tenon-import', summary: 'Imported test nodes.' }, {
      yieldEveryNodes: 2,
      commitEveryNodes: 2,
    });
    const rootId = focusNodeId(result);

    expect(await searchNodeIds(service, 'imported beta')).toHaveLength(1);

    const undo = await service.operationHistory({ action: 'undo', origin: 'agent' });
    expect(undo.count).toBe(1);
    expect(service.getProjection().nodes.some((node) => node.id === rootId)).toBe(false);
    expect(await searchNodeIds(service, 'imported beta')).toEqual([]);
  });

  test('keeps the previous search generation readable during a yielding refresh', async () => {
    const service = await createService();
    const todayId = service.getProjection().todayId;
    const existingId = focusNodeId(await service.handle('create_node', {
      parentId: todayId,
      index: null,
      text: 'Existing generation marker',
    }));
    const target = service as unknown as {
      refreshTextSearchIndexFromCoreDeltaYielding: (options?: {
        yieldEveryNodes?: number;
        yield?: () => Promise<void>;
      }) => Promise<void>;
    };
    const originalRefresh = target.refreshTextSearchIndexFromCoreDeltaYielding.bind(service);
    let releaseRefresh!: () => void;
    let signalRefresh!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const reached = new Promise<void>((resolve) => { signalRefresh = resolve; });
    let firstYield = true;
    target.refreshTextSearchIndexFromCoreDeltaYielding = (options = {}) => originalRefresh({
      ...options,
      yieldEveryNodes: 1,
      yield: async () => {
        if (!firstYield) return;
        firstYield = false;
        signalRefresh();
        await blocked;
      },
    });

    const importTask = service.createNodesFromTreeYielding(todayId, [{
      content: plainText('Hidden working generation marker'),
      children: [],
    }], { origin: 'agent', tool: 'tenon-import', summary: 'Imported atomically.' }, {
      yieldEveryNodes: 100,
      commitEveryNodes: 100,
    });
    await reached;

    expect(await searchNodeIds(service, 'existing generation marker')).toContain(existingId);
    expect(await searchNodeIds(service, 'hidden working generation marker')).toEqual([]);

    releaseRefresh();
    await importTask;
    expect(await searchNodeIds(service, 'hidden working generation marker')).toHaveLength(1);
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
