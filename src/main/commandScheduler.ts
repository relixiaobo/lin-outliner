import { shouldFireDateSchedule } from '../core/dateSchedule';
import { richTextToReferenceMarkup } from '../core/referenceMarkup';
import { collectDescendantIds } from '../core/treeUtils';
import type { DocumentProjection, NodeProjection } from '../core/types';

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
type CommandNodeProjection = Extract<NodeProjection, { type: 'command' }>;

function isScheduledCommand(node: NodeProjection): node is CommandNodeProjection {
  return node.type === 'command' && !!node.commandSchedule;
}

export function selectDueCommands(projection: DocumentProjection, now: Date): DueCommand[] {
  // Early-out before any O(N) trash walk: the common document has zero command
  // nodes, so don't build the trashed set (or a node Map) until we know at least
  // one command node exists.
  const commandNodes = projection.nodes.filter(isScheduledCommand);
  if (commandNodes.length === 0) return [];

  const trashed = trashedNodeIds(projection);
  const due: DueCommand[] = [];
  for (const node of commandNodes) {
    if (trashed.has(node.id)) continue; // trashed command nodes are paused
    // Reconstruct inline references (`[[label||id]]` / file markers) the same
    // way every other agent-facing node text does — `content.text` alone drops
    // them (they live by offset in `content.inlineRefs`).
    const brief = richTextToReferenceMarkup(node.content);
    if (!brief.trim()) continue; // empty brief = nothing to run; never fire / advance the watermark
    const schedule = node.commandSchedule!;
    const lastSuccessAt = node.sysLastRunAt ?? null;
    const decision = shouldFireDateSchedule(schedule, now, lastSuccessAt);
    if (!decision.shouldFire || !decision.dueAt) continue;
    due.push({
      nodeId: node.id,
      brief,
      schedule,
      dueAt: decision.dueAt.getTime(),
      lastSuccessAt,
    });
  }
  return due;
}

// Ids of every command node currently present in the document (scheduled or
// not), so the runtime can prune in-memory backoff state for nodes that were
// deleted, trashed, or had their schedule cleared.
export function liveCommandNodeIds(projection: DocumentProjection): Set<string> {
  const ids = new Set<string>();
  for (const node of projection.nodes) {
    if (node.type === 'command') ids.add(node.id);
  }
  return ids;
}

// Ids of every node under the Trash subtree (so a trashed command pauses without
// scanning content). Reuses the canonical subtree walk so it can never diverge
// from the rest of the tree tooling.
function trashedNodeIds(projection: DocumentProjection): Set<string> {
  const byId = new Map<string, NodeProjection>(projection.nodes.map((node) => [node.id, node]));
  return new Set(collectDescendantIds(byId, projection.trashId));
}
