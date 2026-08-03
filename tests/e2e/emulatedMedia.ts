import { expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';

type EmulatedVisualMedia = {
  colorScheme: 'light' | 'dark';
  reducedTransparency: 'no-preference' | 'reduce';
};

const sessions = new WeakMap<Page, CDPSession>();

async function mediaSession(page: Page): Promise<CDPSession> {
  const existing = sessions.get(page);
  if (existing) return existing;
  const session = await page.context().newCDPSession(page);
  sessions.set(page, session);
  return session;
}

/** Playwright does not yet expose prefers-reduced-transparency in emulateMedia. */
export async function emulateVisualMedia(page: Page, media: EmulatedVisualMedia): Promise<void> {
  const session = await mediaSession(page);
  await session.send('Emulation.setEmulatedMedia', {
    media: 'screen',
    // setEmulatedMedia replaces the feature set, so declare every visual
    // preference that can change these material assertions.
    features: [
      { name: 'prefers-color-scheme', value: media.colorScheme },
      { name: 'prefers-reduced-motion', value: 'no-preference' },
      { name: 'forced-colors', value: 'none' },
      { name: 'prefers-contrast', value: 'no-preference' },
      { name: 'prefers-reduced-transparency', value: media.reducedTransparency },
    ],
  });
  await expect.poll(async () => page.evaluate(() => ({
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    forcedColors: matchMedia('(forced-colors: active)').matches ? 'active' : 'none',
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
    contrast: matchMedia('(prefers-contrast: more)').matches ? 'more' : 'no-preference',
    reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches
      ? 'reduce'
      : 'no-preference',
  })), {
    message: `Visual media overrides did not settle: ${JSON.stringify(media)}`,
    timeout: 5_000,
  }).toEqual({
    colorScheme: media.colorScheme,
    forcedColors: 'none',
    reducedMotion: 'no-preference',
    contrast: 'no-preference',
    reducedTransparency: media.reducedTransparency,
  });
}

/** Resolve a root color token through a non-inherited property so a missing token cannot inherit a false match. */
export async function resolveTokenColor(page: Page, token: `--${string}`): Promise<string> {
  return page.evaluate((tokenName) => {
    const rawValue = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim();
    if (!rawValue) throw new Error(`Missing root color token: ${tokenName}`);

    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${tokenName})`;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return resolved;
  }, token);
}
