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

  test.beforeAll(async () => {
    server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/article') {
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
        const translation = JSON.stringify(payload.blocks.map((block) => ({
          id: block.id,
          translation: `ZH: ${block.text}`,
        })));
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
        lin: { setLanguage: (locale: 'zh-Hans') => Promise<void> };
      }).lin;
      await lin.setLanguage('zh-Hans');
    });
    await expect.poll(() => smoke.window.locator('html').getAttribute('lang')).toBe('zh-Hans');
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
    await expect(webview).toBeAttached();
    await expect.poll(() => guest<string>(webview, 'document.readyState')).toBe('complete');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(batches).toHaveLength(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-translation="true"]').length
    `)).toBeGreaterThanOrEqual(2);

    const initialTexts = batches.flatMap((batch) => batch.blocks.map((block) => block.text));
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
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await guest(webview, `document.documentElement.getAttribute('data-tenon-bilingual-hidden')`))
      .toBe('true');
    expect(await guest(webview, `
      document.querySelectorAll('[data-tenon-bilingual-translation="true"]').length
    `)).toBeGreaterThanOrEqual(3);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => guest(webview, `
      document.documentElement.hasAttribute('data-tenon-bilingual-hidden')
    `)).toBe(false);
    await smoke.window.waitForTimeout(600);
    expect(batches).toHaveLength(completedRequestCount);

    await webview.evaluate((element) => (element as Electron.WebviewTag).reload());
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => guest<number>(webview, `
      document.querySelectorAll('[data-tenon-bilingual-translation="true"]').length
    `)).toBe(0);
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
