import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { VerificationConfiguration, VerificationCheckDefinition, VerificationCheckView, VerificationSourceManifest, VerificationView } from '../../../core/agent/verification';
import { decodeVerificationConfiguration } from '../../../core/agent/verification';
import type { ThreadContextPayload, ThreadContextPayloadReference, VerificationObservationPayload } from '../../../core/agent/protocol';
import { GoalStore } from '../extensions/goal/GoalStore';
import { Mutex } from '../Mutex';
import { ExecutionAdmissionError, executionDigest } from '../tasks/ExecutionContext';
import type { ToolTaskService } from '../tasks/ToolTaskService';
import { isToolTaskTerminal, type ToolTaskRecord } from '../tasks/toolTaskTypes';
import { captureSourceManifest, changedSourcePaths, resolveVerificationChecks, VerificationUnavailable } from './SourceManifest';
import type { VerificationAttempt, VerificationState } from './VerificationState';

export interface VerificationHost {
  write(owner: string, payload: ThreadContextPayload): Promise<ThreadContextPayloadReference>;
  read(owner: string, ref: ThreadContextPayloadReference): Promise<ThreadContextPayload | null>;
  ancestors(threadId: string): readonly string[];
  deleteEvidence?(owner: string): Promise<void>;
}

/** Coordinates evidence and bounded attempts; execution and outcomes belong to Tool Tasks. */
export class VerificationCoordinator {
  private readonly mutex = new Mutex();
  private recoveryComplete = false;
  private readonly unavailableOwners = new Map<string, string>();
  constructor(private readonly goals: GoalStore, private readonly tasks: ToolTaskService, private readonly host: VerificationHost) {}

  async configure(threadId: string, input: VerificationConfiguration): Promise<VerificationView> {
    return this.mutex.run(async () => {
      const requested = decodeVerificationConfiguration(input);
      let configuration = requested;
      let rootFailure: string | null = null;
      try { configuration = { ...requested, roots: [...new Set(await Promise.all(requested.roots.map((root) => realpath(root))))].sort() }; }
      catch (error) { rootFailure = `Verification roots are unavailable: ${message(error)}`; }
      const existing = this.current(threadId);
      if (existing) throw new VerificationUnavailable('An existing verification run cannot be replaced. Inspect or explicitly resume it.');
      const goal = this.goals.read(threadId);
      if (!goal || goal.goal.status !== 'active') throw new VerificationUnavailable('Verification requires an active persistent Goal.');
      const state: VerificationState = { verificationRunId: randomUUID(), threadId, generation: goal.generation,
        configuration, attempts: [], invalidations: [], resumptions: [], stopped: null };
      this.goals.writeVerification(state);
      try {
        if (rootFailure) throw new VerificationUnavailable(rootFailure);
        await resolveVerificationChecks(configuration.roots);
      }
      catch (error) { this.goals.stopVerification(threadId, message(error)); }
      return this.view(this.goals.readVerification(threadId)!, false);
    });
  }

  async resume(threadId: string, configuration: VerificationConfiguration, turn: { id: string; startedAt: number; provenance: { trigger: { kind: string } } }): Promise<VerificationView> {
    return this.mutex.run(async () => {
      let state = this.current(threadId);
      const goal = this.goals.read(threadId);
      if (!state?.stopped || !goal || turn.provenance.trigger.kind !== 'user' || turn.startedAt <= state.stopped.at
        || state.resumptions.some((entry) => entry.turnId === turn.id)) {
        throw new VerificationUnavailable('Resume requires a fresh user Turn after verification stopped.');
      }
      const requested = decodeVerificationConfiguration(configuration);
      const roots = [...new Set(await Promise.all(requested.roots.map((root) => realpath(root))))].sort();
      if (executionDigest({ ...requested, roots }) !== executionDigest(state.configuration)) {
        throw new VerificationUnavailable('Resume must preserve the existing roots and attempt budget.');
      }
      if (state.attempts.length >= state.configuration.maxAttempts || (goal.goal.tokenBudget !== null && goal.goal.tokensUsed >= goal.goal.tokenBudget)) {
        throw new VerificationUnavailable('This verification budget is exhausted. A separately requested Goal in a new Chat is required.');
      }
      const definitions = await resolveVerificationChecks(state.configuration.roots);
      await captureSourceManifest(state.configuration.roots, definitions);
      const stopReason = state.stopped.reason;
      state = this.invalidate(state, 'Explicit user resumption requires a fresh source revision and all required checks.', null);
      this.goals.writeVerification({ ...state, stopped: null, resumptions: [...state.resumptions,
        { turnId: turn.id, afterRevision: state.attempts.at(-1)?.revision ?? -1, at: Date.now(), stopReason }] });
      this.goals.setStatus(threadId, 'active');
      return this.view(this.current(threadId)!, true);
    });
  }

  async clearEvidence(threadId: string): Promise<void> {
    await this.host.deleteEvidence?.(`verification_${threadId}_`);
  }

  async inspect(threadId: string): Promise<VerificationView | null> {
    return this.mutex.run(async () => {
      const state = this.current(threadId);
      if (!state) return this.unavailableView(threadId);
      try { return await this.view(state, true); }
      catch (error) {
        this.goals.stopVerification(threadId, `Verification inspection is unavailable: ${message(error)}`);
        this.unavailableOwners.set(threadId, message(error));
        return this.unavailableView(threadId);
      }
    });
  }

  async completeGoal(threadId: string): Promise<boolean> {
    return this.mutex.run(async () => {
      const state = this.current(threadId);
      if (!state && !this.unavailableOwners.has(threadId)) return false;
      if (!state || (await this.view(state, true)).state !== 'passed') {
        throw new VerificationUnavailable('All required checks must pass for the current source revision before completing this Goal.');
      }
      // Keep the source decision and Goal mutation inside the admission mutex.
      this.goals.updateFromAgent(threadId, 'complete');
      return true;
    });
  }

  async assertComplete(threadId: string): Promise<void> {
    const view = await this.inspect(threadId);
    if (view && view.state !== 'passed') throw new VerificationUnavailable('All required checks must pass for the current source revision before completing this Goal.');
  }

  isStopped(threadId: string): boolean {
    return Boolean(this.current(threadId)?.stopped || this.unavailableOwners.has(threadId));
  }

  stop(threadId: string, reason: string): void {
    if (this.current(threadId)) this.goals.stopVerification(threadId, reason);
  }

  allowContinuation(threadId: string, admittedCount: number): boolean {
    const state = this.current(threadId);
    if (!state) return !this.unavailableOwners.has(threadId);
    if (state.stopped) return false;
    if (admittedCount >= state.configuration.maxAttempts) {
      this.goals.stopVerification(threadId, `Verification automatic continuation limit (${state.configuration.maxAttempts}) exhausted.`);
      return false;
    }
    return true;
  }

  admissionFailed(owner: string, error: unknown): void {
    for (const threadId of [owner, ...this.host.ancestors(owner)]) this.stop(threadId, `Host admission failed: ${message(error)}`);
  }

  async beforeTask(task: ToolTaskRecord): Promise<void> {
    await this.mutex.run(async () => {
      const family = new Set([task.ownerThreadId, ...this.host.ancestors(task.ownerThreadId)]);
      const states = this.goals.verificationOwners().map((owner) => this.current(owner)).filter((state): state is VerificationState => state !== null);
      const active = states.filter((state) => !state.stopped && this.goals.read(state.threadId)?.goal.status === 'active');
      const own = active.find((state) => state.threadId === task.ownerThreadId)
        ?? active.find((state) => family.has(state.threadId));
      let definitions: VerificationCheckDefinition[] = [];
      let declaration: VerificationCheckDefinition | undefined;
      if (own && !own.stopped) {
        try {
          definitions = await resolveVerificationChecks(own.configuration.roots);
          if (task.producer === 'bash' && task.operationKind === 'process') {
            declaration = definitions.find((check) => check.scope === task.cwd && commandDigest(check.command) === task.commandDigest);
          }
        } catch (error) { this.goals.stopVerification(own.threadId, message(error)); throw error; }
      }
      for (const state of states) {
        if (state.stopped || (state === own && declaration)) continue;
        const withinWorkflow = family.has(state.threadId) && task.operationKind === 'process';
        const measuredRoots = state.attempts.at(-1)
          ? (await this.manifest(state, state.attempts.at(-1)!.baselineRef).catch(() => null))?.roots.map((root) => root.path) ?? state.configuration.roots
          : state.configuration.roots;
        const overlaps = task.executionContext.policy.mutation && measuredRoots.some((root) =>
          task.executionContext.address.scopes.some((scope) => contains(root, scope.directory) || contains(scope.directory, root)));
        if (withinWorkflow || overlaps) this.invalidate(state, 'An admitted mutation or unclassified process invalidated this revision.', task.taskId);
      }
      if (!own || !declaration) return;
      if (own.stopped || this.goals.read(own.threadId)?.goal.status !== 'active') throw new VerificationUnavailable('Verification is stopped. Renew user admission before continuing.');
      const current = this.current(own.threadId)!;
      try {
        const previous = current.attempts.at(-1);
        if (previous?.checks.some((check) => {
          const receipt = this.tasks.store.read(check.toolTaskId);
          return receipt && !isToolTaskTerminal(receipt.state);
        })) throw new ExecutionAdmissionError('worktree_busy', 'Another declared check is still running. Use an isolated worktree or finish it before the next check.');
        const baseline = previous ? await this.manifest(current, previous.baselineRef) : null;
        const source = await captureSourceManifest(current.configuration.roots, definitions, baseline);
        const newAttempt = !previous || this.invalidated(current, previous) || source.digest !== baseline?.digest
          || previous.definitionDigest !== source.definitionDigest || previous.checks.some((check) => check.checkId === declaration!.key);
        let state = current;
        let attempt = previous;
        if (newAttempt) {
          if (state.attempts.length >= state.configuration.maxAttempts) throw new VerificationUnavailable('Verification attempt budget exhausted.');
          if (previous) state = this.invalidate(state, 'A new source revision or repeated check requires every required check to run again.', task.taskId);
          const baselineRef = await this.storeManifest(state, source);
          attempt = { revision: state.attempts.length, baselineRef, definitionDigest: source.definitionDigest,
            definitions, checks: [], changedPaths: baseline ? changedSourcePaths(baseline, source) : [],
            parentFailureTaskIds: previous?.checks.filter((check) => this.tasks.store.read(check.toolTaskId)?.state !== 'succeeded').map((check) => check.toolTaskId) ?? [],
            tokensAtStart: this.goals.read(state.threadId)!.goal.tokensUsed, startedAt: Date.now() };
          state = { ...state, attempts: [...state.attempts, attempt] };
        }
        if (!attempt) throw new VerificationUnavailable('Verification baseline is unavailable.');
        const beforeRef = await this.storeManifest(state, source);
        this.replaceAttempt(state, { ...attempt, checks: [...attempt.checks, { checkId: declaration.key,
          toolTaskId: task.taskId, beforeRef, afterRef: null, terminalDigest: null, fingerprint: null }] });
      } catch (error) {
        if (!(error instanceof ExecutionAdmissionError)) this.goals.stopVerification(own.threadId, message(error));
        throw error;
      }
    });
  }

  async afterTask(task: ToolTaskRecord): Promise<void> {
    if (!this.recoveryComplete) return;
    await this.mutex.run(async () => {
      for (const owner of this.goals.verificationOwners()) {
        let state = this.current(owner);
        if (!state) continue;
        const attempt = state.attempts.find((attempt) => attempt.checks.some((check) => check.toolTaskId === task.taskId));
        const check = attempt?.checks.find((check) => check.toolTaskId === task.taskId);
        if (!attempt || !check || check.terminalDigest) continue;
        try {
          const baseline = await this.manifest(state, attempt.baselineRef);
          const definitions = await resolveVerificationChecks(state.configuration.roots);
          const source = await captureSourceManifest(state.configuration.roots, definitions, baseline);
          const afterRef = await this.storeManifest(state, source);
          const output = await this.tasks.output(task.taskId, task.ownerThreadId, 4_096);
          const fingerprint = task.state === 'failed' ? executionDigest({ checkId: check.checkId, exitCode: task.exitCode,
            reason: task.outcomeReason, error: task.error, diagnostic: normalizeDiagnostic(`${output?.stdout ?? ''}\n${output?.stderr ?? ''}`) }) : null;
          state = this.replaceAttempt(state, { ...attempt, checks: attempt.checks.map((entry) => entry === check
            ? { ...entry, afterRef, terminalDigest: task.terminalDigest, fingerprint } : entry) });
          if (source.digest !== baseline.digest || source.definitionDigest !== attempt.definitionDigest) {
            state = this.invalidate(state, 'A check changed included sources or its definition changed during execution.', task.taskId);
          }
          if (['admission_failed', 'admission_interrupted', 'storage_limit'].includes(task.outcomeReason ?? '')) this.goals.stopVerification(owner, `Host admission failed: ${task.error ?? task.outcomeReason}`);
          else if (task.state === 'cancelled' || task.state === 'timed_out' || task.state === 'lost') this.goals.stopVerification(owner, `Check ${task.state}: ${task.outcomeReason ?? 'no terminal execution evidence'}`);
          else if (fingerprint && state.attempts.filter((attempt) => attempt.revision > (state!.resumptions.at(-1)?.afterRevision ?? -1)).flatMap((attempt) => attempt.checks).filter((entry) => entry.fingerprint === fingerprint).length >= 2) {
            this.goals.stopVerification(owner, 'An equivalent check failure repeated.');
          } else if (state.attempts.length >= state.configuration.maxAttempts && (this.invalidated(state, attempt) || (task.state === 'failed' && attempt.definitions.find((definition) => definition.key === check.checkId)?.required))) {
            this.goals.stopVerification(owner, 'Verification attempt budget exhausted.');
          }
        } catch (error) { this.goals.stopVerification(owner, message(error)); }
      }
    });
  }

  async initialize(): Promise<void> {
    // Tool Task reconciliation must run first. Missing post-check evidence cannot be reconstructed as a pass.
    await this.mutex.run(async () => {
      for (const owner of this.goals.verificationOwners()) {
        const state = this.current(owner);
        if (!state || state.stopped) continue;
        for (const attempt of state.attempts) {
          for (const check of attempt.checks) {
            const task = this.tasks.store.read(check.toolTaskId);
            if (!task || (isToolTaskTerminal(task.state) && !check.afterRef)) {
              this.goals.stopVerification(owner, 'Restart found a check without verified terminal source evidence.');
            }
          }
        }
        try { await this.view(this.current(owner)!, true); }
        catch (error) { this.goals.stopVerification(owner, `Verification recovery is unavailable: ${message(error)}`); }
      }
      this.recoveryComplete = true;
    });
  }

  async publication(threadId: string): Promise<VerificationObservationPayload | null> {
    const view = await this.inspect(threadId);
    const state = this.current(threadId);
    if (!view) return null;
    const evidenceRefs = [...new Map((state?.attempts ?? []).flatMap((attempt) => [attempt.baselineRef,
      ...attempt.checks.flatMap((check) => [check.beforeRef, ...(check.afterRef ? [check.afterRef] : [])])]).map((ref) => [ref.id, ref])).values()];
    const summary = { ...view, checks: view.checks.map(({ output: _output, command: _command, ...check }) => check), limitations: view.limitations.slice(0, 4) };
    const text = `Verification evidence for this Goal; prior process receipts remain historical facts.\n${JSON.stringify(summary).slice(0, 10_000)}\nUse get_goal for the full bounded check list. Never reuse a stale pass or replay an edit after recovery.`;
    return { schemaVersion: 1, kind: 'verificationObservation', evidenceRefs,
      facts: [{ source: `host:verification:${threadId}`, kind: 'check', authority: 'host', purpose: 'observation',
        scope: `thread:${threadId}`, version: executionDigest(summary), text,
        invalidated: view.state === 'stopped' || view.state === 'unavailable' || view.checks.some((check) => check.applicability !== 'current'),
        observedAt: Math.max(state?.attempts.at(-1)?.startedAt ?? 0, state?.invalidations.at(-1)?.at ?? 0, state?.stopped?.at ?? 0) }] };
  }

  evidenceOwner(threadId: string): string | null {
    const state = this.current(threadId);
    return state ? ownerKey(state) : null;
  }

  private async view(state: VerificationState, revalidate: boolean): Promise<VerificationView> {
    let attempt = state.attempts.at(-1);
    let definitions = attempt?.definitions ?? [];
    let manifest: VerificationSourceManifest | null = null;
    let unavailable: string | null = state.stopped?.reason ?? null;
    try {
      definitions = await resolveVerificationChecks(state.configuration.roots);
      if (attempt) {
        manifest = await this.manifest(state, attempt.baselineRef);
        if (revalidate) {
          const source = await captureSourceManifest(state.configuration.roots, definitions, manifest);
          if (source.digest !== manifest.digest) state = this.invalidate(state, 'Sources or check definitions changed after the recorded baseline.', null);
        }
      }
    } catch (error) { unavailable = message(error); this.goals.stopVerification(state.threadId, unavailable); state = this.current(state.threadId)!; }
    attempt = state.attempts.at(-1);
    const applicability = unavailable ? 'unavailable' : attempt && this.invalidated(state, attempt) ? 'stale' : 'current';
    const checks: VerificationCheckView[] = [];
    for (const definition of definitions) {
      const evidence = attempt?.checks.find((check) => check.checkId === definition.key);
      const task = evidence ? this.tasks.store.read(evidence.toolTaskId) : null;
      if (evidence && !task) this.goals.stopVerification(state.threadId, 'A recorded check Tool Task is unavailable.');
      const output = task ? await this.tasks.output(task.taskId, task.ownerThreadId, 1_024) : null;
      const receiptState = !task ? evidence ? 'lost' : 'unavailable' : !isToolTaskTerminal(task.state) ? 'running'
        : task.state === 'succeeded' ? 'passed' : task.state === 'lost' ? 'lost' : task.state === 'failed' ? 'failed' : 'stopped';
      let verified = !task || !isToolTaskTerminal(task.state);
      let matchingSources = true;
      if (task && isToolTaskTerminal(task.state) && evidence?.afterRef && evidence.terminalDigest === task.terminalDigest) {
        try {
          const before = await this.manifest(state, evidence.beforeRef);
          const after = await this.manifest(state, evidence.afterRef);
          const admittedDefinition = attempt?.definitions.find((entry) => entry.key === evidence.checkId);
          verified = task.producer === 'bash' && task.operationKind === 'process'
            && task.cwd === admittedDefinition?.scope && task.commandDigest === commandDigest(admittedDefinition.command)
            && (task.ownerThreadId === state.threadId || this.host.ancestors(task.ownerThreadId).includes(state.threadId))
            && before.definitionDigest === attempt?.definitionDigest;
          matchingSources = before.digest === manifest?.digest && after.digest === manifest?.digest;
        } catch {
          verified = false;
          this.goals.stopVerification(state.threadId, 'Terminal source evidence is unavailable.');
        }
      }
      checks.push({ checkId: definition.key, command: definition.command, cwd: definition.scope, required: definition.required,
        toolTaskId: task?.taskId ?? evidence?.toolTaskId ?? null, state: receiptState,
        applicability: verified ? matchingSources ? applicability : 'stale' : 'unavailable', exitCode: task?.exitCode ?? null,
        output: output ? `${output.stdout}\n${output.stderr}`.trim() : null,
        reason: unavailable ?? (!verified ? 'Terminal source evidence is unavailable.' : task?.outcomeReason ?? null) });
    }
    state = this.current(state.threadId) ?? state;
    const required = checks.filter((check) => check.required);
    const passed = !state.stopped && required.length > 0 && required.every((check) => check.state === 'passed' && check.applicability === 'current');
    return { verificationRunId: state.verificationRunId, revision: attempt?.revision ?? null, attemptsUsed: state.attempts.length, maxAttempts: state.configuration.maxAttempts,
      state: state.stopped ? 'stopped' : unavailable ? 'unavailable' : passed ? 'passed' : checks.some((check) => check.state === 'running') ? 'running'
        : checks.some((check) => check.state === 'failed' || check.state === 'lost' || check.applicability === 'stale') ? 'failed' : 'pending',
      stopReason: state.stopped?.reason ?? unavailable, changedPaths: attempt?.changedPaths.slice(0, 64) ?? [], checks,
      sourceStateRef: attempt?.baselineRef ?? null, limitations: [...(manifest?.limitations ?? []), ...(attempt && attempt.changedPaths.length > 64 ? ['Changed-path preview is limited to 64 entries; full source evidence remains referenced.'] : [])] };
  }

  private current(threadId: string): VerificationState | null {
    try {
      const state = this.goals.readVerification(threadId);
      this.unavailableOwners.delete(threadId);
      return state && this.goals.read(threadId)?.generation === state.generation ? state : null;
    } catch (error) {
      if (!this.unavailableOwners.has(threadId)) console.warn('[agent] Verification metadata is unavailable', threadId, error);
      this.unavailableOwners.set(threadId, `Verification metadata is unavailable: ${message(error)}`);
      if (this.goals.read(threadId)?.goal.status !== 'complete') this.goals.setStatus(threadId, 'blocked');
      return null;
    }
  }
  private unavailableView(threadId: string): VerificationView | null {
    const reason = this.unavailableOwners.get(threadId);
    return reason ? { verificationRunId: 'unavailable', revision: null, attemptsUsed: 0, maxAttempts: 1, state: 'unavailable',
      stopReason: reason, changedPaths: [], checks: [], sourceStateRef: null, limitations: ['Attempt metadata cannot be trusted.'] } : null;
  }
  private invalidated(state: VerificationState, attempt: VerificationAttempt): boolean {
    return state.invalidations.some((entry) => entry.revision === attempt.revision);
  }
  private invalidate(state: VerificationState, reason: string, taskId: string | null): VerificationState {
    const attempt = state.attempts.at(-1);
    if (!attempt || this.invalidated(state, attempt)) return state;
    const latest = this.current(state.threadId);
    const next = { ...state, stopped: latest?.stopped ?? state.stopped, invalidations: [...state.invalidations, { revision: attempt.revision, reason, taskId, at: Date.now() }] };
    this.goals.writeVerification(next);
    return next;
  }
  private replaceAttempt(state: VerificationState, attempt: VerificationAttempt): VerificationState {
    const latest = this.current(state.threadId);
    const next = { ...state, stopped: latest?.stopped ?? state.stopped, attempts: state.attempts.map((value) => value.revision === attempt.revision ? attempt : value) };
    this.goals.writeVerification(next);
    return next;
  }
  private async storeManifest(state: VerificationState, manifest: VerificationSourceManifest): Promise<ThreadContextPayloadReference> {
    return this.host.write(ownerKey(state), { schemaVersion: 1, kind: 'verificationSource', manifest });
  }
  private async manifest(state: VerificationState, ref: ThreadContextPayloadReference): Promise<VerificationSourceManifest> {
    const payload = await this.host.read(ownerKey(state), ref);
    if (payload?.kind !== 'verificationSource') throw new VerificationUnavailable('Verification source evidence is unavailable.');
    const { roots, entries, definitionDigest, digest } = payload.manifest;
    if (executionDigest({ roots, entries, definitionDigest }) !== digest) throw new VerificationUnavailable('Verification source evidence digest is invalid.');
    return payload.manifest;
  }
}
function ownerKey(state: VerificationState): string { return `verification_${state.threadId}_${state.verificationRunId}`; }
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4_096); }
function commandDigest(command: string): string { return createHash('sha256').update(command).digest('hex'); }
function contains(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}/`); }
function normalizeDiagnostic(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/gu, '').replace(/\b\d{4}-\d\d-\d\d[T ][\d:.]+Z?\b/gu, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|s)\b/gu, '<duration>').trim().slice(0, 4_096);
}
