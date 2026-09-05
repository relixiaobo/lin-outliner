import { turnTerminalAnswer } from '../../../core/agent/turnAnswer';
import type { ThreadId } from '../../../core/agent/protocol';
import type { DelegateExecutionResult, DelegateUsage } from '../../../delegate/contract';
import type { ThreadService } from '../ThreadService';
import {
  AgentWorktree,
  type AgentWorktreeMetadata,
  type AgentWorktreeRecoveryIntent,
} from '../worktree/AgentWorktree';
import type {
  DelegationSessionCommitInput,
  DelegationSessionRunInput,
  DelegationSessionRuntime,
} from './DelegationCoordinator';
import type { DelegationSessionBinding } from './delegationSessionTypes';
import { DelegationSessionStore } from './DelegationSessionStore';
import type { DelegationRunnerRegistry } from './DelegationPolicyResolver';

/** Runs delegated work through the canonical Thread/Turn executor. */
export class InternalDelegationSessionRuntime implements DelegationSessionRuntime {
  constructor(
    private readonly threads: ThreadService,
    private readonly store: DelegationSessionStore,
    private readonly worktrees: AgentWorktree,
    private readonly now: () => number = Date.now,
    private readonly runners: DelegationRunnerRegistry | null = null,
  ) {}

  async ensureSession(session: DelegationSessionBinding): Promise<void> {
    const current = session.policy.worktreePolicy === 'dedicated'
      ? await this.ensureWorktree(session)
      : session;
    await this.threads.ensureDelegationThread(current);
  }

  async run(input: DelegationSessionRunInput): Promise<DelegateExecutionResult> {
    const adapter = this.runners?.adapter(input.session.policy.runnerId);
    if (input.session.policy.runnerId !== 'internal' && !adapter?.run) {
      throw new Error(`Delegation Runner is not executable: ${input.session.policy.runnerId}`);
    }
    if (input.session.policy.runnerId !== 'internal' && adapter?.run) {
      const result = await adapter.run(input);
      if (result.adapterSessionId) {
        const current = this.store.readSession(input.session.sessionId) ?? input.session;
        this.store.setAdapterSessionId(
          current.sessionId,
          current.revision,
          result.adapterSessionId,
          this.now(),
        );
      }
      const workspace = await this.workspaceResult(input.session.sessionId);
      return {
        ...result,
        artifacts: result.artifacts.length > 0 ? result.artifacts : workspace.artifacts,
        worktree: workspace.result,
      };
    }
    const content = input.messages.length === 0
      ? input.prompt
      : input.messages.map((message) => message.text).filter((text): text is string => text !== null).join('\n\n');
    const interrupt = () => {
      void this.threads.interruptDelegationTurn(input.session.sessionId, input.turnId).catch(() => undefined);
    };
    input.signal.addEventListener('abort', interrupt, { once: true });
    try {
      await this.threads.startPrivilegedTurn({
        threadId: input.session.sessionId,
        turnId: input.turnId,
        input: [{ type: 'text', text: content }],
        author: { kind: 'feature', feature: 'delegation', ref: input.session.ownerThreadId },
        trigger: { kind: 'feature', feature: 'delegation', ref: input.session.currentTaskId ?? undefined },
      });
      if (input.signal.aborted) interrupt();
      await this.threads.waitForIdle(input.session.sessionId);
      const turn = this.threads.readTurnForHost(input.session.sessionId, input.turnId);
      if (!turn || turn.status === 'inProgress') throw new Error('Delegated Turn did not reach a terminal state.');
      const outcome = turn.status === 'completed'
        ? 'succeeded'
        : turn.status === 'interrupted'
          ? 'cancelled'
          : 'failed';
      const text = turnTerminalAnswer(turn.items) || null;
      const workspace = await this.workspaceResult(input.session.sessionId);
      return {
        version: 1,
        kind: 'delegate.execution-result',
        sessionId: input.session.sessionId,
        turnId: input.turnId,
        outcome,
        runner: { id: input.session.policy.runnerId, version: input.session.policy.runnerVersion },
        model: input.session.policy.modelId === null || input.session.policy.modelProvider === null
          ? null
          : `${input.session.policy.modelProvider}/${input.session.policy.modelId}`,
        durationMs: turn.durationMs ?? 0,
        text,
        error: outcome === 'succeeded' ? null : turn.error?.message ?? `Delegated execution ${outcome}.`,
        partialEvidence: outcome !== 'succeeded' && text !== null,
        committedMessageSequence: input.messages.at(-1)?.sequence ?? input.session.messageSequence,
        continuation: 'available',
        usage: delegateUsage(turn.execution.usage),
        artifacts: workspace.artifacts,
        worktree: workspace.result,
      };
    } finally {
      input.signal.removeEventListener('abort', interrupt);
    }
  }

  async commitResult(input: DelegationSessionCommitInput): Promise<void> {
    const turn = this.threads.readTurnForHost(input.session.sessionId, input.turnId);
    if (!turn || turn.status === 'inProgress') {
      throw new Error('Canonical delegated Turn is unavailable for settlement.');
    }
  }

  send(_sessionId: ThreadId): boolean {
    // Root messages remain queued until the next explicit Turn. This preserves
    // exact delivery evidence without claiming an in-flight provider accepted them.
    return false;
  }

  async close(session: DelegationSessionBinding): Promise<void> {
    let current = this.store.readSession(session.sessionId) ?? session;
    if (current.policy.worktreePolicy === 'dedicated') {
      if (current.worktree.kind === 'none' || current.worktree.kind === 'planned') {
        current = await this.ensureWorktree(current);
      }
      if (current.worktree.kind === 'active' || current.worktree.kind === 'unchanged'
        || current.worktree.kind === 'changed' || current.worktree.kind === 'retained') {
        const metadata = current.worktree.metadata;
        try {
          const inspection = await this.worktrees.inspect(metadata);
          if (inspection.changedFiles.length > 0) {
            this.store.setWorktree(
              current.sessionId,
              current.revision,
              { kind: 'retained', metadata },
              this.now(),
            );
          } else {
            const settled = await this.worktrees.settle(metadata);
            this.store.setWorktree(
              current.sessionId,
              current.revision,
              settled.retained
                ? { kind: 'retained', metadata: settled.worktree }
                : { kind: 'cleaned', baseRevision: settled.worktree.baseCommit },
              this.now(),
            );
          }
        } catch (error) {
          this.markAmbiguous(current, worktreeIntent(metadata), metadata);
          throw error;
        }
      }
    }
    await this.threads.closeDelegationThread(session.sessionId);
  }

  async prepareOwnerDeletion(session: DelegationSessionBinding): Promise<void> {
    let current = this.store.readSession(session.sessionId) ?? session;
    if (current.policy.worktreePolicy === 'dedicated') {
      if (current.worktree.kind === 'ambiguous') {
        throw new Error(`Delegation worktree recovery is ambiguous: ${current.worktree.intent.path}`);
      }
      if (current.worktree.kind === 'planned') {
        if (current.state !== 'open') {
          throw new Error(`Closed Delegation worktree recovery is incomplete: ${current.worktree.intent.path}`);
        }
        current = await this.ensureWorktree(current);
      }
      if (current.worktree.kind === 'active' || current.worktree.kind === 'unchanged'
        || current.worktree.kind === 'changed' || current.worktree.kind === 'retained') {
        const metadata = current.worktree.metadata;
        const intent = worktreeIntent(metadata);
        let recovery;
        try {
          recovery = await this.worktrees.recover({
            agentId: current.sessionId,
            intent,
            previous: metadata,
          });
        } catch (error) {
          this.markAmbiguous(current, intent, metadata);
          throw error;
        }
        if (recovery.status === 'absent') {
          current = this.store.setWorktree(
            current.sessionId,
            current.revision,
            { kind: 'cleaned', baseRevision: metadata.baseCommit },
            this.now(),
          );
        } else {
          if (recovery.status !== 'recovered') {
            this.markAmbiguous(current, intent, metadata);
            throw new Error(`Delegation worktree recovery is incomplete: ${metadata.path}`);
          }
          let inspection;
          try {
            inspection = await this.worktrees.inspect(metadata);
          } catch (error) {
            this.markAmbiguous(current, intent, metadata);
            throw error;
          }
          if (inspection.changedFiles.length > 0) {
            this.store.setWorktree(
              current.sessionId,
              current.revision,
              { kind: 'retained', metadata },
              this.now(),
            );
            throw new Error(`Delegation worktree retains changes: ${metadata.path}`);
          }
          let settled;
          try {
            settled = await this.worktrees.settle(metadata);
          } catch (error) {
            this.markAmbiguous(current, intent, metadata);
            throw error;
          }
          if (settled.retained) {
            this.store.setWorktree(
              current.sessionId,
              current.revision,
              { kind: 'retained', metadata: settled.worktree },
              this.now(),
            );
            throw new Error(`Delegation worktree retains changes: ${metadata.path}`);
          }
          current = this.store.setWorktree(
            current.sessionId,
            current.revision,
            { kind: 'cleaned', baseRevision: settled.worktree.baseCommit },
            this.now(),
          );
        }
      }
    }
    await this.threads.closeDelegationThread(current.sessionId);
  }

  private async ensureWorktree(sessionInput: DelegationSessionBinding): Promise<DelegationSessionBinding> {
    let session = this.store.readSession(sessionInput.sessionId) ?? sessionInput;
    if (session.worktree.kind === 'cleaned') {
      throw new Error('Closed Delegation worktree cannot be resumed.');
    }
    if (session.worktree.kind === 'ambiguous') {
      throw new Error(`Delegation worktree recovery is ambiguous: ${session.worktree.intent.path}`);
    }
    if (session.worktree.kind === 'none') {
      const intent = await this.worktrees.plan({
        agentId: session.sessionId,
        cwd: session.policy.cwd,
        previous: null,
      });
      session = this.store.setWorktree(
        session.sessionId,
        session.revision,
        { kind: 'planned', intent },
        this.now(),
      );
    }
    if (session.worktree.kind === 'planned') {
      const intent = session.worktree.intent;
      try {
        let recovery = await this.worktrees.recover({
          agentId: session.sessionId,
          intent,
          previous: null,
        });
        if (recovery.status === 'residual') {
          recovery = await this.worktrees.cleanupResidual({
            agentId: session.sessionId,
            intent,
            previous: null,
          });
        }
        const prepared = recovery.status === 'recovered'
          ? recovery.prepared
          : recovery.status === 'absent'
            ? await this.worktrees.prepare({ agentId: session.sessionId, intent })
            : null;
        if (!prepared) throw new Error(`Delegation worktree residue requires recovery: ${intent.path}`);
        return this.store.setWorktree(
          session.sessionId,
          session.revision,
          { kind: 'active', metadata: prepared.worktree },
          this.now(),
        );
      } catch (error) {
        this.markAmbiguous(session, intent, null);
        throw new Error(`Delegation Session ${session.sessionId} worktree preparation failed.`, { cause: error });
      }
    }
    if (session.worktree.kind !== 'active' && session.worktree.kind !== 'unchanged'
      && session.worktree.kind !== 'changed' && session.worktree.kind !== 'retained') {
      throw new Error('Delegation worktree did not reach an active state.');
    }
    const metadata = session.worktree.metadata;
    const intent = worktreeIntent(metadata);
    try {
      const recovery = await this.worktrees.recover({
        agentId: session.sessionId,
        intent,
        previous: metadata,
      });
      if (recovery.status !== 'recovered') {
        throw new Error(`Delegation worktree is unavailable for continuation: ${intent.path}`);
      }
      return session;
    } catch (error) {
      this.markAmbiguous(session, intent, metadata);
      throw error;
    }
  }

  private async workspaceResult(sessionId: ThreadId): Promise<{
    readonly artifacts: DelegateExecutionResult['artifacts'];
    readonly result: DelegateExecutionResult['worktree'];
  }> {
    const session = this.store.readSession(sessionId);
    if (!session || session.policy.worktreePolicy === 'none') {
      return { artifacts: [], result: { disposition: 'none' } };
    }
    const disposition = session.worktree;
    if (disposition.kind !== 'active' && disposition.kind !== 'unchanged'
      && disposition.kind !== 'changed' && disposition.kind !== 'retained') {
      throw new Error('Delegation worktree is unavailable for result inspection.');
    }
    const metadata = disposition.metadata;
    try {
      const inspection = await this.worktrees.inspect(metadata);
      const current = this.store.readSession(sessionId)!;
      if (inspection.changedFiles.length === 0) {
        this.store.setWorktree(sessionId, current.revision, { kind: 'unchanged', metadata }, this.now());
        return {
          artifacts: [],
          result: {
            disposition: 'unchanged',
            path: metadata.path,
            baseRevision: metadata.baseCommit,
          },
        };
      }
      const ref = await this.threads.writeThreadResource(
        session.ownerThreadId,
        Buffer.from(inspection.patch, 'utf8'),
        'text/x-diff',
        `delegation-${session.sessionId}.patch`,
      );
      const patchRef = JSON.stringify(ref);
      this.store.setWorktree(sessionId, current.revision, { kind: 'changed', metadata }, this.now());
      return {
        artifacts: [{ kind: 'patch', ref: patchRef }],
        result: {
          disposition: 'changed',
          path: metadata.path,
          baseRevision: metadata.baseCommit,
          changedFiles: [...inspection.changedFiles],
          patchRef,
          verification: [],
        },
      };
    } catch (error) {
      const current = this.store.readSession(sessionId)!;
      this.markAmbiguous(current, worktreeIntent(metadata), metadata);
      throw error;
    }
  }

  private markAmbiguous(
    session: DelegationSessionBinding,
    intent: AgentWorktreeRecoveryIntent,
    metadata: AgentWorktreeMetadata | null,
  ): void {
    const current = this.store.readSession(session.sessionId) ?? session;
    if (current.worktree.kind === 'ambiguous') return;
    this.store.setWorktree(
      current.sessionId,
      current.revision,
      { kind: 'ambiguous', intent, metadata },
      this.now(),
    );
  }
}

function worktreeIntent(metadata: AgentWorktreeMetadata): AgentWorktreeRecoveryIntent {
  return {
    sourceCwd: metadata.sourceCwd,
    path: metadata.path,
    branch: metadata.branch,
    baseCommit: metadata.baseCommit,
    gitCommonDir: metadata.gitCommonDir,
  };
}

function delegateUsage(usage: {
  readonly input: number;
  readonly output: number;
  readonly cost: { readonly total: number } | null;
}): DelegateUsage {
  if (usage.input === 0 && usage.output === 0 && (usage.cost?.total ?? 0) === 0) return { state: 'unknown' };
  return {
    state: 'known',
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cost ? { costUsd: usage.cost.total } : {}),
  };
}
