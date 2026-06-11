import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp } from './electronApp';
import type { DiagnosticLogRecord } from '../../src/core/errorObservability';

function readDiagnosticRecords(userDataDir: string): DiagnosticLogRecord[] {
  const logPath = join(userDataDir, 'diagnostics', 'errors.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DiagnosticLogRecord);
}

async function mainRendererPage(smoke: Awaited<ReturnType<typeof launchSmokeApp>>): Promise<Page> {
  await expect.poll(() => (
    smoke.app.windows().some((page) => /\/index\.html(?:$|\?)/.test(page.url()))
  )).toBe(true);
  const page = smoke.app.windows().find((candidate) => /\/index\.html(?:$|\?)/.test(candidate.url()));
  if (!page) throw new Error('Main renderer window not found');
  return page;
}

test.describe('diagnostics', () => {
  test('captures renderer errors and unhandled rejections from the main world', async () => {
    const smoke = await launchSmokeApp();
    try {
      const page = await mainRendererPage(smoke);
      await expect.poll(async () => (await page.locator('#root').innerHTML()).length)
        .toBeGreaterThan(0);
      await expect.poll(() => page.evaluate(() => typeof window.lin?.reportRendererError))
        .toBe('function');
      page.on('pageerror', () => undefined);

      await page.evaluate(() => {
        window.lin?.reportRendererError?.({
          domain: 'render',
          severity: 'fatal',
          code: 'direct-renderer-report',
          message: 'smoke direct renderer report',
        });
      });
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('smoke-renderer-error');
        }, 0);
        setTimeout(() => {
          void Promise.reject(new Error('smoke-renderer-rejection'));
        }, 0);
      });

      await expect.poll(() => {
        const codes = readDiagnosticRecords(smoke.userDataDir)
          .filter((record) => record.domain === 'render')
          .map((record) => record.code)
          .sort();
        return codes;
      }).toEqual(['direct-renderer-report', 'window-error', 'window-unhandled-rejection']);
    } finally {
      await closeSmokeApp(smoke);
    }
  });
});
