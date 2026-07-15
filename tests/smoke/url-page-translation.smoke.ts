import { expect, test, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { closeSmokeApp, launchSmokeApp, type SmokeApp } from './electronApp';

interface TranslationBatch {
  blocks: Array<{ id: string; text: string }>;
  targetLanguage: string;
}

const ARTICLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Translation smoke article</title>
    <style>
      body { margin: 0; color: #202124; background: #fff; font: 18px/1.55 system-ui, sans-serif; }
      main { box-sizing: border-box; max-width: 760px; margin: 0 auto; padding: 48px 32px 96px; }
      h1, p { margin: 0 0 24px; }
      .near-spacer { height: 520px; }
      .far-spacer { height: 4200px; }
    </style>
  </head>
  <body>
    <main>
      <h1 id="heading">Viewport translation smoke test</h1>
      <p id="visible">Visible source paragraph.</p>
      <div class="near-spacer"></div>
      <p id="prefetch">Prefetched source paragraph.</p>
      <div class="far-spacer"></div>
      <p id="far">Far source paragraph.</p>
    </main>
  </body>
</html>`;

test.describe('URL page translation', () => {
  let server: Server;
  let origin = '';
  let smoke: SmokeApp;
  const batches: TranslationBatch[] = [];
  let failNextRequest = false;

  test.beforeAll(async () => {
    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url?.startsWith('/article')) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(ARTICLE_HTML);
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/chat/completions') {
        const body = JSON.parse(await readRequestBody(request)) as {
          messages?: Array<{ content?: unknown; role?: string }>;
          model?: string;
        };
        const userMessage = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
        const payload = JSON.parse(messageText(userMessage?.content)) as TranslationBatch;
        batches.push(payload);
        const shouldFail = failNextRequest;
        failNextRequest = false;
        const translation = shouldFail
          ? 'invalid translation response'
          : JSON.stringify(payload.blocks.map((block) => ({
              id: block.id,
              translation: `ZH: ${block.text}`,
            })));
        await new Promise((resolve) => setTimeout(resolve, 250));
        const id = 'chatcmpl-translation-smoke';
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
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;

    smoke = await launchSmokeApp();
    smoke.window = await findMainWindow(smoke);
    await smoke.window.locator('#root').waitFor();
    await configureTranslationProvider(smoke.window, `${origin}/v1`);
    await smoke.window.evaluate(async () => {
      const lin = (window as unknown as {
        lin: { setLanguage: (locale: 'en') => Promise<void> };
      }).lin;
      await lin.setLanguage('en');
    });
    await expect.poll(() => smoke.window.locator('html').getAttribute('lang')).toBe('en');
  });

  test.afterAll(async () => {
    await closeSmokeApp(smoke);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  test('translates the reading window lazily and reuses the in-memory cache', async () => {
    await smoke.window.evaluate((url) => {
      window.dispatchEvent(new CustomEvent('lin:preview-target-open', {
        detail: {
          target: { kind: 'url', label: 'Translation smoke article', url },
        },
      }));
    }, `${origin}/article`);

    const webview = smoke.window.locator('webview.file-preview-url-webview');
    const toggle = smoke.window.locator('.file-preview-translation-toggle');
    const popover = smoke.window.locator('.file-preview-translation-popover');
    const visualDir = process.env.LIN_TRANSLATION_VISUAL_DIR;
    await expect(webview).toBeAttached();
    await expect.poll(() => guest<string>(webview, 'document.readyState')).toBe('complete');
    await expect(toggle).toHaveAttribute('data-translation-enabled', 'false');
    expect(batches).toHaveLength(0);

    await toggle.click();
    await expect(popover).toBeVisible();
    const languageSelect = popover.getByLabel('Target language');
    await expect(languageSelect).toHaveValue('en');
    await popover.getByRole('button', { name: 'Translate page' }).click();
    await expect(toggle).toHaveAttribute('data-translation-enabled', 'true');
    await smoke.window.waitForTimeout(600);
    expect(batches).toHaveLength(0);
    expect(await guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-status]').length
    `)).toBe(0);

    await toggle.click();
    await popover.getByRole('button', { name: 'Show original' }).click();
    await expect(toggle).toHaveAttribute('data-translation-enabled', 'false');

    await toggle.click();
    await languageSelect.selectOption('zh-Hans');
    await popover.getByRole('button', { name: 'Translate page' }).click();
    await expect(toggle).toHaveAttribute('data-translation-enabled', 'true');
    await expect.poll(() => guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-status="loading"]').length
    `)).toBeGreaterThan(0);
    if (visualDir) {
      await smoke.window.screenshot({ path: `${visualDir}/url-translation-loading.png` });
    }
    await expect.poll(() => guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-translation="true"]').length
    `)).toBeGreaterThanOrEqual(2);
    expect(await guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-status]').length
    `)).toBe(0);

    if (visualDir) {
      await captureTranslationVisual(smoke.window, toggle, popover, visualDir, 'light');
      await captureTranslationVisual(smoke.window, toggle, popover, visualDir, 'dark');
      await smoke.window.emulateMedia({ colorScheme: 'no-preference' });
      await smoke.window.evaluate(async () => {
        await (window as unknown as {
          lin: { setTheme: (theme: 'system') => Promise<void> };
        }).lin.setTheme('system');
      });
    }

    const initialTexts = batches.flatMap((batch) => batch.blocks.map((block) => block.text));
    expect(batches.every((batch) => batch.targetLanguage === 'Simplified Chinese')).toBe(true);
    expect(initialTexts).toContain('Visible source paragraph.');
    expect(initialTexts).toContain('Prefetched source paragraph.');
    expect(initialTexts).not.toContain('Far source paragraph.');

    await guest(webview, `document.getElementById('far').scrollIntoView({ block: 'center' }); true`);
    await expect.poll(() => guest<string | null>(webview, `
      document.querySelector('#far [data-tenon-bilingual-translation="true"]')?.textContent ?? null
    `)).toBe('ZH: Far source paragraph.');
    expect(batches.flatMap((batch) => batch.blocks.map((block) => block.text)))
      .toContain('Far source paragraph.');

    const completedRequestCount = batches.length;
    await toggle.click();
    await popover.getByRole('button', { name: 'Show original' }).click();
    await expect(toggle).toHaveAttribute('data-translation-enabled', 'false');
    expect(await guest(webview, `document.documentElement.getAttribute('data-tenon-bilingual-hidden')`))
      .toBe('true');
    expect(await guest(webview, `
      document.querySelectorAll('[data-tenon-bilingual-translation="true"]').length
    `)).toBeGreaterThanOrEqual(3);

    await toggle.click();
    await expect(languageSelect).toHaveValue('zh-Hans');
    await popover.getByRole('button', { name: 'Translate page' }).click();
    await expect(toggle).toHaveAttribute('data-translation-enabled', 'true');
    await expect.poll(() => guest(webview, `
      document.documentElement.hasAttribute('data-tenon-bilingual-hidden')
    `)).toBe(false);
    await smoke.window.waitForTimeout(600);
    expect(batches).toHaveLength(completedRequestCount);

    await webview.evaluate((element) => (element as Electron.WebviewTag).reload());
    await expect(toggle).toHaveAttribute('data-translation-enabled', 'false');
    await expect.poll(() => guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-translation="true"]').length
    `)).toBe(0);

    await smoke.window.evaluate((url) => {
      window.dispatchEvent(new CustomEvent('lin:preview-target-open', {
        detail: {
          target: { kind: 'url', label: 'Translation failure article', url },
        },
      }));
    }, `${origin}/article?failure`);
    await expect.poll(() => guest<string>(webview, 'window.location.search')).toBe('?failure');
    await expect.poll(() => guest<string>(webview, 'document.readyState')).toBe('complete');

    failNextRequest = true;
    await toggle.click();
    await popover.getByRole('button', { name: 'Translate page' }).click();
    await expect.poll(() => guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-status="error"]').length
    `)).toBeGreaterThan(0);
    const retryMetrics = await guest<{ cursor: string; height: number; width: number }>(webview, `(() => {
      const retry = document.querySelector('[data-tenon-bilingual-status="error"]');
      if (!retry) return { cursor: '', height: 0, width: 0 };
      const rect = retry.getBoundingClientRect();
      return {
        cursor: getComputedStyle(retry).cursor,
        height: rect.height,
        width: rect.width,
      };
    })()`);
    expect(retryMetrics.width).toBeGreaterThanOrEqual(16);
    expect(retryMetrics.height).toBeGreaterThanOrEqual(16);
    expect(retryMetrics.cursor).toBe('default');
    if (visualDir) {
      await guest(webview, `
        document.querySelector('[data-tenon-bilingual-status="error"]')?.scrollIntoView({ block: 'center' });
        true
      `);
      await expect.poll(() => guest<boolean>(webview, `(() => {
        const retry = document.querySelector('[data-tenon-bilingual-status="error"]');
        if (!retry) return false;
        const rect = retry.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      })()`)).toBe(true);
      await smoke.window.waitForTimeout(100);
      await smoke.window.screenshot({ path: `${visualDir}/url-translation-error.png` });
    }
    const failedRequestCount = batches.length;
    const failedBlockCount = await guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-status="error"]').length
    `);
    await smoke.window.waitForTimeout(600);
    expect(batches).toHaveLength(failedRequestCount);

    const retriedSourceId = await guest<string>(webview, `(() => {
      const retry = document.querySelector('[data-tenon-bilingual-status="error"]');
      const sourceId = retry?.parentElement?.id ?? '';
      retry?.click();
      return sourceId;
    })()`);
    expect(retriedSourceId).not.toBe('');
    await expect.poll(() => guest<string | null>(webview, `
      document.querySelector('#${retriedSourceId} [data-tenon-bilingual-translation="true"]')?.textContent ?? null
    `)).not.toBeNull();
    expect(batches.at(-1)?.blocks).toHaveLength(1);
    expect(await guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-status="error"]').length
    `)).toBe(failedBlockCount - 1);
  });
});

async function configureTranslationProvider(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate(async ({ baseUrl }) => {
    const lin = (window as unknown as {
      lin: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    }).lin;
    const providerId = 'translation-smoke';
    await lin.invoke('agent_upsert_provider_config', {
      provider: { providerId, baseUrl, enabled: true },
    });
    await lin.invoke('agent_set_provider_api_key', { providerId, apiKey: 'smoke-key' });
    await lin.invoke('agent_set_active_provider', { providerId });
  }, { baseUrl });
}

async function captureTranslationVisual(
  page: Page,
  toggle: ReturnType<Page['locator']>,
  popover: ReturnType<Page['locator']>,
  directory: string,
  theme: 'dark' | 'light',
): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate(async (nextTheme) => {
    await (window as unknown as {
      lin: { setTheme: (theme: 'dark' | 'light') => Promise<void> };
    }).lin.setTheme(nextTheme);
  }, theme);
  await expect.poll(() => page.evaluate(() => (
    window.matchMedia('(prefers-color-scheme: dark)').matches
  ))).toBe(theme === 'dark');
  await toggle.click();
  await expect(popover).toBeVisible();
  await page.screenshot({ path: `${directory}/url-translation-${theme}.png` });
  await toggle.click();
  await expect(popover).toBeHidden();
}

async function findMainWindow(smokeApp: SmokeApp): Promise<Page> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const mainWindow = smokeApp.app.windows().find((page) => (
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
