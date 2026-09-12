import { expect, test } from '@playwright/test';
import { installElectronMock } from './outlinerMock';

test('a failed first backup inspection can be refreshed without remounting Settings', async ({ page }) => {
  await installElectronMock(page);
  await page.goto('/?surface=settings');
  await expect(page.getByRole('tab', { name: 'Data', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const api = window.lin!.dataLifecycle;
    const request = api.request; let fail = true;
    (window as unknown as { repairBackupDirectory: () => void }).repairBackupDirectory = () => { fail = false; };
    api.request = async (input) => {
      if (input.action === 'inspect' && fail) throw new Error('Temporary backup directory permission failure');
      return request(input);
    };
  });
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Temporary backup directory');
  await expect(page.getByRole('button', { name: 'Create backup', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as unknown as { repairBackupDirectory: () => void }).repairBackupDirectory());
  await page.getByRole('button', { name: 'Refresh backups', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create backup', exact: true })).toBeEnabled();
});

for (const domain of ['agent', 'outline'] as const) for (const theme of ['light', 'dark'] as const) {
  test(`${domain} recovery remains scrollable with 200% text in ${theme}`, async ({ page }, testInfo) => {
    await installElectronMock(page, { startupFailureDomain: domain });
    await page.setViewportSize(domain === 'agent' ? { width: 1100, height: 650 } : { width: 860, height: 560 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.goto('/');
    await page.evaluate(() => document.documentElement.style.setProperty('--font-scale', '200%'));
    const card = page.locator('.startup-failure');
    await expect(card.getByRole('heading', { name: 'Data backup and recovery', exact: true })).toBeVisible();
    const scroller = page.locator(domain === 'agent' ? '.startup-agent-pane' : '.app-startup-shell');
    await expect(card.locator('h1')).toBeInViewport();
    await scroller.hover(); await page.mouse.wheel(0, 1600);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await card.getByRole('button', { name: 'Quit', exact: true }).scrollIntoViewIfNeeded();
    await expect(card.getByRole('button', { name: 'Quit', exact: true })).toBeInViewport();
    await expect(card.getByRole('button', { name: 'Retry', exact: true })).toBeInViewport();
    expect(await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`recovery-${domain}-${theme}-200.png`), animations: 'disabled' });
  });
}
