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
  /** Which agent runs the brief (an `AgentDefinition.name`); empty = main agent. */
  commandAgent: string | undefined;
}

// Anacron decision, as a pure function of the document + the clock. A command
// node fires when it carries a schedule, is not trashed, and
// `shouldFireDateSchedule` says an occurrence at/before `now` has not yet been
// covered by `sysLastRunAt`. Catch-up coalesces by construction: a three-day
// gap yields one due occurrence (today's), not three.
type CommandNodeProjection = Extract<NodeProjection, { type: 'command' }>;

// The brief the agent runs: the command node's own text (the title) plus every
// non-field descendant serialized as a nested bullet outline. Field-entry
// children (the Agent / Schedule rows) are config, not prompt, so they're
// skipped; inline references are preserved via reference markup. A command with
// no body children reduces to just its title (backward compatible).
export function commandBriefText(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): string {
  const title = richTextToReferenceMarkup(node.content).trim();
  const body = serializeCommandBody(node, byId, 0);
  return body ? `${title}\n${body}`.trimEnd() : title;
}

function serializeCommandBody(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
  depth: number,
): string {
  const lines: string[] = [];
  for (const childId of node.children) {
    const child = byId.get(childId);
    if (!child || child.type === 'fieldEntry') continue; // config row, not prompt
    const text = richTextToReferenceMarkup(child.content).trim();
    if (text) lines.push(`${'  '.repeat(depth)}- ${text}`);
    const nested = serializeCommandBody(child, byId, depth + 1);
    if (nested) lines.push(nested);
  }
  return lines.join('\n');
}

function isScheduledCommand(node: NodeProjection): node is CommandNodeProjection {
  return node.type === 'command' && !!node.commandSchedule;
}

export function selectDueCommands(projection: DocumentProjection, now: Date): DueCommand[] {
  // Early-out before any O(N) trash walk: the common document has zero command
  // nodes, so don't build the trashed set (or a node Map) until we know at least
  // one command node exists.
  const commandNodes = projection.nodes.filter(isScheduledCommand);
  if (commandNodes.length === 0) return [];

  const byId = new Map<string, NodeProjection>(projection.nodes.map((node) => [node.id, node]));
  const trashed = new Set(collectDescendantIds(byId, projection.trashId));
  const due: DueCommand[] = [];
  for (const node of commandNodes) {
    if (trashed.has(node.id)) continue; // trashed command nodes are paused
    // The brief is the node's title + its non-field child outline, with inline
    // references reconstructed (`[[label||id]]` / file markers) — `content.text`
    // alone drops refs (they live by offset in `content.inlineRefs`).
    const brief = commandBriefText(node, byId);
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
      commandAgent: node.commandAgent,
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
