/// <reference types="electron-vite/node" />

import type { Worker } from 'node:worker_threads';
import type { SecretStringScanJob } from './agentSecretStringScanner';

const SECRET_SCAN_WORKER_MIN_CHARS = 16_384;
const SECRET_SCAN_WORKER_COUNT = 2;
const SECRET_SCAN_WORKER_TIMEOUT_MS = 5_000;

interface SecretScanWorkerResponse {
  readonly id: number;
  readonly outputs?: readonly string[];
  readonly error?: string;
}

interface PendingRequest {
  readonly id: number;
  readonly jobs: readonly SecretStringScanJob[];
  readonly expectedOutputs: number;
  readonly resolve: (outputs: readonly string[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

interface WorkerSlot {
  readonly worker: Worker;
  current: PendingRequest | null;
}

interface SecretScanWorkerPoolOptions {
  readonly maxWorkers: number;
  readonly requestTimeoutMs: number;
}

export class SecretScanWorkerPool {
  private readonly slots = new Set<WorkerSlot>();
  private readonly queue: PendingRequest[] = [];
  private startingWorkers = 0;
  private nextRequestId = 1;
  private closed = false;

  constructor(
    private readonly createWorker: () => Promise<Worker>,
    private readonly options: SecretScanWorkerPoolOptions,
  ) {
    if (options.maxWorkers < 1 || options.requestTimeoutMs < 1) {
      throw new Error('Secret scanner worker pool limits must be positive.');
    }
  }

  scan(jobs: readonly SecretStringScanJob[]): Promise<readonly string[]> {
    if (jobs.length === 0) return Promise.resolve([]);
    if (this.closed) return Promise.reject(new Error('Secret scanner worker pool is closed.'));
    const id = this.nextRequestId;
    this.nextRequestId = this.nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextRequestId + 1;
    return new Promise<readonly string[]>((resolve, reject) => {
      let request: PendingRequest;
      const timer = setTimeout(() => this.timeoutRequest(request), this.options.requestTimeoutMs);
      request = {
        id,
        jobs,
        expectedOutputs: jobs.length,
        resolve,
        reject,
        timer,
        settled: false,
      };
      this.queue.push(request);
      this.pump();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Secret scanner worker pool is closed.');
    for (const request of this.queue.splice(0)) this.rejectRequest(request, error);
    const terminations: Array<Promise<number>> = [];
    for (const slot of this.slots) {
      this.slots.delete(slot);
      slot.worker.removeAllListeners();
      if (slot.current) this.rejectRequest(slot.current, error);
      terminations.push(slot.worker.terminate());
    }
    await Promise.allSettled(terminations);
  }

  private pump(): void {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (!slot.current) this.dispatch(slot, this.queue.shift()!);
    }
    while (
      this.queue.length > 0
      && this.slots.size + this.startingWorkers < this.options.maxWorkers
    ) {
      this.startWorker(this.queue.shift()!);
    }
  }

  private startWorker(request: PendingRequest): void {
    this.startingWorkers += 1;
    void this.createWorker().then((worker) => {
      this.startingWorkers -= 1;
      if (this.closed || request.settled) {
        void worker.terminate().catch(() => undefined);
        this.pump();
        return;
      }
      const slot: WorkerSlot = { worker, current: null };
      worker.on('message', (response: SecretScanWorkerResponse) => this.handleMessage(slot, response));
      worker.on('error', (error) => this.failSlot(slot, error));
      worker.on('exit', (code) => this.failSlot(slot, new Error(`Secret scanner worker exited (${code}).`)));
      worker.unref();
      this.slots.add(slot);
      this.dispatch(slot, request);
      this.pump();
    }, (error) => {
      this.startingWorkers -= 1;
      this.rejectRequest(request, toError(error));
      this.pump();
    });
  }

  private dispatch(slot: WorkerSlot, request: PendingRequest): void {
    if (request.settled) {
      this.pump();
      return;
    }
    slot.current = request;
    try {
      slot.worker.postMessage({ id: request.id, jobs: request.jobs });
    } catch (error) {
      this.failSlot(slot, error);
    }
  }

  private handleMessage(slot: WorkerSlot, response: SecretScanWorkerResponse): void {
    const request = slot.current;
    if (!request || response.id !== request.id) {
      this.failSlot(slot, new Error('Secret scanner worker returned an unexpected response.'));
      return;
    }
    if (
      response.error
      || !response.outputs
      || response.outputs.length !== request.expectedOutputs
      || response.outputs.some((output) => typeof output !== 'string')
    ) {
      this.failSlot(slot, new Error(response.error ?? 'Secret scanner worker returned an invalid batch.'));
      return;
    }
    slot.current = null;
    this.resolveRequest(request, response.outputs);
    this.pump();
  }

  private timeoutRequest(request: PendingRequest): void {
    if (request.settled) return;
    const slot = [...this.slots].find((candidate) => candidate.current === request);
    const error = new Error(`Secret scanner worker exceeded ${this.options.requestTimeoutMs}ms.`);
    if (slot) {
      this.failSlot(slot, error);
      return;
    }
    const queuedIndex = this.queue.indexOf(request);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    this.rejectRequest(request, error);
  }

  private failSlot(slot: WorkerSlot, value: unknown): void {
    if (!this.slots.delete(slot)) return;
    const request = slot.current;
    slot.current = null;
    slot.worker.removeAllListeners();
    void slot.worker.terminate().catch(() => undefined);
    if (request) this.rejectRequest(request, toError(value));
    this.pump();
  }

  private resolveRequest(request: PendingRequest, outputs: readonly string[]): void {
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    request.resolve(outputs);
  }

  private rejectRequest(request: PendingRequest, error: Error): void {
    if (request.settled) return;
    request.settled = true;
    clearTimeout(request.timer);
    request.reject(error);
  }
}

const workerPool = new SecretScanWorkerPool(startWorker, {
  maxWorkers: SECRET_SCAN_WORKER_COUNT,
  requestTimeoutMs: SECRET_SCAN_WORKER_TIMEOUT_MS,
});

export async function scanSecretStringsOffMain(
  jobs: readonly SecretStringScanJob[],
): Promise<readonly string[] | null> {
  if (jobs.length === 0) return [];
  const totalChars = jobs.reduce((total, job) => total + job.content.length, 0);
  if (!process.versions.electron || totalChars < SECRET_SCAN_WORKER_MIN_CHARS) return null;
  return await workerPool.scan(jobs);
}

async function startWorker(): Promise<Worker> {
  const { default: createWorker } = await import('./agentSecretRedactionWorker?nodeWorker');
  return createWorker({ name: 'agent-secret-redaction' });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
