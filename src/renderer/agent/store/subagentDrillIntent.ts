import type { ThreadId } from '../../../core/agent/protocol';

interface ThreadLineageRecord {
  readonly parentThreadId: ThreadId | null;
}

/**
 * "Open this child, which lives deeper in the delegated subtree."
 *
 * Thread Details lists a conversation's whole descendant subtree, but a child is
 * read from the delegation row that spawned it, while deeper descendant rows
 * live inside their parent's run detail. Expanding the row that
 * exists would open the right container on the wrong subject.
 *
 * So the request carries the path: the row to expand, and where to drill once it
 * is open. It is consumed on arrival rather than kept, because it describes one
 * navigation and not a state — reopening the same row later must show that row's
 * own child, not the target of a request the reader already followed.
 */
const intents = new Map<ThreadId, readonly ThreadId[]>();
const listeners = new Set<() => void>();

/**
 * Consumers subscribe because a row may ALREADY be expanded when the request
 * arrives: relying on the container's first render would drop that request and
 * leave the stale path behind to hijack the next expand of the same row.
 */
export function subscribeSubagentDrill(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `path` starts at the row being expanded and ends at the child to show. */
export function requestSubagentDrill(rowThreadId: ThreadId, path: readonly ThreadId[]): void {
  intents.set(rowThreadId, path);
  for (const listener of listeners) listener();
}

export function consumeSubagentDrill(rowThreadId: ThreadId): readonly ThreadId[] | null {
  const path = intents.get(rowThreadId);
  if (!path) return null;
  intents.delete(rowThreadId);
  return path;
}

/** The descendants between `ancestorThreadId` and `targetThreadId`, in display order. */
export function descendantDrillPath(
  ancestorThreadId: ThreadId,
  targetThreadId: ThreadId,
  threadsById: ReadonlyMap<ThreadId, ThreadLineageRecord>,
): readonly ThreadId[] | null {
  if (ancestorThreadId === targetThreadId) return [];
  const path: ThreadId[] = [];
  const visited = new Set<ThreadId>();
  let current: ThreadId | null = targetThreadId;
  while (current !== ancestorThreadId) {
    if (current === null || visited.has(current)) return null;
    visited.add(current);
    const thread = threadsById.get(current);
    if (!thread) return null;
    path.unshift(current);
    current = thread.parentThreadId;
  }
  return path;
}

/** Test seam: intents outlive a render, so a suite must be able to clear them. */
export function resetSubagentDrillIntents(): void {
  intents.clear();
  listeners.clear();
}
