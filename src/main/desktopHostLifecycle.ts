export type DesktopHostPhase = 'constructed' | 'starting' | 'started' | 'quitting' | 'disposed';
export type DesktopHostQuitOutcome = 'cancelled' | 'disposed';

export interface DesktopHostStartStep {
  readonly name: string;
  readonly run: () => void | Promise<void>;
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
    this.startSettlement = this.runStart();
    return this.startSettlement;
  }

  requestQuit(): Promise<void> {
    if (this.currentPhase === 'disposed') return Promise.resolve();
    if (this.quitSettlement) return this.quitSettlement;

    this.currentPhase = 'quitting';
    this.options.closeAdmission();
    const attempt = this.runQuitAttempt();
    this.quitSettlement = attempt.finally(() => {
      if (this.currentPhase === 'started') this.quitSettlement = null;
    });
    return this.quitSettlement;
  }

  private async runStart(): Promise<void> {
    try {
      for (const step of this.options.startSteps) {
        this.assertStartupStillOwnsLifecycle();
        await step.run();
        this.milestones.add(step.name);
        this.assertStartupStillOwnsLifecycle();
      }
      this.currentPhase = 'started';
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
        throw new AggregateError(
          [error, rollbackError],
          'Desktop Host startup and failed-start rollback both failed.',
        );
      }
      throw error;
    }
  }

  private async runQuitAttempt(): Promise<void> {
    if (this.startSettlement) {
      try {
        await this.startSettlement;
      } catch {
        return;
      }
      if (this.currentPhase === 'disposed') return;
    }

    if (!this.milestones.has('outline-documents')) {
      await this.options.rollback(this.completedMilestones(), 'quit-before-start');
      this.currentPhase = 'disposed';
      this.options.exitAfterEarlyQuit();
      return;
    }

    const outcome = await this.options.ordinaryQuit(this.completedMilestones());
    this.currentPhase = outcome === 'cancelled' ? 'started' : 'disposed';
  }

  private assertStartupStillOwnsLifecycle(): void {
    if (this.currentPhase === 'quitting') throw new QuitWonStartupRace();
    if (this.currentPhase !== 'starting') {
      throw new Error(`Desktop Host startup lost lifecycle ownership in ${this.currentPhase}.`);
    }
  }
}
