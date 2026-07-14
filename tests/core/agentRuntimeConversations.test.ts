import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { systemReminder } from '../../src/core/agentAttachments';
import { TOOL_CATALOG } from '../../src/core/agentToolCatalog';
import {
  DEFAULT_DREAM_CHANNEL_ID,
  DEFAULT_DREAM_CHANNEL_TITLE,
  DEFAULT_GENERAL_CHANNEL_ID,
  DEFAULT_GENERAL_CHANNEL_TITLE,
  channelIncludesInDreamData,
} from '../../src/core/agentChannel';
import { AGENT_EVENT_VERSION, getAgentEventActivePath, type AgentEvent } from '../../src/core/agentEventLog';
import type { ActorRef, AgentSessionStartInput } from '../../src/core/agentIssue';
import { LIN_AGENT_EVENT_CHANNEL, type AgentRuntimeEvent } from '../../src/core/agentTypes';
import { AgentEventStore } from '../../src/main/agentEventStore';
import { agentDefinitionAgentId } from '../../src/main/agentDelegationIdentity';
import { createAgentIssueToolRuntime } from '../../src/main/agentIssueRuntime';
import {
  AgentIssueStore,
  TERMINAL_DELIVERY_CLAIM_LEASE_MS,
  type AgentIssueTerminalDelivery,
} from '../../src/main/agentIssueStore';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

const electronUserDataRoot = path.join(tmpdir(), 'lin-agent-runtime-conversations-test-user-data');

mock.module('electron', () => ({
  app: {
    getPath: () => electronUserDataRoot,
    getVersion: () => 'test',
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({
      clearStorageData: async () => undefined,
    }),
  },
}));

type RuntimeModule = typeof import('../../src/main/agentRuntime');

let runtimeModulePromise: Promise<RuntimeModule> | null = null;

async function loadRuntimeModule() {
  runtimeModulePromise ??= import('../../src/main/agentRuntime');
  return runtimeModulePromise;
}

const roots: string[] = [];
const drainableRuntimes: Array<{ drainPendingWrites(): Promise<void> }> = [];
const ASSISTANT_AGENT_ID = 'built-in:tenon:assistant';
const ISSUE_ACTOR: ActorRef = { type: 'agent', agentId: ASSISTANT_AGENT_ID };

interface IssueDeliveryRuntimeInternals {
  deliverRootIssueToConversation(...args: unknown[]): Promise<'delivered' | 'deferred'>;
  deliverTerminalIssueDelivery(delivery: AgentIssueTerminalDelivery): Promise<'delivered' | 'deferred'>;
  drainTerminalIssueDeliveries(): Promise<void>;
  notifyParentAgentSessionForIssueDelivery(
    parentAgentSessionId: string,
    delivery: AgentIssueTerminalDelivery,
  ): Promise<'delivered' | 'deferred'>;
  runLedgerIssueDeliveryState(
    runId: string,
    marker: string,
    verificationRequired?: boolean,
  ): Promise<'absent' | 'queued' | 'processed'>;
  scheduleIssueDeliveryRetryDrain(): void;
  issueDeliveryRetryTimerAt: number | null;
  issueDeliveryRetryNotBefore: Map<string, number>;
  dreamSchedulerTimer: ReturnType<typeof setInterval> | null;
  issueSchedulerTimer: ReturnType<typeof setInterval> | null;
  fireDream(trigger: string, now: Date): Promise<void>;
  startTriggeredIssueSession(issue: unknown, now: Date): Promise<void>;
  agentSessionContinuationContext(input: AgentSessionStartInput): Promise<string | undefined>;
}

afterEach(async () => {
  await Promise.allSettled(drainableRuntimes.splice(0).map((runtime) => runtime.drainPendingWrites()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hostFor(core: Core): OutlinerToolHost {
  return {
    getProjection: () => core.projection(),
    transaction: async (_meta, fn) => fn(),
    operationHistory: async () => ({ entries: [], count: 0 }),
    handle: async () => {
      throw new Error('node tools are not used in this test');
    },
  };
}

function createWindowSink() {
  const events: AgentRuntimeEvent[] = [];
  return {
    events,
    window: {
      webContents: {
        send: (channel: string, event: AgentRuntimeEvent) => {
          if (channel === LIN_AGENT_EVENT_CHANNEL) events.push(event);
        },
      },
    },
  };
}

async function createRuntime(dataRoot: string, localRoot?: string) {
  const { AgentRuntime } = await loadRuntimeModule();
  const sink = createWindowSink();
  const runtime = new AgentRuntime(
    () => sink.window as never,
    hostFor(Core.new()),
    {
      agentDataRoot: dataRoot,
      localFileRoot: localRoot,
      providerConfigLoader: async () => null,
      runtimeSettingsLoader: async () => ({
        permissionMode: 'trusted',
        automaticSkillsEnabled: false,
        slashSkillsEnabled: false,
        compactEnabled: true,
        additionalSkillDirectories: [],
      }),
    },
  );
  drainableRuntimes.push(runtime);
  return { runtime, sink };
}

async function createProjectAgent(localRoot: string, name = 'self') {
  const rootDir = path.join(localRoot, '.agents', 'agents', name);
  const agentFile = path.join(rootDir, 'AGENT.md');
  await mkdir(rootDir, { recursive: true });
  await writeFile(agentFile, [
    '---',
    `name: ${name}`,
    'description: User-owned personal agent.',
    '---',
    'You are a focused child agent.',
    '',
  ].join('\n'));
  return {
    agentId: agentDefinitionAgentId({
      name,
      displayName: name,
      source: 'project',
      rootDir,
      agentFile,
      description: 'User-owned personal agent.',
      body: 'You are a focused child agent.',
    }),
    rootDir,
    agentFile,
  };
}

async function expectRejects(fn: () => Promise<unknown>, message: string) {
  try {
    await fn();
  } catch (error) {
    expect(error instanceof Error ? error.message : String(error)).toContain(message);
    return;
  }
  throw new Error('Expected promise to reject.');
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition.');
}

describe('agent runtime conversations', () => {
  test('queues interrupted Issue Session recovery only once across repeated window readiness', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-ready-recovery-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    let recoveryCount = 0;
    const internals = runtime as unknown as {
      queueIssueRecovery(now: Date): void;
      queueIssueSweep(now: Date): void;
      queueScheduledDream(now: Date): void;
      refreshPrimaryAgentIdentity(): Promise<void>;
      ensureDefaultChannelEventStates(): Promise<void>;
    };
    internals.queueIssueRecovery = () => {
      recoveryCount += 1;
    };
    internals.queueIssueSweep = () => undefined;
    internals.queueScheduledDream = () => undefined;
    internals.refreshPrimaryAgentIdentity = async () => undefined;
    internals.ensureDefaultChannelEventStates = async () => undefined;

    runtime.ready();
    runtime.ready();

    expect(recoveryCount).toBe(1);
  });

  test('startup recovery only stales Sessions from the constructor snapshot', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-recovery-snapshot-'));
    roots.push(dataRoot);
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const createPendingSession = async (title: string, now: number) => {
      const created = await store.create({
        issueType: 'issue',
        fields: { title },
        request: { mode: 'request' },
        reason: `Create ${title}.`,
      }, ISSUE_ACTOR, now);
      const issueId = created.targets.find((target) => target.type === 'issue')!.id;
      const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
      const started = await store.startSession({
        issueId,
        expectedIssueRevision: issue.revision,
        request: { mode: 'request' },
        reason: `Start ${title}.`,
      }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, now + 1);
      return started.targets.find((target) => target.type === 'agent-session')!.id;
    };

    const interruptedSessionId = await createPendingSession('Interrupted before startup', 10);
    const { runtime } = await createRuntime(dataRoot);
    const internals = runtime as unknown as {
      issueStartupSessionIds: Promise<ReadonlySet<string>>;
      issueSweepTail: Promise<void>;
    };
    await internals.issueStartupSessionIds;

    const newSessionId = await createPendingSession('Created after startup snapshot', 30);
    const stopReservation = await store.reserveSessionStop({
      agentSessionId: newSessionId,
      request: { mode: 'request' },
      reason: 'Keep a new Session stop reservation intact.',
    }, 40);
    expect(stopReservation.token).toBeDefined();

    runtime.ready();
    await internals.issueSweepTail;

    const state = await store.state();
    expect(state.sessions[interruptedSessionId]?.state).toBe('stale');
    expect(state.sessions[newSessionId]?.state).toBe('pending');
    expect(state.sessionStopIntents[newSessionId]?.token).toBe(stopReservation.token);
  });

  test('reconciles a terminal Run ledger before startup marks active Sessions stale', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-terminal-ledger-recovery-'));
    roots.push(dataRoot);
    const conversationId = 'conversation:terminal-ledger-recovery';
    const runId = 'child-terminal-ledger-recovery';
    const eventStore = new AgentEventStore(dataRoot);
    await eventStore.appendEvents(conversationId, [{
      v: AGENT_EVENT_VERSION,
      eventId: 'terminal-ledger-recovery-conversation',
      seq: 1,
      conversationId,
      type: 'conversation.created',
      createdAt: 10,
      actor: { type: 'system' },
      title: 'Terminal ledger recovery',
    }]);
    await eventStore.appendRunStreamEvents(conversationId, runId, [
      {
        v: AGENT_EVENT_VERSION,
        eventId: `${runId}-started`,
        seq: 1,
        conversationId,
        type: 'run.started',
        createdAt: 30,
        actor: { type: 'system' },
        runId,
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId },
        disposition: 'detached',
        objective: 'Recover the completed Session result.',
        objectiveRole: 'controller',
        trigger: { type: 'system' },
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: `${runId}-result`,
        seq: 2,
        conversationId,
        type: 'run.result.submitted',
        createdAt: 40,
        actor: { type: 'system' },
        runId,
        summary: 'Recovered authoritative terminal result.',
        source: 'final_assistant_message',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: `${runId}-completed`,
        seq: 3,
        conversationId,
        type: 'run.completed',
        createdAt: 50,
        actor: { type: 'system' },
        runId,
        objectiveRole: 'controller',
      },
    ]);

    const issueStore = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await issueStore.create({
      issueType: 'issue',
      fields: { title: 'Terminal ledger recovery Issue', permissionMode: 'attended' },
      request: { mode: 'request' },
      reason: 'Create terminal ledger recovery work.',
    }, ISSUE_ACTOR, 15, {
      origin: { type: 'conversation', conversationId },
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueStore.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueStore.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start terminal ledger recovery work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await issueStore.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId,
      executionId: runId,
      startedAt: 25,
    }, ISSUE_ACTOR, 25);

    const { runtime } = await createRuntime(dataRoot);
    runtime.ready();
    await runtime.drainPendingWrites();

    const state = await issueStore.state();
    expect(state.sessions[sessionId]).toMatchObject({
      state: 'complete',
      latestOutput: 'Recovered authoritative terminal result.',
    });
    expect(state.issues[issueId]?.status.category).toBe('completed');
    expect(Object.values(state.terminalDeliveries).some((delivery) => delivery.state === 'error')).toBe(false);
    expect(Object.values(state.activity).some((activity) => (
      activity.target.type === 'agent-session'
      && activity.target.agentSessionId === sessionId
      && activity.content.type === 'agent-error'
      && activity.content.body.includes('interrupted before runtime restore')
    ))).toBe(false);
  });

  test('restores verification mode and inherited verifier attempts for persisted delegated Runs', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-verify-restore-'));
    roots.push(dataRoot);
    const conversationId = 'conversation:verify-restore';
    const parentRunId = 'child-verify-restore-parent';
    const verifierRunId = 'child-verify-restore-verifier';
    const replacementRunId = 'child-verify-restore-replacement';
    const replacementVerifierRunId = 'child-verify-restore-replacement-verifier';
    const store = new AgentEventStore(dataRoot);
    await store.appendEvents(conversationId, [{
      v: AGENT_EVENT_VERSION,
      eventId: 'verify-restore-conversation',
      seq: 1,
      conversationId,
      type: 'conversation.created',
      createdAt: 1,
      actor: { type: 'system' },
      title: 'Verify restore',
    }]);
    const runEvent = (runId: string, seq: number, type: AgentEvent['type']) => ({
      v: AGENT_EVENT_VERSION,
      eventId: `${runId}-${seq}`,
      seq,
      conversationId,
      type,
      createdAt: seq,
      actor: { type: 'system' as const },
      runId,
    });
    await store.appendRunStreamEvents(conversationId, parentRunId, [
      {
        ...runEvent(parentRunId, 1, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId },
        disposition: 'detached',
        objective: 'Integrate child work.',
        criteria: ['Return a verified parent result.'],
        objectiveRole: 'controller',
        objectiveStatus: 'verifying',
        verificationRequired: true,
        purpose: 'work',
        trigger: { type: 'system' },
      },
      {
        ...runEvent(parentRunId, 2, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'verifying',
      },
    ]);
    await store.appendRunStreamEvents(conversationId, verifierRunId, [
      {
        ...runEvent(verifierRunId, 3, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId },
        disposition: 'detached',
        objective: 'Verify the parent result.',
        criteria: ['Return a verdict.'],
        objectiveRole: 'verifier',
        objectiveStatus: 'active',
        purpose: 'verify',
        trigger: { type: 'parent-run', parentRunId },
      },
      {
        ...runEvent(verifierRunId, 4, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'verified',
      },
    ]);
    await store.appendRunStreamEvents(conversationId, replacementRunId, [
      {
        ...runEvent(replacementRunId, 5, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId },
        disposition: 'detached',
        objective: 'Retry rejected worker output.',
        criteria: ['Return a verified replacement result.'],
        objectiveRole: 'worker',
        objectiveStatus: 'verifying',
        verificationRequired: true,
        verificationAttemptBase: 1,
        verifierGapSignatures: ['missing evidence', 'missing evidence'],
        purpose: 'work',
        trigger: { type: 'parent-run', parentRunId },
      },
      {
        ...runEvent(replacementRunId, 6, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'verifying',
        verifierGapSignatures: ['missing evidence', 'missing evidence'],
      },
    ]);
    await store.appendRunStreamEvents(conversationId, replacementVerifierRunId, [
      {
        ...runEvent(replacementVerifierRunId, 7, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId },
        disposition: 'detached',
        objective: 'Verify the replacement result.',
        criteria: ['Return a verdict.'],
        objectiveRole: 'verifier',
        objectiveStatus: 'active',
        purpose: 'verify',
        trigger: { type: 'parent-run', parentRunId: replacementRunId },
      },
      {
        ...runEvent(replacementVerifierRunId, 8, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'verified',
      },
    ]);

    const { runtime } = await createRuntime(dataRoot);
    await runtime.restoreConversation(conversationId);
    const runtimeInternals = runtime as unknown as {
      conversations: Map<string, {
        delegationRuntime: {
          runs: Map<string, {
            verify: boolean;
            verificationAttemptBase: number;
            verificationAttempts: number;
            verifierRunIds: string[];
            verifierGapSignatures: string[];
          }>;
        };
      }>;
    };
    const restoredParent = runtimeInternals.conversations
      .get(conversationId)?.delegationRuntime.runs.get(parentRunId);
    const restoredReplacement = runtimeInternals.conversations
      .get(conversationId)?.delegationRuntime.runs.get(replacementRunId);

    expect(restoredParent).toMatchObject({
      verify: true,
      verificationAttempts: 1,
      verifierRunIds: [verifierRunId],
    });
    expect(restoredReplacement).toMatchObject({
      verify: true,
      verificationAttemptBase: 1,
      verificationAttempts: 2,
      verifierRunIds: [replacementVerifierRunId],
      verifierGapSignatures: ['missing evidence', 'missing evidence'],
    });
  });

  test('blocks a completed Run left verifying across restart instead of reopening its Session', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-verify-interrupted-'));
    roots.push(dataRoot);
    const conversationId = 'conversation:verify-interrupted';
    const parentRunId = 'child-verify-interrupted-parent';
    const verifierRunId = 'child-verify-interrupted-verifier';
    const eventStore = new AgentEventStore(dataRoot);
    await eventStore.appendEvents(conversationId, [{
      v: AGENT_EVENT_VERSION,
      eventId: 'verify-interrupted-conversation',
      seq: 1,
      conversationId,
      type: 'conversation.created',
      createdAt: 1,
      actor: { type: 'system' },
      title: 'Verify interrupted',
    }]);
    const runEvent = (runId: string, seq: number, type: AgentEvent['type']) => ({
      v: AGENT_EVENT_VERSION,
      eventId: `${runId}-${seq}`,
      seq,
      conversationId,
      type,
      createdAt: seq,
      actor: { type: 'system' as const },
      runId,
    });
    await eventStore.appendRunStreamEvents(conversationId, parentRunId, [
      {
        ...runEvent(parentRunId, 1, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId },
        disposition: 'detached',
        objective: 'Return verified work.',
        criteria: ['Verification must pass.'],
        objectiveRole: 'controller',
        objectiveStatus: 'verifying',
        verificationRequired: true,
        purpose: 'work',
        trigger: { type: 'system' },
      },
      {
        ...runEvent(parentRunId, 2, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'verifying',
      },
    ]);
    await eventStore.appendRunStreamEvents(conversationId, verifierRunId, [
      {
        ...runEvent(verifierRunId, 3, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId },
        disposition: 'detached',
        objective: 'Verify interrupted parent.',
        criteria: ['Return a verdict.'],
        objectiveRole: 'verifier',
        objectiveStatus: 'active',
        purpose: 'verify',
        trigger: { type: 'parent-run', parentRunId },
      },
    ]);
    const issueStore = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await issueStore.create({
      issueType: 'issue',
      fields: {
        title: 'Interrupted verification Issue',
        verificationPolicy: { mode: 'agent-review', requiredVerdict: 'pass' },
      },
      request: { mode: 'request' },
      reason: 'Create interrupted verification Issue.',
    }, ISSUE_ACTOR, 10);
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueStore.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueStore.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start interrupted verification Issue.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await issueStore.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId,
      executionId: parentRunId,
      startedAt: 25,
    }, ISSUE_ACTOR, 25);

    const { runtime } = await createRuntime(dataRoot);
    await runtime.restoreConversation(conversationId);

    expect((await eventStore.readRunMetaProjection(parentRunId))?.objective).toMatchObject({
      status: 'blocked',
      blockedReason: 'Verification was interrupted before conversation restore.',
    });
    expect((await eventStore.readRunMetaProjection(verifierRunId))?.execution.status).toBe('failed');
    const conversationEvents = await eventStore.readConversationStreamEvents(conversationId);
    expect(conversationEvents.some((event) => (
      event.type === 'notification.created'
      && event.source?.type === 'run'
      && event.source.runId === verifierRunId
    ))).toBe(false);
    expect((await runtime.readAgentSession({ agentSessionId: sessionId }))?.agentSession.state).toBe('error');
  });

  test('serializes Run-detail stop behind Session guidance across Store instances', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-run-stop-serialization-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const conversation = await runtime.restoreLatestConversation();
    const runtimeStore = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await runtimeStore.create({
      issueType: 'issue',
      fields: { title: 'Run detail stop serialization' },
      request: { mode: 'request' },
      reason: 'Create serialized Run detail work.',
    }, ISSUE_ACTOR, 10);
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await runtimeStore.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await runtimeStore.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start serialized Run detail work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    const runId = 'run:detail-stop-serialization';
    await runtimeStore.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: runId,
      startedAt: 25,
    }, ISSUE_ACTOR, 25);

    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendRuntime = createAgentIssueToolRuntime({
      store: new AgentIssueStore(runtimeStore.coordinationKey()),
      actor: ISSUE_ACTOR,
      executor: {
        start: () => ({
          engine: 'delegation',
          conversationId: conversation.conversationId,
          executionId: runId,
          startedAt: 25,
        }),
        sendMessage: async () => {
          markSendStarted();
          await sendGate;
        },
      },
    });
    const runtimeInternals = runtime as unknown as {
      conversations: Map<string, {
        delegationRuntime: {
          stop(input: { runId: string }): Promise<{
            status: 'cancelled';
            runId: string;
            objective_status: 'stopped';
            updated_at: number;
            completed_at: number;
          }>;
        };
      }>;
    };
    let stopCalls = 0;
    runtimeInternals.conversations.get(conversation.conversationId)!.delegationRuntime.stop = async () => {
      stopCalls += 1;
      return {
        status: 'cancelled',
        runId,
        objective_status: 'stopped',
        updated_at: 40,
        completed_at: 40,
      };
    };

    const send = sendRuntime.sendSessionMessage({
      agentSessionId: sessionId,
      message: 'Persist guidance before the Run-detail stop.',
      request: { mode: 'request' },
      reason: 'Exercise cross-surface serialization.',
    });
    await sendStarted;
    const stop = runtime.runStop(conversation.conversationId, runId);
    await Promise.resolve();

    expect(stopCalls).toBe(0);
    expect((await runtimeStore.state()).sessionStopIntents[sessionId]).toBeUndefined();

    releaseSend();
    expect((await send).status).toBe('applied');
    expect((await stop).status).toBe('cancelled');
    expect(stopCalls).toBe(1);
    const read = await runtimeStore.readSession({ agentSessionId: sessionId, include: ['activity-summary'] });
    expect(read?.activity?.some((entry) => (
      entry.content.type === 'comment'
      && entry.content.body === 'Persist guidance before the Run-detail stop.'
    ))).toBe(true);
    expect(read?.agentSession.state).toBe('canceled');
  });

  test('keeps a naturally completed Issue Session terminal when Run-detail stop loses the race', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-run-stop-terminal-race-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const conversation = await runtime.restoreLatestConversation();
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await store.create({
      issueType: 'issue',
      fields: { title: 'Run detail terminal race' },
      request: { mode: 'request' },
      reason: 'Create Run detail terminal race work.',
    }, ISSUE_ACTOR, 10);
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await store.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start Run detail terminal race work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    const runId = 'run:detail-stop-terminal-race';
    await store.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: runId,
      startedAt: 25,
    }, ISSUE_ACTOR, 25);
    const runtimeInternals = runtime as unknown as {
      conversations: Map<string, {
        delegationRuntime: {
          stop(input: { runId: string }): Promise<{
            status: 'completed';
            runId: string;
            objective_status: 'active';
            result: string;
            updated_at: number;
            completed_at: number;
          }>;
        };
      }>;
    };
    runtimeInternals.conversations.get(conversation.conversationId)!.delegationRuntime.stop = async () => ({
      status: 'completed',
      runId,
      objective_status: 'active',
      result: 'Completed before the stop reached execution.',
      updated_at: 40,
      completed_at: 40,
    });

    const result = await runtime.runStop(conversation.conversationId, runId);

    expect(result.status).toBe('completed');
    expect((await store.readSession({ agentSessionId: sessionId }))?.agentSession).toMatchObject({
      state: 'complete',
      latestOutput: 'Completed before the stop reached execution.',
    });
    expect((await store.state()).sessionStopIntents[sessionId]).toBeUndefined();
    expect((await store.read({ target: { type: 'issue', id: issueId } })).issue?.status.category).toBe('completed');
  });

  test('deduplicates concurrent notification delivery before appending events', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    await runtime.restoreLatestConversation();

    await Promise.all([
      runtime.appendNotificationForTest(DEFAULT_GENERAL_CHANNEL_ID, 'notification:duplicate'),
      runtime.appendNotificationForTest(DEFAULT_GENERAL_CHANNEL_ID, 'notification:duplicate'),
    ]);

    const events = await new AgentEventStore(dataRoot).readConversationStreamEvents(DEFAULT_GENERAL_CHANNEL_ID);
    expect(events.filter((event) => (
      event.type === 'notification.created' && event.notificationId === 'notification:duplicate'
    ))).toHaveLength(1);
  });

  test('recovers a root Issue delivery after notification append without duplicating its attention event', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-root-delivery-recovery-'));
    roots.push(dataRoot);
    const { runtime: crashedRuntime } = await createRuntime(dataRoot);
    const conversation = await crashedRuntime.restoreLatestConversation();
    const issueStore = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await issueStore.create({
      issueType: 'issue',
      fields: { title: 'Recover root delivery' },
      request: { mode: 'request' },
      reason: 'Create durable root delivery work.',
    }, ISSUE_ACTOR, 100, {
      origin: { type: 'conversation', conversationId: conversation.conversationId },
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueStore.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueStore.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start root delivery work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 110);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await issueStore.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: 'execution:root-delivery-recovery',
      startedAt: 120,
    }, ISSUE_ACTOR, 120);
    await issueStore.syncSessionExecution({
      engine: 'delegation',
      executionId: 'execution:root-delivery-recovery',
      state: 'completed',
      latestOutput: 'Recovered root delivery result.',
      completedAt: 130,
    }, ISSUE_ACTOR, 130);

    const [claimed] = await issueStore.claimTerminalDeliveries('owner:crashed-runtime', 10, 140);
    expect(claimed).toBeDefined();
    const crashedInternals = crashedRuntime as unknown as IssueDeliveryRuntimeInternals;
    crashedInternals.deliverRootIssueToConversation = async () => {
      throw new Error('Simulated crash after notification append.');
    };
    await expectRejects(
      () => crashedInternals.deliverTerminalIssueDelivery(claimed!),
      'Simulated crash after notification append.',
    );

    const eventStore = new AgentEventStore(dataRoot);
    const eventsAfterCrash = await eventStore.readConversationStreamEvents(conversation.conversationId);
    expect(eventsAfterCrash.filter((event) => (
      event.type === 'notification.created'
      && event.notificationId === `notification-${claimed!.id}`
    ))).toHaveLength(1);
    expect(eventsAfterCrash.filter((event) => event.type === 'user_message.created')).toHaveLength(0);
    expect((await issueStore.state()).terminalDeliveries[claimed!.id]).toMatchObject({
      status: 'dispatching',
      dispatchOwnerId: 'owner:crashed-runtime',
      attemptCount: 1,
    });

    const { runtime: restartedRuntime } = await createRuntime(dataRoot);
    await restartedRuntime.restoreLatestConversation();
    const restartedInternals = restartedRuntime as unknown as IssueDeliveryRuntimeInternals;
    let resumedDeliveryTurns = 0;
    restartedInternals.deliverRootIssueToConversation = async () => {
      resumedDeliveryTurns += 1;
      return 'delivered';
    };
    await restartedInternals.drainTerminalIssueDeliveries();
    await restartedInternals.drainTerminalIssueDeliveries();

    expect((await issueStore.state()).terminalDeliveries[claimed!.id]).toMatchObject({
      status: 'delivered',
      attemptCount: 2,
    });
    expect(resumedDeliveryTurns).toBe(1);
    const recoveredEvents = await new AgentEventStore(dataRoot).readEvents(conversation.conversationId);
    expect(recoveredEvents.filter((event) => (
      event.type === 'notification.created'
      && event.notificationId === `notification-${claimed!.id}`
    ))).toHaveLength(1);
  });

  test('seals a persisted silent root notification after restart without calling the Agent again', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-root-response-recovery-'));
    roots.push(dataRoot);
    const { runtime: crashedRuntime } = await createRuntime(dataRoot);
    const conversation = await crashedRuntime.restoreLatestConversation();
    const issueStore = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await issueStore.create({
      issueType: 'issue',
      fields: { title: 'Recover persisted root response' },
      request: { mode: 'request' },
      reason: 'Create persisted root response recovery work.',
    }, ISSUE_ACTOR, 100, {
      origin: { type: 'conversation', conversationId: conversation.conversationId },
    });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await issueStore.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await issueStore.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start persisted root response recovery work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 110);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await issueStore.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: 'execution:root-response-recovery',
      startedAt: 120,
    }, ISSUE_ACTOR, 120);
    await issueStore.syncSessionExecution({
      engine: 'delegation',
      executionId: 'execution:root-response-recovery',
      state: 'completed',
      latestOutput: 'Persisted authoritative root result.',
      completedAt: 130,
    }, ISSUE_ACTOR, 130);

    const delivery = Object.values((await issueStore.state()).terminalDeliveries)[0]!;
    const deliveryKey = createHash('sha256').update(delivery.id).digest('hex').slice(0, 24);
    const runId = `issue-delivery-run-${deliveryKey}-1`;
    const userMessageId = `user-issue-delivery-${deliveryKey}-1`;
    const assistantMessageId = `assistant-issue-delivery-${deliveryKey}-1`;
    const eventStore = new AgentEventStore(dataRoot);
    let seq = (await eventStore.replay(conversation.conversationId)).latestSeq;
    const createdAt = Date.now();
    await eventStore.appendEvents(conversation.conversationId, [
      {
        v: AGENT_EVENT_VERSION,
        eventId: `notification-${deliveryKey}`,
        seq: ++seq,
        conversationId: conversation.conversationId,
        type: 'notification.created',
        createdAt,
        actor: { type: 'system' },
        notificationId: `notification-${delivery.id}`,
        kind: 'task_completed',
        title: delivery.title,
        body: delivery.body,
        source: {
          type: 'issue',
          issueId: delivery.issueId,
          agentSessionId: delivery.agentSessionId,
          state: delivery.state,
        },
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: `user-${deliveryKey}`,
        seq: ++seq,
        conversationId: conversation.conversationId,
        type: 'user_message.created',
        createdAt: createdAt + 1,
        actor: { type: 'system' },
        messageId: userMessageId,
        parentMessageId: null,
        content: [{
          type: 'text',
          text: systemReminder([
            `<root-issue-delivery id="tenon-issue-delivery:${delivery.id}">`,
            '<result>Persisted authoritative root result.</result>',
            '</root-issue-delivery>',
          ].join('\n')),
        }],
        notificationId: `notification-${delivery.id}`,
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: `branch-${deliveryKey}`,
        seq: ++seq,
        conversationId: conversation.conversationId,
        type: 'branch.selected',
        createdAt: createdAt + 2,
        actor: { type: 'system' },
        leafMessageId: userMessageId,
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: `run-${deliveryKey}`,
        seq: ++seq,
        conversationId: conversation.conversationId,
        type: 'run.started',
        createdAt: createdAt + 3,
        actor: { type: 'system' },
        runId,
        agentId: ASSISTANT_AGENT_ID,
        anchor: {
          type: 'conversation',
          agentId: ASSISTANT_AGENT_ID,
          conversationId: conversation.conversationId,
        },
        trigger: { type: 'message', messageId: userMessageId },
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: `assistant-start-${deliveryKey}`,
        seq: ++seq,
        conversationId: conversation.conversationId,
        type: 'assistant_message.started',
        createdAt: createdAt + 4,
        actor: { type: 'agent', agentId: ASSISTANT_AGENT_ID },
        runId,
        messageId: assistantMessageId,
        parentMessageId: userMessageId,
        providerId: 'test',
        modelId: 'test-model',
        apiId: 'test-api',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: `assistant-complete-${deliveryKey}`,
        seq: ++seq,
        conversationId: conversation.conversationId,
        type: 'assistant_message.completed',
        createdAt: createdAt + 5,
        actor: { type: 'agent', agentId: ASSISTANT_AGENT_ID },
        runId,
        messageId: assistantMessageId,
        stopReason: 'stop',
        content: [],
      },
    ]);

    const { runtime: restartedRuntime } = await createRuntime(dataRoot);
    await restartedRuntime.restoreLatestConversation();
    const restartedInternals = restartedRuntime as unknown as IssueDeliveryRuntimeInternals;
    await restartedInternals.drainTerminalIssueDeliveries();
    await restartedInternals.drainTerminalIssueDeliveries();

    expect((await issueStore.state()).terminalDeliveries[delivery.id]).toMatchObject({
      status: 'delivered',
      attemptCount: 1,
    });
    const runEvents = await eventStore.readRunStreamEvents(runId);
    expect(runEvents.filter((event) => event.type === 'assistant_message.started')).toHaveLength(1);
    expect(runEvents.filter((event) => event.type === 'assistant_message.completed')).toHaveLength(1);
    expect(runEvents.filter((event) => event.type === 'run.result.submitted')).toHaveLength(0);
    expect(runEvents.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    const restored = await restartedRuntime.restoreConversation(conversation.conversationId);
    expect(restored.renderProjection.entities.messages[userMessageId]?.issueNotification).toMatchObject({
      issueId: delivery.issueId,
      state: 'complete',
      title: delivery.title,
    });
    expect(restored.renderProjection.entities.messages[assistantMessageId]?.content).toEqual([]);
  });

  test('releases and retries a parent Agent Session delivery after a transient notify failure', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-parent-delivery-retry-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const conversation = await runtime.restoreLatestConversation();
    const issueStore = AgentIssueStore.forAgentDataRoot(dataRoot);
    const parentCreated = await issueStore.create({
      issueType: 'issue',
      fields: { title: 'Parent delivery retry' },
      request: { mode: 'request' },
      reason: 'Create parent work.',
    }, ISSUE_ACTOR, 100, {
      origin: { type: 'conversation', conversationId: conversation.conversationId },
    });
    const parentIssueId = parentCreated.targets.find((target) => target.type === 'issue')!.id;
    const parentIssue = (await issueStore.read({ target: { type: 'issue', id: parentIssueId } })).issue!;
    const parentStarted = await issueStore.startSession({
      issueId: parentIssueId,
      expectedIssueRevision: parentIssue.revision,
      request: { mode: 'request' },
      reason: 'Start parent work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 110);
    const parentSessionId = parentStarted.targets.find((target) => target.type === 'agent-session')!.id;
    await issueStore.bindSessionExecution(parentSessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: 'execution:parent-delivery-retry',
      startedAt: 120,
    }, ISSUE_ACTOR, 120);

    const childCreated = await issueStore.create({
      issueType: 'issue',
      fields: { title: 'Child delivery retry' },
      request: { mode: 'request' },
      reason: 'Create child work.',
    }, ISSUE_ACTOR, 130, {
      origin: { type: 'agent-session', agentSessionId: parentSessionId },
    });
    const childIssueId = childCreated.targets.find((target) => target.type === 'issue')!.id;
    const childIssue = (await issueStore.read({ target: { type: 'issue', id: childIssueId } })).issue!;
    const childStarted = await issueStore.startSession({
      issueId: childIssueId,
      expectedIssueRevision: childIssue.revision,
      request: { mode: 'request' },
      reason: 'Start child work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 140);
    const childSessionId = childStarted.targets.find((target) => target.type === 'agent-session')!.id;
    await issueStore.bindSessionExecution(childSessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: 'execution:child-delivery-retry',
      startedAt: 150,
    }, ISSUE_ACTOR, 150);
    await issueStore.syncSessionExecution({
      engine: 'delegation',
      executionId: 'execution:child-delivery-retry',
      state: 'completed',
      latestOutput: 'Child result for retry.',
      completedAt: 160,
    }, ISSUE_ACTOR, 160);

    const [delivery] = Object.values((await issueStore.state()).terminalDeliveries);
    expect(delivery).toMatchObject({
      issueId: childIssueId,
      origin: { type: 'agent-session', agentSessionId: parentSessionId },
      status: 'pending',
      attemptCount: 0,
    });
    let notifyAttempts = 0;
    const internals = runtime as unknown as IssueDeliveryRuntimeInternals;
    internals.notifyParentAgentSessionForIssueDelivery = async (agentSessionId, candidate) => {
      notifyAttempts += 1;
      expect(agentSessionId).toBe(parentSessionId);
      expect(candidate.id).toBe(delivery!.id);
      if (notifyAttempts === 1) throw new Error('Transient parent notify failure.');
      return notifyAttempts === 2 ? 'deferred' : 'delivered';
    };

    await internals.drainTerminalIssueDeliveries();
    expect((await issueStore.state()).terminalDeliveries[delivery!.id]).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      lastError: 'Transient parent notify failure.',
    });
    expect(internals.issueDeliveryRetryNotBefore.get(delivery!.id)).toBeGreaterThan(Date.now());
    internals.issueDeliveryRetryNotBefore.set(delivery!.id, 0);

    await internals.drainTerminalIssueDeliveries();
    expect((await issueStore.state()).terminalDeliveries[delivery!.id]).toMatchObject({
      status: 'pending',
      attemptCount: 2,
    });
    await internals.drainTerminalIssueDeliveries();
    expect((await issueStore.state()).terminalDeliveries[delivery!.id]).toMatchObject({
      status: 'delivered',
      attemptCount: 3,
    });
    await internals.drainTerminalIssueDeliveries();
    expect(notifyAttempts).toBe(3);
  });

  test('schedules restart recovery at the persisted terminal-delivery lease expiry', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-delivery-lease-restart-'));
    roots.push(dataRoot);
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await store.create({
      issueType: 'issue',
      fields: { title: 'Lease recovery delivery' },
      request: { mode: 'request' },
      reason: 'Create routed work for lease recovery.',
    }, ISSUE_ACTOR, 10, { origin: { type: 'conversation', conversationId: 'conversation:origin' } });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await store.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Start work that will fail before dispatch.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await store.failSessionStart(sessionId, 'Provider unavailable.', ISSUE_ACTOR, 30);
    const claimNow = Date.now();
    const [claimed] = await store.claimTerminalDeliveries('owner:crashed', 10, claimNow);
    expect(claimed).toBeDefined();

    const { runtime } = await createRuntime(dataRoot);
    const internals = runtime as unknown as IssueDeliveryRuntimeInternals;
    runtime.ready();
    await waitFor(() => internals.issueDeliveryRetryTimerAt !== null);
    expect(internals.issueDeliveryRetryTimerAt).toBe(claimNow + TERMINAL_DELIVERY_CLAIM_LEASE_MS);
    await runtime.drainPendingWrites();
  });

  test('drain waits for retry scheduling and prevents later Issue store access', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-delivery-drain-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const internals = runtime as unknown as IssueDeliveryRuntimeInternals & {
      getIssueStore(): AgentIssueStore;
    };
    let dreamRunsAfterDrain = 0;
    internals.fireDream = async () => {
      dreamRunsAfterDrain += 1;
    };
    const store = internals.getIssueStore();
    const originalState = store.state.bind(store);
    let stateReads = 0;
    let blockNextStateRead = true;
    let releaseStateRead = () => undefined;
    const stateReadStarted = new Promise<void>((resolve) => {
      store.state = async () => {
        stateReads += 1;
        if (blockNextStateRead) {
          blockNextStateRead = false;
          resolve();
          await new Promise<void>((release) => {
            releaseStateRead = release;
          });
        }
        return originalState();
      };
    });

    try {
      internals.scheduleIssueDeliveryRetryDrain();
      await stateReadStarted;
      let drained = false;
      const draining = runtime.drainPendingWrites().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(drained).toBe(false);
      releaseStateRead();
      await draining;

      const readsAfterDrain = stateReads;
      expect(internals.dreamSchedulerTimer).toBeNull();
      expect(internals.issueSchedulerTimer).toBeNull();
      internals.scheduleIssueDeliveryRetryDrain();
      await runtime.runScheduledDreamsForTest();
      await expectRejects(() => runtime.runDreamNow(), 'shutting down');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stateReads).toBe(readsAfterDrain);
      expect(dreamRunsAfterDrain).toBe(0);
      expect(internals.issueDeliveryRetryTimerAt).toBeNull();
    } finally {
      releaseStateRead();
      store.state = originalState;
    }
  });

  test('drain waits for a Session startup launched by the Issue scheduler', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-trigger-start-drain-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    await store.create({
      issueType: 'issue',
      fields: {
        title: 'Drain scheduled startup',
        trigger: { type: 'when-ready' },
        permissionMode: 'unattended',
      },
      request: { mode: 'request' },
      reason: 'Create ready work for shutdown draining.',
    }, ISSUE_ACTOR, Date.now(), {
      origin: { type: 'conversation', conversationId: 'conversation:trigger-start-drain' },
    });
    const internals = runtime as unknown as IssueDeliveryRuntimeInternals;
    let releaseStart = () => undefined;
    let markStartEntered = () => undefined;
    let startSettled = false;
    let drainedAfterStart = false;
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    internals.drainTerminalIssueDeliveries = async () => {
      if (startSettled) drainedAfterStart = true;
    };
    internals.startTriggeredIssueSession = async () => {
      markStartEntered();
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      startSettled = true;
    };

    runtime.runIssueCatchUp();
    await startEntered;
    let drained = false;
    const draining = runtime.drainPendingWrites().then(() => {
      drained = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(drained).toBe(false);
    } finally {
      releaseStart();
      await draining;
    }
    expect(drainedAfterStart).toBe(true);
  });

  test('records Work human-review acceptance as the trusted local user', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-human-review-'));
    roots.push(dataRoot);
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await store.create({
      issueType: 'issue',
      fields: {
        title: 'Human review from Work',
        verificationPolicy: { mode: 'human-review' },
      },
      request: { mode: 'request' },
      reason: 'Create review-gated work.',
    }, ISSUE_ACTOR, 10, { origin: { type: 'conversation', conversationId: 'conversation:origin' } });
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await store.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Produce a result for review.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    await store.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId: 'conversation:execution',
      executionId: 'execution:human-review-work',
      startedAt: 30,
    }, ISSUE_ACTOR, 30);
    await store.syncSessionExecution({
      engine: 'delegation',
      executionId: 'execution:human-review-work',
      state: 'completed',
      latestOutput: 'Reviewable result.',
      completedAt: 40,
    }, ISSUE_ACTOR, 40);
    const current = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
    const { runtime } = await createRuntime(dataRoot);

    const completed = await runtime.completeHumanReview(issueId, current.revision);
    expect(completed.status).toBe('applied');
    const detail = await store.read({ target: { type: 'issue', id: issueId }, include: ['activity'] });
    expect(detail.issue?.status.category).toBe('completed');
    expect(detail.activity).toContainEqual(expect.objectContaining({
      actor: { type: 'user', userId: 'local-user' },
      content: { type: 'status-change', from: 'Started', to: 'Completed' },
    }));
    await runtime.drainPendingWrites();
  });

  test('builds summary, transcript, none, and explicit transcript-fallback continuation context', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-session-continuation-context-'));
    roots.push(dataRoot);
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const created = await store.create({
      issueType: 'issue',
      fields: { title: 'Continuation context source' },
      request: { mode: 'request' },
      reason: 'Create prior Session work.',
    }, ISSUE_ACTOR, 10);
    const issueId = created.targets.find((target) => target.type === 'issue')!.id;
    const issue = (await store.read({ target: { type: 'issue', id: issueId } })).issue!;
    const started = await store.startSession({
      issueId,
      expectedIssueRevision: issue.revision,
      request: { mode: 'request' },
      reason: 'Create the prior Session.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const sessionId = started.targets.find((target) => target.type === 'agent-session')!.id;
    const conversationId = 'conversation:continuation-context';
    const runId = 'execution:continuation-context';
    await store.bindSessionExecution(sessionId, {
      engine: 'delegation',
      conversationId,
      executionId: runId,
      startedAt: 30,
    }, ISSUE_ACTOR, 30);
    await store.syncSessionExecution({
      engine: 'delegation',
      executionId: runId,
      state: 'completed',
      latestOutput: 'Stored latest output only.',
      completedAt: 40,
    }, ISSUE_ACTOR, 40);
    const base = (seq: number, type: AgentEvent['type']) => ({
      v: AGENT_EVENT_VERSION,
      eventId: `continuation-context-${seq}`,
      seq,
      conversationId,
      type,
      createdAt: 30 + seq,
      actor: { type: 'system' as const },
      runId,
    });
    await new AgentEventStore(dataRoot).appendRunStreamEvents(conversationId, runId, [
      {
        ...base(1, 'user_message.created'),
        type: 'user_message.created',
        messageId: 'continuation-user',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Prior transcript instruction.' }],
      },
      {
        ...base(2, 'assistant_message.started'),
        type: 'assistant_message.started',
        messageId: 'continuation-assistant',
        parentMessageId: 'continuation-user',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(3, 'assistant_message.completed'),
        type: 'assistant_message.completed',
        messageId: 'continuation-assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Prior transcript final.' }],
      },
    ]);
    const { runtime } = await createRuntime(dataRoot);
    const internals = runtime as unknown as IssueDeliveryRuntimeInternals;
    const input = (context: 'summary' | 'transcript' | 'none'): AgentSessionStartInput => ({
      issueId,
      continuation: { previousAgentSessionId: sessionId, intent: 'continue', context },
      request: { mode: 'request' },
      reason: 'Continue prior work.',
    });

    const summary = await internals.agentSessionContinuationContext(input('summary'));
    expect(summary).toContain('Stored latest output only.');
    expect(summary).not.toContain('Prior transcript instruction.');
    expect(await internals.agentSessionContinuationContext(input('none'))).toBeUndefined();
    const transcript = await internals.agentSessionContinuationContext(input('transcript'));
    expect(transcript).toContain('Previous Agent Session transcript:');
    expect(transcript).toContain('Prior transcript instruction.');
    expect(transcript).toContain('Prior transcript final.');

    const unboundCreated = await store.create({
      issueType: 'issue',
      fields: { title: 'Unbound continuation source' },
      request: { mode: 'request' },
      reason: 'Create an unbound failed Session.',
    }, ISSUE_ACTOR, 50);
    const unboundIssueId = unboundCreated.targets.find((target) => target.type === 'issue')!.id;
    const unboundIssue = (await store.read({ target: { type: 'issue', id: unboundIssueId } })).issue!;
    const unboundStarted = await store.startSession({
      issueId: unboundIssueId,
      expectedIssueRevision: unboundIssue.revision,
      request: { mode: 'request' },
      reason: 'Fail before binding.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 60);
    const unboundSessionId = unboundStarted.targets.find((target) => target.type === 'agent-session')!.id;
    await store.failSessionStart(unboundSessionId, 'Binding never existed.', ISSUE_ACTOR, 70);
    const fallback = await internals.agentSessionContinuationContext({
      issueId: unboundIssueId,
      continuation: { previousAgentSessionId: unboundSessionId, intent: 'retry', context: 'transcript' },
      request: { mode: 'request' },
      reason: 'Retry with transcript fallback.',
    });
    expect(fallback).toContain('Previous Agent Session transcript unavailable.');
    expect(fallback).toContain('Binding never existed.');
    await runtime.drainPendingWrites();
  });

  test('acknowledges a child delivery only after its parent continuation completes', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-parent-delivery-ack-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const conversation = await runtime.restoreLatestConversation();
    const eventStore = new AgentEventStore(dataRoot);
    const runId = 'run:parent-delivery-ack';
    const marker = 'tenon-issue-delivery:delivery-ack';
    const base = (seq: number, type: AgentEvent['type']) => ({
      v: AGENT_EVENT_VERSION,
      eventId: `event-${seq}`,
      seq,
      conversationId: conversation.conversationId,
      type,
      createdAt: seq,
      actor: { type: 'system' as const },
      runId,
    });
    await eventStore.appendRunStreamEvents(conversation.conversationId, runId, [
      {
        ...base(1, 'user_message.created'),
        type: 'user_message.created',
        messageId: 'user-delivery-marker',
        parentMessageId: null,
        content: [{ type: 'text', text: marker }],
      },
      {
        ...base(2, 'run.failed'),
        type: 'run.failed',
        errorMessage: 'The delegated run was interrupted before conversation restore.',
      },
    ]);
    const internals = runtime as unknown as IssueDeliveryRuntimeInternals;
    expect(await internals.runLedgerIssueDeliveryState(runId, marker)).toBe('queued');

    await eventStore.appendRunStreamEvents(conversation.conversationId, runId, [
      {
        ...base(3, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: {
          type: 'conversation',
          agentId: ASSISTANT_AGENT_ID,
          conversationId: conversation.conversationId,
        },
        disposition: 'detached',
        trigger: { type: 'system' },
      },
      {
        ...base(4, 'assistant_message.started'),
        type: 'assistant_message.started',
        messageId: 'assistant-delivery-tool',
        parentMessageId: 'user-delivery-marker',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(5, 'assistant_message.completed'),
        type: 'assistant_message.completed',
        messageId: 'assistant-delivery-tool',
        stopReason: 'toolUse',
        content: [],
      },
      {
        ...base(6, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'active',
      },
    ]);
    expect(await internals.runLedgerIssueDeliveryState(runId, marker)).toBe('queued');

    await eventStore.appendRunStreamEvents(conversation.conversationId, runId, [
      {
        ...base(7, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: {
          type: 'conversation',
          agentId: ASSISTANT_AGENT_ID,
          conversationId: conversation.conversationId,
        },
        disposition: 'detached',
        objectiveStatus: 'active',
        trigger: { type: 'system' },
      },
      {
        ...base(8, 'tool_result.created'),
        type: 'tool_result.created',
        toolCallId: 'tool-delivery',
        toolName: 'issue_read',
        messageId: 'tool-result-delivery',
        parentMessageId: 'assistant-delivery-tool',
        isError: false,
        content: [{ type: 'text', text: 'Integrated child state.' }],
        outputSummary: 'Integrated child state.',
      },
      {
        ...base(9, 'assistant_message.started'),
        type: 'assistant_message.started',
        messageId: 'assistant-delivery-final',
        parentMessageId: 'tool-result-delivery',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(10, 'assistant_message.completed'),
        type: 'assistant_message.completed',
        messageId: 'assistant-delivery-final',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Parent continuation complete.' }],
      },
      {
        ...base(11, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'verifying',
      },
    ]);
    expect(await internals.runLedgerIssueDeliveryState(runId, marker, true)).toBe('queued');

    await eventStore.appendRunStreamEvents(conversation.conversationId, runId, [{
      ...base(12, 'run.completed'),
      type: 'run.completed',
      objectiveStatus: 'verified',
    }]);
    expect(await internals.runLedgerIssueDeliveryState(runId, marker, true)).toBe('processed');
  });

  test('requires the final assistant completion in a Run span to be a tool-free stop', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-parent-delivery-final-turn-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const conversation = await runtime.restoreLatestConversation();
    const eventStore = new AgentEventStore(dataRoot);
    const internals = runtime as unknown as IssueDeliveryRuntimeInternals;
    const appendCase = async (
      runId: string,
      marker: string,
      finalContent: Extract<AgentEvent, { type: 'assistant_message.completed' }>['content'],
      includeLaterToolTurn: boolean,
    ) => {
      const base = (seq: number, type: AgentEvent['type']) => ({
        v: AGENT_EVENT_VERSION,
        eventId: `${runId}-event-${seq}`,
        seq,
        conversationId: conversation.conversationId,
        type,
        createdAt: seq,
        actor: { type: 'system' as const },
        runId,
      });
      const events: AgentEvent[] = [
        {
          ...base(1, 'user_message.created'),
          type: 'user_message.created',
          messageId: `${runId}-marker`,
          parentMessageId: null,
          content: [{ type: 'text', text: marker }],
        },
        {
          ...base(2, 'run.started'),
          type: 'run.started',
          agentId: ASSISTANT_AGENT_ID,
          anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId: conversation.conversationId },
          disposition: 'detached',
          trigger: { type: 'system' },
        },
        {
          ...base(3, 'assistant_message.started'),
          type: 'assistant_message.started',
          messageId: `${runId}-stop`,
          parentMessageId: `${runId}-marker`,
          providerId: 'test',
          modelId: 'test',
        },
        {
          ...base(4, 'assistant_message.completed'),
          type: 'assistant_message.completed',
          messageId: `${runId}-stop`,
          stopReason: 'stop',
          content: finalContent,
        },
      ];
      if (includeLaterToolTurn) {
        events.push(
          {
            ...base(5, 'user_message.created'),
            type: 'user_message.created',
            messageId: `${runId}-follow-up`,
            parentMessageId: `${runId}-stop`,
            content: [{ type: 'text', text: 'Continue before completing.' }],
          },
          {
            ...base(6, 'assistant_message.started'),
            type: 'assistant_message.started',
            messageId: `${runId}-tool-turn`,
            parentMessageId: `${runId}-follow-up`,
            providerId: 'test',
            modelId: 'test',
          },
          {
            ...base(7, 'assistant_message.completed'),
            type: 'assistant_message.completed',
            messageId: `${runId}-tool-turn`,
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'tool-late', name: 'issue_read', arguments: {} }],
          },
        );
      }
      const completionSeq = includeLaterToolTurn ? 8 : 5;
      events.push({
        ...base(completionSeq, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'active',
      });
      await eventStore.appendRunStreamEvents(conversation.conversationId, runId, events);
    };

    await appendCase(
      'run:delivery-stop-before-tool',
      'tenon-issue-delivery:stop-before-tool',
      [{ type: 'text', text: 'Premature final response.' }],
      true,
    );
    expect(await internals.runLedgerIssueDeliveryState(
      'run:delivery-stop-before-tool',
      'tenon-issue-delivery:stop-before-tool',
    )).toBe('queued');

    await appendCase(
      'run:delivery-stop-with-tool',
      'tenon-issue-delivery:stop-with-tool',
      [
        { type: 'text', text: 'Claims completion but still calls a tool.' },
        { type: 'toolCall', id: 'tool-inline', name: 'issue_read', arguments: {} },
      ],
      false,
    );
    expect(await internals.runLedgerIssueDeliveryState(
      'run:delivery-stop-with-tool',
      'tenon-issue-delivery:stop-with-tool',
    )).toBe('queued');
  });

  test('reconciles a processed child delivery from the Run ledger when Run metadata is stale', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-parent-delivery-stale-meta-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const conversation = await runtime.restoreLatestConversation();
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const eventStore = new AgentEventStore(dataRoot);
    const parentCreated = await store.create({
      issueType: 'issue',
      fields: { title: 'Parent stale-meta work' },
      request: { mode: 'request' },
      reason: 'Create parent stale-meta work.',
    }, ISSUE_ACTOR, 10);
    const parentIssueId = parentCreated.targets.find((target) => target.type === 'issue')!.id;
    const parentIssue = (await store.read({ target: { type: 'issue', id: parentIssueId } })).issue!;
    const parentStarted = await store.startSession({
      issueId: parentIssueId,
      expectedIssueRevision: parentIssue.revision,
      request: { mode: 'request' },
      reason: 'Start parent stale-meta work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const parentSessionId = parentStarted.targets.find((target) => target.type === 'agent-session')!.id;
    const runId = 'child-parent-delivery-stale-meta';
    await store.bindSessionExecution(parentSessionId, {
      engine: 'delegation',
      conversationId: conversation.conversationId,
      executionId: runId,
      startedAt: 25,
    }, ISSUE_ACTOR, 25);
    const childCreated = await store.create({
      issueType: 'issue',
      fields: { title: 'Child stale-meta work' },
      request: { mode: 'request' },
      reason: 'Create child stale-meta work.',
    }, ISSUE_ACTOR, 30, { origin: { type: 'agent-session', agentSessionId: parentSessionId } });
    const childIssueId = childCreated.targets.find((target) => target.type === 'issue')!.id;
    const childIssue = (await store.read({ target: { type: 'issue', id: childIssueId } })).issue!;
    await store.update({
      target: { type: 'issue', id: childIssueId, expectedRevision: childIssue.revision },
      change: { type: 'transition', status: { name: 'Canceled', category: 'canceled' } },
      request: { mode: 'request' },
      reason: 'Cancel child stale-meta work.',
    }, ISSUE_ACTOR, 40);
    const delivery = Object.values((await store.state()).terminalDeliveries)[0]!;
    const marker = `tenon-issue-delivery:${delivery.id}`;
    const base = (seq: number, type: AgentEvent['type']) => ({
      v: AGENT_EVENT_VERSION,
      eventId: `stale-meta-event-${seq}`,
      seq,
      conversationId: conversation.conversationId,
      type,
      createdAt: seq,
      actor: { type: 'system' as const },
      runId,
    });
    await eventStore.appendRunStreamEvents(conversation.conversationId, runId, [
      {
        ...base(1, 'user_message.created'),
        type: 'user_message.created',
        messageId: 'stale-meta-initial-user',
        parentMessageId: null,
        content: [{ type: 'text', text: 'Wait for the child result.' }],
      },
      {
        ...base(2, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId: conversation.conversationId },
        disposition: 'detached',
        objective: 'Integrate a canceled child.',
        objectiveStatus: 'active',
        trigger: { type: 'system' },
      },
      {
        ...base(3, 'assistant_message.started'),
        type: 'assistant_message.started',
        messageId: 'stale-meta-waiting-response',
        parentMessageId: 'stale-meta-initial-user',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(4, 'assistant_message.completed'),
        type: 'assistant_message.completed',
        messageId: 'stale-meta-waiting-response',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Parent is waiting for the child result.' }],
      },
      {
        ...base(5, 'run.result.submitted'),
        type: 'run.result.submitted',
        summary: 'Parent is waiting for the child result.',
        source: 'final_assistant_message',
      },
      {
        ...base(6, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'active',
      },
      {
        ...base(7, 'user_message.created'),
        type: 'user_message.created',
        messageId: 'stale-meta-marker',
        parentMessageId: 'stale-meta-waiting-response',
        content: [{ type: 'text', text: marker }],
      },
      {
        ...base(8, 'run.started'),
        type: 'run.started',
        agentId: ASSISTANT_AGENT_ID,
        anchor: { type: 'conversation', agentId: ASSISTANT_AGENT_ID, conversationId: conversation.conversationId },
        disposition: 'detached',
        objectiveStatus: 'active',
        trigger: { type: 'system' },
      },
      {
        ...base(9, 'assistant_message.started'),
        type: 'assistant_message.started',
        messageId: 'stale-meta-final-response',
        parentMessageId: 'stale-meta-marker',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(10, 'assistant_message.completed'),
        type: 'assistant_message.completed',
        messageId: 'stale-meta-final-response',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Handled the canceled child with the current result.' }],
      },
      {
        ...base(11, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'active',
      },
    ]);
    const completedMeta = (await eventStore.readRunMetaProjection(runId))!;
    await eventStore.writeRunMeta({
      ...completedMeta,
      execution: { status: 'running' },
      objective: completedMeta.objective
        ? { ...completedMeta.objective, latestSubmissionSeq: 5 }
        : undefined,
      updatedAt: 9,
      latestSeq: 9,
    });

    const { runtime: restoredRuntime } = await createRuntime(dataRoot);
    await restoredRuntime.restoreConversation(conversation.conversationId);
    expect((await eventStore.readRunMetaProjection(runId))?.execution.status).toBe('completed');

    const internals = restoredRuntime as unknown as IssueDeliveryRuntimeInternals;
    expect(await internals.notifyParentAgentSessionForIssueDelivery(parentSessionId, delivery)).toBe('delivered');
    expect((await store.state()).terminalDeliveries[delivery.id]?.status).toBe('delivered');
    expect((await store.readSession({ agentSessionId: parentSessionId }))?.agentSession).toMatchObject({
      state: 'complete',
      latestOutput: 'Handled the canceled child with the current result.',
    });
    expect((await store.read({ target: { type: 'issue', id: parentIssueId } })).issue?.status.category).toBe('completed');
    expect((await eventStore.readRunMetaProjection(runId))?.execution.status).toBe('completed');
  });

  test('keeps a child delivery queued when the parent objective is blocked', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-parent-delivery-blocked-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const conversation = await runtime.restoreLatestConversation();
    const eventStore = new AgentEventStore(dataRoot);
    const runId = 'run:parent-delivery-blocked';
    const marker = 'tenon-issue-delivery:delivery-blocked';
    const base = (seq: number, type: AgentEvent['type']) => ({
      v: AGENT_EVENT_VERSION,
      eventId: `blocked-event-${seq}`,
      seq,
      conversationId: conversation.conversationId,
      type,
      createdAt: seq,
      actor: { type: 'system' as const },
      runId,
    });
    await eventStore.appendRunStreamEvents(conversation.conversationId, runId, [
      {
        ...base(1, 'user_message.created'),
        type: 'user_message.created',
        messageId: 'blocked-delivery-marker',
        parentMessageId: null,
        content: [{ type: 'text', text: marker }],
      },
      {
        ...base(2, 'assistant_message.started'),
        type: 'assistant_message.started',
        messageId: 'blocked-delivery-response',
        parentMessageId: 'blocked-delivery-marker',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(3, 'assistant_message.completed'),
        type: 'assistant_message.completed',
        messageId: 'blocked-delivery-response',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Candidate parent result.' }],
      },
      {
        ...base(4, 'run.completed'),
        type: 'run.completed',
        objectiveStatus: 'blocked',
      },
    ]);

    const internals = runtime as unknown as IssueDeliveryRuntimeInternals;
    expect(await internals.runLedgerIssueDeliveryState(runId, marker)).toBe('queued');
    expect(await internals.runLedgerIssueDeliveryState(runId, marker, true)).toBe('queued');
  });

  test('tracks an Issue delivery marker through repeated compaction carriers', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-delivery-compaction-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const conversation = await runtime.restoreLatestConversation();
    const eventStore = new AgentEventStore(dataRoot);
    const runId = 'run:delivery-compaction';
    const marker = 'tenon-issue-delivery:delivery-compaction';
    const exactPayload = `<child-issue-delivery id="${marker}"><result>Exact child payload.</result></child-issue-delivery>`;
    const base = (seq: number, type: AgentEvent['type']) => ({
      v: AGENT_EVENT_VERSION,
      eventId: `compact-event-${seq}`,
      seq,
      conversationId: conversation.conversationId,
      type,
      createdAt: seq,
      actor: { type: 'system' as const },
      runId,
    });
    await eventStore.appendRunStreamEvents(conversation.conversationId, runId, [
      {
        ...base(1, 'user_message.created'),
        type: 'user_message.created',
        messageId: 'delivery-marker',
        parentMessageId: null,
        content: [{ type: 'text', text: exactPayload }],
      },
      {
        ...base(2, 'assistant_message.started'),
        type: 'assistant_message.started',
        messageId: 'failed-response',
        parentMessageId: 'delivery-marker',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(3, 'assistant_message.completed'),
        type: 'assistant_message.completed',
        messageId: 'failed-response',
        stopReason: 'error',
        content: [],
      },
      {
        ...base(4, 'compaction.completed'),
        type: 'compaction.completed',
        messageId: 'compact-root-1',
        summary: 'Summary intentionally omits the child result.',
        source: { fromMessageId: 'delivery-marker', throughMessageId: 'failed-response' },
        trigger: 'reactive',
      },
      {
        ...base(5, 'user_message.created'),
        type: 'user_message.created',
        messageId: 'compact-root-1',
        parentMessageId: null,
        content: [{ type: 'text', text: `Conversation compacted.\n${exactPayload}` }],
      },
      {
        ...base(6, 'compaction.completed'),
        type: 'compaction.completed',
        messageId: 'compact-root-2',
        summary: 'Second summary also omits the child result.',
        source: { fromMessageId: 'compact-root-1', throughMessageId: 'compact-root-1' },
        trigger: 'auto',
      },
      {
        ...base(7, 'user_message.created'),
        type: 'user_message.created',
        messageId: 'compact-root-2',
        parentMessageId: null,
        content: [{ type: 'text', text: `Conversation compacted again.\n${exactPayload}` }],
      },
    ]);
    const internals = runtime as unknown as IssueDeliveryRuntimeInternals;
    expect(await internals.runLedgerIssueDeliveryState(runId, marker)).toBe('queued');

    await eventStore.appendRunStreamEvents(conversation.conversationId, runId, [
      {
        ...base(8, 'assistant_message.started'),
        type: 'assistant_message.started',
        messageId: 'successful-response',
        parentMessageId: 'compact-root-2',
        providerId: 'test',
        modelId: 'test',
      },
      {
        ...base(9, 'assistant_message.completed'),
        type: 'assistant_message.completed',
        messageId: 'successful-response',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Integrated exact child payload.' }],
      },
      {
        ...base(10, 'run.completed'),
        type: 'run.completed',
      },
    ]);

    expect(await internals.runLedgerIssueDeliveryState(runId, marker)).toBe('processed');
    const activePath = getAgentEventActivePath(await eventStore.replayRunStream(runId));
    expect(JSON.stringify(activePath[0]?.content)).toContain('Exact child payload.');
  });

  test('exposes the built-in Tenon assistant as a directly editable agent definition', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);

    const definitions = await runtime.listAllAgentDefinitions('workspace');
    const assistant = definitions.find((definition) => definition.agentId === ASSISTANT_AGENT_ID);

    expect(assistant).toMatchObject({
      agentId: ASSISTANT_AGENT_ID,
      name: 'assistant',
      displayName: 'Neva',
      source: 'built-in',
      rootDir: 'built-in',
      agentFile: 'built-in/assistant',
      description: 'Default Tenon assistant profile.',
      // Editable in place (its edits persist to the settings overlay, not a file).
      writable: true,
    });
    expect(assistant?.body).toContain('You are Neva.');
  });

  test('the registry loads only Neva — a dropped AGENT.md under .agents/agents is ignored (one-Neva invariant)', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-local-'));
    roots.push(dataRoot, localRoot);
    // A user drops a file-backed agent under the workspace agents dir. Pre-collapse this
    // would have loaded a second agent; the registry now never scans it.
    await createProjectAgent(localRoot, 'shadow-researcher');
    const { runtime } = await createRuntime(dataRoot, localRoot);

    const definitions = await runtime.listAllAgentDefinitions('workspace');

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({ agentId: ASSISTANT_AGENT_ID, name: 'assistant', source: 'built-in' });
  });

  test('editing the built-in assistant overlays display name + persona, keeping the stable id', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    try {
      await runtime.updateAgentDefinition('workspace', ASSISTANT_AGENT_ID, {
        name: 'Lin',
        description: 'My editing partner',
        body: 'You are Lin. Be terse.',
      });

      const assistant = (await runtime.listAllAgentDefinitions('workspace'))
        .find((definition) => definition.agentId === ASSISTANT_AGENT_ID);

      // The name field edits the DISPLAY name; the stable id / `name` is untouched, so
      // memory anchored to the agentId never orphans on a rename.
      expect(assistant?.agentId).toBe(ASSISTANT_AGENT_ID);
      expect(assistant?.name).toBe('assistant');
      expect(assistant?.displayName).toBe('Lin');
      expect(assistant?.description).toBe('My editing partner');
      expect(assistant?.body).toBe('You are Lin. Be terse.');
      expect(assistant?.writable).toBe(true);
    } finally {
      // The overlay lives under the shared mocked userData — reset it so sibling tests
      // still see the default Neva.
      await rm(path.join(electronUserDataRoot, 'agent-providers.json'), { force: true });
    }
  });

  test('re-saving the built-in with an unchanged persona/description does not freeze them into the overlay', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    try {
      const before = (await runtime.listAllAgentDefinitions('workspace'))
        .find((definition) => definition.agentId === ASSISTANT_AGENT_ID);
      // The user only renames; the persona + description round-trip unchanged through the
      // form (the editor loads them from the materialized definition).
      await runtime.updateAgentDefinition('workspace', ASSISTANT_AGENT_ID, {
        name: 'Lin',
        description: before?.description,
        body: before?.body,
      });

      // Only the field the user actually changed (displayName) is stored. Persisting the
      // unchanged persona/description would freeze them at edit time, so a later change to
      // the code default (NEVA_AGENT_PERSONA) would be silently ignored.
      const overlay = JSON.parse(
        await readFile(path.join(electronUserDataRoot, 'agent-providers.json'), 'utf8'),
      ) as { builtInAgentProfiles?: Record<string, Record<string, unknown>> };
      const entries = Object.values(overlay.builtInAgentProfiles ?? {});
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({ displayName: 'Lin' });
    } finally {
      await rm(path.join(electronUserDataRoot, 'agent-providers.json'), { force: true });
    }
  });

  test('previews run-scoped tool output payloads only with the owning run id', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const store = new AgentEventStore(dataRoot);
    const conversationId = 'conversation-preview-payload';
    const runId = 'run-preview-payload';
    const payload = await store.writePayload(conversationId, {
      runId,
      id: 'tool-output-preview',
      data: 'full tool output',
      mimeType: 'text/plain',
      role: 'tool_output',
      summary: 'large.log output',
      truncated: true,
    });

    await store.appendEvents(conversationId, [
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'conversation-preview-payload-created',
        seq: 1,
        conversationId,
        type: 'conversation.created',
        createdAt: 1_800_000_000_001,
        actor: { type: 'system' },
        title: 'Preview payload scope',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'conversation-preview-payload-run-started',
        seq: 2,
        conversationId,
        type: 'run.started',
        createdAt: 1_800_000_000_002,
        actor: { type: 'system' },
        runId,
        agentId: ASSISTANT_AGENT_ID,
        kind: 'turn',
        retention: 'hot',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'conversation-preview-payload-created-payload',
        seq: 3,
        conversationId,
        type: 'payload.created',
        createdAt: 1_800_000_000_003,
        actor: { type: 'system' },
        runId,
        payload,
      },
    ] satisfies AgentEvent[]);

    await expect(runtime.previewPayload(conversationId, payload.id)).resolves.toBeNull();
    await expect(runtime.previewPayload(conversationId, payload.id, 'other-run')).resolves.toBeNull();
    await expect(runtime.previewPayload(conversationId, payload.id, runId)).resolves.toMatchObject({
      id: payload.id,
      role: 'tool_output',
      scope: { type: 'run', conversationId, runId },
    });
    await expect(runtime.previewPayloadBytes(conversationId, payload.id, runId)).resolves.toEqual(Buffer.from('full tool output'));
  });

  test('default channel membership is exactly {user, Neva}', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-local-'));
    roots.push(dataRoot, localRoot);
    const { runtime } = await createRuntime(dataRoot, localRoot);

    await runtime.restoreConversation(DEFAULT_GENERAL_CHANNEL_ID);
    await runtime.restoreConversation(DEFAULT_DREAM_CHANNEL_ID);
    // The one-Neva invariant: the only conversation members are the local user and
    // Neva. There is no second agent to add, and no member.added beyond setup.
    const store = new AgentEventStore(dataRoot);
    for (const conversationId of [DEFAULT_GENERAL_CHANNEL_ID, DEFAULT_DREAM_CHANNEL_ID]) {
      const state = await store.replay(conversationId);
      expect(state.conversation?.members).toEqual([
        { type: 'user', userId: 'local-user' },
        { type: 'agent', agentId: ASSISTANT_AGENT_ID },
      ]);
      expect((await store.readEvents(conversationId))
        .filter((event) => event.type === 'member.added'))
        .toHaveLength(0);
    }

    const dreamState = await store.replay(DEFAULT_DREAM_CHANNEL_ID);
    expect(dreamState.conversation?.title).toBe(DEFAULT_DREAM_CHANNEL_TITLE);
    expect(channelIncludesInDreamData(
      DEFAULT_DREAM_CHANNEL_ID,
      dreamState.conversation?.settings,
    )).toBe(false);
  });

  test('creates, renames, and deletes channels; default channels stay immutable', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const { runtime, sink } = await createRuntime(dataRoot);

    await runtime.restoreLatestConversation();
    const channel = await runtime.createConversation({ title: 'Initial Project' });
    let channels = await runtime.listConversations();

    expect(channel.conversationId).toMatch(/^lin-agent-channel-/);
    expect(channels.map((entry) => entry.id)).toEqual([
      DEFAULT_GENERAL_CHANNEL_ID,
      DEFAULT_DREAM_CHANNEL_ID,
      channel.conversationId,
    ]);
    expect(channels.find((entry) => entry.id === DEFAULT_DREAM_CHANNEL_ID)).toMatchObject({
      id: DEFAULT_DREAM_CHANNEL_ID,
      title: DEFAULT_DREAM_CHANNEL_TITLE,
      goal: DEFAULT_DREAM_CHANNEL_TITLE,
      settings: { includeInDreamData: false },
    });
    expect(channels.find((entry) => entry.id === channel.conversationId)).toMatchObject({
      id: channel.conversationId,
      title: 'Initial Project',
      goal: 'Initial Project',
      settings: {},
      members: [
        { type: 'user', userId: 'local-user' },
        { type: 'agent', agentId: ASSISTANT_AGENT_ID },
      ],
    });

    const renamed = await runtime.renameConversation(channel.conversationId, 'Project Alpha');
    channels = await runtime.listConversations();

    expect(renamed).toMatchObject({ title: 'Project Alpha', goal: 'Project Alpha' });
    expect(channels.find((entry) => entry.id === channel.conversationId))
      .toMatchObject({ title: 'Project Alpha', goal: 'Project Alpha' });
    const blankRenamed = await runtime.renameConversation(channel.conversationId, '   ');
    channels = await runtime.listConversations();

    expect(blankRenamed).toMatchObject({ title: 'Untitled', goal: 'Untitled' });
    expect(channels.find((entry) => entry.id === channel.conversationId))
      .toMatchObject({ title: 'Untitled', goal: 'Untitled' });
    await expectRejects(() => runtime.renameConversation(DEFAULT_GENERAL_CHANNEL_ID, 'Town Square'), '#General cannot be renamed');
    await expectRejects(() => runtime.renameConversation(DEFAULT_DREAM_CHANNEL_ID, 'Night Log'), '#Dream cannot be renamed');
    await expectRejects(() => runtime.deleteConversation(DEFAULT_GENERAL_CHANNEL_ID), '#General cannot be deleted');
    await expectRejects(() => runtime.deleteConversation(DEFAULT_DREAM_CHANNEL_ID), '#Dream cannot be deleted');
    const dreamEventsBeforeMessage = await new AgentEventStore(dataRoot).readEvents(DEFAULT_DREAM_CHANNEL_ID);
    await runtime.sendMessage(DEFAULT_DREAM_CHANNEL_ID, 'Can we talk here?');
    const dreamEventsAfterMessage = await new AgentEventStore(dataRoot).readEvents(DEFAULT_DREAM_CHANNEL_ID);
    expect(dreamEventsAfterMessage).toHaveLength(dreamEventsBeforeMessage.length);
    expect(sink.events.some((event) =>
      event.type === 'error'
      && event.error.includes('#Dream does not accept regular chat messages'),
    )).toBe(true);
    expect(channelIncludesInDreamData(channel.conversationId, channels.find((entry) => entry.id === channel.conversationId)?.settings))
      .toBe(true);
    const excluded = await runtime.setConversationIncludeInDreamData(channel.conversationId, false);
    expect(excluded?.settings).toEqual({ includeInDreamData: false });
    expect(channelIncludesInDreamData(channel.conversationId, excluded?.settings)).toBe(false);
    const included = await runtime.setConversationIncludeInDreamData(channel.conversationId, true);
    expect(included?.settings).toEqual({ includeInDreamData: true });
    expect(channelIncludesInDreamData(channel.conversationId, included?.settings)).toBe(true);
    await expectRejects(
      () => runtime.setConversationIncludeInDreamData(DEFAULT_DREAM_CHANNEL_ID, true),
      '#Dream cannot be included in Dream data',
    );

    await runtime.deleteConversation(channel.conversationId);
    expect((await runtime.listConversations()).map((entry) => entry.id))
      .toEqual([DEFAULT_GENERAL_CHANNEL_ID, DEFAULT_DREAM_CHANNEL_ID]);
  });

  test('blocks Channel deletion while Issue routing still references it', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversation-routing-delete-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const channel = await runtime.createConversation({ title: 'Routed work' });
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);

    const rootCreated = await store.create({
      issueType: 'issue',
      fields: { title: 'Root routed work' },
      request: { mode: 'request' },
      reason: 'Create root routed work.',
    }, ISSUE_ACTOR, 10, {
      origin: { type: 'conversation', conversationId: channel.conversationId },
    });
    const rootIssueId = rootCreated.targets.find((target) => target.type === 'issue')!.id;
    await expectRejects(
      () => runtime.deleteConversation(channel.conversationId),
      'active Issue routing',
    );
    const rootIssue = (await store.read({ target: { type: 'issue', id: rootIssueId } })).issue!;
    await store.update({
      target: { type: 'issue', id: rootIssueId, expectedRevision: rootIssue.revision },
      change: { type: 'transition', status: { name: 'Canceled', category: 'canceled' } },
      request: { mode: 'request' },
      reason: 'Cancel root routed work.',
    }, ISSUE_ACTOR, 20);

    const recurringCreated = await store.create({
      issueType: 'recurring-issue',
      fields: {
        titleTemplate: 'Recurring routed work',
        cadence: { type: 'daily', time: '09:00' },
        timeZone: 'UTC',
        issueTemplate: { permissionMode: 'unattended' },
      },
      request: { mode: 'request' },
      reason: 'Create recurring routed work.',
    }, ISSUE_ACTOR, 30, {
      origin: { type: 'conversation', conversationId: channel.conversationId },
    });
    const recurringIssueId = recurringCreated.targets.find((target) => target.type === 'recurring-issue')!.id;
    await expectRejects(
      () => runtime.deleteConversation(channel.conversationId),
      'active Issue routing',
    );
    const recurringIssue = (await store.read({
      target: { type: 'recurring-issue', id: recurringIssueId },
    })).recurringIssue!;
    await store.update({
      target: {
        type: 'recurring-issue',
        id: recurringIssueId,
        expectedRevision: recurringIssue.revision,
      },
      change: { type: 'archive' },
      request: { mode: 'request' },
      reason: 'Archive recurring routed work.',
    }, ISSUE_ACTOR, 40);

    await runtime.deleteConversation(channel.conversationId);
    expect((await runtime.listConversations()).some((entry) => entry.id === channel.conversationId)).toBe(false);
  });

  test('keeps a parent Session execution Channel until child delivery is acknowledged', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-parent-binding-delete-'));
    roots.push(dataRoot);
    const { runtime } = await createRuntime(dataRoot);
    const channel = await runtime.createConversation({ title: 'Parent execution' });
    const store = AgentIssueStore.forAgentDataRoot(dataRoot);
    const parentCreated = await store.create({
      issueType: 'issue',
      fields: { title: 'Parent binding work' },
      request: { mode: 'request' },
      reason: 'Create parent binding work.',
    }, ISSUE_ACTOR, 10);
    const parentIssueId = parentCreated.targets.find((target) => target.type === 'issue')!.id;
    const parentIssue = (await store.read({ target: { type: 'issue', id: parentIssueId } })).issue!;
    const parentStarted = await store.startSession({
      issueId: parentIssueId,
      expectedIssueRevision: parentIssue.revision,
      request: { mode: 'request' },
      reason: 'Start parent binding work.',
    }, { type: 'runtime-action', actor: ISSUE_ACTOR }, ISSUE_ACTOR, 20);
    const parentSessionId = parentStarted.targets.find((target) => target.type === 'agent-session')!.id;
    await store.bindSessionExecution(parentSessionId, {
      engine: 'delegation',
      conversationId: channel.conversationId,
      executionId: 'execution:parent-binding-delete',
      startedAt: 25,
    }, ISSUE_ACTOR, 25);
    const childCreated = await store.create({
      issueType: 'issue',
      fields: { title: 'Child binding work' },
      request: { mode: 'request' },
      reason: 'Create child binding work.',
    }, ISSUE_ACTOR, 30, {
      origin: { type: 'agent-session', agentSessionId: parentSessionId },
    });
    const childIssueId = childCreated.targets.find((target) => target.type === 'issue')!.id;
    await store.syncSessionExecution({
      engine: 'delegation',
      executionId: 'execution:parent-binding-delete',
      state: 'completed',
      latestOutput: 'Waiting for child work.',
      completedAt: 35,
    }, ISSUE_ACTOR, 35);

    await expectRejects(
      () => runtime.deleteConversation(channel.conversationId),
      'active Issue routing',
    );
    await expectRejects(
      () => runtime.resetConversation(channel.conversationId),
      'active Agent Session routing',
    );
    const childIssue = (await store.read({ target: { type: 'issue', id: childIssueId } })).issue!;
    await store.update({
      target: { type: 'issue', id: childIssueId, expectedRevision: childIssue.revision },
      change: { type: 'transition', status: { name: 'Canceled', category: 'canceled' } },
      request: { mode: 'request' },
      reason: 'Cancel child binding work.',
    }, ISSUE_ACTOR, 40);
    await expectRejects(
      () => runtime.deleteConversation(channel.conversationId),
      'active Issue routing',
    );
    const [delivery] = await store.claimTerminalDeliveries('owner:delete-test', 10, 50);
    expect(delivery).toBeDefined();
    expect(await store.completeTerminalDelivery(delivery!.id, 'owner:delete-test', 60)).toBe(true);

    await runtime.deleteConversation(channel.conversationId);
    expect((await runtime.listConversations()).some((entry) => entry.id === channel.conversationId)).toBe(false);
  });

  test('Channel creation can be untitled; a channel always has exactly {user, Neva}', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    const localRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-local-'));
    roots.push(dataRoot, localRoot);
    // A project agent definition exists, but it is a delegation child-type — it
    // must never join a conversation as a member (single-agent collapse).
    await createProjectAgent(localRoot);
    const { runtime } = await createRuntime(dataRoot, localRoot);

    const untitledChannel = await runtime.createConversation();
    const untitledState = await new AgentEventStore(dataRoot).replay(untitledChannel.conversationId);
    expect(untitledState.conversation?.title).toBe('Untitled');
    expect(Object.keys(untitledState.messages)).toHaveLength(0);

    const soloChannel = await runtime.createConversation({ title: 'Solo channel' });
    const state = await new AgentEventStore(dataRoot).replay(soloChannel.conversationId);

    expect(state.conversation?.goal).toBe('Solo channel');
    expect(state.conversation?.members).toEqual([
      { type: 'user', userId: 'local-user' },
      { type: 'agent', agentId: ASSISTANT_AGENT_ID },
    ]);
  });

  test('restores and resolves durable pending user questions', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const conversationId = 'lin-agent-channel-question';
    const events: AgentEvent[] = [
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-1',
        seq: 1,
        conversationId,
        type: 'conversation.created',
        createdAt: 1,
        actor: { type: 'system' },
        title: 'Question channel',
        members: [
          { type: 'user', userId: 'local-user' },
          { type: 'agent', agentId: 'built-in:tenon:assistant' },
        ],
        goal: 'Question channel',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-2',
        seq: 2,
        conversationId,
        type: 'run.started',
        createdAt: 2,
        actor: { type: 'system' },
        runId: 'run-1',
        agentId: 'built-in:tenon:assistant',
        kind: 'turn',
        trigger: { type: 'manual' },
        fingerprint: {
          appVersion: 'test',
          promptHash: 'prompt',
          toolSchemaHash: 'tools',
          skillBindings: [],
          modelConfig: 'model',
        },
        retention: 'hot',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-3',
        seq: 3,
        conversationId,
        type: 'assistant_message.started',
        createdAt: 3,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        parentMessageId: null,
        providerId: 'test',
        modelId: 'test',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-4',
        seq: 4,
        conversationId,
        type: 'tool_call.started',
        createdAt: 4,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        toolCallId: 'tool-question-1',
        name: 'ask_user_question',
        inputSummary: '{"questions":[{"id":"direction"}]}',
        args: { questions: [{ id: 'direction' }] },
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-5',
        seq: 5,
        conversationId,
        type: 'assistant_message.completed',
        createdAt: 5,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        stopReason: 'toolUse',
        content: [{
          type: 'toolCall',
          id: 'tool-question-1',
          name: 'ask_user_question',
          arguments: { questions: [{ id: 'direction' }] },
        }],
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-6',
        seq: 6,
        conversationId,
        type: 'user_question.requested',
        createdAt: 6,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        requestId: 'question-1',
        toolCallId: 'tool-question-1',
        request: {
          questions: [{
            id: 'direction',
            type: 'single_choice',
            question: 'Which path?',
            allowReferences: true,
            allowAttachments: true,
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          }, {
            id: 'node-context',
            type: 'free_text',
            question: 'Which node has the context?',
            allowReferences: true,
          }, {
            id: 'file-context',
            type: 'free_text',
            question: 'Which file has the context?',
            allowReferences: true,
          }, {
            id: 'attachment-context',
            type: 'free_text',
            question: 'Attach the context.',
            allowAttachments: true,
          }],
        },
      },
    ];
    await new AgentEventStore(dataRoot).appendEvents(conversationId, events);
    const { runtime } = await createRuntime(dataRoot);

    const restored = await runtime.restoreConversation(conversationId);
    expect(restored.pendingUserQuestion?.requestId).toBe('question-1');

    await expectRejects(
      () => runtime.resolveUserQuestion(conversationId, 'question-1', {
        requestId: 'question-1',
        answers: [{ questionId: 'direction', selectedOptionIds: [] }],
      }),
      'Question direction is required.',
    );

    await runtime.resolveUserQuestion(conversationId, 'question-1', {
      requestId: 'question-1',
      answers: [{
        questionId: 'direction',
        selectedOptionIds: ['b'],
        text: 'use [[file:readme^README.md]]',
        nodeRefs: [{ nodeId: 'node-1', title: 'Referenced node' }],
        fileRefs: [{
          attachmentId: 'attachment-1',
          entryKind: 'file',
          name: 'README.md',
          path: 'README.md',
          ref: 'readme',
          mimeType: 'text/markdown',
          sizeBytes: 12,
        }],
        attachments: [{
          id: 'attachment-1',
          kind: 'text',
          name: 'notes.txt',
          ref: 'notes',
          mimeType: 'text/plain',
          sizeBytes: 5,
          text: 'hello',
        }],
      }, {
        questionId: 'node-context',
        nodeRefs: [{ nodeId: 'node-only', title: 'Node only' }],
      }, {
        questionId: 'file-context',
        fileRefs: [{
          attachmentId: 'file-ref-only',
          entryKind: 'file',
          iconDataUrl: 'data:image/png;base64,icon',
          name: 'reference.md',
          path: 'reference.md',
          ref: 'reference',
          mimeType: 'text/markdown',
          sizeBytes: 24,
          thumbnailDataUrl: 'data:image/png;base64,thumb',
        }],
      }, {
        questionId: 'attachment-context',
        attachments: [{
          id: 'attachment-only',
          kind: 'text',
          name: 'context.txt',
          ref: 'context',
          mimeType: 'text/plain',
          sizeBytes: 11,
          text: 'hello world',
        }],
      }],
    });

    const replay = await new AgentEventStore(dataRoot).replay(conversationId);
    expect(replay.userQuestions['question-1']).toMatchObject({
      status: 'answered',
      result: {
        requestId: 'question-1',
        outcome: 'answered',
        answers: [{
          questionId: 'direction',
          selectedOptionIds: ['b'],
          text: 'use [[file:readme^README.md]]',
          nodeRefs: [{ nodeId: 'node-1', label: 'Referenced node' }],
          fileRefs: [{
            attachmentId: 'attachment-1',
            entryKind: 'file',
            name: 'README.md',
            path: 'README.md',
            ref: 'readme',
            mimeType: 'text/markdown',
            sizeBytes: 12,
          }],
          attachments: [{
            id: 'attachment-1',
            kind: 'text',
            name: 'notes.txt',
            ref: 'notes',
            mimeType: 'text/plain',
            sizeBytes: 5,
            payload: expect.objectContaining({ kind: 'payload_ref', mimeType: 'text/plain' }),
          }],
        }, {
          questionId: 'node-context',
          nodeRefs: [{ nodeId: 'node-only', label: 'Node only' }],
        }, {
          questionId: 'file-context',
          fileRefs: [{
            attachmentId: 'file-ref-only',
            entryKind: 'file',
            name: 'reference.md',
            path: 'reference.md',
            ref: 'reference',
            mimeType: 'text/markdown',
            sizeBytes: 24,
          }],
        }, {
          questionId: 'attachment-context',
          attachments: [{
            id: 'attachment-only',
            kind: 'text',
            name: 'context.txt',
            ref: 'context',
            mimeType: 'text/plain',
            sizeBytes: 11,
            payload: expect.objectContaining({ kind: 'payload_ref', mimeType: 'text/plain' }),
          }],
        }],
      },
    });
    const toolResult = getAgentEventActivePath(replay).find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'tool-question-1',
    );
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      actor: { type: 'tool', toolName: 'ask_user_question', toolCallId: 'tool-question-1' },
      parentMessageId: 'assistant-question-1',
      toolName: 'ask_user_question',
      isError: false,
    });
    // Replayed answers render through the shared tool-result envelope, identical to
    // the live ask_user_question result the model sees (format-agnostic structure check).
    expect(toolResult?.content).toHaveLength(1);
    expect(toolResult?.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.parse((toolResult?.content[0] as { text: string }).text)).toEqual({
      ok: true,
      data: replay.userQuestions['question-1']!.result,
    });
  });

  test('resolves durable pending user questions with a discuss outcome', async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-runtime-conversations-data-'));
    roots.push(dataRoot);
    const conversationId = 'lin-agent-channel-question-discuss';
    const events: AgentEvent[] = [
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-1',
        seq: 1,
        conversationId,
        type: 'conversation.created',
        createdAt: 1,
        actor: { type: 'system' },
        title: 'Question channel',
        members: [
          { type: 'user', userId: 'local-user' },
          { type: 'agent', agentId: 'built-in:tenon:assistant' },
        ],
        goal: 'Question channel',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-2',
        seq: 2,
        conversationId,
        type: 'run.started',
        createdAt: 2,
        actor: { type: 'system' },
        runId: 'run-1',
        agentId: 'built-in:tenon:assistant',
        kind: 'turn',
        trigger: { type: 'manual' },
        fingerprint: {
          appVersion: 'test',
          promptHash: 'prompt',
          toolSchemaHash: 'tools',
          skillBindings: [],
          modelConfig: 'model',
        },
        retention: 'hot',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-3',
        seq: 3,
        conversationId,
        type: 'assistant_message.started',
        createdAt: 3,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        parentMessageId: null,
        providerId: 'test',
        modelId: 'test',
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-4',
        seq: 4,
        conversationId,
        type: 'tool_call.started',
        createdAt: 4,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        toolCallId: 'tool-question-1',
        name: 'ask_user_question',
        inputSummary: '{"questions":[{"id":"direction"}]}',
        args: { questions: [{ id: 'direction' }] },
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-5',
        seq: 5,
        conversationId,
        type: 'assistant_message.completed',
        createdAt: 5,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        messageId: 'assistant-question-1',
        stopReason: 'toolUse',
        content: [{
          type: 'toolCall',
          id: 'tool-question-1',
          name: 'ask_user_question',
          arguments: { questions: [{ id: 'direction' }] },
        }],
      },
      {
        v: AGENT_EVENT_VERSION,
        eventId: 'event-6',
        seq: 6,
        conversationId,
        type: 'user_question.requested',
        createdAt: 6,
        actor: { type: 'agent', agentId: 'built-in:tenon:assistant' },
        runId: 'run-1',
        requestId: 'question-1',
        toolCallId: 'tool-question-1',
        request: {
          questions: [{
            id: 'direction',
            type: 'single_choice',
            question: 'Which path?',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          }],
        },
      },
    ];
    await new AgentEventStore(dataRoot).appendEvents(conversationId, events);
    const { runtime } = await createRuntime(dataRoot);

    await runtime.resolveUserQuestion(conversationId, 'question-1', {
      requestId: 'question-1',
      outcome: 'discussed',
      discuss: { message: 'Can we discuss the tradeoffs first?' },
      answers: [],
    });

    const replay = await new AgentEventStore(dataRoot).replay(conversationId);
    expect(replay.userQuestions['question-1']).toMatchObject({
      status: 'answered',
      result: {
        requestId: 'question-1',
        outcome: 'discussed',
        discuss: { message: 'Can we discuss the tradeoffs first?' },
        answers: [],
      },
    });
    const toolResult = getAgentEventActivePath(replay).find(
      (message) => message.role === 'toolResult' && message.toolCallId === 'tool-question-1',
    );
    const visible = JSON.parse((toolResult?.content[0] as { text: string }).text);
    expect(visible).toMatchObject({
      ok: true,
      data: {
        requestId: 'question-1',
        outcome: 'discussed',
        discuss: { message: 'Can we discuss the tradeoffs first?' },
        answers: [],
      },
    });
    expect(visible.instructions).toContain('discuss before answering');
  });
});

describe('resolveAgentToolFilter', () => {
  const CORE_TOOLS = ['past_chats', 'node_create', 'node_edit', 'node_read', 'skill'] as const;

  test('external (file) agents keep a strict allow-list passthrough', async () => {
    const { resolveAgentToolFilter } = await loadRuntimeModule();
    expect(
      resolveAgentToolFilter({ isBuiltIn: false, tools: ['file_read', 'bash'], disallowedTools: ['web_fetch'] }),
    ).toEqual({ allowedTools: ['file_read', 'bash'], disallowedTools: ['web_fetch'] });
  });

  test('built-in with no restriction or an explicit `*` never sets an allow-list', async () => {
    const { resolveAgentToolFilter } = await loadRuntimeModule();
    expect(resolveAgentToolFilter({ isBuiltIn: true, tools: undefined, disallowedTools: undefined }))
      .toEqual({ allowedTools: undefined, disallowedTools: undefined });
    expect(resolveAgentToolFilter({ isBuiltIn: true, tools: ['*'], disallowedTools: ['web_fetch'] }))
      .toEqual({ allowedTools: undefined, disallowedTools: ['web_fetch'] });
  });

  test('a built-in catalog restriction becomes a disallow-list over the unchecked catalog — never an allow-list, so core tools stay on', async () => {
    const { resolveAgentToolFilter } = await loadRuntimeModule();
    const result = resolveAgentToolFilter({ isBuiltIn: true, tools: ['file_read', 'bash'], disallowedTools: undefined });
    // No allow-list — a strict allow-list would also strip Neva's core tools.
    expect(result.allowedTools).toBeUndefined();
    // Exactly the catalog tools the user left unchecked are disallowed.
    expect(result.disallowedTools).toEqual(TOOL_CATALOG.filter((name) => name !== 'file_read' && name !== 'bash'));
    // No core tool ever leaks into the disallow-list.
    for (const core of CORE_TOOLS) expect(result.disallowedTools).not.toContain(core);
  });

  test('a built-in restriction merges with an explicit disallow-list without duplicates', async () => {
    const { resolveAgentToolFilter } = await loadRuntimeModule();
    const result = resolveAgentToolFilter({ isBuiltIn: true, tools: ['file_read'], disallowedTools: ['bash', 'web_fetch'] });
    expect(result.allowedTools).toBeUndefined();
    expect(result.disallowedTools).toEqual([
      'bash',
      'web_fetch',
      ...TOOL_CATALOG.filter((name) => name !== 'file_read' && name !== 'bash' && name !== 'web_fetch'),
    ]);
    expect(new Set(result.disallowedTools).size).toBe(result.disallowedTools!.length);
  });
});

describe('builtInModelEffortChanged', () => {
  test('a persona/display-name-only edit (model + effort round-tripped unchanged) is not a change', async () => {
    const { builtInModelEffortChanged } = await loadRuntimeModule();
    // The composer chip and the editor both re-send the existing model/effort.
    // Re-resolving on such an edit would silently swap a live conversation's
    // model when the active provider had changed since setup — the #2 bug.
    expect(builtInModelEffortChanged({ model: 'inherit', effort: '' }, { model: 'inherit', effort: '' })).toBe(false);
    expect(builtInModelEffortChanged({ model: 'openai/gpt-5.4', effort: 'high' }, { model: 'openai/gpt-5.4', effort: 'high' })).toBe(false);
  });

  test('the unset sentinels (undefined / blank / whitespace / `inherit`) all normalize together', async () => {
    const { builtInModelEffortChanged } = await loadRuntimeModule();
    expect(builtInModelEffortChanged({ model: undefined, effort: undefined }, { model: 'inherit', effort: '' })).toBe(false);
    expect(builtInModelEffortChanged({ model: '  ', effort: '  ' }, { model: 'inherit', effort: '' })).toBe(false);
    expect(builtInModelEffortChanged({ model: null, effort: null }, { model: undefined, effort: undefined })).toBe(false);
  });

  test('an actual model or effort move is a change', async () => {
    const { builtInModelEffortChanged } = await loadRuntimeModule();
    expect(builtInModelEffortChanged({ model: 'inherit', effort: '' }, { model: 'openai/gpt-5.4', effort: '' })).toBe(true);
    expect(builtInModelEffortChanged({ model: 'openai/gpt-5.4', effort: 'low' }, { model: 'openai/gpt-5.4', effort: 'high' })).toBe(true);
    // Setting an explicit model that happens to equal `inherit`'s resolution is
    // still an unset model — not a change.
    expect(builtInModelEffortChanged({ model: 'inherit', effort: 'high' }, { model: '', effort: 'high' })).toBe(false);
  });
});
