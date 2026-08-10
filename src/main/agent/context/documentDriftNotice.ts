/**
 * The notice itself: a belief update, not a warning.
 *
 * It carries the CURRENT content of the first few drifted nodes rather than only
 * naming them, so the ordinary case costs the model no re-read round trip.
 * Outliner nodes are small, which is what makes that affordable here where
 * injecting a whole file diff would not be.
 *
 * The "do not revert" line is load-bearing, not politeness. A model told that
 * something it read has changed can read that as an inconsistency to repair, and
 * overwrite the edit the user just made — a failure this feature would otherwise
 * have created. The coding agents say the same thing in the same situation.
 */
import type { NodeProjection } from '../../../core/types';
import { nodeTitle } from './userView';
import { nodeContentText } from '../capabilities/agentNodeToolProjection';
import type { DocumentDriftedNode } from './DocumentBeliefs';

/** How many drifted nodes carry their current content. The rest become a count. */
export const DRIFT_NOTICE_NODE_LIMIT = 5;
/** A node's content is user- or model-authored text entering trusted context. */
const CONTENT_MAX_CHARS = 400;
/** How far back attribution looks in the journal. Its miss costs one clause. */
export const DRIFT_ATTRIBUTION_SCAN = 100;
/** The notice is four lines; a session list is not allowed to make it forty. */
const MAX_ATTRIBUTED_SESSIONS = 3;

/**
 * Who touched these nodes SINCE the model was shown them.
 *
 * Scoping by node alone is not enough, which the review caught: the journal
 * remembers operations from before the observation too, so an edit the user made
 * at 10:00 would be credited for drift the model only saw at 10:05 — telling it
 * the user personally changed something they changed before it ever looked. The
 * node scope says WHICH operations are relevant; `observedAt` says which of them
 * happened after the belief was formed. Both are needed, and neither is the
 * comparison itself — attribution stays garnish, so an edit older than the
 * journal's ring is simply not found and the clause is omitted.
 */
export function driftAttribution(
  drifted: readonly { readonly nodeId: string; readonly observedAt: number }[],
  entries: readonly {
    readonly origin: string;
    readonly createdAt?: string;
    readonly affectedNodeIds?: readonly string[];
    readonly causation?: { readonly threadId: string };
  }[],
  selfThreadId: string,
): DocumentDriftAttribution | null {
  const observedAtByNode = new Map(drifted.map((entry) => [entry.nodeId, entry.observedAt]));
  let userEdits = 0;
  const otherSessions = new Set<string>();
  for (const entry of entries) {
    const at = entry.createdAt === undefined ? Number.NaN : Date.parse(entry.createdAt);
    // An operation with no usable timestamp cannot be placed relative to the
    // observation, and a guess here is exactly the misattribution to avoid.
    if (Number.isNaN(at)) continue;
    const touchedAfterObservation = entry.affectedNodeIds
      ?.some((nodeId) => { const observedAt = observedAtByNode.get(nodeId); return observedAt !== undefined && at > observedAt; });
    if (!touchedAfterObservation) continue;
    if (entry.origin === 'user') {
      userEdits += 1;
      continue;
    }
    const threadId = entry.causation?.threadId;
    // A Thread's own edit is not drift it needs telling about; its belief was
    // updated when the edit returned.
    if (threadId && threadId !== selfThreadId) otherSessions.add(threadId);
  }
  if (userEdits === 0 && otherSessions.size === 0) return null;
  return {
    userEdits,
    // Bounded: an unlucky Thread could otherwise paste a hundred uuids into the
    // notice it is trying to keep to four lines.
    otherSessionThreadIds: [...otherSessions].slice(0, MAX_ATTRIBUTED_SESSIONS),
  };
}

export interface DocumentDriftAttribution {
  /** Edits made by the user directly in the UI. */
  readonly userEdits: number;
  /** Edits made through another session, by the Thread ids that made them. */
  readonly otherSessionThreadIds: readonly string[];
}

/**
 * Null when there is nothing to say. The caller injects only what this returns,
 * so "no drift, no notice" needs no separate check.
 */
export function documentDriftNotice(
  reported: readonly DocumentDriftedNode[],
  total: number,
  attribution: DocumentDriftAttribution | null,
): string | null {
  if (reported.length === 0) return null;
  const lines = [`${headline(total)}${attributionClause(attribution)}`];
  for (const entry of reported) {
    lines.push(entry.kind === 'gone' || !entry.node
      // The highest-signal outcome, and the one a re-read cannot recover alone.
      ? `- ${entry.nodeId} has been deleted.`
      : `- "${boundedLine(nodeTitle(entry.node))}" (${entry.nodeId}) is now: ${boundedLine(content(entry.node))}`);
  }
  lines.push(
    'These edits were made deliberately by someone else. Do not revert them unless asked.',
  );
  const withheld = total - reported.length;
  if (withheld > 0) {
    lines.push(
      `${withheld} more node${withheld === 1 ? '' : 's'} you were shown ${withheld === 1 ? 'has' : 'have'} also changed; re-read before relying on remembered content.`,
    );
  }
  return lines.join('\n');
}

function headline(total: number): string {
  return total === 1
    ? '1 node you were shown has changed since you saw it:'
    : `${total} nodes you were shown have changed since you saw them:`;
}

/**
 * One clause, and only the distinction that is both load-bearing and free: the
 * user's own edit versus another session's. An Automation is another session —
 * what would matter about one is that nobody watched the result, and the record
 * does not know that. The Thread id is what makes the rest resolvable, through
 * the transcript index.
 */
function attributionClause(attribution: DocumentDriftAttribution | null): string {
  if (!attribution) return '';
  const parts: string[] = [];
  if (attribution.userEdits > 0) {
    parts.push(`${attribution.userEdits} edit${attribution.userEdits === 1 ? '' : 's'} by the user directly`);
  }
  if (attribution.otherSessionThreadIds.length > 0) {
    parts.push(`another session (${attribution.otherSessionThreadIds.join(', ')})`);
  }
  return parts.length === 0 ? '' : ` (${parts.join('; ')})`;
}

function content(node: NodeProjection): string {
  const text = nodeContentText(node).trim();
  return text || '(empty)';
}

/**
 * One line, bounded. The same rule the transcript header, the index rows and the
 * Automation previews already follow: authored text entering trusted context
 * must not be able to open a line that looks like one of ours.
 */
function boundedLine(value: string): string {
  const collapsed = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return collapsed.length > CONTENT_MAX_CHARS ? `${collapsed.slice(0, CONTENT_MAX_CHARS)}…` : collapsed;
}
