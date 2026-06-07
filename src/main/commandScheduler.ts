import { shouldFireDateSchedule } from '../core/dateSchedule';
import type { DocumentProjection } from '../core/types';

// One command node that is due to fire on this tick. Pure data derived from the
// projection + `now`; the runtime turns each into a triggered agent run.
export interface DueCommand {
  nodeId: string;
  /** The natural-language brief — the command node's text content. */
  brief: string;
  /** Canonical `<endpoint> RRULE:...` schedule string. */
  schedule: string;
  /** The most-recent occurrence at/before `now` that this fire covers (ms epoch). */
  dueAt: number;
  /** The fire watermark before this fire (ms epoch), or null if never fired. */
  lastSuccessAt: number | null;
}

// Anacron decision, as a pure function of the document + the clock. A command
// node fires when it carries a schedule, is not trashed, and
// `shouldFireDateSchedule` says an occurrence at/before `now` has not yet been
// covered by `sysLastRunAt`. Catch-up coalesces by construction: a three-day
// gap yields one due occurrence (today's), not three.
export function selectDueCommands(projection: DocumentProjection, now: Date): DueCommand[] {
  const trashed = trashedNodeIds(projection);
  const due: DueCommand[] = [];
  for (const node of projection.nodes) {
    if (node.type !== 'command') continue;
    if (trashed.has(node.id)) continue; // trashed command nodes are paused
    const schedule = node.commandSchedule;
    if (!schedule) continue; // empty schedule = manual-only (Run now still works)
    const lastSuccessAt = node.sysLastRunAt ?? null;
    const decision = shouldFireDateSchedule(schedule, now, lastSuccessAt);
    if (!decision.shouldFire || !decision.dueAt) continue;
    due.push({
      nodeId: node.id,
      brief: node.content.text,
      schedule,
      dueAt: decision.dueAt.getTime(),
      lastSuccessAt,
    });
  }
  return due;
}

// Ids of every node under the Trash subtree (so a trashed command pauses without
// scanning content). Walks `children` from the projection's trash root.
function trashedNodeIds(projection: DocumentProjection): Set<string> {
  const byId = new Map(projection.nodes.map((node) => [node.id, node]));
  const trashed = new Set<string>();
  const stack = [...(byId.get(projection.trashId)?.children ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (trashed.has(id)) continue;
    trashed.add(id);
    const node = byId.get(id);
    if (node) stack.push(...node.children);
  }
  return trashed;
}
