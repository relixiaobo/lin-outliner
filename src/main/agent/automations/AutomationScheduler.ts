import type { Automation, AutomationRun } from '../../../core/agent/automation';
import { Mutex } from '../Mutex';
import { automationOccurrencesBetween, nextAutomationOccurrence } from './AutomationSchedule';
import { AutomationDispatcher, projectBindingForRun } from './AutomationDispatcher';
import { AutomationStore } from './AutomationStore';

const MAX_TIMER_DELAY_MS = 60 * 60 * 1_000;
const PENDING_RETRY_DELAY_MS = 15_000;

export interface AutomationSchedulerOptions {
  readonly store: AutomationStore;
  readonly dispatcher: AutomationDispatcher;
  readonly onAutomationChanged?: (automation: Automation) => void | Promise<void>;
  readonly onRunChanged?: (run: AutomationRun) => void | Promise<void>;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delay: number) => number | NodeJS.Timeout;
  readonly clearTimer?: (timer: number | NodeJS.Timeout) => void;
  readonly onError?: (error: unknown) => void;
}

export class AutomationScheduler {
  private readonly mutex = new Mutex();
  private readonly now: () => number;
  private timer: number | NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopped = false;
    this.running = true;
    try {
      await this.wake();
    } catch (error) {
      this.stopped = true;
      this.running = false;
      this.clearWakeTimer();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.clearWakeTimer();
    await this.mutex.run(async () => undefined);
  }

  wake(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.runExclusive(async () => {
      if (this.stopped) return;
      this.clearWakeTimer();
      let needsImmediateContinuation = false;
      try {
        await this.options.dispatcher.reconcile();
        const now = this.now();
        for (const automation of this.options.store.list({ statuses: ['active'] }, now)) {
          const outcome = await this.evaluateAutomation(automation, now);
          needsImmediateContinuation ||= outcome.truncated;
        }
        await this.options.dispatcher.cleanupRetainedWorktrees();
      } finally {
        if (!this.stopped) this.scheduleNextWake(needsImmediateContinuation);
      }
    });
  }

  runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => operation());
  }

  private async evaluateAutomation(
    automation: Automation,
    through: number,
  ): Promise<{ readonly truncated: boolean }> {
    let truncated = false;
    for (const cursor of this.options.store.bindingCursors(automation)) {
      const binding = projectBindingForRun(automation, cursor.bindingKey);
      const unsettled = this.options.store.latestUnsettledRun(automation.id, cursor.bindingKey);
      if (unsettled && this.options.dispatcher.isRunActive(unsettled)) {
        const next = nextAutomationOccurrence(automation.schedule, cursor.evaluatedThrough);
        if (next !== null && next <= through) {
          this.options.store.markOverlapDeferred(automation.id, cursor.bindingKey);
        }
        continue;
      }
      const batch = automationOccurrencesBetween(
        automation.schedule,
        cursor.evaluatedThrough,
        through,
      );
      const result = this.options.store.claimDueBatch({
        automation,
        binding,
        expectedEvaluatedThrough: cursor.evaluatedThrough,
        evaluatedThrough: batch.evaluatedThrough,
        occurrences: batch.occurrences,
        truncated: batch.truncated,
        now: through,
      });
      if (result.omissions) await this.options.onRunChanged?.(result.omissions);
      if (result.claimed) {
        await this.options.onRunChanged?.(result.claimed);
        await this.options.dispatcher.dispatch(result.claimed);
      }
      truncated ||= batch.truncated;
    }
    if (!truncated) {
      const updated = this.options.store.completeIfExhausted(automation.id, automation.revision, through);
      if (updated?.status === 'completed' && updated.revision !== automation.revision) {
        await this.options.onAutomationChanged?.(updated);
      }
    }
    return { truncated };
  }

  private scheduleNextWake(immediate: boolean): void {
    const now = this.now();
    let delay = immediate ? 0 : MAX_TIMER_DELAY_MS;
    for (const automation of this.options.store.list({ statuses: ['active'] }, now)) {
      if (automation.nextOccurrenceAt !== null) {
        delay = Math.min(delay, Math.max(0, automation.nextOccurrenceAt - now));
      }
    }
    if (this.options.store.pendingRuns().length > 0) delay = Math.min(delay, PENDING_RETRY_DELAY_MS);
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      void this.wake().catch((error) => {
        if (this.options.onError) this.options.onError(error);
        else console.error('[automation] scheduled wake failed', error);
      });
    }, delay);
    if (typeof this.timer === 'object') this.timer.unref();
  }

  private clearWakeTimer(): void {
    if (!this.timer) return;
    if (this.options.clearTimer) this.options.clearTimer(this.timer);
    else clearTimeout(this.timer as NodeJS.Timeout);
    this.timer = null;
  }
}
