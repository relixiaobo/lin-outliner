export type DoneStateTransition = 'toggle' | 'cycle';

export function nextCompletedAt(params: {
  completedAt: number | undefined;
  tagDriven: boolean;
  transition: DoneStateTransition;
  now?: number;
}): number | undefined {
  const done = typeof params.completedAt === 'number' && params.completedAt > 0;
  const now = params.now ?? Date.now();
  if (params.transition === 'toggle') {
    if (!done) return now;
    return params.tagDriven ? undefined : 0;
  }
  if (params.tagDriven) return done ? undefined : now;
  if (params.completedAt === undefined) return 0;
  if (params.completedAt === 0) return now;
  return undefined;
}

export function applyCompletedAtTransition<T extends { completedAt?: number }>(
  node: T,
  params: {
    tagDriven: boolean;
    transition: DoneStateTransition;
    now?: number;
  },
): void {
  const completedAt = nextCompletedAt({ completedAt: node.completedAt, ...params });
  if (completedAt === undefined) delete node.completedAt;
  else node.completedAt = completedAt;
}
