import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeThread } from '../../../core/agent/codec';
import type { Thread } from '../../../core/agent/protocol';
import type { ThreadRecoveryAction, ThreadRecoveryPhase, ThreadRecoveryPreview } from '../../../core/threadRecovery';
import { startupIssue } from '../../startupIssue';
import { Mutex } from '../Mutex';
import { uuidV7 } from '../uuid';
import { RecoveryEvidence } from './RecoveryEvidence';

export interface RecoveryInspection {
  readonly threads: readonly Thread[];
  readonly revision: string;
  readonly source: ThreadRecoveryPreview['source'];
  readonly rebuildUnavailable: string | null;
  readonly blockers: readonly string[];
  readonly resourceCount: number;
}

export interface ThreadRecoveryOperation {
  readonly id: string;
  readonly threadId: string;
  readonly action: ThreadRecoveryAction;
  readonly source: ThreadRecoveryPreview['source'];
  readonly revision: string;
  readonly threads: readonly Thread[];
  readonly resourceCount: number;
  readonly phase: ThreadRecoveryPhase;
  readonly completedSteps: number;
  readonly error: string | null;
}

export interface ThreadRecoveryStep {
  readonly name: string;
  run(): Promise<void> | void;
}

export interface ThreadRecoveryParticipant {
  readonly name: string;
  inspect(threadIds: readonly string[]): Promise<{ readonly state: unknown; readonly blockers: readonly string[] }>;
  retain(threadIds: readonly string[], evidence: RecoveryEvidence): Promise<void>;
  remove(threadIds: readonly string[]): Promise<void>;
  withLock<T>(threadIds: readonly string[], operation: () => Promise<T>): Promise<T>;
}

export interface ThreadRecoveryOptions {
  readonly root: string;
  readonly journal: {
    read(): readonly { readonly id: string; readonly value: string }[];
    write(id: string, value: string): void;
  };
  inspect(threadId: string): Promise<RecoveryInspection>;
  withFence<T>(threads: readonly Thread[], operation: () => Promise<T>): Promise<T>;
  retain(operation: ThreadRecoveryOperation, evidence: RecoveryEvidence): Promise<void>;
  steps(operation: ThreadRecoveryOperation, evidence: RecoveryEvidence): readonly ThreadRecoveryStep[];
  changed(operation: ThreadRecoveryOperation): void;
  completed(operation: ThreadRecoveryOperation): Promise<void>;
  /** Fault-injection boundary after durable state, never a production retry policy. */
  checkpoint?: (name: string, operation: ThreadRecoveryOperation) => void | Promise<void>;
}

/** One exact, durable operation across existing owners; this is not a storage repair framework. */
export class ThreadRecoveryService {
  private readonly mutex = new Mutex();
  private readonly operations = new Map<string, ThreadRecoveryOperation>();
  private readonly busy = new Set<string>();

  constructor(private readonly options: ThreadRecoveryOptions) {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
      for (const row of options.journal.read()) {
        const operation = decodeOperation(JSON.parse(row.value));
        if (row.id !== operation.id) throw new Error('Recovery operation identity mismatch');
        this.operations.set(row.id, operation);
      }
  }

  drain(): Promise<void> { return this.mutex.run(async () => undefined); }
  pending(): readonly ThreadRecoveryOperation[] { return [...this.operations.values()].filter((entry) => entry.phase === 'retaining' || entry.phase === 'applying'); }
  isFenced(threadId: string): boolean {
    return [...this.operations.values()].some((entry) => entry.phase !== 'cancelled' && (entry.phase !== 'complete' || entry.action === 'remove')
      && entry.threads.some((thread) => thread.id === threadId));
  }
  isBusy(): boolean { return this.busy.size > 0; }

  private latest(threadId: string): ThreadRecoveryOperation | undefined {
    return [...this.operations.values()].filter((entry) => entry.threadId === threadId && entry.phase !== 'cancelled').at(-1);
  }

  async inspect(threadId: string): Promise<ThreadRecoveryPreview> {
    const previous = this.latest(threadId);
    if (previous && previous.phase !== 'complete') return this.previewFromOperation(previous);
    try { return this.preview(threadId, await this.options.inspect(threadId)); }
    catch (error) { if (previous) return this.previewFromOperation(previous); throw error; }
  }

  async execute(threadId: string, action: ThreadRecoveryAction, revision: string,
    confirm: (preview: ThreadRecoveryPreview) => Promise<boolean>): Promise<{ preview: ThreadRecoveryPreview; cancelled?: true }> {
    return this.mutex.run(async () => {
      const previous = this.latest(threadId);
      if (previous && (previous.phase !== 'complete' || previous.revision === revision)) {
        if (previous.action !== action || previous.revision !== revision) throw new Error('Another recovery operation already owns this conversation');
        return { preview: this.previewFromOperation(previous) };
      }
      const observed = await this.options.inspect(threadId);
      this.assertEligible(observed, action, revision);
      const preview = this.preview(threadId, observed);
      if (!await confirm(preview)) return { preview, cancelled: true };
      return this.options.withFence(observed.threads, async () => {
        const current = await this.options.inspect(threadId);
        this.assertEligible(current, action, revision);
        let operation: ThreadRecoveryOperation = {
          id: uuidV7(), threadId, action, revision, threads: current.threads,
          source: action === 'rebuild' ? current.source : null, resourceCount: current.resourceCount,
          phase: 'retaining', completedSteps: 0, error: null,
        };
        this.save(operation);
        await this.advance(operation);
        operation = this.operations.get(operation.id)!;
        return { preview: this.previewFromOperation(operation) };
      });
    });
  }

  async resume(threadId: string, operationId: string): Promise<ThreadRecoveryPreview> {
    return this.mutex.run(async () => {
      const operation = this.require(threadId, operationId);
      if (operation.phase === 'cancelled') throw new Error('Recovery observation was replaced');
      if (operation.phase !== 'complete') {
        await this.options.withFence(operation.threads, () => this.advance(operation));
      }
      return this.previewFromOperation(this.require(threadId, operationId));
    });
  }

  async reinspect(threadId: string, operationId: string): Promise<ThreadRecoveryPreview> {
    return this.mutex.run(async () => {
      const operation = this.require(threadId, operationId);
      if (operation.phase !== 'retaining' || operation.completedSteps !== 0) throw new Error('A recovery that has started mutation must resume its original operation');
      await rm(this.evidence(operation).root, { recursive: true, force: true });
      this.save({ ...operation, phase: 'cancelled', error: null });
      return this.preview(threadId, await this.options.inspect(threadId));
    });
  }

  async resumePending(): Promise<void> {
    for (const operation of this.pending()) {
      try { await this.resume(operation.threadId, operation.id); }
      catch (error) {
        const current = this.operations.get(operation.id)!;
        this.save({ ...current, error: startupIssue('agent', error).message });
      }
    }
  }

  async retainedPath(threadId: string, operationId: string): Promise<string> {
    const operation = this.require(threadId, operationId);
    const evidence = this.evidence(operation);
    await evidence.verify();
    return evidence.root;
  }

  private require(threadId: string, operationId: string): ThreadRecoveryOperation {
    const operation = this.operations.get(operationId);
    if (!operation || operation.threadId !== threadId) throw new Error('Recovery operation is no longer available');
    return operation;
  }

  private assertEligible(inspection: RecoveryInspection, action: ThreadRecoveryAction, revision: string): void {
    if (inspection.revision !== revision) throw new Error('Recovery scope changed. Inspect the conversation again.');
    if (inspection.blockers.length) throw new Error(inspection.blockers.join('\n'));
    if (action === 'rebuild' && !inspection.source) throw new Error(inspection.rebuildUnavailable ?? 'No complete recovery source is available');
  }

  private async advance(initial: ThreadRecoveryOperation): Promise<void> {
    let operation = initial;
    const evidence = this.evidence(operation);
    this.busy.add(operation.id);
    try {
      if (operation.phase === 'retaining') {
        const current = await this.options.inspect(operation.threadId);
        this.assertEligible(current, operation.action, operation.revision);
        await this.options.checkpoint?.('before-retention', operation);
        await this.options.retain(operation, evidence);
        await evidence.seal();
        // Retention is read-only. Revalidate before recording permission to mutate.
        this.assertEligible(await this.options.inspect(operation.threadId), operation.action, operation.revision);
        operation = { ...operation, phase: 'applying', error: null };
        this.save(operation);
        await this.options.checkpoint?.('retained', operation);
      }
      await evidence.verify();
      const steps = this.options.steps(operation, evidence);
      if (operation.completedSteps > steps.length) throw new Error('Recovery progress exceeds the current operation');
      for (let index = operation.completedSteps; index < steps.length; index++) {
        const step = steps[index]!;
        await step.run();
        await this.options.checkpoint?.(`applied:${step.name}`, operation);
        operation = { ...operation, completedSteps: index + 1, error: null };
        this.save(operation);
        await this.options.checkpoint?.(`committed:${step.name}`, operation);
      }
      await this.options.completed(operation);
      operation = { ...operation, phase: 'complete', error: null };
      this.save(operation);
    } catch (error) {
      this.save({ ...operation, error: startupIssue('agent', error).message });
      throw error;
    } finally { this.busy.delete(operation.id); }
  }

  private save(operation: ThreadRecoveryOperation): void {
    decodeOperation(operation);
    this.options.journal.write(operation.id, JSON.stringify(operation));
    this.operations.set(operation.id, operation);
    this.options.changed(operation);
  }

  private evidence(operation: ThreadRecoveryOperation): RecoveryEvidence {
    return new RecoveryEvidence(join(this.options.root, operation.id));
  }

  private preview(threadId: string, inspection: RecoveryInspection): ThreadRecoveryPreview {
    return { recoveryId: `thread:${threadId}`, revision: inspection.revision,
      threads: inspection.threads.map(({ id, name, parentThreadId }) => ({ threadId: id, name, parentThreadId })),
      source: inspection.source, rebuildUnavailable: inspection.rebuildUnavailable, blockers: inspection.blockers,
      resourceCount: inspection.resourceCount, retainedRoot: this.options.root, operation: null };
  }

  private previewFromOperation(operation: ThreadRecoveryOperation): ThreadRecoveryPreview {
    return { ...this.preview(operation.threadId, { ...operation, blockers: [], rebuildUnavailable: null }),
      operation: { id: operation.id, action: operation.action, phase: operation.phase,
        completedSteps: operation.completedSteps, error: operation.error, retainedPath: this.evidence(operation).root } };
  }
}

function decodeOperation(value: unknown): ThreadRecoveryOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery operation');
  const operation = value as ThreadRecoveryOperation;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(operation.id) || !uuid.test(operation.threadId)
    || !['rebuild', 'remove'].includes(operation.action) || !['retaining', 'applying', 'complete', 'cancelled'].includes(operation.phase)
    || !/^[a-f0-9]{64}$/.test(operation.revision) || !Array.isArray(operation.threads) || !operation.threads.length
    || !Number.isSafeInteger(operation.completedSteps) || operation.completedSteps < 0
    || !Number.isSafeInteger(operation.resourceCount) || operation.resourceCount < 0
    || (operation.error !== null && (typeof operation.error !== 'string' || operation.error.length > 1_000))
    || ![null, 'rollout', 'history-projection'].includes(operation.source)
    || (operation.action === 'rebuild' && operation.source === null)
    || (operation.phase === 'retaining' && operation.completedSteps !== 0)) throw new Error('Invalid recovery operation fields');
  const ids = new Set<string>();
  for (const thread of operation.threads) {
    decodeThread(thread);
    if (!uuid.test(thread.id) || ids.has(thread.id) || thread.ephemeral) throw new Error('Invalid recovery closure');
    ids.add(thread.id);
  }
  if (operation.threads[0]?.id !== operation.threadId) throw new Error('Invalid recovery root');
  if (operation.threads.slice(1).some((thread) => !thread.parentThreadId || !ids.has(thread.parentThreadId))) {
    throw new Error('Recovery descendant is outside its confirmed closure');
  }
  return operation;
}
