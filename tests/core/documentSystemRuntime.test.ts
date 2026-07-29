import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIBRARY_ID, SCHEMA_ID, TRASH_ID } from '../../src/core/types';
import type { Thread, Turn } from '../../src/core/agent/protocol';
import { MemoryExtension } from '../../src/main/agent/extensions/memory/MemoryExtension';
import { uuidV7 } from '../../src/main/agent/uuid';
import { MemoryControlStore } from '../../src/main/agent/extensions/memory/MemoryControlStore';
import { Phase1 } from '../../src/main/agent/extensions/memory/Phase1';
import { TimelineMemoryStore } from '../../src/main/agent/extensions/memory/TimelineMemoryStore';
import { Database } from 'bun:sqlite';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';

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
    const reloaded = await service();
    expect(await reloaded.readDocumentSystemReceipt('memory', 'daily-notes')).toEqual(receipt);
    expect(JSON.stringify(reloaded.getProjection())).not.toContain('publish-1');
  });

  test('publishes Phase 1 Memory with canonical Node IDs through the real document service', async () => {
    const instance = await service();
    const timeline = new TimelineMemoryStore(instance);
    const control = new MemoryControlStore(
      ':memory:',
      new Database(':memory:') as unknown as SqliteDatabase,
    );
    const threadId = uuidV7();
    const turnId = uuidV7();
    const itemId = uuidV7();
    const startedAt = new Date(2026, 6, 24, 12).getTime();
    const turn: Turn = {
      id: turnId,
      items: [{
        type: 'userMessage',
        id: itemId,
        clientId: null,
        acceptedAt: 1_720_000_000_000,
        provenance: { originThreadId: threadId, originTurnId: turnId, originItemId: itemId },
        content: [{ type: 'text', text: 'Remember the clean implementation rule.' }],
      }],
      itemsView: 'full',
      provenance: { originThreadId: threadId, originTurnId: turnId, trigger: { kind: 'user' } },
      status: 'completed',
      error: null,
      execution: {
        modelProvider: 'test',
        model: 'test',
        reasoningEffort: 'medium',
        diagnosticsRef: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
      },
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
    };
    const thread: Thread = {
      id: threadId,
      sessionId: threadId,
      parentThreadId: null,
      forkedFromId: null,
      agentNickname: null,
      agentRole: null,
      name: null,
      preview: '',
      ephemeral: false,
      source: 'app',
      threadSource: 'user',
      modelProvider: 'test',
      cwd: '/tmp',
      createdAt: startedAt,
      updatedAt: startedAt,
      status: { type: 'idle' },
      historyMode: 'full',
      turns: [turn],
    };
    control.writeAdmission({
      threadId,
      turnId,
      featureModeAtAdmission: 'enabled',
      threadModeAtAdmission: 'enabled',
      eligibleAtAdmission: true,
      featureModeGeneration: 0,
      resetEpoch: 0,
      memoryVisibilityGeneration: 0,
      admittedAt: startedAt,
    });
    await timeline.ensureTagDefinitions();
    const phase = new Phase1(control, timeline, {
      run: async () => JSON.stringify({
        dates: [{
          sourceDate: '2026-07-24',
          headline: { text: 'Implementation rule', originItemIds: [itemId] },
          episode: { text: 'The user established an implementation rule.', originItemIds: [itemId] },
          beliefs: [],
          questions: [],
          guidance: [{ text: 'Keep the implementation clean.', originItemIds: [itemId] }],
        }],
      }),
    }, () => true);

    try {
      await expect(phase.run({ thread, turns: [turn] }, new AbortController().signal)).resolves.toBe('published');
      const generated = control.generatedNodes();
      expect(generated.length).toBeGreaterThanOrEqual(3);
      expect(generated.every((entry) => /^node:[0-9a-f-]{36}$/.test(entry.nodeId))).toBe(true);
      expect(generated.every((entry) => instance.getProjection().nodes.some((node) => node.id === entry.nodeId))).toBe(true);

      const reloaded = await service();
      expect(generated.every((entry) => reloaded.getProjection().nodes.some((node) => node.id === entry.nodeId))).toBe(true);
      expect(await reloaded.readDocumentSystemReceipt('agent.memory', instance.getProjection().dailyNotesId))
        .toMatchObject({ operationId: expect.stringContaining('memory:stage1:') });
    } finally {
      control.close();
    }
  });

  test('holds the host mutation coordinator through validation and document commit', async () => {
    const instance = await service();
    const sequence: string[] = [];
    let coordinated = false;
    instance.setMutationCoordinator(async (_meta, operation) => {
      sequence.push('coordinator-enter');
      coordinated = true;
      try {
        return await operation();
      } finally {
        coordinated = false;
        sequence.push('coordinator-exit');
      }
    });
    instance.setMutationGuard(() => {
      expect(coordinated).toBe(true);
      sequence.push('guard');
    });

    await instance.handle('create_node', {
      id: `node:${uuidV7()}`,
      parentId: LIBRARY_ID,
      index: null,
      text: 'Coordinated mutation',
    });

    expect(sequence).toEqual(['coordinator-enter', 'guard', 'coordinator-exit']);
  });

  test('commits Node changes and a receipt atomically and rolls both back on failure', async () => {
    const instance = await service();
    const events: Array<{ operationId?: string }> = [];
    instance.onProjectionChanged((delivery) => events.push(delivery));
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
    expect(events.at(-1)?.operationId).toBe('publish-2');
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

  test('persists Agent Turn causation in document operation metadata', async () => {
    const instance = await service();
    const causation = {
      threadId: uuidV7(),
      turnId: uuidV7(),
      itemId: uuidV7(),
    };

    await instance.handle('create_node', {
      parentId: instance.getProjection().rootId,
      index: null,
      text: 'Causation audit',
    }, {
      origin: 'agent',
      tool: 'node_create',
      causation,
    });

    const history = await instance.operationHistory({ action: 'list', origin: 'agent' });
    expect(history.items?.[0]).toMatchObject({ tool: 'node_create', causation });
  });

  test('persists Memory sensitivity for commands that resolve reserved tag names', async () => {
    const instance = await service();
    const timeline = new TimelineMemoryStore(instance);
    const control = new MemoryControlStore(
      ':memory:',
      new Database(':memory:') as unknown as SqliteDatabase,
    );
    const extension = new MemoryExtension(control, timeline);
    const richText = (text: string) => ({ text, marks: [], inlineRefs: [] });
    const taggedTree = (tag: string, children: unknown[] = []) => ({
      content: richText(`Tagged ${tag}`),
      tags: [tag],
      children,
    });

    try {
      await timeline.ensureTagDefinitions();
      instance.setMutationGuard((command, args, meta, projection) => ({
        affectsMemory: extension.authorizeMutation(command, args, meta, projection),
      }));
      const todayId = instance.getProjection().todayId;

      await instance.handle('create_tag_and_tagged_node', {
        parentId: todayId,
        content: richText('Daily Memory'),
        name: ' D-MEMORY ',
      }, { origin: 'user', operationId: 'op:named-memory-tag', tool: 'node_create' });
      await instance.handle('create_nodes_from_tree', {
        parentId: todayId,
        nodes: [{ content: richText('Tree root'), children: [taggedTree('d-belief')] }],
      }, { origin: 'user', operationId: 'op:named-memory-tree', tool: 'node_create' });
      const target = await instance.handle('create_node', {
        parentId: todayId,
        index: null,
        text: 'Paste target mentioning tag:d-memory',
      }, { origin: 'user', operationId: 'op:ordinary-tag-text', tool: 'node_create' }) as {
        focus?: { nodeId?: string };
      };
      await instance.handle('paste_nodes_into_node', {
        nodeId: target.focus?.nodeId,
        content: richText('Pasted Memory'),
        firstMeta: { tags: ['d-question'] },
        children: [{ content: richText('Child'), children: [taggedTree('d-guidance')] }],
        siblingsAfter: [taggedTree('d-episode')],
      }, { origin: 'user', operationId: 'op:named-memory-paste', tool: 'node_edit' });

      const history = await instance.operationHistory({ action: 'list', origin: 'user', limit: 20 });
      const byId = new Map((history.items ?? []).map((item) => [item.operationId, item]));
      expect(byId.get('op:named-memory-tag')?.affectsMemory).toBe(true);
      expect(byId.get('op:named-memory-tree')?.affectsMemory).toBe(true);
      expect(byId.get('op:named-memory-paste')?.affectsMemory).toBe(true);
      expect(byId.get('op:ordinary-tag-text')?.affectsMemory).toBe(false);

      expect((await instance.operationHistory(
        { action: 'undo', origin: 'user' },
        { origin: 'user', tool: 'outline_undo_stack' },
      )).count).toBe(1);
      await expect(instance.operationHistory(
        { action: 'redo', origin: 'user' },
        { origin: 'agent', tool: 'outline_undo_stack' },
      )).rejects.toThrow('Memory Nodes can be changed only');
      expect((await instance.operationHistory(
        { action: 'redo', origin: 'user' },
        { origin: 'user', tool: 'outline_undo_stack' },
      )).count).toBe(1);
    } finally {
      control.close();
    }
  });

  test('routes mutating operation history through coordination and the Memory guard with causation', async () => {
    const instance = await service();
    const causation = { threadId: uuidV7(), turnId: uuidV7(), itemId: uuidV7() };
    const created = await instance.handle('create_node', {
      parentId: instance.getProjection().rootId,
      index: null,
      text: 'Undo target',
    }, { origin: 'agent', tool: 'node_create', causation }) as { focus?: { nodeId?: string } };
    const targetNodeId = created.focus?.nodeId;
    expect(targetNodeId).toBeDefined();
    const sequence: string[] = [];
    instance.setMutationCoordinator(async (meta, operation) => {
      expect(meta.causation).toEqual(causation);
      sequence.push('coordinator');
      return operation();
    });
    instance.setMutationGuard((command, args, meta) => {
      expect(command).toBe('undo');
      expect(meta.causation).toEqual(causation);
      expect(args.historyMutation).toMatchObject({
        status: 'known',
        targets: [{ affectedNodeCount: 2 }],
      });
      expect((args.historyMutation as {
        targets: Array<{ affectedNodeIds: string[] }>;
      }).targets[0]?.affectedNodeIds).toContain(targetNodeId);
      sequence.push('guard');
    });

    const result = await instance.operationHistory(
      { action: 'undo', origin: 'agent' },
      { origin: 'agent', tool: 'outline_undo_stack', causation },
    );
    expect(result.count).toBe(1);
    expect(sequence).toEqual(['coordinator', 'guard']);
  });

  test('resolves every exact undo and redo target before mutation authorization', async () => {
    const instance = await service();
    const rootId = instance.getProjection().rootId;
    const first = await instance.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'First target',
    }, { origin: 'agent', tool: 'node_create' }) as { focus?: { nodeId?: string } };
    const second = await instance.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'Second target',
    }, { origin: 'agent', tool: 'node_create' }) as { focus?: { nodeId?: string } };
    const observedTargets: string[][][] = [];
    instance.setMutationGuard((_command, args) => {
      observedTargets.push((args.historyMutation as {
        targets: Array<{ affectedNodeIds: string[] }>;
      }).targets.map((target) => target.affectedNodeIds));
    });

    expect((await instance.operationHistory({ action: 'undo', origin: 'agent', steps: 2 })).count).toBe(2);
    expect(observedTargets[0]).toHaveLength(2);
    expect(observedTargets[0]?.[0]).toContain(second.focus?.nodeId);
    expect(observedTargets[0]?.[1]).toContain(first.focus?.nodeId);

    expect((await instance.operationHistory({ action: 'redo', origin: 'agent', steps: 2 })).count).toBe(2);
    expect(observedTargets[1]).toHaveLength(2);
    expect(observedTargets[1]?.[0]).toContain(first.focus?.nodeId);
    expect(observedTargets[1]?.[1]).toContain(second.focus?.nodeId);
  });

  test('preflights branched multi-step history from the authoritative Loro stack', async () => {
    const instance = await service();
    const rootId = instance.getProjection().rootId;
    instance.setMutationGuard((_command, _args, meta) => ({
      affectsMemory: meta.operationId === 'op:memory-a',
    }));
    await instance.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'A Memory-sensitive',
    }, { origin: 'user', operationId: 'op:memory-a', tool: 'node_create' });
    await instance.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'B ordinary',
    }, { origin: 'user', operationId: 'op:ordinary-b', tool: 'node_create' });
    expect((await instance.operationHistory(
      { action: 'undo', origin: 'user' },
      { origin: 'user', tool: 'outline_undo_stack' },
    )).undone?.[0]?.operationId).toBe('op:ordinary-b');
    await instance.handle('create_node', {
      parentId: rootId,
      index: null,
      text: 'C ordinary',
    }, { origin: 'user', operationId: 'op:ordinary-c', tool: 'node_create' });

    let preflightTargets: Array<{ operationId: string; affectsMemory?: boolean }> = [];
    instance.setMutationGuard((command, args) => {
      if (command === 'undo') {
        preflightTargets = (args.historyMutation as {
          targets: Array<{ operationId: string; affectsMemory?: boolean }>;
        }).targets;
      }
    });
    expect((await instance.operationHistory(
      { action: 'undo', origin: 'user', steps: 2 },
      { origin: 'agent', tool: 'outline_undo_stack' },
    )).count).toBe(2);
    expect(preflightTargets.map((target) => target.operationId)).toEqual([
      'op:ordinary-c',
      'op:memory-a',
    ]);
    expect(preflightTargets.map((target) => target.affectsMemory)).toEqual([false, true]);
  });

  test('fails closed when an executable all-origin stack item has no journal metadata', async () => {
    const instance = await service();
    const created = await instance.handle('create_node', {
      parentId: instance.getProjection().rootId,
      index: null,
      text: 'Scoped undo target',
    }, { origin: 'agent', tool: 'node_create' }) as { focus?: { nodeId?: string } };
    const statuses: unknown[] = [];
    instance.setMutationGuard((_command, args) => {
      statuses.push((args.historyMutation as { status?: unknown }).status);
    });

    expect((await instance.operationHistory({ action: 'undo', origin: 'agent' })).count).toBe(1);
    expect(instance.getProjection().nodes.some((node) => node.id === created.focus?.nodeId)).toBe(false);
    expect((await instance.operationHistory({ action: 'undo', origin: 'all' })).count).toBe(1);
    expect(instance.getProjection().nodes.some((node) => node.id === created.focus?.nodeId)).toBe(true);
    expect(statuses).toEqual(['known', 'unknown']);
  });

  test('persists Memory sensitivity from a guarded transaction into undo metadata', async () => {
    const instance = await service();
    const definition = { namespace: 'memory', tagId: 'tag:memory-history', name: 'memory-history' } as const;
    await instance.transaction({ namespace: 'memory', operationId: 'ensure-history-tag' }, async (transaction) => {
      await transaction.executeHostCommand('ensure_document_system_tag_definition', { definition });
    });
    const created = await instance.handle('create_node', {
      parentId: instance.getProjection().rootId,
      index: null,
      text: 'Historical Memory',
    }, { origin: 'user' }) as { focus?: { nodeId?: string } };
    const nodeId = created.focus?.nodeId ?? '';
    await instance.handle('apply_tag', { nodeId, tagId: definition.tagId }, { origin: 'user' });

    let historyTarget: unknown;
    instance.setMutationGuard((command, args) => {
      if (command === 'undo') historyTarget = (args.historyMutation as { targets?: unknown[] }).targets?.[0];
      return { affectsMemory: command === 'remove_tag' };
    });
    await instance.transaction({ origin: 'user', tool: 'memory_edit' }, async () => {
      await instance.handle('remove_tag', { nodeId, tagId: definition.tagId }, { origin: 'user' });
    });
    expect(instance.getProjection().nodes.find((node) => node.id === nodeId)?.tags).not.toContain(definition.tagId);

    const history = await instance.operationHistory({ action: 'list', origin: 'user' });
    expect(history.items?.[0]).toMatchObject({ tool: 'memory_edit', affectsMemory: true });
    expect((await instance.operationHistory({ action: 'undo', origin: 'user' })).count).toBe(1);
    expect(historyTarget).toMatchObject({ affectsMemory: true });
    expect(instance.getProjection().nodes.find((node) => node.id === nodeId)?.tags).toContain(definition.tagId);
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
