export const FETCH_TIMEOUT_MS = 45_000;
export const WEB_FETCH_USER_AGENT = 'Tenon-WebFetch/0.1 (user-initiated fetch)';
// The off-screen search window renders Google/Bing/DuckDuckGo with a real Chrome
// desktop identity (not Electron's default UA, which advertises "Electron" and
// the app name) so the engines serve the standard desktop layout the SERP
// scrapers target and are marginally less likely to gate the session. The major
// version tracks the bundled Chromium; it falls back to a recent major when
// process.versions.chrome is unavailable (e.g. unit tests).
export const WEB_SEARCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + `Chrome/${(process.versions?.chrome ?? '').split('.')[0] || '140'}.0.0.0 Safari/537.36`;
// One short-backoff retry for a transient search failure (nav network drop /
// timeout) before giving up or falling back to the secondary engine.
export const WEB_SEARCH_RETRY_DELAY_MS = 600;
export const WEB_FETCH_BROWSER_TIMEOUT_MS = 15_000;
export const WEB_FETCH_RENDER_SETTLE_MS = 5_000;
export const WEB_FETCH_MAX_REDIRECTS = 10;
export const MAX_FETCH_BYTES = 10 * 1024 * 1024;
export const DEFAULT_FETCH_CHARS = 30_000;
export const MAX_FETCH_CHARS = 100_000;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 20;
