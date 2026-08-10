// Imported by the sandboxed preload, whose `require` polyfill resolves only
// electron/events/timers/url — so this module must stay dependency-free.
// Version logic (semver) and note parsing (marked, via changelog.ts) live in
// appUpdate.ts, which re-exports everything here for main and renderer.

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
