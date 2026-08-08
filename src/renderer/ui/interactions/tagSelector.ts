import {
  buildTagCandidateIndex,
  rankTagCandidates,
  type TagCandidate,
  type TagCandidateIndex,
} from '../../../core/actions/candidates';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { clampMenuIndex } from './menuNavigation';

// The tag candidate POLICY lives in core beside the retrieval kernel
// (`core/actions/candidates.ts`) so the anchored menu, the at-caret `#` path
// and the registry's `addTag` parameter slot all answer from one
// implementation. This module keeps the renderer's per-projection cache.
export type TagSelectorItem = TagCandidate;

const activeTagSelectorIndexes = new WeakMap<DocumentIndex, TagCandidateIndex>();

function activeTagSelectorIndex(index: DocumentIndex): TagCandidateIndex {
  const cached = activeTagSelectorIndexes.get(index);
  if (cached) return cached;
  const next = buildTagCandidateIndex({
    nodes: index.projection.nodes,
    byId: index.byId,
    trashId: index.projection.trashId,
  });
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
  return rankTagCandidates({
    index: activeTagSelectorIndex(params.index),
    query: params.query,
    existingTagIds: params.existingTagIds,
    ...(params.limit === undefined ? {} : { limit: params.limit }),
  });
}

export function clampTagSelectorIndex(index: number, itemCount: number): number {
  return clampMenuIndex(index, itemCount);
}
