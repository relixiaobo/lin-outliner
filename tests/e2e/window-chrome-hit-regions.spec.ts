import { expect, test } from '@playwright/test';
import { openMockedApp } from './outlinerMock';

test.describe('window chrome hit regions', () => {
  test.beforeEach(async ({ page }) => {
    await openMockedApp(page);
  });

  test('keeps every sibling drag region outside the agent toggle', async ({ page }) => {
    const regions = await page.evaluate(() => {
      const appRegion = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error(`missing ${selector}`);
        return getComputedStyle(element).getPropertyValue('-webkit-app-region').trim();
      };
      const toggle = document.querySelector('.agent-toggle');
      if (!(toggle instanceof HTMLElement)) throw new Error('missing .agent-toggle');
      const toggleBox = toggle.getBoundingClientRect();
      const overlappingSiblingDragRegions = [...document.querySelectorAll<HTMLElement>('*')]
        .filter((element) => (
          element.closest('.window-chrome-zone') === null
          && getComputedStyle(element).getPropertyValue('-webkit-app-region').trim() === 'drag'
        ))
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0
            && box.height > 0
            && box.left < toggleBox.right
            && box.right > toggleBox.left
            && box.top < toggleBox.bottom
            && box.bottom > toggleBox.top;
        })
        .map((element) => ({
          className: element.className,
          tagName: element.tagName,
        }));
      return {
        rightZone: appRegion('.window-chrome-zone-right'),
        agentToggle: appRegion('.agent-toggle'),
        overlappingSiblingDragRegions,
      };
    });

    expect(regions.rightZone).toBe('drag');
    expect(regions.agentToggle).toBe('no-drag');
    // Plain Chromium does not consume native title-bar clicks. Guard the native
    // failure mechanism across every sibling subtree, not only today's header.
    expect(regions.overlappingSiblingDragRegions).toEqual([]);

    const dock = page.locator('.agent-dock');
    await expect(dock).toHaveAttribute('data-rail-state', 'open');
    await page.getByRole('button', { name: 'Collapse agent' }).click();
    await expect(dock).toHaveAttribute('data-rail-state', 'collapsed');
    await page.getByRole('button', { name: 'Expand agent' }).click();
    await expect(dock).toHaveAttribute('data-rail-state', 'open');
  });

  test('makes the root Thread list affordance explicit without a redundant agent glyph', async ({ page }) => {
    const listButton = page.getByRole('button', { name: 'Show Threads' });
    const presentation = await listButton.evaluate((button) => {
      const chevron = button.querySelector('.thread-title-chevron');
      if (!(chevron instanceof SVGElement)) throw new Error('missing Thread list chevron');
      return {
        chevronOpacity: Number.parseFloat(getComputedStyle(chevron).opacity),
        chevronTransform: getComputedStyle(chevron).transform,
        leadingIconCount: button.querySelectorAll('.thread-dock-title-leading').length,
      };
    });

    expect(presentation.leadingIconCount).toBe(0);
    expect(presentation.chevronOpacity).toBeGreaterThan(0);
    expect(presentation.chevronTransform).toBe('none');
    await expect(listButton).toHaveAttribute('aria-expanded', 'false');
  });
});
