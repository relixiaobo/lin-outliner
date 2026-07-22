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

  test('does not manufacture partial history from notifications for an unloaded Thread', async () => {
    const selected = thread('thread-1', 2);
    const unloaded = thread('thread-2', 1);
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

    const completed = turn('turn-unloaded', 'completed', 'must load canonically');
    notify({ type: 'turn/completed', threadId: unloaded.id, turnId: completed.id, turn: completed });

    expect(store.getSnapshot().turnsByThread.has(unloaded.id)).toBe(false);
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
