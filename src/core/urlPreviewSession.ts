export const URL_PREVIEW_WEBVIEW_PARTITION = 'persist:url-preview';

export const LIN_CLEAR_URL_PREVIEW_DATA_CHANNEL = 'lin:clear-url-preview-data';

export type ClearUrlPreviewDataResult =
  | { status: 'cleared' }
  | { status: 'canceled' }
  | { status: 'failed'; error: 'unavailable' | 'clear-failed' };
