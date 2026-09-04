import { createHash } from 'node:crypto';
import type { ThreadId, TurnId } from '../../../core/agent/protocol';
import { createKeyedSerialMutationQueue } from '../../../core/serialMutationQueue';
import {
  canonicalDelegateCommand,
  decodeDelegateMessageInput,
  decodeDelegateExecutionResult,
  decodeDelegateRunInput,
  type DelegateCloseReceipt,
  type DelegateExecutionResult,
  type DelegateMessageReceipt,
} from '../../../delegate/contract';
import { uuidV7 } from '../uuid';
import {
  DelegateCapabilityRefusal,
  type DelegateCapabilityExecution,
} from './DelegateCapabilityBroker';
import {
  DelegationSessionStore,
  EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST,
} from './DelegationSessionStore';
import type {
  DelegationPolicySnapshot,
  DelegationExecutionSettlement,
  DelegationRootMessage,
  DelegationSessionBinding,
} from './delegationSessionTypes';

export interface DelegationSessionRunInput {
  readonly session: DelegationSessionBinding;
  readonly turnId: TurnId;
  readonly prompt: string;
  readonly messages: readonly DelegationRootMessage[];
  readonly signal: AbortSignal;
}

export interface DelegationSessionRuntime {
  ensureSession(session: DelegationSessionBinding): Promise<void>;
  run(input: DelegationSessionRunInput): Promise<DelegateExecutionResult>;
  commitResult(input: DelegationSessionCommitInput): Promise<void>;
  send(
    sessionId: ThreadId,
    message: DelegationRootMessage,
    onDelivered: () => void,
  ): boolean;
  close(session: DelegationSessionBinding): Promise<void>;
}

export interface DelegationSessionCommitInput {
  readonly session: DelegationSessionBinding;
  readonly turnId: TurnId;
  readonly result: DelegateExecutionResult;
  readonly settlementId: string;
  readonly requestDigest: string;
  readonly messageSequenceDigest: string;
  readonly preparedResultDigest: string;
}

export interface DelegationPreparedResultStore {
  prepare(
    taskId: string,
    ownerThreadId: ThreadId,
    bytes: Uint8Array,
  ): Promise<{ readonly sha256: string }>;
  read(taskId: string, ownerThreadId: ThreadId): Promise<Uint8Array | null>;
}

export interface DelegationFinalReceiptEvidence {
  readonly taskId: string;
  readonly preparedResultDigest: string | null;
  readonly receiptDigest: string;
}

export type DelegationFinalReceiptSettlement =
  | { readonly outcome: 'unrelated' | 'committed' }
  | { readonly outcome: 'blocked'; readonly reason: string };

export interface DelegationUserStopInput {
  readonly taskId: string;
  readonly ownerThreadId: ThreadId;
  readonly stoppedByRootTurnId: TurnId;
  readonly currentRootIntentRevision: number;
}

export type DelegationUserStopSettlement =
  | { readonly outcome: 'unrelated' }
  | {
    readonly outcome: 'fenced';
    readonly sessionId: ThreadId;
    readonly minimumResumeRevision: number;
  };

export interface DelegationCoordinatorOptions {
  readonly store: DelegationSessionStore;
  readonly runtime: DelegationSessionRuntime;
  readonly preparedResults: DelegationPreparedResultStore;
  readonly now?: () => number;
}

interface PreparedDelegationTurn {
  readonly execution: DelegateCapabilityExecution;
  readonly session: DelegationSessionBinding;
  readonly turnId: TurnId;
  readonly prompt: string;
  readonly messages: readonly DelegationRootMessage[];
  readonly requestDigest: string;
  readonly settlementId: string;
}

/**
 * Coordinates CLI commands across the durable Session binding and the canonical
 * hidden Thread runtime. Generic Tool Tasks remain the only process authority.
 */
export class DelegationCoordinator {
  private readonly gates = createKeyedSerialMutationQueue();
  private readonly sessionWaiters = new Map<ThreadId, Set<() => void>>();
  private readonly now: () => number;

  constructor(private readonly options: DelegationCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  execute(execution: DelegateCapabilityExecution): Promise<unknown> {
    if (execution.admission.command.name === 'run') return this.run(execution);
    if (execution.admission.command.name === 'send') return this.send(execution);
    return this.close(execution);
  }

  async fenceUserStop(input: DelegationUserStopInput): Promise<DelegationUserStopSettlement> {
    const initial = this.options.store.settlementForTask(input.taskId);
    if (!initial) return { outcome: 'unrelated' };
    const result = await this.gates.run(initial.sessionId, async () => {
      const settlement = this.options.store.settlementForTask(input.taskId);
      if (!settlement) return { outcome: 'unrelated' } as const;
      const session = this.options.store.readSession(settlement.sessionId);
      if (!session || session.ownerThreadId !== input.ownerThreadId) {
        throw unauthorized('Delegate Session is not owned by the Tool Task root Thread.');
      }
      const fenced = this.options.store.fenceUserStop({
        sessionId: session.sessionId,
        expectedRevision: session.revision,
        cancelledTaskId: input.taskId,
        stoppedByRootTurnId: input.stoppedByRootTurnId,
        currentRootIntentRevision: input.currentRootIntentRevision,
        now: this.now(),
      });
      return {
        outcome: 'fenced',
        sessionId: fenced.sessionId,
        minimumResumeRevision: fenced.stopFence!.minimumResumeRevision,
      } as const;
    });
    this.notifySession(initial.sessionId);
    return result;
  }

  async settleFinalReceipt(
    evidence: DelegationFinalReceiptEvidence,
  ): Promise<DelegationFinalReceiptSettlement> {
    const initial = this.options.store.settlementForTask(evidence.taskId);
    if (!initial) return { outcome: 'unrelated' };
    return this.gates.run(initial.sessionId, async () => {
      let settlement = this.options.store.settlementForTask(evidence.taskId);
      if (!settlement) return { outcome: 'unrelated' } as const;
      if (!evidence.preparedResultDigest) {
        const blocked = this.options.store.blockSettlement(
          settlement.settlementId,
          'Delegation final receipt is missing prepared result evidence',
          this.now(),
        );
        this.options.store.releaseExecution(settlement.sessionId, evidence.taskId, this.now());
        this.notifySession(settlement.sessionId);
        return { outcome: 'blocked', reason: blocked.blockedReason! } as const;
      }
      try {
        settlement = await this.ensurePreparedContext(settlement, evidence.preparedResultDigest);
      } catch (error) {
        const blocked = this.options.store.blockSettlement(
          settlement.settlementId,
          `Delegation prepared-result recovery failed: ${errorMessage(error)}`,
          this.now(),
        );
        this.options.store.releaseExecution(settlement.sessionId, evidence.taskId, this.now());
        this.notifySession(settlement.sessionId);
        return { outcome: 'blocked', reason: blocked.blockedReason! } as const;
      }
      let reconciled = this.options.store.recordFinalReceipt({
        settlementId: settlement.settlementId,
        taskId: evidence.taskId,
        preparedResultDigest: evidence.preparedResultDigest,
        finalReceiptDigest: evidence.receiptDigest,
        now: this.now(),
      });
      if (reconciled.state !== 'blocked') {
        reconciled = this.options.store.commitSettlement({
          settlementId: settlement.settlementId,
          taskId: evidence.taskId,
          preparedResultDigest: evidence.preparedResultDigest,
          finalReceiptDigest: evidence.receiptDigest,
          now: this.now(),
        });
      }
      this.options.store.releaseExecution(settlement.sessionId, evidence.taskId, this.now());
      this.notifySession(settlement.sessionId);
      return reconciled.state === 'blocked'
        ? { outcome: 'blocked', reason: reconciled.blockedReason! } as const
        : { outcome: 'committed' } as const;
    });
  }

  private async run(execution: DelegateCapabilityExecution): Promise<DelegateExecutionResult> {
    const admission = execution.admission;
    if (admission.command.name !== 'run' || admission.session.kind !== 'run') {
      throw unauthorized('Delegate run capability does not match its Session binding.');
    }
    const sessionBinding = admission.session;
    const input = decodeDelegateRunInput(execution.input);
    if (input.profile !== admission.policy.profile) {
      throw unauthorized('Delegate run profile does not match its admitted policy.');
    }
    const prepared = await this.gates.run(sessionBinding.preallocatedSessionId, async () => {
      const session = this.options.store.createSession({
        sessionId: sessionBinding.preallocatedSessionId as ThreadId,
        ownerThreadId: admission.source.rootThreadId as ThreadId,
        policy: policySnapshot(execution),
        now: this.now(),
      });
      await this.options.runtime.ensureSession(session);
      return this.prepareTurn(execution, session, input.prompt, []);
    });
    return this.executePreparedTurn(prepared);
  }

  private async send(
    execution: DelegateCapabilityExecution,
  ): Promise<DelegateMessageReceipt | DelegateExecutionResult> {
    const admission = execution.admission;
    if (admission.command.name !== 'send' || admission.session.kind !== 'send') {
      throw unauthorized('Delegate send capability does not match its Session binding.');
    }
    const sessionBinding = admission.session;
    const input = decodeDelegateMessageInput(execution.input);
    let messageAdmitted = false;
    let steeringTaskId: string | null = null;
    while (true) {
      if (execution.signal.aborted) throw unavailable('Delegate message execution was cancelled.');
      const step = await this.gates.run(sessionBinding.sessionId, async () => {
        let session = this.requireOwnedSession(execution);
        if (!messageAdmitted) {
          if (session.revision !== sessionBinding.sessionRevision) {
            throw unavailable('Delegate Session changed before this message was admitted.');
          }
          if (session.stopFence) {
            session = this.options.store.clearUserStopFence({
              sessionId: session.sessionId,
              expectedRevision: session.revision,
              rootTurnId: admission.source.sourceTurnId as TurnId,
              rootIntentRevision: admission.source.rootUserIntentRevision,
              now: this.now(),
            });
          }
          this.options.store.appendMessage({
            sessionId: session.sessionId,
            expectedRevision: session.revision,
            messageId: execution.capabilityId,
            text: input.message,
            sourceTaskId: admission.toolTaskId,
            sourceRootTurnId: admission.source.sourceTurnId as TurnId,
            sourceRootItemId: admission.source.sourceItemId,
            sourceRootIntentRevision: admission.source.rootUserIntentRevision,
            now: this.now(),
          });
          messageAdmitted = true;
          session = this.options.store.readSession(session.sessionId)!;
        }
        const message = this.options.store.readMessage(execution.capabilityId);
        if (!message) throw unavailable('Delegate message admission is unavailable.');
        if (message.state !== 'queued') {
          const consumingTaskId = message.state === 'committed'
            ? session.currentTaskId ?? session.previousTaskId
            : null;
          return { kind: 'receipt' as const, value: messageReceipt(message, consumingTaskId) };
        }
        if (!session.currentTaskId) {
          const queued = this.options.store.queuedMessages(session.sessionId);
          const first = queued[0];
          if (!first?.text) throw unavailable('Delegate message prefix is unavailable.');
          return {
            kind: 'turn' as const,
            value: this.prepareTurn(execution, session, first.text, queued),
          };
        }
        const wait = this.waitForSessionChange(session.sessionId, execution.signal);
        const settlement = this.options.store.settlementForTask(session.currentTaskId);
        if (settlement?.state === 'awaiting_result'
          && message.sequence > settlement.messageSequence
          && steeringTaskId !== session.currentTaskId) {
          const accepted = this.options.runtime.send(session.sessionId, message, () => {
            void this.commitActiveMessage(session.sessionId, message).catch(() => undefined);
          });
          if (accepted) steeringTaskId = session.currentTaskId;
        }
        return { kind: 'wait' as const, value: wait };
      });
      if (step.kind === 'receipt') return step.value;
      if (step.kind === 'turn') return this.executePreparedTurn(step.value);
      await step.value;
    }
  }

  private async close(execution: DelegateCapabilityExecution): Promise<DelegateCloseReceipt> {
    const admission = execution.admission;
    if (admission.command.name !== 'close' || admission.session.kind !== 'close') {
      throw unauthorized('Delegate close capability does not match its Session binding.');
    }
    const sessionBinding = admission.session;
    return this.gates.run(sessionBinding.sessionId, async () => {
      const session = this.requireOwnedSession(execution);
      if (session.revision !== sessionBinding.sessionRevision) {
        throw unavailable('Delegate Session changed before closure was admitted.');
      }
      await this.options.runtime.close(session);
      this.options.store.closeSession(session.sessionId, session.revision, this.now());
      return {
        version: 1,
        kind: 'delegate.close-receipt',
        sessionId: session.sessionId,
        closed: true,
      };
    });
  }

  private prepareTurn(
    execution: DelegateCapabilityExecution,
    sessionInput: DelegationSessionBinding,
    prompt: string,
    messages: readonly DelegationRootMessage[],
  ): PreparedDelegationTurn {
    const session = this.options.store.readSession(sessionInput.sessionId) ?? sessionInput;
    const messageSequence = messages.at(-1)?.sequence ?? session.messageSequence;
    const messageSequenceDigest = messageSequence === 0
      ? EMPTY_DELEGATION_MESSAGE_SEQUENCE_DIGEST
      : this.options.store.messageSequenceDigest(session.sessionId, messageSequence);
    const turnId = uuidV7(this.now());
    const requestDigest = executionDigest(execution, messageSequenceDigest);
    const settlement = this.options.store.reserveExecution({
      settlementId: execution.capabilityId,
      sessionId: session.sessionId,
      expectedRevision: session.revision,
      turnId,
      taskId: execution.admission.toolTaskId,
      requestDigest,
      messageSequence,
      messageSequenceDigest,
      now: this.now(),
    });
    return {
      execution,
      session: this.options.store.readSession(session.sessionId)!,
      turnId,
      prompt,
      messages,
      requestDigest,
      settlementId: settlement.settlementId,
    };
  }

  private async executePreparedTurn(preparedTurn: PreparedDelegationTurn): Promise<DelegateExecutionResult> {
    let result: DelegateExecutionResult;
    try {
      const running = this.options.runtime.run({
        session: preparedTurn.session,
        turnId: preparedTurn.turnId,
        prompt: preparedTurn.prompt,
        messages: preparedTurn.messages,
        signal: preparedTurn.execution.signal,
      });
      this.notifySession(preparedTurn.session.sessionId);
      result = await running;
    } finally {
      this.notifySession(preparedTurn.session.sessionId);
    }
    const committed = await this.gates.run(preparedTurn.session.sessionId, async () => {
      assertRuntimeResult(result, preparedTurn.session.sessionId, preparedTurn.turnId);
      const settlement = this.options.store.readSettlement(preparedTurn.settlementId);
      if (!settlement || settlement.state !== 'awaiting_result') {
        throw unavailable('Delegation settlement is no longer available for this result.');
      }
      if (result.committedMessageSequence !== settlement.messageSequence) {
        this.options.store.blockSettlement(
          settlement.settlementId,
          'Internal Delegate Runner committed message sequence does not match Session evidence',
          this.now(),
        );
        throw unavailable('Delegated message settlement could not be committed safely.');
      }
      const bytes = Buffer.from(JSON.stringify(result), 'utf8');
      const prepared = await this.options.preparedResults.prepare(
        preparedTurn.execution.admission.toolTaskId,
        preparedTurn.session.ownerThreadId,
        bytes,
      );
      const expectedDigest = createHash('sha256').update(bytes).digest('hex');
      if (prepared.sha256 !== expectedDigest) {
        this.options.store.blockSettlement(
          settlement.settlementId,
          'Prepared Tool Task result digest does not match the delegated result',
          this.now(),
        );
        throw unavailable('Delegated result could not be committed safely.');
      }
      this.options.store.prepareSettlement({
        settlementId: settlement.settlementId,
        requestDigest: preparedTurn.requestDigest,
        preparedResultDigest: prepared.sha256,
        now: this.now(),
      });
      if (settlement.messageSequence > 0) {
        const current = this.options.store.readSession(settlement.sessionId)!;
        this.options.store.commitMessagePrefix(
          settlement.sessionId,
          current.revision,
          settlement.messageSequence,
          preparedTurn.turnId,
          this.now(),
        );
      }
      await this.options.runtime.commitResult({
        session: this.options.store.readSession(settlement.sessionId)!,
        turnId: preparedTurn.turnId,
        result,
        settlementId: settlement.settlementId,
        requestDigest: preparedTurn.requestDigest,
        messageSequenceDigest: settlement.messageSequenceDigest,
        preparedResultDigest: prepared.sha256,
      });
      this.options.store.commitSettlementContext({
        settlementId: settlement.settlementId,
        turnId: preparedTurn.turnId,
        requestDigest: preparedTurn.requestDigest,
        messageSequenceDigest: settlement.messageSequenceDigest,
        preparedResultDigest: prepared.sha256,
        now: this.now(),
      });
      return result;
    });
    this.notifySession(preparedTurn.session.sessionId);
    return committed;
  }

  private async ensurePreparedContext(
    settlementInput: DelegationExecutionSettlement,
    preparedResultDigest: string,
  ): Promise<DelegationExecutionSettlement> {
    let settlement = settlementInput;
    if (settlement.state === 'context_committed'
      || settlement.state === 'committed'
      || settlement.state === 'blocked') return settlement;
    const session = this.options.store.readSession(settlement.sessionId);
    if (!session) throw new Error(`Delegation Session is unavailable: ${settlement.sessionId}`);
    const bytes = await this.options.preparedResults.read(settlement.taskId, session.ownerThreadId);
    if (!bytes) throw new Error('prepared result bytes are unavailable');
    const actualDigest = createHash('sha256').update(bytes).digest('hex');
    if (actualDigest !== preparedResultDigest) {
      throw new Error('prepared result bytes do not match final receipt evidence');
    }
    const result = decodeDelegateExecutionResult(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown);
    assertRuntimeResult(result, settlement.sessionId, settlement.turnId);
    if (result.committedMessageSequence !== settlement.messageSequence) {
      throw new Error('prepared result message sequence does not match settlement evidence');
    }
    if (settlement.state === 'awaiting_result') {
      settlement = this.options.store.prepareSettlement({
        settlementId: settlement.settlementId,
        requestDigest: settlement.requestDigest,
        preparedResultDigest,
        now: this.now(),
      });
    }
    if (settlement.messageSequence > 0) {
      const current = this.options.store.readSession(settlement.sessionId)!;
      this.options.store.commitMessagePrefix(
        settlement.sessionId,
        current.revision,
        settlement.messageSequence,
        settlement.turnId,
        this.now(),
      );
    }
    await this.options.runtime.commitResult({
      session: this.options.store.readSession(settlement.sessionId)!,
      turnId: settlement.turnId,
      result,
      settlementId: settlement.settlementId,
      requestDigest: settlement.requestDigest,
      messageSequenceDigest: settlement.messageSequenceDigest,
      preparedResultDigest,
    });
    return this.options.store.commitSettlementContext({
      settlementId: settlement.settlementId,
      turnId: settlement.turnId,
      requestDigest: settlement.requestDigest,
      messageSequenceDigest: settlement.messageSequenceDigest,
      preparedResultDigest,
      now: this.now(),
    });
  }

  private async commitActiveMessage(
    sessionId: ThreadId,
    message: DelegationRootMessage,
  ): Promise<void> {
    try {
      await this.gates.run(sessionId, async () => {
        const session = this.options.store.readSession(sessionId);
        if (!session || session.state !== 'open' || !session.currentTaskId) return;
        const settlement = this.options.store.settlementForTask(session.currentTaskId);
        if (!settlement || settlement.state !== 'awaiting_result') return;
        if (message.sequence <= settlement.messageSequence) return;
        this.options.store.commitMessagePrefix(
          sessionId,
          session.revision,
          message.sequence,
          settlement.turnId,
          this.now(),
        );
        this.options.store.extendSettlementMessagePrefix({
          settlementId: settlement.settlementId,
          throughSequence: message.sequence,
          messageSequenceDigest: this.options.store.messageSequenceDigest(sessionId, message.sequence),
          now: this.now(),
        });
      });
    } finally {
      this.notifySession(sessionId);
    }
  }

  private waitForSessionChange(sessionId: ThreadId, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let waiters = this.sessionWaiters.get(sessionId);
      if (!waiters) {
        waiters = new Set();
        this.sessionWaiters.set(sessionId, waiters);
      }
      const finish = () => {
        signal.removeEventListener('abort', finish);
        waiters!.delete(finish);
        if (waiters!.size === 0) this.sessionWaiters.delete(sessionId);
        resolve();
      };
      waiters.add(finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  private notifySession(sessionId: ThreadId): void {
    for (const finish of [...(this.sessionWaiters.get(sessionId) ?? [])]) finish();
  }

  private requireOwnedSession(execution: DelegateCapabilityExecution): DelegationSessionBinding {
    const binding = execution.admission.session;
    if (binding.kind === 'run') throw unauthorized('Existing Session command requires a Session binding.');
    const session = this.options.store.readSession(binding.sessionId as ThreadId);
    if (!session || session.ownerThreadId !== execution.admission.source.rootThreadId) {
      throw unauthorized('Delegate Session is not owned by the current root Thread.');
    }
    if (session.state !== 'open') throw unavailable('Delegate Session is closed.');
    return session;
  }
}

function policySnapshot(execution: DelegateCapabilityExecution): DelegationPolicySnapshot {
  const admission = execution.admission;
  return {
    runnerId: admission.policy.runnerId,
    runnerVersion: admission.policy.runnerVersion,
    modelProvider: admission.policy.modelProvider,
    modelId: admission.policy.modelId,
    effort: admission.policy.effort as DelegationPolicySnapshot['effort'],
    profile: admission.policy.profile,
    access: admission.policy.access,
    capabilityCeilingDigest: admission.policy.capabilityCeilingDigest,
    schedulingPolicyDigest: admission.policy.schedulingPolicyDigest,
    configurationRevision: admission.policy.configurationRevision,
    cwd: admission.cwd,
    worktreePolicy: admission.policy.access === 'workspace-write' ? 'dedicated' : 'none',
  };
}

function executionDigest(execution: DelegateCapabilityExecution, messageSequenceDigest: string): string {
  return createHash('sha256').update(JSON.stringify({
    command: canonicalDelegateCommand(execution.admission.command),
    input: execution.input,
    source: execution.admission.source,
    policy: execution.admission.policy,
    session: execution.admission.session,
    messageSequenceDigest,
  })).digest('hex');
}

function messageReceipt(message: DelegationRootMessage, taskId: string | null): DelegateMessageReceipt {
  return {
    version: 1,
    kind: 'delegate.message-receipt',
    sessionId: message.sessionId,
    sequence: message.sequence,
    state: message.state,
    taskId,
  };
}

function assertRuntimeResult(result: DelegateExecutionResult, sessionId: ThreadId, turnId: TurnId): void {
  if (result.kind !== 'delegate.execution-result'
    || result.version !== 1
    || result.sessionId !== sessionId
    || result.turnId !== turnId) {
    throw new Error('Internal Delegate Runner returned mismatched Session or Turn identity');
  }
}

function unauthorized(message: string): DelegateCapabilityRefusal {
  return new DelegateCapabilityRefusal('unauthorized', message);
}

function unavailable(message: string): DelegateCapabilityRefusal {
  return new DelegateCapabilityRefusal('unavailable', message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
