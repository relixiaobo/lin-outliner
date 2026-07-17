import {
  PREVIEW_TRANSLATION_CACHE_MAX_SOURCE_ID_CHARS,
  type UrlPageTranslationBlock,
  type UrlPageTranslationResponse,
} from '../../../core/urlPageTranslation';
import type { PreviewFileSource } from '../../../core/preview';

type SuccessfulTranslationResponse = Extract<UrlPageTranslationResponse, { ok: true }>;

export interface PreviewTranslationCacheResponsePlan {
  remainingBlocks: UrlPageTranslationBlock[];
}

export function previewTranslationCacheResponsePlan(
  response: SuccessfulTranslationResponse,
  requestedBlocks: readonly UrlPageTranslationBlock[],
): PreviewTranslationCacheResponsePlan | null {
  if (response.cacheHit !== true || response.translations.length === 0) return null;
  const requestedIds = new Set(requestedBlocks.map((block) => block.id));
  const hitIds = new Set<string>();
  for (const item of response.translations) {
    if (!requestedIds.has(item.id) || hitIds.has(item.id)) return null;
    hitIds.add(item.id);
  }

  const remainingIds = response.remainingBlockIds ?? [];
  if (response.remainingBlockIds && remainingIds.length === 0) return null;
  const remainingSet = new Set<string>();
  for (const id of remainingIds) {
    if (!requestedIds.has(id) || hitIds.has(id) || remainingSet.has(id)) return null;
    remainingSet.add(id);
  }
  if (hitIds.size + remainingSet.size !== requestedIds.size) return null;
  return {
    remainingBlocks: requestedBlocks.filter((block) => remainingSet.has(block.id)),
  };
}

export function previewTranslationCacheSourceId(
  kind: 'epub' | 'url',
  parts: readonly (number | string | null | undefined)[],
): string | undefined {
  const value = JSON.stringify([kind, ...parts]);
  return value.length <= PREVIEW_TRANSLATION_CACHE_MAX_SOURCE_ID_CHARS ? value : undefined;
}

export function epubPreviewTranslationCacheSourceId(
  source: Pick<PreviewFileSource, 'id' | 'lastModified' | 'sizeBytes'>,
): string | undefined {
  return previewTranslationCacheSourceId('epub', [
    source.id,
    source.sizeBytes,
    source.lastModified,
  ]);
}
