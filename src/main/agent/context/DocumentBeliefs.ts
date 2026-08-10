/**
 * What this Thread was shown about the document, and whether it is still true.
 *
 * A BELIEF CARRIES THE FUNCTION THAT MADE IT. The first version of this file
 * stored the token `node_read` emits and compared it against `revisionOf`, which
 * is a different function — `editableOutlineRevision` appends an outline hash —
 * so the two could never be equal and every read produced a permanent false
 * drift. The fix is not a better guess at the format: a belief names its own
 * `basis`, and comparison recomputes THAT basis against the current projection.
 * A shape a tool emits can then only ever be compared with itself.
 *
 * THE BASIS IS AS STRONG AS THE OBSERVATION WAS. `node_read` renders a node's
 * editable outline, so its belief is the outline revision — text, structure and
 * children all inside the hash. `node_search` renders a snippet and a timestamp,
 * so its belief is that timestamp. A search result is a weaker claim about what
 * the model knows, and pretending otherwise would either miss drift or invent it.
 *
 * AND THE BASIS IS READ OFF THE TOKEN, NOT ASSUMED FROM THE FIELD IT ARRIVED IN.
 * `node_edit` writes one `revisions` map from fifteen code paths, and only the
 * outline path emits the three-part form — the other thirteen emit `revisionOf`.
 * Labelling the whole map `outline` reproduced the original defect for the
 * majority of edits: the model moved a node and was then told its own edit was
 * someone else's change it must not revert. Both forms share the prefix
 * `${nodeId}:`, and the id is the map key, so stripping the known prefix
 * separates them without depending on the hash's alphabet or on ids never
 * containing a colon.
 *
 * Both bases are recoverable from the persisted tool output, which is what makes
 * the set a projection of the canonical record rather than a cache: the same
 * `beliefsFromToolResult` runs live and on rebuild, over the same bytes.
 */
import type { NodeProjection } from '../../../core/types';
import type { DocumentProjection } from '../../../core/types';
import { indexProjection, isInTrash } from '../capabilities/agentNodeToolProjection';
import { editableOutlineRevision } from '../capabilities/agentNodeToolRead';
import type { ProjectionIndex } from '../capabilities/agentNodeToolTypes';

/** The node tools whose results say something about a node's current state. */
const BELIEF_BEARING_TOOLS = new Set(['node_read', 'node_search', 'node_edit', 'node_create']);

/**
 * Which function produced the token, and therefore which one must reproduce it.
 * `outline` is `editableOutlineRevision`; `updatedAt` is the raw epoch stamp.
 */
export type DocumentBeliefBasis = 'outline' | 'updatedAt';

export interface DocumentBelief {
  readonly nodeId: string;
  readonly basis: DocumentBeliefBasis;
  readonly token: string;
  /** Whether the node was already in the trash when the model was shown it. */
  readonly trashed: boolean;
  /**
   * When the model was shown it. Attribution needs this: an edit that predates
   * the observation explains nothing about drift the model can see.
   */
  readonly observedAt: number;
}

export type DocumentDriftKind = 'changed' | 'gone';

export interface DocumentDriftedNode {
  readonly nodeId: string;
  readonly kind: DocumentDriftKind;
  /** The node as it is NOW, or null when the projection no longer has it at all. */
  readonly node: NodeProjection | null;
  /** When the belief that just failed was formed. */
  readonly observedAt: number;
}

/**
 * Every belief a node tool's result expresses.
 *
 * `trashed` is resolved against the projection as it was when the result was
 * produced, because "the node you read has since been deleted" is a claim about
 * a transition, not about a state.
 *
 * Unknown shapes yield nothing rather than throwing: this runs behind a live
 * tool call and behind a rebuild, and neither may fail over a payload it does
 * not recognise.
 */
export function beliefsFromToolResult(
  tool: string,
  result: unknown,
  index: ProjectionIndex | null,
  observedAt: number,
): readonly DocumentBelief[] {
  if (!BELIEF_BEARING_TOOLS.has(tool)) return [];
  const data = (result as { data?: unknown } | null)?.data;
  if (!isRecord(data)) return [];
  const beliefs: DocumentBelief[] = [];
  const add = (nodeId: string, basis: DocumentBeliefBasis, token: string) => {
    beliefs.push({ nodeId, basis, token, trashed: index ? isInTrash(index, nodeId) : false, observedAt });
  };
  for (const item of arrayOf(data.items)) {
    if (!isRecord(item)) continue;
    const nodeId = stringOf(item.nodeId);
    if (!nodeId) continue;
    const revision = stringOf(item.revision);
    if (revision) {
      const classified = classifyRevision(nodeId, revision);
      if (classified) add(nodeId, classified.basis, classified.token);
      continue;
    }
    // node_search states an ISO timestamp; normalise to the epoch the projection
    // carries, so the stored token is already in the form its basis compares.
    const updatedAt = epochOf(item.updatedAt);
    if (updatedAt !== undefined) add(nodeId, 'updatedAt', updatedAt);
  }
  // node_edit / node_create: what the mutation left behind, in whichever of the
  // two revision forms the path that produced it emits.
  if (isRecord(data.revisions)) {
    for (const [nodeId, token] of Object.entries(data.revisions)) {
      if (typeof token !== 'string' || !token) continue;
      const classified = classifyRevision(nodeId, token);
      if (classified) add(nodeId, classified.basis, classified.token);
    }
  }
  return beliefs;
}

/**
 * The beliefs that no longer hold, against the document as it is now.
 *
 * Trashing is what "deleted" means here. A trashed node stays in the projection
 * — the trash is a subtree, not a removal — and trashing does not stamp
 * `updatedAt`, so neither absence nor a revision bump would ever notice it. The
 * transition into the trash is checked explicitly, and reported as `gone`
 * because that is what it is to the model that read it.
 */
export function driftedNodes(
  beliefs: Iterable<DocumentBelief>,
  projection: DocumentProjection,
): readonly DocumentDriftedNode[] {
  const index = indexProjection(projection);
  const drifted: DocumentDriftedNode[] = [];
  for (const belief of beliefs) {
    const node = index.nodes.get(belief.nodeId);
    const observedAt = belief.observedAt;
    if (!node) {
      drifted.push({ nodeId: belief.nodeId, kind: 'gone', node: null, observedAt });
      continue;
    }
    if (!belief.trashed && isInTrash(index, belief.nodeId)) {
      drifted.push({ nodeId: belief.nodeId, kind: 'gone', node, observedAt });
      continue;
    }
    if (currentToken(index, node, belief.basis) !== belief.token) {
      drifted.push({ nodeId: belief.nodeId, kind: 'changed', node, observedAt });
    }
  }
  return drifted;
}

/** The belief a node would produce right now, on the same basis it was made. */
export function currentBelief(
  index: ProjectionIndex,
  nodeId: string,
  basis: DocumentBeliefBasis,
  observedAt: number,
): DocumentBelief | null {
  const node = index.nodes.get(nodeId);
  if (!node) return null;
  return {
    nodeId,
    basis,
    token: currentToken(index, node, basis),
    trashed: isInTrash(index, nodeId),
    observedAt,
  };
}

function currentToken(index: ProjectionIndex, node: NodeProjection, basis: DocumentBeliefBasis): string {
  if (basis === 'updatedAt') return String(node.updatedAt);
  try {
    return editableOutlineRevision(index, node.id);
  } catch {
    // A node the serializer cannot render is a node we cannot claim anything
    // about; an impossible token keeps it out of the "unchanged" bucket without
    // asserting what changed.
    return '';
  }
}

/**
 * One Thread's beliefs, newest observation last.
 *
 * Re-observing a node replaces its belief rather than adding one: the model's
 * belief about a node is whatever it was shown most recently, and keeping the
 * older one would report drift the model has already been told about.
 */
export class DocumentBeliefSet {
  private readonly beliefsById = new Map<string, DocumentBelief>();

  get size(): number {
    return this.beliefsById.size;
  }

  record(beliefs: Iterable<DocumentBelief>): void {
    for (const belief of beliefs) {
      // Delete first so re-observation moves the node to the end: the order is
      // the recency the notice's cap spends its slots on.
      this.beliefsById.delete(belief.nodeId);
      this.beliefsById.set(belief.nodeId, belief);
    }
  }

  forget(nodeIds: Iterable<string>): void {
    for (const nodeId of nodeIds) this.beliefsById.delete(nodeId);
  }

  beliefs(): readonly DocumentBelief[] {
    return [...this.beliefsById.values()];
  }
}

/**
 * Which function emitted this revision token, decided by its own structure.
 *
 * `revisionOf` is `${id}:${updatedAt}`; `editableOutlineRevision` appends
 * `:${hash}` to it. The id is known — it is the key the token arrived under — so
 * stripping `${nodeId}:` leaves either a bare stamp or a stamp and a hash, and
 * nothing here depends on what the hash looks like. A token that does not carry
 * the expected prefix is a shape this does not know, and expresses no belief
 * rather than a guessed one.
 */
function classifyRevision(
  nodeId: string,
  token: string,
): { readonly basis: DocumentBeliefBasis; readonly token: string } | null {
  const prefix = `${nodeId}:`;
  if (!token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  if (!rest) return null;
  // A third segment means the outline hash is present, so the outline is what
  // was rendered and what must be recomputed.
  return rest.includes(':')
    ? { basis: 'outline', token }
    : { basis: 'updatedAt', token: rest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function epochOf(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : String(parsed);
}
