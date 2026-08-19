import { describe, expect, test } from 'bun:test';
import type { AgentCoreNotification, Thread, ThreadItem, Turn } from '../../src/core/agent/protocol';
import { ThreadStore, mergeLoadedTurns } from '../../src/renderer/agent/store/threadStore';
import type { api } from '../../src/renderer/api/client';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

type ThreadStoreClient = Pick<typeof api, 'agentCoreRequest' | 'onAgentCoreNotification'>;

describe('renderer Thread store', () => {
  test('resolves the identity roster against the conversation it restored', async () => {
    // The roster is resolved per working directory, and the selected Thread is
    // what names one. Resolving it alongside startup — before `thread/list`
    // has picked a conversation — reads the home directory and misses a
    // project's own Roles and re-skins until the reader switches threads by
    // hand.
    const owner = thread('thread-1', 1);
    const asked: Array<string | null> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: { threadId?: string | null }) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'identities/get') {
          asked.push(input.threadId ?? null);
          return { entries: [{ agentType: 'main', persona: 'Aspen', color: 'teal', source: 'built-in' }] };
        }
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'thread/descendants') return { data: [], queuedWorkThreadIds: [] };
        if (method === 'thread/subagents/list') return { data: [] };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await Promise.resolve();

    expect(asked).toContain(owner.id);
    expect(store.getSnapshot().identityCatalog.get('main')?.persona).toBe('Aspen');
  });

  test('keeps the roster of the conversation selected last', async () => {
    // Two selections in flight: the slower answer must not land last and leave
    // the roster resolved for a directory the reader already left.
    const first = thread('thread-1', 1), second = thread('thread-2', 2);
    const slow = deferred<{ entries: unknown[] }>();
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: { threadId?: string | null }) => {
        if (method === 'thread/list') return { data: [first, second], nextCursor: null };
        if (method === 'identities/get') {
          return input.threadId === first.id
            ? slow.promise
            : { entries: [{ agentType: 'main', persona: 'Second', color: 'blue', source: 'built-in' }] };
        }
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(first);
        if (method === 'thread/descendants') return { data: [], queuedWorkThreadIds: [] };
        if (method === 'thread/subagents/list') return { data: [] };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await store.selectThread(second.id);
    await Promise.resolve();
    // The stale answer for the first conversation arrives last, and is dropped.
    slow.resolve({ entries: [{ agentType: 'main', persona: 'Stale', color: 'pink', source: 'built-in' }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot().identityCatalog.get('main')?.persona).toBe('Second');
  });

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

  test('loads the conversation\'s Agent records and keeps field-equal ones by identity', async () => {
    const owner = thread('thread-1', 1);
    const execution = {
      agentId: 'thread-child',
      parentThreadId: owner.id,
      description: 'survey the runtime',
      agentType: 'general-purpose',
      runMode: 'background' as const,
      generation: 1,
      currentTurnId: 'child-turn',
      stopProvenance: 'none' as const,
      terminalStatus: null,
      notificationState: 'none' as const,
      worktree: null,
      createdAt: 10,
      updatedAt: 10,
    };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/subagents/list') return { data: [execution] };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await Promise.resolve();

    // The cold-start half: a conversation reopened later still knows which
    // Agents it delegated, without waiting for one of them to move.
    const loaded = store.getSnapshot().subagentExecutionsByAgentId.get('thread-child');
    expect(loaded).toMatchObject({ agentId: 'thread-child', description: 'survey the runtime' });

    // A record that says nothing new keeps its identity, so the registry — and
    // every memoized row projected from it — sees no change at all.
    notify({ type: 'subagent/execution/changed', threadId: owner.id, execution: { ...execution } });
    expect(store.getSnapshot().subagentExecutionsByAgentId.get('thread-child')).toBe(loaded);

    notify({
      type: 'subagent/execution/changed',
      threadId: owner.id,
      execution: { ...execution, stopProvenance: 'user', updatedAt: 20 },
    });
    expect(store.getSnapshot().subagentExecutionsByAgentId.get('thread-child'))
      .toMatchObject({ stopProvenance: 'user' });
  });

  test('applies an atomic completed Item batch in one renderer snapshot', async () => {
    const owner = thread('thread-1', 1);
    const active = { ...turn('turn-1', 'inProgress', ''), items: [] };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [active], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const scheduledFlushes: Array<() => void> = [];
    const store = new ThreadStore(client, (flush) => scheduledFlushes.push(flush));
    await store.initialize();
    let snapshots = 0;
    store.subscribe(() => { snapshots += 1; });
    const items: ThreadItem[] = [
      {
        type: 'userMessage',
        id: 'turn-1-steer',
        provenance: { originThreadId: owner.id, originTurnId: active.id, originItemId: 'turn-1-steer' },
        clientId: 'steer-1',
        acceptedAt: 2,
        content: [{ type: 'text', text: 'Steer atomically' }],
      },
      {
        type: 'agentMessage',
        id: 'turn-1-ack',
        provenance: { originThreadId: owner.id, originTurnId: active.id, originItemId: 'turn-1-ack' },
        text: 'Acknowledged',
        phase: 'commentary',
        memoryCitation: null,
      },
    ];

    notify({
      type: 'items/completed',
      threadId: owner.id,
      turnId: active.id,
      items,
      completedAt: 2,
    });

    expect(snapshots).toBe(1);
    expect(store.getSnapshot().turnsByThread.get(owner.id)?.[0]?.items).toEqual(items);
    expect(scheduledFlushes).toHaveLength(0);
  });

  test('updates snapshots synchronously while notifying listeners once per scheduled frame', async () => {
    const owner = thread('thread-1', 1);
    const active = turn('turn-1', 'inProgress', '');
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [active], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const scheduledFlushes: Array<() => void> = [];
    const store = new ThreadStore(client, (flush) => scheduledFlushes.push(flush));
    await store.initialize();
    let snapshots = 0;
    store.subscribe(() => { snapshots += 1; });
    const item = active.items[0]!;

    const chunks = Array.from({ length: 100 }, (_, index) => `[${index}]`);
    for (const delta of chunks) {
      notify({
        type: 'item/delta',
        threadId: owner.id,
        turnId: active.id,
        itemId: item.id,
        delta: { type: 'agentMessageText', delta },
      });
    }

    expect(store.getSnapshot().turnsByThread.get(owner.id)?.[0]?.items[0]).toMatchObject({
      type: 'agentMessage',
      text: chunks.join(''),
    });
    expect(snapshots).toBe(0);
    expect(scheduledFlushes).toHaveLength(1);
    scheduledFlushes.shift()!();
    expect(snapshots).toBe(1);
  });

  test('delivers lifecycle state immediately and invalidates an older scheduled delta flush', async () => {
    const owner = thread('thread-1', 1);
    const active = turn('turn-1', 'inProgress', '');
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [active], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const scheduledFlushes: Array<() => void> = [];
    const store = new ThreadStore(client, (flush) => scheduledFlushes.push(flush));
    await store.initialize();
    let snapshots = 0;
    store.subscribe(() => { snapshots += 1; });
    const item = active.items[0]!;

    notify({
      type: 'item/delta',
      threadId: owner.id,
      turnId: active.id,
      itemId: item.id,
      delta: { type: 'agentMessageText', delta: 'Done' },
    });
    expect(snapshots).toBe(0);
    expect(scheduledFlushes).toHaveLength(1);

    notify({
      type: 'item/completed',
      threadId: owner.id,
      turnId: active.id,
      itemId: item.id,
      item: { ...item, text: 'Done' },
      completedAt: 2,
    });
    expect(snapshots).toBe(1);
    expect(store.getSnapshot().turnsByThread.get(owner.id)?.[0]?.items[0]).toMatchObject({ text: 'Done' });

    scheduledFlushes.shift()!();
    expect(snapshots).toBe(1);
  });

  test('preserves text spacing around structured composer references', async () => {
    const owner = thread('thread-1', 1);
    const startedTurn = turn('turn-started', 'inProgress', 'accepted');
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'turn/submit') return {
          acceptedItemId: 'item-accepted',
          deduplicated: false,
          turn: startedTurn,
          turnId: startedTurn.id,
        };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    const attachment = {
      type: 'attachment' as const,
      id: 'attachment-1',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      source: { kind: 'localFile' as const, path: '/workspace/report.pdf' },
    };

    const acceptedTurn = await store.send([
      { type: 'text', text: '  Compare ' },
      { type: 'nodeReference', nodeId: 'node-1', note: 'Plan' },
      { type: 'text', text: ' with ' },
      attachment,
      { type: 'text', text: ' before deciding.  ' },
    ]);

    expect(calls.find((call) => call.method === 'turn/submit')?.input.input).toEqual([
      { type: 'text', text: 'Compare ' },
      { type: 'nodeReference', nodeId: 'node-1', note: 'Plan' },
      { type: 'text', text: ' with ' },
      attachment,
      { type: 'text', text: ' before deciding.' },
    ]);
    expect(acceptedTurn).toEqual(startedTurn);
  });

  test('submits user input for an active child without renderer-side Turn routing', async () => {
    const owner = thread('thread-root', 2);
    const child = {
      ...thread('thread-child', 1),
      parentThreadId: owner.id,
      source: 'collaboration' as const,
      threadSource: 'subagent' as const,
    };
    const active = childTurn(child.id, 'turn-child-active', 'inProgress');
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/read') return { thread: child };
        if (method === 'thread/turns/list') {
          return {
            data: input.threadId === child.id ? [active] : [],
            nextCursor: null,
            backwardsCursor: null,
          };
        }
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'turn/submit') {
          return { turn: null, turnId: active.id, acceptedItemId: 'steer-item', deduplicated: false };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await store.ensureThreadHistory(child.id);
    const userView = rendererUserView();

    expect(await store.sendToThread(child.id, [{ type: 'text', text: '  Check logs next.  ' }], userView))
      .toBeNull();

    const submit = calls.find((call) => call.method === 'turn/submit');
    expect(submit?.input).toMatchObject({
      threadId: child.id,
      input: [{ type: 'text', text: 'Check logs next.' }],
      userView,
    });
    expect(submit?.input).not.toHaveProperty('expectedTurnId');
    expect(typeof submit?.input.clientUserMessageId).toBe('string');
    expect(store.getSnapshot().selectedThreadId).toBe(owner.id);
    expect(calls.some((call) => call.method === 'turn/start' || call.method === 'turn/steer')).toBe(false);
  });

  test('starts a new user Turn for a terminal child without selecting it', async () => {
    const owner = thread('thread-root', 2);
    const child = {
      ...thread('thread-child', 1),
      parentThreadId: owner.id,
      source: 'collaboration' as const,
      threadSource: 'subagent' as const,
    };
    const terminal = childTurn(child.id, 'turn-child-done', 'completed');
    const started = childTurn(child.id, 'turn-child-resumed', 'inProgress');
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/read') return { thread: child };
        if (method === 'thread/turns/list') {
          return {
            data: input.threadId === child.id ? [terminal] : [],
            nextCursor: null,
            backwardsCursor: null,
          };
        }
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'turn/submit') {
          return { acceptedItemId: 'start-item', deduplicated: false, turn: started, turnId: started.id };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await store.ensureThreadHistory(child.id);
    const userView = rendererUserView();

    expect(await store.sendToThread(child.id, [{ type: 'text', text: 'Continue.' }], userView))
      .toEqual(started);

    const submit = calls.find((call) => call.method === 'turn/submit');
    expect(submit?.input).toMatchObject({
      threadId: child.id,
      input: [{ type: 'text', text: 'Continue.' }],
      userView,
    });
    expect(typeof submit?.input.clientUserMessageId).toBe('string');
    expect(store.getSnapshot().selectedThreadId).toBe(owner.id);
    expect(calls.some((call) => call.method === 'turn/start' || call.method === 'turn/steer')).toBe(false);
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

  test('edits the final user input with rollback and a host-routed replacement submission', async () => {
    const owner = thread('thread-1', 1);
    const original = turn('turn-original', 'completed', 'old response');
    const replacement = turn('turn-replacement', 'inProgress', '');
    const userView = rendererUserView();
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
        if (method === 'turn/submit') {
          return {
            turn: replacement,
            turnId: replacement.id,
            acceptedItemId: 'replacement-item',
            deduplicated: false,
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    await store.rollbackAndSend(owner.id, [{ type: 'text', text: '  revised input  ' }], userView);

    expect(calls.filter((call) => call.method === 'thread/rollback')).toEqual([{
      method: 'thread/rollback',
      input: { threadId: owner.id, numTurns: 1 },
    }]);
    const submit = calls.filter((call) => call.method === 'turn/submit');
    expect(submit).toHaveLength(1);
    expect(submit[0]?.input).toMatchObject({
      threadId: owner.id,
      input: [{ type: 'text', text: 'revised input' }],
      userView,
    });
    expect(typeof submit[0]?.input.clientUserMessageId).toBe('string');
    expect(calls.some((call) => call.method === 'turn/start' || call.method === 'turn/steer')).toBe(false);
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
        acceptedAt: 100,
        content: [{ type: 'text', text: '  Background activity  ' }],
      }],
      startedAt: 100,
    };
    notify({ type: 'turn/started', threadId: unloaded.id, turnId: started.id, turn: started });

    expect(store.getSnapshot().turnsByThread.has(unloaded.id)).toBe(false);
    expect(store.getSnapshot().latestTurnByThread.get(unloaded.id)).toEqual(started);
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
    expect(store.getSnapshot().latestTurnByThread.get(unloaded.id)).toEqual(completed);
    expect(store.getSnapshot().threads[0]).toMatchObject({ id: unloaded.id, updatedAt: 110 });
  });

  test('keeps children across a reload while dropping a root the list no longer returns', async () => {
    const owner = thread('thread-1', 2);
    const dropped = thread('thread-2', 3);
    const child = { ...thread('thread-child', 1), parentThreadId: owner.id, threadSource: 'subagent' as const };
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
          return { data: listCalls === 1 ? [owner, dropped] : [owner], nextCursor: null };
        }
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    notify({ type: 'thread/started', threadId: child.id, thread: child });
    const active = turn('turn-child', 'inProgress', '');
    notify({ type: 'turn/started', threadId: child.id, turnId: active.id, turn: active });
    const droppedTurn = turn('turn-dropped', 'inProgress', '');
    notify({ type: 'turn/started', threadId: dropped.id, turnId: droppedTurn.id, turn: droppedTurn });
    expect(store.getSnapshot().latestTurnByThread.has(child.id)).toBe(true);

    await store.reloadThreads();

    // `thread/list` is root-only, so a child's absence proves nothing: it stays
    // in the catalog, and the transcript keeps its identity and live status.
    // A ROOT the list no longer returns really is gone.
    expect(store.getSnapshot().threads.map((entry) => entry.id).toSorted())
      .toEqual([owner.id, child.id].toSorted());
    expect(store.getSnapshot().latestTurnByThread.has(child.id)).toBe(true);
    expect(store.getSnapshot().latestTurnByThread.has(dropped.id)).toBe(false);
  });

  test('clears latest canonical Turn cache entries for a deleted subtree', async () => {
    const owner = thread('thread-1', 2);
    const child = { ...thread('thread-child', 1), parentThreadId: owner.id, threadSource: 'subagent' as const };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner, child], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'thread/delete') return {};
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    const completed = turn('turn-child', 'completed', 'done');
    notify({ type: 'turn/completed', threadId: child.id, turnId: completed.id, turn: completed });

    await store.deleteThread(owner.id);

    expect(store.getSnapshot().threads).toEqual([]);
    expect(store.getSnapshot().latestTurnByThread.size).toBe(0);
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
        acceptedAt: 100,
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

  test('replaces transient Turn Plan snapshots and clears them at terminal state', async () => {
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
      type: 'turn/plan/updated',
      threadId: owner.id,
      turnId: active.id,
      explanation: 'Initial plan',
      plan: [{ step: 'Inspect', status: 'in_progress' }],
    });
    notify({
      type: 'turn/plan/updated',
      threadId: owner.id,
      turnId: active.id,
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Implement', status: 'in_progress' },
      ],
    });

    expect(store.getSnapshot().planByThread.get(owner.id)).toEqual({
      turnId: active.id,
      plan: [
        { step: 'Inspect', status: 'completed' },
        { step: 'Implement', status: 'in_progress' },
      ],
    });

    const completed = turn(active.id, 'completed', 'done');
    notify({ type: 'turn/completed', threadId: owner.id, turnId: active.id, turn: completed });
    expect(store.getSnapshot().planByThread.has(owner.id)).toBe(false);
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

  test('deduplicates exact payload-backed tool argument reads by immutable context identity', async () => {
    const owner = thread('thread-1', 1);
    const payload = {
      schemaVersion: 1 as const,
      kind: 'toolCallArguments' as const,
      value: { query: 'exact payload-backed arguments' },
    };
    const ref = {
      id: 'd'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-context+json' as const,
      byteLength: 128,
      schemaVersion: 1 as const,
      kind: 'toolCallArguments' as const,
    };
    const requests: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        requests.push({ method, input });
        if (method === 'thread/context/read') return { context: { ref, payload } };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const item = {
      ...commandTurn('turn-1', 'completed').items[0]!,
      modelCall: {
        ...replayableModelCall('bash', {}),
        arguments: { storage: 'payload' as const, ref },
      },
    } as ThreadItem;

    expect(await Promise.all([
      store.readToolArguments(owner.id, 'turn-1', item),
      store.readToolArguments(owner.id, 'turn-1', item),
    ])).toEqual([payload.value, payload.value]);
    expect(requests).toEqual([{
      method: 'thread/context/read',
      input: {
        threadId: owner.id,
        turnId: 'turn-1',
        itemId: item.id,
        contextId: ref.id,
      },
    }]);
  });

  test('bounds payload-backed arguments before caching them for renderer surfaces', async () => {
    const owner = thread('thread-1', 1);
    const ref = {
      id: 'e'.repeat(64),
      mimeType: 'application/vnd.tenon.agent-context+json' as const,
      byteLength: 1_000_000,
      schemaVersion: 1 as const,
      kind: 'toolCallArguments' as const,
    };
    const payload = {
      schemaVersion: 1 as const,
      kind: 'toolCallArguments' as const,
      value: { content: 'x'.repeat(1_000_000), path: '/workspace/large.txt' },
    };
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/context/read') return { context: { ref, payload } };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const item = {
      ...commandTurn('turn-1', 'completed').items[0]!,
      modelCall: {
        ...replayableModelCall('bash', {}),
        arguments: { storage: 'payload' as const, ref },
      },
    } as ThreadItem;

    const value = await store.readToolArguments(owner.id, 'turn-1', item);

    expect(value).toMatchObject({ truncated: true });
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected a bounded argument summary.');
    }
    expect(value.originalChars).toBeGreaterThan(1_000_000);
    expect(JSON.stringify(value, null, 2).length).toBeLessThanOrEqual(32_000);
  });

  test('never resolves raw collaboration output through the renderer store', async () => {
    let reads = 0;
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async () => {
        reads += 1;
        return { output: null };
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const item: Extract<ThreadItem, { type: 'collabAgentToolCall' }> = {
      id: 'collaboration-item',
      provenance: {
        originThreadId: 'thread-1',
        originTurnId: 'turn-1',
        originItemId: 'collaboration-item',
      },
      type: 'collabAgentToolCall',
      tool: 'task_stop',
      status: 'completed',
      outputRef: {
        id: 'c'.repeat(64),
        mimeType: 'application/json',
        byteLength: 40,
        summary: 'tokensUsed: 1234',
      },
      senderThreadId: 'thread-1',
      receiverThreadIds: [],
      prompt: null,
      summary: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    };

    expect(await store.readItemOutput('thread-1', 'turn-1', item)).toBeNull();
    expect(reads).toBe(0);
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

  test('recovers a child Thread the list never returns, and reports a deleted one', async () => {
    const owner = thread('thread-1', 2);
    const child = { ...thread('thread-child', 1), parentThreadId: owner.id, threadSource: 'subagent' as const };
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input?: unknown) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'thread/read') {
          const threadId = (input as { threadId: string }).threadId;
          if (threadId !== child.id) throw new Error(`Thread not found: ${threadId}`);
          return { thread: child };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    // Not a list row, so the catalog has to recover it through `thread/read`.
    await store.openThreadById(child.id);
    expect(store.getSnapshot().selectedThreadId).toBe(child.id);
    expect(store.getSnapshot().threads.map((entry) => entry.id)).toContain(child.id);

    // A genuinely deleted Thread rejects, so the caller can say so instead of
    // failing silently behind a bare void call.
    await expect(store.openThreadById('thread-gone')).rejects.toThrow('Thread not found');
  });

  test('lists descendants for the parent browse surface and folds them into the catalog', async () => {
    const owner = thread('thread-1', 3);
    const child = { ...thread('thread-child', 2), parentThreadId: owner.id, threadSource: 'subagent' as const };
    const grandchild = { ...thread('thread-grandchild', 1), parentThreadId: child.id, threadSource: 'subagent' as const };
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'thread/descendants') return { data: [child, grandchild], queuedWorkThreadIds: [child.id] };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    const view = await store.listDescendants(owner.id);
    expect(view.threads.map((entry) => entry.id)).toEqual([child.id, grandchild.id]);
    // Queued work is what keeps an idle child out of "finished": the renderer
    // cannot see the host mailbox, so the subtree read carries it.
    expect([...view.queuedWorkThreadIds]).toEqual([child.id]);
    expect(store.getSnapshot().threads.map((entry) => entry.id).toSorted())
      .toEqual([owner.id, child.id, grandchild.id].toSorted());
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

function childTurn(threadId: string, id: string, status: Turn['status']): Turn {
  const itemId = `${id}-item`;
  return {
    id,
    items: [{
      type: 'agentMessage',
      id: itemId,
      provenance: { originThreadId: threadId, originTurnId: id, originItemId: itemId },
      text: 'Child response',
      phase: 'final_answer',
      memoryCitation: null,
    }],
    itemsView: 'full',
    provenance: {
      originThreadId: threadId,
      originTurnId: id,
      trigger: { kind: 'subagent', parentThreadId: 'thread-root', parentItemId: 'agent-call' },
    },
    status,
    error: null,
    startedAt: 1,
    completedAt: status === 'inProgress' ? null : 2,
    durationMs: status === 'inProgress' ? null : 1,
  };
}

function rendererUserView() {
  return {
    activePanelId: 'panel-1',
    focusedPanelId: 'panel-1',
    focusSurface: 'outline',
    focusedNodeId: 'node-1',
    selectedNodeIds: ['node-1'],
    panels: [{
      panelId: 'panel-1',
      rootNodeId: 'root-1',
      order: 0,
      active: true,
      focused: true,
      visibleNodes: [{ nodeId: 'node-1', depth: 1, expanded: false }],
      visibleOutlineTruncated: false,
    }],
    truncated: false,
  } as const;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
