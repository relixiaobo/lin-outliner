import type { PreviewTarget } from '../../../core/preview';

export const PREVIEW_TARGET_OPEN_EVENT = 'lin:preview-target-open';

export interface PreviewTargetOpenDetail {
  newPane?: boolean;
  target: PreviewTarget;
}

export function dispatchPreviewTargetOpen(detail: PreviewTargetOpenDetail): void {
  window.dispatchEvent(new CustomEvent<PreviewTargetOpenDetail>(PREVIEW_TARGET_OPEN_EVENT, { detail }));
}

export function onPreviewTargetOpen(listener: (detail: PreviewTargetOpenDetail) => void): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<PreviewTargetOpenDetail>).detail);
  };
  window.addEventListener(PREVIEW_TARGET_OPEN_EVENT, handler);
  return () => {
    window.removeEventListener(PREVIEW_TARGET_OPEN_EVENT, handler);
  };
}
