import { _electron as electron } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const results = [];
const seed = process.argv[2];
const output = process.argv[3];
if (!seed || !output) throw new Error('Usage: node scripts/probe-startup-window.mjs <fixture-userData> <output.json>');
for (let iteration = 0; iteration < 3; iteration += 1) {
  const userData = await mkdtemp(join(tmpdir(), 'tenon-startup-measure-'));
  await cp(resolve(seed), userData, { recursive: true });
  const environment = { ...process.env, ELECTRON_USER_DATA_DIR: userData };
  delete environment.ELECTRON_RENDERER_URL;
  delete environment.VITE_DEV_SERVER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const app = await electron.launch({ args: [resolve('out/main/main.js')], env: environment, timeout: 60000 });
  app.process().stderr.on('data', (chunk) => process.stderr.write(chunk));
  app.process().stdout.on('data', (chunk) => process.stdout.write(chunk));
  try {
    await app.firstWindow({ timeout: 60000 });
    let page;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      page = app.windows().find((window) => /\/index\.html(?:$|\?)/.test(window.url()));
      if (page) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page) throw new Error(`No main window: ${app.windows().map((window) => window.url())}`);
    page.on('pageerror', (error) => console.error(error));
    page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
    await page.locator('#root > *').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => performance.getEntriesByName('first-paint').length > 0);
    const paint = await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      paints: performance.getEntriesByType('paint').map(({ name, startTime }) => ({ name, startTime })),
    }));
    const firstPaint = paint.paints.find((entry) => entry.name === 'first-paint');
    const result = {
      iteration: iteration + 1,
      firstPaintMs: firstPaint ? Math.round(paint.timeOrigin + firstPaint.startTime - started) : null,
      attachedMs: Date.now() - started,
    };
    console.log(JSON.stringify(result));
    await page.locator('.workspace-canvas').waitFor({ timeout: 30000 }).catch(async (error) => {
      console.log(await page.locator('body').innerText());
      await page.screenshot({ path: resolve('tmp/startup-measure-failure.png') });
      throw error;
    });
    result.workspaceMs = Date.now() - started;
    results.push(result);
    console.log(JSON.stringify(result));
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
}
await writeFile(resolve(output), JSON.stringify(results, null, 2));
