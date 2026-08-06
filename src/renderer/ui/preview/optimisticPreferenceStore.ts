import { createSerialMutationQueue } from '../../../core/serialMutationQueue';

/**
 * A window-shared preference that moves the moment the user asks and is put back
 * if main refuses it.
 *
 * The two translation preference stores each grew their own copy of this —
 * per-field pending versions, a serialized write tail, bridge-echo merging, a
 * test reset — and the copies had drifted, so any fix to the rollback or the echo
 * had to be made twice and reasoned about twice. The contract, in one place:
 *
 * - The control moves optimistically; the returned promise is the write, so the
 *   caller can surface a failure.
 * - Writes are serialized, and each one sends the last value main confirmed with
 *   only its own field changed — so a queued write never smuggles another field's
 *   in-flight, possibly-doomed value onto disk.
 * - A rejected write restores the last confirmed value for that field, and leaves
 *   every other field's newer intent alone.
 * - A write superseded before it lands does not undo its successor: reconciliation
 *   is by pending version, per field.
 * - Main's own broadcast is merged UNDER anything still pending, so an echo of the
 *   value before this window's write cannot make a control jump backwards.
 */
export interface OptimisticPreferenceStoreOptions<T extends object> {
  /** Value before the bridge has supplied one, and in any non-window context. */
  fallback: T;
  /** What main seeded this window with. Read once, lazily. */
  initial: () => T;
  /** Main's broadcast of the canonical value; returns its unsubscribe. */
  observe: (onChange: (value: T) => void) => (() => void) | undefined;
  /** Write through to main. Resolves with what main actually stored. */
  write: (value: T) => Promise<T>;
}

export interface OptimisticPreferenceStore<T extends object> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  set: <K extends keyof T>(key: K, value: T[K]) => Promise<void>;
  /**
   * Drop the module-level cache. The seeded value is read once and kept, so a test
   * that renders under one bridge would otherwise leave it set for whatever
   * renders next.
   */
  resetForTests: () => void;
}

export function createOptimisticPreferenceStore<T extends object>(
  options: OptimisticPreferenceStoreOptions<T>,
): OptimisticPreferenceStore<T> {
  const listeners = new Set<() => void>();
  const pending = new Map<keyof T, { version: number; value: unknown }>();
  let current: T | null = null;
  let persisted: T | null = null;
  let unobserve: (() => void) | null = null;
  let nextVersion = 0;
  let writes = createSerialMutationQueue();

  function ensureLoaded(): T {
    if (current) return current;
    current = typeof window === 'undefined' ? options.fallback : options.initial();
    persisted = current;
    return current;
  }

  function setCurrent(next: T): void {
    if (shallowEqual(ensureLoaded(), next)) return;
    current = next;
    for (const listener of listeners) listener();
  }

  function withPending(base: T): T {
    if (pending.size === 0) return base;
    const next = { ...base };
    for (const [key, slot] of pending) (next as Record<keyof T, unknown>)[key] = slot.value;
    return next;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (!unobserve && typeof window !== 'undefined') {
      unobserve = options.observe((value) => {
        persisted = value;
        setCurrent(withPending(value));
      }) ?? null;
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && unobserve) {
        unobserve();
        unobserve = null;
      }
    };
  }

  function set<K extends keyof T>(key: K, value: T[K]): Promise<void> {
    ensureLoaded();
    const version = ++nextVersion;
    pending.set(key, { version, value });
    setCurrent({ ...ensureLoaded(), [key]: value } as T);

    return writes.run(async () => {
      const payload = { ...(persisted ?? ensureLoaded()), [key]: value } as T;
      try {
        const canonical = typeof window === 'undefined' ? payload : await options.write(payload);
        persisted = canonical;
        clearPending(key, version);
        setCurrent(withPending(canonical));
      } catch (error) {
        clearPending(key, version);
        setCurrent(withPending(persisted ?? options.fallback));
        throw error;
      }
    });
  }

  // Only this write's own intent. A newer one for the same field has already
  // replaced the slot, and reconciling to this stale value would undo it.
  function clearPending(key: keyof T, version: number): void {
    if (pending.get(key)?.version === version) pending.delete(key);
  }

  return {
    subscribe,
    getSnapshot: ensureLoaded,
    getServerSnapshot: () => options.fallback,
    set,
    resetForTests(): void {
      current = null;
      persisted = null;
      unobserve?.();
      unobserve = null;
      listeners.clear();
      pending.clear();
      nextVersion = 0;
      writes = createSerialMutationQueue();
    },
  };
}

function shallowEqual<T extends object>(left: T, right: T): boolean {
  if (left === right) return true;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => (
    (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key]
  ));
}
