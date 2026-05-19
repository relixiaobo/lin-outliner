import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { textMatchRank } from './candidateRanking';
import { clampMenuIndex } from './menuNavigation';

export type TagSelectorItem =
  | { type: 'existing'; tag: NodeProjection }
  | { type: 'create'; name: string };

const DEFAULT_TAG_SELECTOR_LIMIT = 24;
const HEX_COLOR_LABEL_RE = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function tagLabel(tag: NodeProjection): string {
  return tag.content.text.trim();
}

function normalizedTagLabel(tag: NodeProjection): string {
  return tagLabel(tag).toLowerCase();
}

function isHexColorLike(label: string): boolean {
  return HEX_COLOR_LABEL_RE.test(label);
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
  const tags = params.index.projection.nodes.filter((node) => node.type === 'tagDef');
  const exactTagExists = Boolean(normalizedQuery)
    && tags.some((tag) => normalizedTagLabel(tag) === normalizedQuery);
  const matches = tags
    .filter((tag) => !existing.has(tag.id))
    .map((tag) => ({
      tag,
      label: tagLabel(tag),
      normalizedLabel: normalizedTagLabel(tag),
    }))
    .map((item) => ({
      ...item,
      rank: textMatchRank(item.normalizedLabel, normalizedQuery),
      hexPenalty: isHexColorLike(item.label) ? 1 : 0,
    }))
    .filter((item) => item.rank !== null)
    .sort((left, right) => {
      if (left.rank !== right.rank) return (left.rank ?? 0) - (right.rank ?? 0);
      if (left.hexPenalty !== right.hexPenalty) return left.hexPenalty - right.hexPenalty;
      if (normalizedQuery && left.label.length !== right.label.length) return left.label.length - right.label.length;
      if (left.tag.updatedAt !== right.tag.updatedAt) return right.tag.updatedAt - left.tag.updatedAt;
      return left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    })
    .slice(0, params.limit ?? DEFAULT_TAG_SELECTOR_LIMIT)
    .map((item): TagSelectorItem => ({ type: 'existing', tag: item.tag }));

  if (!query) return matches;
  return exactTagExists ? matches : [...matches, { type: 'create', name: query }];
}

export function clampTagSelectorIndex(index: number, itemCount: number): number {
  return clampMenuIndex(index, itemCount);
}
