import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SCHEMA_ID, type CommandResult, type DocumentProjectionChangedEvent } from '../../src/core/types';
import { createNodeTools } from '../../src/main/agentNodeTools';
import type { ProjectionChangedDelivery } from '../../src/main/documentService';

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

describe('DocumentService projection routing metadata', () => {
  beforeEach(async () => {
    electronUserDataRoot = await mkdtemp(path.join(tmpdir(), 'lin-document-service-projection-routing-'));
  });

  afterEach(async () => {
    for (const service of activeServices) await service.flushPendingChanges();
    activeServices = [];
    await rm(electronUserDataRoot, { recursive: true, force: true });
    electronUserDataRoot = '';
  });

  test('tags renderer-originated document mutations with the invoking webContents id', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const deliveries: ProjectionChangedDelivery[] = [];
    const unsubscribe = service.onProjectionChanged((delivery) => deliveries.push(delivery));

    const result = await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Renderer routed',
    }, { sourceWebContentsId: 7 }) as CommandResult;

    unsubscribe();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].sourceWebContentsId).toBe(7);
    expect(deliveries[0].event.origin).toBe('user');
    expect(deliveries[0].event.update).toEqual(result.update);
  });

  test('leaves main-owned mutations broadcastable while preserving the public event payload', async () => {
    const service = await createService();
    const deliveries: ProjectionChangedDelivery[] = [];
    const unsubscribe = service.onProjectionChanged((delivery) => deliveries.push(delivery));

    await service.transaction({ origin: 'agent', tool: 'routing-test' }, async () => {
      const rootId = service.getProjection().rootId;
      await service.handle('create_node', {
        parentId: rootId,
        index: null,
        text: 'Agent routed',
      });
    });

    unsubscribe();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].sourceWebContentsId).toBeUndefined();
    const publicEvent: DocumentProjectionChangedEvent = deliveries[0].event;
    expect(publicEvent.origin).toBe('agent');
    expect(publicEvent.type).toBe('projection_changed');
  });

  test('keeps the document read model fresh without projection listeners', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const model = service.getDocumentReadModel();
    const unchangedBefore = model.node(SCHEMA_ID);

    const result = await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Read model routed',
    }) as CommandResult;
    const nodeId = result.focus!.nodeId;

    expect(service.getDocumentReadModel()).toBe(model);
    expect(model.revision).toBe(result.update.revision);
    expect(model.node(nodeId)?.content.text).toBe('Read model routed');
    expect(model.node(SCHEMA_ID)).toBe(unchangedBefore);
  });

  test('serves DocumentService-backed node_read through the read model', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const result = await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Tool read model routed',
    }) as CommandResult;
    const nodeId = result.focus!.nodeId;
    service.getDocumentReadModel();

    const originalGetProjection = service.getProjection.bind(service);
    let projectionReads = 0;
    (service as unknown as { getProjection: typeof service.getProjection }).getProjection = () => {
      projectionReads += 1;
      return originalGetProjection();
    };
    const nodeRead = createNodeTools(service).find((tool) => tool.name === 'node_read');
    expect(nodeRead).toBeDefined();

    const toolResult = await (nodeRead!.execute as any)('test-call', { node_id: nodeId, depth: 0 });

    expect(toolResult.details.ok).toBe(true);
    expect(toolResult.details.data.items[0].title).toBe('Tool read model routed');
    expect(projectionReads).toBe(0);
  });

  test('serves DocumentService-backed replace_outline edit through command deltas without rebuilding projection indexes', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    const createdRoot = await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Editable root',
    }) as CommandResult;
    const nodeId = createdRoot.focus!.nodeId;
    const createdField = await service.handle('create_inline_field', {
      parentId: nodeId,
      index: null,
      name: 'Status',
      fieldType: 'plain',
    }) as CommandResult;
    const fieldId = createdField.focus!.nodeId;
    const createdValue = await service.handle('create_node', {
      parentId: fieldId,
      index: null,
      text: 'Open',
    }) as CommandResult;
    const valueId = createdValue.focus!.nodeId;
    service.getDocumentReadModel();

    const originalGetProjection = service.getProjection.bind(service);
    let projectionReads = 0;
    (service as unknown as { getProjection: typeof service.getProjection }).getProjection = () => {
      projectionReads += 1;
      return originalGetProjection();
    };
    const tools = createNodeTools(service);
    const nodeRead = tools.find((tool) => tool.name === 'node_read');
    const nodeEdit = tools.find((tool) => tool.name === 'node_edit');
    expect(nodeRead).toBeDefined();
    expect(nodeEdit).toBeDefined();
    const readResult = await (nodeRead!.execute as any)('test-read', { node_id: nodeId, depth: 0 });
    const revision = readResult.details.data.items[0].revision;

    const editResult = await (nodeEdit!.execute as any)('test-edit', {
      node_id: nodeId,
      old_string: '*',
      new_string: [
        `- %%node:${nodeId}%% [x] Edited root #delta-tag`,
        `  - %%node:${fieldId}%% Status::`,
        `    - %%node:${valueId}%% Closed`,
        '  - Mood:: Focused',
      ].join('\n'),
      expected_revision: revision,
    });

    expect(editResult.details.ok).toBe(true);
    expect(editResult.details.data.afterOutline).toContain(`- %%node:${nodeId}%% [x] Edited root #delta-tag`);
    expect(editResult.details.data.afterOutline).toContain(`- %%node:${valueId}%% Closed`);
    expect(editResult.details.data.createdNodeIds).toHaveLength(1);
    expect(projectionReads).toBe(0);
  });

  test('serves DocumentService-backed target-reference node_create through the read model', async () => {
    const service = await createService();
    const projection = service.getProjection();
    const rootId = projection.rootId;
    const todayId = projection.todayId;
    const target = await service.handle('create_node', {
      parentId: todayId,
      index: null,
      text: 'Reference target',
    }) as CommandResult;
    const targetId = target.focus!.nodeId;
    service.getDocumentReadModel();

    const originalGetProjection = service.getProjection.bind(service);
    const originalGetDocumentReadModel = service.getDocumentReadModel.bind(service);
    let projectionReads = 0;
    let readModelReads = 0;
    (service as unknown as { getProjection: typeof service.getProjection }).getProjection = () => {
      projectionReads += 1;
      return originalGetProjection();
    };
    (service as unknown as { getDocumentReadModel: typeof service.getDocumentReadModel }).getDocumentReadModel = () => {
      readModelReads += 1;
      return originalGetDocumentReadModel();
    };
    const nodeCreate = createNodeTools(service).find((tool) => tool.name === 'node_create');
    expect(nodeCreate).toBeDefined();

    const createResult = await (nodeCreate!.execute as any)('test-create-reference', {
      parent_id: rootId,
      target_id: targetId,
    });

    expect(createResult.details.ok).toBe(true);
    expect(createResult.details.data.targetId).toBe(targetId);
    expect(createResult.details.data.createdRootIds).toHaveLength(1);
    expect(projectionReads).toBe(0);
    expect(readModelReads).toBeGreaterThan(0);
  });

  test('serves DocumentService-backed definition node_create through command deltas without projection fanout', async () => {
    const service = await createService();
    service.getDocumentReadModel();

    const originalGetProjection = service.getProjection.bind(service);
    const originalGetDocumentReadModel = service.getDocumentReadModel.bind(service);
    let projectionReads = 0;
    let readModelReads = 0;
    (service as unknown as { getProjection: typeof service.getProjection }).getProjection = () => {
      projectionReads += 1;
      return originalGetProjection();
    };
    (service as unknown as { getDocumentReadModel: typeof service.getDocumentReadModel }).getDocumentReadModel = () => {
      readModelReads += 1;
      return originalGetDocumentReadModel();
    };
    const nodeCreate = createNodeTools(service).find((tool) => tool.name === 'node_create');
    expect(nodeCreate).toBeDefined();

    const createResult = await (nodeCreate!.execute as any)('test-create-definition', {
      definition: {
        kind: 'field',
        name: 'Score',
        config: { field_type: 'number', min_value: 0, max_value: 10 },
      },
    });

    expect(createResult.details.ok).toBe(true);
    expect(createResult.details.data.createdFieldDefIds).toHaveLength(1);
    expect(createResult.details.data.definition.afterConfig).toMatchObject({
      fieldType: 'number',
      minValue: 0,
      maxValue: 10,
    });
    expect(projectionReads).toBe(0);
    expect(readModelReads).toBeGreaterThan(0);
  });

  test('serves DocumentService-backed outline node_create through command deltas without projection fanout', async () => {
    const service = await createService();
    const rootId = service.getProjection().rootId;
    await service.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Forecast background',
    });
    await service.handle('create_tag', { name: 'existing-tag' });
    service.getDocumentReadModel();

    const originalGetProjection = service.getProjection.bind(service);
    const originalGetDocumentReadModel = service.getDocumentReadModel.bind(service);
    let projectionReads = 0;
    let readModelReads = 0;
    (service as unknown as { getProjection: typeof service.getProjection }).getProjection = () => {
      projectionReads += 1;
      return originalGetProjection();
    };
    (service as unknown as { getDocumentReadModel: typeof service.getDocumentReadModel }).getDocumentReadModel = () => {
      readModelReads += 1;
      return originalGetDocumentReadModel();
    };
    const nodeCreate = createNodeTools(service).find((tool) => tool.name === 'node_create');
    expect(nodeCreate).toBeDefined();

    const createResult = await (nodeCreate!.execute as any)('test-create-outline', {
      parent_id: rootId,
      outline: [
        '- Source:: RSS',
        '- Reporter:: Codex',
        '- Root #existing-tag #created-tag',
        '  - Status:: Active',
        '  - ```ts',
        '  const answer = 42',
        '  ```',
        '  - %%search%% Forecast %%view:list%%',
        '    - STRING_MATCH',
        '      - value:: forecast',
      ].join('\n'),
    });

    expect(createResult.details.ok).toBe(true);
    expect(createResult.details.data.createdFieldEntryIds.length).toBeGreaterThanOrEqual(3);
    expect(createResult.details.data.createdTagIds).toHaveLength(1);
    expect(createResult.details.data.createdRootIds).toHaveLength(1);
    expect(createResult.details.data.createdNodeIds.length).toBeGreaterThan(2);
    expect(projectionReads).toBe(0);
    expect(readModelReads).toBeGreaterThan(0);
  });
});
