export type DesktopHostPhase = 'constructed' | 'starting' | 'started' | 'quitting' | 'disposed';
export type DesktopHostQuitOutcome = 'cancelled' | 'disposed';

export interface DesktopHostStartContext {
  readonly assertActive: () => void;
}

export interface DesktopHostStartStep {
  readonly name: string;
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

  constructor(private readonly options: DesktopHostLifecycleOptions) {}

  phase(): DesktopHostPhase {
    return this.currentPhase;
  }

  completedMilestones(): ReadonlySet<string> {
    return new Set(this.milestones);
  }

  start(): Promise<void> {
    if (this.startSettlement) return this.startSettlement;
    if (this.currentPhase !== 'constructed') {
      return Promise.reject(new Error(`Desktop Host cannot start from ${this.currentPhase}.`));
    }
    this.currentPhase = 'starting';
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
    try {
      for (const step of this.options.startSteps) {
        if (this.milestones.has(step.name)) continue;
        this.assertStartupStillOwnsLifecycle();
        await step.run({ assertActive: () => this.assertStartupStillOwnsLifecycle() });
        this.milestones.add(step.name);
        this.assertStartupStillOwnsLifecycle();
      }
      this.currentPhase = 'started';
      this.resolveStart?.();
      this.clearStartCompletion();
    } catch (error) {
      if (error instanceof QuitWonStartupRace) return;
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

    const outcome = await this.options.ordinaryQuit(this.completedMilestones());
    if (outcome === 'cancelled') {
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
}
