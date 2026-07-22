import { describe, expect, test } from 'bun:test';
import type { AgentCoreNotification, Thread, Turn } from '../../src/core/agent/protocol';
import { ThreadStore } from '../../src/renderer/agent/store/threadStore';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
