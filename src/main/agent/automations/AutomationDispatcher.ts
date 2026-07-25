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
  readonly onRunChanged?: (run: AutomationRun) => void | Promise<void>;
  readonly now?: () => number;
}

export class AutomationDispatcher {
  private readonly now: () => number;

  constructor(private readonly options: AutomationDispatcherOptions) {
    this.now = options.now ?? Date.now;
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

  async dispatch(run: AutomationRun): Promise<AutomationRun> {
    const current = this.options.store.readRun(run.id);
    if (!current || current.state !== 'pending') return current ?? run;
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
        additionalContext: automationContext(prepared, executionCwd),
        trigger: { kind: 'feature', feature: 'automation', ref: prepared.id },
      });
      if (!turn) return prepared;
      acceptedTurn = true;
      const dispatched = this.options.store.markDispatched(prepared.id, thread.id, turn.id, this.now());
      await this.changed(dispatched);
      return dispatched;
    } catch (error) {
      if (acceptedTurn) {
        const latest = this.options.store.readRun(current.id);
        if (!latest) throw error;
        if (latest.state === 'pending') {
          const retryable = this.options.store.recordPendingError(current.id, errorMessage(error), this.now());
          await this.changed(retryable);
          return retryable;
        }
        if (latest.state === 'dispatched') return latest;
        throw error;
      }
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

  private async changed(run: AutomationRun): Promise<void> {
    await this.options.onRunChanged?.(run);
  }
}

function automationContext(run: AutomationRun, cwd: string): AdditionalContext {
  return Object.freeze({
    automation_info: Object.freeze({
      kind: 'application',
      value: JSON.stringify({
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
      }),
    }),
  });
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
    selection.profileName !== null && selection.profileName !== configuration.profileName,
    selection.tools !== null && !sameStrings(selection.tools, configuration.tools),
    selection.skills !== null && !sameStrings(selection.skills, configuration.skills),
    selection.plugins !== null && !sameStrings(selection.plugins, configuration.plugins),
    selection.mcpServers !== null && !sameStrings(selection.mcpServers, configuration.mcpServers),
  ];
  if (mismatches.some(Boolean)) {
    throw new Error('Automation configuration does not match the destination Thread configuration');
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
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
