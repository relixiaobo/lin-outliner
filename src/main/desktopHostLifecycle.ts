import { initialStartupState, type StartupIssue, type StartupState, type StartupThreadAvailability } from '../core/startup';
import { startupIssue } from './startupIssue';

export type DesktopHostPhase = 'constructed' | 'starting' | 'failed' | 'started' | 'quitting' | 'disposed';
export type DesktopHostQuitOutcome = 'cancelled' | 'disposed';

export interface DesktopHostStartContext {
  readonly assertActive: () => void;
}

export interface DesktopHostStartStep {
  readonly name: string;
  readonly dependsOn?: readonly string[];
  readonly retryable?: boolean;
  readonly source?: StartupIssue['source'];
  readonly run: (context: DesktopHostStartContext) => void | Promise<void>;
}

export interface DesktopHostLifecycleOptions {
  readonly startSteps: readonly DesktopHostStartStep[];
  readonly closeAdmission: () => void;
  readonly ordinaryQuit: (milestones: ReadonlySet<string>) => Promise<DesktopHostQuitOutcome>;
  readonly rollback: (
    milestones: ReadonlySet<string>,
    cause: 'startup-failure' | 'quit-before-start',
  ) => void | Promise<void>;
  readonly exitAfterStartupFailure: () => void;
  readonly exitAfterEarlyQuit: () => void;
  readonly onStartupState?: (state: StartupState) => void;
}

class QuitWonStartupRace extends Error {
  constructor() {
    super('Quit won the Desktop Host startup race.');
    this.name = 'QuitWonStartupRace';
  }
}

export class DesktopHostLifecycle {
  private currentPhase: DesktopHostPhase = 'constructed';
  private readonly milestones = new Set<string>();
  private startSettlement: Promise<void> | null = null;
  private startAttemptSettlement: Promise<void> | null = null;
  private resolveStart: (() => void) | null = null;
  private rejectStart: ((error: unknown) => void) | null = null;
  private quitSettlement: Promise<void> | null = null;
  private readonly readiness = new Map<string, Promise<void>>();
  private startupState: StartupState = initialStartupState();
  private readonly issues = new Map<string, StartupIssue>();
  private threadIssues: readonly StartupIssue[] = [];
  private threadAvailability: readonly StartupThreadAvailability[] = [];

  setThreadIssues(issues: readonly StartupIssue[], threads: readonly StartupThreadAvailability[]): void {
    this.threadIssues = issues;
    this.threadAvailability = threads;
  }

  private readonly failedReadiness = new Set<string>();

  constructor(private readonly options: DesktopHostLifecycleOptions) {}

  phase(): DesktopHostPhase {
    return this.currentPhase;
  }

  completedMilestones(): ReadonlySet<string> {
    return new Set(this.milestones);
  }

  state(): StartupState {
    return this.startupState;
  }

  ready(name: string): Promise<void> {
    if (this.currentPhase === 'quitting' || this.currentPhase === 'disposed') {
      return Promise.reject(new Error('Desktop Host is closing.'));
    }
    return this.readiness.get(name)
      ?? Promise.reject(new Error(`Desktop Host readiness is unavailable: ${name}.`));
  }

  start(): Promise<void> {
    if (this.startSettlement) return this.startSettlement;
    if (this.currentPhase !== 'constructed' && this.currentPhase !== 'failed') {
      return Promise.reject(new Error(`Desktop Host cannot start from ${this.currentPhase}.`));
    }
    this.currentPhase = 'starting';
    this.issues.clear();
    this.failedReadiness.clear();
    this.publishState({ status: 'starting' });
    this.startSettlement = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.beginStartAttempt();
    return this.startSettlement;
  }

  requestQuit(): Promise<void> {
    if (this.currentPhase === 'disposed') return Promise.resolve();
    if (this.quitSettlement) return this.quitSettlement;

    this.currentPhase = 'quitting';
    this.options.closeAdmission();
    const attempt = this.runQuitAttempt();
    this.quitSettlement = attempt.finally(() => {
      if (this.currentPhase !== 'disposed') this.quitSettlement = null;
    });
    return this.quitSettlement;
  }

  private beginStartAttempt(): void {
    const attempt = this.runStart();
    this.startAttemptSettlement = attempt;
    void attempt.finally(() => {
      if (this.startAttemptSettlement === attempt) this.startAttemptSettlement = null;
    });
  }

  private async runStart(): Promise<void> {
    let failedStep: DesktopHostStartStep | undefined;
    let failure: unknown;
    try {
      this.readiness.clear();
      for (const [index, step] of this.options.startSteps.entries()) {
        const dependencies = step.dependsOn ?? (
          index > 0 ? [this.options.startSteps[index - 1]!.name] : []
        );
        const settlement = (async () => {
          if (this.milestones.has(step.name)) return;
          let entered = false;
          try {
            await Promise.all(dependencies.map((name) => {
              const ready = this.readiness.get(name);
              if (!ready) throw new Error(`Startup dependency ${name} must precede ${step.name}.`);
              return ready;
            }));
            this.assertStartupStillOwnsLifecycle();
            entered = true;
            await step.run({ assertActive: () => this.assertStartupStillOwnsLifecycle() });
            this.milestones.add(step.name);
            this.assertStartupStillOwnsLifecycle();
            this.publishState({ status: 'starting' });
          } catch (error) {
            if (!(error instanceof QuitWonStartupRace)) {
              this.failedReadiness.add(step.name);
              if (entered) {
                this.issues.set(step.name, startupIssue(step.name, error, step.source));
                if (!failedStep || !step.retryable) {
                  failedStep = step;
                  failure = error;
                }
              }
              if (this.currentPhase === 'starting') this.publishState({ status: 'starting' });
            }
            throw error;
          }
        })();
        this.readiness.set(step.name, settlement);
      }
      // Drain every started branch before retry or teardown can reuse its resources.
      const settlements = await Promise.allSettled(this.readiness.values());
      const rejected = settlements.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw failedStep ? failure : rejected.reason;
      this.assertStartupStillOwnsLifecycle();
      this.currentPhase = 'started';
      this.publishState({ status: 'ready' });
      this.resolveStart?.();
      this.clearStartCompletion();
    } catch (error) {
      if (error instanceof QuitWonStartupRace) return;
      if (failedStep?.retryable) {
        if (this.currentPhase === 'quitting') return;
        this.currentPhase = 'failed';
        this.startSettlement = null;
        this.publishState({
          status: 'failed',
          step: failedStep.name,
          message: this.issues.get(failedStep.name)?.message ?? 'Startup failed.',
        });
        this.rejectStart?.(error);
        this.clearStartCompletion();
        return;
      }
      this.currentPhase = 'quitting';
      let rollbackError: unknown;
      try {
        await this.options.rollback(this.completedMilestones(), 'startup-failure');
      } catch (caught) {
        rollbackError = caught;
      }
      this.currentPhase = 'disposed';
      this.options.exitAfterStartupFailure();
      if (rollbackError !== undefined) {
        this.rejectStart?.(new AggregateError(
          [error, rollbackError],
          'Desktop Host startup and failed-start rollback both failed.',
        ));
        this.clearStartCompletion();
        return;
      }
      this.rejectStart?.(error);
      this.clearStartCompletion();
    }
  }

  private async runQuitAttempt(): Promise<void> {
    const wasFailed = this.startupState.status === 'failed';
    await this.startAttemptSettlement;
    if (this.currentPhase === 'disposed') return;

    if (!this.milestones.has('outline-documents')) {
      const failures: unknown[] = [];
      try {
        await this.options.rollback(this.completedMilestones(), 'quit-before-start');
      } catch (error) {
        failures.push(error);
      }
      this.currentPhase = 'disposed';
      this.resolveStart?.();
      this.clearStartCompletion();
      try {
        this.options.exitAfterEarlyQuit();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Desktop Host early quit and cleanup both failed.');
      }
      return;
    }

    let outcome: DesktopHostQuitOutcome;
    try {
      outcome = await this.options.ordinaryQuit(this.completedMilestones());
    } catch (error) {
      // The quit owner retains durability/admission truth; restore actionable UI state.
      this.currentPhase = wasFailed ? 'failed' : this.startupState.status === 'ready' ? 'started' : 'starting';
      if (this.currentPhase === 'starting') this.beginStartAttempt();
      else this.publishState(this.startupState);
      throw error;
    }
    if (outcome === 'cancelled') {
      if (wasFailed) {
        this.currentPhase = 'failed';
        return;
      }
      this.currentPhase = 'starting';
      this.beginStartAttempt();
      return;
    }
    this.currentPhase = 'disposed';
    this.resolveStart?.();
    this.clearStartCompletion();
  }

  private assertStartupStillOwnsLifecycle(): void {
    if (this.currentPhase === 'quitting') throw new QuitWonStartupRace();
    if (this.currentPhase !== 'starting') {
      throw new Error(`Desktop Host startup lost lifecycle ownership in ${this.currentPhase}.`);
    }
  }

  private clearStartCompletion(): void {
    this.resolveStart = null;
    this.rejectStart = null;
  }

  private publishState(state: { readonly status: 'starting' | 'ready' } | {
    readonly status: 'failed'; readonly step: string; readonly message: string;
  }): void {
    const availability = (name: string) => this.milestones.has(name) ? 'ready' as const
      : this.failedReadiness.has(name) ? 'unavailable' as const : 'starting' as const;
    this.startupState = {
      ...state,
      revision: this.startupState.revision + 1,
      capabilities: { outline: availability('outline-documents'), agent: availability('agent') },
      issues: [...this.issues.values(), ...this.threadIssues],
      threads: this.threadAvailability,
    };
    try {
      this.options.onStartupState?.(this.startupState);
    } catch {
      // Notifications and diagnostics cannot change owner readiness or hide an issue.
    }
  }
}
