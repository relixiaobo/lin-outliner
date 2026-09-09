import { expect, test } from '@playwright/test';
import { closeSmokeApp, launchSmokeApp } from './electronApp';

test('reads bounded bundled release information through the real Settings bridge', async () => {
  const smoke = await launchSmokeApp();
  try {
    await expect.poll(() => smoke.window.evaluate(() => typeof window.lin?.openSettings)).toBe('function');
    await smoke.window.evaluate(() => window.lin!.openSettings({ destination: 'about' }));
    await expect.poll(() => (
      smoke.app.windows().some((page) => page.url().includes('destination=about'))
    )).toBe(true);
    const settings = smoke.app.windows().find((page) => page.url().includes('destination=about'));
    if (!settings) throw new Error('Missing Settings window');
    const result = await settings.evaluate(async () => {
      if (!window.lin) throw new Error('Missing preload API');
      return {
        app: await window.lin.appInfo(),
        release: await window.lin.bundledApplicationRelease(),
      };
    });

    expect(result.app.version).toMatch(/^\d+\.\d+\.\d+$/);
    if (!result.release) throw new Error('Missing bundled release information');
    expect(result.release.version).not.toBe('Unreleased');
    expect(result.release.note).not.toContain('main is the');
    expect(result.release.changelogUrl).toContain(`/blob/v${result.release.version}/CHANGELOG.md#`);
  } finally {
    await closeSmokeApp(smoke);
  }
});
