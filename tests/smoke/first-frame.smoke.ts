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

  test('a single main window is created and becomes visible', async () => {
    const visible = await smoke.app.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length !== 1) return { count: windows.length, visible: false };
      const win = windows[0];
      // Reveal happens on ready-to-show; poll briefly so we don't race the first
      // paint on a cold launch.
      for (let i = 0; i < 50 && !win.isVisible(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { count: windows.length, visible: win.isVisible() };
    });
    expect(visible.count).toBe(1);
    expect(visible.visible).toBe(true);
  });

  test('the pre-paint backing is never white (no launch flash)', async () => {
    const backgroundColor = await smoke.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.getBackgroundColor(),
    );
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
