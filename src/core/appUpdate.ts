import { gt, prerelease, rcompare, valid } from 'semver';
import { normalizedVersion } from './changelog';

export const LIN_APP_UPDATE_GET_CHANNEL = 'lin:app-update/get';
export const LIN_APP_UPDATE_CHECK_CHANNEL = 'lin:app-update/check';
export const LIN_APP_UPDATE_SET_AUTOMATIC_CHANNEL = 'lin:app-update/set-automatic';
export const LIN_APP_UPDATE_OPEN_CHANNEL = 'lin:app-update/open';
export const LIN_APP_UPDATE_CHANGED_CHANNEL = 'lin:app-update/changed';

export const APP_UPDATE_RELEASES_URL =
  'https://api.github.com/repos/relixiaobo/lin-outliner/releases?per_page=20';
export const APP_UPDATE_MAX_RELEASES = 50;
export const APP_UPDATE_MAX_ASSETS_PER_RELEASE = 100;

export type AppUpdatePhase = 'idle' | 'checking';
export type AppUpdateErrorCode = 'network' | 'timeout' | 'invalid-response';

export interface AppUpdateReleaseView {
  version: string;
  publishedAt: string;
  note: string | null;
  downloadAvailable: boolean;
}

export interface AppUpdateView {
  currentVersion: string;
  automaticChecksEnabled: boolean;
  phase: AppUpdatePhase;
  lastSuccessfulCheckAt: number | null;
  availableRelease: AppUpdateReleaseView | null;
  manualError: AppUpdateErrorCode | null;
}

export interface AppUpdateOpenResult {
  ok: boolean;
  destination?: 'download' | 'release';
  error?: 'unavailable' | 'open-failed';
}

export interface AppUpdateRemoteRelease {
  version: string;
  tag: string;
  publishedAt: string;
  releasePageUrl: string;
  downloadUrl: string | null;
}

export class AppUpdatePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppUpdatePayloadError';
  }
}

export function decodeGitHubReleases(value: unknown): AppUpdateRemoteRelease[] {
  if (!Array.isArray(value)) throw new AppUpdatePayloadError('GitHub Releases response must be an array.');
  if (value.length > APP_UPDATE_MAX_RELEASES) {
    throw new AppUpdatePayloadError('GitHub Releases response exceeds the release limit.');
  }

  return value.flatMap((entry) => {
    const release = decodeGitHubRelease(entry);
    return release ? [release] : [];
  });
}

export function selectLatestStableRelease(
  releases: readonly AppUpdateRemoteRelease[],
  currentVersion: string,
): AppUpdateRemoteRelease | null {
  const current = stableVersion(currentVersion);
  if (!current) return null;
  return releases
    .filter((release) => gt(release.version, current))
    .sort((left, right) => rcompare(left.version, right.version))[0] ?? null;
}

export function stableVersion(value: string): string | null {
  const candidate = normalizedVersion(value);
  const parsed = valid(candidate);
  return parsed && prerelease(parsed) === null ? parsed : null;
}

export function isReleaseNewerThan(version: string, currentVersion: string): boolean {
  const release = stableVersion(version);
  const current = stableVersion(currentVersion);
  return Boolean(release && current && gt(release, current));
}

export function isAppUpdateAvailable(view: AppUpdateView | null | undefined): boolean {
  return Boolean(
    view?.automaticChecksEnabled
    && view.availableRelease
    && isReleaseNewerThan(view.availableRelease.version, view.currentVersion),
  );
}

export function isSafeReleasePageUrl(value: string, tag: string): boolean {
  const url = safeUrl(value);
  return Boolean(
    url
    && url.origin === 'https://github.com'
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && url.pathname === `/relixiaobo/lin-outliner/releases/tag/${encodeURIComponent(tag)}`,
  );
}

export function isSafeDmgDownloadUrl(value: string, tag: string): boolean {
  const url = safeUrl(value);
  const prefix = `/relixiaobo/lin-outliner/releases/download/${encodeURIComponent(tag)}/`;
  return Boolean(
    url
    && url.origin === 'https://github.com'
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && url.pathname.startsWith(prefix)
    && url.pathname.length > prefix.length
    && url.pathname.toLowerCase().endsWith('.dmg'),
  );
}

function decodeGitHubRelease(value: unknown): AppUpdateRemoteRelease | null {
  if (!isRecord(value)) return null;
  if (typeof value.draft !== 'boolean' || typeof value.prerelease !== 'boolean') return null;
  if (value.draft || value.prerelease) return null;
  if (typeof value.tag_name !== 'string' || typeof value.published_at !== 'string') return null;
  if (typeof value.html_url !== 'string' || !Array.isArray(value.assets)) return null;
  if (value.assets.length > APP_UPDATE_MAX_ASSETS_PER_RELEASE) return null;

  const tag = value.tag_name;
  const version = stableVersion(tag);
  if (!version || !isIsoDate(value.published_at)) return null;
  if (!isSafeReleasePageUrl(value.html_url, tag)) return null;

  const downloadUrl = value.assets
    .flatMap((asset) => decodeDmgAsset(asset, tag))
    .sort((left, right) => left.name.localeCompare(right.name))[0]?.url ?? null;

  return {
    version,
    tag,
    publishedAt: value.published_at,
    releasePageUrl: value.html_url,
    downloadUrl,
  };
}

function decodeDmgAsset(value: unknown, tag: string): Array<{ name: string; url: string }> {
  if (!isRecord(value)) return [];
  if (typeof value.name !== 'string' || typeof value.browser_download_url !== 'string') return [];
  if (!value.name.toLowerCase().endsWith('.dmg')) return [];
  if (!isSafeDmgDownloadUrl(value.browser_download_url, tag)) return [];
  return [{ name: value.name, url: value.browser_download_url }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
