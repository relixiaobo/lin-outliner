import type { Thread, ThreadId, Turn } from '../../../../core/agent/protocol';
import { MemoryControlStore, type MemoryDirtyJob, type MemoryPublicationRecord } from './MemoryControlStore';
import { Phase1, type Phase1Source } from './Phase1';
import { Phase2 } from './Phase2';
import { TimelineMemoryStore } from './TimelineMemoryStore';

const DEFAULT_MAX_THREAD_AGE_MS = 10 * 24 * 60 * 60 * 1_000;
const DEFAULT_MIN_THREAD_IDLE_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_MAX_STARTUP_THREADS = 2;

export interface MemoryPipelineSourceHost {
  persistentRootThreads(): readonly Thread[];
  readSource(threadId: ThreadId): Phase1Source | null;
}

export interface MemoryPipelineOptions {
  readonly now?: () => number;
  readonly maxThreadAgeMs?: number;
  readonly minThreadIdleMs?: number;
  readonly maxStartupThreads?: number;
  readonly recoverResetPublication?: (record: MemoryPublicationRecord, receiptMatches: boolean) => Promise<void>;
}

export class MemoryPipeline {
  private readonly now: () => number;
  private readonly maxThreadAgeMs: number;
  private readonly minThreadIdleMs: number;
  private readonly maxStartupThreads: number;
  private running: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private activeController: AbortController | null = null;
  private recovered = false;
  private started = false;
  private stopped = false;
  private suspended = false;

  constructor(
    private readonly control: MemoryControlStore,
    private readonly timeline: TimelineMemoryStore,
    private readonly phase1: Phase1,
    private readonly phase2: Phase2,
    private readonly sources: MemoryPipelineSourceHost,
    private readonly options: MemoryPipelineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxThreadAgeMs = options.maxThreadAgeMs ?? DEFAULT_MAX_THREAD_AGE_MS;
    this.minThreadIdleMs = options.minThreadIdleMs ?? DEFAULT_MIN_THREAD_IDLE_MS;
    this.maxStartupThreads = options.maxStartupThreads ?? DEFAULT_MAX_STARTUP_THREADS;
  }

  async recover(): Promise<void> {
    if (this.stopped) throw new Error('Memory pipeline cannot restart after shutdown');
    if (this.recovered) return;
    await this.recoverPublications();
    this.recovered = true;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.recover();
    this.started = true;
    if (this.control.featureMode() !== 'enabled') {
      this.suspended = true;
      return;
    }
    this.scanEligibleThreads();
    this.wake();
  }

  suspend(): void {
    this.suspended = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.activeController?.abort();
  }

  resume(): void {
    if (this.stopped) return;
    this.suspended = false;
    this.wake();
  }

  wakeThread(thread: Thread): void {
    if (!isEligibleRootThread(thread) || this.control.threadMode(thread.id) !== 'enabled') return;
    const availableAt = Math.max(this.now(), thread.updatedAt + this.minThreadIdleMs);
    this.control.scheduleJob(`phase1:${thread.id}`, 'phase1', { threadId: thread.id }, availableAt, this.now());
    this.wake();
  }

  wakeGlobal(reason: string): void {
    this.control.enqueueJob('phase2:global', 'phase2', { reason }, this.now());
    this.wake();
  }

  wakePending(): void {
    this.wake();
  }

  scanEligibleThreads(): void {
    if (this.control.featureMode() !== 'enabled') return;
    const cutoff = this.now() - this.maxThreadAgeMs;
    const candidates = this.sources.persistentRootThreads()
      .filter((thread) => isEligibleRootThread(thread) && thread.updatedAt >= cutoff)
      .filter((thread) => thread.status.type === 'idle' && this.control.threadMode(thread.id) === 'enabled')
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, this.maxStartupThreads);
    for (const thread of candidates) {
      const availableAt = Math.max(this.now(), thread.updatedAt + this.minThreadIdleMs);
      this.control.scheduleJob(`phase1:${thread.id}`, 'phase1', { threadId: thread.id }, availableAt, this.now());
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.activeController?.abort();
    await this.running;
  }

  private wake(): void {
    if (this.stopped || this.suspended || this.running) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.running = this.drain().finally(() => {
      this.running = null;
      this.scheduleNextWake();
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && !this.suspended) {
      const job = this.control.nextJob(this.now());
      if (!job) return;
      try {
        await this.runJob(job);
        this.control.completeJob(job.key);
      } catch (error) {
        if (isAbortError(error) && (this.stopped || this.suspended)) return;
        this.control.failJob(job.key, errorMessage(error), this.now());
        return;
      }
    }
  }

  private async runJob(job: MemoryDirtyJob): Promise<void> {
    if (job.kind !== 'reset') await this.recoverPublications();
    const controller = new AbortController();
    this.activeController = controller;
    if (this.stopped) controller.abort();
    try {
      if (job.kind === 'phase1') {
        const threadId = payloadThreadId(job.payload);
        const source = this.sources.readSource(threadId);
        if (!source || source.thread.status.type !== 'idle') return;
        await this.phase1.run(source, controller.signal);
        return;
      }
      if (job.kind === 'phase2') {
        await this.phase2.run(controller.signal);
        return;
      }
      if (job.kind === 'rollback') {
        const rollbackId = payloadString(job.payload, 'rollbackId');
        const rollback = this.control.rollback(rollbackId);
        if (!rollback || rollback.status === 'aborted' || rollback.status === 'reconciled') return;
        this.control.enqueueJob(`phase1:${rollback.threadId}`, 'phase1', { threadId: rollback.threadId }, this.now());
        this.control.enqueueJob('phase2:global', 'phase2', { reason: 'rollback', rollbackId }, this.now());
        return;
      }
      if (job.kind === 'reset') {
        const publicationId = payloadString(job.payload, 'publicationId');
        const publication = this.control.publication(publicationId);
        if (!publication || publication.status === 'finalized') return;
        if (publication.kind !== 'reset') throw new Error(`Memory reset job targets ${publication.kind} publication`);
        await this.options.recoverResetPublication?.(publication, false);
        return;
      }
      throw new Error(`Unknown Memory job kind: ${job.kind}`);
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private async recoverPublications(): Promise<void> {
    for (const record of this.control.preparedPublications()) {
      const matches = await this.timeline.hasPublication(record.id, record.digest);
      if (matches) {
        if (record.kind === 'stage1') await this.phase1.recoverPrepared(record, true);
        else if (record.kind === 'stage2') await this.phase2.recoverPrepared(record, true);
        else await this.options.recoverResetPublication?.(record, true);
        continue;
      }
      if (record.kind === 'reset') {
        await this.options.recoverResetPublication?.(record, false);
        continue;
      }
      this.control.discardPreparedPublication(record.id);
      if (record.kind === 'stage1') {
        const threadId = payloadString(record.payload, 'threadId');
        this.control.enqueueJob(`phase1:${threadId}`, 'phase1', { threadId }, this.now());
      } else if (record.kind === 'stage2') {
        this.control.enqueueJob('phase2:global', 'phase2', { reason: 'publication-recovery' }, this.now());
      }
    }
  }

  private scheduleNextWake(): void {
    if (this.stopped || this.suspended || this.running || this.retryTimer) return;
    const availableAt = this.control.nextJobAvailableAt();
    if (availableAt === null) return;
    const delay = Math.max(0, Math.min(60_000, availableAt - this.now()));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.wake();
    }, delay);
    this.retryTimer.unref?.();
  }
}

function isEligibleRootThread(thread: Thread): boolean {
  return !thread.ephemeral && thread.parentThreadId === null && thread.threadSource === 'user';
}

function payloadThreadId(value: unknown): ThreadId {
  return payloadString(value, 'threadId');
}

function payloadString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Memory job payload must contain ${key}`);
  const result = (value as Record<string, unknown>)[key];
  if (typeof result !== 'string' || !result.trim()) throw new Error(`Memory job payload must contain ${key}`);
  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function phase1Source(thread: Thread, turns: readonly Turn[]): Phase1Source {
  return { thread, turns };
}
