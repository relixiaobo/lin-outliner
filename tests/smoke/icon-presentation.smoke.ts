import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSmokeApp, launchSmokeApp, REPO_ROOT } from './electronApp';

test('packaged renderer paints semantic rail controls in both native themes', async ({}, testInfo) => {
  const userDataDir = await mkdtemp('/tmp/tenon-icon-smoke-');
  execFileSync('bun', [join(REPO_ROOT, 'tests/fixtures/startupWorkspace.ts'), userDataDir], { cwd: REPO_ROOT });
  const smoke = await launchSmokeApp({ userDataDir });
  try {
    const page = smoke.window;
    await expect(page.locator('.sidebar-toggle')).toBeVisible();
    await expect(page.locator('.sidebar-primary-nav')).toBeAttached({ timeout: 30_000 });
    for (const theme of ['light', 'dark'] as const) {
      await smoke.app.evaluate(({ BrowserWindow, nativeTheme }, theme) => {
        nativeTheme.themeSource = theme;
        BrowserWindow.getAllWindows().find(window => /\/index\.html(?:$|\?)/.test(window.webContents.getURL()))?.setSize(1200, 800);
      }, theme);
      // Playwright's media override must match the native host theme.
      await page.emulateMedia({ colorScheme: theme });
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark');
      for (const [selector, collapse, expand] of [
        ['.sidebar-toggle', 'CollapseSidebar', 'ExpandSidebar'],
        ['.agent-toggle', 'CollapseAgentPanel', 'ExpandAgentPanel'],
      ]) {
        const control = page.locator(selector);
        const open = await control.getAttribute('aria-expanded') === 'true';
        await expect(control.locator('svg')).toHaveAttribute('data-icon', open ? collapse : expand);
        await control.click();
        await expect(control.locator('svg')).toHaveAttribute('data-icon', open ? expand : collapse);
        if (open) await control.click();
      }
      await expect(page.locator('.sidebar-primary-nav')).toBeVisible();
      const icons = await page.locator('svg.app-icon:visible').evaluateAll(elements => elements.map(element => ({
        name: element.getAttribute('data-icon'),
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        hidden: element.getAttribute('aria-hidden'),
      })));
      expect(icons.length).toBeGreaterThan(10);
      for (const icon of icons) {
        expect(icon.width, icon.name ?? '').toBeGreaterThan(0);
        expect(icon.width, icon.name ?? '').toBe(icon.height);
        expect(icon.hidden).toBe('true');
      }
      await page.screenshot({ path: testInfo.outputPath(`app-${theme}.png`) });
    }
  } catch (error) {
    await smoke.window.screenshot({ path: testInfo.outputPath('failure.png') });
    await testInfo.attach('startup-state', { body: JSON.stringify(await smoke.window.evaluate(async () => ({
      startup: await window.lin!.startup.get(), text: document.body.innerText,
    }))), contentType: 'application/json' });
    throw error;
  } finally {
    await closeSmokeApp(smoke);
  }
});
