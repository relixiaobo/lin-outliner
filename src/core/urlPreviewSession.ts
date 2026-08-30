export const URL_PREVIEW_WEBVIEW_PARTITION = 'persist:url-preview';

const YOUTUBE_EMBED_HTTP_REFERRER = 'https://tenon.local/';
const YOUTUBE_EMBED_PATH = /^\/embed\/[A-Za-z0-9_-]{6,32}$/;

export function httpReferrerForUrlPreview(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'www.youtube.com'
      && YOUTUBE_EMBED_PATH.test(parsed.pathname)
      ? YOUTUBE_EMBED_HTTP_REFERRER
      : undefined;
  } catch {
    return undefined;
  }
}

export const LIN_CLEAR_URL_PREVIEW_DATA_CHANNEL = 'lin:clear-url-preview-data';

export type ClearUrlPreviewDataResult =
  | { status: 'cleared' }
  | { status: 'canceled' }
  | { status: 'failed'; error: 'unavailable' | 'clear-failed' };
