/**
 * Run tasks one at a time, in the order they were asked for.
 *
 * The shape it replaces was hand-written six times across main and the renderer:
 * chain onto a tail, swallow errors in the tail so one failure cannot stall the
 * queue, hand the caller the un-swallowed promise. Each copy re-decided the same
 * subtleties — whether the tail or the caller sees a rejection, whether a failed
 * step still lets the next one run, when a per-key entry is dropped — and they did
 * not all decide alike.
 *
 * What every caller needs and gets here:
 *
 * - Order is the order of the `run` call, not of whatever it awaits inside.
 * - A task that throws does not stall the queue: the next one still runs.
 * - The caller's promise rejects; the queue's own tail never does.
 */
export interface SerialMutationQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Resolves when everything queued so far has settled. */
  settled(): Promise<void>;
}

export function createSerialMutationQueue(): SerialMutationQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      // `then(task, task)` rather than `then(task)`: the tail is already
      // error-swallowed, so this only states that a predecessor's outcome never
      // decides whether this task runs.
      const started = tail.then(task, task);
      tail = started.then(() => undefined, () => undefined);
      return started;
    },
    settled(): Promise<void> {
      return tail;
    },
  };
}

/**
 * One independent serial queue per key — concurrent across keys, serial within
 * one. Idle keys are dropped, so a map of them does not grow with every id the
 * session has ever touched.
 */
export interface KeyedSerialMutationQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Resolves when everything queued so far for `key` has settled. */
  settled(key: string): Promise<void>;
}

export function createKeyedSerialMutationQueue(): KeyedSerialMutationQueue {
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prior = tails.get(key) ?? Promise.resolve();
      const started = prior.then(task, task);
      const tail = started.then(() => undefined, () => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        // Only if nothing was queued behind this one; otherwise the newer tail owns
        // the key.
        if (tails.get(key) === tail) tails.delete(key);
      });
      return started;
    },
    settled(key: string): Promise<void> {
      return tails.get(key) ?? Promise.resolve();
    },
  };
}
