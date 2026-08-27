import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SubagentExecutionLedger } from '../../src/main/agent/persistence/SubagentExecutionLedger';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { SubagentCollaboration } from '../../src/main/agent/thread/SubagentCollaboration';
import type {
  AgentWorktreeMetadata,
  AgentWorktreeRecoveryIntent,
} from '../../src/main/agent/worktree/AgentWorktree';

const PARENT_ID = 'parent-thread';
const FIRST_AGENT_ID = 'first-agent';
const SECOND_AGENT_ID = 'second-agent';

function subagentRequestLedgerStub() {
  return {
    readRequest: () => null,
    readChild: () => null,
    childrenForOriginTurn: () => [],
    createAdmission: (input: {
      readonly request: { readonly originTurnId: string; readonly originThreadId: string };
      readonly child: { readonly threadId: string; readonly originTurnId: string };
    }) => ({
      request: { ...input.request, closedAt: null },
      child: { ...input.child },
    }),
    closeRequest: () => null,
    deleteChild: () => false,
    deleteRequestIfEmpty: () => false,
    clearThread: () => false,
    clearThreadsForRecovery: () => false,
  };
}

interface DeliverySeam {
  deliverParentMessages(
    parentThreadId: string,
    foreground?: { readonly senderAgentId: string; readonly generation: number },
  ): Promise<void>;
}

interface MainMessageSeam extends DeliverySeam {
  sendAgentMessageToMain(senderThreadId: string, message: string): Promise<unknown>;
}

interface RecoverySeam {
  discardStaleForegroundParentMessages(): Promise<void>;
  recoverPendingNotifications(): Promise<void>;
}

interface AdmissionSeam {
  assertNewAgentAdmission(senderThreadId: string): Promise<void>;
  terminalPipelines: Map<string, Promise<void>>;
  terminalSettlementReservations: Map<string, {
    readonly pipeline: Promise<void> | null;
    readonly retryAttempt: number;
    readonly retryExhausted: boolean;
    readonly retryTimer: ReturnType<typeof setTimeout> | null;
    readonly notifyParent?: boolean;
  }>;
}

interface TerminalSettlementSeam extends AdmissionSeam, MainMessageSeam {
  terminalSettlementDeferreds: Map<string, { readonly promise: Promise<unknown> }>;
  beginThreadDeletion(threadIds: readonly string[]): void;
  finishThreadDeletion(threadIds: readonly string[]): void;
  beginClose(): void;
  clearThreadCoordinationState(threadIds: readonly string[]): void;
  drainForClose(deadline: number): Promise<boolean>;
  deliverParentWork(parentThreadId: string): Promise<void>;
  ensureTerminalPipeline(agentId: string, generation: number): Promise<void>;
  prepareChildTerminalSettlement(thread: unknown, turn: unknown): void;
  queueChildTurnActivity(thread: unknown, turn: unknown): void;
  threadBecameIdle(threadId: string): void;
}

describe('foreground Agent main-message delivery', () => {
  test('rejects foreground and background Agent spawns aborted during async preflight', async () => {
    for (const runInBackground of [false, true] as const) {
      let releaseStartup!: () => void;
      let markStartupEntered!: () => void;
      const startupGate = new Promise<void>((resolve) => { releaseStartup = resolve; });
      const startupEntered = new Promise<void>((resolve) => { markStartupEntered = resolve; });
      let prepareCalls = 0;
      let createThreadCalls = 0;
      const collaboration = spawnAdmissionCollaboration({
        resolveAgentStartupContext: async () => {
          markStartupEntered();
          await startupGate;
          return null;
        },
        planAgentWorktree: async () => agentWorktreeIntent('/managed/preflight'),
        prepareAgentWorktree: async () => {
          prepareCalls += 1;
          throw new Error('worktree preparation must not start');
        },
        createThread: async () => {
          createThreadCalls += 1;
          throw new Error('Thread creation must not start');
        },
      });
      const controller = new AbortController();
      const spawn = collaboration.spawnAgent({
        senderThreadId: PARENT_ID,
        senderTurnId: 'parent-turn',
        parentItemId: 'agent-tool',
        description: 'Inspect the repository',
        prompt: 'Inspect the repository',
        agentType: 'general-purpose',
        runInBackground,
        isolation: 'worktree',
        signal: controller.signal,
      });

      await startupEntered;
      controller.abort(new Error('Parent Turn stopped during Agent preflight'));
      releaseStartup();

      await expect(spawn).rejects.toThrow('Parent Turn stopped during Agent preflight');
      expect(prepareCalls).toBe(0);
      expect(createThreadCalls).toBe(0);
    }
  });

  test('reclaims a prepared worktree when parent ownership expires at tree admission', async () => {
    for (const runInBackground of [false, true] as const) {
      const worktree = agentWorktree(`/managed/${runInBackground ? 'background' : 'foreground'}`);
      let parentActive = true;
      let createThreadCalls = 0;
      const settled: AgentWorktreeMetadata[] = [];
      let markPrepareEntered!: () => void;
      let releasePrepare!: () => void;
      const prepareEntered = new Promise<void>((resolve) => { markPrepareEntered = resolve; });
      const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
      const collaboration = spawnAdmissionCollaboration({
        requireActiveTurn: () => {
          if (!parentActive) throw new Error('Parent Turn is no longer active');
        },
        runTreeMutex: async (operation) => {
          const result = operation();
          await prepareEntered;
          parentActive = false;
          releasePrepare();
          return result;
        },
        planAgentWorktree: async () => agentWorktreeIntent(worktree.path),
        prepareAgentWorktree: async () => {
          markPrepareEntered();
          await prepareGate;
          return { cwd: worktree.path, worktree };
        },
        settleAgentWorktree: async (prepared) => {
          settled.push(prepared);
          return { worktree: prepared, retained: false };
        },
        createThread: async () => {
          if (!parentActive) throw new Error('Parent Turn is no longer active');
          createThreadCalls += 1;
          throw new Error('Thread creation unexpectedly started');
        },
      });

      await expect(collaboration.spawnAgent({
        senderThreadId: PARENT_ID,
        senderTurnId: 'parent-turn',
        parentItemId: 'agent-tool',
        description: 'Inspect the repository',
        prompt: 'Inspect the repository',
        agentType: 'general-purpose',
        runInBackground,
        isolation: 'worktree',
      })).rejects.toThrow('Parent Turn is no longer active');

      expect(createThreadCalls).toBe(0);
      expect(settled).toEqual([worktree]);
    }
  });

  test('rejects an Agent spawn whose Item is outside the active parent Turn', async () => {
    const collaboration = spawnAdmissionCollaboration({
      createThread: async () => { throw new Error('Thread creation must not start'); },
    });

    await expect(collaboration.spawnAgent({
      senderThreadId: PARENT_ID,
      senderTurnId: 'parent-turn',
      parentItemId: 'stale-agent-tool',
      description: 'Stale replay',
      prompt: 'Do not start',
      agentType: 'general-purpose',
      runInBackground: true,
      isolation: null,
    })).rejects.toThrow('Agent spawn Item is outside the active parent Turn');
  });

  test('rejects an Agent spawn whose parent Item is not an active Agent call', async () => {
    for (const spawnItem of [
      { type: 'dynamicToolCall', id: 'agent-tool', tool: 'agent', status: 'inProgress' },
      { type: 'collabAgentToolCall', id: 'agent-tool', tool: 'agent', status: 'completed' },
    ]) {
      const collaboration = spawnAdmissionCollaboration({
        spawnItem,
        createThread: async () => { throw new Error('Thread creation must not start'); },
      });

      await expect(collaboration.spawnAgent({
        senderThreadId: PARENT_ID,
        senderTurnId: 'parent-turn',
        parentItemId: 'agent-tool',
        description: 'Invalid replay',
        prompt: 'Do not start',
        agentType: 'general-purpose',
        runInBackground: true,
        isolation: null,
      })).rejects.toThrow('Agent spawn boundary must reference an in-progress agent Item');
    }
  });

  test('returns a non-empty foreground result when the child has no text or usage', async () => {
    const collaboration = spawnAdmissionCollaboration({
      createThread: async () => { throw new Error('unused'); },
    });
    collaboration.spawnAgent = async () => ({
      agentId: FIRST_AGENT_ID,
      runMode: 'foreground',
      report: '',
      usage: null,
      outputFile: null,
    });
    const [agent] = collaboration.collaborationToolContributions(
      { threadId: PARENT_ID, turnId: 'parent-turn' },
      [],
    );
    if (!agent) throw new Error('Agent tool was not contributed');

    const result = await agent.execute('agent-tool', {
      description: 'Return no text',
      prompt: 'Return no text',
      subagent_type: 'general-purpose',
      run_in_background: false,
    });

    expect(result.content).toEqual([{ type: 'text', text: 'Agent finished without text output.' }]);
  });

  test('rejects Agent self-message and self-stop targets', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const collaboration = new SubagentCollaboration(
      {} as never,
      {} as never,
      {} as never,
      { requireActiveTurn: () => undefined } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );

    await expect(collaboration.sendAgentMessage(
      FIRST_AGENT_ID,
      'first-turn',
      'message-item',
      FIRST_AGENT_ID,
      'Loop this message',
      'Loop',
    )).resolves.toEqual({ success: false, message: 'An Agent cannot send a message to itself.' });
    await expect(collaboration.stopAgentTask(FIRST_AGENT_ID, 'first-turn', FIRST_AGENT_ID))
      .rejects.toThrow('An Agent cannot stop itself.');
    expect(collaboration.hasAgentTask(FIRST_AGENT_ID, FIRST_AGENT_ID)).toBe(false);
    database.close();
  });

  test('keeps pending Agent admissions unreachable from collaboration tools', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createPendingExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    createExecution(ledger, SECOND_AGENT_ID, 'second-turn', 'second-tool');
    const threads = new Map([
      [PARENT_ID, {
        id: PARENT_ID,
        sessionId: 'session',
        parentThreadId: null,
        source: 'app',
      }],
      [FIRST_AGENT_ID, {
        id: FIRST_AGENT_ID,
        sessionId: 'session',
        parentThreadId: PARENT_ID,
        source: 'collaboration',
      }],
      [SECOND_AGENT_ID, {
        id: SECOND_AGENT_ID,
        sessionId: 'session',
        parentThreadId: PARENT_ID,
        source: 'collaboration',
      }],
    ]);
    let steerCalls = 0;
    let interruptCalls = 0;
    const collaboration = new SubagentCollaboration(
      { requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }) } as never,
      {} as never,
      {} as never,
      {
        requireActiveTurn: () => undefined,
        activeTurnId: (threadId: string) => threadId === FIRST_AGENT_ID
          ? 'first-turn'
          : threadId === SECOND_AGENT_ID
            ? 'second-turn'
            : null,
        isActiveTurnFinishing: () => false,
        steerTurn: async () => { steerCalls += 1; },
        interruptTurn: async () => { interruptCalls += 1; },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );

    await expect(collaboration.sendAgentMessage(
      PARENT_ID,
      'parent-turn',
      'root-message-item',
      FIRST_AGENT_ID,
      'Reach the pending Agent',
      'Reach pending',
    )).resolves.toEqual({
      success: false,
      message: `No agent with ID '${FIRST_AGENT_ID}' is reachable.\nUse the agent ID from a background agent's spawn result.`,
    });
    await expect(collaboration.stopAgentTask(PARENT_ID, 'parent-turn', FIRST_AGENT_ID))
      .resolves.toBeNull();
    expect(collaboration.hasAgentTask(PARENT_ID, FIRST_AGENT_ID)).toBe(false);

    await expect(collaboration.sendAgentMessage(
      FIRST_AGENT_ID,
      'first-turn',
      'sibling-message-item',
      SECOND_AGENT_ID,
      'Reach the committed sibling',
      'Reach sibling',
    )).resolves.toEqual({
      success: false,
      message: 'Agent admission is incomplete; messaging is unavailable.',
    });
    await expect(collaboration.sendAgentMessage(
      FIRST_AGENT_ID,
      'first-turn',
      'main-message-item',
      'main',
      'Reach the main conversation',
      'Reach main',
    )).resolves.toEqual({
      success: false,
      message: 'Agent admission is incomplete; messaging is unavailable.',
    });
    await expect(collaboration.stopAgentTask(FIRST_AGENT_ID, 'first-turn', SECOND_AGENT_ID))
      .resolves.toBeNull();
    expect(collaboration.hasAgentTask(FIRST_AGENT_ID, SECOND_AGENT_ID)).toBe(false);

    expect(steerCalls).toBe(0);
    expect(interruptCalls).toBe(0);
    expect(ledger.pendingParentMessages(PARENT_ID)).toEqual([]);
    database.close();
  });

  test('keeps root collaboration access to committed Agents without a root execution', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const threads = new Map([
      [PARENT_ID, {
        id: PARENT_ID,
        sessionId: 'session',
        parentThreadId: null,
        source: 'app',
      }],
      [FIRST_AGENT_ID, {
        id: FIRST_AGENT_ID,
        sessionId: 'session',
        parentThreadId: PARENT_ID,
        source: 'collaboration',
      }],
    ]);
    let steerCalls = 0;
    let interruptCalls = 0;
    const collaboration = new SubagentCollaboration(
      { requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }) } as never,
      {} as never,
      {} as never,
      {
        requireActiveTurn: () => undefined,
        activeTurnId: () => 'first-turn',
        isActiveTurnFinishing: () => false,
        steerTurn: async () => { steerCalls += 1; },
        interruptTurn: async () => { interruptCalls += 1; },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );

    await expect(collaboration.sendAgentMessage(
      PARENT_ID,
      'parent-turn',
      'message-item',
      FIRST_AGENT_ID,
      'Continue the task',
      'Continue',
    )).resolves.toMatchObject({ success: true });
    expect(collaboration.hasAgentTask(PARENT_ID, FIRST_AGENT_ID)).toBe(true);
    await expect(collaboration.stopAgentTask(PARENT_ID, 'parent-turn', FIRST_AGENT_ID))
      .resolves.toMatchObject({ task_id: FIRST_AGENT_ID });
    expect(steerCalls).toBe(1);
    expect(interruptCalls).toBe(1);
    database.close();
  });

  test('rechecks committed admission after acquiring an Agent resume lock', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const originalRead = ledger.read.bind(ledger);
    let targetReads = 0;
    ledger.read = (agentId) => {
      const execution = originalRead(agentId);
      if (agentId !== FIRST_AGENT_ID || !execution) return execution;
      targetReads += 1;
      return targetReads < 2
        ? execution
        : { ...execution, initialAdmissionState: 'pending' };
    };
    const threads = new Map([
      [PARENT_ID, {
        id: PARENT_ID,
        sessionId: 'session',
        parentThreadId: null,
        source: 'app',
      }],
      [FIRST_AGENT_ID, {
        id: FIRST_AGENT_ID,
        sessionId: 'session',
        parentThreadId: PARENT_ID,
        source: 'collaboration',
      }],
    ]);
    let privilegedStarts = 0;
    const collaboration = new SubagentCollaboration(
      {
        requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }),
        readTurn: () => null,
      } as never,
      {} as never,
      {} as never,
      {
        requireActiveTurn: () => undefined,
        activeTurnId: () => null,
        startPrivilegedTurn: async () => { privilegedStarts += 1; },
      } as never,
      subagentRequestLedgerStub() as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );

    await expect(collaboration.sendAgentMessage(
      PARENT_ID,
      'parent-turn',
      'message-item',
      FIRST_AGENT_ID,
      'Resume this Agent',
      'Resume',
    )).resolves.toEqual({
      success: false,
      message: `No agent with ID '${FIRST_AGENT_ID}' is reachable.\nUse the agent ID from a background agent's spawn result.`,
    });
    expect(targetReads).toBe(2);
    expect(privilegedStarts).toBe(0);
    database.close();
  });

  test('keeps a slot occupied until terminal settlement finishes', async () => {
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const root = { id: PARENT_ID, parentThreadId: null, source: 'app' };
    const collaboration = new SubagentCollaboration(
      {
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID ? root : child,
        }),
        metadata: { childEdges: () => [{ childThreadId: FIRST_AGENT_ID }] },
      } as never,
      {} as never,
      {} as never,
      { activeTurnId: () => null } as never,
      {} as never,
      {} as never,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 1 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );
    const seam = collaboration as unknown as AdmissionSeam;
    seam.terminalPipelines.set(`${FIRST_AGENT_ID}:1`, Promise.resolve());

    await expect(seam.assertNewAgentAdmission(PARENT_ID)).rejects.toThrow(
      'Concurrent subagent limit reached. You can run 1 subagents at once.',
    );
  });

  test('does not count settled historical children against a lifetime spawn cap', async () => {
    const root = { id: PARENT_ID, parentThreadId: null, source: 'app' };
    const historicalChildren = Array.from({ length: 32 }, (_, index) => ({
      id: `settled-agent-${index}`,
      parentThreadId: PARENT_ID,
      source: 'collaboration',
    }));
    const threads = new Map([root, ...historicalChildren].map((thread) => [thread.id, thread]));
    const collaboration = new SubagentCollaboration(
      {
        requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }),
        metadata: {
          childEdges: () => historicalChildren.map((thread) => ({ childThreadId: thread.id })),
        },
      } as never,
      {} as never,
      {} as never,
      { activeTurnId: () => null } as never,
      {} as never,
      {} as never,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 1 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );

    await expect((collaboration as unknown as AdmissionSeam).assertNewAgentAdmission(PARENT_ID))
      .resolves.toBeUndefined();
  });

  test('derives Agent spawn availability from the persisted child tool policy', () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    const cases = [
      { id: 'general-child', policy: {}, expected: true },
      { id: 'depth-capped-child', policy: { allowNesting: false }, expected: false },
      { id: 'explore-child', policy: { kind: 'explore' as const }, expected: false },
      { id: 'plan-child', policy: { kind: 'plan' as const }, expected: false },
      { id: 'restricted-child', policy: { requestedTools: ['file_read'] }, expected: false },
      { id: 'agent-enabled-child', policy: { requestedTools: ['agent'] }, expected: true },
    ];
    for (const entry of cases) {
      createExecution(
        ledger,
        entry.id,
        `${entry.id}-turn`,
        `${entry.id}-tool`,
        PARENT_ID,
        entry.policy,
      );
    }
    const pendingChildId = 'pending-child';
    createPendingExecution(ledger, pendingChildId, 'pending-child-turn', 'pending-child-tool');
    const root = { id: PARENT_ID, parentThreadId: null, source: 'app' };
    const threads = new Map([
      [PARENT_ID, root],
      ...cases.map((entry) => [entry.id, {
        id: entry.id,
        parentThreadId: PARENT_ID,
        source: 'collaboration',
      }] as const),
      [pendingChildId, {
        id: pendingChildId,
        parentThreadId: PARENT_ID,
        source: 'collaboration',
      }],
    ]);
    const collaboration = new SubagentCollaboration(
      { requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );
    const withAgent = { tools: ['agent'] } as never;
    const withoutAgent = { tools: ['file_read'] } as never;

    expect(collaboration.canSpawnAgent(PARENT_ID, withAgent)).toBe(true);
    expect(collaboration.canSpawnAgent(PARENT_ID, withoutAgent)).toBe(false);
    for (const entry of cases) {
      expect(collaboration.canSpawnAgent(entry.id, withAgent)).toBe(entry.expected);
    }
    expect(collaboration.canSpawnAgent(pendingChildId, withAgent)).toBe(false);
    database.close();
  });

  test('keeps mismatched active worktree metadata as a closed write-boundary fallback', () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    const worktree = agentWorktree('/managed/expected-worktree');
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool', PARENT_ID, worktree);
    const threads = new Map([
      [PARENT_ID, { id: PARENT_ID, parentThreadId: null, cwd: '/repo', source: 'app' }],
      [FIRST_AGENT_ID, {
        id: FIRST_AGENT_ID,
        parentThreadId: PARENT_ID,
        cwd: '/managed/moved-worktree',
        source: 'collaboration',
      }],
    ]);
    const collaboration = new SubagentCollaboration(
      { requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(collaboration.worktreeForThread(FIRST_AGENT_ID)).toEqual(worktree);
    const warningText = serializedConsoleCalls(warning.mock.calls);
    expect(warning.mock.calls.some((call) => String(call[0]).includes('worktree metadata does not match Thread cwd')))
      .toBe(true);
    expect(warningText).not.toContain(worktree.path);
    expect(warningText).not.toContain('/managed/moved-worktree');
    warning.mockRestore();
    database.close();
  });

  test('waits for a foreground generation through its background descendant notification Turn', async () => {
    const fixture = foregroundSettlementFixture();
    const spawn = fixture.spawn();
    const child = await fixture.childSpawned;
    const descendant = fixture.addBackgroundChild(child.id, SECOND_AGENT_ID, 'descendant-turn');
    let spawnState: 'pending' | 'resolved' | 'rejected' = 'pending';
    void spawn.then(
      () => { spawnState = 'resolved'; },
      () => { spawnState = 'rejected'; },
    );

    const descendantTurn = terminalTurn('descendant-turn');
    fixture.setTerminalTurn(SECOND_AGENT_ID, descendantTurn);
    fixture.setActive(SECOND_AGENT_ID, false);
    fixture.seam.prepareChildTerminalSettlement(descendant, descendantTurn);
    fixture.seam.queueChildTurnActivity(descendant, descendantTurn);
    await fixture.seam.terminalPipelines.get(`${SECOND_AGENT_ID}:1`);
    expect(fixture.ledger.pendingForParent(child.id)).toMatchObject([{
      agentId: SECOND_AGENT_ID,
      generation: 1,
      state: 'pending',
    }]);

    const firstTurn = terminalTurn(child.turnId);
    fixture.setTerminalTurn(child.id, firstTurn);
    fixture.setActive(child.id, false);
    fixture.seam.prepareChildTerminalSettlement(child.thread, firstTurn);
    fixture.seam.queueChildTurnActivity(child.thread, firstTurn);
    await Promise.resolve();

    expect(spawnState).toBe('pending');
    expect(fixture.seam.terminalPipelines.has(`${child.id}:1`)).toBe(false);

    expect(fixture.ledger.claim(SECOND_AGENT_ID, 1)).toBe(true);
    const snapshot = fixture.ledger.generationSnapshot(child.id);
    expect(fixture.ledger.continueGeneration({
      agentId: child.id,
      expectedGeneration: snapshot.generation,
      expectedTurnId: snapshot.currentTurnId,
      turnId: 'notification-turn',
      updatedAt: 101,
    })).toBe(true);
    fixture.ledger.markDelivered(SECOND_AGENT_ID, 1, 102);
    fixture.setActive(child.id, true);
    fixture.seam.threadBecameIdle(SECOND_AGENT_ID);
    await Promise.resolve();
    expect(spawnState).toBe('pending');
    expect(fixture.seam.terminalSettlementReservations.has(`${child.id}:1`)).toBe(true);

    const notificationTurn = terminalTurn('notification-turn');
    fixture.setTerminalTurn(child.id, notificationTurn);
    fixture.setActive(child.id, false);
    fixture.seam.prepareChildTerminalSettlement(child.thread, notificationTurn);
    fixture.seam.queueChildTurnActivity(child.thread, notificationTurn);
    await fixture.seam.terminalPipelines.get(`${child.id}:1`);

    await expect(withTimeout(spawn, 1_000)).resolves.toMatchObject({
      agentId: child.id,
      runMode: 'foreground',
    });
    expect(spawnState).toBe('resolved');
    expect(fixture.seam.terminalSettlementDeferreds.has(`${child.id}:1`)).toBe(false);
    expect(fixture.seam.terminalSettlementDeferreds.has(`${SECOND_AGENT_ID}:1`)).toBe(false);
    fixture.close();
  });

  test('rejects a foreground settlement wait when terminal retries are exhausted', async () => {
    const fixture = foregroundSettlementFixture();
    const spawn = fixture.spawn();
    const child = await fixture.childSpawned;
    const key = `${child.id}:1`;
    await Promise.resolve();
    expect(fixture.seam.terminalSettlementDeferreds.has(key)).toBe(true);
    let recordAttempts = 0;
    fixture.ledger.recordTerminal = () => {
      recordAttempts += 1;
      throw new Error('sqlite remains unavailable');
    };
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    let spawnError: unknown;
    const observedSpawn = spawn.catch((error) => { spawnError = error; });

    const turn = terminalTurn(child.turnId);
    fixture.setTerminalTurn(child.id, turn);
    fixture.setActive(child.id, false);
    fixture.seam.prepareChildTerminalSettlement(child.thread, turn);
    expect(fixture.seam.terminalSettlementDeferreds.has(key)).toBe(true);
    fixture.seam.queueChildTurnActivity(child.thread, turn);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const pipeline = fixture.seam.terminalPipelines.get(key);
      expect(pipeline).toBeDefined();
      await expect(pipeline!).rejects.toThrow('sqlite remains unavailable');
      if (attempt < 5) fixture.seam.threadBecameIdle(child.id);
    }

    await withTimeout(observedSpawn, 1_000);
    expect(spawnError).toEqual(expect.objectContaining({
      message: 'Agent terminal settlement failed after 5 attempts. Restart Tenon to retry durable recovery.',
    }));
    expect(recordAttempts).toBe(5);
    expect(fixture.seam.terminalSettlementReservations.get(key)).toMatchObject({
      retryAttempt: 4,
      retryExhausted: true,
      retryTimer: null,
    });
    expect(fixture.seam.terminalSettlementDeferreds.has(key)).toBe(false);
    warning.mockRestore();
    fixture.close();
  });

  test('abandons a foreground wait when close begins before terminal settlement', async () => {
    const fixture = foregroundSettlementFixture();
    const spawn = fixture.spawn();
    const child = await fixture.childSpawned;
    await Promise.resolve();
    expect(fixture.seam.terminalSettlementDeferreds.has(`${child.id}:1`)).toBe(true);

    fixture.seam.beginClose();

    await expect(withTimeout(spawn, 1_000)).rejects.toThrow('Agent service is shutting down');
    expect(fixture.seam.terminalSettlementDeferreds.has(`${child.id}:1`)).toBe(false);
    fixture.close();
  });

  test('abandons a foreground wait when its Thread coordination state is cleared', async () => {
    const fixture = foregroundSettlementFixture();
    const spawn = fixture.spawn();
    const child = await fixture.childSpawned;

    fixture.seam.clearThreadCoordinationState([child.id]);

    await expect(withTimeout(spawn, 1_000)).rejects.toThrow(
      `Agent Thread was deleted before terminal settlement: ${child.id}`,
    );
    expect(fixture.seam.terminalSettlementDeferreds.has(`${child.id}:1`)).toBe(false);
    fixture.close();
  });

  test('abandons a foreground wait when another generation replaces its reservation', async () => {
    const fixture = foregroundSettlementFixture();
    const spawn = fixture.spawn();
    const child = await fixture.childSpawned;
    await Promise.resolve();
    const turn = terminalTurn(child.turnId);
    fixture.setTerminalTurn(child.id, turn);
    fixture.setActive(child.id, false);
    fixture.seam.prepareChildTerminalSettlement(child.thread, turn);
    const snapshot = fixture.ledger.generationSnapshot(child.id);
    expect(fixture.ledger.beginNextGenerationIfCurrent({
      agentId: child.id,
      expectedGeneration: snapshot.generation,
      expectedTurnId: snapshot.currentTurnId,
      turnId: 'replacement-turn',
      toolUseId: 'replacement-tool',
      runMode: 'foreground',
      tokenBudget: null,
      previous: snapshot,
      updatedAt: 101,
    })).not.toBeNull();

    fixture.seam.threadBecameIdle(child.id);

    await expect(withTimeout(spawn, 1_000)).rejects.toThrow(
      `Agent generation changed before terminal settlement: ${child.id}`,
    );
    expect(fixture.seam.terminalSettlementReservations.has(`${child.id}:1`)).toBe(false);
    fixture.close();
  });

  test('lets invoking Turn abort win while an idle foreground child settles independently', async () => {
    const fixture = foregroundSettlementFixture();
    const controller = new AbortController();
    const stopped = new Error('Root Turn stopped');
    const spawn = fixture.spawn(controller.signal);
    const child = await fixture.childSpawned;
    fixture.setActive(child.id, false);
    await fixture.seam.sendAgentMessageToMain(child.id, 'This foreground message becomes stale.');
    expect(fixture.ledger.pendingParentMessages(PARENT_ID)).toMatchObject([{
      senderAgentId: child.id,
      generation: 1,
      deliveryMode: 'foreground',
    }]);

    controller.abort(stopped);

    await expect(withTimeout(spawn, 1_000)).rejects.toBe(stopped);
    expect(fixture.ledger.terminalNotification(child.id, 1)).toBeNull();
    expect(fixture.ledger.pendingParentMessages(PARENT_ID)).toEqual([]);
    expect(fixture.seam.terminalSettlementDeferreds.has(`${child.id}:1`)).toBe(true);
    await fixture.seam.sendAgentMessageToMain(child.id, 'This message races the child interrupt.');
    expect(fixture.ledger.pendingParentMessages(PARENT_ID)).toHaveLength(1);

    const turn = terminalTurn(child.turnId);
    fixture.setTerminalTurn(child.id, turn);
    fixture.seam.prepareChildTerminalSettlement(child.thread, turn);
    fixture.seam.queueChildTurnActivity(child.thread, turn);
    await fixture.seam.terminalPipelines.get(`${child.id}:1`);

    expect(fixture.ledger.terminalNotification(child.id, 1)).toMatchObject({
      status: 'finished',
      stopProvenance: 'none',
      state: 'delivered',
    });
    await Promise.resolve();
    expect(fixture.ledger.pendingParentMessages(PARENT_ID)).toEqual([]);
    expect(fixture.seam.terminalSettlementDeferreds.has(`${child.id}:1`)).toBe(false);
    fixture.close();
  });

  test('reserves terminal settlement before idle and retries a failed ledger write later', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const originalRecordTerminal = ledger.recordTerminal.bind(ledger);
    let recordAttempts = 0;
    ledger.recordTerminal = (input) => {
      recordAttempts += 1;
      if (recordAttempts === 1) throw new Error('temporary sqlite failure');
      return originalRecordTerminal(input);
    };
    const child = {
      id: FIRST_AGENT_ID,
      parentThreadId: PARENT_ID,
      source: 'collaboration',
    };
    const turn = { id: 'first-turn', status: 'completed', error: null };
    const collaboration = new SubagentCollaboration(
      {
        metadata: {
          childEdges: () => [{ childThreadId: FIRST_AGENT_ID }],
          spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }),
        },
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : child,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        activeTurnId: () => null,
        hasActiveTurn: (threadId: string) => threadId === PARENT_ID,
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 1 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => undefined } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const key = `${FIRST_AGENT_ID}:1`;

    seam.prepareChildTerminalSettlement(child, turn);
    expect(seam.terminalSettlementReservations.has(key)).toBe(true);
    expect(seam.terminalPipelines.has(key)).toBe(false);
    await expect(seam.assertNewAgentAdmission(PARENT_ID)).rejects.toThrow(
      'Concurrent subagent limit reached. You can run 1 subagents at once.',
    );

    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    seam.queueChildTurnActivity(child, turn);
    const first = seam.terminalPipelines.get(key);
    expect(first).toBeDefined();
    await expect(first!).rejects.toThrow('temporary sqlite failure');
    warning.mockRestore();
    expect(recordAttempts).toBe(1);
    expect(seam.terminalSettlementReservations.has(key)).toBe(true);
    expect(ledger.pendingForParent(PARENT_ID)).toEqual([]);

    seam.threadBecameIdle(FIRST_AGENT_ID);
    const retry = seam.terminalPipelines.get(key);
    expect(retry).toBeDefined();
    await retry;
    expect(recordAttempts).toBe(2);
    expect(seam.terminalSettlementReservations.has(key)).toBe(false);
    expect(ledger.pendingForParent(PARENT_ID)).toMatchObject([{
      agentId: FIRST_AGENT_ID,
      generation: 1,
      turnId: 'first-turn',
    }]);
    database.close();
  });

  test('restores parent notification intent when a Thread deletion aborts', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const turn = { id: 'first-turn', status: 'completed', error: null };
    const collaboration = new SubagentCollaboration(
      {
        metadata: { spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }) },
        readTurn: () => turn,
        requireThread: (threadId: string) => ({
          thread: threadId === FIRST_AGENT_ID
            ? child
            : { id: PARENT_ID, parentThreadId: null, source: 'app' },
        }),
      } as never,
      {} as never,
      {} as never,
      { hasActiveTurn: (threadId: string) => threadId === PARENT_ID } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => undefined } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const key = `${FIRST_AGENT_ID}:1`;

    seam.prepareChildTerminalSettlement(child, turn);
    seam.beginThreadDeletion([FIRST_AGENT_ID]);
    expect((seam.terminalSettlementReservations.get(key) as { notifyParent?: boolean })?.notifyParent)
      .toBe(false);
    seam.finishThreadDeletion([FIRST_AGENT_ID]);
    await seam.terminalSettlementReservations.get(key)?.pipeline;

    expect(ledger.pendingForParent(PARENT_ID)).toContainEqual(expect.objectContaining({
      agentId: FIRST_AGENT_ID,
      generation: 1,
    }));
    database.close();
  });

  test('settles a terminal notification when the ordinary transcript flush is wedged', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const turn = { id: 'first-turn', status: 'completed', error: null };
    let ordinaryFlushCalls = 0;
    let terminalFlushCalls = 0;
    const collaboration = new SubagentCollaboration(
      {
        metadata: {
          childEdges: () => [{ childThreadId: FIRST_AGENT_ID }],
          spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }),
        },
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : child,
        }),
      } as never,
      {} as never,
      {} as never,
      { hasActiveTurn: (threadId: string) => threadId === PARENT_ID } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {
        flush: async () => {
          ordinaryFlushCalls += 1;
          await new Promise<void>(() => undefined);
        },
        flushForTerminalSettlement: async () => {
          terminalFlushCalls += 1;
        },
      } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const key = `${FIRST_AGENT_ID}:1`;

    seam.prepareChildTerminalSettlement(child, turn);
    seam.queueChildTurnActivity(child, turn);
    await seam.terminalPipelines.get(key);

    expect(ordinaryFlushCalls).toBe(0);
    expect(terminalFlushCalls).toBe(1);
    expect(ledger.pendingForParent(PARENT_ID)).toMatchObject([{
      agentId: FIRST_AGENT_ID,
      generation: 1,
      turnId: 'first-turn',
    }]);
    database.close();
  });

  test('delivers terminal output even when worktree cleanup keeps failing', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    const worktree: AgentWorktreeMetadata = {
      sourceCwd: '/repo',
      path: '/managed/agent-worktree',
      branch: 'tenon-agent-test',
      baseCommit: 'abc123',
      gitCommonDir: '/repo/.git',
      gitWorktreeDir: '/repo/.git/worktrees/tenon-agent-test',
      managed: true,
      removedAt: null,
    };
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool', PARENT_ID, worktree);
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const turn = { id: 'first-turn', status: 'completed', error: null };
    let cleanupAttempts = 0;
    const collaboration = new SubagentCollaboration(
      {
        metadata: { spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }) },
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : child,
        }),
      } as never,
      {} as never,
      {} as never,
      { hasActiveTurn: (threadId: string) => threadId === PARENT_ID } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      async (_worktree, options) => {
        cleanupAttempts += 1;
        await options?.beforeCleanRemoval?.();
        throw new Error('permanent worktree cleanup failure');
      },
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => undefined } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const key = `${FIRST_AGENT_ID}:1`;
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    seam.prepareChildTerminalSettlement(child, turn);
    seam.queueChildTurnActivity(child, turn);
    await seam.terminalPipelines.get(key);

    expect(cleanupAttempts).toBe(1);
    expect(seam.terminalSettlementReservations.has(key)).toBe(false);
    expect(ledger.pendingForParent(PARENT_ID)).toMatchObject([{
      agentId: FIRST_AGENT_ID,
      generation: 1,
      turnId: 'first-turn',
    }]);
    expect(ledger.require(FIRST_AGENT_ID)).toMatchObject({
      worktree,
      worktreeCleanupStartedAt: 100,
    });
    expect(warning.mock.calls.some((call) => (
      String(call[0]).includes(`Subagent worktree cleanup deferred for ${FIRST_AGENT_ID}`)
    ))).toBe(true);
    warning.mockRestore();
    database.close();
  });

  test('retains a changed worktree and clears stale cleanup intent before resume', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    const worktree: AgentWorktreeMetadata = {
      sourceCwd: '/repo',
      path: '/managed/agent-worktree',
      branch: 'tenon-agent-test',
      baseCommit: 'abc123',
      gitCommonDir: '/repo/.git',
      gitWorktreeDir: '/repo/.git/worktrees/tenon-agent-test',
      managed: true,
      removedAt: null,
    };
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool', PARENT_ID, worktree);
    expect(ledger.beginWorktreeCleanupIfCurrent({
      agentId: FIRST_AGENT_ID,
      generation: 1,
      turnId: 'first-turn',
      worktree,
      startedAt: 50,
    })).not.toBeNull();
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const turn = { id: 'first-turn', status: 'completed', error: null };
    let persistedCwd: string | null = null;
    const collaboration = new SubagentCollaboration(
      {
        metadata: {
          spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }),
          setCwd: (_threadId: string, cwd: string) => { persistedCwd = cwd; },
        },
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : child,
        }),
        ephemeral: new Map(),
      } as never,
      {} as never,
      {} as never,
      { hasActiveTurn: (threadId: string) => threadId === PARENT_ID } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      async () => ({ worktree, retained: true }),
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => undefined } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const key = `${FIRST_AGENT_ID}:1`;

    seam.prepareChildTerminalSettlement(child, turn);
    seam.queueChildTurnActivity(child, turn);
    await seam.terminalPipelines.get(key);

    const retained = ledger.require(FIRST_AGENT_ID);
    expect(retained).toMatchObject({ worktree, worktreeCleanupStartedAt: null });
    expect(persistedCwd).toBe(worktree.path);
    expect(ledger.pendingForParent(PARENT_ID)).toHaveLength(1);
    expect(ledger.beginNextGenerationIfCurrent({
      agentId: FIRST_AGENT_ID,
      expectedGeneration: retained.generation,
      expectedTurnId: retained.currentTurnId,
      turnId: 'second-turn',
      toolUseId: 'second-tool',
      runMode: 'background',
      tokenBudget: null,
      previous: ledger.generationSnapshot(FIRST_AGENT_ID),
      updatedAt: 101,
    })?.generation).toBe(2);
    database.close();
  });

  test('close attempts a failed terminal reservation once and leaves it for startup recovery', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    let recordAttempts = 0;
    ledger.recordTerminal = () => {
      recordAttempts += 1;
      throw new Error('sqlite remains unavailable');
    };
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const collaboration = new SubagentCollaboration(
      {
        metadata: { spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }) },
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : child,
        }),
      } as never,
      {} as never,
      {} as never,
      { hasActiveTurn: (threadId: string) => threadId === PARENT_ID } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => undefined } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const key = `${FIRST_AGENT_ID}:1`;
    const turn = { id: 'first-turn', status: 'completed', error: null };
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    seam.prepareChildTerminalSettlement(child, turn);
    seam.queueChildTurnActivity(child, turn);
    await expect(seam.terminalPipelines.get(key)!).rejects.toThrow('sqlite remains unavailable');
    expect(recordAttempts).toBe(1);
    expect(seam.terminalSettlementReservations.get(key)?.retryTimer).not.toBeNull();

    seam.beginClose();
    expect(await seam.drainForClose(Date.now() + 2_000)).toBe(true);
    expect(await seam.drainForClose(Date.now() + 2_000)).toBe(true);

    expect(recordAttempts).toBe(2);
    expect(seam.terminalSettlementReservations.has(key)).toBe(true);
    expect(seam.terminalSettlementReservations.get(key)?.retryTimer).toBeNull();
    expect(ledger.pendingForParent(PARENT_ID)).toEqual([]);
    warning.mockRestore();
    database.close();
  });

  test('bounds close-time collaboration drain when a terminal pipeline is wedged', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const turn = { id: 'first-turn', status: 'completed', error: null };
    const collaboration = new SubagentCollaboration(
      {
        metadata: { spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }) },
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : child,
        }),
      } as never,
      {} as never,
      {} as never,
      { hasActiveTurn: (threadId: string) => threadId === PARENT_ID } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => await new Promise<void>(() => undefined) } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    seam.prepareChildTerminalSettlement(child, turn);

    expect(await seam.drainForClose(Date.now() + 10)).toBe(false);
    expect(seam.terminalSettlementReservations.has(`${FIRST_AGENT_ID}:1`)).toBe(true);
    database.close();
  });

  test('keeps a terminal reservation when stop provenance persistence fails', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const originalRecordStop = ledger.recordStopIfCurrent.bind(ledger);
    let stopAttempts = 0;
    ledger.recordStopIfCurrent = (input) => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error('stop provenance write failed');
      return originalRecordStop(input);
    };
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const collaboration = new SubagentCollaboration(
      {
        metadata: { spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }) },
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : child,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        activeTurnId: () => null,
        hasActiveTurn: (threadId: string) => threadId === PARENT_ID,
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => undefined } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const key = `${FIRST_AGENT_ID}:1`;
    const turn = {
      id: 'first-turn',
      status: 'interrupted',
      error: { code: 'host_restart', message: 'Host restarted' },
    };
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    seam.prepareChildTerminalSettlement(child, turn);
    seam.queueChildTurnActivity(child, turn);
    await expect(seam.terminalPipelines.get(key)!).rejects.toThrow('stop provenance write failed');
    expect(ledger.require(FIRST_AGENT_ID).stopProvenance).toBe('none');
    expect(seam.terminalSettlementReservations.has(key)).toBe(true);
    expect(ledger.pendingForParent(PARENT_ID)).toEqual([]);

    seam.threadBecameIdle(FIRST_AGENT_ID);
    await seam.terminalPipelines.get(key);

    expect(stopAttempts).toBe(2);
    expect(ledger.require(FIRST_AGENT_ID).stopProvenance).toBe('hostRestart');
    expect(seam.terminalSettlementReservations.has(key)).toBe(false);
    expect(ledger.pendingForParent(PARENT_ID)).toMatchObject([{
      agentId: FIRST_AGENT_ID,
      generation: 1,
      turnId: 'first-turn',
    }]);
    warning.mockRestore();
    database.close();
  });

  test('defers terminal settlement without spending retry budget when a descendant appears during transcript flush', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'parent-turn', 'parent-tool');
    const root = { id: PARENT_ID, parentThreadId: null, source: 'app' };
    const parent = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const descendant = { id: SECOND_AGENT_ID, parentThreadId: FIRST_AGENT_ID, source: 'collaboration' };
    const threads = new Map([
      [PARENT_ID, root],
      [FIRST_AGENT_ID, parent],
      [SECOND_AGENT_ID, descendant],
    ]);
    let descendantActive = false;
    let flushCalls = 0;
    let markFlushEntered!: () => void;
    let releaseFlush!: () => void;
    const flushEntered = new Promise<void>((resolve) => { markFlushEntered = resolve; });
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const collaboration = new SubagentCollaboration(
      {
        metadata: { spawnEdgeForChild: (threadId: string) => ({ taskPath: `/root/${threadId}` }) },
        requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }),
      } as never,
      {} as never,
      {} as never,
      {
        activeTurnId: () => null,
        hasActiveTurn: (threadId: string) => (
          threadId === PARENT_ID || (threadId === SECOND_AGENT_ID && descendantActive)
        ),
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {
        flushForTerminalSettlement: async () => {
          flushCalls += 1;
          if (flushCalls !== 1) return;
          markFlushEntered();
          await flushGate;
        },
      } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const parentKey = `${FIRST_AGENT_ID}:1`;
    const turn = { id: 'parent-turn', status: 'completed', error: null };
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    seam.prepareChildTerminalSettlement(parent, turn);
    seam.queueChildTurnActivity(parent, turn);
    const first = seam.terminalPipelines.get(parentKey);
    expect(first).toBeDefined();
    await flushEntered;

    createBackgroundExecution(
      ledger,
      SECOND_AGENT_ID,
      'descendant-turn',
      'descendant-tool',
      FIRST_AGENT_ID,
    );
    descendantActive = true;
    releaseFlush();
    await first;

    expect(seam.terminalPipelines.has(parentKey)).toBe(false);
    expect(seam.terminalSettlementReservations.get(parentKey)).toMatchObject({
      retryAttempt: 0,
      retryExhausted: false,
      retryTimer: null,
    });
    expect(ledger.pendingForParent(PARENT_ID)).toEqual([]);
    expect(warning.mock.calls.some((call) => (
      String(call[0]).includes('Subagent terminal pipeline deferred')
    ))).toBe(false);

    descendantActive = false;
    seam.threadBecameIdle(SECOND_AGENT_ID);
    const resumed = seam.terminalPipelines.get(parentKey);
    expect(resumed).toBeDefined();
    await resumed;

    expect(flushCalls).toBe(2);
    expect(seam.terminalSettlementReservations.has(parentKey)).toBe(false);
    expect(ledger.pendingForParent(PARENT_ID)).toMatchObject([{
      agentId: FIRST_AGENT_ID,
      generation: 1,
      turnId: 'parent-turn',
    }]);
    seam.beginClose();
    expect(await seam.drainForClose(Date.now() + 2_000)).toBe(true);
    warning.mockRestore();
    database.close();
  });

  test('bounds permanent terminal settlement failure and leaves durable startup recovery authority', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    let recordAttempts = 0;
    ledger.recordTerminal = () => {
      recordAttempts += 1;
      throw new Error('sqlite remains unavailable');
    };
    const child = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const collaboration = new SubagentCollaboration(
      {
        metadata: { spawnEdgeForChild: () => ({ taskPath: `/root/${FIRST_AGENT_ID}` }) },
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : child,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        activeTurnId: () => null,
        hasActiveTurn: (threadId: string) => threadId === PARENT_ID,
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => undefined } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const key = `${FIRST_AGENT_ID}:1`;
    const turn = { id: 'first-turn', status: 'completed', error: null };
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    seam.prepareChildTerminalSettlement(child, turn);
    seam.queueChildTurnActivity(child, turn);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const pipeline = seam.terminalPipelines.get(key);
      expect(pipeline).toBeDefined();
      await expect(pipeline!).rejects.toThrow('sqlite remains unavailable');
      expect(recordAttempts).toBe(attempt);
      if (attempt < 5) {
        expect(seam.terminalSettlementReservations.get(key)?.retryTimer).not.toBeNull();
        seam.threadBecameIdle(FIRST_AGENT_ID);
      }
    }

    expect(seam.terminalPipelines.has(key)).toBe(false);
    expect(seam.terminalSettlementReservations.get(key)).toMatchObject({
      retryAttempt: 4,
      retryExhausted: true,
      retryTimer: null,
    });
    expect(ledger.require(FIRST_AGENT_ID)).toMatchObject({
      generation: 1,
      currentTurnId: 'first-turn',
    });
    expect(ledger.pendingForParent(PARENT_ID)).toEqual([]);

    seam.threadBecameIdle(FIRST_AGENT_ID);
    expect(seam.terminalPipelines.has(key)).toBe(false);
    expect(recordAttempts).toBe(5);
    await expect(seam.ensureTerminalPipeline(FIRST_AGENT_ID, 1)).rejects.toThrow(
      'Agent terminal settlement failed after 5 attempts. Restart Tenon to retry durable recovery.',
    );
    expect(recordAttempts).toBe(5);
    expect(warning.mock.calls.some((call) => (
      String(call[0]).includes('terminal settlement retry budget exhausted')
    ))).toBe(true);

    seam.beginClose();
    expect(await seam.drainForClose(Date.now() + 2_000)).toBe(true);
    warning.mockRestore();
    database.close();
  });

  test('does not settle a parent while a descendant terminal reservation awaits retry', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'parent-turn', 'parent-tool');
    createBackgroundExecution(ledger, SECOND_AGENT_ID, 'descendant-turn', 'descendant-tool', FIRST_AGENT_ID);
    const originalRecordTerminal = ledger.recordTerminal.bind(ledger);
    let parentTerminalAttempts = 0;
    ledger.recordTerminal = (input) => {
      if (input.agentId === SECOND_AGENT_ID) throw new Error('descendant ledger write failed');
      parentTerminalAttempts += 1;
      return originalRecordTerminal(input);
    };
    const root = { id: PARENT_ID, parentThreadId: null, source: 'app' };
    const parent = { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' };
    const descendant = { id: SECOND_AGENT_ID, parentThreadId: FIRST_AGENT_ID, source: 'collaboration' };
    const threads = new Map([
      [PARENT_ID, root],
      [FIRST_AGENT_ID, parent],
      [SECOND_AGENT_ID, descendant],
    ]);
    const collaboration = new SubagentCollaboration(
      {
        metadata: { spawnEdgeForChild: (threadId: string) => ({ taskPath: `/root/${threadId}` }) },
        requireThread: (threadId: string) => ({ thread: threads.get(threadId)! }),
      } as never,
      {} as never,
      {} as never,
      {
        activeTurnId: () => null,
        hasActiveTurn: (threadId: string) => threadId !== SECOND_AGENT_ID,
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => undefined } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const descendantKey = `${SECOND_AGENT_ID}:1`;
    const parentKey = `${FIRST_AGENT_ID}:1`;
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    seam.prepareChildTerminalSettlement(descendant, {
      id: 'descendant-turn', status: 'completed', error: null,
    });
    seam.queueChildTurnActivity(descendant, {
      id: 'descendant-turn', status: 'completed', error: null,
    });
    await expect(seam.terminalPipelines.get(descendantKey)!).rejects.toThrow('descendant ledger write failed');
    expect(seam.terminalSettlementReservations.get(descendantKey)?.retryTimer).not.toBeNull();

    seam.prepareChildTerminalSettlement(parent, {
      id: 'parent-turn', status: 'completed', error: null,
    });
    seam.queueChildTurnActivity(parent, {
      id: 'parent-turn', status: 'completed', error: null,
    });

    // The parent provider Turn is only an intermediate result while a direct
    // descendant still owns a terminal reservation. No parent terminal
    // pipeline is admitted until that descendant result is durable and
    // consumed by a continuation.
    expect(seam.terminalPipelines.has(parentKey)).toBe(false);
    expect(parentTerminalAttempts).toBe(0);
    expect(seam.terminalSettlementReservations.has(parentKey)).toBe(true);
    expect(ledger.pendingForParent(PARENT_ID)).toEqual([]);
    seam.beginClose();
    warning.mockRestore();
    database.close();
  });

  test('close prevents Agent resume and parent notification Turns during shutdown', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 1,
      parentThreadId: PARENT_ID,
      turnId: 'first-turn',
      toolUseId: 'first-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 1,
    });
    let privilegedStarts = 0;
    let notificationStarts = 0;
    const collaboration = new SubagentCollaboration(
      {} as never,
      {} as never,
      {} as never,
      {
        requireActiveTurn: () => undefined,
        startPrivilegedTurn: async () => { privilegedStarts += 1; },
        tryStartTurnIfIdle: async () => {
          notificationStarts += 1;
          return true;
        },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;

    seam.beginClose();
    const resume = await collaboration.sendAgentMessage(
      PARENT_ID,
      'parent-turn',
      'message-item',
      FIRST_AGENT_ID,
      'Resume this Agent',
      'Resume',
    );
    await seam.deliverParentWork(PARENT_ID);

    expect(resume).toEqual({ success: false, message: 'Agent service is shutting down.' });
    expect(privilegedStarts).toBe(0);
    expect(notificationStarts).toBe(0);
    expect(ledger.pendingForParent(PARENT_ID)).toHaveLength(1);
    database.close();
  });

  test('rolls back an Agent parent continuation when notification admission throws', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, PARENT_ID, 'parent-turn', 'parent-tool', 'root-thread');
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 1,
      parentThreadId: PARENT_ID,
      turnId: 'first-turn',
      toolUseId: 'first-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 1,
    });
    const childTurn = terminalTurn('first-turn');
    let admissionAttempts = 0;
    const acceptedTurnIds: string[] = [];
    const collaboration = new SubagentCollaboration(
      {
        readTurn: (threadId: string, turnId: string) => (
          threadId === FIRST_AGENT_ID && turnId === childTurn.id ? childTurn : null
        ),
        requireThread: (threadId: string) => ({
          thread: {
            id: threadId,
            parentThreadId: threadId === FIRST_AGENT_ID ? PARENT_ID : 'root-thread',
            source: 'collaboration',
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {
        hasActiveTurn: () => false,
        readTurnByClientUserMessageIdForHost: () => null,
        tryStartTurnIfIdle: async (request: { readonly turnId?: string }) => {
          admissionAttempts += 1;
          if (admissionAttempts === 1) throw new Error('notification admission failed');
          acceptedTurnIds.push(request.turnId ?? 'missing');
          return childTurn;
        },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100 + admissionAttempts,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { pathForReader: async () => null } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;
    const before = ledger.generationSnapshot(PARENT_ID);
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    await seam.deliverParentWork(PARENT_ID);
    expect(ledger.generationSnapshot(PARENT_ID)).toEqual(before);
    expect(ledger.notificationState(FIRST_AGENT_ID, 1)).toBe('pending');

    await seam.deliverParentWork(PARENT_ID);
    expect(admissionAttempts).toBe(2);
    expect(acceptedTurnIds).toHaveLength(1);
    expect(ledger.require(PARENT_ID).currentTurnId).toBe(acceptedTurnIds[0]!);
    expect(ledger.notificationState(FIRST_AGENT_ID, 1)).toBe('delivered');
    warning.mockRestore();
    database.close();
  });

  test('continues delivering sibling notifications after one child record is unreadable', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'missing-turn', 'first-tool');
    createBackgroundExecution(ledger, SECOND_AGENT_ID, 'second-turn', 'second-tool');
    for (const [agentId, turnId, toolUseId, createdAt] of [
      [FIRST_AGENT_ID, 'missing-turn', 'first-tool', 1],
      [SECOND_AGENT_ID, 'second-turn', 'second-tool', 2],
    ] as const) {
      ledger.recordTerminal({
        agentId,
        generation: 1,
        parentThreadId: PARENT_ID,
        turnId,
        toolUseId,
        status: 'finished',
        stopProvenance: 'none',
        error: null,
        tokensUsed: 0,
        settlementCoverage: null,
        createdAt,
      });
    }
    const secondTurn = terminalTurn('second-turn');
    const started: string[] = [];
    const collaboration = new SubagentCollaboration(
      {
        readTurn: (threadId: string) => threadId === SECOND_AGENT_ID ? secondTurn : null,
        requireThread: (threadId: string) => ({
          thread: {
            id: threadId,
            parentThreadId: threadId === PARENT_ID ? null : PARENT_ID,
            source: threadId === PARENT_ID ? 'app' : 'collaboration',
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {
        hasActiveTurn: () => false,
        readTurnByClientUserMessageIdForHost: () => null,
        tryStartTurnIfIdle: async (request: { readonly clientUserMessageId?: string }) => {
          started.push(request.clientUserMessageId ?? '');
          return secondTurn;
        },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { pathForReader: async () => null } as never,
    );
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    await (collaboration as unknown as TerminalSettlementSeam).deliverParentWork(PARENT_ID);

    expect(ledger.notificationState(FIRST_AGENT_ID, 1)).toBe('pending');
    expect(ledger.notificationState(SECOND_AGENT_ID, 1)).toBe('delivered');
    expect(started).toEqual([`task-notification:${SECOND_AGENT_ID}:1`]);
    warning.mockRestore();
    database.close();
  });

  test('continues delivering sibling notifications after one sender is quarantined', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    createBackgroundExecution(ledger, SECOND_AGENT_ID, 'second-turn', 'second-tool');
    for (const [agentId, turnId, toolUseId, createdAt] of [
      [FIRST_AGENT_ID, 'first-turn', 'first-tool', 1],
      [SECOND_AGENT_ID, 'second-turn', 'second-tool', 2],
    ] as const) {
      ledger.recordTerminal({
        agentId,
        generation: 1,
        parentThreadId: PARENT_ID,
        turnId,
        toolUseId,
        status: 'finished',
        stopProvenance: 'none',
        error: null,
        tokensUsed: 0,
        settlementCoverage: null,
        createdAt,
      });
    }
    const turns = new Map([
      [FIRST_AGENT_ID, terminalTurn('first-turn')],
      [SECOND_AGENT_ID, terminalTurn('second-turn')],
    ]);
    const started: string[] = [];
    const availabilityChecks: string[] = [];
    const collaboration = new SubagentCollaboration(
      {
        readTurn: (threadId: string) => turns.get(threadId) ?? null,
        requireThread: (threadId: string) => ({
          thread: {
            id: threadId,
            parentThreadId: threadId === PARENT_ID ? null : PARENT_ID,
            source: threadId === PARENT_ID ? 'app' : 'collaboration',
          },
        }),
      } as never,
      {} as never,
      {} as never,
      {
        hasActiveTurn: () => false,
        readTurnByClientUserMessageIdForHost: () => null,
        tryStartTurnIfIdle: async (request: { readonly clientUserMessageId?: string }) => {
          started.push(request.clientUserMessageId ?? '');
          return turns.get(SECOND_AGENT_ID)!;
        },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      (threadId) => {
        availabilityChecks.push(threadId);
        if (threadId === FIRST_AGENT_ID) throw new Error('Thread is quarantined');
      },
      (message) => new Error(message),
      { pathForReader: async () => null } as never,
    );

    await (collaboration as unknown as TerminalSettlementSeam).deliverParentWork(PARENT_ID);

    expect(availabilityChecks).toContain(FIRST_AGENT_ID);
    expect(availabilityChecks).toContain(SECOND_AGENT_ID);
    expect(ledger.notificationState(FIRST_AGENT_ID, 1)).toBe('pending');
    expect(ledger.notificationState(SECOND_AGENT_ID, 1)).toBe('delivered');
    expect(started).toEqual([`task-notification:${SECOND_AGENT_ID}:1`]);
    database.close();
  });

  test('reuses a committed notification Turn after recovery without advancing the parent ledger', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, PARENT_ID, 'notification-turn', 'parent-tool', 'root-thread');
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 1,
      parentThreadId: PARENT_ID,
      turnId: 'first-turn',
      toolUseId: 'first-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 1,
    });
    const childTurn = terminalTurn('first-turn');
    const committedTurn = terminalTurn('notification-turn');
    let admissionAttempts = 0;
    const collaboration = new SubagentCollaboration(
      {
        readTurn: (threadId: string, turnId: string) => (
          threadId === FIRST_AGENT_ID && turnId === childTurn.id ? childTurn : null
        ),
      } as never,
      {} as never,
      {} as never,
      {
        hasActiveTurn: () => false,
        readTurnByClientUserMessageIdForHost: () => committedTurn,
        tryStartTurnIfIdle: async () => {
          admissionAttempts += 1;
          return committedTurn;
        },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { pathForReader: async () => null } as never,
    );
    const seam = collaboration as unknown as TerminalSettlementSeam;

    await seam.deliverParentWork(PARENT_ID);

    expect(admissionAttempts).toBe(0);
    expect(ledger.require(PARENT_ID).currentTurnId).toBe('notification-turn');
    expect(ledger.notificationState(FIRST_AGENT_ID, 1)).toBe('delivered');
    database.close();
  });

  test('keeps a parent blocked when an old notification belongs to a newly running generation', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, PARENT_ID, 'parent-turn', 'parent-tool', 'root-thread');
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    createBackgroundExecution(ledger, SECOND_AGENT_ID, 'second-turn', 'second-tool');
    ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 1,
      parentThreadId: PARENT_ID,
      turnId: 'first-turn',
      toolUseId: 'first-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 2,
    });
    ledger.recordTerminal({
      agentId: SECOND_AGENT_ID,
      generation: 1,
      parentThreadId: PARENT_ID,
      turnId: 'second-turn',
      toolUseId: 'second-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 1,
    });
    const previous = ledger.generationSnapshot(FIRST_AGENT_ID);
    ledger.beginNextGenerationIfCurrent({
      agentId: FIRST_AGENT_ID,
      expectedGeneration: previous.generation,
      expectedTurnId: previous.currentTurnId,
      turnId: 'first-turn-resumed',
      toolUseId: 'resume-tool',
      runMode: 'background',
      tokenBudget: null,
      previous,
      updatedAt: 3,
    });
    let parentStarts = 0;
    const collaboration = new SubagentCollaboration(
      { requireThread: () => ({ thread: {} }) } as never,
      {} as never,
      {} as never,
      {
        hasActiveTurn: (threadId: string) => threadId === FIRST_AGENT_ID,
        tryStartTurnIfIdle: async () => {
          parentStarts += 1;
          return terminalTurn('unexpected-parent-turn');
        },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );

    await (collaboration as unknown as TerminalSettlementSeam).deliverParentWork(PARENT_ID);

    expect(parentStarts).toBe(0);
    expect(ledger.pendingForParent(PARENT_ID).map(({ agentId, generation }) => (
      `${agentId}:${generation}`
    ))).toEqual([`${SECOND_AGENT_ID}:1`, `${FIRST_AGENT_ID}:1`]);
    database.close();
  });

  test('does not let a stale terminal pipeline write into a resumed generation', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    ledger.create({
      agentId: FIRST_AGENT_ID,
      parentThreadId: PARENT_ID,
      description: FIRST_AGENT_ID,
      agentType: 'general-purpose',
      runMode: 'background',
      currentTurnId: 'first-turn',
      toolUseId: 'first-tool',
      tokenBudget: null,
      worktree: null,
      toolPolicy: {
        kind: 'general-purpose',
        runInBackground: true,
        worktree: false,
        allowNesting: true,
        requestedTools: null,
      },
      startupContext: null,
      createdAt: 1,
      updatedAt: 1,
    });
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve; });
    const collaboration = new SubagentCollaboration(
      {} as never,
      {} as never,
      {} as never,
      { hasActiveTurn: () => false } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      { flushForTerminalSettlement: async () => flushGate } as never,
    );
    const turn = {
      id: 'first-turn',
      status: 'completed',
      error: null,
    } as never;
    const pipeline = (collaboration as unknown as {
      runTerminalPipeline(
        execution: ReturnType<SubagentExecutionLedger['require']>,
        turn: unknown,
      ): Promise<void>;
    }).runTerminalPipeline(ledger.require(FIRST_AGENT_ID), turn);

    // The old generation is still in account I/O when another Agent resumes it.
    await Promise.resolve();
    const resumed = ledger.beginNextGenerationIfCurrent({
      agentId: FIRST_AGENT_ID,
      expectedGeneration: 1,
      expectedTurnId: 'first-turn',
      turnId: 'second-turn',
      toolUseId: 'second-tool',
      runMode: 'background',
      tokenBudget: null,
      previous: ledger.generationSnapshot(FIRST_AGENT_ID),
      updatedAt: 2,
    });
    expect(resumed?.generation).toBe(2);
    releaseFlush();
    await pipeline;

    expect(ledger.pendingForParent(PARENT_ID)).toEqual([]);
    expect(ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 1,
      parentThreadId: PARENT_ID,
      turnId: 'first-turn',
      toolUseId: 'first-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 3,
    })).toBe(false);
    expect(ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 2,
      parentThreadId: PARENT_ID,
      turnId: 'second-turn',
      toolUseId: 'second-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 4,
    })).toBe(true);
    expect(ledger.pendingForParent(PARENT_ID).map((notification) => notification.generation)).toEqual([2]);
    database.close();
  });

  test('recovers a claimed current-generation parent message after restart', () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    enqueue(ledger, 'claimed-message', FIRST_AGENT_ID, 3, 'background');
    expect(ledger.claimParentMessage('claimed-message')).toBe(true);
    expect(ledger.pendingParentMessages(PARENT_ID)).toEqual([]);

    const recovered = new SubagentExecutionLedger(database);

    expect(recovered.pendingParentMessages(PARENT_ID)).toEqual([expect.objectContaining({
      id: 'claimed-message',
      senderAgentId: FIRST_AGENT_ID,
      generation: 3,
      deliveryMode: 'background',
      state: 'pending',
    })]);
    database.close();
  });

  test('sweeps only the orphaned envelope when one Agent also owns valid work', () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    expect(ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 1,
      parentThreadId: 'missing-parent',
      turnId: 'first-turn',
      toolUseId: 'first-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 1,
    })).toBe(true);
    const previous = ledger.generationSnapshot(FIRST_AGENT_ID);
    expect(ledger.beginNextGenerationIfCurrent({
      agentId: FIRST_AGENT_ID,
      expectedGeneration: previous.generation,
      expectedTurnId: previous.currentTurnId,
      turnId: 'second-turn',
      toolUseId: 'second-tool',
      runMode: 'background',
      tokenBudget: null,
      previous,
      updatedAt: 2,
    })).not.toBeNull();
    expect(ledger.completeGenerationAdmissionIfCurrent(FIRST_AGENT_ID, 2, 'second-turn')).toBe(true);
    expect(ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 2,
      parentThreadId: PARENT_ID,
      turnId: 'second-turn',
      toolUseId: 'second-tool',
      status: 'finished',
      stopProvenance: 'none',
      error: null,
      tokensUsed: 0,
      settlementCoverage: null,
      createdAt: 2,
    })).toBe(true);
    ledger.enqueueParentMessage({
      id: 'orphan-message',
      senderAgentId: FIRST_AGENT_ID,
      parentThreadId: 'missing-parent',
      generation: 2,
      content: 'orphan',
      deliveryMode: 'background',
      createdAt: 3,
    });
    enqueue(ledger, 'valid-message', FIRST_AGENT_ID, 2, 'background');

    expect(ledger.sweepOrphanEnvelopes(new Set([PARENT_ID, FIRST_AGENT_ID]))).toBe(2);

    expect(ledger.notificationState(FIRST_AGENT_ID, 1)).toBeNull();
    expect(ledger.notificationState(FIRST_AGENT_ID, 2)).toBe('pending');
    expect(ledger.pendingParentMessages(PARENT_ID).map((message) => message.id)).toEqual(['valid-message']);
    database.close();
  });

  test('rolls back an uncommitted Agent generation admission during startup recovery', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const previous = ledger.generationSnapshot(FIRST_AGENT_ID);
    const reserved = ledger.beginUserGenerationIfCurrent({
      agentId: FIRST_AGENT_ID,
      expectedGeneration: previous.generation,
      expectedTurnId: previous.currentTurnId,
      turnId: 'missing-turn',
      tokenBudget: null,
      previous,
      updatedAt: 2,
    });
    expect(reserved?.generation).toBe(2);
    const collaboration = recoveryCollaboration(ledger, () => null);

    await (collaboration as unknown as RecoverySeam).recoverPendingNotifications();

    expect(ledger.require(FIRST_AGENT_ID)).toMatchObject({
      generation: 1,
      currentTurnId: 'first-turn',
      toolUseId: 'first-tool',
    });
    expect(ledger.pendingGenerationAdmissions()).toEqual([]);
    database.close();
  });

  test('commits a recovered Agent generation when its reserved Turn exists', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const previous = ledger.generationSnapshot(FIRST_AGENT_ID);
    ledger.beginNextGenerationIfCurrent({
      agentId: FIRST_AGENT_ID,
      expectedGeneration: previous.generation,
      expectedTurnId: previous.currentTurnId,
      turnId: 'committed-turn',
      toolUseId: 'resume-tool',
      runMode: 'background',
      tokenBudget: null,
      previous,
      updatedAt: 2,
    });
    const committed = { id: 'committed-turn', status: 'inProgress' };
    const collaboration = recoveryCollaboration(
      ledger,
      (_agentId, turnId) => turnId === committed.id ? committed : null,
    );

    await (collaboration as unknown as RecoverySeam).recoverPendingNotifications();

    expect(ledger.require(FIRST_AGENT_ID)).toMatchObject({
      generation: 2,
      currentTurnId: 'committed-turn',
      toolUseId: 'resume-tool',
    });
    expect(ledger.pendingGenerationAdmissions()).toEqual([]);
    database.close();
  });

  test('skips an orphaned execution row while recovering healthy siblings', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'missing-turn', 'first-tool');
    createExecution(ledger, SECOND_AGENT_ID, 'second-turn', 'second-tool');
    const orphanTurn = terminalTurn('missing-turn');
    const healthyTurn = terminalTurn('second-turn');
    const delivered: string[] = [];
    const collaboration = new SubagentCollaboration(
      {
        readTurn: (threadId: string) => threadId === FIRST_AGENT_ID
          ? orphanTurn
          : threadId === SECOND_AGENT_ID
            ? healthyTurn
            : null,
        requireThread: (threadId: string) => {
          if (threadId === FIRST_AGENT_ID) throw new Error('Thread not found');
          return {
            thread: {
              id: threadId,
              parentThreadId: threadId === PARENT_ID ? null : PARENT_ID,
              source: threadId === PARENT_ID ? 'app' : 'collaboration',
            },
          };
        },
      } as never,
      {} as never,
      {} as never,
      { hasActiveTurn: () => false, activeTurnId: () => null } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {
        flushForTerminalSettlement: async (threadId: string) => { delivered.push(threadId); },
        pathForReader: async () => null,
      } as never,
    );
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);

    await (collaboration as unknown as RecoverySeam).recoverPendingNotifications();

    expect(delivered).toContain(SECOND_AGENT_ID);
    expect(warning.mock.calls.some((call) => String(call[0]).includes(FIRST_AGENT_ID))).toBe(true);
    warning.mockRestore();
    database.close();
  });

  test('does not apply a Stop from an older Agent generation', () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    const stopped = ledger.generationSnapshot(FIRST_AGENT_ID);
    ledger.beginNextGenerationIfCurrent({
      agentId: FIRST_AGENT_ID,
      expectedGeneration: stopped.generation,
      expectedTurnId: stopped.currentTurnId,
      turnId: 'second-turn',
      toolUseId: 'resume-tool',
      runMode: 'background',
      tokenBudget: null,
      previous: stopped,
      updatedAt: 2,
    });

    expect(ledger.recordStopIfCurrent({
      agentId: FIRST_AGENT_ID,
      generation: stopped.generation,
      turnId: stopped.currentTurnId,
      provenance: 'user',
      updatedAt: 3,
    })).toBeNull();
    expect(ledger.require(FIRST_AGENT_ID)).toMatchObject({
      generation: 2,
      currentTurnId: 'second-turn',
      stopProvenance: 'none',
    });
    database.close();
  });

  test('drains only the completing sender generation', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    createExecution(ledger, SECOND_AGENT_ID, 'second-turn', 'second-tool');
    const activeAgents = new Set<string>();
    const deliveredIds: string[] = [];
    let parentActive = true;
    const turnLifecycle = {
      hasActiveTurn: (threadId: string) => activeAgents.has(threadId),
      activeTurnId: (threadId: string) => threadId === PARENT_ID && parentActive ? 'parent-turn' : null,
      isActiveTurnFinishing: () => false,
      steerTurn: async (request: { readonly clientUserMessageId?: string }) => {
        deliveredIds.push(request.clientUserMessageId ?? '');
      },
    };
    const collaboration = new SubagentCollaboration(
      {} as never,
      {} as never,
      {} as never,
      turnLifecycle as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );
    const delivery = collaboration as unknown as DeliverySeam;

    enqueue(ledger, 'first-generation-1', FIRST_AGENT_ID, 1, 'foreground');
    enqueue(ledger, 'first-generation-2', FIRST_AGENT_ID, 2, 'foreground');
    enqueue(ledger, 'second-generation-1', SECOND_AGENT_ID, 1, 'foreground');
    enqueue(ledger, 'background-message', SECOND_AGENT_ID, 1, 'background');

    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: FIRST_AGENT_ID,
      generation: 1,
    });

    expect(deliveredIds).toEqual(['first-generation-1']);
    expect(ledger.pendingParentMessages(PARENT_ID).map((message) => message.id)).toEqual([
      'background-message',
      'second-generation-1',
      'first-generation-2',
    ]);

    activeAgents.add(SECOND_AGENT_ID);
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: SECOND_AGENT_ID,
      generation: 1,
    });
    expect(deliveredIds).toEqual(['first-generation-1']);

    activeAgents.delete(SECOND_AGENT_ID);
    enqueue(ledger, 'first-generation-1-after-resume', FIRST_AGENT_ID, 1, 'foreground');
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: SECOND_AGENT_ID,
      generation: 1,
    });
    const firstExecution = ledger.require(FIRST_AGENT_ID);
    ledger.beginNextGenerationIfCurrent({
      agentId: FIRST_AGENT_ID,
      expectedGeneration: firstExecution.generation,
      expectedTurnId: firstExecution.currentTurnId,
      turnId: 'first-turn-2',
      toolUseId: 'first-tool-2',
      runMode: 'foreground',
      tokenBudget: null,
      previous: ledger.generationSnapshot(FIRST_AGENT_ID),
      updatedAt: 2,
    });
    activeAgents.add(FIRST_AGENT_ID);
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: FIRST_AGENT_ID,
      generation: 1,
    });
    expect(deliveredIds).toEqual([
      'first-generation-1',
      'second-generation-1',
      'first-generation-1-after-resume',
    ]);
    activeAgents.delete(FIRST_AGENT_ID);
    parentActive = false;
    await delivery.deliverParentMessages(PARENT_ID, {
      senderAgentId: FIRST_AGENT_ID,
      generation: 2,
    });
    expect(deliveredIds).toEqual([
      'first-generation-1',
      'second-generation-1',
      'first-generation-1-after-resume',
    ]);
    parentActive = true;
    await delivery.deliverParentMessages(PARENT_ID);

    expect(deliveredIds).toEqual([
      'first-generation-1',
      'second-generation-1',
      'first-generation-1-after-resume',
      'background-message',
    ]);
    // A foreground envelope is bound to the invoking parent Turn. Once that
    // Turn has settled, it is discarded rather than replayed into a later
    // unsolicited root admission.
    expect(ledger.pendingParentMessages(PARENT_ID).map((message) => message.id)).toEqual([]);

    database.close();
  });

  test('continues delivering sibling parent messages after one sender is quarantined', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    createBackgroundExecution(ledger, SECOND_AGENT_ID, 'second-turn', 'second-tool');
    enqueue(ledger, 'a-quarantined-message', FIRST_AGENT_ID, 1, 'background');
    enqueue(ledger, 'b-healthy-message', SECOND_AGENT_ID, 1, 'background');
    const delivered: string[] = [];
    const availabilityChecks: string[] = [];
    const collaboration = new SubagentCollaboration(
      {} as never,
      {} as never,
      {} as never,
      {
        hasActiveTurn: () => false,
        activeTurnId: (threadId: string) => threadId === PARENT_ID ? 'parent-turn' : null,
        isActiveTurnFinishing: () => false,
        steerTurn: async (request: { readonly clientUserMessageId?: string }) => {
          delivered.push(request.clientUserMessageId ?? '');
        },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      (threadId) => {
        availabilityChecks.push(threadId);
        if (threadId === FIRST_AGENT_ID) throw new Error('Thread is quarantined');
      },
      (message) => new Error(message),
      {} as never,
    );

    await (collaboration as unknown as DeliverySeam).deliverParentMessages(PARENT_ID);

    expect(availabilityChecks).toEqual([PARENT_ID, FIRST_AGENT_ID, SECOND_AGENT_ID]);
    expect(delivered).toEqual(['b-healthy-message']);
    expect(ledger.pendingParentMessages(PARENT_ID).map((message) => message.id)).toEqual([
      'a-quarantined-message',
    ]);
    database.close();
  });

  test('delivers a nested foreground main message after its sender settles while root is idle', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'parent-turn', 'parent-tool');
    createExecution(ledger, SECOND_AGENT_ID, 'nested-turn', 'nested-tool', FIRST_AGENT_ID);
    const activeAgents = new Set<string>([FIRST_AGENT_ID, SECOND_AGENT_ID]);
    const started: Array<{
      readonly threadId: string;
      readonly input: readonly { readonly type: string; readonly text: string }[];
      readonly additionalContext?: import('../../src/core/agent/protocol').AdditionalContext;
      readonly additionalContextSource?: string;
      readonly clientUserMessageId?: string;
    }> = [];
    const collaboration = new SubagentCollaboration(
      {
        requireThread: (threadId: string) => ({
          thread: threadId === PARENT_ID
            ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
            : threadId === FIRST_AGENT_ID
              ? { id: FIRST_AGENT_ID, parentThreadId: PARENT_ID, source: 'collaboration' }
              : { id: SECOND_AGENT_ID, parentThreadId: FIRST_AGENT_ID, source: 'collaboration' },
        }),
      } as never,
      {} as never,
      {} as never,
      {
        hasActiveTurn: (threadId: string) => activeAgents.has(threadId),
        activeTurnId: () => null,
        tryStartTurnIfIdle: async (request: typeof started[number]) => {
          started.push(request);
          return true;
        },
      } as never,
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );
    const seam = collaboration as unknown as MainMessageSeam;

    await expect(seam.sendAgentMessageToMain(SECOND_AGENT_ID, 'Nested result is ready.')).resolves.toEqual({
      success: true,
      message: "Message queued for the main conversation's next turn.",
    });
    const queued = ledger.pendingParentMessages(PARENT_ID);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.deliveryMode).toBe('background');
    expect(queued[0]?.content).toBe('Nested result is ready.');

    await seam.deliverParentMessages(PARENT_ID);
    expect(started).toEqual([]);
    expect(ledger.pendingParentMessages(PARENT_ID)).toHaveLength(1);

    activeAgents.delete(SECOND_AGENT_ID);
    await seam.deliverParentMessages(PARENT_ID, {
      senderAgentId: SECOND_AGENT_ID,
      generation: 1,
    });

    expect(started).toHaveLength(1);
    expect(started[0]?.threadId).toBe(PARENT_ID);
    expect(started[0]?.input).toEqual([]);
    expect(started[0]?.additionalContextSource).toBe(`subagent:${SECOND_AGENT_ID}`);
    expect(started[0]?.additionalContext?.['subagent.peer-message']).toEqual({
      kind: 'untrusted',
      purpose: 'observation',
      value: 'Nested result is ready.',
    });
    expect(started[0]?.additionalContext?.['subagent.peer-message-handling']).toMatchObject({
      kind: 'application',
      purpose: 'instruction',
    });
    expect(started[0]?.clientUserMessageId).toBe(queued[0]?.id);
    expect(ledger.pendingParentMessages(PARENT_ID)).toEqual([]);
    database.close();
  });

  test('discards foreground envelopes during recovery and preserves background work', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createExecution(ledger, FIRST_AGENT_ID, 'first-turn', 'first-tool');
    enqueue(ledger, 'stale-foreground', FIRST_AGENT_ID, 1, 'foreground');
    enqueue(ledger, 'recoverable-background', FIRST_AGENT_ID, 1, 'background');

    const collaboration = new SubagentCollaboration(
      {} as never,
      {} as never,
      {} as never,
      // Recovery may start a background parent continuation before the sweep;
      // that new Turn is never the foreground envelope's invoking Turn.
      { hasActiveTurn: () => true } as never,
      subagentRequestLedgerStub() as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
      () => undefined,
      (message) => new Error(message),
      {} as never,
    );
    const recovery = collaboration as unknown as RecoverySeam;
    const warning = spyOn(console, 'warn').mockImplementation(() => undefined);
    await recovery.discardStaleForegroundParentMessages();
    const warningCalls = warning.mock.calls.map((call) => [...call]);
    warning.mockRestore();

    expect(ledger.pendingParentMessages(PARENT_ID).map((message) => message.id)).toEqual([
      'recoverable-background',
    ]);
    expect(warningCalls).toEqual([
      [expect.stringContaining(FIRST_AGENT_ID)],
    ]);
    database.close();
  });
});

function foregroundSettlementFixture() {
  const database = new Database(':memory:') as unknown as SqliteDatabase;
  const ledger = new SubagentExecutionLedger(database);
  const role = {
    name: 'default',
    source: 'builtIn',
    description: 'General-purpose Agent.',
    developerInstructions: 'Complete the delegated task.',
  } as const;
  const configuration = {
    profileName: 'default',
    developerInstructions: [],
    model: 'test-model',
    reasoningEffort: 'medium',
    tools: [],
    skills: [],
    preloadedSkills: [],
    plugins: [],
    mcpServers: [],
  } as const;
  const parent = {
    id: PARENT_ID,
    sessionId: 'session',
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: 'Parent',
    preview: '',
    ephemeral: true,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    historyMode: 'full',
  } as const;
  const spawnItem = {
    type: 'collabAgentToolCall',
    id: 'agent-tool',
    tool: 'agent',
    status: 'inProgress',
  } as const;
  const threads = new Map<string, unknown>([[PARENT_ID, parent]]);
  const terminalTurns = new Map<string, ReturnType<typeof terminalTurn>>();
  const activeThreadIds = new Set<string>([PARENT_ID]);
  const idleWaiters = new Map<string, Set<() => void>>();
  let resolveChildSpawned!: (value: {
    readonly id: string;
    readonly turnId: string;
    readonly thread: ReturnType<typeof delegatedFixtureThread>;
  }) => void;
  const childSpawned = new Promise<{
    readonly id: string;
    readonly turnId: string;
    readonly thread: ReturnType<typeof delegatedFixtureThread>;
  }>((resolve) => { resolveChildSpawned = resolve; });

  const setActive = (threadId: string, active: boolean): void => {
    if (active) {
      activeThreadIds.add(threadId);
      return;
    }
    activeThreadIds.delete(threadId);
    for (const resolve of idleWaiters.get(threadId) ?? []) resolve();
    idleWaiters.delete(threadId);
  };

  const collaboration = new SubagentCollaboration(
    {
      requireThread: (threadId: string) => {
        const thread = threads.get(threadId);
        if (!thread) throw new Error(`Thread not found: ${threadId}`);
        return { thread, configuration };
      },
      readTurn: (threadId: string, turnId: string) => {
        if (threadId === PARENT_ID && turnId === 'parent-turn') {
          return { id: turnId, items: [spawnItem] };
        }
        return terminalTurns.get(`${threadId}:${turnId}`) ?? null;
      },
      metadata: {
        spawnEdgeForChild: (threadId: string) => (
          threadId === PARENT_ID ? null : { taskPath: `/root/${threadId}` }
        ),
        childEdges: () => [],
      },
    } as never,
    {} as never,
    {} as never,
    {
      requireActiveTurn: (threadId: string) => {
        if (!activeThreadIds.has(threadId)) throw new Error('Parent Turn is no longer active');
      },
      activeTurnId: (threadId: string) => (
        activeThreadIds.has(threadId) ? `${threadId}-active-turn` : null
      ),
      isActiveTurnFinishing: () => false,
      hasActiveTurn: (threadId: string) => activeThreadIds.has(threadId),
      waitForIdle: async (threadId: string) => {
        if (!activeThreadIds.has(threadId)) return;
        await new Promise<void>((resolve) => {
          const waiters = idleWaiters.get(threadId) ?? new Set<() => void>();
          waiters.add(resolve);
          idleWaiters.set(threadId, waiters);
        });
      },
      interruptTurn: async (threadId: string) => { setActive(threadId, false); },
    } as never,
    subagentRequestLedgerStub() as never,
    ledger,
    () => role,
    () => ({ canonicalType: 'general-purpose', role, kind: 'general-purpose' }),
    async () => null,
    async () => ({ maxDepth: 3, maxConcurrent: 20 }),
    async () => null,
    undefined,
    undefined,
    undefined,
    () => 100,
    ((value: unknown) => value) as never,
    () => undefined,
    (message) => new Error(message),
    {
      flushForTerminalSettlement: async () => undefined,
      forgetCursor: () => undefined,
      pathForReader: async (threadId: string) => `/tmp/${threadId}.jsonl`,
    } as never,
  );
  collaboration.spawnChild = async (input) => {
    if (!input.id || !input.turnId) throw new Error('Fixture requires explicit child identities');
    const thread = delegatedFixtureThread(input.id, input.parentThreadId);
    threads.set(input.id, thread);
    createExecution(ledger, input.id, input.turnId, input.parentItemId, input.parentThreadId);
    setActive(input.id, true);
    resolveChildSpawned({ id: input.id, turnId: input.turnId, thread });
    return { thread, turn: { id: input.turnId }, taskPath: input.taskPath } as never;
  };
  const seam = collaboration as unknown as TerminalSettlementSeam;

  return {
    childSpawned,
    collaboration,
    ledger,
    seam,
    spawn: (signal?: AbortSignal) => collaboration.spawnAgent({
      senderThreadId: PARENT_ID,
      senderTurnId: 'parent-turn',
      parentItemId: 'agent-tool',
      description: 'Coordinate descendants',
      prompt: 'Coordinate descendants',
      agentType: 'general-purpose',
      runInBackground: false,
      isolation: null,
      ...(signal === undefined ? {} : { signal }),
    }),
    addBackgroundChild: (parentThreadId: string, agentId: string, turnId: string) => {
      const thread = delegatedFixtureThread(agentId, parentThreadId);
      threads.set(agentId, thread);
      createBackgroundExecution(ledger, agentId, turnId, `${agentId}-tool`, parentThreadId);
      setActive(agentId, true);
      return thread;
    },
    setActive,
    setTerminalTurn: (threadId: string, turn: ReturnType<typeof terminalTurn>) => {
      terminalTurns.set(`${threadId}:${turn.id}`, turn);
    },
    close: () => {
      seam.beginClose();
      database.close();
    },
  };
}

function delegatedFixtureThread(id: string, parentThreadId: string) {
  return {
    id,
    sessionId: 'session',
    parentThreadId,
    forkedFromId: null,
    agentNickname: null,
    agentRole: 'default',
    name: id,
    preview: '',
    ephemeral: true,
    source: 'collaboration',
    threadSource: 'subagent',
    modelProvider: 'openai',
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    historyMode: 'full',
  } as const;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SpawnAdmissionCollaborationOptions {
  readonly requireActiveTurn?: () => void;
  readonly runTreeMutex?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly resolveAgentStartupContext?: () => Promise<unknown>;
  readonly planAgentWorktree?: () => Promise<AgentWorktreeRecoveryIntent>;
  readonly prepareAgentWorktree?: () => Promise<{
    readonly cwd: string;
    readonly worktree: AgentWorktreeMetadata;
  }>;
  readonly settleAgentWorktree?: (worktree: AgentWorktreeMetadata) => Promise<{
    readonly worktree: AgentWorktreeMetadata;
    readonly retained: boolean;
  }>;
  readonly createThread: () => Promise<unknown>;
  readonly spawnItem?: unknown;
}

function spawnAdmissionCollaboration(
  options: SpawnAdmissionCollaborationOptions,
): SubagentCollaboration {
  const role = {
    name: 'default',
    source: 'builtIn',
    description: 'General-purpose Agent.',
    developerInstructions: 'Complete the delegated task.',
  } as const;
  const parent = {
    id: PARENT_ID,
    sessionId: 'session',
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: 'Parent',
    preview: '',
    ephemeral: true,
    source: 'app',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    historyMode: 'full',
  } as const;
  const configuration = {
    profileName: 'default',
    developerInstructions: [],
    model: 'test-model',
    reasoningEffort: 'medium',
    tools: [],
    skills: [],
    preloadedSkills: [],
    plugins: [],
    mcpServers: [],
  } as const;
  const spawnItem = {
    type: 'collabAgentToolCall',
    id: 'agent-tool',
    tool: 'agent',
    status: 'inProgress',
  } as const;

  return new SubagentCollaboration(
    {
      requireThread: () => ({ thread: parent, configuration }),
      readTurn: (_threadId: string, turnId: string) => (
        turnId === 'parent-turn' ? { id: turnId, items: [options.spawnItem ?? spawnItem] } : null
      ),
      metadata: {
        childEdges: () => [],
        spawnEdgeForChild: () => null,
        read: () => null,
      },
      ephemeral: new Map(),
      rollout: { read: async () => [] },
      stoppingThreads: new Set(),
      threadTreeMutex: {
        run: options.runTreeMutex ?? (async (operation) => operation()),
      },
    } as never,
    {} as never,
    {
      createThread: options.createThread,
      deleteThread: async () => undefined,
    } as never,
    {
      requireActiveTurn: options.requireActiveTurn ?? (() => undefined),
      assertSubagentRequestOpen: () => undefined,
      assertSubagentSpawnBudgetAvailable: () => null,
    } as never,
    {
      deleteChild: () => false,
      deleteRequestIfEmpty: () => false,
    } as never,
    {
      read: () => null,
      beginInitialAdmission: () => undefined,
      recordInitialWorktreeIfPending: () => true,
      deleteAgentOnly: () => undefined,
    } as never,
    () => role,
    () => ({ canonicalType: 'general-purpose', role, kind: 'general-purpose' }),
    async () => null,
    async () => ({ maxDepth: 3, maxConcurrent: 20 }),
    (options.resolveAgentStartupContext ?? (async () => null)) as never,
    options.planAgentWorktree,
    options.prepareAgentWorktree,
    options.settleAgentWorktree,
    () => 100,
    ((value: unknown) => value) as never,
    (message) => new Error(message),
    {} as never,
  );
}

function agentWorktree(path: string): AgentWorktreeMetadata {
  return {
    sourceCwd: '/repo',
    path,
    branch: `tenon-agent-${path.split('/').at(-1)}`,
    baseCommit: 'abc123',
    gitCommonDir: '/repo/.git',
    gitWorktreeDir: `/repo/.git/worktrees/${path.split('/').at(-1)}`,
    managed: true,
    removedAt: null,
  };
}

function agentWorktreeIntent(path: string): AgentWorktreeRecoveryIntent {
  return {
    sourceCwd: '/repo',
    path,
    branch: `tenon-agent-${path.split('/').at(-1)}`,
    baseCommit: 'abc123',
    gitCommonDir: '/repo/.git',
  };
}

function enqueue(
  ledger: SubagentExecutionLedger,
  id: string,
  senderAgentId: string,
  generation: number,
  deliveryMode: 'foreground' | 'background',
): void {
  ledger.enqueueParentMessage({
    id,
    senderAgentId,
    parentThreadId: PARENT_ID,
    generation,
    content: id,
    deliveryMode,
    createdAt: generation,
  });
}

function createExecution(
  ledger: SubagentExecutionLedger,
  agentId: string,
  turnId: string,
  toolUseId: string,
  parentThreadId = PARENT_ID,
  policy: Partial<{
    readonly kind: 'general-purpose' | 'explore' | 'plan' | 'role';
    readonly runInBackground: boolean;
    readonly worktree: boolean;
    readonly allowNesting: boolean;
    readonly requestedTools: readonly string[] | null;
  }> = {},
): void {
  ledger.create({
    agentId,
    parentThreadId,
    description: agentId,
      agentType: 'general-purpose',
      runMode: 'foreground',
      currentTurnId: turnId,
      toolUseId,
      tokenBudget: null,
      worktree: null,
    toolPolicy: {
      kind: 'general-purpose',
      runInBackground: false,
      worktree: false,
      allowNesting: true,
      requestedTools: null,
      ...policy,
    },
    startupContext: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

function createPendingExecution(
  ledger: SubagentExecutionLedger,
  agentId: string,
  turnId: string,
  toolUseId: string,
  parentThreadId = PARENT_ID,
): void {
  ledger.beginInitialAdmission({
    agentId,
    parentThreadId,
    description: agentId,
    agentType: 'general-purpose',
    runMode: 'foreground',
    currentTurnId: turnId,
    toolUseId,
    tokenBudget: null,
    worktree: null,
    toolPolicy: {
      kind: 'general-purpose',
      runInBackground: false,
      worktree: false,
      allowNesting: true,
      requestedTools: null,
    },
    startupContext: null,
    initialWorktreeIntent: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

function createBackgroundExecution(
  ledger: SubagentExecutionLedger,
  agentId: string,
  turnId: string,
  toolUseId: string,
  parentThreadId = PARENT_ID,
  worktree: AgentWorktreeMetadata | null = null,
): void {
  ledger.create({
    agentId,
    parentThreadId,
    description: agentId,
    agentType: 'general-purpose',
    runMode: 'background',
    currentTurnId: turnId,
    toolUseId,
    tokenBudget: null,
    worktree,
    toolPolicy: {
      kind: 'general-purpose',
      runInBackground: true,
      worktree: false,
      allowNesting: true,
      requestedTools: null,
    },
    startupContext: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

function recoveryCollaboration(
  ledger: SubagentExecutionLedger,
  readTurn: (agentId: string, turnId: string) => unknown,
): SubagentCollaboration {
  return new SubagentCollaboration(
    {
      readTurn,
      requireThread: (threadId: string) => ({
        thread: threadId === PARENT_ID
          ? { id: PARENT_ID, parentThreadId: null, source: 'app' }
          : { id: threadId, parentThreadId: PARENT_ID, source: 'collaboration' },
      }),
    } as never,
    {} as never,
    {} as never,
    { hasActiveTurn: () => false, activeTurnId: () => null } as never,
    subagentRequestLedgerStub() as never,
    ledger,
    (() => { throw new Error('unused'); }) as never,
    (() => { throw new Error('unused'); }) as never,
    async () => null,
    async () => ({ maxDepth: 3, maxConcurrent: 20 }),
    async () => null,
      undefined,
    undefined,
    undefined,
    () => 100,
    ((configuration: unknown) => configuration) as never,
    () => undefined,
    (message) => new Error(message),
    {} as never,
  );
}

function terminalTurn(id: string) {
  return {
    id,
    items: [],
    itemsView: 'full',
    provenance: {
      originThreadId: FIRST_AGENT_ID,
      originTurnId: id,
      trigger: { kind: 'subagent', parentThreadId: PARENT_ID, parentItemId: 'first-tool' },
    },
    status: 'completed',
    error: null,
    execution: {
      model: 'test-model',
      reasoningEffort: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
      contextWindow: 1,
      maxOutputTokens: 1,
    },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  } as const;
}

function serializedConsoleCalls(calls: readonly (readonly unknown[])[]): string {
  return calls.map((call) => call.map((value) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }).join(' ')).join('\n');
}
