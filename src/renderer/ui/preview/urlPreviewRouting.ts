import { normalizePreviewHttpUrl, type PreviewTarget } from '../../../core/preview';
import { dispatchPreviewTargetOpen } from './previewEvents';

export interface YoutubePreviewRoute {
  embedUrl: string;
  videoId: string;
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{6,32}$/;

export function youtubePreviewRouteForUrl(url: string): YoutubePreviewRoute | null {
  const normalized = normalizePreviewHttpUrl(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    let videoId = '';
    if (hostname === 'youtu.be' || hostname === 'www.youtu.be') {
      videoId = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      videoId = parsed.searchParams.get('v')?.trim() ?? '';
      if (!videoId) {
        const [route, routeVideoId] = parsed.pathname.split('/').filter(Boolean);
        if (route === 'embed' || route === 'shorts' || route === 'live') videoId = routeVideoId ?? '';
      }
    }
    if (!YOUTUBE_VIDEO_ID.test(videoId)) return null;
    const embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
    embedUrl.searchParams.set('autoplay', '0');
    embedUrl.searchParams.set('playsinline', '1');
    return { embedUrl: embedUrl.toString(), videoId };
  } catch {
    return null;
  }
}

export function previewTargetForUrl(url: string, label?: string): Extract<PreviewTarget, { kind: 'url' }> | null {
  const normalized = normalizePreviewHttpUrl(url);
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
