import { expect, test, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

test('URL Preview keeps and clears one persistent website session', async () => {
  test.setTimeout(90_000);
  const server = await startFixtureServer();
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  let smoke: SmokeApp | null = null;
  let userDataDir = '';

  try {
    smoke = await launchSmokeApp();
    userDataDir = smoke.userDataDir;
    smoke.window = await findMainWindow(smoke);
    await smoke.window.locator('#root').waitFor();
    await setEnglish(smoke.window);

    let webview = await openPreview(smoke.window, `${origin}/seed`);
    await expect.poll(() => guestOrNull(webview, 'document.readyState')).toBe('complete');
    await expect.poll(() => guestOrNull(webview, `localStorage.getItem('tenon-session-smoke')`))
      .toBe('remembered');
    await expect(webview).toHaveAttribute('partition', 'persist:url-preview');
    expect(await webview.getAttribute('allowpopups')).not.toBeNull();

    await closeSmokeApp(smoke, { keepUserData: true });
    smoke = null;

    smoke = await launchSmokeApp({ userDataDir });
    smoke.window = await findMainWindow(smoke);
    await smoke.window.locator('#root').waitFor();
    await setEnglish(smoke.window);
    webview = await openPreview(smoke.window, `${origin}/verify`);
    await expect.poll(() => guestOrNull(webview, 'document.readyState')).toBe('complete');
    await expect.poll(() => guestOrNull(webview, 'document.body.dataset.cookieSeen')).toBe('true');
    await expect.poll(() => guestOrNull(webview, `localStorage.getItem('tenon-session-smoke')`))
      .toBe('remembered');

    const browserWindowCountBeforePopup = await browserWindowCount(smoke);
    await clickGuestElement(smoke.window, webview, '#popup-link');
    await expect.poll(() => guestOrNull(webview, 'window.location.pathname')).toBe('/popup');
    await expect.poll(() => guestOrNull(webview, 'document.body.dataset.cookieSeen')).toBe('true');
    await expect.poll(() => browserWindowCount(smoke)).toBe(browserWindowCountBeforePopup);

    await autoConfirmNextMessageBox(smoke);
    const settings = await openGeneralSettings(smoke);
    await settings.getByRole('button', { name: 'Clear…' }).click();
    await expect(settings.getByText('Website data cleared.')).toBeVisible();

    webview = await openPreview(smoke.window, `${origin}/verify?cleared=1`);
    await expect.poll(() => guestOrNull(webview, 'document.readyState')).toBe('complete');
    await expect.poll(() => guestOrNull(webview, 'document.body.dataset.cookieSeen')).toBe('false');
    await expect.poll(() => guestOrNull(webview, `localStorage.getItem('tenon-session-smoke')`)).toBeNull();

    await closeSmokeApp(smoke, { keepUserData: true });
    smoke = null;

    smoke = await launchSmokeApp({ userDataDir });
    smoke.window = await findMainWindow(smoke);
    await smoke.window.locator('#root').waitFor();
    webview = await openPreview(smoke.window, `${origin}/verify?after-relaunch=1`);
    await expect.poll(() => guestOrNull(webview, 'document.body.dataset.cookieSeen')).toBe('false');
    await expect.poll(() => guestOrNull(webview, `localStorage.getItem('tenon-session-smoke')`)).toBeNull();
  } finally {
    if (smoke) await closeSmokeApp(smoke, { keepUserData: true });
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

async function startFixtureServer(): Promise<Server> {
  let seeded = false;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.test').pathname;
    const cookieSeen = request.headers.cookie?.split(';').some((entry) => (
      entry.trim() === 'tenon_session=remembered'
    )) ?? false;
    if (path === '/seed' && !seeded) {
      seeded = true;
      response.setHeader('set-cookie', 'tenon_session=remembered; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/');
    }
    if (path !== '/seed' && path !== '/verify' && path !== '/popup') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html lang="en">
        <head><meta charset="utf-8"><title>Session fixture</title></head>
        <body data-cookie-seen="${cookieSeen}">
          <a id="popup-link" href="/popup" target="_blank">Open popup route</a>
          ${path === '/seed' ? `<script>localStorage.setItem('tenon-session-smoke', 'remembered')</script>` : ''}
        </body>
      </html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return server;
}

async function openPreview(page: Page, url: string) {
  const webview = page.locator('webview.file-preview-url-webview');
  await page.locator('.workspace-canvas').waitFor();
  await page.waitForTimeout(500);
  const needsPreviewPane = await webview.count() === 0;
  await page.evaluate(({ targetUrl, newPane }) => {
    window.dispatchEvent(new CustomEvent('lin:preview-target-open', {
      detail: { newPane, target: { kind: 'url', label: 'Session fixture', url: targetUrl } },
    }));
  }, { targetUrl: url, newPane: needsPreviewPane });
  await expect.poll(() => guestOrNull(webview, 'window.location.href')).toBe(url);
  return webview;
}

async function openGeneralSettings(smoke: SmokeApp): Promise<Page> {
  await smoke.window.evaluate(async () => {
    await (window as unknown as {
      lin: { openSettings: (target: { category: 'general' }) => Promise<void> };
    }).lin.openSettings({ category: 'general' });
  });
  await expect.poll(() => smoke.app.windows().filter((page) => surfaceFor(page) === 'settings').length).toBe(1);
  const settings = smoke.app.windows().find((page) => surfaceFor(page) === 'settings');
  if (!settings) throw new Error('Missing Settings window');
  await settings.locator('#root').waitFor();
  return settings;
}

async function autoConfirmNextMessageBox(smoke: SmokeApp): Promise<void> {
  await smoke.app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
}

async function browserWindowCount(smoke: SmokeApp): Promise<number> {
  return await smoke.app.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length
  ));
}

async function setEnglish(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as unknown as { lin: { setLanguage: (locale: 'en') => Promise<void> } }).lin.setLanguage('en');
  });
  await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
}

function surfaceFor(page: Page): string | null {
  try {
    return new URL(page.url()).searchParams.get('surface');
  } catch {
    return null;
  }
}

async function findMainWindow(smoke: SmokeApp): Promise<Page> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const mainWindow = smoke.app.windows().find((page) => (
      page.url().endsWith('/index.html') || page.url().includes('/index.html?')
    ));
    if (mainWindow) return mainWindow;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the main Tenon window.');
}

async function guest<T>(webview: ReturnType<Page['locator']>, expression: string): Promise<T> {
  return await webview.evaluate(async (element, source) => (
    await (element as Electron.WebviewTag).executeJavaScript(source) as T
  ), expression);
}

async function guestOrNull<T>(webview: ReturnType<Page['locator']>, expression: string): Promise<T | null> {
  try {
    return await guest<T>(webview, expression);
  } catch {
    return null;
  }
}

async function clickGuestElement(
  page: Page,
  webview: ReturnType<Page['locator']>,
  selector: string,
): Promise<void> {
  const target = await guest<{ height: number; width: number; x: number; y: number } | null>(
    webview,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { height: rect.height, width: rect.width, x: rect.x, y: rect.y };
    })()`,
  );
  const webviewBox = await webview.boundingBox();
  if (!target || !webviewBox) throw new Error(`Guest element is not clickable: ${selector}`);
  await page.mouse.click(
    webviewBox.x + target.x + target.width / 2,
    webviewBox.y + target.y + target.height / 2,
  );
}
