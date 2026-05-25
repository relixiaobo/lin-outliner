/**
 * The custom privileged protocol the renderer uses to load locally stored
 * assets (registered in the main process, served by `AssetService`). Kept here
 * so the main process and the renderer share one source of truth for the
 * scheme name. Only the bare asset id is persisted in the document; the URL is
 * built at render time, so the scheme can change without any data migration.
 */
export const ASSET_URL_SCHEME = 'asset';

/** Build the `asset://<id>` URL a local asset is loaded through. */
export function assetUrl(assetId: string): string {
  return `${ASSET_URL_SCHEME}://${assetId}`;
}
