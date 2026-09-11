import { realpath } from 'node:fs/promises';
import { automationDirectoryHint } from '../../../core/agent/automation';
import type { AutomationDispatchContextPayload } from '../../../core/agent/protocol';
import { pendingExecutionContext, resolveExecutionAddress, validateExecutionContext } from '../tasks/ExecutionContext';
import type { EffectiveThreadConfiguration } from '../../../core/agent/configuration';
import { threadFeatureSource, type AdditionalContext, type Thread } from '../../../core/agent/protocol';
import type {
  Automation,
  AutomationConfiguration,
  AutomationContextHint,
  AutomationRun,
} from '../../../core/agent/automation';
import type { ThreadService } from '../ThreadService';
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
  readonly canDispatch?: () => boolean;
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
      recentRunsForContextHint: (...args) => this.options.store.recentRunsForContextHint(...args),
      readTurn: (threadId, turnId) => this.options.threads.readTurnForHost(threadId, turnId),
      transcriptPath: (threadId) => this.options.threads.threadRecordPath(threadId),
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
    if (this.options.canDispatch?.() === false) return current;
    let featureThreadCreated = false;
    let acceptedTurn = false;
    try {
      let prepared = current;
      const snapshot = prepared.snapshot;
      let dispatchContext: AutomationDispatchContextPayload;
      if (prepared.dispatchSnapshotRef) {
        const stored = await this.options.threads.readFeatureContext(prepared.id, prepared.dispatchSnapshotRef);
        if (stored?.kind !== 'automationDispatch' || stored.automationRunId !== prepared.id) throw new Error('Prepared Automation dispatch context is unavailable');
        dispatchContext = stored;
        for (const captured of [stored.sourceContext, stored.executionContext]) {
          validateExecutionContext(captured);
          const address = await resolveExecutionAddress({ defaultCwd: captured.address.cwd });
          if (address.cwd !== captured.address.cwd || JSON.stringify(address.scopes) !== JSON.stringify(captured.address.scopes)) {
            throw new Error('Prepared Automation execution identity changed before admission');
          }
        }
        if (prepared.worktree) await this.options.worktrees.prepare(prepared, stored.sourceContext.address.cwd, async () => {
          throw new Error('Prepared dispatch cannot allocate a new worktree');
        });
      } else {
        const sourceAddress = await resolveExecutionAddress({
          defaultCwd: prepared.worktree?.sourceCwd ?? this.options.defaultCwd,
          ...(prepared.worktree || !snapshot.contextHint ? {} : { cwd: snapshot.contextHint.source.kind === 'project'
            ? requireProjectSnapshotRoot(snapshot) : automationDirectoryHint(snapshot.contextHint) }),
        });
        if (snapshot.contextHint?.source.kind === 'project'
          && sourceAddress.cwd !== requireProjectSnapshotRoot(snapshot)) {
          throw new Error('Saved Project directory was redirected; edit its root hint before scheduling');
        }
        const sourceContext = pendingExecutionContext(sourceAddress, {
          capability: 'full-access', isolation: 'unsandboxed', writablePaths: [],
        });
        const workspace = await this.options.worktrees.prepare(prepared, sourceAddress.cwd, async (intent) => {
          prepared = this.options.store.setWorktree(prepared.id, intent, this.now());
          await this.changed(prepared);
        });
        if (workspace.worktree && !prepared.worktree) prepared = this.options.store.setWorktree(prepared.id, workspace.worktree, this.now());
        const executionContext = pendingExecutionContext(await resolveExecutionAddress({ defaultCwd: workspace.cwd }), {
          capability: 'full-access',
          isolation: workspace.worktree ? 'macos-write-sandbox' : 'unsandboxed',
          writablePaths: workspace.worktree ? [workspace.cwd] : [],
        });
        const resolved = snapshot.destination.kind === 'existingThread'
          ? (() => {
            const context = this.options.threads.persistentThreadExecutionContext(snapshot.destination.threadId);
            return { modelProvider: context.thread.modelProvider, configuration: context.configuration };
          })()
          : await this.options.resolveConfiguration(snapshot.configuration, this.options.defaultCwd);
        const info = await automationContext(prepared, executionContext.address.cwd, this.continuity);
        dispatchContext = {
          schemaVersion: 1, kind: 'automationDispatch', automationRunId: prepared.id,
          sourceContext, executionContext, ...resolved, info: String(info.automation_info!.value),
        };
        const ref = await this.options.threads.writeFeatureContext(prepared.id, dispatchContext);
        prepared = this.options.store.setDispatchSnapshot(prepared.id, ref, this.now());
        await this.changed(prepared);
      }
      let thread: Thread;
      if (snapshot.destination.kind === 'existingThread') {
        const context = this.options.threads.persistentThreadExecutionContext(snapshot.destination.threadId);
        if (context.thread.threadSource !== 'user') {
          throw new Error('An existing-Thread Automation must target a user root Thread');
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
        if (JSON.stringify(context.configuration) !== JSON.stringify(dispatchContext.configuration)
          || context.thread.modelProvider !== dispatchContext.modelProvider) throw new Error('Destination configuration changed after dispatch preparation');
      } else {
        await this.options.validateEffectiveConfiguration(dispatchContext.modelProvider, dispatchContext.configuration);
        thread = await this.options.threads.ensureFeatureRootThread({
          id: requireThreadId(prepared),
          name: snapshot.automationName,
          source: 'agent.automation',
          threadSource: threadFeatureSource('automation'),
          modelProvider: dispatchContext.modelProvider,
          configuration: dispatchContext.configuration,
        });
        featureThreadCreated = true;
      }
      if (prepared.threadId !== thread.id) {
        prepared = this.options.store.setThread(prepared.id, thread.id, this.now());
        await this.changed(prepared);
      }
      const turn = await this.options.threads.tryStartTurnIfIdle({
        threadId: thread.id,
        input: [{ type: 'text', text: snapshot.prompt }],
        clientUserMessageId: prepared.id,
        initialContext: { storageOwner: prepared.id, refs: [prepared.dispatchSnapshotRef!] },
        author: { kind: 'feature', feature: 'automation', ref: prepared.id },
        trigger: { kind: 'feature', feature: 'automation', ref: prepared.id },
      });
      if (!turn) return prepared;
      acceptedTurn = true;
      const dispatched = this.options.store.markDispatched(prepared.id, thread.id, turn.id, this.now());
      await this.changed(dispatched);
      return dispatched;
    } catch (error) {
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
        contextHintId: run.contextHintId,
        source: run.snapshot.contextHint?.source ?? null,
        ...(run.snapshot.projectSnapshot ? { project: run.snapshot.projectSnapshot } : {}),
        occurrenceKey: run.occurrenceKey,
        cwd,
        executionMode: run.snapshot.contextHint?.executionMode ?? null,
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

function requireProjectSnapshotRoot(snapshot: AutomationRun['snapshot']): string {
  const project = snapshot.projectSnapshot;
  if (snapshot.contextHint?.source.kind !== 'project' || !project?.primaryFolder
    || project.id !== snapshot.contextHint.source.projectId) throw new Error('Automation Project hint is unavailable or has no saved directory');
  return project.primaryFolder;
}

export function contextHintForRun(
  automation: Automation,
  contextHintKey: string,
): AutomationContextHint | null {
  if (automation.contextHints.length === 0) return null;
  const binding = automation.contextHints.find((candidate) => candidate.contextHintId === contextHintKey);
  if (!binding) throw new Error(`Automation context hint not found: ${contextHintKey}`);
  return binding;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
