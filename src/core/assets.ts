/**
 * The custom privileged protocol the renderer uses to load locally stored
 * assets (registered in the main process, served through Outline Runtime). Kept here
 * so the main process and the renderer share one source of truth for the
 * scheme name. Only the bare asset id is persisted in the document; the URL is
 * built at render time, so the scheme can change without any data migration.
 */
export const ASSET_URL_SCHEME = 'asset';
export const PREVIEW_LOCAL_URL_SCHEME = 'preview-local';
const ASSET_URL_HOST = 'local';

/** Build the URL a local asset is loaded through. */
export function assetUrl(assetId: string): string {
  return `${ASSET_URL_SCHEME}://${ASSET_URL_HOST}/${encodeURIComponent(assetId)}`;
}

export function assetIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== `${ASSET_URL_SCHEME}:`
      || url.hostname !== ASSET_URL_HOST
      || url.username !== ''
      || url.password !== ''
      || url.port !== ''
      || url.search !== ''
      || url.hash !== ''
      || !url.pathname.startsWith('/')
      || url.pathname.slice(1).includes('/')) {
      return null;
    }
    const assetId = decodeURIComponent(url.pathname.slice(1));
    return assetId.length > 0 && assetId.length <= 255 && !/[\\/\u0000-\u001f\u007f]/u.test(assetId)
      ? assetId
      : null;
  } catch {
    return null;
  }
}

/** Build the `preview-local://<token>` URL a trusted local-file preview streams through. */
export function previewLocalUrl(token: string): string {
  return `${PREVIEW_LOCAL_URL_SCHEME}://${token}`;
}
