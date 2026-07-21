import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { textMatchRank } from './candidateRanking';
import { clampMenuIndex } from './menuNavigation';
import { isNodeInTrash } from './nodeLocation';

export type TagSelectorItem =
  | { type: 'existing'; tag: NodeProjection }
  | { type: 'create'; name: string };

const DEFAULT_TAG_SELECTOR_LIMIT = 24;
const HEX_COLOR_LABEL_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

interface ActiveTagCandidate {
  tag: NodeProjection;
  label: string;
  normalizedLabel: string;
  hexPenalty: number;
}

interface RankedTagCandidate extends ActiveTagCandidate {
  rank: number;
}

interface ActiveTagSelectorIndex {
  tags: readonly ActiveTagCandidate[];
  emptyQueryTags: readonly ActiveTagCandidate[];
  normalizedLabels: ReadonlySet<string>;
}

const activeTagSelectorIndexes = new WeakMap<DocumentIndex, ActiveTagSelectorIndex>();

function tagLabel(tag: NodeProjection): string {
  return tag.content.text.trim();
}

function isHexColorLike(label: string): boolean {
  return HEX_COLOR_LABEL_RE.test(label);
}

function compareTagCandidates(
  left: ActiveTagCandidate,
  right: ActiveTagCandidate,
  normalizedQuery: string,
  leftRank: number,
  rightRank: number,
): number {
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.hexPenalty !== right.hexPenalty) return left.hexPenalty - right.hexPenalty;
  if (normalizedQuery && left.label.length !== right.label.length) return left.label.length - right.label.length;
  if (left.tag.updatedAt !== right.tag.updatedAt) return right.tag.updatedAt - left.tag.updatedAt;
  return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
}

function buildActiveTagSelectorIndex(index: DocumentIndex): ActiveTagSelectorIndex {
  const tags: ActiveTagCandidate[] = [];
  const normalizedLabels = new Set<string>();
  for (const node of index.projection.nodes) {
    if (node.type !== 'tagDef' || isNodeInTrash(index, node.id)) continue;
    const label = tagLabel(node);
    const normalizedLabel = label.toLowerCase();
    tags.push({
      tag: node,
      label,
      normalizedLabel,
      hexPenalty: isHexColorLike(label) ? 1 : 0,
    });
    normalizedLabels.add(normalizedLabel);
  }
  return {
    tags,
    emptyQueryTags: [...tags].sort((left, right) => compareTagCandidates(left, right, '', 0, 0)),
    normalizedLabels,
  };
}

function activeTagSelectorIndex(index: DocumentIndex): ActiveTagSelectorIndex {
  const cached = activeTagSelectorIndexes.get(index);
  if (cached) return cached;
  const next = buildActiveTagSelectorIndex(index);
  activeTagSelectorIndexes.set(index, next);
  return next;
}

export function tagSelectorItemLabel(item: TagSelectorItem): string {
  return item.type === 'existing'
    ? item.tag.content.text
    : `Create ${item.name}`;
}

export function tagSelectorItems(params: {
  query: string;
  index: DocumentIndex;
  existingTagIds: readonly NodeId[];
  limit?: number;
}): TagSelectorItem[] {
  const query = params.query.trim();
  const normalizedQuery = query.toLowerCase();
  const existing = new Set(params.existingTagIds);
  const tagIndex = activeTagSelectorIndex(params.index);
  const limit = params.limit ?? DEFAULT_TAG_SELECTOR_LIMIT;
  if (!query) {
    const matches: TagSelectorItem[] = [];
    for (const item of tagIndex.emptyQueryTags) {
      if (existing.has(item.tag.id)) continue;
      matches.push({ type: 'existing', tag: item.tag });
      if (matches.length >= limit) break;
    }
    return matches;
  }
  const exactTagExists = Boolean(normalizedQuery)
    && tagIndex.normalizedLabels.has(normalizedQuery);
  const ranked: RankedTagCandidate[] = [];
  for (const item of tagIndex.tags) {
    if (existing.has(item.tag.id)) continue;
    const rank = textMatchRank(item.normalizedLabel, normalizedQuery);
    if (rank === null) continue;
    ranked.push({ ...item, rank });
  }
  const matches = ranked
    .sort((left, right) => compareTagCandidates(left, right, normalizedQuery, left.rank, right.rank))
    .slice(0, limit)
    .map((item): TagSelectorItem => ({ type: 'existing', tag: item.tag }));

  return exactTagExists ? matches : [...matches, { type: 'create', name: query }];
}

export function clampTagSelectorIndex(index: number, itemCount: number): number {
  return clampMenuIndex(index, itemCount);
}
