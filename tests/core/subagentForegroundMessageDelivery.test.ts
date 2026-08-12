import { describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SubagentExecutionLedger } from '../../src/main/agent/persistence/SubagentExecutionLedger';
import type { SqliteDatabase } from '../../src/main/agent/persistence/sqlite';
import { SubagentCollaboration } from '../../src/main/agent/thread/SubagentCollaboration';
import type { AgentWorktreeMetadata } from '../../src/main/agent/worktree/AgentWorktree';

const PARENT_ID = 'parent-thread';
const FIRST_AGENT_ID = 'first-agent';
const SECOND_AGENT_ID = 'second-agent';

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
    readonly retryTimer: ReturnType<typeof setTimeout> | null;
  }>;
}

interface TerminalSettlementSeam extends AdmissionSeam {
  beginClose(): void;
  drainForClose(): Promise<void>;
  deliverParentWork(parentThreadId: string): Promise<void>;
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
      const collaboration = spawnAdmissionCollaboration({
        requireActiveTurn: () => {
          if (!parentActive) throw new Error('Parent Turn is no longer active');
        },
        runTreeMutex: async (operation) => {
          parentActive = false;
          return operation();
        },
        prepareAgentWorktree: async () => ({ cwd: worktree.path, worktree }),
        settleAgentWorktree: async (prepared) => {
          settled.push(prepared);
          return { worktree: prepared, retained: false };
        },
        createThread: async () => {
          createThreadCalls += 1;
          throw new Error('Thread creation must not start');
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
      (message) => new Error(message),
      {} as never,
    );
    const seam = collaboration as unknown as AdmissionSeam;
    seam.terminalPipelines.set(`${FIRST_AGENT_ID}:1`, Promise.resolve());

    await expect(seam.assertNewAgentAdmission(PARENT_ID)).rejects.toThrow(
      'Concurrent subagent limit reached. You can run 1 subagents at once.',
    );
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      async (_worktree, options) => {
        cleanupAttempts += 1;
        await options?.beforeCleanRemoval?.();
        throw new Error('permanent worktree cleanup failure');
      },
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      async () => ({ worktree, retained: true }),
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
    await seam.drainForClose();
    await seam.drainForClose();

    expect(recordAttempts).toBe(2);
    expect(seam.terminalSettlementReservations.has(key)).toBe(true);
    expect(seam.terminalSettlementReservations.get(key)?.retryTimer).toBeNull();
    expect(ledger.pendingForParent(PARENT_ID)).toEqual([]);
    warning.mockRestore();
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      status: 'completed',
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      status: 'completed',
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
      () => 100 + admissionAttempts,
      ((configuration: unknown) => configuration) as never,
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
      status: 'completed',
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      status: 'completed',
      createdAt: 2,
    });
    ledger.recordTerminal({
      agentId: SECOND_AGENT_ID,
      generation: 1,
      parentThreadId: PARENT_ID,
      turnId: 'second-turn',
      toolUseId: 'second-tool',
      status: 'completed',
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
      status: 'completed',
      createdAt: 3,
    })).toBe(false);
    expect(ledger.recordTerminal({
      agentId: FIRST_AGENT_ID,
      generation: 2,
      parentThreadId: PARENT_ID,
      turnId: 'second-turn',
      toolUseId: 'second-tool',
      status: 'completed',
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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

  test('delivers a nested foreground main message after its sender settles while root is idle', async () => {
    const database = new Database(':memory:') as unknown as SqliteDatabase;
    const ledger = new SubagentExecutionLedger(database);
    createBackgroundExecution(ledger, FIRST_AGENT_ID, 'parent-turn', 'parent-tool');
    createExecution(ledger, SECOND_AGENT_ID, 'nested-turn', 'nested-tool', FIRST_AGENT_ID);
    const activeAgents = new Set<string>([FIRST_AGENT_ID, SECOND_AGENT_ID]);
    const started: Array<{
      readonly threadId: string;
      readonly input: readonly { readonly type: string; readonly text: string }[];
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
      () => 100,
      ((configuration: unknown) => configuration) as never,
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
    expect(queued[0]?.content).toStartWith('Another Agent sent a message:\n');
    expect(queued[0]?.content).not.toContain('agentId from the immediately preceding agent tool result');

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
    expect(started[0]?.input[0]?.text).toBe(queued[0]?.content);
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
      {} as never,
      ledger,
      (() => { throw new Error('unused'); }) as never,
      (() => { throw new Error('unused'); }) as never,
      async () => null,
      async () => ({ maxDepth: 3, maxConcurrent: 20 }),
      async () => null,
      undefined,
      undefined,
      () => 100,
      ((configuration: unknown) => configuration) as never,
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

interface SpawnAdmissionCollaborationOptions {
  readonly requireActiveTurn?: () => void;
  readonly runTreeMutex?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly resolveAgentStartupContext?: () => Promise<unknown>;
  readonly prepareAgentWorktree: () => Promise<{
    readonly cwd: string;
    readonly worktree: AgentWorktreeMetadata;
  }>;
  readonly settleAgentWorktree?: (worktree: AgentWorktreeMetadata) => Promise<{
    readonly worktree: AgentWorktreeMetadata;
    readonly retained: boolean;
  }>;
  readonly createThread: () => Promise<unknown>;
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

  return new SubagentCollaboration(
    {
      requireThread: () => ({ thread: parent, configuration }),
      metadata: {
        childEdges: () => [],
        spawnEdgeForChild: () => null,
      },
      ephemeral: new Map(),
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
    } as never,
    {} as never,
    {} as never,
    () => role,
    () => ({ canonicalType: 'general-purpose', role, kind: 'general-purpose' }),
    async () => null,
    async () => ({ maxDepth: 3, maxConcurrent: 20 }),
    (options.resolveAgentStartupContext ?? (async () => null)) as never,
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
): void {
  ledger.create({
    agentId,
    parentThreadId,
    description: agentId,
    agentType: 'general-purpose',
    runMode: 'foreground',
    currentTurnId: turnId,
    toolUseId,
    worktree: null,
    toolPolicy: {
      kind: 'general-purpose',
      runInBackground: false,
      worktree: false,
      allowNesting: true,
      requestedTools: null,
    },
    startupContext: null,
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
    {} as never,
    ledger,
    (() => { throw new Error('unused'); }) as never,
    (() => { throw new Error('unused'); }) as never,
    async () => null,
    async () => ({ maxDepth: 3, maxConcurrent: 20 }),
    async () => null,
    undefined,
    undefined,
    () => 100,
    ((configuration: unknown) => configuration) as never,
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
