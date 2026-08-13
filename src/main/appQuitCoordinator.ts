export type QuitPhase = 'idle' | 'draining' | 'tearing-down' | 'done';
export type QuitDrainOutcome = 'ready' | 'failed' | 'timeout';
export type QuitDecision = 'retry' | 'quit-anyway' | 'cancel';

export interface QuitCoordinatorHost {
  freezeAdmission(): void;
  unfreezeAdmission(): void;
  commitAdmissionFreeze(): void;
  latestAcceptedRevision(): number;
  durableRevision(): number;
  drainToRevision(revision: number): Promise<void>;
  showDrainFailure(error: unknown, outcome: QuitDrainOutcome): Promise<QuitDecision>;
  teardown(): Promise<void>;
  exit(): void;
}

export interface QuitCoordinatorOptions {
  drainTimeoutMs?: number;
}

interface QuitDrainResult {
  outcome: QuitDrainOutcome;
  error?: unknown;
}

export class AppQuitCoordinator {
  private phaseValue: QuitPhase = 'idle';
  private drainInFlight?: Promise<void>;
  private requestPromise?: Promise<void>;
  private readonly drainTimeoutMs: number;

  constructor(
    private readonly host: QuitCoordinatorHost,
    options: QuitCoordinatorOptions = {},
  ) {
    this.drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? 2_500);
  }

  phase(): QuitPhase {
    return this.phaseValue;
  }

  requestQuit(): Promise<void> {
    if (this.requestPromise) return this.requestPromise;
    this.requestPromise = this.runRequest().finally(() => {
      this.requestPromise = undefined;
    });
    return this.requestPromise;
  }

  private async runRequest(): Promise<void> {
    if (this.phaseValue === 'tearing-down' || this.phaseValue === 'done') return;
    this.phaseValue = 'draining';
    this.host.freezeAdmission();
    // There is intentionally no total-attempt cap here. The 2.5 s deadline
    // bounds each drain attempt, while this dialog is the user-decision
    // boundary: an automatic exit after repeated failures would discard
    // accepted-but-not-durable document changes without an explicit choice.
    while (true) {
      const result = await this.drainOnce();
      if (result.outcome === 'ready' && this.barrierHolds()) break;
      if (result.outcome === 'ready') continue;
      let decision: QuitDecision;
      try {
        decision = await this.host.showDrainFailure(
          this.drainError(result),
          result.outcome,
        );
      } catch (error) {
        this.phaseValue = 'idle';
        this.host.unfreezeAdmission();
        throw error;
      }
      if (decision === 'retry') continue;
      if (decision === 'cancel') {
        this.phaseValue = 'idle';
        this.host.unfreezeAdmission();
        return;
      }
      break;
    }

    this.host.commitAdmissionFreeze();
    this.phaseValue = 'tearing-down';
    try {
      await this.host.teardown();
    } finally {
      // Phase 2 is intentionally irreversible: some services may already be
      // disposed even if a later teardown step fails.
      this.phaseValue = 'done';
      this.host.exit();
    }
  }

  private drainError(result: QuitDrainResult): Error {
    if (result.error instanceof Error) return result.error;
    return result.outcome === 'timeout'
      ? new Error('Workspace persistence drain timed out.')
      : new Error('Workspace persistence did not reach the accepted revision.');
  }

  private barrierHolds(): boolean {
    return this.host.durableRevision() >= this.host.latestAcceptedRevision();
  }

  private async drainOnce(): Promise<QuitDrainResult> {
    // A timed-out operation cannot be cancelled through the host contract. A
    // Retry therefore reuses it with a fresh deadline instead of starting a
    // second drain against the same persistence frontier.
    let drain = this.drainInFlight;
    if (!drain) {
      const target = this.host.latestAcceptedRevision();
      try {
        drain = Promise.resolve(this.host.drainToRevision(target));
      } catch (error) {
        return { outcome: 'failed', error };
      }
      this.drainInFlight = drain;
      void drain.then(
        () => {
          if (this.drainInFlight === drain) this.drainInFlight = undefined;
        },
        () => {
          if (this.drainInFlight === drain) this.drainInFlight = undefined;
        },
      );
    }
    return drainWithTimeout(drain, this.drainTimeoutMs);
  }
}

function drainWithTimeout(drain: Promise<void>, timeoutMs: number): Promise<QuitDrainResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: QuitDrainResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);
    void drain.then(
      () => finish({ outcome: 'ready' }),
      (error) => finish({ outcome: 'failed', error }),
    );
  });
}
