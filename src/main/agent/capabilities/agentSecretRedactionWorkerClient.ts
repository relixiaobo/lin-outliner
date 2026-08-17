/// <reference types="electron-vite/node" />

import type { Worker } from 'node:worker_threads';
import {
  scanSecretStrings,
  type SecretStringScanJob,
} from './agentSecretStringScanner';

const SECRET_SCAN_WORKER_MIN_CHARS = 16_384;

interface SecretScanWorkerResponse {
  readonly id: number;
  readonly outputs?: readonly string[];
  readonly error?: string;
}

interface PendingRequest {
  readonly expectedOutputs: number;
  readonly resolve: (outputs: readonly string[]) => void;
  readonly reject: (error: Error) => void;
}

let worker: Worker | null = null;
let workerPromise: Promise<Worker> | null = null;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

export async function scanSecretStringsOffMain(
  jobs: readonly SecretStringScanJob[],
): Promise<readonly string[]> {
  if (jobs.length === 0) return [];
  const totalChars = jobs.reduce((total, job) => total + job.content.length, 0);
  if (!process.versions.electron || totalChars < SECRET_SCAN_WORKER_MIN_CHARS) {
    return scanSecretStrings(jobs);
  }
  const activeWorker = await getWorker();
  const id = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  return await new Promise<readonly string[]>((resolve, reject) => {
    pending.set(id, { expectedOutputs: jobs.length, resolve, reject });
    try {
      activeWorker.postMessage({ id, jobs });
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function getWorker(): Promise<Worker> {
  if (worker) return worker;
  if (!workerPromise) {
    workerPromise = startWorker().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return await workerPromise;
}

async function startWorker(): Promise<Worker> {
  const { default: createWorker } = await import('./agentSecretRedactionWorker?nodeWorker');
  const started = createWorker({ name: 'agent-secret-redaction' });
  started.on('message', handleMessage);
  started.on('error', failWorker);
  started.on('exit', (code) => failWorker(new Error(`Secret scanner worker exited (${code}).`)));
  started.unref();
  worker = started;
  return started;
}

function handleMessage(response: SecretScanWorkerResponse): void {
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id);
  if (
    response.error
    || !response.outputs
    || response.outputs.length !== request.expectedOutputs
    || response.outputs.some((output) => typeof output !== 'string')
  ) {
    request.reject(new Error(response.error ?? 'Secret scanner worker returned an invalid batch.'));
    return;
  }
  request.resolve(response.outputs);
}

function failWorker(value: unknown): void {
  const error = value instanceof Error ? value : new Error(String(value));
  const failed = worker;
  worker = null;
  workerPromise = null;
  failed?.removeAllListeners();
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}
