import type { Automation, AutomationRun } from '../../../core/agent/automation';
import { Mutex } from '../Mutex';
import { automationOccurrencesBetween, isOneOffAutomationSchedule, nextAutomationOccurrence } from './AutomationSchedule';
import { AutomationDispatcher, contextHintForRun } from './AutomationDispatcher';
import { AutomationStore } from './AutomationStore';

const MAX_TIMER_DELAY_MS = 60 * 60 * 1_000;
const PENDING_RETRY_DELAY_MS = 15_000;

export interface AutomationSchedulerOptions {
  readonly canSchedule?: () => boolean;
  readonly store: AutomationStore;
  readonly dispatcher: AutomationDispatcher;
  readonly onAutomationChanged?: (automation: Automation) => void | Promise<void>;
  readonly onRunChanged?: (run: AutomationRun) => void | Promise<void>;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
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
  private lastClock: { wall: number; monotonic: number } | null = null;

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stopped = false;
    this.running = true;
    try {
      await this.wake('unavailable');
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

  wake(reason: 'normal' | 'unavailable' = 'normal'): Promise<void> {
    if (this.stopped || this.options.canSchedule?.() === false) return Promise.resolve();
    return this.runExclusive(async () => {
      if (this.stopped) return;
      this.clearWakeTimer();
      let needsImmediateContinuation = false;
      try {
        const now = this.now();
        const monotonic = (this.options.monotonicNow ?? (() => performance.now()))();
        const jumpedForward = this.lastClock !== null
          && (now - this.lastClock.wall) - (monotonic - this.lastClock.monotonic) > 5_000;
        const unavailableThrough = reason === 'unavailable' || jumpedForward ? now : null;
        this.lastClock = { wall: now, monotonic };
        await this.options.dispatcher.reconcile();
        for (const automation of this.options.store.list({ statuses: ['active'] }, now)) {
          const outcome = await this.evaluateAutomation(automation, now, unavailableThrough);
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

  admitContinuation(automationRunId: string, operation: () => Promise<boolean>): Promise<boolean> {
    return this.runExclusive(async () => {
      if (this.stopped) return false;
      const owner = this.options.store.readRun(automationRunId);
      if (!owner || owner.state !== 'dispatched') return false;
      if (this.options.store.allRunsForAutomation(owner.automationId)
        .some((run) => run.id !== owner.id && this.options.dispatcher.isRunActive(run))) return false;
      return operation();
    });
  }

  private async evaluateAutomation(
    automation: Automation,
    through: number,
    unavailableThrough: number | null,
  ): Promise<{ readonly truncated: boolean }> {
    let truncated = false;
    for (const cursor of this.options.store.bindingCursors(automation)) {
      const binding = contextHintForRun(automation, cursor.contextHintKey);
      const next = nextAutomationOccurrence(automation.schedule, cursor.evaluatedThrough);
      if (unavailableThrough !== null && next !== null && next < unavailableThrough
        && isOneOffAutomationSchedule(automation.schedule) && !cursor.overlapDeferred) {
        this.options.store.recordMissedOccurrence(automation, binding, next, cursor.evaluatedThrough);
        await this.options.onAutomationChanged?.(automation);
        continue;
      }
      const unsettled = this.options.store.allRunsForAutomation(automation.id)
        .find((run) => this.options.dispatcher.isRunActive(run));
      if (unsettled && this.options.dispatcher.isRunActive(unsettled)) {
        const next = nextAutomationOccurrence(automation.schedule, cursor.evaluatedThrough);
        if (next !== null && next <= through) {
          this.options.store.markOverlapDeferred(automation.id, cursor.contextHintKey);
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
