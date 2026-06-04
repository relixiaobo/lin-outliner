import { describe, expect, test } from 'bun:test';
import {
  enrichGithubContext,
  enrichSubstackContext,
  enrichXTwitterContext,
  enrichYoutubeContext,
  normalizeWebpageContext,
  selectSiteProvider,
} from '../../src/main/context/contextCapture';
import type { WebpageContextInputs } from '../../src/main/context/contextCapture';
import type { XTwitterRaw, YoutubeRaw } from '../../src/main/context/providers/browserScripts';

function base(overrides: Partial<WebpageContextInputs>): WebpageContextInputs {
  return {
    id: 'ctx:test',
    capturedAt: '2026-06-03T00:00:00.000Z',
    captureOrigin: 'test',
    frontmost: null,
    family: null,
    tab: null,
    page: null,
    ...overrides,
  };
}

describe('normalizeWebpageContext', () => {
  test('full page-script result yields an exact generic-webpage context', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
        family: 'chromium',
        tab: { url: 'https://example.com/post', title: 'Tab Title' },
        page: {
          raw: {
            url: 'https://example.com/post',
            title: 'Doc Title',
            ogTitle: 'OG Title',
            canonical: 'https://example.com/post-canonical',
            siteName: 'Example',
            description: 'A description',
            image: 'https://example.com/img.png',
            jsonLdCount: 0,
          },
        },
      }),
    );

    expect(ctx.providerId).toBe('generic-webpage');
    expect(ctx.confidence).toBe('exact');
    expect(ctx.warnings).toHaveLength(0);
    expect(ctx.permissions).toEqual(['macos-automation', 'browser-automation']);
    expect(ctx.browser?.hostname).toBe('example.com');
    expect(ctx.source?.kind).toBe('webpage');
    expect(ctx.source?.title).toBe('OG Title');
    expect(ctx.source?.url).toBe('https://example.com/post');
    expect(ctx.source?.canonicalUrl).toBe('https://example.com/post-canonical');
    expect(ctx.source?.imageUrl).toBe('https://example.com/img.png');
    expect(ctx.source?.original.kind).toBe('remote-url');
  });

  test('author/published metadata classifies the source as an article', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Safari' },
        family: 'safari',
        tab: { url: 'https://blog.example.com/x', title: 'Post' },
        page: {
          raw: {
            url: 'https://blog.example.com/x',
            title: 'Post',
            author: 'Jane Doe',
            published: '2026-01-01T00:00:00Z',
            ogType: 'article',
          },
        },
      }),
    );

    expect(ctx.source?.kind).toBe('article');
    expect(ctx.source?.author?.name).toBe('Jane Doe');
    expect(ctx.source?.publishedAt).toBe('2026-01-01T00:00:00Z');
  });

  test('basic info (no rich data) yields a probable webpage context — URL + title only', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Safari' },
        family: 'safari',
        tab: { url: 'https://example.com/', title: 'Example' },
        page: null,
      }),
    );

    expect(ctx.providerId).toBe('generic-webpage');
    expect(ctx.confidence).toBe('probable');
    expect(ctx.source?.kind).toBe('webpage');
    expect(ctx.source?.title).toBe('Example');
    expect(ctx.source?.url).toBe('https://example.com/');
    expect(ctx.warnings).toHaveLength(0); // no in-page script → no toggle/script warnings
  });

  test('a non-browser frontmost app yields the unknown-app fallback', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' },
        family: null,
      }),
    );

    expect(ctx.providerId).toBe('unknown-app');
    expect(ctx.confidence).toBe('fallback');
    expect(ctx.app.name).toBe('Slack');
    expect(ctx.source).toBeUndefined();
    expect(ctx.warnings).toHaveLength(0);
  });

  test('a browser with no readable tab flags browser-tab-unavailable', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome' },
        family: 'chromium',
        tab: null,
        page: null,
      }),
    );

    expect(ctx.providerId).toBe('unknown-app');
    expect(ctx.confidence).toBe('fallback');
    expect(ctx.warnings.some((w) => w.code === 'browser-tab-unavailable')).toBe(true);
    expect(ctx.permissions).toEqual(['macos-automation', 'browser-automation']);
  });

  test('no frontmost app records frontmost-unavailable', () => {
    const ctx = normalizeWebpageContext(base({ frontmost: null, family: null }));
    expect(ctx.providerId).toBe('unknown-app');
    expect(ctx.warnings.some((w) => w.code === 'frontmost-unavailable')).toBe(true);
  });

  test('AX URL agreeing with the page keeps rich metadata and adds the AX permission', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 1234 },
        family: 'chromium',
        tab: { url: 'https://example.com/post', title: 'Tab Title' },
        page: { raw: { url: 'https://example.com/post/', title: 'Doc', ogTitle: 'OG Title', author: 'Jane' } },
        ax: { url: 'https://example.com/post', title: 'OG Title' },
      }),
    );

    expect(ctx.confidence).toBe('exact');
    expect(ctx.source?.url).toBe('https://example.com/post');
    expect(ctx.source?.title).toBe('OG Title');
    expect(ctx.source?.author?.name).toBe('Jane');
    expect(ctx.warnings).toHaveLength(0);
    expect(ctx.permissions).toContain('macos-accessibility');
  });

  test('AX URL is authoritative for both URL and title (the front-tab may be another window)', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 1234 },
        family: 'chromium',
        // The AppleScript front-tab read may point at a DIFFERENT window than the
        // focused one; AX (by PID) is authoritative, so it wins for url + title.
        tab: { url: 'https://localhost:5173/csp-spike', title: 'csp-spike' },
        ax: { url: 'https://claude.ai/chat/abc', title: 'GPT pricing — Google Chrome' },
      }),
    );

    expect(ctx.source?.url).toBe('https://claude.ai/chat/abc');
    expect(ctx.source?.title).toBe('GPT pricing'); // AX title, browser suffix stripped
    expect(ctx.browser?.hostname).toBe('claude.ai');
    expect(ctx.confidence).toBe('probable');
    expect(ctx.warnings).toHaveLength(0); // no in-page script → no mismatch warnings
  });

  test('AX URL with no usable page yields an AX-only probable context', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Safari', pid: 9 },
        family: 'safari',
        tab: null,
        page: null,
        ax: { url: 'https://example.org/x', title: 'Example' },
      }),
    );

    expect(ctx.source?.url).toBe('https://example.org/x');
    expect(ctx.source?.title).toBe('Example');
    expect(ctx.confidence).toBe('probable');
  });

  test('Accessibility not granted is recorded as a relevant permission', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 1234 },
        family: 'chromium',
        tab: { url: 'https://example.com/', title: 'Example' },
        page: { raw: { url: 'https://example.com/', title: 'Example' } },
        ax: { error: 'ax-not-trusted' },
      }),
    );

    // No AX URL → existing front-window behavior, but flag AX as the better path.
    expect(ctx.source?.url).toBe('https://example.com/');
    expect(ctx.permissions).toContain('macos-accessibility');
    expect(ctx.warnings).toHaveLength(0);
  });

  test('cleans Chrome window-title decorations on the AX fallback title', () => {
    const ctx = normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 7 },
        family: 'chromium',
        tab: null,
        page: null,
        // Chrome appends "- Audio playing - <Browser> - <Profile>" to the window title.
        ax: { url: 'https://example.com/post', title: 'Deep Dive - Audio playing - Google Chrome - Work Profile' },
      }),
    );
    expect(ctx.source?.title).toBe('Deep Dive');
  });
});

describe('selectSiteProvider', () => {
  test('YouTube video URLs select the youtube provider; everything else is generic', () => {
    expect(selectSiteProvider('https://www.youtube.com/watch?v=abc')).toBe('youtube');
    expect(selectSiteProvider('https://youtu.be/abc')).toBe('youtube');
    expect(selectSiteProvider('https://example.com/post')).toBeNull();
    expect(selectSiteProvider('https://www.youtube.com/@channel')).toBeNull();
    expect(selectSiteProvider(undefined)).toBeNull();
  });

  test('X/Twitter status URLs select x-twitter (status pages only)', () => {
    expect(selectSiteProvider('https://x.com/jack/status/123')).toBe('x-twitter');
    expect(selectSiteProvider('https://twitter.com/jack/status/123')).toBe('x-twitter');
    expect(selectSiteProvider('https://mobile.twitter.com/jack/statuses/123')).toBe('x-twitter');
    // A profile/home is not a status → generic for now.
    expect(selectSiteProvider('https://x.com/jack')).toBeNull();
    expect(selectSiteProvider('https://x.com/home')).toBeNull();
  });

  test('GitHub repo + profile routes select github, but reserved roots do not', () => {
    expect(selectSiteProvider('https://github.com/facebook/react')).toBe('github');
    expect(selectSiteProvider('https://github.com/facebook/react/pulls')).toBe('github');
    expect(selectSiteProvider('https://github.com/torvalds')).toBe('github');
    expect(selectSiteProvider('https://github.com/features')).toBeNull();
    expect(selectSiteProvider('https://github.com/settings')).toBeNull();
    expect(selectSiteProvider('https://github.com/')).toBeNull();
  });

  test('Substack publication subdomains select substack; the bare marketing site does not', () => {
    expect(selectSiteProvider('https://read.substack.com/p/a-post')).toBe('substack');
    expect(selectSiteProvider('https://read.substack.com/')).toBe('substack');
    expect(selectSiteProvider('https://substack.com/')).toBeNull();
    expect(selectSiteProvider('https://www.substack.com/')).toBeNull();
  });
});

describe('enrichYoutubeContext', () => {
  function youtubeBaseContext(url = 'https://www.youtube.com/watch?v=abc123&list=PLxyz'): ReturnType<typeof normalizeWebpageContext> {
    return normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 1 },
        family: 'chromium',
        tab: { url, title: 'Cool Video - YouTube' },
        page: { raw: { url, title: 'Cool Video - YouTube', ogTitle: 'Cool Video', image: 'https://i.ytimg.com/x.jpg' } },
        ax: { url, title: 'Cool Video - YouTube' },
      }),
    );
  }

  test('upgrades a generic webpage context to a youtube video with a clean canonical URL', () => {
    const raw: YoutubeRaw = {
      url: 'https://www.youtube.com/watch?v=abc123&list=PLxyz',
      videoId: 'abc123',
      channel: 'Great Channel',
      channelUrl: 'https://www.youtube.com/@great',
    };
    const ctx = enrichYoutubeContext(youtubeBaseContext(), raw);

    expect(ctx.providerId).toBe('youtube');
    expect(ctx.source?.kind).toBe('video');
    // og:title survives the upgrade; the link is the clean canonical watch URL —
    // no playlist or player-position noise.
    expect(ctx.source?.title).toBe('Cool Video');
    expect(ctx.source?.url).toBe('https://www.youtube.com/watch?v=abc123');
    // No timestamp/duration is captured (basic-info only).
    expect(ctx.source?.timestampSeconds).toBeUndefined();
    expect(ctx.source?.durationSeconds).toBeUndefined();
    expect(ctx.source?.author?.name).toBe('Great Channel');
    expect(ctx.source?.author?.url).toBe('https://www.youtube.com/@great');
    expect(ctx.source?.original.kind).toBe('remote-url');
  });

  test('Shorts keep their own URL with any player-position param stripped', () => {
    const ctx = enrichYoutubeContext(
      youtubeBaseContext('https://www.youtube.com/shorts/zzz999?t=12s'),
      { videoId: 'zzz999', isShorts: true },
    );
    expect(ctx.source?.url).toBe('https://www.youtube.com/shorts/zzz999');
    expect(ctx.source?.timestampSeconds).toBeUndefined();
  });

  test('a context with no source (unknown-app) is returned unchanged', () => {
    const baseCtx = normalizeWebpageContext(base({ frontmost: { name: 'Slack' }, family: null }));
    const ctx = enrichYoutubeContext(baseCtx, { videoId: 'abc' });
    expect(ctx).toBe(baseCtx);
    expect(ctx.providerId).toBe('unknown-app');
  });

  test('classifies a YouTube URL as a video from the URL alone with no rich data', () => {
    // Empty raw = no backend extractor supplied page data.
    const ctx = enrichYoutubeContext(youtubeBaseContext('https://www.youtube.com/watch?v=abc123&t=45s'), {});
    expect(ctx.providerId).toBe('youtube');
    expect(ctx.source?.kind).toBe('video');
    // videoId recovered from the URL; clean canonical link with the `t=` stripped.
    expect(ctx.source?.url).toBe('https://www.youtube.com/watch?v=abc123');
    expect(ctx.source?.timestampSeconds).toBeUndefined();
    // Channel only arrives from a backend extractor.
    expect(ctx.source?.author).toBeUndefined();
  });
});

describe('enrichXTwitterContext', () => {
  // A context whose scripted page agreed with the AX URL → confidence 'exact', so
  // the scraped tweet fields are honored.
  function xBaseContext(url = 'https://x.com/jack/status/123'): ReturnType<typeof normalizeWebpageContext> {
    return normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 1 },
        family: 'chromium',
        tab: { url, title: 'Jack on X' },
        page: { raw: { url, title: 'Jack on X', ogTitle: 'Jack on X' } },
        ax: { url, title: 'Jack on X' },
      }),
    );
  }

  test('upgrades to a tweet: text becomes the title; author from the scrape', () => {
    const raw: XTwitterRaw = {
      url: 'https://x.com/jack/status/123',
      tweetText: 'just setting up my twttr',
      handle: '@jack',
      name: 'jack',
      avatar: 'https://pbs.twimg.com/a.jpg',
    };
    const ctx = enrichXTwitterContext(xBaseContext(), raw);

    expect(ctx.providerId).toBe('x-twitter');
    expect(ctx.source?.kind).toBe('tweet');
    expect(ctx.source?.title).toBe('just setting up my twttr');
    expect(ctx.source?.url).toBe('https://x.com/jack/status/123');
    expect(ctx.source?.author?.handle).toBe('@jack');
    expect(ctx.source?.author?.name).toBe('jack');
    expect(ctx.source?.author?.avatarUrl).toBe('https://pbs.twimg.com/a.jpg');
  });

  test('twitter.com hosts are recognized too', () => {
    const ctx = enrichXTwitterContext(
      xBaseContext('https://twitter.com/jack/status/123'),
      { tweetText: 'hi', handle: '@jack' },
    );
    expect(ctx.providerId).toBe('x-twitter');
    expect(ctx.source?.kind).toBe('tweet');
  });

  test('basic info (confidence not exact) ignores any passed raw; handle derives from the URL', () => {
    // No rich data → confidence 'probable', so the enricher does not trust raw and
    // keeps only the URL-derived tweet identity (today's basic-info path).
    const probable = normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 1 },
        family: 'chromium',
        tab: null,
        page: null,
        ax: { url: 'https://x.com/jack/status/123', title: 'Jack on X' },
      }),
    );
    expect(probable.confidence).toBe('probable');
    const ctx = enrichXTwitterContext(probable, { tweetText: 'UNTRUSTED', handle: '@wrong' });

    expect(ctx.source?.kind).toBe('tweet');
    expect(ctx.source?.title).not.toBe('UNTRUSTED'); // untrusted raw ignored
    expect(ctx.source?.author?.handle).toBe('@jack'); // recovered from the URL
  });

  test('a context with no source (unknown-app) is returned unchanged', () => {
    const baseCtx = normalizeWebpageContext(base({ frontmost: { name: 'Slack' }, family: null }));
    const ctx = enrichXTwitterContext(baseCtx, { tweetText: 'x', handle: '@x' });
    expect(ctx).toBe(baseCtx);
    expect(ctx.providerId).toBe('unknown-app');
  });
});

describe('enrichGithubContext', () => {
  function ghBaseContext(url: string): ReturnType<typeof normalizeWebpageContext> {
    return normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 1 },
        family: 'chromium',
        tab: { url, title: 'GitHub' },
        page: {
          raw: {
            url,
            title: 'GitHub',
            ogTitle: 'GitHub - owner/repo',
            description: 'A great repo',
            image: 'https://opengraph.githubassets.com/x.png',
          },
        },
        ax: { url, title: 'GitHub' },
      }),
    );
  }

  test('a repo route → kind repo, owner/repo title, owner as author', () => {
    const ctx = enrichGithubContext(ghBaseContext('https://github.com/facebook/react'));
    expect(ctx.providerId).toBe('github');
    expect(ctx.source?.kind).toBe('repo');
    expect(ctx.source?.title).toBe('facebook/react');
    expect(ctx.source?.author?.name).toBe('facebook');
    expect(ctx.source?.author?.url).toBe('https://github.com/facebook');
    expect(ctx.source?.url).toBe('https://github.com/facebook/react');
    // The generic OG description survives the upgrade.
    expect(ctx.source?.metadata?.description).toBe('A great repo');
  });

  test('a deep repo route still resolves to the repo', () => {
    const ctx = enrichGithubContext(ghBaseContext('https://github.com/facebook/react/blob/main/README.md'));
    expect(ctx.source?.kind).toBe('repo');
    expect(ctx.source?.title).toBe('facebook/react');
  });

  test('a bare user route → kind profile', () => {
    const ctx = enrichGithubContext(ghBaseContext('https://github.com/torvalds'));
    expect(ctx.source?.kind).toBe('profile');
    expect(ctx.source?.title).toBe('torvalds');
    expect(ctx.source?.author?.name).toBe('torvalds');
  });
});

describe('enrichSubstackContext', () => {
  function ssBaseContext(url: string, withByline = true): ReturnType<typeof normalizeWebpageContext> {
    return normalizeWebpageContext(
      base({
        frontmost: { name: 'Google Chrome', pid: 1 },
        family: 'chromium',
        tab: { url, title: 'A Post' },
        page: {
          raw: {
            url,
            title: 'A Post',
            ...(withByline ? { author: 'Jane Writer', published: '2026-05-01', ogType: 'article' } : {}),
          },
        },
        ax: { url, title: 'A Post' },
      }),
    );
  }

  test('a /p/ post → kind article with the byline + published already folded in', () => {
    const ctx = enrichSubstackContext(ssBaseContext('https://read.substack.com/p/a-post'));
    expect(ctx.providerId).toBe('substack');
    expect(ctx.source?.kind).toBe('article');
    expect(ctx.source?.author?.name).toBe('Jane Writer');
    expect(ctx.source?.publishedAt).toBe('2026-05-01');
  });

  test('a non-post (home/archive) is forced to a generic webpage even if it carries article metadata', () => {
    const ctx = enrichSubstackContext(ssBaseContext('https://read.substack.com/'));
    expect(ctx.providerId).toBe('substack');
    expect(ctx.source?.kind).toBe('webpage');
  });
});
