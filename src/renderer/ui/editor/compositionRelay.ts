/**
 * Cross-editor IME composition coordination (issue #176).
 *
 * Each editor's `composingRef` is private to its component instance, but the
 * editor that must NOT steal focus mid-composition is a *different* instance —
 * the target of an async echo's focusRequest. This module is the shared signal:
 * editors register their live composition here, and every focusRequest applier
 * checks `isCompositionLive()` before moving focus/selection. A parked request
 * stays in ui state; the composing editor relays it (with any composed text)
 * at compositionend.
 */

const liveCompositions = new Set<symbol>();

/**
 * Dev-only diagnostic trail for the #176 family — every composition/focus
 * decision logs through here so a live repro can be read back over CDP
 * (`console.debug` with the `[ime-trace]` prefix). No-op in prod runs.
 * `IME_TRACE_ENABLED` gates trace blocks whose argument construction is
 * itself costly (DOM serialization), not just the log sink.
 */
export const IME_TRACE_ENABLED: boolean = Boolean(import.meta.env?.DEV);

export function imeTrace(...args: unknown[]): void {
  if (IME_TRACE_ENABLED) console.debug('[ime-trace]', performance.now().toFixed(0), ...args);
}

export function beginComposition(token: symbol): void {
  liveCompositions.add(token);
}

export function endComposition(token: symbol): void {
  liveCompositions.delete(token);
}

export function isCompositionLive(): boolean {
  return liveCompositions.size > 0;
}

/** Test-only: clear stray registrations between cases. */
export function resetCompositionRelayForTests(): void {
  liveCompositions.clear();
}

/**
 * The text a composition inserted, recovered by prefix/suffix diff between the
 * last flushed/synced content and the post-composition doc. Composition is a
 * single contiguous edit, so the unshared middle of `next` IS the insertion —
 * independent of net length (a composition that replaced a wider selection
 * still yields the composed text, not '').
 */
export function extractComposedInsertion(previous: string, next: string): string {
  let prefix = 0;
  const maxShared = Math.min(previous.length, next.length);
  while (prefix < maxShared && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = maxShared - prefix;
  while (
    suffix < maxSuffix
    && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;
  return next.slice(prefix, next.length - suffix);
}
