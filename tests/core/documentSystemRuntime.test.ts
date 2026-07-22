import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_ID, TRASH_ID } from '../../src/core/types';

let electronUserDataRoot = '';

mock.module('electron', () => ({
  app: { getPath: () => electronUserDataRoot },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: { fromPartition: () => ({ clearStorageData: async () => undefined }) },
}));

type DocumentServiceModule = typeof import('../../src/main/documentService');
type DocumentServiceInstance = InstanceType<DocumentServiceModule['DocumentService']>;

let documentServiceModule: Promise<DocumentServiceModule> | null = null;
let services: DocumentServiceInstance[] = [];

async function service(): Promise<DocumentServiceInstance> {
  documentServiceModule ??= import('../../src/main/documentService');
  const { DocumentService } = await documentServiceModule;
  const instance = new DocumentService();
  await instance.initWorkspace();
  services.push(instance);
  return instance;
}

describe('Document system runtime', () => {
  beforeEach(async () => {
    electronUserDataRoot = await mkdtemp(join(tmpdir(), 'tenon-document-system-'));
  });

  afterEach(async () => {
    for (const instance of services) await instance.flushPendingChanges();
    services = [];
    await rm(electronUserDataRoot, { recursive: true, force: true });
  });

  test('persists receipt-only transactions without changing or emitting the projection', async () => {
    const instance = await service();
    const before = instance.projectionSnapshot();
    const events: unknown[] = [];
    instance.onProjectionChanged((delivery) => events.push(delivery));
    const receipt = {
      namespace: 'memory',
      scopeId: 'daily-notes',
      operationId: 'publish-1',
      generation: 1,
      digest: 'a'.repeat(64),
    } as const;

    await instance.transaction({ namespace: 'memory', operationId: 'publish-1' }, async (transaction) => {
      await transaction.executeHostCommand('put_document_system_receipt', { receipt });
    });
    expect(instance.projectionSnapshot()).toEqual(before);
    expect(events).toEqual([]);
    expect(await instance.readDocumentSystemReceipt('memory', 'daily-notes')).toEqual(receipt);
    await instance.flushPendingChanges();

    const reloaded = await service();
    expect(await reloaded.readDocumentSystemReceipt('memory', 'daily-notes')).toEqual(receipt);
    expect(JSON.stringify(reloaded.getProjection())).not.toContain('publish-1');
  });

  test('commits Node changes and a receipt atomically and rolls both back on failure', async () => {
    const instance = await service();
    const rootId = instance.getProjection().rootId;
    const receipt = {
      namespace: 'memory',
      scopeId: 'daily-notes',
      operationId: 'publish-2',
      generation: 2,
      digest: 'b'.repeat(64),
    } as const;
    let createdId = '';

    await instance.transaction({ namespace: 'memory', operationId: 'publish-2' }, async (transaction) => {
      const outcome = await transaction.executeDocumentCommand('create_node', {
        parentId: rootId,
        index: null,
        text: 'Published memory',
      }) as { focus?: { nodeId?: string } };
      createdId = outcome.focus?.nodeId ?? '';
      await transaction.executeHostCommand('put_document_system_receipt', { receipt });
    });
    expect(instance.getProjection().nodes.some((node) => node.id === createdId)).toBe(true);
    expect(await instance.readDocumentSystemReceipt('memory', 'daily-notes')).toEqual(receipt);

    const revisionBeforeFailure = instance.projectionSnapshot().revision;
    let rolledBackId = '';
    await expect(instance.transaction({ namespace: 'memory', operationId: 'publish-3' }, async (transaction) => {
      const outcome = await transaction.executeDocumentCommand('create_node', {
        parentId: rootId,
        index: null,
        text: 'Must roll back',
      }) as { focus?: { nodeId?: string } };
      rolledBackId = outcome.focus?.nodeId ?? '';
      await transaction.executeHostCommand('put_document_system_receipt', {
        receipt: { ...receipt, operationId: 'wrong-operation' },
      });
    })).rejects.toThrow('receipt identity must match');
    expect(instance.projectionSnapshot().revision).toBe(revisionBeforeFailure);
    expect(instance.getProjection().nodes.some((node) => node.id === rolledBackId)).toBe(false);
    expect(await instance.readDocumentSystemReceipt('memory', 'daily-notes')).toEqual(receipt);
  });

  test('ensures deterministic protected tags and permits only ordinary tag application', async () => {
    const instance = await service();
    const definition = { namespace: 'memory', tagId: 'tag:memory-episode', name: 'episode' } as const;
    await instance.transaction({ namespace: 'memory', operationId: 'ensure-tags-1' }, async (transaction) => {
      await transaction.executeHostCommand('ensure_document_system_tag_definition', { definition });
    });
    const tag = instance.getProjection().nodes.find((node) => node.id === definition.tagId);
    expect(tag).toMatchObject({ id: definition.tagId, parentId: SCHEMA_ID, type: 'tagDef', locked: true });
    expect(tag?.content.text).toBe('episode');

    const rootId = instance.getProjection().rootId;
    const created = await instance.handle('create_node', { parentId: rootId, index: null, text: 'Remember this' }) as {
      focus?: { nodeId?: string };
    };
    const noteId = created.focus?.nodeId ?? '';
    await instance.handle('apply_tag', { nodeId: noteId, tagId: definition.tagId });
    expect(instance.getProjection().nodes.find((node) => node.id === noteId)?.tags).toContain(definition.tagId);
    await instance.handle('remove_tag', { nodeId: noteId, tagId: definition.tagId });
    expect(instance.getProjection().nodes.find((node) => node.id === noteId)?.tags).not.toContain(definition.tagId);

    await expect(instance.handle('apply_node_text_patch', {
      nodeId: definition.tagId,
      patch: { ops: [{ type: 'delete', index: 0, count: 7 }, { type: 'insert', index: 0, text: 'renamed' }] },
    })).rejects.toThrow('protected system tag');
    await expect(instance.handle('create_field_def', {
      tagId: definition.tagId,
      name: 'Protected template field',
    })).rejects.toThrow('protected system tag');

    const core = (instance as unknown as { core: {
      transaction: <T>(origin: 'system', operation: () => Promise<T>) => Promise<T>;
      loro: { moveNode: (nodeId: string, parentId: string, index?: number) => void };
    } }).core;
    await core.transaction('system', async () => {
      core.loro.moveNode(definition.tagId, TRASH_ID);
    });
    await instance.transaction({ namespace: 'memory', operationId: 'ensure-tags-2' }, async (transaction) => {
      await transaction.executeHostCommand('ensure_document_system_tag_definition', { definition });
    });
    expect(instance.getProjection().nodes.find((node) => node.id === definition.tagId)?.parentId).toBe(SCHEMA_ID);
    expect(await instance.readDocumentSystemTagDefinition(definition.tagId)).toEqual(definition);
  });
});
