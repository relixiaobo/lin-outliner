import { realpath } from 'node:fs/promises';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import { threadFeatureSource, type AdditionalContext, type Thread } from '../../../core/agent/protocol';
import type {
  Automation,
  AutomationConfiguration,
  AutomationProjectBinding,
  AutomationRun,
} from '../../../core/agent/automation';
import type { ThreadService } from '../ThreadService';
import { isSubagentBudgetExhaustedError } from '../SubagentBudgetExhaustedError';
import {
  AUTOMATION_RUN_GUIDANCE,
  recentAutomationRuns,
  type AutomationRunContinuityReader,
  type RecentAutomationRun,
} from './AutomationRunContinuity';
import { AutomationStore } from './AutomationStore';
import { AutomationWorktree } from './AutomationWorktree';

export interface ResolvedAutomationConfiguration {
  readonly modelProvider: string;
  readonly configuration: EffectiveThreadConfiguration;
}

export interface AutomationDispatcherOptions {
  readonly store: AutomationStore;
  readonly threads: ThreadService;
  readonly worktrees: AutomationWorktree;
  readonly defaultCwd: string;
  readonly resolveConfiguration: (
    selection: AutomationConfiguration,
    cwd: string,
  ) => Promise<ResolvedAutomationConfiguration>;
  readonly validateEffectiveConfiguration: (
    modelProvider: string,
    configuration: EffectiveThreadConfiguration,
  ) => Promise<void>;
  readonly onRunChanged?: (run: AutomationRun) => void | Promise<void>;
  readonly now?: () => number;
}

export class AutomationDispatcher {
  private readonly now: () => number;

  constructor(private readonly options: AutomationDispatcherOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * The reader the run digest is built through. It is a narrow view on purpose:
   * everything it can do is inspection-only, so nothing it returns can be
   * mistaken for a source of truth about the run being dispatched.
   */
  private get continuity(): AutomationRunContinuityReader {
    return {
      recentRunsForBinding: (...args) => this.options.store.recentRunsForBinding(...args),
      readTurn: (threadId, turnId) => this.options.threads.readTurnForHost(threadId, turnId),
      transcriptPath: (threadId) => this.options.threads.threadTranscriptPath(threadId),
    };
  }

  async reconcile(): Promise<void> {
    await this.assertDispatchedBindings();
    for (const run of this.options.store.pendingRuns()) await this.dispatch(run);
  }

  validateConfiguration(
    selection: AutomationConfiguration,
    cwd = this.options.defaultCwd,
  ): Promise<ResolvedAutomationConfiguration> {
    return this.options.resolveConfiguration(selection, cwd);
  }

  validateResolvedConfiguration(
    modelProvider: string,
    configuration: EffectiveThreadConfiguration,
  ): Promise<void> {
    return this.options.validateEffectiveConfiguration(modelProvider, configuration);
  }

  async recoverPendingRuns(automationId: string): Promise<void> {
    for (const run of this.options.store.pendingRuns(automationId)) {
      await this.recoverAcceptedTurn(run);
    }
  }

  async dispatch(run: AutomationRun): Promise<AutomationRun> {
    const current = this.options.store.readRun(run.id);
    if (!current || current.state !== 'pending') return current ?? run;
    const recovered = await this.recoverAcceptedTurn(current);
    if (recovered) return recovered;
    let featureThreadCreated = false;
    let acceptedTurn = false;
    try {
      const workspace = await this.options.worktrees.prepare(current);
      let prepared = current;
      if (workspace.worktree && !current.worktree) {
        prepared = this.options.store.setWorktree(current.id, workspace.worktree, this.now());
        await this.changed(prepared);
      }
      const snapshot = prepared.snapshot;
      let thread: Thread;
      let executionCwd: string;
      if (snapshot.destination.kind === 'existingThread') {
        const context = this.options.threads.persistentThreadExecutionContext(snapshot.destination.threadId);
        if (context.thread.threadSource !== 'user') {
          throw new Error('An existing-Thread Automation must target a user root Thread');
        }
        if (snapshot.projectBinding && await realpath(context.thread.cwd) !== workspace.cwd) {
          throw new Error('Automation project does not match the destination Thread workspace');
        }
        assertAutomationConfigurationMatchesThread(
          snapshot.configuration,
          context.thread.modelProvider,
          context.configuration,
        );
        await this.options.validateEffectiveConfiguration(
          context.thread.modelProvider,
          context.configuration,
        );
        thread = context.thread;
        executionCwd = context.thread.cwd;
      } else {
        const cwd = workspace.cwd || this.options.defaultCwd;
        const resolved = await this.options.resolveConfiguration(snapshot.configuration, cwd);
        thread = await this.options.threads.ensureFeatureRootThread({
          id: requireThreadId(prepared),
          name: snapshot.automationName,
          source: 'agent.automation',
          threadSource: threadFeatureSource('automation'),
          modelProvider: resolved.modelProvider,
          cwd,
          configuration: resolved.configuration,
        });
        featureThreadCreated = true;
        executionCwd = cwd;
      }
      if (prepared.threadId !== thread.id) {
        prepared = this.options.store.setThread(prepared.id, thread.id, this.now());
        await this.changed(prepared);
      }
      const turn = await this.options.threads.tryStartTurnIfIdle({
        threadId: thread.id,
        input: [{ type: 'text', text: snapshot.prompt }],
        clientUserMessageId: prepared.id,
        additionalContext: await automationContext(prepared, executionCwd, this.continuity),
        trigger: { kind: 'feature', feature: 'automation', ref: prepared.id },
      });
      if (!turn) return prepared;
      acceptedTurn = true;
      const dispatched = this.options.store.markDispatched(prepared.id, thread.id, turn.id, this.now());
      await this.changed(dispatched);
      return dispatched;
    } catch (error) {
      if (isSubagentBudgetExhaustedError(error)) {
        const failed = this.options.store.markFailed(current.id, JSON.stringify({
          error: { code: error.code, message: error.message },
        }), this.now());
        await this.changed(failed);
        return failed;
      }
      let recoveredAfterFailure: AutomationRun | null;
      try {
        recoveredAfterFailure = await this.recoverAcceptedTurn(current);
      } catch (recoveryError) {
        return this.retainPending(current.id, recoveryError);
      }
      if (recoveredAfterFailure) return recoveredAfterFailure;
      if (acceptedTurn) return this.retainPending(current.id, error);
      if (featureThreadCreated && current.snapshot.destination.kind === 'standalone' && current.threadId) {
        await this.options.threads.deleteThread(current.threadId).catch(() => undefined);
      }
      const failed = this.options.store.markFailed(current.id, errorMessage(error), this.now());
      await this.changed(failed);
      return failed;
    }
  }

  isRunActive(run: AutomationRun): boolean {
    if (run.state === 'pending') return true;
    if (run.state !== 'dispatched' || !run.threadId || !run.turnId) return false;
    const turn = this.options.threads.readTurnForHost(run.threadId, run.turnId);
    return Boolean(
      turn
      && turn.provenance.trigger.kind === 'feature'
      && turn.provenance.trigger.feature === 'automation'
      && turn.provenance.trigger.ref === run.id
      && turn.status === 'inProgress',
    );
  }

  async cleanupRetainedWorktrees(retain = 10): Promise<void> {
    const candidates = this.options.store.retainedWorktreeRunsForCleanup()
      .filter((run) => (
        run.worktree
        && run.worktree.removedAt === null
        && !run.pinned
        && (run.state === 'dispatched' || run.state === 'failed' || run.state === 'omitted')
      ))
      .filter((run) => !this.isRunActive(run));
    for (const run of candidates.slice(retain)) {
      if (!run.worktree) continue;
      try {
        let stored = run;
        const updated = await this.options.worktrees.snapshotAndRemove(run.worktree, async (snapshot) => {
          stored = this.options.store.setWorktree(run.id, snapshot, this.now());
          await this.changed(stored);
        });
        if (stored.worktree?.removedAt !== updated.removedAt) {
          stored = this.options.store.setWorktree(run.id, updated, this.now());
          await this.changed(stored);
        }
      } catch {
        // Retention is best-effort and is retried on the next scheduler wake.
      }
    }
  }

  private async assertDispatchedBindings(): Promise<void> {
    for (const run of this.options.store.dispatchedRunsForReconciliation()) {
      if (!run.threadId || !run.turnId) continue;
      const turn = this.options.threads.readTurnForHost(run.threadId, run.turnId);
      // Users may delete canonical Thread history after a run. The routing
      // record stays auditable even though its transcript is no longer present.
      if (!turn) continue;
      if (
        turn.provenance.trigger.kind === 'feature'
        && turn.provenance.trigger.feature === 'automation'
        && turn.provenance.trigger.ref === run.id
      ) continue;
      throw new Error(`AutomationRun provenance binding is invalid: ${run.id}`);
    }
  }

  private async recoverAcceptedTurn(run: AutomationRun): Promise<AutomationRun | null> {
    if (run.state !== 'pending' || !run.threadId) return null;
    const turn = this.options.threads.readTurnByClientUserMessageIdForHost(run.threadId, run.id);
    if (!turn) return null;
    if (
      turn.provenance.trigger.kind !== 'feature'
      || turn.provenance.trigger.feature !== 'automation'
      || turn.provenance.trigger.ref !== run.id
    ) {
      throw new Error(`Accepted AutomationRun Turn provenance is invalid: ${run.id}`);
    }
    const dispatched = this.options.store.markDispatched(run.id, run.threadId, turn.id, this.now());
    await this.changed(dispatched);
    return dispatched;
  }

  private async retainPending(id: string, error: unknown): Promise<AutomationRun> {
    const latest = this.options.store.readRun(id);
    if (!latest) throw error;
    if (latest.state === 'dispatched') return latest;
    if (latest.state !== 'pending') throw error;
    const retryable = this.options.store.recordPendingError(id, errorMessage(error), this.now());
    await this.changed(retryable);
    return retryable;
  }

  private async changed(run: AutomationRun): Promise<void> {
    await this.options.onRunChanged?.(run);
  }
}

/**
 * `guidance` is emitted FIRST, ahead of the data it governs: the model reads the
 * contract for `recentRuns` before it reads any of it. An existing-Thread run
 * gets neither — its predecessors are already Turns in the Thread it is joining,
 * so a digest of them would be the same history told twice and worse.
 */
async function automationContext(
  run: AutomationRun,
  cwd: string,
  continuity: AutomationRunContinuityReader,
): Promise<AdditionalContext> {
  const standalone = run.snapshot.destination.kind === 'standalone';
  return Object.freeze({
    automation_info: Object.freeze({
      kind: 'application',
      value: JSON.stringify({
        ...(standalone ? { guidance: AUTOMATION_RUN_GUIDANCE } : {}),
        automationId: run.automationId,
        automationRunId: run.id,
        automationRevision: run.automationRevision,
        scheduledFor: new Date(run.scheduledFor).toISOString(),
        destination: run.snapshot.destination.kind,
        projectBindingKey: run.projectBindingKey,
        projectCwd: run.snapshot.projectBinding?.cwd ?? null,
        cwd,
        executionMode: run.snapshot.projectBinding?.executionMode ?? null,
        worktree: run.worktree
          ? {
              sourceCwd: run.worktree.sourceCwd,
              path: run.worktree.path,
              baseCommit: run.worktree.baseCommit,
              managed: run.worktree.managed,
            }
          : null,
        ...(standalone ? { recentRuns: await recentRunsForDispatch(run, continuity) } : {}),
      }),
    }),
  });
}

/**
 * A12 around the whole digest, not only around each read inside it: a
 * predecessor's history is a hint, and a hint must never be able to stop the run
 * it was meant to help. An empty list is the honest degraded answer — the model
 * reads "no predecessors on record", not a half-built one.
 */
async function recentRunsForDispatch(
  run: AutomationRun,
  continuity: AutomationRunContinuityReader,
): Promise<readonly RecentAutomationRun[]> {
  try {
    return await recentAutomationRuns(run, continuity);
  } catch (error) {
    console.warn(`[agent] Automation run continuity was not resolved for ${run.id}`, error);
    return [];
  }
}

export function assertAutomationConfigurationMatchesThread(
  selection: AutomationConfiguration,
  modelProvider: string,
  configuration: EffectiveThreadConfiguration,
): void {
  const mismatches = [
    selection.modelProvider !== null && selection.modelProvider !== modelProvider,
    selection.model !== null && selection.model !== configuration.model,
    selection.reasoningEffort !== null && selection.reasoningEffort !== configuration.reasoningEffort,
  ];
  if (mismatches.some(Boolean)) {
    throw new Error('Automation configuration does not match the destination Thread configuration');
  }
}

function requireThreadId(run: AutomationRun): string {
  if (!run.threadId) throw new Error(`Standalone AutomationRun has no reserved Thread ID: ${run.id}`);
  return run.threadId;
}

export function projectBindingForRun(
  automation: Automation,
  bindingKey: string,
): AutomationProjectBinding | null {
  if (automation.projectBindings.length === 0) return null;
  const binding = automation.projectBindings.find((candidate) => candidate.id === bindingKey);
  if (!binding) throw new Error(`Automation project binding not found: ${bindingKey}`);
  return binding;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
