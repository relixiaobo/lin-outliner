import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { clampMenuIndex } from './menuNavigation';

export type TagSelectorItem =
  | { type: 'existing'; tag: NodeProjection }
  | { type: 'create'; name: string };

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
  const matches = params.index.projection.nodes
    .filter((node) => node.type === 'tagDef')
    .filter((tag) => !existing.has(tag.id))
    .filter((tag) => !normalizedQuery || tag.content.text.toLowerCase().includes(normalizedQuery))
    .slice(0, params.limit ?? 6)
    .map((tag): TagSelectorItem => ({ type: 'existing', tag }));

  if (!query) return matches;
  return [...matches, { type: 'create', name: query }];
}

export function clampTagSelectorIndex(index: number, itemCount: number): number {
  return clampMenuIndex(index, itemCount);
}
