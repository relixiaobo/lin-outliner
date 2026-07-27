// web_fetch presents a real Chrome desktop identity so origins that gate on a
// browser User-Agent (Cloudflare edges, most news/CDN fronts) serve real
// content instead of a bot challenge. The major version tracks the bundled
// Chromium so the string never goes stale as Electron upgrades; it falls back to
// a recent major when process.versions.chrome is unavailable (e.g. unit tests).
const CHROME_MAJOR = (process.versions?.chrome ?? '').split('.')[0] || '140';
export const WEB_FETCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
export const WEB_FETCH_CLIENT_HINT_UA =
  `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not?A_Brand";v="24"`;
export const WEB_FETCH_CLIENT_HINT_PLATFORM = '"macOS"';

// The off-screen search window renders Google/Bing/DuckDuckGo with a real Chrome
// desktop identity (not Electron's default UA, which advertises "Electron" and
// the app name) so the engines serve the standard desktop layout the SERP
// scrapers target and are marginally less likely to gate the session. Shares the
// same bundled-Chromium major as the web_fetch identity above.
export const WEB_SEARCH_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
// One short-backoff retry for a transient search failure (nav network drop /
// timeout) before giving up or falling back to the secondary engine.
export const WEB_SEARCH_RETRY_DELAY_MS = 600;

export const FETCH_TIMEOUT_MS = 45_000;
// Backoff before the single automatic retry, which fires only for a recognized
// transient transport fault (a dropped/reset connection or network change — see
// isTransientNetworkError). HTTP responses (403/429/5xx, Cloudflare) are not
// retried here; they route to the embedded-browser fallback.
export const WEB_FETCH_RETRY_DELAY_MS = 600;
export const WEB_FETCH_BROWSER_TIMEOUT_MS = 20_000;
export const WEB_FETCH_RENDER_SETTLE_MS = 5_000;
export const WEB_FETCH_MAX_REDIRECTS = 10;
export const MAX_FETCH_BYTES = 10 * 1024 * 1024;
export const DEFAULT_FETCH_CHARS = 30_000;
export const MAX_FETCH_CHARS = 100_000;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 20;
