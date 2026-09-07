import {
  APP_UPDATE_RELEASES_URL,
  AppUpdatePayloadError,
  decodeGitHubReleases,
  isReleaseNewerThan,
  selectLatestStableRelease,
  type AppUpdateErrorCode,
  type AppUpdateOpenResult,
  type AppUpdateRemoteRelease,
  type AppUpdateView,
} from '../core/appUpdate';
import { normalizedVersion, parseChangelogReleases } from '../core/changelog';
import {
  AppUpdateStore,
  APP_UPDATE_MAX_RELEASE_NOTE_LENGTH,
  defaultState,
  type StoredAppUpdateRelease,
  type StoredAppUpdateState,
} from './appUpdateStore';

export const APP_UPDATE_THROTTLE_MS = 6 * 60 * 60 * 1_000;
export const APP_UPDATE_TIMEOUT_MS = 5_000;
const MAX_RELEASE_RESPONSE_BYTES = 1_000_000;
const MAX_CHANGELOG_BYTES = 4 * 1_024 * 1_024;
const MAX_REDIRECTS = 2;
const GITHUB_API_HOST = 'api.github.com';
const GITHUB_RAW_HOST = 'raw.githubusercontent.com';

type AppUpdateCheckKind = 'ambient' | 'explicit';

export interface AppUpdateServiceOptions {
  currentVersion: string;
  defaultAutomaticChecksEnabled: boolean;
  store: AppUpdateStore;
  fetch?: typeof globalThis.fetch;
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  throttleMs?: number;
  onChanged?: (view: AppUpdateView) => void;
  onError?: (error: unknown, operation: 'check' | 'release-note' | 'open') => void;
}

export class AppUpdateService {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly throttleMs: number;
  private readonly ready: Promise<void>;
  private state: StoredAppUpdateState;
  private phase: AppUpdateView['phase'] = 'idle';
  private checkInFlight: Promise<AppUpdateView> | null = null;
  private explicitCheckRequested = false;

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? APP_UPDATE_TIMEOUT_MS;
    this.throttleMs = options.throttleMs ?? APP_UPDATE_THROTTLE_MS;
    this.state = defaultState(options.defaultAutomaticChecksEnabled);
    this.ready = this.initialize();
  }

  async view(): Promise<AppUpdateView> {
    await this.ready;
    return this.projectView();
  }

  async checkExplicitly(): Promise<AppUpdateView> {
    return this.check('explicit', true);
  }

  async checkInBackground(options: { force?: boolean } = {}): Promise<AppUpdateView> {
    return this.check('ambient', options.force === true);
  }

  async setAutomaticChecksEnabled(enabled: boolean): Promise<AppUpdateView> {
    await this.ready;
    if (this.state.automaticChecksEnabled === enabled) return this.projectView();
    this.state = { ...this.state, automaticChecksEnabled: enabled };
    await this.options.store.save(this.state);
    this.emit();
    if (enabled) void this.checkInBackground({ force: true });
    return this.projectView();
  }

  async applyAutomaticChecksEnabled(enabled: boolean): Promise<AppUpdateView> {
    await this.ready;
    if (this.state.automaticChecksEnabled === enabled) return this.projectView();
    this.state = { ...this.state, automaticChecksEnabled: enabled };
    this.emit();
    if (enabled) void this.checkInBackground({ force: true });
    return this.projectView();
  }

  async openAvailableUpdate(): Promise<AppUpdateOpenResult> {
    await this.ready;
    const release = this.availableStoredRelease();
    if (!release) return { ok: false, error: 'unavailable' };
    const destination = release.downloadUrl ? 'download' : 'release';
    try {
      await this.options.openExternal(release.downloadUrl ?? release.releasePageUrl);
      return { ok: true, destination };
    } catch (error) {
      this.options.onError?.(error, 'open');
      return { ok: false, error: 'open-failed' };
    }
  }

  private async initialize(): Promise<void> {
    this.state = await this.options.store.load(this.options.defaultAutomaticChecksEnabled);
    if (this.state.release && !isReleaseNewerThan(this.state.release.version, this.options.currentVersion)) {
      this.state = { ...this.state, release: null };
      await this.options.store.save(this.state);
    }
  }

  private async check(kind: AppUpdateCheckKind, force: boolean): Promise<AppUpdateView> {
    await this.ready;
    if (kind === 'ambient') {
      if (!this.state.automaticChecksEnabled) return this.projectView();
      if (!force && !this.isDue()) return this.projectView();
    }
    if (this.checkInFlight) {
      if (kind === 'explicit') this.explicitCheckRequested = true;
      return this.checkInFlight;
    }

    this.explicitCheckRequested = kind === 'explicit';
    const run = this.runCheck().finally(() => {
      if (this.checkInFlight === run) this.checkInFlight = null;
      this.explicitCheckRequested = false;
    });
    this.checkInFlight = run;
    return run;
  }

  private async runCheck(): Promise<AppUpdateView> {
    let manualError: AppUpdateErrorCode | null = null;
    this.phase = 'checking';
    this.state = { ...this.state, lastAttemptAt: this.now() };
    await this.options.store.save(this.state);
    this.emit();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchFromTrustedHost(this.fetch, APP_UPDATE_RELEASES_URL, GITHUB_API_HOST, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `Tenon/${this.options.currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: controller.signal,
      });
      const payload = JSON.parse(await responseText(response, MAX_RELEASE_RESPONSE_BYTES));
      const release = selectLatestStableRelease(
        decodeGitHubReleases(payload),
        this.options.currentVersion,
      );
      const cached = this.state.release;
      const nextRelease = release
        ? await this.buildStoredRelease(release, cached, controller.signal)
        : null;
      this.state = {
        ...this.state,
        lastSuccessfulCheckAt: this.now(),
        release: nextRelease,
      };
      await this.options.store.save(this.state);
    } catch (error) {
      this.options.onError?.(error, 'check');
      if (this.explicitCheckRequested) manualError = classifyCheckError(error);
    } finally {
      clearTimeout(timeout);
      this.phase = 'idle';
      this.emit();
    }
    return this.projectView(manualError);
  }

  private async buildStoredRelease(
    release: AppUpdateRemoteRelease,
    cached: StoredAppUpdateRelease | null,
    signal: AbortSignal,
  ): Promise<StoredAppUpdateRelease> {
    const sameRelease = cached?.version === release.version;
    let note = sameRelease ? cached.note : null;
    if (!sameRelease || note === null) {
      try {
        const tag = encodeURIComponent(release.tag);
        const response = await fetchFromTrustedHost(
          this.fetch,
          `https://raw.githubusercontent.com/relixiaobo/lin-outliner/${tag}/CHANGELOG.md`,
          GITHUB_RAW_HOST,
          { signal },
        );
        const changelog = await responseText(response, MAX_CHANGELOG_BYTES);
        const matchingRelease = parseChangelogReleases(changelog)
          .find((entry) => normalizedVersion(entry.version) === release.version);
        if (!matchingRelease) {
          throw new AppUpdatePayloadError('Changelog does not contain the selected release.');
        }
        if (matchingRelease.note.length > APP_UPDATE_MAX_RELEASE_NOTE_LENGTH) {
          throw new AppUpdatePayloadError('Release note exceeds the character limit.');
        }
        note = matchingRelease.note;
      } catch (error) {
        this.options.onError?.(error, 'release-note');
      }
    }
    return {
      version: release.version,
      tag: release.tag,
      publishedAt: release.publishedAt,
      releasePageUrl: release.releasePageUrl,
      downloadUrl: release.downloadUrl,
      note,
    };
  }

  private availableStoredRelease(): StoredAppUpdateRelease | null {
    return this.state.release
      && isReleaseNewerThan(this.state.release.version, this.options.currentVersion)
      ? this.state.release
      : null;
  }

  private isDue(): boolean {
    const lastAttemptAt = this.state.lastAttemptAt;
    const now = this.now();
    return lastAttemptAt === null || now < lastAttemptAt || now - lastAttemptAt >= this.throttleMs;
  }

  private projectView(manualError: AppUpdateErrorCode | null = null): AppUpdateView {
    const release = this.availableStoredRelease();
    return {
      currentVersion: this.options.currentVersion,
      automaticChecksEnabled: this.state.automaticChecksEnabled,
      phase: this.phase,
      lastSuccessfulCheckAt: this.state.lastSuccessfulCheckAt,
      availableRelease: release ? {
        version: release.version,
        publishedAt: release.publishedAt,
        note: release.note || null,
        downloadAvailable: release.downloadUrl !== null,
      } : null,
      manualError,
    };
  }

  private emit(): void {
    this.options.onChanged?.(this.projectView());
  }
}

function classifyCheckError(error: unknown): AppUpdateErrorCode {
  if (isAbortError(error)) return 'timeout';
  if (error instanceof AppUpdatePayloadError || error instanceof SyntaxError) return 'invalid-response';
  return 'network';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function fetchFromTrustedHost(
  fetchImpl: typeof globalThis.fetch,
  initialUrl: string,
  trustedHost: string,
  init: RequestInit,
): Promise<Response> {
  let url = trustedUpdateUrl(initialUrl, trustedHost);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetchImpl(url, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;

    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get('location');
    if (!location || redirect === MAX_REDIRECTS) {
      throw new AppUpdatePayloadError('Update request returned too many or invalid redirects.');
    }
    url = trustedUpdateUrl(location, trustedHost, url);
  }
  throw new AppUpdatePayloadError('Update redirect policy rejected the request.');
}

function trustedUpdateUrl(value: string, trustedHost: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new AppUpdatePayloadError('Update request returned an invalid redirect URL.');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== trustedHost
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new AppUpdatePayloadError('Update request redirected outside its trusted GitHub host.');
  }
  return url;
}

async function responseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) throw new Error(`Update request failed with HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppUpdatePayloadError('Update response exceeds the byte limit.');
  }

  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AppUpdatePayloadError('Update response exceeds the byte limit.');
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        await reader.cancel().catch(() => undefined);
        throw new AppUpdatePayloadError('Update response is not valid UTF-8.');
      }
    }
    try {
      return text + decoder.decode();
    } catch {
      throw new AppUpdatePayloadError('Update response is not valid UTF-8.');
    }
  } finally {
    reader.releaseLock();
  }
}
