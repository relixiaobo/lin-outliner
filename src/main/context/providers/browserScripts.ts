// AppleScript active-tab reader + URL helpers + the rich-page content CONTRACT.
//
// Capture is basic-info only today: `activeTabScript` reads a browser's active tab
// URL + title (no JS injection, no "Allow JavaScript from Apple Events" toggle). The
// in-page DOM scrapers that used to live here were removed in favor of the planned
// browser extension / CDP backend (see contextCapture.ts + docs/plans/
// browser-extension-integration.md).
//
// The `*Raw` interfaces stay as the backend-neutral CONTRACT: the shape a future
// `PageContentExtractor` (extension/CDP) produces and the normalizer + per-provider
// enrichers consume. They are not produced by anything today.

export type BrowserFamily = 'chromium' | 'safari';

/**
 * Rich generic-webpage metadata — the contract a backend extractor fills
 * (title/url/canonical/OG/Twitter-card/author). Folded into the saved SourceDraft.
 * Absent in today's basic-info capture; the normalizer falls back to URL + title
 * when it is missing. Body/transcript/selection extraction is intentionally out of
 * scope — that lives with the future unified backend.
 */
export interface GenericWebpageRaw {
  url?: string;
  title?: string;
  canonical?: string;
  ogTitle?: string;
  siteName?: string;
  description?: string;
  image?: string;
  ogUrl?: string;
  ogType?: string;
  author?: string;
  published?: string;
  h1?: string;
  jsonLdCount?: number;
}

/** YouTube content contract — generic metadata plus video identity. */
export interface YoutubeRaw extends GenericWebpageRaw {
  /** The `v` query param (watch) or the `/shorts/<id>` segment. */
  videoId?: string;
  /** True when captured on a Shorts page (no start-time anchoring). */
  isShorts?: boolean;
  /** Channel display name. */
  channel?: string;
  /** Channel URL. */
  channelUrl?: string;
}

/** X/Twitter content contract — generic OG fields plus the focused tweet. */
export interface XTwitterRaw extends GenericWebpageRaw {
  /** The primary tweet's text (bounded). */
  tweetText?: string;
  /** Author display name. */
  name?: string;
  /** Author handle, including the leading `@`. */
  handle?: string;
  /** Author avatar image URL. */
  avatar?: string;
}

/**
 * True when the URL is a YouTube *video* page (watch or Shorts) — the only pages
 * the YouTube provider enriches. Channel/home/search pages fall through to the
 * generic webpage provider. Tolerant of `www.`/`m.` and short links (`youtu.be`).
 */
export function isYouTubeWatchUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    if (host === 'youtu.be') return u.pathname.length > 1;
    if (host === 'youtube.com') {
      if (u.pathname === '/watch') return Boolean(u.searchParams.get('v'));
      if (u.pathname.startsWith('/shorts/')) return u.pathname.length > '/shorts/'.length;
    }
    return false;
  } catch {
    return false;
  }
}

/** Separator used to return two AppleScript values in one line (quote/backslash-free). */
export const TAB_FIELD_SEPARATOR = ' <<|LIN|>> ';

/**
 * Escape a value for embedding in an AppleScript double-quoted string literal.
 * Only `\` and `"` are special inside an AppleScript string. Callers pass the app
 * name into `tell application "…"`, which today is always an allow-listed browser
 * name (see `detectBrowserFamily`) — but escape rather than trust the allow-list,
 * so a future caller widening the input can't break out of the literal and inject
 * script (defense-by-escaping, not defense-by-allow-list).
 */
function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** AppleScript to read the active tab's URL + title without injecting JS. */
export function activeTabScript(family: BrowserFamily, appName: string): string {
  const app = escapeAppleScriptString(appName);
  if (family === 'safari') {
    return `tell application "${app}"\n`
      + `return (URL of front document) & "${TAB_FIELD_SEPARATOR}" & (name of front document)\n`
      + 'end tell';
  }
  return `tell application "${app}"\n`
    + `return (URL of active tab of front window) & "${TAB_FIELD_SEPARATOR}" & (title of active tab of front window)\n`
    + 'end tell';
}
