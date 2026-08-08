// Typed candidate policies for the registry's object-valued parameters.
//
// D5: what converges is the matching KERNEL, not the candidate policy. Each
// parameter keeps its domain rules — `Move to` excludes the moving rows, field
// entries, their descendants and Trash and has its own empty-query ordering;
// `Add tag` admits tag definitions only, excludes already-applied tags and
// penalises hex-looking labels. Both live here so the anchored menu and the
// searchable surface answer from one implementation.

import { rankTextSearchLabel } from '../textSearchAnalyzer';
import { nodeIsInSubtree } from '../treeUtils';
import type { NodeId, NodeProjection } from '../types';
import { isDescendantOf } from './rowFacets';

// ---------------------------------------------------------------------------
// Move-to destinations
// ---------------------------------------------------------------------------

export interface MoveToAdmissionParams {
  candidateId: NodeId;
  moving: readonly NodeId[];
  byId: ReadonlyMap<NodeId, NodeProjection>;
  trashId: NodeId;
}

/**
 * Admission runs BEFORE the limit, never after: filtering a limited generic
 * result would let invalid descendants consume the limit and hide a valid
 * ranked destination — the exact defect this fixes.
 */
export function admitsMoveToDestination(params: MoveToAdmissionParams): boolean {
  const { candidateId, moving, byId, trashId } = params;
  if (candidateId === trashId) return false;
  if (moving.includes(candidateId)) return false;
  const node = byId.get(candidateId);
  if (!node || node.type === 'fieldEntry') return false;
  return moving.every((nodeId) => !isDescendantOf(byId, candidateId, nodeId));
}

/**
 * Empty query has its own ordering rather than "no results": document order,
 * the shipped picker's behaviour, admitted first and then limited.
 */
export function moveToEmptyQueryOrder(params: {
  nodes: readonly NodeProjection[];
  moving: readonly NodeId[];
  byId: ReadonlyMap<NodeId, NodeProjection>;
  trashId: NodeId;
  limit: number;
}): NodeId[] {
  const result: NodeId[] = [];
  for (const node of params.nodes) {
    if (!admitsMoveToDestination({
      candidateId: node.id,
      moving: params.moving,
      byId: params.byId,
      trashId: params.trashId,
    })) continue;
    result.push(node.id);
    if (result.length >= params.limit) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tag candidates
// ---------------------------------------------------------------------------

export type TagCandidate =
  | { type: 'existing'; tag: NodeProjection }
  | { type: 'create'; name: string };

const DEFAULT_TAG_LIMIT = 24;
const HEX_COLOR_LABEL_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

interface TagCandidateEntry {
  tag: NodeProjection;
  label: string;
  normalizedLabel: string;
  hexPenalty: number;
}

export interface TagCandidateIndex {
  tags: readonly TagCandidateEntry[];
  emptyQueryTags: readonly TagCandidateEntry[];
  normalizedLabels: ReadonlySet<string>;
}

function tagLabel(tag: NodeProjection): string {
  return tag.content.text.trim();
}

function isHexColorLike(label: string): boolean {
  return HEX_COLOR_LABEL_RE.test(label);
}

function compareTagCandidates(
  left: TagCandidateEntry,
  right: TagCandidateEntry,
  normalizedQuery: string,
  leftRank: number,
  rightRank: number,
): number {
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.hexPenalty !== right.hexPenalty) return left.hexPenalty - right.hexPenalty;
  if (normalizedQuery && left.label.length !== right.label.length) {
    return left.label.length - right.label.length;
  }
  if (left.tag.updatedAt !== right.tag.updatedAt) return right.tag.updatedAt - left.tag.updatedAt;
  return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
}

export function buildTagCandidateIndex(params: {
  nodes: readonly NodeProjection[];
  byId: ReadonlyMap<NodeId, NodeProjection>;
  trashId: NodeId;
}): TagCandidateIndex {
  const tags: TagCandidateEntry[] = [];
  const normalizedLabels = new Set<string>();
  for (const node of params.nodes) {
    if (node.type !== 'tagDef' || nodeIsInSubtree(params.byId, node.id, params.trashId)) continue;
    const label = tagLabel(node);
    const normalizedLabel = label.toLowerCase();
    tags.push({ tag: node, label, normalizedLabel, hexPenalty: isHexColorLike(label) ? 1 : 0 });
    normalizedLabels.add(normalizedLabel);
  }
  return {
    tags,
    emptyQueryTags: [...tags].sort((left, right) => compareTagCandidates(left, right, '', 0, 0)),
    normalizedLabels,
  };
}

export function rankTagCandidates(params: {
  index: TagCandidateIndex;
  query: string;
  existingTagIds: readonly NodeId[];
  limit?: number;
}): TagCandidate[] {
  const query = params.query.trim();
  const normalizedQuery = query.toLowerCase();
  const existing = new Set(params.existingTagIds);
  const limit = params.limit ?? DEFAULT_TAG_LIMIT;
  if (!query) {
    const matches: TagCandidate[] = [];
    for (const item of params.index.emptyQueryTags) {
      if (existing.has(item.tag.id)) continue;
      matches.push({ type: 'existing', tag: item.tag });
      if (matches.length >= limit) break;
    }
    return matches;
  }
  const exactTagExists = params.index.normalizedLabels.has(normalizedQuery);
  const ranked: (TagCandidateEntry & { rank: number })[] = [];
  for (const item of params.index.tags) {
    if (existing.has(item.tag.id)) continue;
    const rank = rankTextSearchLabel(item.normalizedLabel, normalizedQuery)?.rank ?? null;
    if (rank === null) continue;
    ranked.push({ ...item, rank });
  }
  const matches = ranked
    .sort((left, right) => compareTagCandidates(left, right, normalizedQuery, left.rank, right.rank))
    .slice(0, limit)
    .map((item): TagCandidate => ({ type: 'existing', tag: item.tag }));

  // The tag DRAFT is a noun row whose selection lets `addTag` resolve
  // create-then-apply; it never becomes a top-level `createTag` action.
  return exactTagExists ? matches : [...matches, { type: 'create', name: query }];
}
