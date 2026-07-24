export type RollbackHookRecoveryTarget = 'abort' | 'commit';

export interface RollbackHookRecoveryTask {
  readonly extensionId: string;
  readonly rollbackId: string;
  readonly target: RollbackHookRecoveryTarget;
  readonly run: () => Promise<void>;
}

export interface RollbackHookRecoveryDiagnostic {
  readonly extensionId: string;
  readonly rollbackId: string;
  readonly target: RollbackHookRecoveryTarget;
  readonly attempts: number;
  readonly message: string;
}

interface PendingTask extends RollbackHookRecoveryTask {
  attempts: number;
  nextAttemptAt: number;
}

const RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_DIAGNOSTICS = 64;

export class RollbackHookRecoveryQueue {
  private readonly tasks = new Map<string, PendingTask>();
  private readonly diagnostics = new Map<string, RollbackHookRecoveryDiagnostic>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;
  private closing = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  enqueue(task: RollbackHookRecoveryTask): void {
    if (this.closing) return;
    const key = taskKey(task.extensionId, task.rollbackId);
    const existing = this.tasks.get(key);
    if (existing) {
      if (existing.target !== task.target) {
        throw new Error(`Rollback hook recovery target changed for ${task.extensionId}:${task.rollbackId}`);
      }
      return;
    }
    this.tasks.set(key, { ...task, attempts: 0, nextAttemptAt: this.now() });
    this.schedule();
  }

  diagnosticsSnapshot(): readonly RollbackHookRecoveryDiagnostic[] {
    return [...this.diagnostics.values()];
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.draining;
    this.tasks.clear();
  }

  private schedule(): void {
    if (this.closing || this.draining || this.timer || this.tasks.size === 0) return;
    const nextAttemptAt = Math.min(...[...this.tasks.values()].map((task) => task.nextAttemptAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draining = this.drain().finally(() => {
        this.draining = null;
        this.schedule();
      });
    }, Math.max(0, nextAttemptAt - this.now()));
  }

  private async drain(): Promise<void> {
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.nextAttemptAt <= this.now())
      .sort((left, right) => left[1].nextAttemptAt - right[1].nextAttemptAt || left[0].localeCompare(right[0]));
    for (const [key, task] of due) {
      if (this.closing || this.tasks.get(key) !== task) continue;
      try {
        await task.run();
        this.tasks.delete(key);
        this.diagnostics.delete(key);
      } catch (error) {
        task.attempts += 1;
        task.nextAttemptAt = this.now() + retryDelay(task.attempts, this.random);
        this.recordDiagnostic(key, task, error);
      }
    }
  }

  private recordDiagnostic(key: string, task: PendingTask, error: unknown): void {
    this.diagnostics.delete(key);
    this.diagnostics.set(key, {
      extensionId: task.extensionId,
      rollbackId: task.rollbackId,
      target: task.target,
      attempts: task.attempts,
      message: error instanceof Error ? error.message : String(error),
    });
    while (this.diagnostics.size > MAX_DIAGNOSTICS) {
      const oldest = this.diagnostics.keys().next().value;
      if (oldest === undefined) break;
      this.diagnostics.delete(oldest);
    }
  }
}

function taskKey(extensionId: string, rollbackId: string): string {
  return JSON.stringify([extensionId, rollbackId]);
}

function retryDelay(attempts: number, random: () => number): number {
  const base = RETRY_DELAYS_MS[attempts - 1] ?? MAX_RETRY_DELAY_MS;
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.round(base * jitter);
}
