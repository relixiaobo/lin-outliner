import { expect, test } from '@playwright/test';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

// Stage 2 startup semantics: the window is created hidden (`show: false`) and
// revealed on `ready-to-show`, with a scheme-matched (or transparent, under a
// material) pre-paint backing so launch never flashes an empty white frame. By
// the time the first window is available the renderer has mounted, so we assert
// the end-to-end first frame: a visible window, a non-white backing, and a
// populated `#root`.
test.describe('first frame', () => {
  let smoke: SmokeApp;

  test.beforeAll(async () => {
    smoke = await launchSmokeApp();
  });

  test.afterAll(async () => {
    await closeSmokeApp(smoke);
  });

  test('one main window becomes visible while the launcher stays hidden', async () => {
    const visible = await smoke.app.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const main = windows.find((window) => /\/index\.html(?:$|\?)/.test(window.webContents.getURL()));
      const launcher = windows.find((window) => /\/launcher\.html(?:$|\?)/.test(window.webContents.getURL()));
      if (!main || !launcher) {
        return { mainCount: main ? 1 : 0, launcherCount: launcher ? 1 : 0, mainVisible: false, launcherVisible: true };
      }
      // Reveal happens on ready-to-show; poll briefly so we don't race the first
      // paint on a cold launch.
      for (let i = 0; i < 50 && !main.isVisible(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        mainCount: windows.filter((window) => /\/index\.html(?:$|\?)/.test(window.webContents.getURL())).length,
        launcherCount: windows.filter((window) => /\/launcher\.html(?:$|\?)/.test(window.webContents.getURL())).length,
        mainVisible: main.isVisible(),
        launcherVisible: launcher.isVisible(),
      };
    });
    expect(visible.mainCount).toBe(1);
    expect(visible.launcherCount).toBe(1);
    expect(visible.mainVisible).toBe(true);
    expect(visible.launcherVisible).toBe(false);
  });

  test('the pre-paint backing is never white (no launch flash)', async () => {
    const backgroundColor = await smoke.app.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows()
        .find((window) => /\/index\.html(?:$|\?)/.test(window.webContents.getURL()))
        ?.getBackgroundColor()
    ));
    // macOS vibrancy → transparent (#00000000); a non-material window → the
    // opaque deck colour (#ececec / #2a2a2c). Either way, never the default
    // white that telegraphs a web-page load.
    expect(backgroundColor?.toUpperCase()).not.toBe('#FFFFFF');
    expect(backgroundColor?.toUpperCase()).not.toBe('#FFFFFFFF');
  });

  test('the renderer mounts its React root from the packaged file:// document', async () => {
    // Loaded from file:// (not the dev server), proving the prod renderer path.
    const url = smoke.window.url();
    expect(url.startsWith('file://')).toBe(true);

    const root = smoke.window.locator('#root');
    await expect(root).toBeAttached();
    await expect.poll(async () => (await root.innerHTML()).length).toBeGreaterThan(0);
  });
});
