import { expect, test, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  closeSmokeApp,
  launchSmokeApp,
  type SmokeApp,
} from './electronApp';

interface TranslationBatch {
  blocks: Array<{ id: string; text: string }>;
}

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Persistent translation article</title></head>
  <body><main><h1>Persistent article heading</h1><p>Persistent source paragraph.</p></main></body>
</html>`;

const EPUB_BASE64 = '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';

test.describe('persistent preview translation cache', () => {
  let server: Server;
  let origin = '';
  let smoke: SmokeApp;
  const batches: TranslationBatch[] = [];

  test.beforeAll(async () => {
    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/article') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(ARTICLE_HTML);
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'llama-3.1-8b-instant', object: 'model', created: 1, owned_by: 'groq' }],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(await readRequestBody(request)) as {
          messages?: Array<{ content?: unknown; role?: string }>;
          model?: string;
        };
        const userMessage = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
        const batch = JSON.parse(messageText(userMessage?.content)) as TranslationBatch;
        batches.push(batch);
        const translation = JSON.stringify(batch.blocks.map((block) => ({
          id: block.id,
          translation: `Cached: ${block.text}`,
        })));
        const id = 'chatcmpl-persistent-translation';
        response.writeHead(200, {
          'cache-control': 'no-cache',
          connection: 'close',
          'content-type': 'text/event-stream; charset=utf-8',
        });
        response.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model ?? 'translation-smoke',
          choices: [{ index: 0, delta: { role: 'assistant', content: translation }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model ?? 'translation-smoke',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        })}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(404);
      response.end('Not found');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    smoke = await launchSmokeApp();
    smoke.window = await findMainWindow(smoke);
    await smoke.window.locator('#root').waitFor();
    await configureTranslation(smoke.window, `${origin}/v1`);
  });

  test.afterAll(async () => {
    await closeSmokeApp(smoke);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  test('restores URL and EPUB passages after restart and clears them from Settings', async () => {
    const assetId = await ingestEpub(smoke.window);
    await openTarget(smoke.window, {
      kind: 'url',
      label: 'Persistent translation article',
      url: `${origin}/article`,
    });
    const webview = smoke.window.locator('webview.file-preview-url-webview');
    await expect.poll(() => guest<string>(webview, 'document.readyState')).toBe('complete');
    await enableTranslation(smoke.window);
    await expect.poll(() => batches.length).toBeGreaterThan(0);
    await expect.poll(() => guest<string | null>(webview, `
      document.querySelector('[data-tenon-bilingual-translation="true"]')?.textContent ?? null
    `)).toContain('Cached:');
    await expect.poll(() => guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-status]').length
    `)).toBe(0);

    await openTarget(smoke.window, {
      kind: 'asset',
      assetId,
      label: 'Persistent translation book',
    });
    const firstChapter = smoke.window.locator('.file-preview-epub-iframe').first().contentFrame();
    await expect(firstChapter.locator('body')).toBeVisible();
    await enableTranslation(smoke.window);
    await expect(firstChapter.locator('[data-tenon-epub-translation="true"]').first()).toContainText('Cached:');
    await expect(firstChapter.locator('[data-tenon-epub-translation-status]')).toHaveCount(0);
    expect(batches.length).toBeGreaterThanOrEqual(2);

    const requestsBeforeRestart = batches.length;
    const userDataDir = smoke.userDataDir;
    await closeSmokeApp(smoke, { keepUserData: true });
    smoke = await launchSmokeApp({ userDataDir });
    smoke.window = await findMainWindow(smoke);
    await smoke.window.locator('#root').waitFor();

    await openTarget(smoke.window, {
      kind: 'url',
      label: 'Persistent translation article',
      url: `${origin}/article`,
    });
    const restoredWebview = smoke.window.locator('webview.file-preview-url-webview');
    await expect(restoredWebview).toBeAttached();
    await expect.poll(() => guestOrNull<string>(restoredWebview, 'document.readyState')).toBe('complete');
    await enableTranslation(smoke.window);
    await expect.poll(() => guest<string | null>(restoredWebview, `
      document.querySelector('[data-tenon-bilingual-translation="true"]')?.textContent ?? null
    `)).toContain('Cached:');
    await smoke.window.waitForTimeout(250);
    expect(batches).toHaveLength(requestsBeforeRestart);

    await openTarget(smoke.window, {
      kind: 'asset',
      assetId,
      label: 'Persistent translation book',
    });
    const restoredChapter = smoke.window.locator('.file-preview-epub-iframe').first().contentFrame();
    await expect(restoredChapter.locator('body')).toBeVisible();
    await enableTranslation(smoke.window);
    await expect(restoredChapter.locator('[data-tenon-epub-translation="true"]').first()).toContainText('Cached:');
    await smoke.window.waitForTimeout(250);
    expect(batches).toHaveLength(requestsBeforeRestart);

    await autoConfirmNextMessageBox(smoke);
    const settings = await openGeneralSettings(smoke);
    const translationData = settings.getByRole('list', { name: 'Translation Data' });
    await expect(translationData).toContainText('Saved translations');
    const visualDir = process.env.LIN_TRANSLATION_CACHE_VISUAL_DIR;
    if (visualDir) {
      await captureSettingsVisual(settings, visualDir, 'light');
      await captureSettingsVisual(settings, visualDir, 'dark');
      await settings.evaluate(async () => window.lin?.setTheme('system'));
    }
    await translationData.getByRole('button', { name: 'Clear…' }).click();
    await expect(settings.getByText('Saved translations cleared.')).toBeVisible();

    await openTarget(smoke.window, {
      kind: 'url',
      label: 'Persistent translation article',
      url: `${origin}/article`,
    });
    const clearedWebview = smoke.window.locator('webview.file-preview-url-webview');
    await expect.poll(() => guestOrNull<string>(clearedWebview, 'document.readyState')).toBe('complete');
    await enableTranslation(smoke.window);
    await expect.poll(() => batches.length).toBeGreaterThan(requestsBeforeRestart);
    await expect.poll(() => guest<string | null>(clearedWebview, `
      document.querySelector('[data-tenon-bilingual-translation="true"]')?.textContent ?? null
    `)).toContain('Cached:');

    await smoke.window.evaluate(async (id) => {
      await window.lin?.invoke('delete_asset', { id });
    }, assetId);
  });
});

async function configureTranslation(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate(async ({ baseUrl }) => {
    const lin = window.lin;
    if (!lin) throw new Error('Missing preload API');
    const providerId = 'groq';
    await lin.invoke('agent_upsert_provider_config', {
      provider: { providerId, baseUrl, enabled: true },
    });
    await lin.invoke('agent_set_provider_api_key', { providerId, apiKey: 'smoke-key' });
    await lin.invoke('agent_set_active_provider', { providerId });
    await lin.setLanguage('en');
    await lin.setTranslationLanguage('zh-Hans');
  }, { baseUrl });
}

async function openGeneralSettings(smoke: SmokeApp): Promise<Page> {
  await smoke.window.evaluate(async () => {
    await window.lin?.openSettings({ category: 'general' });
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

async function captureSettingsVisual(
  settings: Page,
  directory: string,
  theme: 'dark' | 'light',
): Promise<void> {
  await settings.emulateMedia({ colorScheme: theme });
  await settings.evaluate(async (nextTheme) => window.lin?.setTheme(nextTheme), theme);
  await expect.poll(() => settings.evaluate(() => (
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ))).toBe(theme === 'dark');
  await settings.waitForTimeout(200);
  await settings.screenshot({ path: `${directory}/translation-data-settings-${theme}.png` });
}

function surfaceFor(page: Page): string | null {
  try {
    return new URL(page.url()).searchParams.get('surface');
  } catch {
    return null;
  }
}

async function ingestEpub(page: Page): Promise<string> {
  const bytes = [...Buffer.from(EPUB_BASE64, 'base64')];
  return page.evaluate(async (input) => {
    const lin = window.lin;
    if (!lin) throw new Error('Missing preload API');
    const asset = await lin.invoke<{ id: string }>('ingest_asset', {
      kind: 'buffer',
      data: Uint8Array.from(input),
      mimeType: 'application/epub+zip',
      originalFilename: 'persistent-translation.epub',
    });
    return asset.id;
  }, bytes);
}

async function openTarget(page: Page, target: Record<string, unknown>): Promise<void> {
  await page.locator('.outline-panel-surface').first().waitFor();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.evaluate((nextTarget) => {
      window.dispatchEvent(new CustomEvent('lin:preview-target-open', {
        detail: { target: nextTarget },
      }));
    }, target);
    try {
      await page.locator('.file-preview-panel').waitFor({ timeout: 300 });
      return;
    } catch {
      // The first post-launch dispatch can precede App's preview-event effect.
    }
  }
  throw new Error('Timed out opening the preview target.');
}

async function enableTranslation(page: Page): Promise<void> {
  const toggle = page.locator('.file-preview-translation-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  const popover = page.locator('.file-preview-translation-popover');
  await expect(popover).toBeVisible();
  const language = popover.getByLabel('Translate to');
  if (await language.inputValue() !== 'zh-Hans') await language.selectOption('zh-Hans');
  await expect(language).toHaveValue('zh-Hans');
  await popover.locator('.file-preview-translation-command').click();
  await expect(toggle).toHaveAttribute('data-translation-enabled', 'true');
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
  return webview.evaluate(async (element, source) => (
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

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('Missing translation request content.');
  return content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    const value = part as { text?: unknown };
    return typeof value.text === 'string' ? value.text : '';
  }).join('');
}
