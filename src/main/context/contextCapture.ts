// Context-capture orchestrator: turns "what is the user looking at right now"
// into a serializable ExternalContext the launcher can act on.
//
// Split into a thin IO orchestrator (captureExternalContext) and a PURE
// normalizer (normalizeWebpageContext) so the mapping from raw browser output to
// ExternalContext is unit-testable without spawning osascript. Nothing here blocks
// the hotkey-to-visible path — the launcher shows first and asks for this async.
//
// CAPTURE IS BASIC-INFO ONLY today: it reads URL + title (via the Accessibility
// API and the AppleScript front-tab read) and classifies the provider from the URL.
// In-page DOM extraction (the old AppleScript page scripts) was REMOVED — the
// toggle friction + wrong-window fragility weren't worth investing in when the
// planned browser extension / CDP backend replaces that layer wholesale. Rich page
// metadata (`raw`: OG/canonical/author/etc.) arrives only through a
// `PageContentExtractor` (the seam below) that the extension will implement; the
// normalizer + per-provider enrichers already fold `raw` into the saved SourceDraft,
// so plugging it in needs no change here. There is no in-app body/transcript/media
// extraction — that is deferred to the unified backend.
// See docs/plans/browser-extension-integration.md.

import type {
  ContextProviderId,
  ContextWarning,
  ExternalContext,
  PermissionRequirement,
} from '../../core/launcher/context';
import type { OriginalResourceRef, SourceDraft } from '../../core/launcher/sources';
import {
  detectBrowserFamily,
  getActiveTab,
  getFrontmostApp,
} from './providers/browser';
import type { ActiveTab, FrontmostApp } from './providers/browser';
import { isYouTubeWatchUrl } from './providers/browserScripts';
import type { BrowserFamily, GenericWebpageRaw, XTwitterRaw, YoutubeRaw } from './providers/browserScripts';
import { getFocusedBrowserTab } from './nativeBrowserTab';
import type { FocusedTabResult } from './nativeBrowserTab';

/** Site providers that enrich the generic-webpage context for specific hosts. */
export type SiteProvider = 'youtube' | 'x-twitter' | 'github' | 'substack';

/**
 * Pick a site provider for a URL, or null for the generic webpage path. Keyed on
 * the AX-authoritative URL (so it matches the window the user actually sees); when
 * AX is unavailable the generic provider runs and the site extras are simply
 * skipped (the link is still captured). Order is exclusive — a URL matches at most
 * one provider.
 */
export function selectSiteProvider(url: string | undefined): SiteProvider | null {
  if (isYouTubeWatchUrl(url)) return 'youtube';
  if (parseXStatus(url)) return 'x-twitter';
  if (parseGithubUrl(url)) return 'github';
  if (parseSubstack(url)) return 'substack';
  return null;
}

/** Everything the pure normalizer needs — gathered by the orchestrator. */
export interface WebpageContextInputs {
  id: string;
  capturedAt: string;
  captureOrigin: ExternalContext['captureOrigin'];
  frontmost: FrontmostApp | null;
  family: BrowserFamily | null;
  tab: ActiveTab | null;
  /**
   * Rich page data from a `PageContentExtractor` (the future extension/CDP backend),
   * or null in today's basic-info capture. The normalizer + enrichers consume
   * `raw` when present and otherwise produce URL+title-only output.
   */
  page: { raw?: GenericWebpageRaw } | null;
  /**
   * Accessibility-API read of the FOCUSED browser window (URL + title), targeting
   * the frontmost app by PID. Authoritative across multiple windows/instances —
   * the AppleScript front-tab read can disagree. null when AX is unavailable
   * (off-darwin / addon missing / no PID).
   */
  ax?: FocusedTabResult | null;
}

function safeHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Clean an AX window title for display. Chrome/Edge decorate it as
 * "<page> [- Audio playing] - <Browser> [- <Profile>]" — so cut from " - <Browser>"
 * onward (dropping the trailing profile too) and strip the audio indicator. The
 * og:title from the page script is preferred when available; this only grooms the
 * fallback.
 */
function stripBrowserSuffix(title: string | undefined, browserName: string): string | undefined {
  if (!title) return undefined;
  const esc = browserName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = title;
  const m = t.match(new RegExp(`\\s+[-—–]\\s+${esc}(?:\\s+[-—–]\\s+.*)?$`));
  if (m && m.index !== undefined && m.index > 0) t = t.slice(0, m.index);
  t = t.replace(/\s+[-—–]\s+Audio (?:playing|muted)\s*$/i, '');
  return t.trim() || title;
}

/** Drop undefined values so the serialized context stays clean. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function unknownAppContext(inputs: WebpageContextInputs): ExternalContext {
  const { frontmost } = inputs;
  const warnings: ContextWarning[] = [];
  if (!frontmost) {
    warnings.push({ code: 'frontmost-unavailable', message: 'Could not determine the active app.' });
  }
  return {
    id: inputs.id,
    capturedAt: inputs.capturedAt,
    captureOrigin: inputs.captureOrigin,
    app: { name: frontmost?.name ?? 'Unknown', ...(frontmost?.bundleId ? { bundleId: frontmost.bundleId } : {}) },
    providerId: 'unknown-app',
    confidence: 'fallback',
    warnings,
    permissions: [],
  };
}

/**
 * Pure: map gathered browser outputs to an ExternalContext. No IO. The generic
 * webpage provider owns any frontmost browser; if there is no usable URL it
 * degrades to the unknown-app fallback.
 *
 * `page.raw` (rich page data) is present only when a `PageContentExtractor` supplied
 * it (the future extension backend); today it is always absent, so this produces
 * basic-info output — URL + title. The raw-consumption paths below are kept as the
 * backend-neutral contract the extension will feed.
 */
export function normalizeWebpageContext(inputs: WebpageContextInputs): ExternalContext {
  const { frontmost, family, tab, page } = inputs;
  const ax = inputs.ax ?? null;

  // Not a scriptable browser → fallback to app-only context.
  if (!frontmost || !family) return unknownAppContext(inputs);

  // The AX read targets the FOCUSED window by PID, so its URL is authoritative when
  // present (only accept a real web URL); the AppleScript front-tab read is the
  // fallback. A rich extractor (when one exists) reads the same focused tab, so its
  // `raw` is trusted as-is — no cross-window reconciliation needed.
  const axUrl = ax?.url && /^https?:\/\//i.test(ax.url) ? ax.url : undefined;
  const raw = page?.raw;
  const url = axUrl || tab?.url || raw?.url;
  // No URL from any source → app-only, but flag why (drives the Automation remediation).
  if (!url) {
    const ctx = unknownAppContext(inputs);
    ctx.warnings.push({
      code: 'browser-tab-unavailable',
      message: `Could not read the active tab in ${frontmost.name}. Grant Automation access and try again.`,
      permission: 'browser-automation',
    });
    ctx.permissions = ['macos-automation', 'browser-automation'];
    return ctx;
  }

  const warnings: ContextWarning[] = [];
  const permissions: PermissionRequirement[] = ['macos-automation', 'browser-automation'];
  const providerId: ContextProviderId = 'generic-webpage';
  if (axUrl || ax?.error === 'ax-not-trusted') permissions.push('macos-accessibility');

  const hostname = safeHostname(url);
  const axTitle = stripBrowserSuffix(ax?.title, frontmost.name);
  // When AX has the authoritative (focused-window) URL, its stripped title is
  // authoritative too — the AppleScript front-tab title may belong to a different
  // window, so it is only a fallback. With no AX URL, the front-tab title leads.
  const preferredTitle = axUrl ? axTitle ?? tab?.title : tab?.title ?? axTitle;
  const title = raw?.ogTitle || raw?.title || preferredTitle || hostname || 'Untitled';
  const canonicalUrl = raw?.canonical || raw?.ogUrl;
  const looksLikeArticle = Boolean(raw?.author || raw?.published || raw?.ogType === 'article' || (raw?.jsonLdCount ?? 0) > 0);

  const metadata = compact({
    siteName: raw?.siteName,
    description: raw?.description,
    h1: raw?.h1,
    jsonLdCount: raw?.jsonLdCount,
    ogType: raw?.ogType,
  });

  const source: SourceDraft = compact({
    kind: looksLikeArticle ? 'article' : 'webpage',
    title,
    original: compact({
      kind: 'remote-url',
      url,
      canonicalUrl,
      preview: 'web-preview',
    }) as SourceDraft['original'],
    url,
    canonicalUrl,
    author: raw?.author ? { name: raw.author } : undefined,
    imageUrl: raw?.image,
    publishedAt: raw?.published,
    providerId,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  }) as SourceDraft;

  // "exact" only with rich page data from an extractor; basic-info (URL + title)
  // is "probable" — the right link, but not the full page.
  const confidence: ExternalContext['confidence'] = raw ? 'exact' : 'probable';

  return {
    id: inputs.id,
    capturedAt: inputs.capturedAt,
    captureOrigin: inputs.captureOrigin,
    app: compact({
      name: frontmost.name,
      bundleId: frontmost.bundleId,
    }),
    browser: compact({
      name: frontmost.name,
      tabTitle: raw?.title || preferredTitle,
      url,
      hostname,
    }),
    providerId,
    confidence,
    source,
    warnings,
    permissions,
  };
}

/** Identity bits parseable from a YouTube URL alone (no in-page script needed). */
function parseYoutubeUrl(url: string): { videoId?: string; isShorts?: boolean } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    let videoId: string | undefined;
    let isShorts: boolean | undefined;
    if (host === 'youtu.be') {
      videoId = u.pathname.slice(1).split('/')[0] || undefined;
    } else if (u.pathname === '/watch') {
      videoId = u.searchParams.get('v') ?? undefined;
    } else if (u.pathname.startsWith('/shorts/')) {
      videoId = u.pathname.slice('/shorts/'.length).split('/')[0] || undefined;
      isShorts = true;
    }
    return { videoId, isShorts };
  } catch {
    return {};
  }
}

/**
 * Build the captured YouTube link: a watch page collapses to the clean canonical
 * `watch?v=<id>` (dropping playlist/position noise); Shorts and id-less pages keep
 * their own URL with any player-position param (`t`/`start`) stripped. The link is
 * the video itself, never a "resume at <time>" deep-link — the player position is
 * intentionally not part of the captured URL.
 */
function buildYoutubeUrl(baseUrl: string, videoId: string | undefined, isShorts: boolean | undefined): string {
  if (videoId && !isShorts) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }
  try {
    const u = new URL(baseUrl);
    u.searchParams.delete('t');
    u.searchParams.delete('start');
    return u.toString();
  } catch {
    return baseUrl;
  }
}

/**
 * Pure: upgrade a generic-webpage context to a YouTube `video` context. Reuses
 * everything the generic normalizer already resolved
 * (URL/title/AX-merge/permissions/warnings) and overlays the video-specifics: a
 * #video kind, the channel author (when a backend extractor supplied it), and a
 * clean canonical watch URL. Identity (video id / Shorts) is derived from the URL
 * alone, so a watch/Shorts link still becomes a video with no rich data. A context
 * that degraded to no source is returned unchanged. Player position/duration are
 * intentionally not captured — that lives with the future unified backend.
 */
export function enrichYoutubeContext(ctx: ExternalContext, raw: YoutubeRaw): ExternalContext {
  const base = ctx.source;
  if (!base) return ctx;
  const baseUrl = base.url ?? ctx.browser?.url;
  if (!baseUrl) return ctx;

  // URL-derived identity is enough to classify the video; the channel only arrives
  // from a backend extractor (none today), so it stays absent until one runs.
  const fromUrl = parseYoutubeUrl(baseUrl);
  const videoId = raw.videoId ?? fromUrl.videoId;
  const isShorts = raw.isShorts ?? fromUrl.isShorts;
  const url = buildYoutubeUrl(baseUrl, videoId, isShorts);
  const author = raw.channel ? compact({ name: raw.channel, url: raw.channelUrl }) : base.author;

  // The source draft (what projects to the captured node) carries no timestamp /
  // duration — only the video kind, clean URL, and channel author.
  const source: SourceDraft = compact({
    ...base,
    kind: 'video',
    providerId: 'youtube',
    url,
    canonicalUrl: undefined,
    original: compact({ kind: 'remote-url', url, preview: 'web-preview' }) as OriginalResourceRef,
    author,
  }) as SourceDraft;

  return { ...ctx, providerId: 'youtube', source };
}

// ---------------------------------------------------------------------------
// X / Twitter
// ---------------------------------------------------------------------------

/** Parse an X/Twitter status URL → its handle + id, or null if not a status page. */
function parseXStatus(url: string | undefined): { handle: string; statusId: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|mobile\.|m\.)/, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    // /<handle>/status/<id>  (also /statuses/<id> on legacy links)
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 3 && (parts[1] === 'status' || parts[1] === 'statuses') && /^\d+$/.test(parts[2]!)) {
      return { handle: parts[0]!, statusId: parts[2]! };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pure: upgrade a generic-webpage context to an X/Twitter `tweet` context. When a
 * backend extractor supplied the focused tweet's text it becomes the node title and
 * the author handle/name/avatar populate the source; the scraped fields are only
 * trusted when the page agreed with the AX-authoritative URL (`confidence` is
 * `exact`). Otherwise we keep just the URL-derived tweet identity (handle from the
 * status URL). Returns the context unchanged if it had no source.
 */
export function enrichXTwitterContext(ctx: ExternalContext, raw: XTwitterRaw): ExternalContext {
  const base = ctx.source;
  if (!base) return ctx;
  const url = base.url ?? ctx.browser?.url;
  if (!url) return ctx;

  // Only honor the scraped tweet body/author when the page matched the focused
  // window (see normalizeWebpageContext: confidence === 'exact' iff raw was
  // honored). On a mismatch, keep the URL-derived tweet identity only.
  const scraped = ctx.confidence === 'exact' ? raw : undefined;
  const tweetText = scraped?.tweetText?.trim();
  const handle = scraped?.handle?.trim() || (parseXStatus(url)?.handle ? `@${parseXStatus(url)!.handle}` : undefined);
  const name = scraped?.name?.trim();
  const avatarUrl = scraped?.avatar;

  const author = handle || name || avatarUrl
    ? compact({ name, handle, avatarUrl })
    : base.author;

  const title = tweetText || base.title;
  const source: SourceDraft = compact({
    ...base,
    kind: 'tweet',
    providerId: 'x-twitter',
    title,
    canonicalUrl: undefined,
    original: compact({ kind: 'remote-url', url, preview: 'web-preview' }) as OriginalResourceRef,
    author,
  }) as SourceDraft;

  return { ...ctx, providerId: 'x-twitter', source };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

// Top-level GitHub routes that are NOT user/org profiles (so `/features` etc. are
// not mistaken for a profile capture).
const GITHUB_RESERVED_ROOTS = new Set([
  'features', 'marketplace', 'explore', 'topics', 'sponsors', 'settings', 'notifications',
  'pulls', 'issues', 'about', 'login', 'logout', 'join', 'search', 'orgs', 'new', 'apps',
  'organizations', 'dashboard', 'stars', 'codespaces', 'pricing', 'enterprise', 'team',
  'contact', 'site', 'security', 'collections', 'trending', 'readme', 'sponsors',
]);

/** Parse a GitHub URL into a repo or profile descriptor, or null if neither. */
function parseGithubUrl(url: string | undefined): { kind: 'repo' | 'profile'; owner: string; repo?: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, '') !== 'github.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const owner = parts[0]!;
    if (GITHUB_RESERVED_ROOTS.has(owner.toLowerCase())) return null;
    if (parts.length === 1) return { kind: 'profile', owner };
    // /<owner>/<repo>[/...] — anything deeper still identifies the repo.
    const repo = parts[1]!;
    if (repo === 'tab=repositories') return { kind: 'profile', owner };
    return { kind: 'repo', owner, repo };
  } catch {
    return null;
  }
}

/**
 * Pure: classify a GitHub page as a `repo` or user `profile` from its URL route.
 * Uses the generic OG metadata the base normalizer already folded in (description,
 * social-card image) and overlays a clean title + the owner as author. No DOM
 * script — GitHub's route pattern + OG tags carry everything we surface.
 */
export function enrichGithubContext(ctx: ExternalContext): ExternalContext {
  const base = ctx.source;
  if (!base) return ctx;
  const url = base.url ?? ctx.browser?.url;
  const parsed = parseGithubUrl(url);
  if (!parsed) return ctx;

  const ownerUrl = `https://github.com/${parsed.owner}`;
  const isRepo = parsed.kind === 'repo';
  const title = isRepo ? `${parsed.owner}/${parsed.repo}` : (base.author?.name || parsed.owner);
  const source: SourceDraft = compact({
    ...base,
    kind: isRepo ? 'repo' : 'profile',
    providerId: 'github',
    title,
    author: compact({ name: parsed.owner, handle: parsed.owner, url: ownerUrl }),
  }) as SourceDraft;
  return { ...ctx, providerId: 'github', source };
}

// ---------------------------------------------------------------------------
// Substack
// ---------------------------------------------------------------------------

/**
 * Detect a Substack-hosted page → whether it is a post. Only `*.substack.com`
 * subdomains are recognized; custom-domain Substacks are indistinguishable from a
 * generic site without the page and fall through to the generic provider.
 */
function parseSubstack(url: string | undefined): { isPost: boolean } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // A publication subdomain (e.g. `read.substack.com`), not the bare marketing site.
    if (host === 'substack.com' || !host.endsWith('.substack.com')) return null;
    return { isPost: u.pathname.startsWith('/p/') };
  } catch {
    return null;
  }
}

/**
 * Pure: tag a Substack page with the `substack` provider, classifying a `/p/` post
 * as an `article` (byline + published already folded in by the generic normalizer)
 * and anything else (home/archive/note) as a generic `webpage`. No DOM script —
 * Substack exposes author/published via standard meta tags the generic extractor reads.
 */
export function enrichSubstackContext(ctx: ExternalContext): ExternalContext {
  const base = ctx.source;
  if (!base) return ctx;
  const url = base.url ?? ctx.browser?.url;
  const parsed = parseSubstack(url);
  if (!parsed) return ctx;
  const source: SourceDraft = compact({
    ...base,
    kind: parsed.isPost ? 'article' : 'webpage',
    providerId: 'substack',
  }) as SourceDraft;
  return { ...ctx, providerId: 'substack', source };
}

/**
 * SEAM for the future browser backend. Capture today reads only basic info (URL +
 * title via AX / the AppleScript front-tab read); rich page data (`raw` →
 * OG/body/tweet/etc.) is supplied by an implementation of this interface. There is
 * intentionally NO implementation yet: the AppleScript in-page path was removed
 * (toggle friction + wrong-window fragility) in favor of the planned extension / CDP
 * backend, which will implement `extract()`. Its output is fed straight into the
 * existing normalizer + per-provider enrichers (they already consume `raw`) — that
 * is the entire plug-in point. See docs/plans/browser-extension-integration.md.
 */
export interface PageContentExtractor {
  extract(input: {
    /** The focused tab's URL (AX-authoritative when available). */
    url: string;
    family: BrowserFamily;
    appName: string;
    /** URL-derived provider classification, so the backend can pick a site extractor. */
    provider: SiteProvider | null;
  }): Promise<GenericWebpageRaw | null>;
}

/**
 * IO orchestrator: detect frontmost → read the active tab → normalize.
 *
 * The launcher steals focus once shown, so the frontmost app MUST be read before
 * that happens. Callers that already resolved it (the show path) pass `frontmost`
 * to skip the query; the tab read targets the browser by name and is safe to run
 * after focus moved. Omit `frontmost` (headless/manual refresh) and it is queried here.
 *
 * Pass an `extractor` (the future extension/CDP backend) to enrich with rich page
 * data; omit it (today) for basic-info capture.
 */
export async function captureExternalContext(args: {
  id: string;
  capturedAt: string;
  captureOrigin: ExternalContext['captureOrigin'];
  frontmost?: FrontmostApp | null;
  extractor?: PageContentExtractor;
}): Promise<ExternalContext> {
  const frontmost = 'frontmost' in args ? args.frontmost ?? null : await getFrontmostApp();
  const family = frontmost ? detectBrowserFamily(frontmost.name) : null;

  let tab: ActiveTab | null = null;
  let raw: GenericWebpageRaw | null = null;
  let ax: FocusedTabResult | null = null;
  let siteProvider: SiteProvider | null = null;
  if (frontmost && family) {
    const pid = frontmost.pid;
    // Resolve the AX read first: it targets the focused window by PID (a bounded,
    // synchronous native call) and is authoritative for the URL + title.
    ax = pid ? getFocusedBrowserTab(pid) : null;
    const axUrl = ax?.url && /^https?:\/\//i.test(ax.url) ? ax.url : undefined;
    const axTitle = ax?.title?.trim() ? ax.title : undefined;
    // The AppleScript front-tab read is the FALLBACK for URL + title. Skip its
    // ~800ms osascript spawn when the AX read is authoritative AND complete (both
    // URL + title present) — its output would be unused. Run it whenever AX is
    // missing either field, so a generic webpage still gets its link/title.
    tab = axUrl && axTitle ? null : await getActiveTab(family, frontmost.name);
    const tabUrl = tab?.url && /^https?:\/\//i.test(tab.url) ? tab.url : undefined;
    // Classify from the authoritative URL, falling back to the AppleScript tab URL
    // so a YouTube/X/GitHub/Substack page is still recognized when Accessibility
    // isn't granted (axUrl undefined). Classifying from axUrl alone would silently
    // downgrade such a page to a generic #webpage even though the link is captured.
    const url = axUrl ?? tabUrl;
    siteProvider = selectSiteProvider(url);
    // Rich page data only when a backend extractor is supplied (none today).
    if (args.extractor && url) {
      raw = await args.extractor.extract({ url, family, appName: frontmost.name, provider: siteProvider });
    }
  }

  const context = normalizeWebpageContext({
    id: args.id,
    capturedAt: args.capturedAt,
    captureOrigin: args.captureOrigin,
    frontmost,
    family,
    tab,
    page: raw ? { raw } : null,
    ax,
  });

  // Overlay site-provider specifics on the generic context. Each provider classifies
  // from the URL alone (so the link gets the right shape with no rich data); when an
  // extractor supplies `raw`, the enricher adds the rich fields too.
  switch (siteProvider) {
    case 'youtube':
      return enrichYoutubeContext(context, (raw as YoutubeRaw | null) ?? {});
    case 'x-twitter':
      return enrichXTwitterContext(context, (raw as XTwitterRaw | null) ?? {});
    case 'github':
      return enrichGithubContext(context);
    case 'substack':
      return enrichSubstackContext(context);
    default:
      return context;
  }
}
