import { expect, test } from '@playwright/test';
import { SETTINGS_PANES } from '../../src/core/settingsWindow';
import { getMessages } from '../../src/core/i18n';
import { installElectronMock } from './outlinerMock';

for (const locale of ['en', 'zh-Hans'] as const) {
  for (const [colorScheme, width, scale] of [['light', 860, '100%'], ['dark', 680, '200%']] as const) {
    test(`all Settings panes remain readable in ${locale}, ${colorScheme}, and ${scale} text`, async ({ page }, testInfo) => {
      await installElectronMock(page, { initialLanguage: locale });
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme, contrast: 'more', reducedMotion: 'reduce' });
      await page.goto('/?surface=settings&destination=settings');
      await page.evaluate((scale) => document.documentElement.style.setProperty('--font-scale', scale), scale);
      const copy = getMessages(locale).settings.discovery;
      for (const destination of SETTINGS_PANES) {
        await page.getByRole('tab', { name: copy.destinations[destination], exact: true }).click();
        const pane = page.getByRole('tabpanel', { name: copy.destinations[destination], exact: true });
        await expect(pane.getByRole('listitem').first()).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
        const rail = await page.locator('.settings-rail').boundingBox();
        const toolbar = await page.locator('.configuration-toolbar').boundingBox();
        const content = await page.locator('.settings-body').boundingBox();
        expect(rail!.x).toBeGreaterThan(0);
        expect(rail!.y).toBeCloseTo(toolbar!.y);
        expect(toolbar!.x).toBeGreaterThan(rail!.x + rail!.width);
        expect(content!.y).toBeGreaterThan(toolbar!.y + toolbar!.height);
        expect(content!.x).toBeCloseTo(toolbar!.x);
        expect(content!.width).toBeCloseTo(toolbar!.width);
        const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
          '.settings-sidebar, .settings-pane:not([hidden]), .settings-pane:not([hidden]) .inset-row, .settings-pane:not([hidden]) .preference-row, .settings-pane:not([hidden]) .settings-shortcut-row',
        )].filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.className));
        expect(overflow, `${destination} should wrap inside its content column`).toEqual([]);
        if (destination === 'models') {
          const selectedWidths = await pane.locator('.select-popup-input').evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().width));
          expect(selectedWidths.every((value) => value < width / 3)).toBe(true);
        }
        await page.screenshot({ path: testInfo.outputPath(`${destination}-${locale}-${colorScheme}-${scale}.png`) });
      }
    });
  }
}
