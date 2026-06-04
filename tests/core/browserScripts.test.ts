import { describe, expect, test } from 'bun:test';
import { isYouTubeWatchUrl } from '../../src/main/context/providers/browserScripts';

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
