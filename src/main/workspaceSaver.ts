import type { Core, CorePersistenceCapture } from '../core/core';
import {
  WorkspacePersistenceResnapshotRequiredError,
  WorkspacePersistenceStore,
} from './workspacePersistenceStore';

export type WorkspaceSaveFailureListener = (error: unknown, revision: number) => void;

export interface WorkspaceSaverOptions {
  idleDelayMs?: number;
  maxWaitMs?: number;
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
  compactAfterUpdates?: number;
  compactAfterBytes?: number;
  initialUpdateCount?: number;
  initialUpdateBytes?: number;
  initialDurableRevision?: number;
  initialPersistedVersion?: Uint8Array;
  initialPersistedMetadataSequence?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  onFailure?: WorkspaceSaveFailureListener;
}

export interface WorkspaceSaverStatus {
  acceptedRevision: number;
  durableRevision: number;
  dirty: boolean;
  lastError: unknown;
}

interface RevisionWaiter {
  revision: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class WorkspaceSaver {
  private readonly idleDelayMs: number;
  private readonly maxWaitMs: number;
  private readonly retryDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly compactAfterUpdates: number;
  private readonly compactAfterBytes: number;
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly onFailure?: WorkspaceSaveFailureListener;
  private readonly now: () => number;
  private acceptedRevisionValue: number;
  private durableRevisionValue: number;
  private persistedVersion: Uint8Array;
  private persistedMetadataSequence: number;
  private pending = false;
  private compactionPending = false;
  private running = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private maxWaitTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAttempt = 0;
  private idleWindowReached = false;
  private firstDirtyAt: number | undefined;
  private forceRunAfterCurrent = false;
  private resnapshotPending = false;
  private updateCount = 0;
  private updateBytes = 0;
  private lastErrorValue: unknown = undefined;
  private waiters: RevisionWaiter[] = [];

  constructor(
    private readonly core: Core,
    private readonly store: WorkspacePersistenceStore,
    options: WorkspaceSaverOptions = {},
  ) {
    this.idleDelayMs = Math.max(0, options.idleDelayMs ?? 700);
    this.maxWaitMs = Math.max(this.idleDelayMs, options.maxWaitMs ?? 5_000);
    this.retryDelayMs = Math.max(50, options.retryDelayMs ?? 1_000);
    this.retryMaxDelayMs = Math.max(this.retryDelayMs, options.retryMaxDelayMs ?? 30_000);
    this.compactAfterUpdates = Math.max(1, options.compactAfterUpdates ?? 64);
    this.compactAfterBytes = Math.max(1, options.compactAfterBytes ?? 2 * 1024 * 1024);
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
    this.onFailure = options.onFailure;
    this.now = options.now ?? Date.now;
    this.acceptedRevisionValue = core.persistenceRevision();
    this.durableRevisionValue = Math.min(
      this.acceptedRevisionValue,
      Math.max(0, Math.trunc(options.initialDurableRevision ?? this.acceptedRevisionValue)),
    );
    this.persistedVersion = options.initialPersistedVersion?.slice() ?? core.loadedPersistenceVersion();
    this.persistedMetadataSequence = Math.max(
      0,
      Math.trunc(options.initialPersistedMetadataSequence ?? core.persistenceMetadataSequence()),
    );
    this.pending = this.durableRevisionValue < this.acceptedRevisionValue;
    if (this.pending) this.firstDirtyAt = this.now();
    this.updateCount = Math.max(0, Math.trunc(options.initialUpdateCount ?? 0));
    this.updateBytes = Math.max(0, Math.trunc(options.initialUpdateBytes ?? 0));
    if (this.pending) this.armTimers();
  }

  status(): WorkspaceSaverStatus {
    return {
      acceptedRevision: this.acceptedRevisionValue,
      durableRevision: this.durableRevisionValue,
      dirty: this.pending || this.durableRevisionValue < this.acceptedRevisionValue,
      lastError: this.lastErrorValue,
    };
  }

  acceptedRevision(): number {
    return this.acceptedRevisionValue;
  }

  durableRevision(): number {
    return this.durableRevisionValue;
  }

  markAccepted(): number {
    const revision = this.core.persistenceRevision();
    if (revision <= this.acceptedRevisionValue) return this.acceptedRevisionValue;
    this.acceptedRevisionValue = revision;
    this.pending = true;
    this.firstDirtyAt ??= this.now();
    this.idleWindowReached = false;
    if (!this.running && !this.retryTimer) this.armTimers();
    return revision;
  }

  scheduleSave(): void {
    this.markAccepted();
  }

  waitForDurable(revision = this.acceptedRevisionValue): Promise<void> {
    // A compaction failure is orthogonal to append durability. Once the target
    // revision is durable, callers must not be held hostage by an optional
    // snapshot rewrite retry.
    if (this.durableRevisionValue >= revision) return Promise.resolve();
    this.markAccepted();
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ revision, resolve, reject });
      // An explicit durability request is a user-controlled retry (trusted
      // transaction, flush, or quit), so it does not wait behind the automatic
      // retry backoff.
      this.forceRunAfterCurrent = true;
      this.startRun(true);
    });
  }

  async flushPending(): Promise<void> {
    this.markAccepted();
    const target = this.acceptedRevisionValue;
    await this.waitForDurable(target);
  }

  dispose(): void {
    if (this.idleTimer) this.cancel(this.idleTimer);
    if (this.maxWaitTimer) this.cancel(this.maxWaitTimer);
    if (this.retryTimer) this.cancel(this.retryTimer);
    this.idleTimer = undefined;
    this.maxWaitTimer = undefined;
    this.retryTimer = undefined;
  }

  private armTimers(): void {
    if (this.idleTimer) this.cancel(this.idleTimer);
    this.idleWindowReached = false;
    this.idleTimer = this.schedule(() => {
      this.idleTimer = undefined;
      this.idleWindowReached = true;
      this.startRun();
    }, this.idleDelayMs);
    if (this.pending && this.core.persistenceCaptureAvailable() && !this.maxWaitTimer) {
      const elapsed = this.now() - (this.firstDirtyAt ?? this.now());
      this.maxWaitTimer = this.schedule(() => {
        this.maxWaitTimer = undefined;
        this.startRun();
      }, Math.max(0, this.maxWaitMs - elapsed));
    }
  }

  private startRun(forceRetry = false): void {
    if (this.running) {
      if (forceRetry) this.forceRunAfterCurrent = true;
      return;
    }
    if (this.retryTimer) {
      if (!forceRetry) return;
      this.cancel(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.pending && !this.compactionPending && this.waiters.length === 0) return;
    if (this.idleTimer) this.cancel(this.idleTimer);
    if (this.maxWaitTimer) this.cancel(this.maxWaitTimer);
    this.idleTimer = undefined;
    this.maxWaitTimer = undefined;
    this.running = true;
    this.forceRunAfterCurrent = false;
    void this.run().finally(() => {
      this.running = false;
      if (!(this.pending || this.compactionPending || this.waiters.length > 0)) return;
      if ((this.forceRunAfterCurrent || this.waiters.length > 0) && this.core.persistenceCaptureAvailable()) {
        this.startRun(true);
        return;
      }
      if (!this.retryTimer) this.armTimers();
    });
  }

  private async run(): Promise<void> {
    // Yielding Core transactions expose intermediate in-memory state while their
    // rollback frontier is still live. That is ordinary contention, not a save
    // failure: leave the revision dirty and retry once the transaction settles.
    if (!this.core.persistenceCaptureAvailable()) {
      return;
    }
    const targetRevision = this.acceptedRevisionValue;
    const capturedDirtyAt = this.firstDirtyAt;
    // Mutations accepted while append/compaction awaits I/O belong to a new
    // dirty epoch. Clearing here lets markAccepted timestamp that epoch instead
    // of inheriting an already-expired max-wait deadline forever.
    this.firstDirtyAt = undefined;
    let appended = false;
    try {
      if (this.resnapshotPending) {
        const compactedRevision = await this.compact();
        this.finishResnapshot(compactedRevision);
        return;
      }
      if (this.pending || this.durableRevisionValue < targetRevision) {
        const capture = this.core.capturePersistenceUpdate(this.persistedVersion, this.persistedMetadataSequence);
        if (capture.update.byteLength > 0 || capture.local.operationHistoryUpserts.length > 0
          || capture.local.operationHistoryDeletes.length > 0 || capture.local.loroPendingUpdates) {
          this.updateBytes = await this.store.append(capture);
          this.persistedVersion = capture.version;
          this.persistedMetadataSequence = capture.metadataSequence;
          this.updateCount += 1;
          this.core.acknowledgePersistenceMetadata(capture.metadataSequence);
        }
        this.durableRevisionValue = Math.max(this.durableRevisionValue, targetRevision);
        this.pending = this.core.persistenceRevision() > this.durableRevisionValue;
        if (this.pending) this.firstDirtyAt ??= this.now();
        this.lastErrorValue = undefined;
        this.resetRetryBackoff();
        this.resolveWaiters();
        if (this.shouldCompact()) this.compactionPending = true;
      }
      appended = true;
      if (
        this.compactionPending
        && this.idleWindowReached
        && this.core.persistenceRevision() === targetRevision
        && this.core.persistenceCaptureAvailable()
      ) {
        try {
          await this.compact();
          this.compactionPending = false;
          this.lastErrorValue = undefined;
          this.resetRetryBackoff();
        } catch (error) {
          // The append above is already durable. Keep that acknowledgement even
          // when the optional snapshot rewrite fails; retry compaction later.
          this.lastErrorValue = error;
          this.notifyFailure(error, targetRevision);
          this.scheduleRetry();
        }
      }
      if (this.core.persistenceRevision() > this.durableRevisionValue) {
        this.pending = true;
        this.firstDirtyAt ??= this.now();
      }
      if (!this.compactionPending) this.resetRetryBackoff();
    } catch (caught) {
      let error = caught;
      if (caught instanceof WorkspacePersistenceResnapshotRequiredError) {
        this.resnapshotPending = true;
        try {
          const compactedRevision = await this.compact();
          this.finishResnapshot(compactedRevision);
          return;
        } catch (compactError) {
          error = compactError;
        }
      }
      this.lastErrorValue = error;
      this.notifyFailure(error, targetRevision);
      if (!appended) this.rejectWaiters(error, targetRevision);
      // A failed append did not pass an idle boundary. Require a fresh quiet
      // window before allowing a threshold compaction on the retry path.
      this.idleWindowReached = false;
      this.pending = true;
      this.firstDirtyAt = earliestTimestamp(capturedDirtyAt, this.firstDirtyAt) ?? this.now();
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const exponent = Math.min(this.retryAttempt, 30);
    const delayMs = Math.min(this.retryMaxDelayMs, this.retryDelayMs * (2 ** exponent));
    this.retryAttempt += 1;
    this.retryTimer = this.schedule(() => {
      this.retryTimer = undefined;
      this.startRun();
    }, delayMs);
  }

  private resetRetryBackoff(): void {
    this.retryAttempt = 0;
    if (!this.retryTimer) return;
    this.cancel(this.retryTimer);
    this.retryTimer = undefined;
  }

  private notifyFailure(error: unknown, revision: number): void {
    try {
      this.onFailure?.(error, revision);
    } catch {
      // Observability must never disable persistence retries or alter the ack
      // state machine.
    }
  }

  private async compact(): Promise<number> {
    const snapshot = this.core.capturePersistenceSnapshot();
    await this.store.compact(snapshot.raw);
    this.persistedVersion = snapshot.version;
    this.persistedMetadataSequence = snapshot.metadataSequence;
    this.core.acknowledgePersistenceMetadata(snapshot.metadataSequence);
    this.updateCount = 0;
    this.updateBytes = 0;
    return snapshot.persistenceRevision;
  }

  private finishResnapshot(durableRevision: number): void {
    this.resnapshotPending = false;
    this.durableRevisionValue = Math.max(this.durableRevisionValue, durableRevision);
    this.pending = this.core.persistenceRevision() > this.durableRevisionValue;
    if (this.pending) this.firstDirtyAt ??= this.now();
    this.compactionPending = false;
    this.lastErrorValue = undefined;
    this.resetRetryBackoff();
    this.resolveWaiters();
  }

  private shouldCompact(): boolean {
    return this.updateCount >= this.compactAfterUpdates || this.updateBytes >= this.compactAfterBytes;
  }

  private resolveWaiters(): void {
    const ready = this.waiters.filter((waiter) => waiter.revision <= this.durableRevisionValue);
    this.waiters = this.waiters.filter((waiter) => waiter.revision > this.durableRevisionValue);
    for (const waiter of ready) waiter.resolve();
  }

  private rejectWaiters(error: unknown, throughRevision: number): void {
    const rejected = this.waiters.filter((waiter) => waiter.revision <= throughRevision);
    this.waiters = this.waiters.filter((waiter) => waiter.revision > throughRevision);
    for (const waiter of rejected) waiter.reject(error);
  }

}

function earliestTimestamp(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}
