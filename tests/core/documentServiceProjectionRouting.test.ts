import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandResult, DocumentProjectionChangedEvent } from '../../src/core/types';
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
});
