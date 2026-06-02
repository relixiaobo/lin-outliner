import { expect, test } from '@playwright/test';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

// Stage 1 navigation guards: the renderer is a fixed local surface. A child
// window (window.open) is denied and any http(s) target is routed to the OS
// browser via shell.openExternal; a top-level navigation away from the app
// document is blocked and likewise routed. We stub shell.openExternal in the
// main process so nothing actually launches a browser, then assert the routing.
//
// One shared instance: every guarded action is *prevented*, so it leaves the
// page on its file:// document and the app reusable. We just clear the recorder
// between tests.
test.describe('external-link routing', () => {
  let smoke: SmokeApp;

  test.beforeAll(async () => {
    smoke = await launchSmokeApp();
    await smoke.window.locator('#root').waitFor();
    // Replace shell.openExternal with a recorder. hardenWebContents reads the
    // live shell.openExternal reference at call time, so swapping the method
    // captures every routed URL.
    await smoke.app.evaluate(({ shell }) => {
      const sink: string[] = [];
      (globalThis as Record<string, unknown>).__openedExternal = sink;
      shell.openExternal = (url: string) => {
        sink.push(url);
        return Promise.resolve();
      };
    });
  });

  test.beforeEach(async () => {
    await smoke.app.evaluate(() => {
      ((globalThis as Record<string, unknown>).__openedExternal as string[]).length = 0;
    });
  });

  test.afterAll(async () => {
    await closeSmokeApp(smoke);
  });

  const opened = () =>
    smoke.app.evaluate(() => (globalThis as Record<string, unknown>).__openedExternal as string[]);

  test('window.open(https) is denied and routed to the OS browser', async () => {
    const before = await smoke.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await smoke.window.evaluate(() => {
      window.open('https://example.com/opened', '_blank');
    });
    await expect.poll(async () => (await opened()).includes('https://example.com/opened')).toBe(true);
    const after = await smoke.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(after).toBe(before); // no child window spawned
  });

  test('a non-http(s) window.open target is denied and NOT routed', async () => {
    await smoke.window.evaluate(() => {
      window.open('file:///etc/passwd', '_blank');
    });
    // openExternalUrl only forwards http(s); a file:// scheme must never reach
    // shell.openExternal.
    await smoke.window.waitForTimeout(300);
    expect((await opened()).some((url) => url.startsWith('file:'))).toBe(false);
  });

  test('a top-level navigation to https is blocked and routed', async () => {
    const documentUrl = smoke.window.url();
    await smoke.window.evaluate(() => {
      window.location.href = 'https://example.com/navigated';
    });
    await expect.poll(async () => (await opened()).includes('https://example.com/navigated')).toBe(true);
    // The renderer never left its file:// document.
    expect(smoke.window.url()).toBe(documentUrl);
  });
});
