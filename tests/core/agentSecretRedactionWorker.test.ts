import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { SecretScanWorkerPool } from '../../src/main/agent/capabilities/agentSecretRedactionWorkerClient';
import {
  scanSecretStrings,
  type SecretStringScanJob,
} from '../../src/main/agent/capabilities/agentSecretStringScanner';

class ControlledWorker extends EventEmitter {
  readonly requests: Array<{ readonly id: number; readonly jobs: readonly SecretStringScanJob[] }> = [];
  terminated = false;

  postMessage(request: { readonly id: number; readonly jobs: readonly SecretStringScanJob[] }): void {
    this.requests.push(request);
  }

  unref(): void {}

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

const pools: SecretScanWorkerPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function createPool(
  factory: () => Promise<Worker>,
  options: { readonly maxWorkers?: number; readonly requestTimeoutMs?: number } = {},
): SecretScanWorkerPool {
  const pool = new SecretScanWorkerPool(factory, {
    maxWorkers: options.maxWorkers ?? 2,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
  });
  pools.push(pool);
  return pool;
}

describe('agent secret redaction worker', () => {
  test('runs the real worker entry and matches the direct arbitrary-span scan', async () => {
    const pool = createPool(async () => new Worker(
      new URL('../../src/main/agent/capabilities/agentSecretRedactionWorker.ts', import.meta.url),
      { name: 'agent-secret-redaction-test' },
    ));
    const jobs = [{
      content: [
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'ordinary key material words '.repeat(10_000),
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'),
      inspectEncodedJson: false,
    }];

    await expect(pool.scan(jobs)).resolves.toEqual(scanSecretStrings(jobs));
  });

  test('dispatches concurrent batches to separate bounded workers', async () => {
    const workers: ControlledWorker[] = [];
    const pool = createPool(async () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const first = pool.scan([{ content: 'first batch', inspectEncodedJson: false }]);
    const second = pool.scan([{ content: 'second batch', inspectEncodedJson: false }]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(workers).toHaveLength(2);
    expect(workers.map((worker) => worker.requests.length)).toEqual([1, 1]);
    for (const worker of workers) {
      const request = worker.requests[0]!;
      worker.emit('message', { id: request.id, outputs: [request.jobs[0]!.content] });
    }

    await expect(Promise.all([first, second])).resolves.toEqual([['first batch'], ['second batch']]);
  });

  test('times out and terminates a busy but live worker', async () => {
    const worker = new ControlledWorker();
    const pool = createPool(
      async () => worker as unknown as Worker,
      { maxWorkers: 1, requestTimeoutMs: 20 },
    );

    await expect(pool.scan([{ content: 'never completes', inspectEncodedJson: false }]))
      .rejects.toThrow('exceeded 20ms');
    expect(worker.terminated).toBe(true);
  });
});
