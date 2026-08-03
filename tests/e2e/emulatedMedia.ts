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
  await page.waitForFunction((expected) => (
    matchMedia(`(prefers-color-scheme: ${expected.colorScheme})`).matches
    && matchMedia('(prefers-contrast: no-preference)').matches
    && matchMedia('(prefers-reduced-transparency: reduce)').matches
      === (expected.reducedTransparency === 'reduce')
  ), media);
}
