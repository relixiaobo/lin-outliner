export type QuitPhase = 'idle' | 'draining' | 'tearing-down' | 'done';
export type QuitDrainOutcome = 'ready' | 'failed' | 'timeout';
export type QuitDecision = 'retry' | 'quit-anyway' | 'cancel';

export interface QuitCoordinatorHost {
  freezeAdmission(): void;
  unfreezeAdmission(): void | Promise<void>;
  commitAdmissionFreeze(): void | Promise<void>;
  latestAcceptedRevision(): number | Promise<number>;
  durableRevision(): number | Promise<number>;
  drainToRevision(revision: number): Promise<void>;
  showDrainFailure(error: unknown, outcome: QuitDrainOutcome): Promise<QuitDecision>;
  teardown(): Promise<void>;
  shutdownRuntime(signal: AbortSignal): Promise<void>;
  exit(): void;
}

export interface QuitCoordinatorOptions {
  drainTimeoutMs?: number;
  runtimeShutdownTimeoutMs?: number;
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
  private readonly runtimeShutdownTimeoutMs: number;

  constructor(
    private readonly host: QuitCoordinatorHost,
    options: QuitCoordinatorOptions = {},
  ) {
    this.drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? 2_500);
    this.runtimeShutdownTimeoutMs = Math.max(1, options.runtimeShutdownTimeoutMs ?? 2_500);
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
      let result = await this.drainOnce();
      if (result.outcome === 'ready') {
        try {
          if (await this.barrierHolds()) break;
          continue;
        } catch (error) {
          result = { outcome: 'failed', error };
        }
      }
      let decision: QuitDecision;
      try {
        decision = await this.host.showDrainFailure(
          this.drainError(result),
          result.outcome,
        );
      } catch (error) {
        await this.host.unfreezeAdmission();
        this.phaseValue = 'idle';
        throw error;
      }
      if (decision === 'retry') continue;
      if (decision === 'cancel') {
        await this.host.unfreezeAdmission();
        this.phaseValue = 'idle';
        return;
      }
      break;
    }

    this.phaseValue = 'tearing-down';
    let phaseTwoError: unknown;
    try {
      await this.host.commitAdmissionFreeze();
    } catch (error) {
      phaseTwoError = error;
    }
    try {
      await this.host.teardown();
    } catch (error) {
      phaseTwoError ??= error;
    } finally {
      try {
        await shutdownWithTimeout(
          (signal) => this.host.shutdownRuntime(signal),
          this.runtimeShutdownTimeoutMs,
        );
      } catch (error) {
        phaseTwoError ??= error;
      }
      // Phase 2 is intentionally irreversible: services may already be
      // disposed even if Runtime shutdown or a later teardown step fails.
      this.phaseValue = 'done';
      this.host.exit();
    }
    if (phaseTwoError) throw phaseTwoError;
  }

  private drainError(result: QuitDrainResult): Error {
    if (result.error instanceof Error) return result.error;
    return result.outcome === 'timeout'
      ? new Error('Workspace persistence drain timed out.')
      : new Error('Workspace persistence did not reach the accepted revision.');
  }

  private async barrierHolds(): Promise<boolean> {
    return await this.host.durableRevision() >= await this.host.latestAcceptedRevision();
  }

  private async drainOnce(): Promise<QuitDrainResult> {
    // A timed-out operation cannot be cancelled through the host contract. A
    // Retry therefore reuses it with a fresh deadline instead of starting a
    // second drain against the same persistence frontier.
    let drain = this.drainInFlight;
    if (!drain) {
      try {
        drain = Promise.resolve(this.host.latestAcceptedRevision()).then((target) => (
          this.host.drainToRevision(target)
        ));
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

function shutdownWithTimeout(
  shutdown: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      const error = new Error('Outline Runtime shutdown timed out.');
      controller.abort(error);
      fail(error);
    }, timeoutMs);
    let operation: Promise<void>;
    try {
      operation = shutdown(controller.signal);
    } catch (error) {
      fail(error);
      return;
    }
    void operation.then(
      succeed,
      fail,
    );
  });
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
