import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCoreExtension, TurnAdmissionContext } from '../../src/core/agent/extensions';
import type { AgentRole, EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import { MODEL_TOOL_CATALOG, canonicalModelToolKey } from '../../src/core/agent/tools';
import type { AgentCoreNotification, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { ExtensionRegistry } from '../../src/main/agent/ExtensionRegistry';
import { ThreadService, type ThreadServiceStores } from '../../src/main/agent/ThreadService';
import { GoalStore } from '../../src/main/agent/extensions/goal/GoalStore';
import { RolloutStore } from '../../src/main/agent/persistence/RolloutStore';
import { ThreadHistoryProjectionStore } from '../../src/main/agent/persistence/ThreadHistoryProjectionStore';
import { ThreadMetadataStore } from '../../src/main/agent/persistence/ThreadMetadataStore';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import type { TurnExecutionContext, TurnExecutionResult, TurnExecutor } from '../../src/main/agent/runtime/types';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import { Core } from '../../src/core/core';
import { createNodeTools, type OutlinerToolHost } from '../../src/main/agent/capabilities/agentNodeTools';
import { uuidV7 } from '../../src/main/agent/uuid';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ControlledExecutor implements TurnExecutor {
  readonly contexts: TurnExecutionContext[] = [];
  readonly steered: string[] = [];
  private readonly completions: Array<(result: TurnExecutionResult) => void> = [];

  async execute(context: TurnExecutionContext): Promise<TurnExecutionResult> {
    this.contexts.push(context);
    const itemId = context.recorder.createItemId();
    const started: ThreadItem = {
      type: 'agentMessage',
      id: itemId,
      provenance: context.recorder.localProvenance(itemId),
      text: '',
      phase: 'final_answer',
      memoryCitation: null,
    };
    await context.recorder.started(started);
    context.onSteer((input) => {
      this.steered.push(input.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'));
    });
    const result = await new Promise<TurnExecutionResult>((resolve) => {
      this.completions.push(resolve);
      if (context.signal.aborted) resolve({ status: 'interrupted' });
      else context.signal.addEventListener('abort', () => resolve({ status: 'interrupted' }), { once: true });
    });
    await context.recorder.completed({
      ...started,
      text: result.status === 'interrupted' ? 'Interrupted' : 'Done',
    });
    return result;
  }

  finish(index = 0, result: TurnExecutionResult = { status: 'completed', tokensUsed: 7 }): void {
    const complete = this.completions[index];
    if (!complete) throw new Error(`Executor call ${index} is not waiting`);
    complete(result);
  }

  async waitUntilWaiting(index = 0): Promise<void> {
    while (!this.completions[index]) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('ThreadService', () => {
  test('resolves renderer-owned Thread defaults at the host boundary', async () => {
    const fixture = await createFixture(undefined, {
      resolveRendererStartDefaults: () => ({ modelProvider: 'openai', cwd: '/tmp/agent-workdir' }),
    });

    const thread = (await fixture.service.startThread({ name: 'Host defaults' })).thread;

    expect(thread.modelProvider).toBe('openai');
    expect(thread.cwd).toBe('/tmp/agent-workdir');
    expect(fixture.service.readThread({ threadId: thread.id }).thread).toEqual(thread);
    await fixture.service.close();
  });

  test('normalizes attachment content before start and steer Items become authoritative', async () => {
    const resolvedPaths: string[] = [];
    const fixture = await createFixture(undefined, {
      resolveUserContent: (content, context) => content.map((part) => {
        if (part.type !== 'attachment') return part;
        const path = join(context.cwd, 'resolved', part.name);
        resolvedPaths.push(path);
        return { ...part, source: { kind: 'localFile' as const, path } };
      }),
    });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{
        type: 'attachment',
        id: 'start-attachment',
        name: 'start.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        source: { kind: 'asset', assetId: 'asset-start' },
      }],
    });
    await fixture.executor.waitUntilWaiting();
    await fixture.service.steerTurn({
      threadId: thread.id,
      expectedTurnId: accepted.turn.id,
      input: [{
        type: 'attachment',
        id: 'steer-attachment',
        name: 'steer.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        source: { kind: 'localFile', path: '/outside/steer.txt' },
      }],
    });
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);

    const userItems = fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.[0]?.items
      .filter((item) => item.type === 'userMessage') ?? [];
    expect(userItems.map((item) => item.content[0])).toMatchObject([
      { source: { kind: 'localFile', path: join(fixture.root, 'resolved', 'start.pdf') } },
      { source: { kind: 'localFile', path: join(fixture.root, 'resolved', 'steer.txt') } },
    ]);
    expect(resolvedPaths).toHaveLength(2);
    await fixture.service.close();
  });

  test('enforces one active Turn, deduplicates client input, steers, and persists canonical history', async () => {
    const fixture = await createFixture();
    const notifications: AgentCoreNotification[] = [];
    fixture.service.subscribe((notification) => notifications.push(notification));
    const thread = (await fixture.service.startThread({
      name: 'Canonical runtime',
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;

    const request = {
      threadId: thread.id,
      input: [{ type: 'text' as const, text: 'Implement it' }],
      clientUserMessageId: 'submit-1',
    };
    const accepted = await fixture.service.startRendererTurn(request);
    const retry = await fixture.service.startRendererTurn(request);
    expect(retry).toEqual({ ...accepted, deduplicated: true });
    await expect(fixture.service.startRendererTurn({
      ...request,
      clientUserMessageId: 'submit-2',
    })).rejects.toThrow('active Turn');

    const steered = await fixture.service.steerTurn({
      threadId: thread.id,
      expectedTurnId: accepted.turn.id,
      input: [{ type: 'text', text: 'Also update the tests' }],
      clientUserMessageId: 'steer-1',
    });
    expect(steered.deduplicated).toBe(false);
    expect(fixture.executor.steered).toEqual(['Also update the tests']);

    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    const stored = fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread;
    expect(stored.status).toEqual({ type: 'idle' });
    expect(stored.turns).toHaveLength(1);
    expect(stored.turns?.[0]).toMatchObject({ status: 'completed', id: accepted.turn.id });
    expect(stored.turns?.[0]?.items.map((item) => item.type)).toEqual([
      'userMessage',
      'agentMessage',
      'userMessage',
    ]);
    expect(notifications.map((notification) => notification.type)).toContain('turn/completed');
    await fixture.service.close();

    const reopened = await openFixture(fixture.root, new ControlledExecutor(), fixture.clock);
    await reopened.service.initialize();
    expect(reopened.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns).toEqual(stored.turns);
    await reopened.service.close();
  });

  test('creates only the declared Agent Core storage tree from fresh userData', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Persist canonical storage' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();

    const files = await storageFiles(join(fixture.root, 'agent'));
    expect(files.filter((file) => !file.endsWith('-shm') && !file.endsWith('-wal'))).toEqual([
      'goals.sqlite',
      `rollouts/${thread.id}.jsonl`,
      'state.sqlite',
      'thread_history.sqlite',
    ]);
    expect(files.filter((file) => file.endsWith('-shm') || file.endsWith('-wal')).every((file) =>
      /^(?:goals|state|thread_history)\.sqlite-(?:shm|wal)$/.test(file))).toBe(true);
  });

  test('interrupts the exact active Turn and records a terminal history fact', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Long work' }],
    });
    await expect(fixture.service.interruptTurn(thread.id, '018f0f24-7b2e-7a3f-8a4b-123456789abc'))
      .rejects.toThrow('Expected Turn');
    await fixture.service.interruptTurn(thread.id, accepted.turn.id);
    await fixture.service.waitForIdle(thread.id);
    expect(fixture.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.[0]?.status)
      .toBe('interrupted');
    await fixture.service.close();
  });

  test('closes and replays a partially streamed Item after host restart', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.close();

    const turnId = uuidV7(fixture.clock());
    const userItem: ThreadItem = {
      type: 'userMessage',
      id: 'restart-user',
      provenance: { originThreadId: thread.id, originTurnId: turnId, originItemId: 'restart-user' },
      clientId: null,
      content: [{ type: 'text', text: 'Stream a response' }],
    };
    const agentItem: ThreadItem = {
      type: 'agentMessage',
      id: 'restart-agent',
      provenance: { originThreadId: thread.id, originTurnId: turnId, originItemId: 'restart-agent' },
      text: '',
      phase: 'final_answer',
      memoryCitation: null,
    };
    const startedTurn: Turn = {
      id: turnId,
      items: [userItem],
      itemsView: 'full',
      provenance: {
        originThreadId: thread.id,
        originTurnId: turnId,
        trigger: { kind: 'user' },
      },
      status: 'inProgress',
      error: null,
      startedAt: fixture.clock(),
      completedAt: null,
      durationMs: null,
    };
    const rollout = new RolloutStore(join(fixture.root, 'agent', 'rollouts'));
    for (const notification of [
      { type: 'turn/started', threadId: thread.id, turnId, turn: startedTurn },
      {
        type: 'item/completed',
        threadId: thread.id,
        turnId,
        itemId: userItem.id,
        item: userItem,
        completedAt: fixture.clock(),
      },
      {
        type: 'item/started',
        threadId: thread.id,
        turnId,
        itemId: agentItem.id,
        item: agentItem,
        startedAt: fixture.clock(),
      },
      {
        type: 'item/delta',
        threadId: thread.id,
        turnId,
        itemId: agentItem.id,
        delta: { type: 'agentMessageText', delta: 'Partial output' },
      },
    ] satisfies AgentCoreNotification[]) {
      await rollout.append(thread.id, notification);
    }

    const reopened = await openFixture(fixture.root, new ControlledExecutor(), fixture.clock);
    await reopened.service.initialize();
    const recovered = reopened.service.readThread({ threadId: thread.id, includeTurns: true }).thread.turns?.[0];
    expect(recovered).toMatchObject({
      id: turnId,
      status: 'interrupted',
      error: { code: 'host_restart' },
    });
    expect(recovered?.items.at(-1)).toMatchObject({ type: 'agentMessage', text: 'Partial output' });
    expect(reopened.stores.history.unfinishedItems(thread.id, turnId)).toEqual([]);
    await reopened.service.close();
  });

  test('forks immutable history with local ids and ultimate provenance without reusing client ids', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Original input' }],
      clientUserMessageId: 'original-submit',
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(source.id);
    const sourceTurn = fixture.service.readThread({ threadId: source.id, includeTurns: true }).thread.turns![0]!;

    const fork = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'afterTurn', turnId: accepted.turn.id },
      name: 'Alternative',
    })).thread;
    const copied = fixture.service.readThread({ threadId: fork.id, includeTurns: true }).thread.turns![0]!;
    expect(fork.forkedFromId).toBe(source.id);
    expect(fork.parentThreadId).toBeNull();
    expect(copied.id).not.toBe(sourceTurn.id);
    expect(copied.provenance).toEqual(sourceTurn.provenance);
    expect(copied.items[0]?.id).not.toBe(sourceTurn.items[0]?.id);
    expect(copied.items[0]?.provenance).toEqual(sourceTurn.items[0]?.provenance);
    expect(copied.items[0]).toMatchObject({ type: 'userMessage', clientId: null });
    await fixture.service.close();
  });

  test('omits forked history without reverting document, file, shell, MCP, process, or external effects', async () => {
    const fixture = await createFixture();
    const source = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const accepted = await fixture.service.startRendererTurn({
      threadId: source.id,
      input: [{ type: 'text', text: 'Produce observable effects' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(source.id);

    const document = Core.new();
    const nodeId = document.createNode(document.projection().todayId, null, 'Effect remains').focus!.nodeId;
    const filePath = join(fixture.root, 'effect.txt');
    await writeFile(filePath, 'file effect remains', 'utf8');
    const nonDocumentEffects = {
      shell: ['command completed'],
      mcp: ['remote mutation accepted'],
      processes: ['process-1'],
      external: ['message delivered'],
    };

    const fork = (await fixture.service.forkThread({
      threadId: source.id,
      boundary: { kind: 'beforeTurn', turnId: accepted.turn.id },
    })).thread;

    expect(fixture.service.readThread({ threadId: fork.id, includeTurns: true }).thread.turns).toEqual([]);
    expect(document.projection().nodes.find((node) => node.id === nodeId)?.content.text).toBe('Effect remains');
    expect(await readFile(filePath, 'utf8')).toBe('file effect remains');
    expect(nonDocumentEffects).toEqual({
      shell: ['command completed'],
      mcp: ['remote mutation accepted'],
      processes: ['process-1'],
      external: ['message delivered'],
    });
    await fixture.service.close();
  });

  test('captures host and per-Thread admission generations under their barriers', async () => {
    const extension = new AdmissionProbe();
    const registry = new ExtensionRegistry();
    registry.register(extension);
    const fixture = await createFixture(registry);
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.withHostRootTurnAdmissionBarrier(async () => undefined);
    await fixture.service.withThreadAdmissionBarrier(thread.id, async () => undefined);
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Snapshot barriers' }],
    });
    expect(extension.contexts).toHaveLength(1);
    expect(extension.contexts[0]?.hostBarrier.generation).toBe(1);
    expect(extension.contexts[0]?.threadBarrier.generation).toBe(1);
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });

  test('round-trips request_user_input through the control plane and active Thread flag', async () => {
    const fixture = await createFixture();
    const notifications: AgentCoreNotification[] = [];
    fixture.service.subscribe((notification) => notifications.push(notification));
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const turn = await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Ask before choosing' }],
    });
    await fixture.executor.waitUntilWaiting();
    const responsePromise = fixture.service.requestUserInput(thread.id, turn.turn.id, 'question-item', {
      questions: [{
        id: 'storage_mode',
        header: 'Storage',
        question: 'Which storage mode should be used?',
        options: [
          { label: 'Local (Recommended)', description: 'Keep data on this device.' },
          { label: 'Cloud', description: 'Synchronize data remotely.' },
        ],
      }],
    });
    await waitUntil(() => fixture.service.readThread({ threadId: thread.id }).thread.status.type === 'active'
      && fixture.service.readThread({ threadId: thread.id }).thread.status.activeFlags.includes('waitingOnUserInput'));
    await fixture.service.request('userInput/respond', {
      threadId: thread.id,
      turnId: turn.turn.id,
      itemId: 'question-item',
      answers: [{ questionId: 'storage_mode', optionLabel: 'Local (Recommended)' }],
      autoResolved: false,
    });
    expect(await responsePromise).toMatchObject({ answers: [{ optionLabel: 'Local (Recommended)' }], autoResolved: false });
    expect(notifications.map((notification) => notification.type)).toContain('userInput/requested');
    expect(notifications.map((notification) => notification.type)).toContain('userInput/resolved');
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });

  test('paginates ephemeral history without creating persistence records', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      ephemeral: true,
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    for (const [index, prompt] of ['One', 'Two'].entries()) {
      await fixture.service.startRendererTurn({ threadId: thread.id, input: [{ type: 'text', text: prompt }] });
      await fixture.executor.waitUntilWaiting(index);
      fixture.executor.finish(index);
      await fixture.service.waitForIdle(thread.id);
    }
    const first = await fixture.service.request('thread/turns/list', { threadId: thread.id, limit: 1 });
    const second = await fixture.service.request('thread/turns/list', {
      threadId: thread.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(second.data[0]?.id).not.toBe(first.data[0]?.id);
    expect(fixture.stores.metadata.read(thread.id)).toBeNull();
    await fixture.service.close();
  });

  test('archives a persistent Thread subtree after interrupting every active Turn', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Delegate before archive' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const child = await fixture.service.spawnChild({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'archive-spawn',
      prompt: 'Keep working until archived',
      taskPath: '/root/archive_child',
    });
    await fixture.executor.waitUntilWaiting(1);

    await fixture.service.setThreadArchived(root.id, true);

    expect(fixture.service.readThread({ threadId: root.id, includeTurns: true }).thread.turns?.at(-1)?.status)
      .toBe('interrupted');
    expect(fixture.service.readThread({ threadId: child.thread.id, includeTurns: true }).thread.turns?.at(-1)?.status)
      .toBe('interrupted');
    expect(fixture.service.listThreads({ archived: false }).data.map((thread) => thread.id))
      .not.toContain(root.id);
    expect(fixture.service.listThreads({ archived: true }).data.map((thread) => thread.id))
      .toEqual(expect.arrayContaining([root.id, child.thread.id]));
    await expect(fixture.service.startRendererTurn({
      threadId: child.thread.id,
      input: [{ type: 'text', text: 'Archived work must not restart' }],
    })).rejects.toThrow('archived');

    await fixture.service.setThreadArchived(root.id, false);
    expect(fixture.service.listThreads({ archived: false }).data.map((thread) => thread.id)).toContain(root.id);
    expect(fixture.service.listThreads({ archived: true }).data.map((thread) => thread.id)).toContain(child.thread.id);
    await fixture.service.close();
  });

  test('rejects overlapping subtree teardown while the first operation is stopping active Turns', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Remain active during teardown' }],
    });
    await fixture.executor.waitUntilWaiting();

    const archive = fixture.service.setThreadArchived(thread.id, true);
    await expect(fixture.service.deleteThread(thread.id)).rejects.toThrow('already stopping');
    await archive;

    expect(fixture.service.listThreads({ archived: true }).data.map((candidate) => candidate.id))
      .toContain(thread.id);
    await fixture.service.close();
  });

  test('deletes a persistent Thread subtree only after active descendants stop', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Build a child tree' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const child = await fixture.service.spawnChild({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'delete-child',
      prompt: 'Spawn a grandchild',
      taskPath: '/root/delete_child',
    });
    await fixture.executor.waitUntilWaiting(1);
    const grandchild = await fixture.service.spawnChild({
      parentThreadId: child.thread.id,
      parentTurnId: child.turn.id,
      parentItemId: 'delete-grandchild',
      prompt: 'Remain active',
      taskPath: '/root/delete_child/grandchild',
    });
    await fixture.executor.waitUntilWaiting(2);

    await fixture.service.deleteThread(root.id);

    for (const threadId of [root.id, child.thread.id, grandchild.thread.id]) {
      expect(fixture.stores.metadata.read(threadId)).toBeNull();
      expect(() => fixture.service.readThread({ threadId })).toThrow('Thread not found');
      await expect(readFile(fixture.stores.rollout.pathFor(threadId))).rejects.toThrow();
    }
    expect(fixture.service.listThreads().data).toEqual([]);
    await fixture.service.close();
  });

  test('deletes every ephemeral descendant without leaving orphan Threads', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      ephemeral: true,
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Create ephemeral child' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const child = await fixture.service.spawnChild({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'ephemeral-child',
      prompt: 'Remain active',
      taskPath: '/root/ephemeral_child',
    });
    await fixture.executor.waitUntilWaiting(1);

    await fixture.service.deleteThread(root.id);

    expect(() => fixture.service.readThread({ threadId: root.id })).toThrow('Thread not found');
    expect(() => fixture.service.readThread({ threadId: child.thread.id })).toThrow('Thread not found');
    expect(fixture.service.listThreads().data).toEqual([]);
    await fixture.service.close();
  });

  test('applies the parent ceiling to every child capability source', async () => {
    const parentConfiguration: EffectiveThreadConfiguration = {
      profileName: 'restricted',
      developerInstructions: ['Parent instructions'],
      model: 'parent-model',
      reasoningEffort: 'medium',
      tools: ['node_read', 'collaboration.spawn_agent'],
      skills: ['allowed-skill'],
      plugins: ['allowed-plugin'],
      mcpServers: ['allowed-mcp'],
    };
    const expansiveRole: AgentRole = {
      name: 'expansive',
      source: 'user',
      description: 'Attempts to expand capabilities.',
      developerInstructions: 'Child instructions',
      overrides: {
        tools: ['node_read', 'bash'],
        skills: ['allowed-skill', 'extra-skill'],
        plugins: ['extra-plugin'],
        mcpServers: ['allowed-mcp', 'extra-mcp'],
      },
    };
    const fixture = await createFixture(undefined, {
      resolveConfiguration: () => parentConfiguration,
      resolveRole: () => expansiveRole,
    });
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Delegate' }],
    });
    await fixture.executor.waitUntilWaiting();
    const child = await fixture.service.spawnCollaborationAgent({
      senderThreadId: root.id,
      senderTurnId: rootTurn.turn.id,
      parentItemId: 'spawn-item',
      taskName: 'worker',
      message: 'Inspect the child configuration',
      role: 'expansive',
    });
    await fixture.executor.waitUntilWaiting(1);
    expect(fixture.executor.contexts[1]?.configuration).toMatchObject({
      tools: ['node_read'],
      skills: ['allowed-skill'],
      plugins: [],
      mcpServers: ['allowed-mcp'],
    });
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(child.thread.id);

    const isolated = await fixture.service.spawnIsolatedSkillThread({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'skill-item',
      skillName: 'research',
      prompt: 'Inspect without tools',
      allowedTools: [],
      readOnly: true,
    });
    await fixture.executor.waitUntilWaiting(2);
    expect(isolated.thread.parentThreadId).toBe(root.id);
    expect(isolated.thread.threadSource).toBe('subagent');
    expect(fixture.executor.contexts[2]?.configuration.tools).toEqual([]);
    fixture.executor.finish(2);
    await fixture.service.waitForIdle(isolated.thread.id);

    fixture.executor.finish(0);
    await fixture.service.waitForIdle(root.id);
    await fixture.service.close();
  });

  test('re-resolves a child Role and current parent ceiling on resume', async () => {
    const parentConfiguration: EffectiveThreadConfiguration = {
      profileName: 'root',
      developerInstructions: ['Initial parent instructions'],
      model: 'parent-model',
      reasoningEffort: 'medium',
      tools: ['node_read', 'bash'],
      skills: ['initial-skill', 'shared-skill'],
      plugins: ['initial-plugin'],
      mcpServers: ['initial-mcp'],
    };
    let role: AgentRole = {
      name: 'mutable',
      source: 'user',
      description: 'Initial child role.',
      developerInstructions: 'Initial role instructions',
      overrides: {
        model: 'initial-role-model',
        reasoningEffort: 'low',
        tools: ['node_read', 'bash'],
        skills: ['initial-skill'],
        plugins: ['initial-plugin'],
        mcpServers: ['initial-mcp'],
      },
    };
    const fixture = await createFixture(undefined, {
      resolveConfiguration: () => parentConfiguration,
      resolveRole: () => role,
    });
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Delegate mutable role work' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const child = await fixture.service.spawnChild({
      parentThreadId: root.id,
      parentTurnId: rootTurn.turn.id,
      parentItemId: 'spawn-item',
      prompt: 'Initial child work',
      taskPath: '/root/mutable',
      role: 'mutable',
      allowedTools: ['node_read'],
    });
    await fixture.executor.waitUntilWaiting(1);
    expect(fixture.executor.contexts[1]?.configuration.model).toBe('initial-role-model');
    expect(fixture.executor.contexts[1]?.configuration.reasoningEffort).toBe('low');
    expect(fixture.executor.contexts[1]?.configuration.tools).toEqual(['node_read']);
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(child.thread.id);

    const currentParent: EffectiveThreadConfiguration = {
      ...parentConfiguration,
      developerInstructions: ['Current parent instructions'],
      tools: ['node_read', 'file_read'],
      skills: ['current-skill'],
      plugins: ['current-plugin'],
      mcpServers: ['current-mcp'],
    };
    fixture.stores.metadata.setConfiguration(root.id, currentParent);
    role = {
      ...role,
      developerInstructions: 'Current role instructions',
      overrides: {
        model: 'current-role-model',
        reasoningEffort: 'high',
        tools: ['node_read', 'file_read'],
        skills: ['current-skill'],
        plugins: ['current-plugin'],
        mcpServers: ['current-mcp'],
      },
    };

    await fixture.service.resumeThread(child.thread.id);
    await fixture.service.startPrivilegedTurn({
      threadId: child.thread.id,
      input: [{ type: 'text', text: 'Resume with current configuration' }],
      trigger: { kind: 'subagent', parentThreadId: root.id, parentItemId: 'followup-item' },
    });
    await fixture.executor.waitUntilWaiting(2);
    expect(fixture.executor.contexts[2]?.configuration).toMatchObject({
      developerInstructions: ['Current parent instructions', 'Current role instructions'],
      model: 'current-role-model',
      reasoningEffort: 'high',
      tools: ['node_read'],
      skills: ['current-skill'],
      plugins: ['current-plugin'],
      mcpServers: ['current-mcp'],
    });
    fixture.executor.finish(2);
    await fixture.service.waitForIdle(child.thread.id);
    fixture.executor.finish(0);
    await fixture.service.waitForIdle(root.id);
    await fixture.service.close();
  });

  test('exposes canonical control tools and executes plan, Goal, and collaboration paths', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Use the canonical tools' }],
    });
    await fixture.executor.waitUntilWaiting();
    const context = fixture.executor.contexts[0]!;
    const runtime = new ToolRuntime(fixture.service, {
      capabilityTools: () => [],
      capabilityConfig: { blocks: [] },
    });
    const tools = await runtime.createTools(context);
    expect(tools.map((tool) => tool.name)).toEqual([
      'request_user_input',
      'update_plan',
      'get_goal',
      'create_goal',
      'update_goal',
      'collaboration__spawn_agent',
      'collaboration__send_message',
      'collaboration__followup_task',
      'collaboration__wait_agent',
      'collaboration__list_agents',
      'collaboration__interrupt_agent',
    ]);

    await executeTool(tools, 'update_plan', 'plan-item', {
      explanation: 'Canonical execution plan',
      plan: [{ step: 'Implement', status: 'in_progress' }],
    });
    const createdGoal = await executeTool(tools, 'create_goal', 'goal-create', {
      objective: 'Finish the canonical runtime',
      token_budget: 100,
    });
    expect(createdGoal.details).toMatchObject({ goal: { status: 'active', tokenBudget: 100 } });
    const spawned = await executeTool(tools, 'collaboration__spawn_agent', 'spawn-item', {
      task_name: 'helper',
      message: 'Inspect the runtime',
      fork_turns: 'none',
    });
    await fixture.executor.waitUntilWaiting(1);
    expect(spawned.details).toMatchObject({ task_name: '/root/helper' });
    const listed = await executeTool(tools, 'collaboration__list_agents', 'list-item', {});
    expect(listed.details).toMatchObject({
      result: [{ taskPath: '/root/helper', status: 'running' }],
      capabilityAudit: { behavior: 'allow' },
    });
    await executeTool(tools, 'update_goal', 'goal-update', { status: 'complete' });

    fixture.executor.finish(1);
    const childId = (spawned.details as { thread_id: string }).thread_id;
    await fixture.service.waitForIdle(childId);
    fixture.executor.finish(0);
    await fixture.service.waitForIdle(root.id);
    const stored = fixture.service.readThread({ threadId: root.id, includeTurns: true }).thread;
    expect(stored.turns?.[0]?.items.some((item) => item.type === 'plan')).toBe(true);
    expect(stored.turns?.[0]?.items.filter((item) => item.type === 'subAgentActivity')).toMatchObject([
      { kind: 'started', agentThreadId: childId, agentPath: '/root/helper' },
      { kind: 'completed', agentThreadId: childId, agentPath: '/root/helper' },
    ]);
    await fixture.service.close();
  });

  test('scopes collaboration waits and preserves child activity that arrived before waiting', async () => {
    const fixture = await createFixture();
    const root = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const rootTurn = await fixture.service.startRendererTurn({
      threadId: root.id,
      input: [{ type: 'text', text: 'Coordinate child work' }],
    });
    await fixture.executor.waitUntilWaiting(0);
    const interrupted = new AbortController();
    interrupted.abort();
    await expect(fixture.service.waitForCollaborationActivity(
      root.id,
      rootTurn.turn.id,
      1_000,
      interrupted.signal,
    )).rejects.toThrow('interrupted');
    const child = await fixture.service.spawnCollaborationAgent({
      senderThreadId: root.id,
      senderTurnId: rootTurn.turn.id,
      parentItemId: 'wait-spawn',
      taskName: 'wait_child',
      message: 'Complete once',
    });
    await fixture.executor.waitUntilWaiting(1);
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(child.thread.id);

    const alreadyPending = await fixture.service.waitForCollaborationActivity(
      root.id,
      rootTurn.turn.id,
      1_000,
    );
    expect(alreadyPending).toMatchObject([{ threadId: child.thread.id, status: 'completed' }]);

    await fixture.service.followupCollaborationTask(
      root.id,
      rootTurn.turn.id,
      'wait-followup',
      '/root/wait_child',
      'Complete again',
    );
    await fixture.executor.waitUntilWaiting(2);
    let resolved = false;
    const waiting = fixture.service.waitForCollaborationActivity(
      root.id,
      rootTurn.turn.id,
      1_000,
    ).then((result) => {
      resolved = true;
      return result;
    });

    const unrelated = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    const unrelatedTurn = await fixture.service.startRendererTurn({
      threadId: unrelated.id,
      input: [{ type: 'text', text: 'Unrelated activity' }],
    });
    await fixture.executor.waitUntilWaiting(3);
    await fixture.service.steerTurn({
      threadId: unrelated.id,
      expectedTurnId: unrelatedTurn.turn.id,
      input: [{ type: 'text', text: 'Still unrelated' }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);

    fixture.executor.finish(2);
    await fixture.service.waitForIdle(child.thread.id);
    expect(await waiting).toMatchObject([{ threadId: child.thread.id, status: 'completed' }]);
    fixture.executor.finish(0);
    fixture.executor.finish(3);
    await fixture.service.waitForIdle(root.id);
    await fixture.service.waitForIdle(unrelated.id);
    await fixture.service.close();
  });

  test('stops Goal continuation before admission when the token budget is exhausted', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.request('goal/create', {
      threadId: thread.id,
      objective: 'Finish within one Turn',
      tokenBudget: 7,
    });

    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Complete the Goal' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish(0, { status: 'completed', tokensUsed: 7 });
    await fixture.service.waitForIdle(thread.id);

    expect(fixture.executor.contexts).toHaveLength(1);
    expect((await fixture.service.request('goal/get', { threadId: thread.id })).goal?.status)
      .toBe('budgetLimited');
    await fixture.service.close();
  });

  test('retries a deferred Goal continuation at the next real idle boundary', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.request('goal/create', {
      threadId: thread.id,
      objective: 'Recover the deferred continuation',
    });
    const record = fixture.stores.goals.read(thread.id)!;
    fixture.stores.goals.deferContinuation(thread.id, record.generation, 'User Turn won admission');

    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Finish the competing Turn' }],
    });
    await fixture.executor.waitUntilWaiting();
    fixture.executor.finish();
    await fixture.executor.waitUntilWaiting(1);

    expect(fixture.executor.contexts[1]?.turn.provenance.trigger).toEqual({
      kind: 'feature',
      feature: 'goal_continuation',
      ref: String(record.generation),
    });
    expect(fixture.stores.goals.readDeferral(thread.id)).toBeNull();
    await fixture.service.request('goal/update', { threadId: thread.id, status: 'complete' });
    fixture.executor.finish(1);
    await fixture.service.waitForIdle(thread.id);
    expect(fixture.executor.contexts).toHaveLength(2);
    await fixture.service.close();
  });

  test('resumes an active Goal continuation after host restart', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'openai',
      cwd: fixture.root,
    })).thread;
    await fixture.service.request('goal/create', {
      threadId: thread.id,
      objective: 'Continue after restart',
    });
    await fixture.service.close();

    const executor = new ControlledExecutor();
    const reopened = await openFixture(fixture.root, executor, fixture.clock);
    await reopened.service.initialize();
    await executor.waitUntilWaiting();
    expect(executor.contexts[0]?.turn.provenance.trigger).toMatchObject({
      kind: 'feature',
      feature: 'goal_continuation',
    });

    await reopened.service.request('goal/update', { threadId: thread.id, status: 'complete' });
    executor.finish();
    await reopened.service.waitForIdle(thread.id);
    await reopened.service.close();
  });

  test('assembles extension and capability tools through one executable registry', async () => {
    const registry = new ExtensionRegistry();
    registry.register(new ToolContributionProbe());
    const configuration: EffectiveThreadConfiguration = {
      profileName: 'extension-test',
      developerInstructions: [],
      model: 'test-model',
      reasoningEffort: 'medium',
      tools: MODEL_TOOL_CATALOG.map((contract) => canonicalModelToolKey(contract.identity)),
      skills: [],
      plugins: ['automation-probe'],
      mcpServers: [],
    };
    const fixture = await createFixture(registry, { resolveConfiguration: () => configuration });
    const thread = (await fixture.service.startThread({
      source: 'app',
      threadSource: 'user',
      modelProvider: 'test',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Use extension tools' }],
    });
    await fixture.executor.waitUntilWaiting();
    const context = fixture.executor.contexts[0]!;
    const runtime = new ToolRuntime(fixture.service, {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
      dynamicTools: () => [{
        name: 'codex_app__automation_update',
        label: 'Update Automation',
        description: AUTOMATION_TOOL_CONTRACT.description,
        parameters: AUTOMATION_TOOL_CONTRACT.inputSchema!,
        executionMode: 'sequential',
        execute: async () => ({ content: [{ type: 'text', text: 'updated' }], details: { updated: true } }),
      }],
    });
    const tools = await runtime.createTools(context);
    expect(tools.map((tool) => tool.name)).toContain('generate_image');
    expect(tools.map((tool) => tool.name)).toContain('codex_app__automation_update');

    const missingImplementation = new ToolRuntime(fixture.service, {
      capabilityTools: runtimeSchemaTools,
      assembleRegistry: true,
    });
    await expect(missingImplementation.createTools(context)).rejects.toThrow(
      'Enabled extension model tool has no runtime implementation',
    );
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });

  test('binds document tool mutations to the executing Thread, Turn, and Item', async () => {
    const fixture = await createFixture();
    const thread = (await fixture.service.startThread({
      modelProvider: 'test',
      cwd: fixture.root,
    })).thread;
    await fixture.service.startRendererTurn({
      threadId: thread.id,
      input: [{ type: 'text', text: 'Read the outline' }],
    });
    await fixture.executor.waitUntilWaiting();
    const context = fixture.executor.contexts[0]!;
    const core = Core.new();
    const metadata: Array<Parameters<NonNullable<OutlinerToolHost['transaction']>>[0]> = [];
    const outliner: OutlinerToolHost = {
      getProjection: () => core.projection(),
      handle: async () => {
        throw new Error('node_read must not mutate the document');
      },
      transaction: async (meta, operation) => {
        metadata.push(meta);
        return operation();
      },
    };
    const runtime = new ToolRuntime(fixture.service, {
      outliner,
      capabilityConfig: { blocks: [] },
      capabilityTools: (_runtimeContext, wrappedOutliner) => createNodeTools(wrappedOutliner!),
    });
    const tools = await runtime.createTools({
      ...context,
      configuration: { ...context.configuration, tools: ['node_read'] },
    });
    const itemId = context.recorder.createItemId();

    await executeTool(tools, 'node_read', itemId, {
      node_id: core.projection().todayId,
      depth: 0,
    });

    expect(metadata).toEqual([expect.objectContaining({
      causation: { threadId: thread.id, turnId: context.turn.id, itemId },
    })]);
    fixture.executor.finish();
    await fixture.service.waitForIdle(thread.id);
    await fixture.service.close();
  });
});

class AdmissionProbe implements AgentCoreExtension {
  readonly id = 'admission-probe';
  readonly contexts: TurnAdmissionContext[] = [];

  contributeTurnAdmission(context: TurnAdmissionContext) {
    this.contexts.push(context);
    return { extensionId: this.id, snapshotId: `snapshot-${this.contexts.length}` };
  }
}

const AUTOMATION_TOOL_CONTRACT = {
  identity: { namespace: 'codex_app', name: 'automation_update' },
  description: 'Create or update one Automation.',
  scope: 'rootThread',
  schemaOwner: 'extension',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { title: { type: 'string' } },
    required: ['title'],
  },
  actionKinds: ['agent.plan.update'],
} as const;

class ToolContributionProbe implements AgentCoreExtension {
  readonly id = 'automation-probe';

  contributeTools() {
    return { extensionId: this.id, tools: [AUTOMATION_TOOL_CONTRACT] };
  }
}

function runtimeSchemaTools(): import('@earendil-works/pi-agent-core').AgentTool[] {
  return MODEL_TOOL_CATALOG.flatMap((contract) => contract.inputSchema === null
    ? [{
        name: canonicalModelToolKey(contract.identity),
        label: contract.identity.name,
        description: contract.description,
        parameters: { type: 'object', additionalProperties: false },
        executionMode: 'sequential' as const,
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: { ok: true } }),
      }]
    : []);
}

interface Fixture {
  root: string;
  service: ThreadService;
  executor: ControlledExecutor;
  clock: () => number;
  stores: ThreadServiceStores;
}

async function createFixture(
  extensions?: ExtensionRegistry,
  options: Pick<
    ConstructorParameters<typeof ThreadService>[0],
    'resolveConfiguration' | 'resolveRole' | 'resolveUserContent'
  > = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-thread-service-'));
  roots.push(root);
  let now = 1_720_000_000_000;
  const clock = () => ++now;
  const executor = new ControlledExecutor();
  const opened = await openFixture(root, executor, clock, extensions, options);
  await opened.service.initialize();
  return { root, executor, clock, service: opened.service, stores: opened.stores };
}

async function openFixture(
  root: string,
  executor: ControlledExecutor,
  clock: () => number,
  extensions?: ExtensionRegistry,
  options: Pick<
    ConstructorParameters<typeof ThreadService>[0],
    'resolveConfiguration' | 'resolveRendererStartDefaults' | 'resolveRole' | 'resolveUserContent'
  > = {},
): Promise<{ service: ThreadService; stores: ThreadServiceStores }> {
  const stores = createStores(root);
  return {
    service: new ThreadService({ stores, executor, now: clock, extensions, ...options }),
    stores,
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise<void>((resolve) => setImmediate(resolve));
}

function createStores(root: string): ThreadServiceStores {
  mkdirSync(join(root, 'agent'), { recursive: true });
  const statePath = join(root, 'agent', 'state.sqlite');
  const historyPath = join(root, 'agent', 'thread_history.sqlite');
  const goalsPath = join(root, 'agent', 'goals.sqlite');
  return {
    metadata: new ThreadMetadataStore(statePath, database(statePath)),
    history: new ThreadHistoryProjectionStore(historyPath, database(historyPath)),
    rollout: new RolloutStore(join(root, 'agent', 'rollouts')),
    goals: new GoalStore(goalsPath, database(goalsPath)),
  };
}

function database(path: string): SqliteDatabase {
  return new Database(path, { create: true }) as unknown as SqliteDatabase;
}

async function storageFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await storageFiles(root, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

async function executeTool(
  tools: readonly import('@earendil-works/pi-agent-core').AgentTool[],
  name: string,
  itemId: string,
  params: Record<string, unknown>,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute(itemId, params);
}
