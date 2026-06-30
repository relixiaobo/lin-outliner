import type { PreviewTarget } from '../../../core/preview';
import { dispatchPreviewTargetOpen } from './previewEvents';

export function previewTargetForUrl(url: string, label?: string): Extract<PreviewTarget, { kind: 'url' }> | null {
  const normalized = normalizePreviewUrl(url);
  if (!normalized) return null;
  const trimmedLabel = label?.trim();
  return {
    kind: 'url',
    url: normalized,
    ...(trimmedLabel ? { label: trimmedLabel } : {}),
  };
}

export function openUrlPreviewFromClick(
  _event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  url: string,
  label?: string,
): boolean {
  const target = previewTargetForUrl(url, label);
  if (!target) return false;
  dispatchPreviewTargetOpen({
    newPane: true,
    target,
  });
  return true;
}

function normalizePreviewUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
