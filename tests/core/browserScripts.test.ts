import { describe, expect, test } from 'bun:test';
import { activeTabScript, isYouTubeWatchUrl } from '../../src/main/context/providers/browserScripts';

describe('isYouTubeWatchUrl', () => {
  test('matches watch / shorts / youtu.be across www and m subdomains', () => {
    expect(isYouTubeWatchUrl('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(isYouTubeWatchUrl('https://m.youtube.com/watch?v=abc123&list=xyz')).toBe(true);
    expect(isYouTubeWatchUrl('https://youtube.com/shorts/xyz789')).toBe(true);
    expect(isYouTubeWatchUrl('https://youtu.be/abc123')).toBe(true);
  });

  test('rejects non-video YouTube pages and other hosts', () => {
    expect(isYouTubeWatchUrl('https://www.youtube.com/')).toBe(false);
    expect(isYouTubeWatchUrl('https://www.youtube.com/watch')).toBe(false); // no ?v
    expect(isYouTubeWatchUrl('https://www.youtube.com/@channel')).toBe(false);
    expect(isYouTubeWatchUrl('https://youtu.be/')).toBe(false);
    expect(isYouTubeWatchUrl('https://example.com/watch?v=abc')).toBe(false);
    expect(isYouTubeWatchUrl('not a url')).toBe(false);
    expect(isYouTubeWatchUrl(undefined)).toBe(false);
  });
});

describe('activeTabScript', () => {
  test('embeds an allow-listed browser name verbatim (no special chars to escape)', () => {
    expect(activeTabScript('chromium', 'Google Chrome')).toContain('tell application "Google Chrome"');
    expect(activeTabScript('safari', 'Safari')).toContain('tell application "Safari"');
  });

  test('escapes quotes and backslashes so an app name cannot break out of the literal', () => {
    // Not a reachable input today (appName is allow-listed), but the escape makes
    // the function safe-by-construction for any future caller.
    const script = activeTabScript('chromium', 'Eviltell application "Finder" to quit"');
    expect(script).toContain('tell application "Eviltell application \\"Finder\\" to quit\\""');
    // The injected `tell application "Finder"` must NOT appear as a live unescaped clause.
    expect(script).not.toContain('"Finder" to quit"\n');
    const withBackslash = activeTabScript('safari', 'Brave\\Browser');
    expect(withBackslash).toContain('tell application "Brave\\\\Browser"');
  });
});
