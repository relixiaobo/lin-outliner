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
