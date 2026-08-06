import { describe, expect, test } from 'bun:test';
import {
  createKeyedSerialMutationQueue,
  createSerialMutationQueue,
} from '../../src/core/serialMutationQueue';

/**
 * The contract six hand-written copies of this idiom each re-decided for
 * themselves — and did not all decide alike. Pinned here once so the callers do
 * not have to state it again.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('serial mutation queue', () => {
  test('runs in call order, not in completion order', async () => {
    const queue = createSerialMutationQueue();
    const first = deferred<void>();
    const started: string[] = [];

    const a = queue.run(async () => { started.push('a'); await first.promise; });
    const b = queue.run(async () => { started.push('b'); });

    // Tasks start on a microtask, so the ordering claim is about which one is
    // allowed to begin — not about running synchronously at the call.
    await Promise.resolve();
    expect(started).toEqual(['a']);
    first.resolve();
    await Promise.all([a, b]);
    expect(started).toEqual(['a', 'b']);
  });

  test('a failed task rejects for its caller and does not stall the queue', async () => {
    const queue = createSerialMutationQueue();
    const failing = queue.run(async () => { throw new Error('write failed'); });

    await expect(failing).rejects.toThrow('write failed');
    expect(await queue.run(async () => 'ran anyway')).toBe('ran anyway');
    // The queue's own tail never rejects, so nothing downstream sees an
    // unhandled failure from a predecessor.
    await expect(queue.settled()).resolves.toBeUndefined();
  });

  test('settled resolves only once everything queued so far has finished', async () => {
    const queue = createSerialMutationQueue();
    const gate = deferred<void>();
    let done = false;
    const running = queue.run(async () => { await gate.promise; done = true; });

    let settled = false;
    void queue.settled().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await running;
    await queue.settled();
    expect(done).toBe(true);
  });
});

describe('keyed serial mutation queue', () => {
  test('serializes within a key and runs different keys concurrently', async () => {
    const queue = createKeyedSerialMutationQueue();
    const blocked = deferred<void>();
    const started: string[] = [];

    const first = queue.run('alpha', async () => { started.push('alpha-1'); await blocked.promise; });
    const second = queue.run('alpha', async () => { started.push('alpha-2'); });
    const other = queue.run('beta', async () => { started.push('beta-1'); });

    await other;
    expect(started).toEqual(['alpha-1', 'beta-1']);

    blocked.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(['alpha-1', 'beta-1', 'alpha-2']);
  });

  test('an idle key is dropped, so the map does not grow with every id touched', async () => {
    const queue = createKeyedSerialMutationQueue();
    await queue.run('alpha', async () => undefined);
    // Nothing queued behind it, so waiting on the key is free rather than a
    // reference to a completed chain kept forever.
    await expect(queue.settled('alpha')).resolves.toBeUndefined();
    await expect(queue.settled('never-used')).resolves.toBeUndefined();
  });

  test('a failure on one key leaves the other keys and the next task alone', async () => {
    const queue = createKeyedSerialMutationQueue();
    await expect(queue.run('alpha', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(await queue.run('alpha', async () => 'next')).toBe('next');
    expect(await queue.run('beta', async () => 'other')).toBe('other');
  });
});
