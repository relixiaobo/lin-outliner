import { expect, test } from '@playwright/test';
import { SETTINGS_PANES } from '../../src/core/settingsWindow';
import { getMessages } from '../../src/core/i18n';
import { installElectronMock } from './outlinerMock';

for (const locale of ['en', 'zh-Hans'] as const) {
  for (const [colorScheme, width, scale] of [['light', 860, '100%'], ['dark', 860, '100%'], ['light', 680, '200%'], ['dark', 680, '200%']] as const) {
    test(`all Settings panes remain readable in ${locale}, ${colorScheme}, and ${scale} text`, async ({ page }, testInfo) => {
      await installElectronMock(page, { initialLanguage: locale });
      await page.setViewportSize({ width, height: 720 });
      await page.emulateMedia({ colorScheme, contrast: scale === '200%' ? 'more' : 'no-preference', reducedMotion: 'reduce' });
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
        await expect(page.locator('.settings-rail').getByRole('searchbox', { name: copy.search })).toBeVisible();
        await expect(page.locator('.configuration-toolbar').getByRole('searchbox')).toHaveCount(0);
        await expect(page.locator('.configuration-toolbar')).toHaveCSS('box-shadow', 'none');
        await expect(page.locator('.configuration-toolbar')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
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

for (const colorScheme of ['light', 'dark'] as const) {
  test(`expanded Settings explain scope and remain usable in ${colorScheme}`, async ({ page }, testInfo) => {
    await installElectronMock(page, { initialLanguage: 'en' });
    await page.setViewportSize({ width: 680, height: 720 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto('/?surface=settings&destination=models');
    await page.locator('summary', { hasText: 'Request Options' }).click();
    const requests = page.locator('.settings-disclosure[open]');
    await expect(requests.getByText(/Minimum:|Allowed range:/).first()).toBeVisible();
    await requests.screenshot({ path: testInfo.outputPath(`requests-${colorScheme}.png`) });

    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await page.getByRole('switch', { name: 'Experimental delegation', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Default runner', exact: true })).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByText(/time limit below apply to Internal Runner/)).toBeVisible();
    await page.locator('summary', { hasText: 'Delegation limits' }).click();
    await page.getByRole('combobox', { name: 'Running globally', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`delegation-${colorScheme}.png`) });

    await page.getByRole('tab', { name: 'Advanced', exact: true }).click();
    await page.locator('summary', { hasText: 'Advanced Preferences' }).click();
    const inspector = page.getByRole('tabpanel', { name: 'Advanced', exact: true }).locator('.settings-disclosure[open]');
    await expect(inspector.getByRole('radiogroup', { name: 'Appearance', exact: true })).toBeVisible();
    for (const input of await inspector.locator('input, select').all()) {
      await input.scrollIntoViewIfNeeded();
      const overflow = await input.evaluate((element) => {
        const row = element.closest('.preference-row')!;
        return row.scrollWidth > row.clientWidth + 1;
      });
      expect(overflow).toBe(false);
    }
    await page.screenshot({ path: testInfo.outputPath(`advanced-${colorScheme}.png`) });
  });
}
