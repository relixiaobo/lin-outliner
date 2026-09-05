import { describe, expect, test } from 'bun:test';
import type {
  AgentCoreNotification,
  AgentIdentityEntry,
  Thread,
  ThreadItem,
  ToolTaskProjection,
  Turn,
} from '../../src/core/agent/protocol';
import { ThreadStore, mergeLoadedTurns } from '../../src/renderer/agent/store/threadStore';
import type { api } from '../../src/renderer/api/client';
import { replayableModelCall } from '../fixtures/agentToolCallHistory';

type ThreadStoreClient = Pick<typeof api, 'agentCoreRequest' | 'onAgentCoreNotification'>
  & Partial<Pick<typeof api, 'onSettingsChanged'>>;

describe('renderer Thread store', () => {
  test('retries failed initialization on remount and keeps successful initialization single-flight', async () => {
    const owner = thread('thread-restored', 1);
    const blocked = deferred<void>();
    let listReads = 0;
    let notificationSubscriptions = 0;
    const client = {
      onAgentCoreNotification: () => {
        notificationSubscriptions += 1;
        return () => { notificationSubscriptions -= 1; };
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') {
          listReads += 1;
          if (listReads === 1) {
            await blocked.promise;
            throw new Error('Agent resource initialization failed');
          }
          return { data: [owner], nextCursor: null };
        }
        if (method === 'identities/get') return { entries: [] };
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'thread/descendants') return { data: [], queuedWorkThreadIds: [] };
        if (method === 'thread/subagents/list' || method === 'thread/tasks/list') return { data: [] };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    try {
      const first = store.initialize();
      expect(store.initialize()).toBe(first);
      expect(listReads).toBe(1);
      expect(notificationSubscriptions).toBe(1);
      store.dispose();
      blocked.resolve();
      await first;
      expect(store.getSnapshot().error).toBe('Agent resource initialization failed');

      const recovered = store.initialize();
      expect(store.initialize()).toBe(recovered);
      await recovered;
      expect(listReads).toBe(2);
      expect(store.getSnapshot()).toMatchObject({
        loading: false, error: null, selectedThreadId: owner.id, threads: [owner],
      });
      expect(notificationSubscriptions).toBe(1);
      store.dispose();
      expect(store.initialize()).toBe(recovered);
      expect(listReads).toBe(2);
      expect(notificationSubscriptions).toBe(1);
    } finally {
      store.dispose();
    }
  });

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
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await Promise.resolve();

    expect(asked).toContain(owner.id);
    expect(store.getSnapshot().identityCatalogByThread.get(owner.id)?.get('main')?.persona).toBe('Aspen');
  });

  test('keeps concurrent identity rosters under their owning Threads', async () => {
    // Two Thread reads in flight: the slower root answer belongs under the root
    // instead of overwriting the second Thread's worktree-specific roster.
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
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await store.selectThread(second.id);
    await Promise.resolve();
    slow.resolve({ entries: [{ agentType: 'main', persona: 'First', color: 'pink', source: 'built-in' }] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot().identityCatalogByThread.get(first.id)?.get('main')?.persona).toBe('First');
    expect(store.getSnapshot().identityCatalogByThread.get(second.id)?.get('main')?.persona).toBe('Second');
  });

  test('re-reads the roster when configuration changes, not only when threads do', async () => {
    // Identities are configuration: they change from the settings window, which
    // produces no Turn and no core notification. Without this the transcript
    // would keep calling an Agent by its old name until the reader switched
    // conversations.
    const owner = thread('thread-1', 1);
    let persona = 'Aspen';
    let notifySettings: () => void = () => undefined;
    const client = {
      onAgentCoreNotification: () => () => undefined,
      onSettingsChanged: (listener: () => void) => {
        notifySettings = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'identities/get') {
          return { entries: [{ agentType: 'main', persona, color: 'teal', source: 'built-in' }] };
        }
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await Promise.resolve();
    expect(store.getSnapshot().identityCatalogByThread.get(owner.id)?.get('main')?.persona).toBe('Aspen');

    persona = 'Juniper';
    notifySettings();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot().identityCatalogByThread.get(owner.id)?.get('main')?.persona).toBe('Juniper');
  });

  test('refreshes the roster after Turn admission for live configuration breakage and recovery', async () => {
    const owner = thread('thread-1', 1);
    let entries: readonly AgentIdentityEntry[] = [
      { agentType: 'main', persona: 'Juniper', color: 'pink', source: 'built-in' },
    ];
    let identityReads = 0;
    let submittedTurns = 0;
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'identities/get') {
          identityReads += 1;
          return { entries };
        }
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'turn/submit') {
          submittedTurns += 1;
          const accepted = turn(`turn-${submittedTurns}`, 'inProgress', '');
          return {
            acceptedItemId: `item-${submittedTurns}`,
            deduplicated: false,
            turn: accepted,
            turnId: accepted.id,
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    await Promise.resolve();
    expect(store.getSnapshot().identityCatalogByThread.get(owner.id)?.get('main')?.persona).toBe('Juniper');

    entries = [
      { agentType: 'main', persona: 'Aspen', color: 'teal', source: 'built-in' },
    ];
    await store.send([{ type: 'text', text: 'Observe the live break' }]);
    await Promise.resolve();
    expect(store.getSnapshot().identityCatalogByThread.get(owner.id)?.get('main')?.persona).toBe('Aspen');

    entries = [
      { agentType: 'main', persona: 'Scout', color: 'blue', source: 'built-in' },
    ];
    await store.send([{ type: 'text', text: 'Observe the live recovery' }]);
    await Promise.resolve();
    expect(store.getSnapshot().identityCatalogByThread.get(owner.id)?.get('main')?.persona).toBe('Scout');
    expect(identityReads).toBe(3);
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

  test('keeps Tool Tasks durable across cold load, realtime races, reads, stops, and Thread deletion', async () => {
    const owner = thread('thread-1', 1);
    const staleList = deferred<{ data: ToolTaskProjection[] }>();
    const running = toolTask('task-1', owner.id, 'running');
    const finished = { ...running, state: 'succeeded' as const, completedAt: 20, outputBytes: 4, detailBytes: 4 };
    const stopped = { ...running, taskId: 'task-2', state: 'cancelled' as const, completedAt: 21 };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const requests: string[] = [];
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        requests.push(method);
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/tasks/list') return staleList.promise;
        if (method === 'thread/turns/list') return { data: [], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'identities/get') return { entries: [] };
        if (method === 'task/read') return {
          task: finished,
          output: { stdout: 'done', stderr: '', stdoutTruncated: false, stderrTruncated: false },
        };
        if (method === 'task/stop') return { task: stopped };
        if (method === 'task/details/clear') return {
          data: [{ ...finished, detailState: 'cleared' }],
          reclaimedBytes: 4,
        };
        if (method === 'thread/delete') return {};
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();
    notify({ type: 'toolTask/changed', threadId: owner.id, task: finished });
    staleList.resolve({ data: [running] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot().toolTasksById.get(running.taskId)?.state).toBe('succeeded');
    expect((await store.readToolTask(owner.id, running.taskId)).output?.stdout).toBe('done');
    await store.stopToolTask(owner.id, stopped.taskId);
    expect(store.getSnapshot().toolTasksById.get(stopped.taskId)?.state).toBe('cancelled');
    expect(await store.clearToolTaskDetails(owner.id)).toBe(4);
    expect(store.getSnapshot().toolTasksById.get(finished.taskId)?.detailState).toBe('cleared');
    await store.deleteThread(owner.id);
    expect(store.getSnapshot().toolTasksById.size).toBe(0);
    expect(requests).toContain('thread/tasks/list');
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
        author: { kind: 'reader' },
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

    const submission = await store.send([
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
    expect(submission).toEqual({
      acceptedItemId: 'item-accepted',
      deduplicated: false,
      turn: startedTurn,
      turnId: startedTurn.id,
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

  test('reruns by Turn identity and replaces the failed Turn with the admitted rerun', async () => {
    const owner = thread('thread-1', 1);
    const failed = turn('turn-failed', 'failed', 'failed response');
    const replacement = turn('turn-replacement', 'inProgress', '');
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [failed], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'turn/rerun') {
          return {
            thread: { ...owner, status: { type: 'active', activeFlags: [] }, updatedAt: 2 },
            turn: replacement,
            replacedTurnId: failed.id,
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    await store.rerunTurn(owner.id, failed.id, false);

    expect(calls.filter((call) => call.method === 'turn/rerun')).toEqual([{
      method: 'turn/rerun',
      input: { threadId: owner.id, turnId: failed.id, confirmToolReplay: false },
    }]);
    expect(calls.some((call) => call.method === 'thread/rollback' || call.method === 'turn/submit')).toBe(false);
    expect(store.getSnapshot().turnsByThread.get(owner.id)).toEqual([replacement]);
    expect(store.getSnapshot().latestTurnByThread.get(owner.id)).toEqual(replacement);
  });

  test('does not regress a rerun that completes before its command response arrives', async () => {
    const owner = thread('thread-1', 1);
    const failed = turn('turn-failed', 'failed', 'failed response');
    const replacement = turn('turn-replacement', 'inProgress', '');
    const completed = {
      ...replacement,
      status: 'completed' as const,
      items: turn('turn-replacement', 'completed', 'recovered').items,
      completedAt: 3,
      durationMs: 2,
    };
    let notify: (notification: AgentCoreNotification) => void = () => undefined;
    const client = {
      onAgentCoreNotification: (listener: (notification: AgentCoreNotification) => void) => {
        notify = listener;
        return () => undefined;
      },
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [failed], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'turn/rerun') {
          notify({
            type: 'turn/started',
            threadId: owner.id,
            turnId: replacement.id,
            turn: replacement,
          });
          notify({
            type: 'turn/completed',
            threadId: owner.id,
            turnId: completed.id,
            turn: completed,
          });
          notify({ type: 'thread/status/changed', threadId: owner.id, status: { type: 'idle' } });
          return {
            thread: { ...owner, status: { type: 'active', activeFlags: [] }, updatedAt: 2 },
            turn: replacement,
            replacedTurnId: failed.id,
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    await store.rerunTurn(owner.id, failed.id, false);

    expect(store.getSnapshot().turnsByThread.get(owner.id)).toEqual([completed]);
    expect(store.getSnapshot().latestTurnByThread.get(owner.id)).toEqual(completed);
    expect(store.getSnapshot().threads.find((thread) => thread.id === owner.id)?.status).toEqual({ type: 'idle' });
  });

  test('appends a continued Turn while preserving its failed source', async () => {
    const owner = thread('thread-1', 1);
    const failed = turn('turn-failed', 'failed', 'settled partial response');
    const continuation = {
      ...turn('turn-continuation', 'inProgress', ''),
      startedAt: 3,
      provenance: {
        originThreadId: owner.id,
        originTurnId: 'turn-continuation',
        trigger: { kind: 'continuation' as const, sourceTurnId: failed.id },
      },
    };
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === 'thread/list') return { data: [owner], nextCursor: null };
        if (method === 'thread/turns/list') return { data: [failed], nextCursor: null, backwardsCursor: null };
        if (method === 'goal/get') return { goal: null };
        if (method === 'thread/configuration/get') return configurationResponse(owner);
        if (method === 'turn/continue') {
          return {
            thread: { ...owner, status: { type: 'active', activeFlags: [] }, updatedAt: 2 },
            turn: continuation,
            sourceTurnId: failed.id,
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    await store.initialize();

    await store.continueTurn(owner.id, failed.id);

    expect(calls.filter((call) => call.method === 'turn/continue')).toEqual([{
      method: 'turn/continue',
      input: { threadId: owner.id, turnId: failed.id },
    }]);
    expect(store.getSnapshot().turnsByThread.get(owner.id)).toEqual([failed, continuation]);
    expect(store.getSnapshot().latestTurnByThread.get(owner.id)).toEqual(continuation);
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
        author: { kind: 'reader' },
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
        author: { kind: 'reader' },
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

  test('deduplicates Item-bound tool argument reads by immutable Item identity', async () => {
    const owner = thread('thread-1', 1);
    const argumentsValue = { query: 'exact payload-backed arguments' };
    const requests: Array<{ method: string; input: Record<string, unknown> }> = [];
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string, input: Record<string, unknown>) => {
        requests.push({ method, input });
        if (method === 'thread/item/arguments/read') return { arguments: argumentsValue };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const item = {
      ...commandTurn('turn-1', 'completed').items[0]!,
      modelCall: {
        ...replayableModelCall('bash', {}),
        arguments: { storage: 'itemBound' as const },
      },
    } as ThreadItem;

    expect(await Promise.all([
      store.readToolArguments(owner.id, 'turn-1', item),
      store.readToolArguments(owner.id, 'turn-1', item),
    ])).toEqual([argumentsValue, argumentsValue]);
    expect(requests).toEqual([{
      method: 'thread/item/arguments/read',
      input: {
        threadId: owner.id,
        turnId: 'turn-1',
        itemId: item.id,
      },
    }]);
  });

  test('caches already-bounded Item arguments for renderer surfaces', async () => {
    const owner = thread('thread-1', 1);
    const bounded = { truncated: true, originalChars: 1_000_050, preview: '{\n  "content": "xxx' };
    const client = {
      onAgentCoreNotification: () => () => undefined,
      agentCoreRequest: async (method: string) => {
        if (method === 'thread/item/arguments/read') return { arguments: bounded };
        throw new Error(`Unexpected method: ${method}`);
      },
    } as unknown as ThreadStoreClient;
    const store = new ThreadStore(client);
    const item = {
      ...commandTurn('turn-1', 'completed').items[0]!,
      modelCall: {
        ...replayableModelCall('bash', {}),
        arguments: { storage: 'itemBound' as const },
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

function toolTask(
  taskId: string,
  ownerThreadId: string,
  state: ToolTaskProjection['state'],
): ToolTaskProjection {
  return {
    taskId,
    ownerThreadId,
    sourceTurnId: 'turn-source',
    sourceItemId: 'item-source',
    producer: 'bash',
    description: 'Background command',
    state,
    deliveryState: 'pending',
    progress: null,
    exitCode: null,
    signal: null,
    outcomeReason: null,
    error: null,
    detailState: 'available',
    artifacts: [],
    artifactWarnings: [],
    outputBytes: 0,
    detailBytes: 0,
    storagePressure: null,
    startedAt: 10,
    completedAt: null,
    deliveryTurnId: null,
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

function rendererUserView() {
  return {
    activePanelId: 'panel-1',
    focusedPanelId: 'panel-1',
    focusSurface: 'outline',
    focusedNodeId: 'node-1',
    selectedNodeIds: ['node-1'],
    panels: [{
      panelId: 'panel-1',
      order: 0,
      active: true,
      focused: true,
      target: { kind: 'node', nodeId: 'root-1' },
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
