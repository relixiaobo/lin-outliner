import { describe, expect, test } from 'bun:test';
import type { AgentCoreNotification, Thread, Turn } from '../../src/core/agent/protocol';
import { ThreadStore, mergeLoadedTurns } from '../../src/renderer/agent/store/threadStore';
import type { api } from '../../src/renderer/api/client';

type ThreadStoreClient = Pick<typeof api, 'agentCoreRequest' | 'onAgentCoreNotification'>;

describe('renderer Thread store', () => {
  test('does not let an older page response overwrite a realtime terminal Turn', async () => {
    const owner = thread('thread-1', 1);
    const stalePage = deferred<{ data: Turn[]; nextCursor: null; backwardsCursor: null }>();
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return stalePage.promise;
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const initialization = store.initialize();
    await Promise.resolve();
    const completed = turn('turn-1', 'completed', 'final');
    notify({ type: 'turn/completed', threadId: owner.id, turnId: completed.id, turn: completed });
    stalePage.resolve({ data: [turn('turn-1', 'inProgress', 'partial')], nextCursor: null, backwardsCursor: null });
    await initialization;

    expect(store.getSnapshot().turnsByThread.get(owner.id)?.[0]).toMatchObject({
      status: 'completed',
      items: [{ type: 'agentMessage', text: 'final' }],
    });
  });

  test('loads Turns and Goal for the replacement selected after deleting the current Thread', async () => {
    const replacement = thread('thread-1', 1);
    const selected = thread('thread-2', 2);
    const replacementTurn = turn('turn-replacement', 'completed', 'loaded replacement');
    const requestedTurns: string[] = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        if (method === 'thread/list') return { data: [selected, replacement], nextCursor: null };
        if (method === 'thread/turns/list') {
          requestedTurns.push(String(input.threadId));
          return {
            data: input.threadId === replacement.id ? [replacementTurn] : [],
            nextCursor: null,
            backwardsCursor: null,
          };
        }
        if (method === 'goal/get') {
          return input.threadId === replacement.id
            ? { goal: { threadId: replacement.id, objective: 'Replacement goal' } }
            : { goal: null };
        }
        if (method === 'thread/configuration/get') {
          const target = input.threadId === replacement.id ? replacement : selected;
          return configurationResponse(target);
        }
        if (method === 'thread/delete') return {};
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await store.deleteThread(selected.id);

    expect(store.getSnapshot().selectedThreadId).toBe(replacement.id);
    expect(store.getSnapshot().turnsByThread.get(replacement.id)).toEqual([replacementTurn]);
    expect(store.getSnapshot().goalsByThread.get(replacement.id)).toMatchObject({ objective: 'Replacement goal' });
    expect(requestedTurns).toEqual([selected.id, replacement.id]);
  });

  test('keeps a terminal loaded Item over an older realtime inProgress Item', () => {
    const current = commandTurn('turn-1', 'inProgress');
    const loaded = commandTurn('turn-1', 'completed');

    expect(mergeLoadedTurns([loaded], [current])[0]?.items[0]).toMatchObject({
      type: 'commandExecution',
      status: 'completed',
      aggregatedOutput: 'done',
    });
  });

  test('edits the final user input with rollback and a replacement Turn in the same Thread', async () => {
    const owner = thread('thread-1', 1);
    const original = turn('turn-original', 'completed', 'old response');
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [original], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'thread/rollback') return { thread: { ...owner, updatedAt: 2 } };
        if (method === 'turn/start') {
          return { turn: original, acceptedItemId: 'replacement-item', deduplicated: false };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    await store.rollbackAndSend(owner.id, [{ type: 'text', text: '  revised input  ' }]);

    expect(calls.filter((call) => call.method === 'thread/rollback')).toEqual([{
      method: 'thread/rollback',
      input: { threadId: owner.id, numTurns: 1 },
    }]);
    expect(calls.filter((call) => call.method === 'turn/start')[0]?.input).toMatchObject({
      threadId: owner.id,
      input: [{ type: 'text', text: 'revised input' }],
    });
    expect(store.getSnapshot().selectedThreadId).toBe(owner.id);
    expect(store.getSnapshot().turnsByThread.get(owner.id)).toEqual([]);
  });

  test('updates catalog metadata without manufacturing history for an unloaded Thread', async () => {
    const selected = thread('thread-1', 50);
    const unloaded = { ...thread('thread-2', 10), preview: '' };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [selected, unloaded], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(selected);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    const active = turn('turn-unloaded', 'inProgress', '');
    const userItemId = 'turn-unloaded-user';
    const started: Turn = {
      ...active,
      items: [{
        type: 'userMessage',
        id: userItemId,
        provenance: {
          originThreadId: unloaded.id,
          originTurnId: active.id,
          originItemId: userItemId,
        },
        clientId: null,
        content: [{ type: 'text', text: '  Background activity  ' }],
      }],
      startedAt: 100,
    };
    notify({ type: 'turn/started', threadId: unloaded.id, turnId: started.id, turn: started });

    expect(store.getSnapshot().turnsByThread.has(unloaded.id)).toBe(false);
    expect(store.getSnapshot().threads[0]).toMatchObject({
      id: unloaded.id,
      preview: 'Background activity',
      updatedAt: 100,
    });

    const completed: Turn = {
      ...started,
      status: 'completed',
      completedAt: 110,
      durationMs: 10,
    };
    notify({ type: 'turn/completed', threadId: unloaded.id, turnId: completed.id, turn: completed });

    expect(store.getSnapshot().turnsByThread.has(unloaded.id)).toBe(false);
    expect(store.getSnapshot().threads[0]).toMatchObject({ id: unloaded.id, updatedAt: 110 });
  });

  test('removes a transient fork notification when Continue in new chat fails', async () => {
    const owner = thread('thread-1', 1);
    const ghost = { ...thread('thread-ghost', 2), forkedFromId: owner.id };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    let listCalls = 0;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') {
          listCalls += 1;
          return { data: [owner], nextCursor: null };
        }
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'thread/fork') {
          notify({ type: 'thread/started', threadId: ghost.id, thread: ghost });
          throw new Error('Fork payload copy failed');
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    await expect(store.continueInNewChat(owner.id, 'turn-1')).rejects.toThrow('Fork payload copy failed');

    expect(listCalls).toBe(2);
    expect(store.getSnapshot().threads.map((candidate) => candidate.id)).toEqual([owner.id]);
    expect(store.getSnapshot().selectedThreadId).toBe(owner.id);
  });

  test('updates an untitled Thread preview and activity time from Turn notifications', async () => {
    const owner = { ...thread('thread-1', 1), name: null };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    const active = turn('turn-preview', 'inProgress', '');
    const userItemId = 'turn-preview-user';
    const started: Turn = {
      ...active,
      items: [{
        type: 'userMessage',
        id: userItemId,
        provenance: {
          originThreadId: owner.id,
          originTurnId: active.id,
          originItemId: userItemId,
        },
        clientId: null,
        content: [{ type: 'text', text: '  Compare\nthese designs.  ' }],
      }],
      startedAt: 10,
    };
    notify({ type: 'turn/started', threadId: owner.id, turnId: started.id, turn: started });

    expect(store.getSnapshot().threads[0]).toMatchObject({
      preview: 'Compare these designs.',
      updatedAt: 10,
    });

    const completed: Turn = {
      ...started,
      status: 'completed',
      completedAt: 25,
      durationMs: 15,
    };
    notify({ type: 'turn/completed', threadId: owner.id, turnId: completed.id, turn: completed });
    expect(store.getSnapshot().threads[0]?.updatedAt).toBe(25);
  });

  test('applies canonical Thread name updates without changing activity time', async () => {
    const owner = { ...thread('thread-1', 10), name: null, preview: 'Immediate preview' };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    notify({
      type: 'thread/name/updated',
      threadId: owner.id,
      threadName: 'Generated title',
    });
    expect(store.getSnapshot().threads[0]).toMatchObject({ name: 'Generated title', updatedAt: 10 });

    notify({ type: 'thread/name/updated', threadId: owner.id });
    expect(store.getSnapshot().threads[0]).toMatchObject({ name: null, updatedAt: 10 });
  });

  test('does not let a stale configuration read overwrite a newer selection', async () => {
    const owner = thread('thread-1', 1);
    const staleConfiguration = deferred<ReturnType<typeof configurationResponse>>();
    let configurationReads = 0;
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') {
          configurationReads += 1;
          return staleConfiguration.promise;
        }
        if (method === 'thread/configuration/set') {
          return {
            thread: { ...owner, modelProvider: input.modelProvider, updatedAt: 2 },
            configuration: {
              modelProvider: input.modelProvider,
              model: input.model,
              reasoningEffort: input.reasoningEffort,
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const initialization = store.initialize();
    while (configurationReads === 0) await Promise.resolve();

    await store.setThreadConfiguration(owner.id, {
      modelProvider: 'anthropic',
      model: 'anthropic/claude-sonnet-4',
      reasoningEffort: 'high',
    });
    staleConfiguration.resolve(configurationResponse(owner));
    await initialization;

    expect(store.getSnapshot().configurationsByThread.get(owner.id)).toEqual({
      modelProvider: 'anthropic',
      model: 'anthropic/claude-sonnet-4',
      reasoningEffort: 'high',
    });
    expect(store.getSnapshot().threads[0]?.modelProvider).toBe('anthropic');
  });

  test('appends reasoning deltas to the active segment without inventing paragraphs', async () => {
    const owner = thread('thread-1', 1);
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    const reasoningId = 'reasoning-1';
    const activeTurn: Turn = {
      ...turn('turn-1', 'inProgress', ''),
      items: [{
        id: reasoningId,
        type: 'reasoning',
        provenance: { originThreadId: owner.id, originTurnId: 'turn-1', originItemId: reasoningId },
        summary: [],
        content: [],
      }],
    };
    notify({ type: 'turn/started', threadId: owner.id, turnId: activeTurn.id, turn: activeTurn });
    notify({
      type: 'item/delta',
      threadId: owner.id,
      turnId: activeTurn.id,
      itemId: reasoningId,
      delta: { type: 'reasoningContent', delta: 'Need ' },
    });
    notify({
      type: 'item/delta',
      threadId: owner.id,
      turnId: activeTurn.id,
      itemId: reasoningId,
      delta: { type: 'reasoningContent', delta: 'evidence' },
    });

    expect(store.getSnapshot().turnsByThread.get(owner.id)?.[0]?.items[0]).toMatchObject({
      type: 'reasoning',
      content: ['Need evidence'],
    });
  });

  test('keeps provider retry state transient and clears it when the Turn settles', async () => {
    const owner = thread('thread-1', 1);
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    const active = turn('turn-1', 'inProgress', 'partial');
    notify({ type: 'turn/started', threadId: owner.id, turnId: active.id, turn: active });
    notify({
      type: 'turn/providerRetry/changed',
      threadId: owner.id,
      turnId: active.id,
      status: { kind: 'stream', attempt: 2, maxRetries: 4 },
    });

    expect(store.getSnapshot().providerRetryByThread.get(owner.id)).toEqual({
      turnId: active.id,
      status: { kind: 'stream', attempt: 2, maxRetries: 4 },
    });

    const completed = turn(active.id, 'completed', 'done');
    notify({ type: 'turn/completed', threadId: owner.id, turnId: active.id, turn: completed });
    expect(store.getSnapshot().providerRetryByThread.has(owner.id)).toBe(false);
  });

  test('deduplicates full tool output reads by immutable output identity', async () => {
    const owner = thread('thread-1', 1);
    const requests: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        requests.push({ method, input });
        if (method === 'thread/item/output/read') {
          return {
            output: {
              ref: { id: 'a'.repeat(64), mimeType: 'text/plain', byteLength: 11, summary: 'full output' },
              text: 'full output',
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const item = {
      ...commandTurn('turn-1', 'completed').items[0]!,
      outputRef: { id: 'a'.repeat(64), mimeType: 'text/plain' as const, byteLength: 11, summary: 'full output' },
    };

    expect(await Promise.all([
      store.readItemOutput(owner.id, 'turn-1', item),
      store.readItemOutput(owner.id, 'turn-1', item),
    ])).toEqual(['full output', 'full output']);
    expect(requests).toEqual([{
      method: 'thread/item/output/read',
      input: {
        threadId: owner.id,
        turnId: 'turn-1',
        itemId: item.id,
        outputId: 'a'.repeat(64),
      },
    }]);
  });

  test('retries a full tool output read after a transient request failure', async () => {
    const owner = thread('thread-1', 1);
    let attempts = 0;
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string) => {
        if (method !== 'thread/item/output/read') throw new Error(`Unexpected method: ${method}`);
        attempts += 1;
        if (attempts === 1) throw new Error('temporary read failure');
        return {
          output: {
            ref: { id: 'b'.repeat(64), mimeType: 'text/plain', byteLength: 6, summary: 'output' },
            text: 'output',
          },
        };
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const item = {
      ...commandTurn('turn-1', 'completed').items[0]!,
      outputRef: { id: 'b'.repeat(64), mimeType: 'text/plain' as const, byteLength: 6, summary: 'output' },
    };

    expect(await store.readItemOutput(owner.id, 'turn-1', item)).toBeNull();
    expect(await store.readItemOutput(owner.id, 'turn-1', item)).toBe('output');
    expect(attempts).toBe(2);
  });
});

function thread(id: string, updatedAt: number): Thread {
  return {
    id,
    sessionId: id,
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: id,
    preview: '',
    ephemeral: false,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/workspace',
    createdAt: updatedAt,
    updatedAt,
    status: { type: 'idle' },
    historyMode: 'paginated',
  };
}

function configurationResponse(owner: Thread) {
  return {
    thread: owner,
    configuration: {
      modelProvider: 'openai',
      model: 'openai/gpt-5',
      reasoningEffort: 'medium',
    },
  };
}

function turn(id: string, status: Turn['status'], text: string): Turn {
  const itemId = `${id}-item`;
  return {
    id,
    items: [{
      type: 'agentMessage',
      id: itemId,
      provenance: { originThreadId: 'thread-1', originTurnId: id, originItemId: itemId },
      text,
      phase: 'final_answer',
      memoryCitation: null,
    }],
    itemsView: 'full',
    provenance: { originThreadId: 'thread-1', originTurnId: id, trigger: { kind: 'user' } },
    status,
    error: null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function commandTurn(id: string, itemStatus: 'inProgress' | 'completed'): Turn {
  const itemId = `${id}-command`;
  return {
    id,
    items: [{
      type: 'commandExecution',
      id: itemId,
      provenance: { originThreadId: 'thread-1', originTurnId: id, originItemId: itemId },
      command: 'work',
      cwd: '/workspace',
      processId: null,
      status: itemStatus,
      commandActions: [],
      aggregatedOutput: itemStatus === 'completed' ? 'done' : null,
      exitCode: itemStatus === 'completed' ? 0 : null,
      durationMs: itemStatus === 'completed' ? 1 : null,
    }],
    itemsView: 'full',
    provenance: { originThreadId: 'thread-1', originTurnId: id, trigger: { kind: 'user' } },
    status: 'inProgress',
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
